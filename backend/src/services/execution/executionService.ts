import crypto from 'crypto';
import { DbQuery, query, transaction } from '../../config/database';
import { env, EXECUTION_LEASE_MARGIN_MS } from '../../config/env';
import {
    ExecutionCapabilities,
    ExecutionProviderName,
    QuoteRequest,
    SubmitRequest,
    SwapQuote,
    TradeExecution,
    addressSchema,
    amountSchema,
    u64Text,
} from '../../types';
import { eventOutbox } from '../eventOutbox';
import { metrics } from '../metrics';
import { STREAMS } from '../redisStreamService';
import {
    parseSolanaTransaction,
    parseSolanaTransactionBytes,
    SolanaTransaction,
    transactionSignature,
    validatePreparedTransaction,
    validateSignedTransaction,
    verifySolanaSignature,
    verifySolanaSignerAt,
} from '../solanaTransaction';
import { abortable } from '../providerCall';
import { ExecutionProviderError, SwapProvider } from './provider';
import {
    ExecutionTxError,
    ExecutionTxStore,
    type SealedExecutionTx,
} from './executionTxStore';

type Row = Record<string, unknown>;
type TxFn = <T>(work: (db: DbQuery) => Promise<T>) => Promise<T>;

export interface ExecutionRecoveryResult {
    checked: number;
    replayed: number;
}

export class ExecutionError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly status: number,
        readonly retryable = false
    ) {
        super(message);
        this.name = 'ExecutionError';
    }
}

const sha256 = (value: string | Buffer): string => crypto.createHash('sha256').update(value).digest('hex');

const quoteDigest = (quote: Omit<SwapQuote, 'integrityDigest'>): string => crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update([
        quote.id,
        quote.provider,
        quote.providerQuoteId,
        quote.inputMint,
        quote.outputMint,
        quote.inputAmount,
        quote.outputAmount,
        quote.minOutputAmount,
        quote.taker,
        quote.feePayer,
        quote.expiresAt,
        quote.transactionDigest,
    ].join(':'))
    .digest('hex');

const iso = (value: unknown): string => {
    const date = value instanceof Date ? value : new Date(String(value));
    return date.toISOString();
};

const optionalString = (value: unknown): string | undefined =>
    value === undefined || value === null ? undefined : String(value);

const executionFromRow = (row: Row): TradeExecution => ({
    id: String(row.id),
    quoteId: String(row.quote_id),
    provider: String(row.provider) as ExecutionProviderName,
    walletAddress: String(row.wallet_address),
    state: row.state as TradeExecution['state'],
    signature: optionalString(row.signature),
    inputMint: String(row.input_mint),
    outputMint: String(row.output_mint),
    expectedInputAmount: String(row.expected_input_amount),
    expectedOutputAmount: String(row.expected_output_amount),
    providerInputAmount: optionalString(row.provider_input_amount),
    providerOutputAmount: optionalString(row.provider_output_amount),
    actualInputAmount: optionalString(row.actual_input_amount),
    actualOutputAmount: optionalString(row.actual_output_amount),
    settlementStatus: String(row.settlement_status || 'pending') as TradeExecution['settlementStatus'],
    settlementSlot: optionalString(row.settlement_slot),
    settlementCommitment: optionalString(row.settlement_commitment) as TradeExecution['settlementCommitment'],
    settlementFeeLamports: optionalString(row.settlement_fee_lamports),
    errorCode: optionalString(row.error_code),
    errorMessage: optionalString(row.error_message),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
});

const decodeTransaction = (value: string): Buffer => {
    const normalized = value.replace(/\s/g, '');
    const decoded = Buffer.from(normalized, 'base64');
    if (decoded.length === 0 || decoded.length > env.MAX_TRANSACTION_BYTES) {
        throw new ExecutionError('invalid_transaction', 'Signed transaction has an invalid size', 400);
    }
    const roundTrip = decoded.toString('base64').replace(/=+$/, '');
    if (roundTrip !== normalized.replace(/=+$/, '')) {
        throw new ExecutionError('invalid_transaction', 'Signed transaction must be base64 encoded', 400);
    }
    return decoded;
};

