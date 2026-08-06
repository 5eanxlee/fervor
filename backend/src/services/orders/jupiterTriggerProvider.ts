import { env } from '../../config/env';
import {
    addressSchema,
    OrderAuth,
    OrderAuthType,
    OrderChallenge,
    OrderRequest,
    OrderUpdate,
    signatureSchema,
    u64Text,
} from '../../types';
import { jupiterRate } from '../jupiterRateService';
import { abortable, boundedSignal } from '../providerCall';
import { parseSolanaTransaction, transactionSignature } from '../solanaTransaction';
import {
    OrderProvider,
    OrderProviderError,
    ProviderActiveOrder,
    ProviderCancelledOrder,
    ProviderCancelOrder,
    ProviderMoneyEvent,
    ProviderOrderSnapshot,
    ProviderPreparedOrder,
} from './provider';

type JsonMap = Record<string, unknown>;
type CallRisk = 'read' | 'mutation';

const map = (value: unknown): JsonMap => value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonMap
    : {};
const string = (value: unknown): string | undefined =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;

const number = (value: unknown): number | undefined => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

const timestamp = (value: unknown): string | undefined => {
    const raw = string(value);
    if (!raw) return undefined;
    const numeric = Number(raw);
    const millis = Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(raw)
        ? numeric < 10_000_000_000 ? numeric * 1_000 : numeric
        : Date.parse(raw);
    if (!Number.isFinite(millis)) return undefined;
    try {
        return new Date(millis).toISOString();
    } catch {
        return undefined;
    }
};

const optionalAmount = (value: unknown, field: string): string | undefined => {
    if (value === undefined || value === null) return undefined;
    const amount = u64Text(value);
    if (amount === undefined) {
        throw new OrderProviderError(
            'provider_contract_error',
            `Order provider returned an invalid ${field}`,
            false
        );
    }
    return amount;
};

const errorMessage = (body: JsonMap): string | undefined => {
    const error = map(body.error);
    return string(error.message) || string(body.error) || string(body.message);
};

export const mapProviderState = (value: unknown, fillPercent?: number): ProviderOrderSnapshot['state'] | null => {
    if (value === 'pending') return 'activating';
    if (value === 'open') return 'open';
    if (value === 'executing') return fillPercent && fillPercent > 0 ? 'partially_filled' : 'executing';
    if (value === 'filled') return 'filled';
    if (value === 'pending_withdraw') return 'cancel_pending';
    if (value === 'cancelled') return 'cancelled';
    if (value === 'expired') return 'expired';
    if (value === 'failed') return 'failed';
    return null;
};

const eventSignature = (events: unknown, types: string[]): string | undefined => {
    if (!Array.isArray(events)) return undefined;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = map(events[index]);
        if (types.includes(String(event.type))) return string(event.txSignature);
    }
    return undefined;
};

const requiredAddress = (value: unknown, field: string): string => {
    const parsed = addressSchema.safeParse(value);
    if (!parsed.success) {
        throw new OrderProviderError('provider_contract_error', `Order provider returned an invalid ${field}`, false);
    }
    return parsed.data;
};

const requiredAmount = (value: unknown, field: string): string => {
    const parsed = optionalAmount(value, field);
    if (parsed === undefined) {
        throw new OrderProviderError('provider_contract_error', `Order provider omitted ${field}`, false);
    }
    return parsed;
};

const requiredOrderType = (value: unknown): OrderRequest['orderType'] => {
    if (value === 'single' || value === 'oco' || value === 'otoco') return value;
    throw new OrderProviderError('provider_contract_error', 'Order provider returned an invalid order type', false);
};

