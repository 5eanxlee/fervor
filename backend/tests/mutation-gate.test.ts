import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ActionAttempt, ActionFence, OrderAction } from '../src/types';
import { MutationGate, MutationGateError } from '../src/services/orders/mutationGate';

const actionId = randomUUID();
const attemptId = randomUUID();
const fence: ActionFence = {
    owner: 'worker-a',
    gen: '3',
    scope: 'provider:fixture',
    epoch: '7',
};

const action = (deadlineMs = 5_000): OrderAction => {
    const now = Date.now();
    return ({
    id: actionId,
    orderId: randomUUID(),
    userId: randomUUID(),
    kind: 'provider_sync',
    ruleVer: 1,
    clientKey: 'provider-sync-fixture',
    reqHash: 'a'.repeat(64),
    desiredHash: 'b'.repeat(64),
    expectedVer: '1',
    version: '3',
    workState: 'dispatching',
    effectState: 'possible',
    outcome: 'pending',
    provider: 'fixture',
    attemptCount: 1,
    dueAt: new Date(now - 1_000).toISOString(),
    lease: { ...fence, until: new Date(now + deadlineMs + 5_000).toISOString() },
    createdAt: new Date(now - 2_000).toISOString(),
    updatedAt: new Date(now - 1_000).toISOString(),
    });
};

const attempt = (deadlineMs = 5_000): ActionAttempt => {
    const now = Date.now();
    return ({
    id: attemptId,
    actionId,
    seq: 1,
    leaseGen: fence.gen,
    writeScope: fence.scope,
    writeEpoch: fence.epoch,
    endpoint: '/fixture',
    method: 'GET',
    provider: 'fixture',
    reqHash: 'a'.repeat(64),
    desiredHash: 'b'.repeat(64),
    sendState: 'started',
    deadlineAt: new Date(now + deadlineMs).toISOString(),
    createdAt: new Date(now - 1_000).toISOString(),
    });
};

const actionRow = (value: OrderAction) => ({
    id: value.id,
    order_id: value.orderId,
    user_id: value.userId,
    leg_id: null,
    parent_action: null,
    kind: value.kind,
    rule_ver: value.ruleVer,
    client_key: value.clientKey,
    req_hash: value.reqHash,
    desired_hash: value.desiredHash,
    expected_ver: value.expectedVer,
    action_ver: value.version,
    work_state: value.workState,
    effect_state: value.effectState,
    outcome: value.outcome,
    block_reason: null,
    provider: value.provider,
    provider_req_id: null,
    provider_order_id: null,
    first_signature: null,
    message_hash: null,
    recent_blockhash: null,
    last_valid_height: null,
    attempt_count: value.attemptCount,
    due_at: value.dueAt,
    lease_owner: value.lease!.owner,
    lease_gen: value.lease!.gen,
    write_scope: value.lease!.scope,
    write_epoch: value.lease!.epoch,
    lease_until: value.lease!.until,
    ambiguity_at: null,
    provider_check_at: null,
    chain_check_at: null,
    error_code: null,
    error_class: null,
    error_message: null,
    http_class: null,
    retry_after: null,
    completed_at: null,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
});

const attemptRow = (value: ActionAttempt) => ({
    id: value.id,
    action_id: value.actionId,
    seq: value.seq,
    lease_gen: value.leaseGen,
    write_scope: value.writeScope,
    write_epoch: value.writeEpoch,
    endpoint: value.endpoint,
    method: value.method,
    provider: value.provider,
    req_hash: value.reqHash,
    body_hash: null,
    desired_hash: value.desiredHash,
    provider_req_id: null,
    blob_action_id: null,
    send_state: value.sendState,
    started_at: new Date(Date.now() - 500),
    deadline_at: value.deadlineAt,
    completed_at: null,
    http_status: null,
    http_class: null,
    response_hash: null,
    provider_effect_id: null,
    error_code: null,
    error_message: null,
    created_at: value.createdAt,
});

interface ClientOptions {
    deadlineMs?: number;
    remainingMs?: number;
    commit?: () => Promise<void>;
    reserveFault?: Error;
    startError?: unknown;
    completeError?: unknown;
    unlocked?: boolean;
}

class FakeClient extends EventEmitter {
    readonly release = vi.fn();
    readonly queries: string[] = [];
    readonly params: unknown[][] = [];
    private readonly order: OrderAction;
    private readonly send: ActionAttempt;

    constructor(private readonly options: ClientOptions = {}) {
        super();
        this.order = action(options.deadlineMs);
        this.send = attempt(options.deadlineMs);
    }

