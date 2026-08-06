import crypto from 'crypto';
import { DbQuery, query, transaction } from '../../config/database';
import { env } from '../../config/env';
import {
    OrderCapabilities,
    OrderAuth,
    OrderAuthType,
    OrderChallenge,
    OrderProviderName,
    OrderRecord,
    OrderRequest,
    OrderUpdate,
    PreparedOrder,
} from '../../types';
import { metrics } from '../metrics';
import { eventOutbox } from '../eventOutbox';
import { STREAMS } from '../redisStreamService';
import { createOrderProvider } from './providerFactory';
import { OrderProvider, OrderProviderError, ProviderOrderSnapshot } from './provider';
import { ProviderMoneySync } from './providerMoneySync';
import {
    parseSolanaTransaction,
    transactionSignature,
    validateSignedTransaction,
} from '../solanaTransaction';
import { SolanaLookupResolver, SolanaLookupUnavailable } from '../solanaLookup';
import { validateOrderTx } from './transactionPolicy';
import type { OrderTxIntent, OrderTxResolver } from './transactionPolicy';

type Row = Record<string, unknown>;
type TxFn = <T>(work: (db: DbQuery) => Promise<T>) => Promise<T>;
type OpKind = 'prepare' | 'activate' | 'edit' | 'cancel_init' | 'cancel_confirm';

interface OpFact {
    kind: OpKind;
    reqHash: string;
    wantHash: string;
    detail: Row;
}

export class OrderError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly status: number,
        readonly retryable = false
    ) {
        super(message);
        this.name = 'OrderError';
    }
}

const iso = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();
const text = (value: unknown): string | undefined => value === null || value === undefined ? undefined : String(value);
const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Row)
                .filter(([, item]) => item !== undefined)
                .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
                .map(([key, item]) => [key, canonical(item)])
        );
    }
    return value;
};
const digest = (value: unknown): string => crypto.createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
const factDigest = (value: unknown): string => crypto.createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const unknownOutcome = 'provider_outcome_unknown';

const opFact = (kind: OpKind, request: Row, want: Row): OpFact => ({
    kind,
    reqHash: factDigest(request),
    wantHash: factDigest(want),
    detail: { request: canonical(request), want: canonical(want) },
});

const txFact = (value: string): Row => {
    try {
        const parsed = parseSolanaTransaction(value, env.MAX_TRANSACTION_BYTES);
        return {
            rawHash: parsed.rawDigest,
            messageHash: parsed.messageDigest,
            recentBlockhash: parsed.recentBlockhash,
            signature: transactionSignature(parsed),
        };
    } catch {
        return { rawHash: crypto.createHash('sha256').update(value).digest('hex') };
    }
};

const decodeTransaction = (value: string): void => {
    const normalized = value.replace(/\s/g, '');
    const bytes = Buffer.from(normalized, 'base64');
    if (!bytes.length || bytes.length > env.MAX_TRANSACTION_BYTES
        || bytes.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
        throw new OrderError('invalid_transaction', 'Signed transaction must be valid base64', 400);
    }
};

const parseTransaction = (value: string) => {
    try {
        return parseSolanaTransaction(value, env.MAX_TRANSACTION_BYTES);
    } catch (error) {
        throw new OrderError(
            'invalid_transaction',
            error instanceof Error ? error.message : 'Transaction is invalid',
            400
        );
    }
};

const params = (row: Row): Record<string, unknown> => {
    if (typeof row.params === 'string') return JSON.parse(row.params) as Record<string, unknown>;
    return (row.params || {}) as Record<string, unknown>;
};

const depositIntent = (
    request: OrderRequest,
    receiver: unknown,
    account: unknown,
    outputAccount?: unknown
): OrderTxIntent => {
    const intent: Extract<OrderTxIntent, { kind: 'deposit' }> = {
        kind: 'deposit',
        wallet: request.walletAddress,
        mint: request.inputMint,
        amount: request.inputAmount,
        receiver: text(receiver) || '',
        account: text(account) || '',
    };
    const output = text(outputAccount);
    if (output) intent.output = { mint: request.outputMint, account: output };
    return intent;
};

const withdrawalIntent = (row: Row): OrderTxIntent => {
    const detail = params(row);
    return {
        kind: 'withdrawal',
        wallet: String(row.wallet_address),
        mint: String(row.input_mint),
        amount: String(row.input_amount),
        receiver: text(row.receiver_address) || '',
        account: text(detail.depositAccount) || '',
    };
};

const jsonRow = (value: unknown): Row => {
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value) as unknown;
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Row : {};
        } catch {
            return {};
        }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
};

const fromRow = (row: Row): OrderRecord => ({
    id: String(row.id),
    provider: String(row.provider) as OrderProviderName,
    providerOrderId: text(row.provider_order_id),
    clientOrderId: String(row.client_order_id),
    walletAddress: String(row.wallet_address),
    orderType: row.order_type as OrderRecord['orderType'],
    state: row.state as OrderRecord['state'],
    inputMint: String(row.input_mint),
    outputMint: String(row.output_mint),
    inputAmount: String(row.input_amount),
    triggerMint: String(row.trigger_mint),
    params: params(row),
    depositSignature: text(row.deposit_signature),
    fillSignature: text(row.fill_signature),
    cancelSignature: text(row.cancel_signature),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
});

export class OrderService {
    private provider: OrderProvider | null;
    private readonly resolver: OrderTxResolver | null;

