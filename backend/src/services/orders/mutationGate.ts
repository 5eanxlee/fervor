import type { PoolClient, QueryResultRow } from 'pg';
import { egressDb, type Database, type DbStats } from '../../config/database';
import { env } from '../../config/env';
import type { ActionAttempt, ActionFence, OrderAction } from '../../types';
import { metrics } from '../metrics';
import { mapAction, mapAttempt, optional, type ActionRow } from './orderActionModel';
import { bounded, uint, uuid } from './orderValidation';

export type MutationGateCode =
    | 'invalid_input'
    | 'not_found'
    | 'fence_closed'
    | 'state_conflict'
    | 'already_forwarded'
    | 'transport_timeout'
    | 'audit_failed'
    | 'database_error';

export class MutationGateError extends Error {
    readonly cause?: unknown;

    constructor(
        readonly code: MutationGateCode,
        message: string,
        readonly retryable = false,
        readonly uncertain = false,
        cause?: unknown
    ) {
        super(message);
        this.name = 'MutationGateError';
        this.cause = cause;
    }
}

export interface MutationInput {
    actionId: string;
    attemptId: string;
    fence: ActionFence;
}

export interface MutationContext {
    action: OrderAction;
    attempt: ActionAttempt;
    signal: AbortSignal;
}

export type MutationForward<T> = (context: MutationContext) => Promise<T>;

interface GateDb extends Pick<Database, 'getClient'> {
    stats?: () => DbStats;
}

interface GateOptions {
    acquireMs?: number;
}

type GatePhase =
    | 'acquired'
    | 'transaction'
    | 'committing'
    | 'reserved'
    | 'started'
    | 'detached'
    | 'completed';

interface GateState {
    phase: GatePhase;
    discard: boolean;
    detached: boolean;
    scope?: string;
    fault?: unknown;
    faultWait: Promise<unknown>;
    fail: (error: unknown) => void;
    controller?: AbortController;
    onError?: (error: Error) => void;
}

interface EgressRow extends QueryResultRow {
    attempt_id: string;
    action_id: string;
    lease_owner: string;
    lease_gen: string;
    write_scope: string;
    write_epoch: string;
    provider: string;
    endpoint: string;
    method: string;
    req_hash: string;
    body_hash: string | null;
    desired_hash: string;
    blob_action_id: string | null;
    forwarded_at: Date;
    started_at: Date | null;
    completed_at: Date | null;
    phase_ver: number | null;
    end_kind: string | null;
    writer_ver: number | null;
}

interface StartRow extends QueryResultRow {
    started_at: Date;
    remaining_ms: string;
}

interface Permit {
    action: OrderAction;
    attempt: ActionAttempt;
}

type Outcome<T> =
    | { kind: 'return'; value: T }
    | { kind: 'throw'; error: unknown };

type Race<T> = Outcome<T> | { kind: 'timeout' } | { kind: 'fault'; error: unknown };

const phaseRank: Record<GatePhase, number> = {
    acquired: 0,
    transaction: 1,
    committing: 2,
    reserved: 3,
    started: 4,
    detached: 5,
    completed: 6,
};

const mayHaveReserved = (state: GateState): boolean => phaseRank[state.phase] >= 2;

const pgCode = (error: unknown): string | undefined => (
    typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined
);

const sameFence = (action: OrderAction, fence: ActionFence): boolean => (
    action.lease?.owner === fence.owner
    && action.lease.gen === fence.gen
    && action.lease.scope === fence.scope
    && action.lease.epoch === fence.epoch
);

const newState = (): GateState => {
    let fail!: (error: unknown) => void;
    const faultWait = new Promise<unknown>((resolve) => { fail = resolve; });
    return {
        phase: 'acquired',
        discard: false,
        detached: false,
        faultWait,
        fail,
    };
};

export class MutationGate<T = unknown> {
    private readonly acquireMs: number;

    constructor(
        private readonly forward: MutationForward<T>,
        private readonly database: GateDb = egressDb,
        options: GateOptions = {}
    ) {
        this.acquireMs = options.acquireMs ?? env.EGRESS_ACQUIRE_MS;
    }