    async query(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
        this.queries.push(sql);
        this.params.push(params);
        if (sql === 'COMMIT' && this.options.commit) await this.options.commit();
        if (sql.includes('SELECT order_id FROM order_actions')) {
            return { rows: [{ order_id: this.order.orderId }], rowCount: 1 };
        }
        if (sql.includes('SELECT * FROM order_actions')) {
            return { rows: [actionRow(this.order)], rowCount: 1 };
        }
        if (sql.includes('SELECT * FROM action_attempts')) {
            return { rows: [attemptRow(this.send)], rowCount: 1 };
        }
        if (sql.includes('SELECT * FROM action_egress')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO action_egress')) {
            if (this.options.reserveFault) this.emit('error', this.options.reserveFault);
            return { rows: [{ attempt_id: attemptId }], rowCount: 1 };
        }
        if (sql.includes('SET started_at')) {
            if (this.options.startError !== undefined) throw this.options.startError;
            return {
                rows: [{
                    started_at: new Date(),
                    remaining_ms: String(
                        this.options.remainingMs ?? this.options.deadlineMs ?? 5_000
                    ),
                }],
                rowCount: 1,
            };
        }
        if (sql.includes('SET completed_at')) {
            if (this.options.completeError !== undefined) throw this.options.completeError;
            return { rows: [{ completed_at: new Date() }], rowCount: 1 };
        }
        if (sql.includes('pg_advisory_unlock_shared')) {
            const unlocked = this.options.unlocked ?? true;
            return { rows: [{ unlocked }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    }
}

const database = (client: FakeClient) => ({
    getClient: vi.fn().mockResolvedValue(client),
    stats: () => ({ total: 1, idle: 0, waiting: 0, max: 2, min: 0 }),
});

const input = { actionId, attemptId, fence };

describe('mutation gate', () => {
    it('durably closes a reservation when PostgreSQL rejects transport start', async () => {
        const client = new FakeClient({
            deadlineMs: 20_000,
            commit: () => new Promise((resolve) => setTimeout(resolve, 35)),
            startError: Object.assign(new Error('deadline elapsed'), { code: '40001' }),
        });
        const forward = vi.fn().mockResolvedValue('forwarded');
        const gate = new MutationGate(forward, database(client), { acquireMs: 100 });

        await expect(gate.run(input)).rejects.toMatchObject({
            code: 'transport_timeout', uncertain: false,
        });
        expect(forward).not.toHaveBeenCalled();
        expect(client.queries.some((sql) => sql.includes('SET started_at'))).toBe(true);
        const end = client.queries.findIndex((sql) => sql.includes('SET completed_at'));
        expect(client.params[end]).toEqual([attemptId, 'deadline_before_start']);
        expect(client.release).toHaveBeenCalledWith(false);
    });

    it('uses the database budget when the application clock is skewed', async () => {
        const live = new FakeClient({ deadlineMs: -1_000, remainingMs: 500 });
        await expect(new MutationGate(
            async () => 'sent', database(live)
        ).run(input)).resolves.toBe('sent');

        const elapsed = new FakeClient({
            deadlineMs: 60_000,
            startError: Object.assign(new Error('database deadline'), { code: '40001' }),
        });
        const forward = vi.fn();
        await expect(new MutationGate(forward, database(elapsed)).run(input)).rejects.toMatchObject({
            code: 'transport_timeout', uncertain: false,
        });
        expect(forward).not.toHaveBeenCalled();
    });

    it('closes a locally exhausted database budget without invoking transport', async () => {
        const client = new FakeClient({ remainingMs: 0 });
        const forward = vi.fn();
        await expect(new MutationGate(forward, database(client)).run(input)).rejects.toMatchObject({
            code: 'transport_timeout', uncertain: false,
        });
        expect(forward).not.toHaveBeenCalled();
        const end = client.queries.findIndex((sql) => sql.includes('SET completed_at'));
        expect(client.params[end]).toEqual([attemptId, 'deadline_after_start']);
    });

    it('keeps a detached session until a non-cooperative transport settles', async () => {
        let settle!: (value: string) => void;
        const transport = new Promise<string>((resolve) => { settle = resolve; });
        const client = new FakeClient({ deadlineMs: 30 });
        const gate = new MutationGate(() => transport, database(client), { acquireMs: 100 });

        await expect(gate.run(input)).rejects.toMatchObject({
            code: 'transport_timeout', uncertain: true,
        });
        expect(client.release).not.toHaveBeenCalled();
        settle('late');
        await vi.waitFor(() => expect(client.release).toHaveBeenCalledWith(false));
        expect(client.queries.some((sql) => sql.includes('SET completed_at'))).toBe(true);
    });

    it('records a thrown undefined as a real transport failure', async () => {
        const client = new FakeClient();
        const gate = new MutationGate(async () => {
            throw undefined;
        }, database(client));
        let rejected = false;
        try {
            await gate.run(input);
        } catch (error) {
            rejected = true;
            expect(error).toBeUndefined();
        }
        expect(rejected).toBe(true);
        expect(client.queries.some((sql) => sql.includes('SET completed_at'))).toBe(true);
    });

    it('fails uncertain when completion or lock release is not durable', async () => {
        const complete = new FakeClient({ completeError: new Error('write failed') });
        await expect(new MutationGate(
            async () => 'ok', database(complete)
        ).run(input)).rejects.toMatchObject({ code: 'audit_failed', uncertain: true });

        const unlock = new FakeClient({ unlocked: false });
        await expect(new MutationGate(
            async () => 'ok', database(unlock)
        ).run(input)).rejects.toMatchObject({ code: 'audit_failed', uncertain: true });
        expect(unlock.release).toHaveBeenCalledWith(true);
    });

    it('treats a commit failure as an ambiguous reservation', async () => {
        const error = new Error('commit connection reset');
        const client = new FakeClient({ commit: async () => { throw error; } });
        await expect(new MutationGate(
            async () => 'never', database(client)
        ).run(input)).rejects.toMatchObject({ code: 'audit_failed', uncertain: true });
        expect(client.release).toHaveBeenCalledWith(true);
    });

    it('keeps a pre-commit client fault retryable and certain', async () => {
        const client = new FakeClient({ reserveFault: new Error('socket closed before commit') });
        await expect(new MutationGate(
            async () => 'never', database(client)
        ).run(input)).rejects.toMatchObject({
            code: 'database_error', retryable: true, uncertain: false,
        });
        expect(client.queries).toContain('ROLLBACK');
        expect(client.release).toHaveBeenCalledWith(true);
    });

    it('aborts promptly on a checked-out client error and retains cleanup ownership', async () => {
        let settle!: () => void;
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => { entered = resolve; });
        const transport = new Promise<string>((resolve) => { settle = () => resolve('late'); });
        const client = new FakeClient();
        const gate = new MutationGate(({ signal }) => {
            entered();
            expect(signal.aborted).toBe(false);
            return transport;
        }, database(client));
        const run = gate.run(input);
        await ready;
        client.emit('error', new Error('socket closed'));
        await expect(run).rejects.toMatchObject({ code: 'audit_failed', uncertain: true });
        expect(client.release).not.toHaveBeenCalled();
        settle();
        await vi.waitFor(() => expect(client.release).toHaveBeenCalledWith(true));
    });

    it('compares every supplied fence field to an existing reservation', () => {
        const gate = new MutationGate(async () => 'ok');
        const order = action();
        const send = attempt();
        const row = {
            attempt_id: send.id,
            action_id: order.id,
            lease_owner: fence.owner,
            lease_gen: fence.gen,
            write_scope: fence.scope,
            write_epoch: fence.epoch,
            provider: send.provider,
            endpoint: send.endpoint,
            method: send.method,
            req_hash: send.reqHash,
            body_hash: null,
            desired_hash: send.desiredHash,
            blob_action_id: null,
            forwarded_at: new Date(),
            started_at: null,
            completed_at: null,
            phase_ver: null,
            end_kind: null,
        };
        const assert = (value: ActionFence) => (
            gate as unknown as {
                assertReservation: (
                    stored: typeof row,
                    current: OrderAction,
                    currentAttempt: ActionAttempt,
                    supplied: ActionFence
                ) => void;
            }
        ).assertReservation(row, order, send, value);

        for (const changed of [
            { ...fence, owner: 'worker-b' },
            { ...fence, gen: '4' },
            { ...fence, scope: 'provider:other' },
            { ...fence, epoch: '8' },
        ]) {
            expect(() => assert(changed)).toThrowError(MutationGateError);
        }
    });

    it('bounds pool admission and releases a late checkout', async () => {
        let checkOut!: (client: FakeClient) => void;
        const pending = new Promise<FakeClient>((resolve) => { checkOut = resolve; });
        const db = { getClient: () => pending };
        const gate = new MutationGate(async () => 'never', db, { acquireMs: 10 });
        await expect(gate.run(input)).rejects.toMatchObject({
            code: 'database_error', retryable: true,
        });
        const client = new FakeClient();
        checkOut(client);
        await vi.waitFor(() => expect(client.release).toHaveBeenCalledWith());
    });
});