const parseProviderTransaction = (
    value: string,
    expectedSigner: string,
    expectedFeePayer: string
): SolanaTransaction => {
    try {
        const parsed = parseSolanaTransaction(value, env.MAX_TRANSACTION_BYTES);
        validatePreparedTransaction(parsed, expectedSigner, expectedFeePayer);
        const signers = expectedFeePayer === expectedSigner
            ? [expectedSigner] : [expectedFeePayer, expectedSigner];
        if (parsed.requiredSigners.length !== signers.length
            || parsed.requiredSigners.some((signer, index) => signer !== signers[index])
            || parsed.signatures.some((signature) => signature.some((byte) => byte !== 0))) {
            throw new Error('Provider transaction signer shape is invalid');
        }
        return parsed;
    } catch {
        throw new ExecutionError('provider_contract_error', 'Provider returned an invalid transaction contract', 502);
    }
};

const parseSignedTransaction = (value: Buffer): SolanaTransaction => {
    try {
        return parseSolanaTransactionBytes(value, env.MAX_TRANSACTION_BYTES);
    } catch (error) {
        throw new ExecutionError(
            'invalid_transaction',
            error instanceof Error ? error.message : 'Signed transaction is invalid',
            400
        );
    }
};

const matchesProviderSignature = (
    transaction: SolanaTransaction,
    local: string | undefined,
    provided: string | undefined
): boolean => !provided || (local
    ? provided === local
    : verifySolanaSignature(transaction, transaction.feePayer, provided));

const validateSignedContract = (quote: Row, signed: SolanaTransaction): void => {
    const wallet = String(quote.wallet_address);
    const feePayer = String(quote.fee_payer);
    const signers = feePayer === wallet ? [wallet] : [feePayer, wallet];
    if (signed.requiredSigners.length !== signers.length
        || signed.requiredSigners.some((signer, index) => signer !== signers[index])) {
        throw new Error('Signed transaction signer shape is invalid');
    }
    validateSignedTransaction(
        { ...signed, messageDigest: String(quote.transaction_digest), feePayer },
        signed,
        wallet,
        feePayer === wallet ? undefined : new Set([feePayer])
    );
};

const validateProviderQuote = (
    provider: SwapProvider,
    request: QuoteRequest,
    quote: Awaited<ReturnType<SwapProvider['quote']>>
): void => {
    const amountLimit = request.slippageBps ?? env.MAX_SLIPPAGE_BPS;
    const amountsValid = quote.inputAmount === request.inputAmount
        && amountSchema.safeParse(quote.outputAmount).success
        && amountSchema.safeParse(quote.minOutputAmount).success
        && BigInt(quote.minOutputAmount) <= BigInt(quote.outputAmount);
    const routeValid = quote.route.length <= 16 && quote.route.every((entry) =>
        entry.venue.length > 0 && Number.isFinite(entry.percent) && entry.percent >= 0 && entry.percent <= 100
    );
    if (quote.provider !== provider.name || quote.taker !== request.taker
        || !addressSchema.safeParse(quote.feePayer).success || !amountsValid || !routeValid
        || !Number.isInteger(quote.slippageBps) || quote.slippageBps < 0 || quote.slippageBps > amountLimit) {
        throw new ExecutionError('provider_contract_error', 'Provider quote failed integrity validation', 502);
    }
};

export class ExecutionService {
    private provider: SwapProvider | null;

    constructor(
        provider?: SwapProvider | null,
        private readonly db: DbQuery = query,
        private readonly tx: TxFn = transaction,
        private readonly txStore = new ExecutionTxStore()
    ) {
        this.provider = provider ?? null;
    }

    capabilities(): ExecutionCapabilities {
        return {
            mode: env.TRADING_MODE,
            provider: this.provider?.name || 'none',
            canQuote: this.provider !== null,
            canSubmit: this.provider !== null && env.TRADING_MODE !== 'disabled',
            clientSigning: true,
            managedLanding: true,
            maxSlippageBps: env.MAX_SLIPPAGE_BPS,
            maxPriorityFeeLamports: env.MAX_PRIORITY_FEE_LAMPORTS,
            maxJitoTipLamports: env.MAX_JITO_TIP_LAMPORTS,
            quoteTtlMs: env.QUOTE_TTL_MS,
        };
    }

