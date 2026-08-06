import crypto from 'crypto';
import { DbQuery, egressDb } from '../../config/database';
import { env, EXECUTION_LEASE_MARGIN_MS } from '../../config/env';
import { ExecutionState, safeSlot, signatureSchema } from '../../types';
import { eventOutbox } from '../eventOutbox';
import { metrics } from '../metrics';
import { STREAMS } from '../redisStreamService';
import {
    ChainSettlement,
    SettlementCommitment,
    decodeSettlement,
} from './executionSettlement';

type ActiveState = Extract<ExecutionState, 'signed' | 'submitted' | 'processed' | 'confirmed' | 'finalized'>;
type ChainState = Extract<ExecutionState, 'processed' | 'confirmed' | 'finalized' | 'failed'>;
type ProgressState = Extract<ChainState, 'processed' | 'failed'>;
type TxFn = <T>(work: (db: DbQuery) => Promise<T>) => Promise<T>;

interface ExecutionRow {
    id: string;
    signature: string;
    state: ActiveState;
    wallet_address: string;
    fee_payer: string;
    input_mint: string;
    output_mint: string;
    expected_input_amount: string;
    min_output_amount: string;
    provider_input_amount: string | null;
    provider_output_amount: string | null;
    settlement_commitment: SettlementCommitment | null;
}

export interface SignatureStatus {
    slot: unknown;
    err: unknown | null;
    confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null;
}

interface StatusResponse {
    error?: { code?: number; message?: string };
    result?: { value?: Array<SignatureStatus | null> };
}

interface TxResponse {
    error?: { code?: number; message?: string };
    result?: unknown | null;
}

interface ReconcileTask {
    row: ExecutionRow;
    run: () => Promise<boolean>;
}

export interface ReconcileResult {
    checked: number;
    updated: number;
}

class RpcContractError extends Error {}
class LeaseLostError extends Error {}

const MAX_TX_RESPONSE_BYTES = 4_000_000;
const MAX_STATUS_RESPONSE_BYTES = 1_000_000;

const readBounded = async (response: Response, limit: number): Promise<Buffer> => {
    const contentLength = response.headers.get('content-length');
    if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > limit) {
        throw new RpcContractError('Solana RPC response exceeds the configured limit');
    }
    if (!response.body) return Buffer.alloc(0);

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > limit) {
            await reader.cancel();
            throw new RpcContractError('Solana RPC response exceeds the configured limit');
        }
        chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, length);
};

export const resolveChainState = (status: SignatureStatus | null): ChainState | null => {
    if (!status) return null;
    if (status.err !== null && status.err !== undefined) return 'failed';
    if (status.confirmationStatus === 'processed') return 'processed';
    if (status.confirmationStatus === 'confirmed') return 'confirmed';
    if (status.confirmationStatus === 'finalized') return 'finalized';
    return null;
};

const errorSummary = (error: unknown): string | null => {
    if (error === null || error === undefined) return null;
    try {
        return JSON.stringify(error).slice(0, 500);
    } catch {
        return 'Transaction failed on-chain';
    }
};

export class ExecutionReconciler {
    constructor(
        private readonly rpcUrl = env.SOLANA_RPC_URL,
        private readonly db: DbQuery = egressDb.query,
        private readonly tx: TxFn = egressDb.transaction,
        private readonly fetcher: typeof fetch = fetch
    ) {}

