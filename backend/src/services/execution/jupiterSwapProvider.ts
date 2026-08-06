import { env } from '../../config/env';
import { ProviderQuote, QuoteRequest, SubmitResult, signatureSchema, u64Text } from '../../types';
import { JupiterBucket, jupiterRate } from '../jupiterRateService';
import { abortable, boundedSignal } from '../providerCall';
import { ExecutionProviderError, ProviderCall, SwapProvider } from './provider';

type JsonMap = Record<string, unknown>;

const terminalCodes = new Set([-1, -2, -3, -1000, -1002, -1003, -1004, -2000, -2002, -2003, -2004]);

const asMap = (value: unknown): JsonMap => value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonMap
    : {};

const asString = (value: unknown): string | undefined =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;

const asStatus = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

const asCode = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;

const acknowledgement = (body: JsonMap): { signature?: string; malformed: boolean; rawStatus?: string } => {
    const raw = body.signature;
    const parsed = signatureSchema.safeParse(raw);
    return {
        signature: parsed.success ? parsed.data : undefined,
        malformed: raw !== undefined && raw !== null && !parsed.success,
        rawStatus: asStatus(body.status),
    };
};

const uncertain = (
    message: string,
    body: JsonMap,
    code = 'provider_contract_error',
    status = 502
): ExecutionProviderError => {
    const ack = acknowledgement(body);
    return new ExecutionProviderError(
        code,
        message,
        false,
        status,
        undefined,
        true,
        { signature: ack.signature, rawStatus: ack.rawStatus }
    );
};

const exactAmount = (body: JsonMap, field: string): string | undefined => {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    const amount = u64Text(value);
    if (amount === undefined) {
        throw new ExecutionProviderError(
            'provider_contract_error',
            `Execution provider returned an invalid ${field}`,
            false
        );
    }
    return amount;
};

const feeAmount = (body: JsonMap, field: string): string | undefined => {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'number') {
        if (Number.isSafeInteger(value) && value >= 0) return String(value);
    } else {
        const amount = u64Text(value);
        if (amount !== undefined) return amount;
    }
    throw new ExecutionProviderError(
        'provider_contract_error',
        `Execution provider returned an invalid ${field}`,
        false
    );
};

const timeoutError = (bucket: JupiterBucket): ExecutionProviderError => new ExecutionProviderError(
    'provider_timeout',
    'Execution provider timed out',
    true,
    504,
    undefined,
    bucket === 'execute',
    bucket === 'execute' ? { rawStatus: 'timeout' } : undefined
);

const requestJson = async (url: URL, init?: RequestInit, external?: AbortSignal): Promise<JsonMap> => {
    const bucket: JupiterBucket = url.pathname.endsWith('/swap/v2/execute') ? 'execute' : 'main';
    const bound = boundedSignal(env.EXECUTION_TIMEOUT_MS, external);
    const { signal } = bound;

    try {
        const reserved = await abortable(jupiterRate.reserve(bucket, signal), signal, () => timeoutError(bucket));
        if (reserved > 0) {
            throw new ExecutionProviderError(
                'provider_rate_limited',
                'Execution provider quota is temporarily exhausted',
                true,
                429,
                reserved
            );
        }
        const response = await abortable(fetch(url, {
            ...init,
            signal,
            headers: {
                Accept: 'application/json',
                ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
                ...(env.JUPITER_API_KEY ? { 'x-api-key': env.JUPITER_API_KEY } : {}),
                ...init?.headers,
            },
        }), signal, () => timeoutError(bucket));
        const observedDelay = jupiterRate.observeSoon(bucket, response);
        const body = asMap(await abortable(
            response.json().catch(() => ({})),
            signal,
            () => timeoutError(bucket)
        ));
        if (!response.ok) {
            const message = asString(body.error) || asString(body.message) || `Provider returned HTTP ${response.status}`;
            const ack = acknowledgement(body);
            const execute = bucket === 'execute';
            throw new ExecutionProviderError(
                response.status === 429 ? 'provider_rate_limited' : 'provider_request_failed',
                message,
                response.status === 429 || response.status >= 500,
                response.status,
                observedDelay,
                execute && (response.status >= 500 || ack.signature !== undefined || ack.malformed),
                execute ? {
                    signature: ack.signature,
                    rawStatus: ack.rawStatus || `http_${response.status}`,
                } : undefined
            );
        }
        return body;
    } catch (error) {
        if (error instanceof ExecutionProviderError) throw error;
        if (error instanceof Error && error.name === 'AbortError') throw timeoutError(bucket);
        throw new ExecutionProviderError(
            'provider_unavailable',
            'Execution provider is unavailable',
            true,
            502,
            undefined,
            bucket === 'execute',
            bucket === 'execute' ? { rawStatus: 'transport_error' } : undefined
        );
    } finally {
        bound.close();
    }
};

export class JupiterSwapProvider implements SwapProvider {
    readonly name = 'jupiter_swap_v2' as const;

