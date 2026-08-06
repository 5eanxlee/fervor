import { describe, expect, it, vi } from 'vitest';
import { DbQuery } from '../src/config/database';
import { metrics } from '../src/services/metrics';
import { collectOpsMetrics, getReadiness, OpsCollector } from '../src/services/observability';

const result = (row: Record<string, unknown>) => ({ rows: [row], rowCount: 1 }) as any;

describe('readiness and degradation', () => {
    it('keeps a dependency-healthy API ready while reporting queue degradation', async () => {
        let statement = '';
        const db = vi.fn(async (sql: string) => {
            statement = sql;
            return result({
            outbox: 100001,
            outbox_failed: 2,
            notifications: 100001,
            executions_signed: 1,
            executions_chain: 2,
            execution_recoveries: 5,
            execution_ambiguous: 2,
            execution_repeated: 1,
            execution_recovery_age_ms: '45000',
            orders: 4,
            market_age_ms: null,
            });
        }) as unknown as DbQuery;

        const collector = new OpsCollector(db, 1000, vi.fn());
        await collector.run();
        const status = await getReadiness(async () => true, collector);
        expect(status.ready).toBe(true);
        expect(status.degraded).toBe(true);
        expect(status.checks).toMatchObject({
            database: true,
            redis: true,
            outboxBacklog: false,
            notificationBacklog: false,
            executionBacklog: false,
            orderBacklog: false,
        });
        expect(status.backlog).toMatchObject({
            executionRecoveries: 5,
            executionAmbiguous: 2,
            executionRepeated: 1,
            executionRecoveryAgeMs: 45000,
        });
        expect(statement).toContain('COALESCE(broadcast_started_at, submitted_at, created_at)');
        expect(statement).toContain('COALESCE(submitted_at, created_at)');
        expect(statement).toContain("state IN ('submitted', 'processed', 'confirmed')");
        const output = metrics.toPrometheus();
        expect(output).toContain('fervor_execution_recovery_pending 5');
        expect(output).toContain('fervor_execution_ambiguous 2');
        expect(output).toContain('fervor_execution_repeated 1');
        expect(output).toContain('fervor_execution_recovery_age_ms 45000');
        expect(output).toContain('fervor_ops_collect_ok 1');
    });

    it('fails readiness when a required dependency is unavailable', async () => {
        const db = vi.fn(async () => result({
            outbox: 0,
            outbox_failed: 0,
            notifications: 0,
            executions_signed: 0,
            executions_chain: 0,
            execution_recoveries: 0,
            execution_ambiguous: 0,
            execution_repeated: 0,
            execution_recovery_age_ms: null,
            orders: 0,
            market_age_ms: null,
        })) as unknown as DbQuery;

        const collector = new OpsCollector(db, 1000, vi.fn());
        await collector.run();
        const status = await getReadiness(async () => false, collector);
        expect(status.ready).toBe(false);
        expect(status.degraded).toBe(false);
        expect(status.checks.redis).toBe(false);
    });

    it('preserves the last successful sample timestamp when collection fails', async () => {
        const ok = vi.fn(async () => result({
            outbox: 0,
            outbox_failed: 0,
            notifications: 0,
            executions_signed: 0,
            executions_chain: 0,
            execution_recoveries: 0,
            execution_ambiguous: 0,
            execution_repeated: 0,
            execution_recovery_age_ms: null,
            orders: 0,
            market_age_ms: null,
        })) as unknown as DbQuery;
        await collectOpsMetrics(ok, () => 123_000);

        const failed = vi.fn(async () => {
            throw new Error('database unavailable');
        }) as unknown as DbQuery;
        await expect(collectOpsMetrics(failed, () => 456_000)).rejects.toThrow('database unavailable');

        const output = metrics.toPrometheus();
        expect(output).toContain('fervor_ops_collect_ok 0');
        expect(output).toContain('fervor_ops_collect_last_success_unixtime 123');
        expect(output).toContain('fervor_ops_collect_errors_total 1');
    });

    it('does not overlap background collections', async () => {
        let release!: (value: ReturnType<typeof result>) => void;
        const blocked = new Promise<ReturnType<typeof result>>((resolve) => { release = resolve; });
        const db = vi.fn(() => blocked) as unknown as DbQuery;
        const onError = vi.fn();
        const collector = new OpsCollector(db, 1000, onError);

        const first = collector.run();
        const second = collector.run();
        expect(db).toHaveBeenCalledOnce();
        release(result({
            outbox: 0,
            outbox_failed: 0,
            notifications: 0,
            executions_signed: 0,
            executions_chain: 0,
            execution_recoveries: 0,
            execution_ambiguous: 0,
            execution_repeated: 0,
            execution_recovery_age_ms: null,
            orders: 0,
            market_age_ms: null,
        }));
        await expect(first).resolves.toBe(true);
        await expect(second).resolves.toBe(true);
        expect(onError).not.toHaveBeenCalled();
        expect(metrics.toPrometheus()).toContain('fervor_ops_collect_skipped_total 1');
    });

    it('serves concurrent readiness requests from one cached collection', async () => {
        let release!: (value: ReturnType<typeof result>) => void;
        const blocked = new Promise<ReturnType<typeof result>>((resolve) => { release = resolve; });
        const db = vi.fn(() => blocked) as unknown as DbQuery;
        const collector = new OpsCollector(db, 1000, vi.fn());

        const running = collector.run();
        const cold = await Promise.all([
            getReadiness(async () => true, collector),
            getReadiness(async () => true, collector),
        ]);
        expect(cold).toMatchObject([{ ready: false }, { ready: false }]);
        expect(db).toHaveBeenCalledOnce();
        release(result({
            outbox: 0,
            outbox_failed: 0,
            notifications: 0,
            executions_signed: 0,
            executions_chain: 0,
            execution_recoveries: 0,
            execution_ambiguous: 0,
            execution_repeated: 0,
            execution_recovery_age_ms: null,
            orders: 0,
            market_age_ms: null,
        }));

        await expect(running).resolves.toBe(true);
        await expect(Promise.all([
            getReadiness(async () => true, collector),
            getReadiness(async () => true, collector),
        ])).resolves.toMatchObject([
            { ready: true },
            { ready: true },
        ]);
        expect(db).toHaveBeenCalledOnce();
    });

    it('clears market age when a successful sample has no observed token', async () => {
        const row = {
            outbox: 0,
            outbox_failed: 0,
            notifications: 0,
            executions_signed: 0,
            executions_chain: 0,
            execution_recoveries: 0,
            execution_ambiguous: 0,
            execution_repeated: 0,
            execution_recovery_age_ms: null,
            orders: 0,
        };
        const db = vi.fn()
            .mockResolvedValueOnce(result({ ...row, market_age_ms: 2500 }))
            .mockResolvedValueOnce(result({ ...row, market_age_ms: null })) as unknown as DbQuery;

        await collectOpsMetrics(db);
        await collectOpsMetrics(db);
        const output = metrics.toPrometheus();
        expect(output).toContain('fervor_market_age_ms 0');
        expect(output).toContain('fervor_market_sample_present 0');
        expect(output).toContain('fervor_ops_collect_ok 1');
    });
});