    async runBatch(): Promise<ReconcileResult> {
        if (!this.rpcUrl) return { checked: 0, updated: 0 };

        const token = crypto.randomUUID();
        const rows = await this.claim(token);
        if (!rows.length) return { checked: 0, updated: 0 };

        let updated = 0;
        try {
            const validRows: ExecutionRow[] = [];
            for (const row of rows) {
                const signature = signatureSchema.safeParse(row.signature);
                if (!signature.success) {
                    await this.quarantine(row, token, 'Stored execution has an invalid transaction signature');
                    continue;
                }
                validRows.push({ ...row, signature: signature.data });
            }

            const statuses = validRows.length
                ? await this.getStatuses(validRows.map((row) => row.signature))
                : [];
            const release: string[] = [];
            const tasks: ReconcileTask[] = [];
            for (let index = 0; index < validRows.length; index += 1) {
                const row = validRows[index];
                const status = statuses[index] || null;
                const slot = status ? safeSlot(status.slot) : undefined;
                if (status && slot === undefined) {
                    await this.quarantine(row, token, 'Solana RPC returned an unsafe signature status slot');
                    continue;
                }
                const valid = status ? { ...status, slot: slot! } : null;
                const nextState = resolveChainState(valid);
                if (!valid || !nextState) {
                    release.push(row.id);
                } else if (nextState === 'confirmed' || nextState === 'finalized') {
                    if (row.settlement_commitment === nextState) release.push(row.id);
                    else tasks.push({
                        row,
                        run: () => this.verify(row, token, nextState, valid),
                    });
                } else {
                    tasks.push({
                        row,
                        run: () => this.transition(row, token, nextState, valid),
                    });
                }
            }

            await this.release(release, token);
            const width = Math.min(env.EXECUTION_RECONCILE_BATCH, env.EGRESS_DB_POOL_MAX);
            for (let offset = 0; offset < tasks.length; offset += width) {
                const chunk = tasks.slice(offset, offset + width);
                let active = chunk;
                if (offset > 0) {
                    const renewed = await this.renew(chunk.map((task) => task.row.id), token);
                    active = chunk.filter((task) => renewed.has(task.row.id));
                }
                const results = await Promise.all(active.map(async (task) => ({
                    id: task.row.id,
                    changed: await task.run(),
                })));
                updated += results.filter((item) => item.changed).length;
                await this.release(
                    results.filter((item) => !item.changed).map((item) => item.id),
                    token
                );
            }
        } catch (error) {
            await this.release(rows.map((row) => row.id), token);
            throw error;
        }

        metrics.increment('fervor_execution_reconcile_checked', undefined, rows.length);
        metrics.increment('fervor_execution_reconcile_updated', undefined, updated);
        return { checked: rows.length, updated };
    }

    private async claim(token: string): Promise<ExecutionRow[]> {
        const leaseMs = Math.max(
            env.EXECUTION_RECONCILE_LEASE_MS,
            2 * env.EXECUTION_TIMEOUT_MS + EXECUTION_LEASE_MARGIN_MS
        );
        return this.tx(async (db) => {
            const result = await db<ExecutionRow>(
                `WITH due AS (
                    SELECT execution.id
                    FROM trade_executions execution
                    WHERE execution.signature IS NOT NULL
                      AND LEFT(execution.signature, 8) <> 'fixture_'
                      AND execution.settlement_commitment IS DISTINCT FROM 'finalized'
                      AND (
                        execution.state IN ('submitted', 'processed', 'confirmed')
                        OR (execution.state = 'signed' AND execution.broadcast_started_at IS NOT NULL)
                      )
                      AND (execution.op_lease_until IS NULL OR execution.op_lease_until <= NOW())
                      AND ((hashtextextended(execution.id::text, 0) & 9223372036854775807) % $2) = $3
                    ORDER BY execution.updated_at, execution.id
                    FOR UPDATE SKIP LOCKED
                    LIMIT $1
                 )
                 UPDATE trade_executions execution
                 SET op_token = $4,
                     op_lease_until = clock_timestamp() + ($5::text || ' milliseconds')::interval
                 FROM due, trade_quotes quote
                 WHERE execution.id = due.id
                   AND quote.id = execution.quote_id
                 RETURNING execution.id, execution.signature, execution.state,
                           execution.wallet_address, execution.input_mint, execution.output_mint,
                           execution.expected_input_amount, quote.min_output_amount,
                           quote.fee_payer,
                           execution.provider_input_amount, execution.provider_output_amount,
                           execution.settlement_commitment`,
                [env.EXECUTION_RECONCILE_BATCH, env.EXECUTION_SHARD_COUNT,
                    env.EXECUTION_SHARD_ID, token, leaseMs]
            );
            return result.rows;
        });
    }