const moneyEvents = (value: unknown): ProviderMoneyEvent[] => {
    if (!Array.isArray(value)) {
        throw new OrderProviderError('provider_contract_error', 'Order provider omitted event history', false);
    }
    const result: ProviderMoneyEvent[] = [];
    for (const item of value) {
        const event = map(item);
        const type = string(event.type);
        if (!['deposit', 'fill', 'withdrawal'].includes(type || '')) continue;
        const state = string(event.state);
        if (!state) {
            throw new OrderProviderError('provider_contract_error', 'Order provider returned an invalid asset event', false);
        }
        if (state !== 'success') continue;
        const signature = signatureSchema.safeParse(event.txSignature);
        const occurredAt = timestamp(event.timestamp);
        if (!signature.success || !occurredAt) {
            throw new OrderProviderError('provider_contract_error', 'Order provider returned an invalid asset event', false);
        }
        const parsed: ProviderMoneyEvent = {
            type: type as ProviderMoneyEvent['type'],
            state,
            signature: signature.data,
            occurredAt,
            mint: requiredAddress(event.mint, 'event mint'),
            amount: requiredAmount(event.amount, 'event amount'),
        };
        if (parsed.type === 'fill') {
            parsed.outputMint = requiredAddress(event.outputMint, 'fill output mint');
            parsed.outputAmount = requiredAmount(event.outputAmount, 'fill output amount');
            parsed.orderContext = string(event.orderContext);
        }
        result.push(parsed);
    }
    return result.sort((left, right) => (
        left.occurredAt.localeCompare(right.occurredAt)
        || left.type.localeCompare(right.type)
        || left.signature.localeCompare(right.signature)
    ));
};

const moneySignature = (events: ProviderMoneyEvent[], type: ProviderMoneyEvent['type']): string | undefined => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].type === type && events[index].state === 'success') return events[index].signature;
    }
    return undefined;
};

const call = async (
    path: string,
    init: RequestInit = {},
    authToken?: string,
    signal?: AbortSignal,
    risk: CallRisk = 'read'
): Promise<JsonMap> => {
    if (!env.JUPITER_API_KEY) throw new OrderProviderError('provider_not_configured', 'Order provider is not configured', false, 503);
    if (!authToken && !path.startsWith('/auth/')) {
        throw new OrderProviderError('provider_auth_required', 'Order provider authorization is required', false, 401);
    }

    const bound = boundedSignal(env.EXECUTION_TIMEOUT_MS, signal);
    let started = false;
    const uncertain = (): boolean => risk === 'mutation' && started;
    const timeout = (): OrderProviderError => new OrderProviderError(
        'provider_timeout', 'Order provider timed out', true, 504, undefined, uncertain()
    );
    try {
        const reserved = await abortable(
            jupiterRate.reserve('main', bound.signal),
            bound.signal,
            timeout
        );
        if (reserved > 0) {
            throw new OrderProviderError(
                'provider_rate_limited',
                'Order provider quota is temporarily exhausted',
                true,
                429,
                reserved
            );
        }

        started = true;
        const response = await abortable(fetch(
            new URL(`/trigger/v2${path}`, env.JUPITER_API_URL), {
                ...init,
                signal: bound.signal,
                headers: {
                    Accept: 'application/json',
                    'x-api-key': env.JUPITER_API_KEY,
                    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
                    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
                    ...init.headers,
                },
            }
        ), bound.signal, timeout);
        const observedDelay = jupiterRate.observeSoon('main', response);
        const body = map(await abortable(
            response.json().catch(() => ({})),
            bound.signal,
            timeout
        ));
        if (!response.ok) {
            const retryable = response.status === 408 || response.status === 425
                || response.status === 429 || response.status >= 500;
            throw new OrderProviderError(
                response.status === 401 ? 'provider_auth_expired'
                    : response.status === 429 ? 'provider_rate_limited'
                        : 'provider_request_failed',
                errorMessage(body) || `Order provider returned HTTP ${response.status}`,
                retryable,
                response.status,
                observedDelay,
                risk === 'mutation' && (response.status === 408 || response.status >= 500)
            );
        }
        return body;
    } catch (error) {
        if (error instanceof OrderProviderError) throw error;
        if (bound.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
            throw timeout();
        }
        throw new OrderProviderError(
            'provider_unavailable', 'Order provider is unavailable', true, 502,
            undefined, uncertain()
        );
    } finally {
        bound.close();
    }
};

