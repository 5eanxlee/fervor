import crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DbQuery } from '../src/config/database';
import { OrderError, OrderService } from '../src/services/orders/orderService';
import type { OrderProvider } from '../src/services/orders/provider';
import { OrderProviderError } from '../src/services/orders/provider';

const input = { orderType: 'single' as const, triggerPriceUsd: 300 };

const row = (id: string) => ({
    id,
    user_id: 'user-1',
    state: 'open',
    provider_order_id: `provider-${id}`,
    order_type: 'single',
    params: { triggerPriceUsd: 250 },
    error_code: null as string | null,
    op_state: null as string | null,
    op_token: null as string | null,
    op_writer: null as number | null,
    op_ver: 0,
    op_started_at: null as Date | null,
    unknown_at: null as Date | null,
    op_req_hash: null as string | null,
});

const provider = (update: ReturnType<typeof vi.fn>, history?: OrderProvider['history']) => ({
    name: 'jupiter_trigger_v2',
    requiresAuth: true,
    custody: 'third_party_vault',
    update,
    history,
}) as unknown as OrderProvider;

const statefulDb = (stored: ReturnType<typeof row>, options: {
    failCommit?: boolean;
    failEvent?: boolean;
    failUnknownWrite?: boolean;
} = {}) => {
    let failCommit = options.failCommit;
    const calls: string[] = [];
    const db = vi.fn(async (sql: string, values: unknown[] = []) => {
        calls.push(sql);
        if (sql.startsWith('SELECT * FROM order_intents')) return { rows: [{ ...stored }] };
        if (sql.includes("SET op_state = 'started'")) {
            if (stored.op_state !== 'reserved' || stored.op_token !== values[1]) return { rows: [] };
            stored.op_state = 'started';
            return { rows: [{ id: stored.id }] };
        }
        if (sql.includes("op_state = 'reserved'")) {
            if (stored.error_code || stored.op_state === 'started') return { rows: [] };
            stored.op_token = String(values[1]);
            stored.op_state = 'reserved';
            stored.op_writer = 2;
            stored.op_ver += 1;
            return { rows: [{ id: stored.id }] };
        }
        if (sql.includes('unknown_at = clock_timestamp()')) {
            if (options.failUnknownWrite) throw new Error('unknown marker unavailable');
            stored.error_code = 'provider_outcome_unknown';
            stored.op_token = null;
            stored.op_ver += 1;
            return { rows: [{ id: stored.id }] };
        }
        if (sql.includes('SET params =') && failCommit) {
            failCommit = false;
            throw new Error('database write failed');
        }
        if (sql.startsWith('SELECT error_code, op_state')) {
            return { rows: [{ error_code: stored.error_code, op_state: stored.op_state }] };
        }
        if (sql.includes('INSERT INTO order_events') && options.failEvent) {
            throw new Error('event store unavailable');
        }
        return { rows: [] };
    }) as unknown as DbQuery;
    return { db, calls };
};