    constructor(
        provider?: OrderProvider | null,
        private readonly db: DbQuery = query,
        private readonly tx: TxFn = transaction,
        resolver?: OrderTxResolver | null
    ) {
        this.provider = provider === undefined ? this.safeProvider() : provider;
        this.resolver = resolver === undefined ? this.safeResolver() : resolver;
    }

    capabilities(): OrderCapabilities {
        return {
            mode: env.ORDER_MODE,
            provider: this.provider?.name || 'none',
            canPrepare: !!this.provider,
            canActivate: !!this.provider && env.ORDER_MODE !== 'disabled',
            requiresProviderAuth: this.provider?.requiresAuth ?? false,
            custody: this.provider?.custody ?? 'none',
            orderTypes: ['single', 'trailing', 'oco', 'otoco'],
        };
    }

    async challenge(walletAddress: string, type: OrderAuthType): Promise<OrderChallenge> {
        return this.requireProvider().challenge(walletAddress, type);
    }

    async verify(walletAddress: string, auth: OrderAuth): Promise<string> {
        return this.requireProvider().verify(walletAddress, auth);
    }

    async prepare(userId: string, request: OrderRequest, authToken?: string): Promise<PreparedOrder> {
        const provider = this.requireProvider();
        const requestDigest = digest(request);
        const fact = opFact('prepare', {
            provider: provider.name,
            clientOrderId: request.clientOrderId,
            requestDigest,
        }, {
            walletAddress: request.walletAddress,
            inputMint: request.inputMint,
            inputAmount: request.inputAmount,
        });
        const opToken = crypto.randomUUID();
        const existing = await this.db(
            'SELECT * FROM order_intents WHERE user_id = $1 AND client_order_id = $2',
            [userId, request.clientOrderId]
        );
        let orderId: string;
        if (existing.rows[0]) {
            const ready = await this.preparedFromExisting(existing.rows[0] as Row, requestDigest, provider);
            if (ready) return ready;
            orderId = String(existing.rows[0].id);
            await this.acquireLease(orderId, ['preparing'], opToken, fact);
        } else {
            orderId = crypto.randomUUID();
            const inserted = await this.db(
                `INSERT INTO order_intents
                 (id, user_id, provider, client_order_id, request_digest, wallet_address, order_type,
                  state, input_mint, output_mint, input_amount, trigger_mint, params, expires_at,
                  op_token, op_lease_until, op_kind, op_state, op_req_hash, op_want_hash, op_detail,
                  op_writer, op_ver, cluster)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'preparing', $8, $9, $10, $11, $12::jsonb, $13,
                         $14, NOW() + ($15::text || ' milliseconds')::interval,
                         $16, 'reserved', $17, $18, $19::jsonb, 2, 1, $20)
                 ON CONFLICT (user_id, client_order_id) DO NOTHING
                 RETURNING *`,
                [orderId, userId, provider.name, request.clientOrderId, requestDigest, request.walletAddress,
                    request.orderType, request.inputMint, request.outputMint, request.inputAmount,
                    request.triggerMint, JSON.stringify(request), request.expiresAt, opToken, env.ORDER_OP_LEASE_MS,
                    fact.kind, fact.reqHash, fact.wantHash, JSON.stringify(fact.detail),
                    provider.name === 'fixture' ? 'localnet' : 'mainnet-beta']
            );
            if (!inserted.rows[0]) {
                const raced = await this.db(
                    'SELECT * FROM order_intents WHERE user_id = $1 AND client_order_id = $2',
                    [userId, request.clientOrderId]
                );
                const ready = await this.preparedFromExisting(raced.rows[0] as Row, requestDigest, provider);
                if (ready) return ready;
                orderId = String(raced.rows[0].id);
                await this.acquireLease(orderId, ['preparing'], opToken, fact);
            }
        }

        const done = metrics.timer('fervor_order_prepare_ms', { provider: provider.name });
        let accepted = false;
        let evidence: Row | undefined;
        try {
            await this.startMutation(orderId, opToken);
            const prepared = await provider.prepare(request, authToken);
            accepted = true;
            evidence = {
                depositRequestId: prepared.depositRequestId,
                receiverAddress: prepared.receiverAddress,
                inputAccount: prepared.inputAccount,
                outputAccount: prepared.outputAccount,
                transaction: txFact(prepared.transaction),
            };
            if (provider.name !== 'fixture') {
                await this.validateProviderTx(prepared.transaction, depositIntent(
                    request,
                    prepared.receiverAddress,
                    prepared.inputAccount,
                    prepared.outputAccount
                ));
            }
            await this.tx(async (db) => {
                const updated = await db(
                    `UPDATE order_intents
                     SET state = 'prepared', deposit_request_id = $2, prepared_tx = $3, receiver_address = $4,
                         params = params || jsonb_strip_nulls(jsonb_build_object(
                             'depositAccount', $5, 'outputAccount', $6
                         )),
                         error_code = NULL, error_message = NULL, op_token = NULL, op_lease_until = NULL,
                         op_kind = NULL, op_state = NULL, op_req_hash = NULL, op_want_hash = NULL,
                         op_detail = NULL, op_started_at = NULL, unknown_at = NULL, unknown_detail = NULL,
                         op_writer = NULL
                     WHERE id = $1 AND state = 'preparing' AND op_token = $7
                     RETURNING *`,
                    [orderId, prepared.depositRequestId, prepared.transaction,
                        prepared.receiverAddress || null, prepared.inputAccount,
                        prepared.outputAccount || null, opToken]
                );
                if (!updated.rows[0]) {
                    throw new OrderError('order_state_conflict', 'Order preparation changed concurrently', 409, true);
                }
                await this.event(db, orderId, 'prepared', { depositRequestId: prepared.depositRequestId });
            });
            return {
                orderId,
                provider: provider.name,
                state: 'prepared',
                depositRequestId: prepared.depositRequestId,
                transaction: prepared.transaction,
                receiverAddress: prepared.receiverAddress,
                expiresAt: request.expiresAt,
                custody: provider.custody,
            };
        } catch (error) {
            const failure = accepted ? this.uncommitted(error) : error;
            await this.recordFailure(orderId, opToken, 'preparing', failure, evidence);
            throw failure;
        } finally {
            done();
        }
    }