    private async renew(ids: string[], token: string): Promise<Set<string>> {
        if (!ids.length) return new Set();
        const leaseMs = Math.max(
            env.EXECUTION_RECONCILE_LEASE_MS,
            2 * env.EXECUTION_TIMEOUT_MS + EXECUTION_LEASE_MARGIN_MS
        );
        const result = await this.db<{ id: string }>(
            `UPDATE trade_executions
             SET op_lease_until = clock_timestamp() + ($3::text || ' milliseconds')::interval
             WHERE id = ANY($1::uuid[])
               AND op_token = $2
               AND op_lease_until > clock_timestamp()
             RETURNING id`,
            [ids, token, leaseMs]
        );
        return new Set(result.rows.map((row) => row.id));
    }

    private async release(ids: string[], token: string): Promise<void> {
        if (!ids.length) return;
        await this.db(
            `UPDATE trade_executions
             SET op_token = NULL, op_lease_until = NULL
             WHERE id = ANY($1::uuid[])
               AND op_token = $2
               AND op_lease_until > clock_timestamp()`,
            [ids, token]
        );
    }

    private async rpc(body: object): Promise<Response> {
        const response = await this.fetcher(this.rpcUrl!, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(env.EXECUTION_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`Solana RPC returned HTTP ${response.status}`);
        return response;
    }

    private async getStatuses(signatures: string[]): Promise<Array<SignatureStatus | null>> {
        const response = await this.rpc({
            jsonrpc: '2.0',
            id: crypto.randomUUID(),
            method: 'getSignatureStatuses',
            params: [signatures, { searchTransactionHistory: true }],
        });
        let body: StatusResponse;
        try {
            body = JSON.parse((await readBounded(response, MAX_STATUS_RESPONSE_BYTES)).toString('utf8')) as StatusResponse;
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                throw new Error('invalid response');
            }
        } catch (error) {
            if (error instanceof RpcContractError) throw error;
            throw new Error('Solana RPC returned malformed signature status JSON');
        }
        if (body.error) throw new Error(`Solana RPC error ${body.error.code || 'unknown'}: ${body.error.message || 'unknown'}`);
        const statuses = body.result?.value;
        if (!Array.isArray(statuses) || statuses.length !== signatures.length) {
            throw new Error('Solana RPC returned an invalid signature status response');
        }
        return statuses;
    }