const providerOrderBody = (request: OrderRequest, depositRequestId: string, signedTransaction: string): JsonMap => {
    const common: JsonMap = {
        orderType: request.orderType,
        depositRequestId,
        depositSignedTx: signedTransaction,
        userPubkey: request.walletAddress,
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        inputAmount: request.inputAmount,
        triggerMint: request.triggerMint,
        expiresAt: new Date(request.expiresAt).getTime(),
    };
    if (request.orderType === 'single') {
        return {
            ...common,
            triggerCondition: request.triggerCondition,
            triggerPriceUsd: request.triggerPriceUsd,
            trailingBps: request.trailingBps,
            slippageBps: request.slippageBps,
        };
    }
    const bracket = {
        ...common,
        tpPriceUsd: request.takeProfitPriceUsd,
        slPriceUsd: request.stopLossPriceUsd,
        tpSlippageBps: request.takeProfitSlippageBps,
        slSlippageBps: request.stopLossSlippageBps,
    };
    if (request.orderType === 'oco') return bracket;
    return {
        ...bracket,
        triggerCondition: request.triggerCondition,
        triggerPriceUsd: request.triggerPriceUsd,
        slippageBps: request.slippageBps,
    };
};

export class JupiterTriggerProvider implements OrderProvider {
    readonly name = 'jupiter_trigger_v2' as const;
    readonly requiresAuth = true;
    readonly custody = 'third_party_vault' as const;

    async challenge(
        walletAddress: string,
        type: OrderAuthType,
        signal?: AbortSignal
    ): Promise<OrderChallenge> {
        const body = await call('/auth/challenge', {
            method: 'POST',
            body: JSON.stringify({ walletPubkey: walletAddress, type }),
        }, undefined, signal);
        if (body.type !== type) {
            throw new OrderProviderError('provider_contract_error', 'Order provider returned the wrong challenge type', false);
        }
        if (type === 'transaction') {
            const transaction = string(body.transaction);
            if (!transaction) throw new OrderProviderError('provider_contract_error', 'Order provider returned no transaction challenge', false);
            return { type, transaction };
        }
        const challenge = string(body.challenge);
        if (!challenge) throw new OrderProviderError('provider_contract_error', 'Order provider returned no message challenge', false);
        return { type, challenge };
    }

    async verify(walletAddress: string, auth: OrderAuth, signal?: AbortSignal): Promise<string> {
        const body = await call('/auth/verify', {
            method: 'POST',
            body: JSON.stringify({ walletPubkey: walletAddress, ...auth }),
        }, undefined, signal);
        const token = string(body.token);
        if (!token) throw new OrderProviderError('provider_contract_error', 'Order provider returned no authorization token', false);
        return token;
    }

    async prepare(
        request: OrderRequest,
        authToken?: string,
        signal?: AbortSignal
    ): Promise<ProviderPreparedOrder> {
        const vault = await this.ensureVault(request.walletAddress, authToken, signal);
        const body = await call('/deposit/craft', {
            method: 'POST',
            body: JSON.stringify({
                inputMint: request.inputMint,
                outputMint: request.outputMint,
                userAddress: request.walletAddress,
                amount: request.inputAmount,
                orderType: 'price',
                orderSubType: request.orderType,
            }),
        }, authToken, signal, 'mutation');
        const transaction = string(body.transaction);
        const depositRequestId = string(body.requestId);
        const receiverAddress = requiredAddress(body.receiverAddress, 'deposit receiver');
        const inputAccount = requiredAddress(body.inputTokenAccount, 'deposit token account');
        const outputAccount = body.outputTokenAccount === undefined
            ? undefined : requiredAddress(body.outputTokenAccount, 'deposit output token account');
        if (!transaction || !depositRequestId
            || string(body.mint) !== request.inputMint
            || optionalAmount(body.amount, 'amount') !== request.inputAmount
            || receiverAddress !== vault
            || (request.orderType === 'otoco') !== (outputAccount !== undefined)) {
            throw new OrderProviderError(
                'provider_contract_error', 'Order provider returned an incomplete deposit',
                false, 502, undefined, true
            );
        }
        return {
            provider: this.name,
            transaction,
            depositRequestId,
            receiverAddress,
            inputAccount,
            outputAccount,
        };
    }