    async activate(userId: string, orderId: string, signedTransaction: string, authToken?: string): Promise<OrderRecord> {
        decodeTransaction(signedTransaction);
        const provider = this.requireProvider();
        const result = await this.db('SELECT * FROM order_intents WHERE id = $1 AND user_id = $2', [orderId, userId]);
        const row = result.rows[0] as Row | undefined;
        if (!row) throw new OrderError('order_not_found', 'Order was not found', 404);
        if (row.provider_order_id) return fromRow(row);
        this.assertKnown(row);
        if (!['prepared', 'activating'].includes(String(row.state))) {
            throw new OrderError('order_not_prepared', 'Order is not ready for activation', 409);
        }
        const detail = params(row);
        const request = detail as OrderRequest;
        const depositRequestId = text(row.deposit_request_id);
        if (!depositRequestId) throw new OrderError('deposit_not_prepared', 'Order deposit is not prepared', 409, true);
        const preparedTx = text(row.prepared_tx);
        if (!preparedTx) throw new OrderError('deposit_not_prepared', 'Order deposit transaction is unavailable', 409, true);
        if (provider.name !== 'fixture') {
            try {
                await this.validateProviderTx(
                    preparedTx,
                    depositIntent(
                        request,
                        row.receiver_address,
                        detail.depositAccount,
                        detail.outputAccount
                    )
                );
                validateSignedTransaction(
                    parseTransaction(preparedTx),
                    parseTransaction(signedTransaction),
                    String(row.wallet_address)
                );
            } catch (error) {
                if (error instanceof OrderError) throw error;
                throw new OrderError('transaction_mismatch', error instanceof Error ? error.message : 'Signed deposit is invalid', 400);
            }
        }

        const fact = opFact('activate', {
            providerOrderId: text(row.provider_order_id),
            depositRequestId,
            transaction: txFact(signedTransaction),
        }, {
            state: 'open',
            walletAddress: row.wallet_address,
            requestDigest: row.request_digest,
        });
        const opToken = crypto.randomUUID();
        await this.acquireLease(orderId, ['prepared', 'activating'], opToken, fact, 'activating');
        let accepted = false;
        let evidence: Row | undefined;
        try {
            await this.startMutation(orderId, opToken);
            const active = await provider.activate(request, depositRequestId, signedTransaction, authToken);
            accepted = true;
            evidence = {
                providerOrderId: active.providerOrderId,
                state: active.state,
                depositSignature: active.depositSignature,
                rawState: active.rawState,
            };
            const updated = await this.tx(async (db) => {
                const result = await db(
                    `UPDATE order_intents SET state = $2, provider_order_id = $3, deposit_signature = $4,
                     raw_state = $5, error_code = NULL, error_message = NULL,
                     prepared_tx = NULL, op_token = NULL, op_lease_until = NULL,
                     op_kind = NULL, op_state = NULL, op_req_hash = NULL, op_want_hash = NULL,
                     op_detail = NULL, op_started_at = NULL, unknown_at = NULL, unknown_detail = NULL,
                     op_writer = NULL
                     WHERE id = $1 AND op_token = $6 RETURNING *`,
                    [orderId, active.state, active.providerOrderId, active.depositSignature || null, active.rawState || null, opToken]
                );
                if (!result.rows[0]) {
                    throw new OrderError('order_state_conflict', 'Order activation lease changed', 409, true);
                }
                await this.event(db, orderId, active.state, {
                    providerOrderId: active.providerOrderId,
                    signature: active.depositSignature,
                });
                return result.rows[0] as Row;
            });
            return fromRow(updated);
        } catch (error) {
            const failure = accepted ? this.uncommitted(error) : error;
            await this.recordFailure(orderId, opToken, 'activating', failure, evidence);
            throw failure;
        }
    }