    async run(input: MutationInput): Promise<T> {
        this.validate(input);
        const client = await this.acquire();
        const state = newState();
        state.onError = (error: Error) => {
            if (state.fault !== undefined) return;
            state.fault = error;
            state.discard = true;
            state.controller?.abort(error);
            state.fail(error);
            metrics.increment('fervor_mutation_gate_client_errors');
        };
        client.on('error', state.onError);

        try {
            const permit = await this.reserve(client, input, state);
            return await this.invoke(client, permit, state);
        } finally {
            if (!state.detached) await this.release(client, state);
        }
    }

    private async acquire(): Promise<PoolClient> {
        const started = process.hrtime.bigint();
        const pending = this.database.getClient();
        const expired = Symbol('expired');
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<typeof expired>((resolve) => {
            timer = setTimeout(() => resolve(expired), this.acquireMs);
            timer.unref?.();
        });

        let client: PoolClient | typeof expired;
        try {
            client = await Promise.race([pending, timeout]);
        } catch (error) {
            this.samplePool();
            throw new MutationGateError(
                'database_error', 'Provider egress database is unavailable', true, false, error
            );
        } finally {
            if (timer) clearTimeout(timer);
            const duration = Number(process.hrtime.bigint() - started) / 1_000_000;
            metrics.observe('fervor_mutation_gate_acquire_ms', duration);
        }

        if (client === expired) {
            void pending.then(
                (late) => late.release(),
                () => undefined
            );
            metrics.increment('fervor_mutation_gate_admission_timeouts');
            this.samplePool();
            throw new MutationGateError(
                'database_error', 'Provider egress capacity is exhausted', true
            );
        }
        this.samplePool();
        return client;
    }

    private samplePool(): void {
        const pool = this.database.stats?.();
        if (!pool) return;
        metrics.gauge('fervor_mutation_gate_pool_active', pool.total - pool.idle);
        metrics.gauge('fervor_mutation_gate_pool_waiting', pool.waiting);
        metrics.gauge('fervor_mutation_gate_pool_limit', pool.max);
    }