    async activate(
        request: OrderRequest,
        depositRequestId: string,
        signedTransaction: string,
        authToken?: string,
        signal?: AbortSignal
    ): Promise<ProviderActiveOrder> {
        const body = await call('/orders/price', {
            method: 'POST',
            body: JSON.stringify(providerOrderBody(request, depositRequestId, signedTransaction)),
        }, authToken, signal, 'mutation');
        const providerOrderId = string(body.id);
        if (!providerOrderId) throw new OrderProviderError(
            'provider_contract_error', 'Order provider returned no order ID',
            false, 502, undefined, true
        );
        return {
            providerOrderId,
            state: body.depositConfirmed === false ? 'activating' : 'open',
            depositSignature: string(body.txSignature),
            rawState: body.depositConfirmed === false ? 'depositing' : 'open',
        };
    }

    async update(
        providerOrderId: string,
        input: OrderUpdate,
        authToken?: string,
        signal?: AbortSignal
    ): Promise<void> {
        let body: JsonMap;
        if (input.orderType === 'single') {
            body = {
                orderType: input.orderType,
                triggerPriceUsd: input.triggerPriceUsd,
                trailingBps: input.trailingBps,
                slippageBps: input.slippageBps,
            };
        } else {
            body = {
                orderType: input.orderType,
                tpPriceUsd: input.takeProfitPriceUsd,
                slPriceUsd: input.stopLossPriceUsd,
                tpSlippageBps: input.takeProfitSlippageBps,
                slSlippageBps: input.stopLossSlippageBps,
            };
            if (input.orderType === 'otoco') {
                body.triggerPriceUsd = input.triggerPriceUsd;
                body.slippageBps = input.slippageBps;
            }
        }
        const result = await call(`/orders/price/${encodeURIComponent(providerOrderId)}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
        }, authToken, signal, 'mutation');
        if (string(result.id) !== providerOrderId) {
            throw new OrderProviderError(
                'provider_contract_error', 'Order provider returned an invalid update',
                false, 502, undefined, true
            );
        }
    }

    async cancel(
        providerOrderId: string,
        authToken?: string,
        signal?: AbortSignal
    ): Promise<ProviderCancelOrder> {
        const body = await call(
            `/orders/price/cancel/${encodeURIComponent(providerOrderId)}`,
            { method: 'POST' },
            authToken,
            signal,
            'mutation'
        );
        const requestId = string(body.requestId);
        const transaction = string(body.transaction);
        if (string(body.id) !== providerOrderId || !requestId || !transaction) {
            throw new OrderProviderError(
                'provider_contract_error', 'Order provider returned an incomplete cancellation',
                false, 502, undefined, true
            );
        }
        return { requestId, transaction };
    }

    async confirmCancel(
        providerOrderId: string,
        cancelRequestId: string,
        signedTransaction: string,
        authToken?: string,
        signal?: AbortSignal
    ): Promise<ProviderCancelledOrder> {
        let expectedSignature: string | undefined;
        try {
            expectedSignature = transactionSignature(
                parseSolanaTransaction(signedTransaction, env.MAX_TRANSACTION_BYTES)
            );
        } catch {
            // The public service validates this first; retain a fail-closed provider boundary.
        }
        if (!expectedSignature) {
            throw new OrderProviderError(
                'invalid_signed_transaction', 'Signed cancellation transaction is invalid',
                false, 400
            );
        }
        const body = await call(`/orders/price/confirm-cancel/${encodeURIComponent(providerOrderId)}`, {
            method: 'POST',
            body: JSON.stringify({ signedTransaction, cancelRequestId }),
        }, authToken, signal, 'mutation');
        const signature = signatureSchema.safeParse(body.txSignature);
        if (string(body.id) !== providerOrderId || !signature.success
            || signature.data !== expectedSignature) {
            throw new OrderProviderError(
                'provider_contract_error',
                'Order provider returned an invalid cancellation confirmation',
                false,
                502,
                undefined,
                true
            );
        }
        return {
            state: 'cancelled',
            signature: signature.data,
            rawState: 'cancelled',
        };
    }

    async history(authToken?: string, signal?: AbortSignal): Promise<ProviderOrderSnapshot[]> {
        const snapshots = new Map<string, ProviderOrderSnapshot>();
        for (const group of ['active', 'past'] as const) {
            for (let page = 0; page < env.ORDER_SYNC_MAX_PAGES; page += 1) {
                const offset = page * 100;
                const body = await call(
                    `/orders/history?state=${group}&limit=100&offset=${offset}&sort=updated_at&dir=desc`,
                    {},
                    authToken,
                    signal
                );
                if (!Array.isArray(body.orders)) {
                    throw new OrderProviderError('provider_contract_error', 'Order provider returned invalid history', false);
                }
                for (const value of body.orders) {
                    const order = map(value);
                    const providerOrderId = string(order.id);
                    const fillPercent = number(order.fillPercent);
                    const state = mapProviderState(order.orderState, fillPercent);
                    if (!providerOrderId || !state) continue;
                    const events = moneyEvents(order.events);
                    const snapshot: ProviderOrderSnapshot = {
                        providerOrderId,
                        orderType: requiredOrderType(order.orderType),
                        updatedAt: timestamp(order.updatedAt ?? order.updated_at),
                        walletAddress: requiredAddress(order.userPubkey, 'history wallet'),
                        vaultAddress: requiredAddress(order.privyWalletPubkey, 'history vault'),
                        inputMint: requiredAddress(order.inputMint, 'history input mint'),
                        outputMint: requiredAddress(order.outputMint, 'history output mint'),
                        inputAmount: requiredAmount(order.initialInputAmount, 'initial input amount'),
                        remainingInput: requiredAmount(order.remainingInputAmount, 'remaining input amount'),
                        moneyEvents: events,
                        state,
                        rawState: string(order.rawState),
                        depositSignature: moneySignature(events, 'deposit'),
                        fillSignature: moneySignature(events, 'fill'),
                        cancelSignature: eventSignature(order.events, ['cancelled', 'withdrawal']),
                        fillPercent,
                        outputAmount: optionalAmount(order.outputAmount, 'outputAmount'),
                        inputUsed: optionalAmount(order.inputUsed, 'inputUsed'),
                        triggerPriceUsd: number(order.triggerPriceUsd),
                        trailingBps: number(order.trailingBps),
                        slippageBps: number(order.slippageBps),
                        takeProfitPriceUsd: number(order.tpPriceUsd ?? order.takeProfitPriceUsd),
                        stopLossPriceUsd: number(order.slPriceUsd ?? order.stopLossPriceUsd),
                        takeProfitSlippageBps: number(order.tpSlippageBps ?? order.takeProfitSlippageBps),
                        stopLossSlippageBps: number(order.slSlippageBps ?? order.stopLossSlippageBps),
                        highWatermark: number(order.highWatermark),
                        lowWatermark: number(order.lowWatermark),
                    };
                    if (!snapshot.updatedAt) {
                        throw new OrderProviderError('provider_contract_error', 'Order provider omitted history time', false);
                    }
                    const current = snapshots.get(providerOrderId);
                    if (!current || Date.parse(snapshot.updatedAt) > Date.parse(current.updatedAt || '')) {
                        snapshots.set(providerOrderId, snapshot);
                    } else if (snapshot.updatedAt === current.updatedAt
                        && JSON.stringify(snapshot) !== JSON.stringify(current)) {
                        throw new OrderProviderError(
                            'provider_contract_error', 'Order provider returned conflicting history snapshots', false
                        );
                    }
                }
                const pagination = map(body.pagination);
                const total = number(pagination.total);
                if (body.orders.length < 100 || (total !== undefined && offset + body.orders.length >= total)) break;
            }
        }
        return [...snapshots.values()];
    }

    private async ensureVault(
        walletAddress: string,
        authToken?: string,
        signal?: AbortSignal
    ): Promise<string> {
        let body: JsonMap;
        try {
            body = await call('/vault', {}, authToken, signal);
        } catch (error) {
            if (!(error instanceof OrderProviderError) || error.status !== 404) throw error;
            try {
                body = await call('/vault/register', {}, authToken, signal, 'mutation');
            } catch (registerError) {
                if (!(registerError instanceof OrderProviderError) || registerError.status !== 409) throw registerError;
                body = await call('/vault', {}, authToken, signal);
            }
        }
        const userPubkey = string(body.userPubkey);
        const vaultPubkey = string(body.vaultPubkey);
        if (userPubkey !== walletAddress || !vaultPubkey || !addressSchema.safeParse(vaultPubkey).success) {
            throw new OrderProviderError('provider_contract_error', 'Order provider returned an invalid vault', false);
        }
        return vaultPubkey;
    }
}