    async update(userId: string, orderId: string, input: OrderUpdate, authToken?: string): Promise<OrderRecord> {
        const provider = this.requireProvider();
        const result = await this.db('SELECT * FROM order_intents WHERE id = $1 AND user_id = $2', [orderId, userId]);
        const row = result.rows[0] as Row | undefined;
        if (!row) throw new OrderError('order_not_found', 'Order was not found', 404);
        this.assertKnown(row);
        if (row.state !== 'open' || !row.provider_order_id) {
            throw new OrderError('order_not_editable', 'Only open orders can be edited', 409);
        }
        if (row.order_type !== input.orderType) {
            throw new OrderError('order_type_mismatch', 'Order type cannot be changed', 400);
        }
        const current = params(row);
        if (input.orderType === 'single') {
            const trailing = current.trailingBps !== undefined;
            if ((trailing && input.triggerPriceUsd !== undefined) || (!trailing && input.trailingBps !== undefined)) {
                throw new OrderError('order_mode_mismatch', 'Static and trailing orders cannot be converted', 400);
            }
        } else {
            const takeProfit = input.takeProfitPriceUsd ?? Number(current.takeProfitPriceUsd);
            const stopLoss = input.stopLossPriceUsd ?? Number(current.stopLossPriceUsd);
            if (!(takeProfit > stopLoss)) {
                throw new OrderError('invalid_price_band', 'Take profit must be above stop loss', 400);
            }
        }
        const patch = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const fact = opFact('edit', {
            providerOrderId: row.provider_order_id,
            patch,
        }, patch);
        const opToken = crypto.randomUUID();
        await this.acquireLease(orderId, ['open'], opToken, fact);
        let accepted = false;
        let evidence: Row | undefined;
        try {
            await this.startMutation(orderId, opToken);
            await provider.update(String(row.provider_order_id), input, authToken);
            accepted = true;
            evidence = { providerOrderId: row.provider_order_id, acknowledged: true };
            const updated = await this.tx(async (db) => {
                const result = await db(
                    `UPDATE order_intents
                     SET params = params || $2::jsonb,
                         op_token = NULL,
                         op_lease_until = NULL,
                         error_code = NULL,
                         error_message = NULL,
                         op_kind = NULL, op_state = NULL, op_req_hash = NULL, op_want_hash = NULL,
                         op_detail = NULL, op_started_at = NULL, unknown_at = NULL, unknown_detail = NULL,
                         op_writer = NULL
                     WHERE id = $1 AND op_token = $3
                     RETURNING *`,
                    [orderId, JSON.stringify(patch), opToken]
                );
                if (!result.rows[0]) {
                    throw new OrderError('order_state_conflict', 'Order update lease changed', 409, true);
                }
                await this.event(db, orderId, 'open', { action: 'updated', ...patch });
                return result.rows[0] as Row;
            });
            return fromRow(updated);
        } catch (error) {
            const failure = accepted ? this.uncommitted(error) : error;
            await this.recordFailure(orderId, opToken, 'open', failure, evidence);
            throw failure;
        }
    }

    async cancel(userId: string, orderId: string, authToken?: string): Promise<{ requestId: string; transaction: string }> {
        const provider = this.requireProvider();
        const result = await this.db('SELECT * FROM order_intents WHERE id = $1 AND user_id = $2', [orderId, userId]);
        const row = result.rows[0] as Row | undefined;
        if (!row) throw new OrderError('order_not_found', 'Order was not found', 404);
        if (row.state === 'cancel_pending' && row.cancel_request_id && row.cancel_tx) {
            if (provider.name !== 'fixture') {
                await this.validateProviderTx(
                    String(row.cancel_tx),
                    withdrawalIntent(row)
                );
            }
            return { requestId: String(row.cancel_request_id), transaction: String(row.cancel_tx) };
        }
        this.assertKnown(row);
        if (!['open', 'expired'].includes(String(row.state)) || !row.provider_order_id) {
            throw new OrderError('order_not_cancellable', 'Order is not cancellable', 409);
        }
        const fact = opFact('cancel_init', {
            providerOrderId: row.provider_order_id,
        }, {
            state: 'cancel_pending',
            providerOrderId: row.provider_order_id,
        });
        const opToken = crypto.randomUUID();
        await this.acquireLease(orderId, ['open', 'expired'], opToken, fact);
        let accepted = false;
        let evidence: Row | undefined;
        let recovery: { cancelRequestId: string; cancelTx: string } | undefined;
        try {
            await this.startMutation(orderId, opToken);
            const cancellation = await provider.cancel(String(row.provider_order_id), authToken);
            accepted = true;
            evidence = {
                providerOrderId: row.provider_order_id,
                cancelRequestId: cancellation.requestId,
                transaction: txFact(cancellation.transaction),
            };
            recovery = {
                cancelRequestId: cancellation.requestId,
                cancelTx: cancellation.transaction,
            };
            if (provider.name !== 'fixture') {
                await this.validateProviderTx(
                    cancellation.transaction,
                    withdrawalIntent(row)
                );
            }
            await this.tx(async (db) => {
                const updated = await db(
                    `UPDATE order_intents SET state = 'cancel_pending', cancel_request_id = $2, cancel_tx = $3,
                     error_code = NULL, error_message = NULL, op_token = NULL, op_lease_until = NULL,
                     op_kind = NULL, op_state = NULL, op_req_hash = NULL, op_want_hash = NULL,
                     op_detail = NULL, op_started_at = NULL, unknown_at = NULL, unknown_detail = NULL,
                     op_writer = NULL
                     WHERE id = $1 AND op_token = $4 RETURNING *`,
                    [orderId, cancellation.requestId, cancellation.transaction, opToken]
                );
                if (!updated.rows[0]) {
                    throw new OrderError('order_state_conflict', 'Cancellation lease changed', 409, true);
                }
                await this.event(db, orderId, 'cancel_pending', { cancelRequestId: cancellation.requestId });
            });
            return cancellation;
        } catch (error) {
            const failure = accepted ? this.uncommitted(error) : error;
            await this.recordFailure(orderId, opToken, String(row.state), failure, evidence, recovery);
            throw failure;
        }
    }