describe('order mutation ambiguity', () => {
    it('commits the replay block independently when lifecycle publication fails', async () => {
        const stored = row('order-1');
        const { db, calls } = statefulDb(stored, { failEvent: true });
        const update = vi.fn().mockRejectedValue(new OrderProviderError(
            'provider_timeout', 'acknowledgement was lost', true, 504, undefined, true
        ));
        const service = new OrderService(provider(update), db, async (work) => work(db));

        await expect(service.update('user-1', stored.id, input, 'token'))
            .rejects.toMatchObject({ uncertain: true });
        expect(stored).toMatchObject({
            error_code: 'provider_outcome_unknown',
            op_state: 'started',
            op_token: null,
            op_writer: 2,
            op_ver: 2,
        });
        expect(calls.findIndex((sql) => sql.includes('unknown_at = clock_timestamp()')))
            .toBeLessThan(calls.findIndex((sql) => sql.includes('INSERT INTO order_events')));
        await expect(service.update('user-1', stored.id, input, 'token'))
            .rejects.toMatchObject({ code: 'order_reconciliation_required' });
        expect(update).toHaveBeenCalledOnce();
    });

    it('retains a started fact when even the unknown marker cannot be written', async () => {
        const stored = row('order-2');
        const { db } = statefulDb(stored, { failUnknownWrite: true });
        const update = vi.fn().mockRejectedValue(new OrderProviderError(
            'provider_timeout', 'provider status is unknown', true, 504, undefined, true
        ));
        const service = new OrderService(provider(update), db, async (work) => work(db));

        await expect(service.update('user-1', stored.id, input, 'token'))
            .rejects.toMatchObject({ code: 'provider_timeout' });
        expect(stored).toMatchObject({ error_code: null, op_state: 'started' });
        await expect(service.update('user-1', stored.id, input, 'token'))
            .rejects.toMatchObject({ code: 'order_reconciliation_required' });
        expect(update).toHaveBeenCalledOnce();
    });

    it('blocks replay when an acknowledged mutation cannot be persisted', async () => {
        const stored = row('order-3');
        const { db } = statefulDb(stored, { failCommit: true });
        const update = vi.fn().mockResolvedValue(undefined);
        const service = new OrderService(provider(update), db, async (work) => work(db));

        await expect(service.update('user-1', stored.id, input, 'token'))
            .rejects.toMatchObject({ code: 'provider_result_uncommitted', uncertain: true });
        await expect(service.update('user-1', stored.id, input, 'token'))
            .rejects.toMatchObject({ code: 'order_reconciliation_required' });
        expect(update).toHaveBeenCalledOnce();
    });

    it('makes the unknown predicate atomic with lease acquisition', async () => {
        const stored = row('order-4');
        const db = vi.fn(async (sql: string) => {
            if (sql.startsWith('SELECT * FROM order_intents')) return { rows: [{ ...stored }] };
            if (sql.includes("op_state = 'reserved'")) {
                stored.op_state = 'started';
                stored.error_code = 'provider_outcome_unknown';
                return { rows: [] };
            }
            if (sql.startsWith('SELECT error_code, op_state')) return { rows: [{ ...stored }] };
            return { rows: [] };
        }) as unknown as DbQuery;
        const update = vi.fn();
        const service = new OrderService(provider(update), db, async (work) => work(db));

        await expect(service.update('user-1', stored.id, input, 'token'))
            .rejects.toEqual(expect.objectContaining<OrderError>({
                code: 'order_reconciliation_required', status: 409,
            }));
        expect(update).not.toHaveBeenCalled();
    });

    it('clears an ambiguous edit only when history proves every desired field', async () => {
        const want = { orderType: 'single', triggerPriceUsd: 300 };
        const wantHash = crypto.createHash('sha256')
            .update(JSON.stringify(want))
            .digest('hex');
        const stored = {
            ...row('order-5'),
            error_code: 'provider_outcome_unknown',
            op_state: 'started',
            op_kind: 'edit',
            op_writer: 2,
            op_ver: 2,
            op_started_at: new Date('2026-08-03T12:00:00.000Z'),
            unknown_at: new Date('2026-08-03T12:00:01.000Z'),
            op_req_hash: 'a'.repeat(64),
            op_want_hash: wantHash,
            op_detail: { want },
            unknown_detail: { evidence: { providerOrderId: 'provider-order-5' } },
        };
        let resolved = false;
        const db = vi.fn(async (sql: string) => {
            if (sql.includes('ORDER BY created_at')) return { rows: [] };
            if (sql.startsWith('SELECT *') && sql.includes('OR error_code')) return { rows: [stored] };
            if (sql.includes("op_kind = $6 AND op_want_hash = $7")) {
                resolved = true;
                return { rows: [{ id: stored.id }] };
            }
            if (sql.includes('INSERT INTO event_outbox')) return { rows: [{ id: 'event-1' }] };
            return { rows: [] };
        }) as unknown as DbQuery;
        const history = vi.fn().mockResolvedValue([{
            providerOrderId: 'provider-order-5', orderType: 'single', state: 'open', triggerPriceUsd: 300,
            updatedAt: '2026-08-03T12:00:02.000Z',
        }]);
        const service = new OrderService(provider(vi.fn(), history), db, async (work) => work(db));

        await service.sync('user-1', 'token');
        expect(resolved).toBe(true);
    });

    it('does not clear an ambiguous edit from incomplete or mismatched history', async () => {
        const want = { orderType: 'single', triggerPriceUsd: 300, slippageBps: 100 };
        const stored = {
            ...row('order-6'),
            error_code: 'provider_outcome_unknown',
            op_state: 'started',
            op_kind: 'edit',
            op_writer: 2,
            op_ver: 2,
            op_started_at: new Date('2026-08-03T12:00:00.000Z'),
            unknown_at: new Date('2026-08-03T12:00:01.000Z'),
            op_req_hash: 'b'.repeat(64),
            op_want_hash: crypto.createHash('sha256').update(JSON.stringify(want)).digest('hex'),
            op_detail: { want },
            unknown_detail: { evidence: { providerOrderId: 'provider-order-6' } },
        };
        const db = vi.fn(async (sql: string) => {
            if (sql.includes('ORDER BY created_at')) return { rows: [] };
            if (sql.startsWith('SELECT *') && sql.includes('OR error_code')) return { rows: [stored] };
            return { rows: [] };
        }) as unknown as DbQuery;
        const history = vi.fn().mockResolvedValue([{
            providerOrderId: 'provider-order-6', orderType: 'single', state: 'open', triggerPriceUsd: 300,
            updatedAt: '2026-08-03T12:00:02.000Z',
        }]);
        const service = new OrderService(provider(vi.fn(), history), db, async (work) => work(db));

        await service.sync('user-1', 'token');
        expect((db as ReturnType<typeof vi.fn>).mock.calls.some(
            ([sql]) => String(sql).includes("op_kind = $6 AND op_want_hash = $7")
        )).toBe(false);
    });

    it('does not clear an operation from provider state older than its dispatch', async () => {
        const want = { orderType: 'single', triggerPriceUsd: 300 };
        const stored = {
            ...row('order-7'),
            error_code: 'provider_outcome_unknown',
            op_state: 'started',
            op_kind: 'edit',
            op_writer: 2,
            op_ver: 2,
            op_started_at: new Date('2026-08-03T12:00:02.000Z'),
            unknown_at: new Date('2026-08-03T12:00:03.000Z'),
            op_req_hash: 'c'.repeat(64),
            op_want_hash: crypto.createHash('sha256').update(JSON.stringify(want)).digest('hex'),
            op_detail: { want },
            unknown_detail: { evidence: { providerOrderId: 'provider-order-7' } },
        };
        const db = vi.fn(async (sql: string) => {
            if (sql.includes('ORDER BY created_at')) return { rows: [] };
            if (sql.startsWith('SELECT *') && sql.includes('OR error_code')) return { rows: [stored] };
            return { rows: [] };
        }) as unknown as DbQuery;
        const history = vi.fn().mockResolvedValue([{
            providerOrderId: 'provider-order-7', orderType: 'single', state: 'open', triggerPriceUsd: 300,
            updatedAt: '2026-08-03T12:00:01.000Z',
        }]);
        const service = new OrderService(provider(vi.fn(), history), db, async (work) => work(db));

        await service.sync('user-1', 'token');
        expect((db as ReturnType<typeof vi.fn>).mock.calls.some(
            ([sql]) => String(sql).includes('AND op_writer = $8 AND op_ver = $9')
        )).toBe(false);
    });
});