    private async reserve(
        client: PoolClient,
        input: MutationInput,
        state: GateState
    ): Promise<Permit> {
        try {
            await client.query('BEGIN');
            state.phase = 'transaction';
            await client.query(`
                SELECT set_config('lock_timeout', '5s', true),
                       set_config('statement_timeout', '15s', true),
                       set_config('idle_in_transaction_session_timeout', '15s', true)
            `);

            const identity = await client.query<ActionRow>(
                'SELECT order_id FROM order_actions WHERE id = $1', [input.actionId]
            );
            if (!identity.rows[0]) {
                throw new MutationGateError('not_found', 'Action was not found');
            }
            await client.query(
                'SELECT id FROM order_intents WHERE id = $1 FOR SHARE',
                [identity.rows[0].order_id]
            );
            const actionResult = await client.query<ActionRow>(
                'SELECT * FROM order_actions WHERE id = $1 FOR SHARE', [input.actionId]
            );
            const attemptResult = await client.query<ActionRow>(
                'SELECT * FROM action_attempts WHERE id = $1 FOR SHARE', [input.attemptId]
            );
            if (!attemptResult.rows[0]) {
                throw new MutationGateError('not_found', 'Attempt was not found');
            }
            const action = mapAction(actionResult.rows[0]);
            const attempt = mapAttempt(attemptResult.rows[0]);
            if (attempt.actionId !== action.id) {
                throw new MutationGateError(
                    'state_conflict', 'Attempt does not belong to the requested action'
                );
            }

            const existing = await client.query<EgressRow>(
                'SELECT * FROM action_egress WHERE attempt_id = $1 FOR SHARE',
                [attempt.id]
            );
            if (existing.rows[0]) {
                this.assertReservation(existing.rows[0], action, attempt, input.fence);
                throw new MutationGateError(
                    'already_forwarded',
                    'Attempt already crossed the durable egress reservation boundary',
                    false,
                    true
                );
            }

            this.assertActive(action, attempt, input.fence);
            await client.query(
                'SELECT pg_advisory_lock_shared(hashtextextended($1, 1937006964))',
                [attempt.writeScope]
            );
            state.scope = attempt.writeScope;

            const inserted = await client.query(`
                INSERT INTO action_egress (
                    attempt_id, action_id, lease_owner, lease_gen, write_scope,
                    write_epoch, provider, endpoint, method, req_hash, body_hash,
                    desired_hash, blob_action_id, writer_ver
                )
                SELECT attempt.id, action.id, action.lease_owner, attempt.lease_gen,
                       attempt.write_scope, attempt.write_epoch, attempt.provider,
                       attempt.endpoint, attempt.method, attempt.req_hash,
                       attempt.body_hash, attempt.desired_hash, attempt.blob_action_id, 2
                  FROM order_actions action
                  JOIN action_attempts attempt ON attempt.action_id = action.id
                 WHERE action.id = $1
                   AND attempt.id = $2
                   AND action.lease_owner = $3
                   AND action.lease_gen = $4
                   AND action.write_scope = $5
                   AND action.write_epoch = $6
                ON CONFLICT DO NOTHING
                RETURNING attempt_id
            `, [input.actionId, input.attemptId, input.fence.owner, input.fence.gen,
                input.fence.scope, input.fence.epoch]);
            if (!inserted.rows[0]) {
                const raced = await client.query<EgressRow>(
                    'SELECT * FROM action_egress WHERE attempt_id = $1 FOR SHARE',
                    [attempt.id]
                );
                if (!raced.rows[0]) {
                    throw new MutationGateError(
                        'fence_closed', 'Action fence closed before egress reservation', true
                    );
                }
                this.assertReservation(raced.rows[0], action, attempt, input.fence);
                throw new MutationGateError(
                    'already_forwarded',
                    'Attempt already crossed the durable egress reservation boundary',
                    false,
                    true
                );
            }

            if (state.fault !== undefined) throw state.fault;
            state.phase = 'committing';
            await client.query('COMMIT');
            state.phase = 'reserved';
            if (state.fault !== undefined) {
                throw new MutationGateError(
                    'audit_failed', 'Egress reservation committed but its session lock was lost',
                    false, true, state.fault
                );
            }
            metrics.increment('fervor_mutation_gate_reservations', { provider: attempt.provider });
            return { action, attempt };
        } catch (error) {
            if (state.phase === 'committing') {
                state.discard = true;
                throw new MutationGateError(
                    'audit_failed',
                    'Egress reservation commit outcome is unknown',
                    false,
                    true,
                    error
                );
            }
            if (phaseRank[state.phase] >= phaseRank.reserved) {
                if (error instanceof MutationGateError) throw error;
                throw new MutationGateError(
                    'audit_failed', 'Committed egress reservation lost its pinned session',
                    false, true, error
                );
            }
            if (state.phase === 'transaction') {
                try {
                    await client.query('ROLLBACK');
                } catch {
                    state.discard = true;
                }
                state.phase = 'acquired';
            }
            throw this.mapReserveError(error);
        }
    }