    async confirmCancel(
        userId: string,
        orderId: string,
        cancelRequestId: string,
        signedTransaction: string,
        authToken?: string
    ): Promise<OrderRecord> {
        decodeTransaction(signedTransaction);
        const provider = this.requireProvider();
        const result = await this.db('SELECT * FROM order_intents WHERE id = $1 AND user_id = $2', [orderId, userId]);
        const row = result.rows[0] as Row | undefined;
        if (!row) throw new OrderError('order_not_found', 'Order was not found', 404);
        if (row.state === 'cancelled') return fromRow(row);
        this.assertKnown(row);
        if (row.state !== 'cancel_pending' || row.cancel_request_id !== cancelRequestId || !row.provider_order_id) {
            throw new OrderError('cancel_state_conflict', 'Cancellation request does not match this order', 409);
        }
        const cancelTx = text(row.cancel_tx);
        if (!cancelTx) throw new OrderError('cancel_state_conflict', 'Cancellation transaction is unavailable', 409);
        if (provider.name !== 'fixture') {
            try {
                await this.validateProviderTx(
                    cancelTx,
                    withdrawalIntent(row)
                );
                validateSignedTransaction(
                    parseTransaction(cancelTx),
                    parseTransaction(signedTransaction),
                    String(row.wallet_address)
                );
            } catch (error) {
                if (error instanceof OrderError) throw error;
                throw new OrderError('transaction_mismatch', error instanceof Error ? error.message : 'Signed withdrawal is invalid', 400);
            }
        }
        const signed = txFact(signedTransaction);
        const fact = opFact('cancel_confirm', {
            providerOrderId: row.provider_order_id,
            cancelRequestId,
            transaction: signed,
        }, {
            state: 'cancelled',
            signature: signed.signature,
        });
        const opToken = crypto.randomUUID();
        await this.acquireLease(orderId, ['cancel_pending'], opToken, fact);
        let accepted = false;
        let evidence: Row | undefined;
        try {
            await this.startMutation(orderId, opToken);
            const cancelled = await provider.confirmCancel(String(row.provider_order_id), cancelRequestId, signedTransaction, authToken);
            accepted = true;
            evidence = {
                providerOrderId: row.provider_order_id,
                cancelRequestId,
                state: cancelled.state,
                signature: cancelled.signature,
                rawState: cancelled.rawState,
            };
            const updated = await this.tx(async (db) => {
                const result = await db(
                    `UPDATE order_intents SET state = $2, cancel_signature = $3, raw_state = $4,
                     cancel_tx = NULL, error_code = NULL, error_message = NULL,
                     op_token = NULL, op_lease_until = NULL,
                     op_kind = NULL, op_state = NULL, op_req_hash = NULL, op_want_hash = NULL,
                     op_detail = NULL, op_started_at = NULL, unknown_at = NULL, unknown_detail = NULL,
                     op_writer = NULL
                     WHERE id = $1 AND op_token = $5 RETURNING *`,
                    [orderId, cancelled.state, cancelled.signature || null, cancelled.rawState || null, opToken]
                );
                if (!result.rows[0]) {
                    throw new OrderError('order_state_conflict', 'Cancellation lease changed', 409, true);
                }
                await this.event(db, orderId, cancelled.state, { signature: cancelled.signature });
                return result.rows[0] as Row;
            });
            return fromRow(updated);
        } catch (error) {
            const failure = accepted ? this.uncommitted(error) : error;
            await this.recordFailure(orderId, opToken, 'cancel_pending', failure, evidence);
            throw failure;
        }
    }

    async list(userId: string, limit = 50): Promise<OrderRecord[]> {
        const result = await this.db(
            'SELECT * FROM order_intents WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
            [userId, Math.min(Math.max(limit, 1), 200)]
        );
        return result.rows.map((row) => fromRow(row as Row));
    }

    async get(userId: string, orderId: string): Promise<OrderRecord> {
        const result = await this.db('SELECT * FROM order_intents WHERE id = $1 AND user_id = $2', [orderId, userId]);
        if (!result.rows[0]) throw new OrderError('order_not_found', 'Order was not found', 404);
        return fromRow(result.rows[0] as Row);
    }