    async createQuote(userId: string, request: QuoteRequest): Promise<SwapQuote> {
        const provider = this.requireProvider();
        if (request.slippageBps && request.slippageBps > env.MAX_SLIPPAGE_BPS) {
            throw new ExecutionError('slippage_too_high', `Slippage cannot exceed ${env.MAX_SLIPPAGE_BPS} bps`, 400);
        }
        if (request.priorityFeeLamports && request.priorityFeeLamports > env.MAX_PRIORITY_FEE_LAMPORTS) {
            throw new ExecutionError(
                'priority_fee_too_high',
                `Priority fee cannot exceed ${env.MAX_PRIORITY_FEE_LAMPORTS} lamports`,
                400
            );
        }
        if (request.jitoTipLamports && request.jitoTipLamports > env.MAX_JITO_TIP_LAMPORTS) {
            throw new ExecutionError(
                'jito_tip_too_high',
                `Jito tip cannot exceed ${env.MAX_JITO_TIP_LAMPORTS} lamports`,
                400
            );
        }

        const done = metrics.timer('fervor_quote_ms', { provider: provider.name });
        try {
            const providerQuote = await provider.quote(request);
            validateProviderQuote(provider, request, providerQuote);
            const now = new Date();
            const expiresAt = new Date(now.getTime() + env.QUOTE_TTL_MS);
            const id = crypto.randomUUID();
            const parsedTransaction = parseProviderTransaction(
                providerQuote.transaction,
                request.taker,
                providerQuote.feePayer
            );
            const baseQuote: Omit<SwapQuote, 'integrityDigest'> = {
                id,
                ...providerQuote,
                inputMint: request.inputMint,
                outputMint: request.outputMint,
                transactionDigest: parsedTransaction.messageDigest,
                requiresSignature: true,
                createdAt: now.toISOString(),
                expiresAt: expiresAt.toISOString(),
            };
            const quote: SwapQuote = {
                ...baseQuote,
                integrityDigest: quoteDigest(baseQuote),
            };

            await this.db(
                `INSERT INTO trade_quotes
                 (id, user_id, wallet_address, provider, provider_quote_id, input_mint, output_mint,
                  input_amount, output_amount, min_output_amount, slippage_bps, transaction_digest,
                  integrity_digest, expires_at, fee_payer)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
                [
                    quote.id,
                    userId,
                    quote.taker,
                    quote.provider,
                    quote.providerQuoteId,
                    quote.inputMint,
                    quote.outputMint,
                    quote.inputAmount,
                    quote.outputAmount,
                    quote.minOutputAmount,
                    quote.slippageBps,
                    quote.transactionDigest,
                    quote.integrityDigest,
                    quote.expiresAt,
                    quote.feePayer,
                ]
            );
            metrics.increment('fervor_quotes_total', { provider: provider.name });
            return quote;
        } finally {
            done();
        }
    }

    async submit(userId: string, quoteId: string, request: SubmitRequest, traceId: string): Promise<TradeExecution> {
        const provider = this.requireProvider();
        const signedBytes = decodeTransaction(request.signedTransaction);
        const signedDigest = sha256(signedBytes);
        const parsedSigned = parseSignedTransaction(signedBytes);
        if (parsedSigned.signatures.some((signature, index) =>
            signature.some((byte) => byte !== 0)
            && !verifySolanaSignerAt(parsedSigned, index))) {
            throw new ExecutionError(
                'invalid_transaction',
                'Transaction contains an invalid signer signature',
                400
            );
        }
        const localSignature = transactionSignature(parsedSigned);
        const executionId = crypto.randomUUID();
        const sealed = await this.prepareBlob(
            userId,
            quoteId,
            request.idempotencyKey,
            signedDigest,
            executionId,
            provider,
            parsedSigned
        );

        const execution = await this.tx(async (db) => {
            // Serialize a user's retries without globally contending unrelated submissions.
            await db('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${userId}:${request.idempotencyKey}`]);
            const existing = await db(
                `SELECT * FROM trade_executions WHERE user_id = $1 AND idempotency_key = $2`,
                [userId, request.idempotencyKey]
            );
            if (existing.rows[0]) {
                const row = existing.rows[0] as Row;
                if (String(row.quote_id) !== quoteId || String(row.signed_tx_digest) !== signedDigest) {
                    throw new ExecutionError('idempotency_conflict', 'Idempotency key was used for another submission', 409);
                }
                return row;
            }

            const quoteResult = await db(
                `UPDATE trade_quotes
                 SET state = 'consumed'
                 WHERE id = $1 AND user_id = $2 AND provider = $3
                   AND state = 'quoted' AND expires_at > CURRENT_TIMESTAMP
                 RETURNING *`,
                [quoteId, userId, provider.name]
            );
            const quote = quoteResult.rows[0] as Row | undefined;
            if (!quote) {
                const lookup = await db(
                    'SELECT state, provider, expires_at FROM trade_quotes WHERE id = $1 AND user_id = $2',
                    [quoteId, userId]
                );
                if (!lookup.rows[0]) throw new ExecutionError('quote_not_found', 'Quote was not found', 404);
                if (String(lookup.rows[0].provider) !== provider.name) {
                    throw new ExecutionError('provider_mismatch', 'Quote provider is not active', 409, true);
                }
                if (new Date(lookup.rows[0].expires_at).getTime() <= Date.now()) {
                    throw new ExecutionError('quote_expired', 'Quote expired. Request a fresh quote.', 409, true);
                }
                throw new ExecutionError('quote_consumed', 'Quote has already been submitted', 409);
            }
            try {
                validateSignedContract(quote, parsedSigned);
            } catch (error) {
                throw new ExecutionError(
                    'transaction_mismatch',
                    error instanceof Error ? error.message : 'Signed transaction failed intent validation',
                    400
                );
            }
            if (env.TRADING_MODE === 'live' && !sealed) {
                throw new ExecutionError(
                    'execution_state_conflict',
                    'Execution changed before its encrypted transaction was prepared',
                    409,
                    true
                );
            }

            const inserted = await db(
                `INSERT INTO trade_executions
                 (id, quote_id, user_id, wallet_address, provider, idempotency_key, state,
                  input_mint, output_mint, expected_input_amount, expected_output_amount,
                  signed_tx_digest, signature)
                 VALUES ($1, $2, $3, $4, $5, $6, 'signed', $7, $8, $9, $10, $11, $12)
                 RETURNING *`,
                [
                    executionId,
                    quoteId,
                    userId,
                    quote.wallet_address,
                    quote.provider,
                    request.idempotencyKey,
                    quote.input_mint,
                    quote.output_mint,
                    quote.input_amount,
                    quote.output_amount,
                    signedDigest,
                    localSignature || null,
                ]
            );
            const row = inserted.rows[0] as Row;
            if (sealed) await this.txStore.insert(db, sealed);
            await this.recordEvent(db, String(row.id), 'signed', traceId, { quoteId });
            return row;
        });

        if (String(execution.state) !== 'signed') return executionFromRow(execution);
        // The idempotency lookup above proved this is the identical signed wire transaction.
        // Replaying it cannot create a second Solana execution: the message, blockhash, and
        // signatures are unchanged, so it retains one transaction identity until expiry.
        return this.broadcast(execution, request.signedTransaction, traceId, provider, parsedSigned);
    }

    async getExecution(userId: string, executionId: string): Promise<TradeExecution> {
        const result = await this.db('SELECT * FROM trade_executions WHERE id = $1 AND user_id = $2', [executionId, userId]);
        if (!result.rows[0]) throw new ExecutionError('execution_not_found', 'Execution was not found', 404);
        return executionFromRow(result.rows[0] as Row);
    }

    async listExecutions(userId: string, limit = 50): Promise<TradeExecution[]> {
        const result = await this.db(
            `SELECT * FROM trade_executions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
            [userId, Math.min(Math.max(limit, 1), 200)]
        );
        return result.rows.map((row) => executionFromRow(row as Row));
    }

    async recoverBatch(): Promise<ExecutionRecoveryResult> {
        const provider = this.provider;
        if (!provider || provider.name !== 'jupiter_swap_v2') {
            return { checked: 0, replayed: 0 };
        }
        const width = Math.min(env.EXECUTION_RECONCILE_BATCH, env.EGRESS_DB_POOL_MAX);
        const settled = await Promise.allSettled(
            Array.from({ length: width }, () => this.recoverOne(provider))
        );
        const failed = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
        if (failed) throw failed.reason;
        const values = settled.map((item) => (item as PromiseFulfilledResult<[number, number]>).value);
        const result = values.reduce<ExecutionRecoveryResult>((total, [checked, replayed]) => ({
            checked: total.checked + checked,
            replayed: total.replayed + replayed,
        }), { checked: 0, replayed: 0 });
        metrics.increment('fervor_execution_recovery_checked', undefined, result.checked);
        metrics.increment('fervor_execution_recovery_replayed', undefined, result.replayed);
        return result;
    }

    private async recoverOne(provider: SwapProvider): Promise<[number, number]> {
        const traceId = crypto.randomUUID();
        try {
            const replayed = await this.txStore.withRecovery(
                this.db,
                Math.max(
                    env.EXECUTION_RECONCILE_LEASE_MS,
                    env.EXECUTION_OP_LEASE_MS,
                    env.TX_KMS_TIMEOUT_MS + EXECUTION_LEASE_MARGIN_MS
                ),
                env.EXECUTION_SHARD_COUNT,
                env.EXECUTION_SHARD_ID,
                async (recovery) => {
                    try {
                        await this.runClaimed(
                            recovery.executionId,
                            recovery.opToken,
                            recovery.providerQuoteId,
                            recovery.signedTransaction,
                            traceId,
                            provider,
                            recovery.transaction,
                            true
                        );
                    } catch (error) {
                        if (!(error instanceof ExecutionError)) throw error;
                        return error.code !== 'execution_state_conflict';
                    }
                    return true;
                }
            );
            return replayed === undefined ? [0, 0] : [1, replayed ? 1 : 0];
        } catch (error) {
            if (!(error instanceof ExecutionTxError)) throw error;
            await this.markRecovery(error, traceId);
            return [1, 0];
        }
    }

    private async broadcast(
        execution: Row,
        signedTransaction: string,
        traceId: string,
        provider: SwapProvider,
        signed: SolanaTransaction
    ): Promise<TradeExecution> {
        const executionId = String(execution.id);
        const quoteResult = await this.db('SELECT provider_quote_id FROM trade_quotes WHERE id = $1', [execution.quote_id]);
        const providerQuoteId = optionalString(quoteResult.rows[0]?.provider_quote_id);
        if (!providerQuoteId) throw new ExecutionError('quote_not_found', 'Provider quote was not found', 409);

        const opToken = crypto.randomUUID();
        const result = await this.db(
            `UPDATE trade_executions
             SET op_token = $2,
                 op_lease_until = clock_timestamp() + ($3::text || ' milliseconds')::interval
             WHERE id = $1 AND state = 'signed'
               AND (op_lease_until IS NULL OR op_lease_until <= clock_timestamp())
             RETURNING *`,
            [executionId, opToken, env.EXECUTION_OP_LEASE_MS]
        );
        const claimed = result.rows[0] as Row | undefined;
        if (!claimed) {
            const current = await this.db('SELECT * FROM trade_executions WHERE id = $1', [executionId]);
            if (current.rows[0] && current.rows[0].state !== 'signed') {
                return executionFromRow(current.rows[0] as Row);
            }
            throw new ExecutionError('execution_in_progress', 'Execution submission is already in progress', 409, true);
        }

        return this.runClaimed(
            executionId,
            opToken,
            providerQuoteId,
            signedTransaction,
            traceId,
            provider,
            signed
        );
    }

    private async runClaimed(
        executionId: string,
        opToken: string,
        providerQuoteId: string,
        signedTransaction: string,
        traceId: string,
        provider: SwapProvider,
        signed: SolanaTransaction,
        recovery = false
    ): Promise<TradeExecution> {
        const active = await this.startBroadcast(executionId, opToken, traceId);
        const previousStatus = optionalString(active.provider_status);
        const priorPossible = previousStatus?.startsWith('ambiguous') === true
            || (!previousStatus && Number(active.broadcast_count) > 1);
        const retryMs = recovery
            ? Math.min(
                env.JUPITER_RETRY_MAX_MS,
                env.EXECUTION_RECONCILE_MS * 2 ** Math.min(Math.max(Number(active.broadcast_count) - 2, 0), 8)
            )
            : 0;
        const done = metrics.timer('fervor_execution_submit_ms', { provider: provider.name });
        try {
            let result;
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), env.EXECUTION_TIMEOUT_MS);
                timer.unref?.();
                try {
                    result = await abortable(
                        provider.submit({ providerQuoteId, signedTransaction }, { signal: controller.signal }),
                        controller.signal,
                        () => new ExecutionProviderError(
                            'provider_timeout',
                            'Execution provider timed out',
                            true,
                            504,
                            undefined,
                            true,
                            { rawStatus: 'timeout' }
                        )
                    );
                } finally {
                    clearTimeout(timer);
                }
            } catch (error) {
                const providerError = error instanceof ExecutionProviderError
                    ? error
                    : new ExecutionProviderError('provider_unavailable', 'Execution provider is unavailable', true);
                const localSignature = optionalString(active.signature);
                if (!matchesProviderSignature(signed, localSignature, providerError.ack?.signature)) {
                    const mismatch = new ExecutionProviderError(
                        'provider_contract_error',
                        'Execution provider returned a signature for a different transaction',
                        false,
                        502,
                        undefined,
                        true,
                        { rawStatus: providerError.ack?.rawStatus }
                    );
                    await this.markAmbiguous(executionId, opToken, traceId, mismatch, localSignature, retryMs);
                    throw new ExecutionError(
                        'submission_ambiguous',
                        'Provider acknowledgement could not be matched to the signed transaction',
                        502
                    );
                }
                if (providerError.uncertain) {
                    await this.markAmbiguous(
                        executionId,
                        opToken,
                        traceId,
                        providerError,
                        optionalString(active.signature),
                        retryMs
                    );
                    throw new ExecutionError(
                        'submission_ambiguous',
                        'Provider acknowledgement is unknown; retry the same request or await reconciliation',
                        providerError.status,
                        false
                    );
                }
                if (priorPossible) {
                    await this.markAmbiguous(
                        executionId, opToken, traceId, providerError,
                        optionalString(active.signature), retryMs
                    );
                    throw new ExecutionError(
                        'submission_ambiguous',
                        'An earlier provider call may have landed; reconcile before treating this replay as failed',
                        providerError.status,
                        false
                    );
                }
                if (providerError.retryable) {
                    await this.markRetryable(executionId, opToken, traceId, providerError, retryMs);
                    throw new ExecutionError(
                        providerError.code,
                        providerError.message,
                        providerError.status,
                        true
                    );
                }
                result = {
                    provider: provider.name,
                    state: 'failed' as const,
                    errorCode: providerError.code,
                    errorMessage: providerError.message,
                    rawStatus: 'rejected',
                };
            }

            const localSignature = optionalString(active.signature);
            if (!matchesProviderSignature(signed, localSignature, result.signature)) {
                const error = new ExecutionProviderError(
                    'provider_contract_error',
                    'Execution provider returned a different transaction signature',
                    false,
                    502,
                    undefined,
                    true,
                    { rawStatus: result.rawStatus }
                );
                await this.markAmbiguous(executionId, opToken, traceId, error, localSignature, retryMs);
                throw new ExecutionError(
                    'submission_ambiguous',
                    'Provider acknowledgement could not be matched to the signed transaction',
                    502
                );
            }

            for (const [field, value] of [
                ['inputAmount', result.inputAmount],
                ['outputAmount', result.outputAmount],
            ] as const) {
                if (value !== undefined && u64Text(value) === undefined) {
                    const error = new ExecutionProviderError(
                        'provider_contract_error',
                        `Execution provider returned an invalid ${field}`,
                        false,
                        502,
                        undefined,
                        true,
                        { signature: result.signature, rawStatus: result.rawStatus }
                    );
                    await this.markAmbiguous(
                        executionId,
                        opToken,
                        traceId,
                        error,
                        optionalString(active.signature),
                        retryMs
                    );
                    throw new ExecutionError(
                        'submission_ambiguous',
                        'Provider acknowledgement could not be verified; reconcile before retrying',
                        502
                    );
                }
            }

            if (result.state === 'failed' && (priorPossible || localSignature || result.signature)) {
                const error = new ExecutionProviderError(
                    result.errorCode || 'provider_rejected_after_broadcast',
                    result.errorMessage || 'Provider reported failure after a possible broadcast',
                    false,
                    502,
                    undefined,
                    true,
                    { signature: result.signature, rawStatus: result.rawStatus }
                );
                await this.markAmbiguous(executionId, opToken, traceId, error, localSignature, retryMs);
                throw new ExecutionError(
                    'submission_ambiguous',
                    'Provider failure does not disprove the earlier possible on-chain effect',
                    502,
                    false
                );
            }

            const updated = await this.tx(async (db) => {
                const persisted = await db(
                    `UPDATE trade_executions
                     SET state = $2::varchar,
                         signature = COALESCE(signature, $3),
                         provider_input_amount = COALESCE($4, provider_input_amount),
                         provider_output_amount = COALESCE($5, provider_output_amount),
                         error_code = $6,
                         error_message = $7,
                         provider_status = $8,
                         submitted_at = COALESCE(submitted_at, CURRENT_TIMESTAMP),
                         confirmed_at = CASE WHEN $2::varchar IN ('confirmed', 'finalized') THEN CURRENT_TIMESTAMP ELSE confirmed_at END,
                         op_token = NULL,
                         op_lease_until = NULL
                     WHERE id = $1 AND op_token = $9
                     RETURNING *`,
                    [
                        executionId,
                        result.state,
                        result.signature || null,
                        result.inputAmount || null,
                        result.outputAmount || null,
                        result.errorCode || null,
                        result.errorMessage || null,
                        result.rawStatus || null,
                        opToken,
                    ]
                );
                if (!persisted.rows[0]) {
                    throw new ExecutionError('execution_state_conflict', 'Execution lease changed concurrently', 409, true);
                }
                await this.recordEvent(db, executionId, result.state, traceId, {
                    signature: result.signature,
                    providerStatus: result.rawStatus,
                    providerInputAmount: result.inputAmount,
                    providerOutputAmount: result.outputAmount,
                    errorCode: result.errorCode,
                });
                return persisted.rows[0] as Row;
            });
            metrics.increment('fervor_executions_total', { provider: provider.name, state: result.state });
            return executionFromRow(updated);
        } finally {
            done();
        }
    }

    private async startBroadcast(executionId: string, opToken: string, traceId: string): Promise<Row> {
        return this.tx(async (db) => {
            const result = await db(
                `UPDATE trade_executions
                 SET op_lease_until = clock_timestamp() + ($3::text || ' milliseconds')::interval,
                     broadcast_started_at = COALESCE(broadcast_started_at, CURRENT_TIMESTAMP),
                     broadcast_count = broadcast_count + 1
                 WHERE id = $1
                   AND state = 'signed'
                   AND op_token = $2
                   AND op_lease_until > clock_timestamp()
                 RETURNING *`,
                [executionId, opToken, env.EXECUTION_OP_LEASE_MS]
            );
            const active = result.rows[0] as Row | undefined;
            if (!active) {
                throw new ExecutionError(
                    'execution_state_conflict',
                    'Execution lease changed before provider submission',
                    409,
                    true
                );
            }
            await this.recordEvent(db, executionId, 'signed', traceId, {
                action: 'broadcast_started',
                attempt: active.broadcast_count,
            });
            return active;
        });
    }

    private async markRecovery(error: ExecutionTxError, traceId: string): Promise<void> {
        const retryable = error.code === 'key_unavailable';
        const status = retryable ? 'recovery:key_unavailable' : `manual:${error.code}`;
        await this.tx(async (db) => {
            const result = await db(
                `UPDATE trade_executions
                 SET error_code = $3,
                     error_message = $4,
                     provider_status = $5,
                     op_token = NULL,
                     op_lease_until = CASE WHEN $6
                         THEN clock_timestamp() + ($7::text || ' milliseconds')::interval
                         ELSE NULL END
                 WHERE id = $1 AND state = 'signed' AND op_token = $2
                 RETURNING id`,
                [error.executionId, error.opToken, error.code, error.message, status,
                    retryable, env.EXECUTION_RECONCILE_MS]
            );
            if (!result.rows[0]) return;
            await this.recordEvent(db, error.executionId, 'signed', traceId, {
                action: retryable ? 'recovery_retry' : 'recovery_manual',
                errorCode: error.code,
                providerStatus: status,
            });
        });
        metrics.increment('fervor_execution_recovery_errors', { code: error.code });
    }

    private async markAmbiguous(
        executionId: string,
        opToken: string,
        traceId: string,
        error: ExecutionProviderError,
        localSignature?: string,
        retryMs = 0
    ): Promise<void> {
        const signature = localSignature || error.ack?.signature;
        const providerStatus = error.ack?.rawStatus
            ? `ambiguous:${error.ack.rawStatus}`.slice(0, 80)
            : 'ambiguous';
        await this.tx(async (db) => {
            const updated = await db(
                `UPDATE trade_executions
                 SET state = CASE WHEN $4::varchar IS NOT NULL THEN 'submitted' ELSE state END,
                     signature = COALESCE(signature, $4),
                     error_code = $2,
                     error_message = $3,
                     provider_status = $5,
                     submitted_at = CASE WHEN $4::varchar IS NOT NULL
                                         THEN COALESCE(submitted_at, CURRENT_TIMESTAMP)
                                         ELSE submitted_at END,
                     op_token = NULL,
                     op_lease_until = CASE WHEN $4::varchar IS NULL AND $7 > 0
                         THEN clock_timestamp() + ($7::text || ' milliseconds')::interval
                         ELSE NULL END
                 WHERE id = $1 AND state = 'signed' AND op_token = $6
                 RETURNING id, state`,
                [executionId, error.code, error.message.slice(0, 500), signature || null,
                    providerStatus, opToken, retryMs]
            );
            if (!updated.rows[0]) return;
            await this.recordEvent(db, executionId, String(updated.rows[0].state), traceId, {
                action: 'submission_ambiguous',
                errorCode: error.code,
                signature,
                providerStatus: error.ack?.rawStatus,
            });
        });
        metrics.increment('fervor_execution_ambiguous_total', { code: error.code });
    }

    private async markRetryable(
        executionId: string,
        opToken: string,
        traceId: string,
        error: ExecutionProviderError,
        retryMs = 0
    ): Promise<void> {
        await this.tx(async (db) => {
            const updated = await db(
                `UPDATE trade_executions
                 SET error_code = $2,
                     error_message = $3,
                     provider_status = $4,
                     op_token = NULL,
                     op_lease_until = CASE WHEN $6 > 0
                         THEN clock_timestamp() + ($6::text || ' milliseconds')::interval
                         ELSE NULL END
                 WHERE id = $1 AND state = 'signed' AND op_token = $5
                 RETURNING id`,
                [executionId, error.code, error.message.slice(0, 500),
                    `retryable:${error.code}`.slice(0, 80), opToken, retryMs]
            );
            if (!updated.rows[0]) return;
            await this.recordEvent(db, executionId, 'signed', traceId, {
                action: 'submission_retryable',
                errorCode: error.code,
            });
        });
        metrics.increment('fervor_execution_retryable_total', { code: error.code });
    }

    private async recordEvent(
        db: DbQuery,
        executionId: string,
        state: string,
        traceId: string,
        metadata: Row
    ): Promise<void> {
        const event = {
            id: crypto.randomUUID(),
            type: 'execution.lifecycle',
            version: 1,
            key: executionId,
            source: 'execution-service',
            traceId,
            occurredAt: new Date().toISOString(),
            receivedAt: new Date().toISOString(),
            payload: { executionId, state, ...metadata },
        };
        await db(
            `INSERT INTO execution_events (execution_id, state, trace_id, metadata)
             VALUES ($1, $2, $3, $4::jsonb)`,
            [executionId, state, traceId, JSON.stringify(metadata)]
        );
        await eventOutbox.enqueue(db, STREAMS.executionLifecycle, `execution:${executionId}:${event.id}`, event);
    }

    private async prepareBlob(
        userId: string,
        quoteId: string,
        idempotencyKey: string,
        signedDigest: string,
        executionId: string,
        provider: SwapProvider,
        signed: SolanaTransaction
    ): Promise<SealedExecutionTx | undefined> {
        if (env.TRADING_MODE !== 'live') return undefined;

        const existing = await this.db(
            `SELECT quote_id, signed_tx_digest
               FROM trade_executions
              WHERE user_id = $1 AND idempotency_key = $2`,
            [userId, idempotencyKey]
        );
        if (existing.rows[0]) {
            if (String(existing.rows[0].quote_id) !== quoteId
                || String(existing.rows[0].signed_tx_digest) !== signedDigest) {
                throw new ExecutionError(
                    'idempotency_conflict',
                    'Idempotency key was used for another submission',
                    409
                );
            }
            return undefined;
        }

        const result = await this.db(
            `SELECT * FROM trade_quotes WHERE id = $1 AND user_id = $2`,
            [quoteId, userId]
        );
        const quote = result.rows[0] as Row | undefined;
        if (!quote) throw new ExecutionError('quote_not_found', 'Quote was not found', 404);
        if (String(quote.provider) !== provider.name) {
            throw new ExecutionError('provider_mismatch', 'Quote provider is not active', 409, true);
        }
        if (String(quote.state) !== 'quoted') {
            throw new ExecutionError('quote_consumed', 'Quote has already been submitted', 409);
        }
        if (new Date(quote.expires_at as string | Date).getTime() <= Date.now()) {
            throw new ExecutionError('quote_expired', 'Quote expired. Request a fresh quote.', 409, true);
        }
        try {
            validateSignedContract(quote, signed);
        } catch (error) {
            throw new ExecutionError(
                'transaction_mismatch',
                error instanceof Error ? error.message : 'Signed transaction failed intent validation',
                400
            );
        }
        return this.txStore.seal({
            executionId,
            quoteId,
            userId,
            provider: provider.name,
            providerQuoteId: String(quote.provider_quote_id),
            wallet: String(quote.wallet_address),
            feePayer: String(quote.fee_payer),
            transaction: signed,
        });
    }

    private requireProvider(): SwapProvider {
        if (!this.provider) throw new ExecutionError('trading_disabled', 'Trading is disabled', 503);
        return this.provider;
    }
}