    private async invoke(
        client: PoolClient,
        permit: Permit,
        state: GateState
    ): Promise<T> {
        let remaining: number;
        const startedAt = process.hrtime.bigint();
        try {
            const started = await client.query<StartRow>(`
                UPDATE action_egress egress
                   SET started_at = clock_timestamp()
                  FROM action_attempts attempt
                 WHERE egress.attempt_id = $1
                   AND attempt.id = egress.attempt_id
                   AND egress.started_at IS NULL
                   AND egress.completed_at IS NULL
                RETURNING egress.started_at,
                          greatest(0, floor(extract(epoch FROM (
                              attempt.deadline_at - clock_timestamp()
                          )) * 1000))::BIGINT AS remaining_ms
            `, [permit.attempt.id]);
            if (!started.rows[0]) throw new Error('Egress transport start fact was not writable');
            const elapsed = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
            remaining = Math.max(0, Number(started.rows[0].remaining_ms) - Math.ceil(elapsed));
            if (!Number.isSafeInteger(remaining)) {
                throw new Error('Egress transport returned an invalid deadline budget');
            }
            state.phase = 'started';
        } catch (error) {
            if (pgCode(error) === '40001') {
                await this.end(client, permit, 'deadline_before_start');
                state.phase = 'completed';
                throw new MutationGateError(
                    'transport_timeout', 'Attempt deadline elapsed before transport entry',
                    false, false, error
                );
            }
            throw new MutationGateError(
                'audit_failed', 'Provider transport could not record its start fact',
                false, true, error
            );
        }

        if (remaining <= 0) {
            await this.end(client, permit, 'deadline_after_start');
            state.phase = 'completed';
            throw new MutationGateError(
                'transport_timeout', 'Attempt deadline elapsed before provider invocation',
                false, false
            );
        }

        const controller = new AbortController();
        state.controller = controller;
        const stop = metrics.timer('fervor_mutation_gate_transport_ms', {
            provider: permit.attempt.provider,
        });
        const transport = Promise.resolve()
            .then(() => this.forward({
                action: permit.action,
                attempt: permit.attempt,
                signal: controller.signal,
            }))
            .then<Outcome<T>, Outcome<T>>(
                (value) => ({ kind: 'return', value }),
                (error) => ({ kind: 'throw', error })
            );

        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<Race<T>>((resolve) => {
            timer = setTimeout(() => resolve({ kind: 'timeout' }), remaining);
            timer.unref?.();
        });
        const fault = state.fault === undefined
            ? state.faultWait.then<Race<T>>((error) => ({ kind: 'fault', error }))
            : Promise.resolve<Race<T>>({ kind: 'fault', error: state.fault });
        const raced = await Promise.race<Race<T>>([transport, timeout, fault]);

        if (raced.kind === 'timeout' || raced.kind === 'fault') {
            controller.abort(raced.kind === 'fault' ? raced.error : undefined);
            state.detached = true;
            state.phase = 'detached';
            metrics.increment('fervor_mutation_gate_detached', {
                provider: permit.attempt.provider,
                reason: raced.kind,
            });
            void this.finishDetached(client, permit, state, transport, timer, stop);
            if (raced.kind === 'fault') {
                throw new MutationGateError(
                    'audit_failed',
                    'Provider transport lost its pinned egress database session',
                    false,
                    true,
                    raced.error
                );
            }
            throw new MutationGateError(
                'transport_timeout',
                'Provider transport exceeded the attempt deadline',
                false,
                true
            );
        }

        if (timer) clearTimeout(timer);
        stop();
        state.controller = undefined;
        await this.end(client, permit, 'transport_settled');
        state.phase = 'completed';
        this.recordCompletion(permit, raced);
        if (raced.kind === 'throw') throw raced.error;
        return raced.value;
    }