    async sync(userId: string, authToken?: string): Promise<OrderRecord[]> {
        const provider = this.requireProvider();
        if (!provider.history) return this.list(userId, 200);
        const local = await this.db(
            `SELECT *
             FROM order_intents
             WHERE user_id = $1 AND provider = $2
               AND (provider_order_id IS NOT NULL
                    OR error_code = $3 OR op_state = 'started')`,
            [userId, provider.name, unknownOutcome]
        );
        const snapshots = await provider.history(authToken);
        const byProviderId = new Map<string, Row>();
        for (const value of local.rows) {
            const row = value as Row;
            const detail = jsonRow(row.unknown_detail);
            const evidence = jsonRow(detail.evidence);
            const providerId = text(row.provider_order_id) || text(evidence.providerOrderId);
            if (providerId) byProviderId.set(providerId, row);
        }

        for (const snapshot of snapshots) {
            const row = byProviderId.get(snapshot.providerOrderId);
            if (!row) continue;
            if (snapshot.orderType !== row.order_type) {
                throw new OrderError('provider_contract_error', 'Order provider changed the order type', 502);
            }
            const orderId = String(row.id);
            const allowed = this.previousStates(snapshot.state);
            const providerFill = {
                fillPercent: snapshot.fillPercent,
                outputAmount: snapshot.outputAmount,
                inputUsed: snapshot.inputUsed,
                triggerPriceUsd: snapshot.triggerPriceUsd,
                trailingBps: snapshot.trailingBps,
                slippageBps: snapshot.slippageBps,
                takeProfitPriceUsd: snapshot.takeProfitPriceUsd,
                stopLossPriceUsd: snapshot.stopLossPriceUsd,
                takeProfitSlippageBps: snapshot.takeProfitSlippageBps,
                stopLossSlippageBps: snapshot.stopLossSlippageBps,
                highWatermark: snapshot.highWatermark,
                lowWatermark: snapshot.lowWatermark,
            };
            await this.tx(async (db) => {
                const financial = snapshot.moneyEvents !== undefined;
                const cluster = financial ? text(row.cluster) : undefined;
                const wallet = financial ? text(row.wallet_address) : undefined;
                if (financial && (!cluster || !wallet)) {
                    throw new OrderError('order_state_conflict', 'Order has no financial scope', 409);
                }
                if (cluster && wallet) {
                    await db('SELECT asset_scope_lock($1, $2)', [cluster, wallet]);
                }
                const current = (await db(
                    'SELECT * FROM order_intents WHERE id = $1 FOR UPDATE',
                    [orderId]
                )).rows[0] as Row | undefined;
                if (!current) return;
                if (financial && (text(current.cluster) !== cluster
                    || text(current.wallet_address) !== wallet)) {
                    throw new OrderError('order_state_conflict', 'Order financial scope changed', 409);
                }
                await new ProviderMoneySync(db).ingest(current, provider.name, snapshot);
                const updated = await db(
                    `UPDATE order_intents
                     SET state = $2,
                         raw_state = $3::varchar,
                         deposit_signature = COALESCE($4::varchar, deposit_signature),
                         fill_signature = COALESCE($5::varchar, fill_signature),
                         cancel_signature = COALESCE($6::varchar, cancel_signature),
                         params = params || jsonb_build_object('providerFill', $7::jsonb),
                         provider_order_id = COALESCE(provider_order_id, $8::varchar),
                         provider_state = COALESCE($3::varchar, $2::varchar),
                         provider_at = $10::timestamptz,
                         sync_at = clock_timestamp()
                     WHERE id = $1 AND state = ANY($9::varchar[])
                       AND (provider_at IS NULL OR provider_at <= $10::timestamptz)
                       AND (state <> $2 OR raw_state IS DISTINCT FROM $3
                            OR provider_order_id IS NULL
                            OR provider_at IS DISTINCT FROM $10::timestamptz
                            OR ($5::varchar IS NOT NULL AND fill_signature IS DISTINCT FROM $5::varchar)
                            OR ($6::varchar IS NOT NULL AND cancel_signature IS DISTINCT FROM $6::varchar))
                     RETURNING *`,
                    [orderId, snapshot.state, snapshot.rawState || null, snapshot.depositSignature || null,
                        snapshot.fillSignature || null, snapshot.cancelSignature || null,
                        JSON.stringify(providerFill), snapshot.providerOrderId, allowed, snapshot.updatedAt || null]
                );
                if (!updated.rows[0]) return;
                await this.event(db, orderId, snapshot.state, {
                    providerOrderId: snapshot.providerOrderId,
                    rawState: snapshot.rawState,
                    fillSignature: snapshot.fillSignature,
                    cancelSignature: snapshot.cancelSignature,
                    ...providerFill,
                });
            });

            const proof = this.reconciliationProof(row, snapshot);
            if (proof) {
                await this.tx(async (db) => {
                    const resolved = await db(
                        `UPDATE order_intents
                         SET state = $2,
                             provider_order_id = COALESCE(provider_order_id, $3),
                             params = params || $4::jsonb,
                             error_code = NULL, error_message = NULL,
                             op_token = NULL, op_lease_until = NULL,
                             op_kind = NULL, op_state = NULL, op_req_hash = NULL, op_want_hash = NULL,
                             op_detail = NULL, op_started_at = NULL, unknown_at = NULL, unknown_detail = NULL,
                             op_writer = NULL
                         WHERE id = $1 AND error_code = $5 AND op_state = 'started'
                           AND op_kind = $6 AND op_want_hash = $7
                           AND op_writer = $8 AND op_ver = $9
                           AND op_started_at = $10 AND unknown_at = $11
                           AND op_req_hash = $12 AND op_detail = $13::jsonb
                         RETURNING id`,
                        [orderId, snapshot.state, snapshot.providerOrderId,
                            JSON.stringify(proof.patch || {}), unknownOutcome,
                            proof.kind, row.op_want_hash, row.op_writer, row.op_ver,
                            row.op_started_at, row.unknown_at, row.op_req_hash,
                            JSON.stringify(jsonRow(row.op_detail))]
                    );
                    if (!resolved.rows[0]) return;
                    await this.event(db, orderId, snapshot.state, {
                        action: 'provider_outcome_reconciled',
                        operation: proof.kind,
                        providerOrderId: snapshot.providerOrderId,
                    });
                });
            }
        }
        return this.list(userId, 200);
    }