    async quote(request: QuoteRequest): Promise<ProviderQuote> {
        const url = new URL('/swap/v2/order', env.JUPITER_API_URL);
        url.searchParams.set('inputMint', request.inputMint);
        url.searchParams.set('outputMint', request.outputMint);
        url.searchParams.set('amount', request.inputAmount);
        url.searchParams.set('taker', request.taker);
        if (request.slippageBps) url.searchParams.set('slippageBps', String(request.slippageBps));
        if (request.priorityFeeLamports) {
            url.searchParams.set('priorityFeeLamports', String(request.priorityFeeLamports));
        }
        if (request.jitoTipLamports) {
            url.searchParams.set('jitoTipLamports', String(request.jitoTipLamports));
        }
        if (request.broadcastFeeType && (request.priorityFeeLamports || request.jitoTipLamports)) {
            url.searchParams.set('broadcastFeeType', request.broadcastFeeType);
        }

        const body = await requestJson(url);
        const transaction = asString(body.transaction);
        const providerQuoteId = asString(body.requestId);
        const inputAmount = exactAmount(body, 'inAmount') || request.inputAmount;
        const outputAmount = exactAmount(body, 'outAmount') || exactAmount(body, 'outputAmount');
        if (!transaction || !providerQuoteId || !outputAmount) {
            throw new ExecutionProviderError('provider_contract_error', 'Execution provider returned an incomplete quote', false);
        }

        const routePlan = Array.isArray(body.routePlan) ? body.routePlan : [];
        const route = routePlan.slice(0, 16).map((item) => {
            const entry = asMap(item);
            const swapInfo = asMap(entry.swapInfo);
            return {
                venue: asString(swapInfo.label) || asString(swapInfo.ammKey) || 'unknown',
                percent: Number(entry.percent || 0),
            };
        });

        return {
            provider: this.name,
            providerQuoteId,
            inputAmount,
            outputAmount,
            minOutputAmount: exactAmount(body, 'otherAmountThreshold') || outputAmount,
            taker: request.taker,
            feePayer: asString(body.signatureFeePayer) || request.taker,
            slippageBps: Number(body.slippageBps ?? request.slippageBps ?? 0),
            priceImpactPct: asString(body.priceImpactPct),
            transaction,
            route,
            fees: {
                networkLamports: feeAmount(body, 'signatureFeeLamports'),
                priorityLamports: feeAmount(body, 'prioritizationFeeLamports'),
                platformAmount: exactAmount(asMap(body.platformFee), 'amount'),
            },
        };
    }

    async submit(
        input: { providerQuoteId: string; signedTransaction: string },
        call?: ProviderCall
    ): Promise<SubmitResult> {
        const url = new URL('/swap/v2/execute', env.JUPITER_API_URL);
        const body = await requestJson(url, {
            method: 'POST',
            body: JSON.stringify({
                requestId: input.providerQuoteId,
                signedTransaction: input.signedTransaction,
            }),
        }, call?.signal);
        const ack = acknowledgement(body);
        const rawStatus = ack.rawStatus;
        const code = asCode(body.code);
        if (ack.malformed) {
            throw uncertain('Execution provider returned a malformed transaction signature', body);
        }
        if (rawStatus !== 'Success' && rawStatus !== 'Failed') {
            throw uncertain('Execution provider returned an unknown execution status', body);
        }

        const success = rawStatus === 'Success';
        const signature = ack.signature;
        let inputAmount: string | undefined;
        let outputAmount: string | undefined;
        if (success) {
            try {
                if (code !== 0) {
                    throw new ExecutionProviderError(
                        'provider_contract_error',
                        'Execution provider returned invalid success fields',
                        false
                    );
                }
                inputAmount = exactAmount(body, 'totalInputAmount');
                outputAmount = exactAmount(body, 'totalOutputAmount');
                if (!inputAmount || !outputAmount) {
                    throw new ExecutionProviderError(
                        'provider_contract_error',
                        'Execution provider returned success without exact wallet amounts',
                        false
                    );
                }
                if (!signature) {
                    throw new ExecutionProviderError(
                        'provider_contract_error',
                        'Execution provider returned success without a signature',
                        false
                    );
                }
            } catch (error) {
                const contract = error instanceof ExecutionProviderError
                    ? error
                    : new ExecutionProviderError('provider_contract_error', 'Execution acknowledgement is invalid', false);
                throw new ExecutionProviderError(
                    contract.code,
                    contract.message,
                    false,
                    contract.status,
                    contract.retryAfterMs,
                    true,
                    { signature, rawStatus }
                );
            }
        } else {
            if (code === undefined || code === -1001 || code === -2001 || !terminalCodes.has(code)) {
                throw uncertain('Execution provider could not determine the transaction outcome', body);
            }
        }

        return {
            provider: this.name,
            state: success ? 'submitted' : 'failed',
            signature,
            inputAmount,
            outputAmount,
            errorCode: success ? undefined : String(code),
            errorMessage: success ? undefined : asString(body.error) || 'Execution provider rejected the transaction',
            rawStatus,
        };
    }
}