    private async finishDetached(
        client: PoolClient,
        permit: Permit,
        state: GateState,
        transport: Promise<Outcome<T>>,
        timer: NodeJS.Timeout | undefined,
        stop: () => void
    ): Promise<void> {
        const outcome = await transport;
        if (timer) clearTimeout(timer);
        stop();
        state.controller = undefined;
        try {
            if (state.fault === undefined) {
                await this.end(client, permit, 'transport_settled');
                state.phase = 'completed';
            }
            this.recordCompletion(permit, outcome);
        } catch (error) {
            state.discard = true;
            metrics.increment('fervor_mutation_gate_detached_errors', {
                provider: permit.attempt.provider,
            });
            console.error('[mutation-gate] Detached completion failed', {
                attemptId: permit.attempt.id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        try {
            await this.release(client, state);
        } catch (error) {
            metrics.increment('fervor_mutation_gate_detached_errors', {
                provider: permit.attempt.provider,
            });
            console.error('[mutation-gate] Detached release failed', {
                attemptId: permit.attempt.id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private async end(
        client: PoolClient,
        permit: Permit,
        kind: 'transport_settled' | 'deadline_before_start' | 'deadline_after_start'
    ): Promise<void> {
        try {
            const completed = await client.query(`
                UPDATE action_egress
                   SET completed_at = clock_timestamp(), end_kind = $2
                 WHERE attempt_id = $1
                   AND completed_at IS NULL
                RETURNING completed_at
            `, [permit.attempt.id, kind]);
            if (!completed.rows[0]) {
                throw new Error('Egress completion fact was not writable');
            }
        } catch (error) {
            throw new MutationGateError(
                'audit_failed', 'Provider egress terminal fact was not durable',
                false,
                true,
                error
            );
        }
    }

    private recordCompletion(permit: Permit, outcome: Outcome<T>): void {
        metrics.increment('fervor_mutation_gate_completions', {
            provider: permit.attempt.provider,
            outcome: outcome.kind === 'return' ? 'returned' : 'threw',
        });
    }

    private async release(client: PoolClient, state: GateState): Promise<void> {
        const uncertain = mayHaveReserved(state);
        let failure: unknown = uncertain ? state.fault : undefined;
        if (state.scope && !state.discard) {
            try {
                const unlocked = await client.query<{ unlocked: boolean }>(
                    `SELECT pg_advisory_unlock_shared(
                        hashtextextended($1, 1937006964)
                    ) AS unlocked`,
                    [state.scope]
                );
                if (unlocked.rows[0]?.unlocked !== true) {
                    throw new Error('Pinned epoch lock was not held by the gateway session');
                }
            } catch (error) {
                state.discard = true;
                failure = error;
            }
        }
        if (state.onError) client.removeListener('error', state.onError);
        client.release(state.discard);
        this.samplePool();
        if (failure !== undefined) {
            throw new MutationGateError(
                uncertain ? 'audit_failed' : 'database_error',
                'Provider egress session cleanup failed',
                !uncertain, uncertain, failure
            );
        }
    }

    private assertActive(
        action: OrderAction,
        attempt: ActionAttempt,
        fence: ActionFence
    ): void {
        if (!sameFence(action, fence)
            || attempt.leaseGen !== fence.gen
            || attempt.writeScope !== fence.scope
            || attempt.writeEpoch !== fence.epoch) {
            throw new MutationGateError('fence_closed', 'Action fence is no longer active', true);
        }
        if (action.workState !== 'dispatching'
            || action.effectState !== 'possible'
            || action.outcome !== 'pending'
            || action.blockReason !== undefined
            || attempt.sendState !== 'started') {
            throw new MutationGateError(
                'state_conflict', 'Action and attempt are not eligible for provider egress'
            );
        }
        if (Date.parse(attempt.deadlineAt) > Date.parse(action.lease!.until)) {
            throw new MutationGateError(
                'fence_closed', 'Attempt deadline is outside its active lease', true
            );
        }
    }

    private assertReservation(
        row: EgressRow,
        action: OrderAction,
        attempt: ActionAttempt,
        fence: ActionFence
    ): void {
        if (String(row.attempt_id) !== attempt.id
            || String(row.action_id) !== action.id
            || String(row.lease_owner) !== fence.owner
            || String(row.lease_gen) !== fence.gen
            || String(row.lease_gen) !== attempt.leaseGen
            || String(row.write_scope) !== fence.scope
            || String(row.write_scope) !== attempt.writeScope
            || String(row.write_epoch) !== fence.epoch
            || String(row.write_epoch) !== attempt.writeEpoch
            || String(row.provider) !== attempt.provider
            || String(row.endpoint) !== attempt.endpoint
            || String(row.method) !== attempt.method
            || String(row.req_hash) !== attempt.reqHash
            || optional(row.body_hash) !== attempt.bodyHash
            || String(row.desired_hash) !== attempt.desiredHash
            || optional(row.blob_action_id) !== attempt.blobActionId) {
            throw new MutationGateError(
                'state_conflict', 'Existing egress reservation has a different immutable identity'
            );
        }
    }

    private validate(input: MutationInput): void {
        try {
            uuid(input.actionId, 'actionId');
            uuid(input.attemptId, 'attemptId');
            bounded(input.fence.owner, 'fence.owner', 128);
            uint(input.fence.gen, 'fence.gen', true);
            bounded(input.fence.scope, 'fence.scope', 64);
            uint(input.fence.epoch, 'fence.epoch', true);
        } catch (error) {
            throw new MutationGateError(
                'invalid_input',
                error instanceof Error ? error.message : 'Mutation input is invalid',
                false,
                false,
                error
            );
        }
    }

    private mapReserveError(error: unknown): MutationGateError {
        if (error instanceof MutationGateError) return error;
        const code = pgCode(error);
        if (code === '40001' || code === '55P03' || code === '57014') {
            return new MutationGateError(
                'fence_closed', 'Provider egress authorization did not remain live', true, false, error
            );
        }
        if (code === '23503' || code === '23514' || code === '55000') {
            return new MutationGateError(
                'state_conflict', 'Provider egress violated a durable action invariant', false, false, error
            );
        }
        return new MutationGateError(
            'database_error', 'Provider egress reservation failed', true, false, error
        );
    }
}