    private reconciliationProof(
        row: Row,
        snapshot: ProviderOrderSnapshot
    ): { kind: OpKind; patch?: Row } | null {
        const startedAt = Date.parse(String(row.op_started_at));
        const providerAt = Date.parse(snapshot.updatedAt || '');
        if (row.error_code !== unknownOutcome || row.op_state !== 'started'
            || row.op_writer !== 2 || !Number.isSafeInteger(Number(row.op_ver))
            || Number(row.op_ver) < 1 || !row.unknown_at || !row.op_req_hash
            || !Number.isFinite(startedAt) || !Number.isFinite(providerAt)
            || providerAt < startedAt) return null;
        const fact = jsonRow(row.op_detail);
        const want = jsonRow(fact.want);
        if (factDigest(want) !== row.op_want_hash) return null;

        if (row.op_kind === 'edit') {
            if (want.orderType !== row.order_type) return null;
            const observed: Row = {
                triggerPriceUsd: snapshot.triggerPriceUsd,
                trailingBps: snapshot.trailingBps,
                slippageBps: snapshot.slippageBps,
                takeProfitPriceUsd: snapshot.takeProfitPriceUsd,
                stopLossPriceUsd: snapshot.stopLossPriceUsd,
                takeProfitSlippageBps: snapshot.takeProfitSlippageBps,
                stopLossSlippageBps: snapshot.stopLossSlippageBps,
            };
            const fields = Object.entries(want).filter(([key]) => key !== 'orderType');
            if (!fields.length || !fields.every(([key, value]) => observed[key] === value)) return null;
            return { kind: 'edit', patch: want };
        }

        if (row.op_kind === 'cancel_init' && snapshot.state === 'cancel_pending') {
            const unknown = jsonRow(row.unknown_detail);
            const evidence = jsonRow(unknown.evidence);
            const transaction = jsonRow(evidence.transaction);
            if (!row.cancel_request_id || !row.cancel_tx
                || evidence.cancelRequestId !== row.cancel_request_id
                || txFact(String(row.cancel_tx)).rawHash !== transaction.rawHash) return null;
            return { kind: 'cancel_init' };
        }
        // Financial activation and withdrawal confirmation require independent
        // chain evidence; provider history alone is not sufficient proof.
        return null;
    }

    private async preparedFromExisting(
        row: Row,
        requestDigest: string,
        provider: OrderProvider
    ): Promise<PreparedOrder | null> {
        if (String(row.request_digest) !== requestDigest) {
            throw new OrderError('idempotency_conflict', 'Client order ID was used for different parameters', 409);
        }
        this.assertKnown(row);
        if (row.state === 'preparing') return null;
        if (row.state !== 'prepared' || !row.prepared_tx || !row.deposit_request_id) {
            throw new OrderError('order_already_exists', `Order already exists in ${row.state} state`, 409);
        }
        const prepared = {
            orderId: String(row.id),
            provider: provider.name,
            state: 'prepared',
            depositRequestId: String(row.deposit_request_id),
            transaction: String(row.prepared_tx),
            receiverAddress: text(row.receiver_address),
            expiresAt: iso(row.expires_at),
            custody: provider.custody,
        } as const;
        if (provider.name !== 'fixture') {
            const detail = params(row);
            await this.validateProviderTx(prepared.transaction, depositIntent(
                detail as OrderRequest,
                row.receiver_address,
                detail.depositAccount,
                detail.outputAccount
            ));
        }
        return prepared;
    }

    private async acquireLease(
        orderId: string,
        states: string[],
        opToken: string,
        fact: OpFact,
        nextState?: string
    ): Promise<void> {
        const result = await this.db(
            `UPDATE order_intents
             SET op_token = $2,
                 op_lease_until = NOW() + ($3::text || ' milliseconds')::interval,
                 state = COALESCE($5, state),
                 op_kind = $6,
                 op_state = 'reserved',
                 op_req_hash = $7,
                 op_want_hash = $8,
                 op_detail = $9::jsonb,
                 op_started_at = NULL,
                 unknown_at = NULL,
                 unknown_detail = NULL,
                 op_writer = 2,
                 op_ver = op_ver + 1
             WHERE id = $1
               AND state = ANY($4::varchar[])
               AND error_code IS DISTINCT FROM $10
               AND op_state IS DISTINCT FROM 'started'
               AND (op_lease_until IS NULL OR op_lease_until <= NOW())
             RETURNING id`,
            [orderId, opToken, env.ORDER_OP_LEASE_MS, states, nextState || null,
                fact.kind, fact.reqHash, fact.wantHash, JSON.stringify(fact.detail), unknownOutcome]
        );
        if (!result.rows[0]) {
            const current = await this.db(
                'SELECT error_code, op_state FROM order_intents WHERE id = $1',
                [orderId]
            );
            if (current.rows[0]?.error_code === unknownOutcome
                || current.rows[0]?.op_state === 'started') {
                throw new OrderError(
                    'order_reconciliation_required',
                    'The previous provider mutation has an unknown outcome',
                    409
                );
            }
            throw new OrderError('order_in_progress', 'Another order operation is in progress', 409, true);
        }
    }

    private async startMutation(orderId: string, opToken: string): Promise<void> {
        const result = await this.db(
            `UPDATE order_intents
             SET op_state = 'started', op_started_at = clock_timestamp()
             WHERE id = $1 AND op_token = $2 AND op_state = 'reserved'
               AND op_lease_until > clock_timestamp()
             RETURNING id`,
            [orderId, opToken]
        );
        if (!result.rows[0]) {
            throw new OrderError(
                'order_operation_expired',
                'Order operation expired before provider dispatch',
                409,
                true
            );
        }
    }

    private assertKnown(row: Row): void {
        if (row.error_code === unknownOutcome || row.op_state === 'started') {
            throw new OrderError(
                'order_reconciliation_required',
                'The previous provider mutation has an unknown outcome',
                409,
                false
            );
        }
    }

    private uncommitted(error: unknown): OrderProviderError {
        if (error instanceof OrderProviderError && error.uncertain) return error;
        return new OrderProviderError(
            'provider_result_uncommitted',
            'The provider result could not be committed locally',
            false,
            503,
            undefined,
            true
        );
    }