    private async getTransaction(
        signature: string,
        commitment: SettlementCommitment
    ): Promise<{ value: unknown; payloadHash: string } | null> {
        const response = await this.rpc({
            jsonrpc: '2.0',
            id: crypto.randomUUID(),
            method: 'getTransaction',
            params: [signature, {
                commitment,
                encoding: 'jsonParsed',
                maxSupportedTransactionVersion: 0,
            }],
        });
        const raw = await readBounded(response, MAX_TX_RESPONSE_BYTES);
        let body: TxResponse;
        try {
            body = JSON.parse(raw.toString('utf8')) as TxResponse;
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                throw new Error('invalid response');
            }
        } catch {
            throw new RpcContractError('Solana RPC returned malformed transaction JSON');
        }
        if (body.error) throw new Error(`Solana RPC error ${body.error.code || 'unknown'}: ${body.error.message || 'unknown'}`);
        if (!Object.prototype.hasOwnProperty.call(body, 'result')) {
            throw new RpcContractError('Solana RPC omitted the transaction result');
        }
        if (body.result === null) return null;
        return {
            value: body.result,
            payloadHash: crypto.createHash('sha256').update(raw).digest('hex'),
        };
    }

    private async quarantine(row: ExecutionRow, token: string, message: string): Promise<void> {
        await this.db(
            `UPDATE trade_executions
             SET error_code = 'rpc_contract_error',
                 error_message = $3,
                 provider_status = 'rpc_malformed',
                 op_token = NULL,
                 op_lease_until = clock_timestamp() + ($4::text || ' milliseconds')::interval
             WHERE id = $1
               AND op_token = $2
               AND op_lease_until > clock_timestamp()`,
            [row.id, token, message.slice(0, 500), Math.max(env.EXECUTION_RECONCILE_LEASE_MS, 5_000)]
        );
        metrics.increment('fervor_execution_reconcile_malformed_total');
    }

    private async verify(
        row: ExecutionRow,
        token: string,
        commitment: SettlementCommitment,
        status: SignatureStatus & { slot: number }
    ): Promise<boolean> {
        let transactionResult: { value: unknown; payloadHash: string } | null;
        try {
            transactionResult = await this.getTransaction(row.signature, commitment);
        } catch (error) {
            if (!(error instanceof RpcContractError)) throw error;
            await this.quarantine(row, token, error.message);
            return false;
        }
        if (!transactionResult) {
            return false;
        }

        let settlement: ChainSettlement;
        try {
            settlement = decodeSettlement({
                signature: row.signature,
                wallet: row.wallet_address,
                feePayer: row.fee_payer,
                inputMint: row.input_mint,
                outputMint: row.output_mint,
                expectedInput: String(row.expected_input_amount),
                minOutput: String(row.min_output_amount),
                providerInput: row.provider_input_amount === null
                    ? undefined
                    : String(row.provider_input_amount),
                providerOutput: row.provider_output_amount === null
                    ? undefined
                    : String(row.provider_output_amount),
                commitment,
            }, transactionResult.value, transactionResult.payloadHash);
            if (settlement.slot !== status.slot) {
                throw new Error('Solana RPC transaction slot differs from its signature status');
            }
        } catch (error) {
            await this.quarantine(
                row,
                token,
                error instanceof Error ? error.message : 'Solana RPC returned invalid settlement evidence'
            );
            return false;
        }
        return this.settle(row, token, settlement);
    }

    private async settle(
        row: ExecutionRow,
        token: string,
        settlement: ChainSettlement
    ): Promise<boolean> {
        const traceId = crypto.randomUUID();
        const metadata = {
            signature: row.signature,
            slot: settlement.slot,
            commitment: settlement.commitment,
            settlementStatus: settlement.status,
            inputAmount: settlement.inputAmount || null,
            outputAmount: settlement.outputAmount || null,
            providerInputAmount: row.provider_input_amount,
            providerOutputAmount: row.provider_output_amount,
            feeLamports: settlement.feeLamports,
            payloadHash: settlement.payloadHash,
            reason: settlement.reason || null,
        };
        try {
            return await this.tx(async (db) => {
                await db(
                    `INSERT INTO execution_settlements
                     (execution_id, signature, commitment, slot, status, input_amount, output_amount,
                      fee_lamports, provider_input_amount, provider_output_amount, payload_hash, reason)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                    [
                        row.id,
                        row.signature,
                        settlement.commitment,
                        settlement.slot,
                        settlement.status,
                        settlement.inputAmount || null,
                        settlement.outputAmount || null,
                        settlement.feeLamports,
                        row.provider_input_amount,
                        row.provider_output_amount,
                        settlement.payloadHash,
                        settlement.reason || null,
                    ]
                );
                const result = await db<{ id: string; state: ActiveState }>(
                    `UPDATE trade_executions
                     SET state = CASE WHEN $2 = 'unsupported' THEN state ELSE $3::varchar END,
                         actual_input_amount = $4,
                         actual_output_amount = $5,
                         settlement_status = $2,
                         settlement_slot = $6,
                         settlement_commitment = $7,
                         settlement_fee_lamports = $8,
                         provider_status = $9,
                         error_code = CASE $2
                             WHEN 'mismatch' THEN 'settlement_mismatch'
                             WHEN 'unsupported' THEN 'settlement_unsupported'
                             ELSE NULL END,
                         error_message = $10,
                         submitted_at = COALESCE(submitted_at, CURRENT_TIMESTAMP),
                         confirmed_at = CASE WHEN $2 <> 'unsupported'
                                             THEN COALESCE(confirmed_at, CURRENT_TIMESTAMP)
                                             ELSE confirmed_at END,
                         op_token = NULL,
                         op_lease_until = NULL
                     WHERE id = $1
                       AND op_token = $11
                       AND op_lease_until > clock_timestamp()
                       AND signature = $12
                       AND (
                         state IN ('submitted', 'processed', 'confirmed')
                         OR (state = 'signed' AND broadcast_started_at IS NOT NULL)
                       )
                     RETURNING id, state`,
                    [
                        row.id,
                        settlement.status,
                        settlement.commitment,
                        settlement.inputAmount || null,
                        settlement.outputAmount || null,
                        settlement.slot,
                        settlement.commitment,
                        settlement.feeLamports,
                        `chain:${settlement.commitment}:${settlement.status}@${settlement.slot}`,
                        settlement.reason || null,
                        token,
                        row.signature,
                    ]
                );
                const persisted = result.rows[0];
                if (!persisted) throw new LeaseLostError('Execution settlement lease expired');
                await db(
                    `INSERT INTO execution_events (execution_id, state, trace_id, metadata)
                     VALUES ($1, $2, $3, $4::jsonb)`,
                    [row.id, persisted.state, traceId, JSON.stringify(metadata)]
                );
                const occurredAt = new Date().toISOString();
                const event = {
                    id: crypto.randomUUID(),
                    type: 'execution.lifecycle',
                    version: 1,
                    key: row.id,
                    source: 'execution-reconciler',
                    traceId,
                    occurredAt,
                    receivedAt: occurredAt,
                    payload: { executionId: row.id, state: persisted.state, ...metadata },
                };
                await eventOutbox.enqueue(
                    db,
                    STREAMS.executionLifecycle,
                    `execution:${row.id}:${event.id}`,
                    event
                );
                return true;
            });
        } catch (error) {
            if (error instanceof LeaseLostError) return false;
            throw error;
        }
    }

    private async transition(
        row: ExecutionRow,
        token: string,
        state: ProgressState,
        status: SignatureStatus & { slot: number }
    ): Promise<boolean> {
        const traceId = crypto.randomUUID();
        const metadata = {
            signature: row.signature,
            slot: status.slot,
            confirmationStatus: status.confirmationStatus || null,
            chainError: status.err || null,
        };
        return this.tx(async (db) => {
            const result = await db(
                `UPDATE trade_executions
                 SET state = $2,
                     provider_status = $3,
                     error_code = CASE WHEN $2 = 'failed' THEN 'onchain_error' ELSE NULL END,
                     error_message = CASE WHEN $2 = 'failed' THEN $4 ELSE NULL END,
                     submitted_at = COALESCE(submitted_at, CURRENT_TIMESTAMP),
                     op_token = NULL,
                     op_lease_until = NULL
                 WHERE id = $1
                   AND op_token = $5
                   AND op_lease_until > clock_timestamp()
                   AND settlement_status = 'pending'
                   AND (state IN ('submitted', 'processed', 'confirmed')
                        OR (state = 'signed' AND broadcast_started_at IS NOT NULL))
                   AND (
                     $2 = 'failed'
                     OR CASE state WHEN 'signed' THEN 0 WHEN 'submitted' THEN 1 WHEN 'processed' THEN 2 WHEN 'confirmed' THEN 3 ELSE 0 END
                        < CASE $2 WHEN 'processed' THEN 2 ELSE 0 END
                   )
                 RETURNING id`,
                [
                    row.id,
                    state,
                    `rpc:${status.confirmationStatus || 'failed'}@${status.slot}`,
                    errorSummary(status.err),
                    token,
                ]
            );
            if (!result.rows[0]) return false;
            await db(
                `INSERT INTO execution_events (execution_id, state, trace_id, metadata)
                 VALUES ($1, $2, $3, $4::jsonb)`,
                [row.id, state, traceId, JSON.stringify(metadata)]
            );
            const occurredAt = new Date().toISOString();
            const event = {
                id: crypto.randomUUID(),
                type: 'execution.lifecycle',
                version: 1,
                key: row.id,
                source: 'execution-reconciler',
                traceId,
                occurredAt,
                receivedAt: occurredAt,
                payload: { executionId: row.id, state, ...metadata },
            };
            await eventOutbox.enqueue(
                db,
                STREAMS.executionLifecycle,
                `execution:${row.id}:${event.id}`,
                event
            );
            return true;
        });
    }
}