    private async recordFailure(
        orderId: string,
        opToken: string,
        state: string,
        error: unknown,
        evidence?: Row,
        recovery?: { cancelRequestId: string; cancelTx: string }
    ): Promise<void> {
        const uncertain = error instanceof OrderProviderError && error.uncertain;
        const code = uncertain ? unknownOutcome
            : error instanceof OrderProviderError ? error.code
                : error instanceof Error ? error.name : 'order_operation_failed';
        const message = error instanceof OrderProviderError
            ? `Order provider operation failed (${error.code})`
            : error instanceof Error ? error.message.slice(0, 500) : 'Order operation failed';
        if (uncertain) {
            const detail = {
                providerCode: error.code,
                providerStatus: error.status,
                retryable: error.retryable,
                evidence: canonical(evidence || {}),
            };
            try {
                const changed = await this.db(
                    `UPDATE order_intents
                     SET error_code = $2, error_message = $3,
                         unknown_at = clock_timestamp(), unknown_detail = $5::jsonb,
                         cancel_request_id = COALESCE($6, cancel_request_id),
                         cancel_tx = COALESCE($7, cancel_tx),
                         op_token = NULL, op_lease_until = NULL,
                         op_ver = op_ver + 1
                     WHERE id = $1 AND op_token = $4 AND op_state = 'started'
                     RETURNING id`,
                    [orderId, unknownOutcome, message, opToken, JSON.stringify(detail),
                        recovery?.cancelRequestId || null, recovery?.cancelTx || null]
                );
                if (!changed.rows[0]) {
                    const current = await this.db(
                        'SELECT error_code, op_state FROM order_intents WHERE id = $1',
                        [orderId]
                    );
                    if (current.rows[0]?.error_code !== unknownOutcome
                        && current.rows[0]?.op_state !== 'started') {
                        throw new OrderError(
                            'order_state_conflict', 'Order operation lease changed', 409, true
                        );
                    }
                }
            } catch (writeError) {
                metrics.increment('fervor_order_unknown_write_errors');
                if (writeError instanceof OrderError) throw writeError;
                // The committed started fact remains the authoritative replay block.
                return;
            }
            try {
                await this.tx((db) => this.event(db, orderId, state, {
                    action: unknownOutcome,
                    providerCode: error.code,
                }));
            } catch {
                metrics.increment('fervor_order_unknown_event_errors');
            }
            return;
        }
        await this.tx(async (db) => {
            const changed = await db(
                `UPDATE order_intents
                 SET error_code = $2, error_message = $3,
                     op_token = NULL, op_lease_until = NULL,
                     op_kind = NULL, op_state = NULL, op_req_hash = NULL, op_want_hash = NULL,
                     op_detail = NULL, op_started_at = NULL, unknown_at = NULL, unknown_detail = NULL,
                     op_writer = NULL
                 WHERE id = $1 AND op_token = $4
                 RETURNING id`,
                [orderId, code, message, opToken]
            );
            if (!changed.rows[0]) {
                throw new OrderError(
                    'order_state_conflict', 'Order operation lease changed', 409, true
                );
            }
        });
    }

    private previousStates(state: OrderRecord['state']): OrderRecord['state'][] {
        if (state === 'activating') return ['preparing', 'prepared', 'activating'];
        if (state === 'open') return ['activating', 'open'];
        if (state === 'executing') return ['open', 'executing'];
        if (state === 'partially_filled') return ['open', 'executing', 'partially_filled'];
        if (state === 'filled') return ['open', 'executing', 'partially_filled', 'filled'];
        if (state === 'cancel_pending') return ['open', 'expired', 'cancel_pending'];
        if (state === 'cancelled') return ['open', 'cancel_pending', 'expired', 'cancelled'];
        if (state === 'expired') return ['open', 'executing', 'expired'];
        if (state === 'failed') {
            return ['preparing', 'prepared', 'activating', 'open', 'executing', 'partially_filled', 'cancel_pending', 'failed'];
        }
        return [state];
    }

    private async event(db: DbQuery, orderId: string, state: string, metadata: Row): Promise<void> {
        await db(
            'INSERT INTO order_events (order_id, state, metadata) VALUES ($1, $2, $3::jsonb)',
            [orderId, state, JSON.stringify(metadata)]
        );
        const event = {
            id: crypto.randomUUID(), type: 'orders.lifecycle', version: 1, key: orderId,
            source: 'order-service', occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
            payload: { orderId, state, ...metadata },
        };
        await eventOutbox.enqueue(db, STREAMS.orderLifecycle, `order:${orderId}:${event.id}`, event);
    }

    private requireProvider(): OrderProvider {
        if (!this.provider) throw new OrderError('orders_disabled', 'Conditional orders are disabled', 503);
        return this.provider;
    }

    private async validateProviderTx(value: string, intent: OrderTxIntent): Promise<void> {
        try {
            if (!this.resolver) throw new Error('Solana RPC is unavailable');
            const parsed = parseSolanaTransaction(value, env.MAX_TRANSACTION_BYTES);
            await validateOrderTx(parsed, intent, this.resolver);
        } catch (error) {
            if (error instanceof SolanaLookupUnavailable) {
                throw new OrderError(
                    'transaction_validation_unavailable',
                    `Provider ${intent.kind} transaction validation is unavailable`,
                    503,
                    true
                );
            }
            throw new OrderError(
                'provider_contract_error',
                `Provider ${intent.kind} transaction is invalid`,
                502
            );
        }
    }

    private safeProvider(): OrderProvider | null {
        try {
            return createOrderProvider();
        } catch {
            return null;
        }
    }

    private safeResolver(): OrderTxResolver | null {
        return env.SOLANA_RPC_URL
            ? new SolanaLookupResolver(env.SOLANA_RPC_URL, env.EXECUTION_TIMEOUT_MS)
            : null;
    }
}
