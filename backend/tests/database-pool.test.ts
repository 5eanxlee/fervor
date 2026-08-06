import { beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    pools: [] as Array<{
        options: Record<string, unknown>;
        client: {
            query: ReturnType<typeof vi.fn>;
            release: ReturnType<typeof vi.fn>;
        };
        end: ReturnType<typeof vi.fn>;
    }>,
}));

vi.mock('pg', () => ({
    Pool: class {
        totalCount = 0;
        idleCount = 0;
        waitingCount = 0;
        options: Record<string, unknown>;
        client = { query: vi.fn(), release: vi.fn() };
        end = vi.fn().mockResolvedValue(undefined);

        constructor(options: Record<string, unknown>) {
            this.options = options;
            state.pools.push(this);
        }

        on() {
            return this;
        }

        query() {
            return Promise.resolve({ rows: [], rowCount: 0 });
        }

        connect() {
            return Promise.resolve(this.client);
        }
    },
}));

let database: typeof import('../src/config/database');

beforeAll(async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORE_DATABASE_URL = 'postgresql://core_user@core.example/fervor_core';
    process.env.MARKET_DATABASE_URL = 'postgresql://market_user@market.example/fervor_market';
    process.env.DB_COLOCATED = 'false';
    process.env.DB_SSL_MODE = 'verify-full';
    process.env.DB_SSL_CA = 'test-ca';
    process.env.REDIS_URL = 'redis://redis.example:6379';
    process.env.CORE_DB_POOL_MAX = '18';
    process.env.CORE_DB_POOL_MIN = '2';
    process.env.CORE_DB_TIMEOUT_MS = '12000';
    process.env.MARKET_DB_POOL_MAX = '7';
    process.env.MARKET_DB_POOL_MIN = '1';
    process.env.MARKET_DB_TIMEOUT_MS = '6000';
    process.env.EGRESS_DB_POOL_MAX = '5';
    process.env.EGRESS_DB_POOL_MIN = '1';
    process.env.EGRESS_ACQUIRE_MS = '750';
    process.env.DB_CONNECT_TIMEOUT_MS = '5000';
    vi.resetModules();
    database = await import('../src/config/database');
});

describe('database pool isolation', () => {
    it('builds one bounded, verified pool per runtime plane', () => {
        expect(state.pools).toHaveLength(3);
        expect(state.pools[0].options).toMatchObject({
            connectionString: 'postgresql://core_user@core.example/fervor_core',
            ssl: { rejectUnauthorized: true, ca: 'test-ca' },
            max: 18,
            min: 2,
            statement_timeout: 12000,
            connectionTimeoutMillis: 5000,
        });
        expect(state.pools[1].options).toMatchObject({
            connectionString: 'postgresql://market_user@market.example/fervor_market',
            ssl: { rejectUnauthorized: true, ca: 'test-ca' },
            max: 7,
            min: 1,
            statement_timeout: 6000,
            connectionTimeoutMillis: 5000,
        });
        expect(String(state.pools[0].options.application_name)).toMatch(/^fervor-core-\d+$/);
        expect(String(state.pools[1].options.application_name)).toMatch(/^fervor-market-\d+$/);
        expect(state.pools[2].options).toMatchObject({
            connectionString: 'postgresql://core_user@core.example/fervor_core',
            ssl: { rejectUnauthorized: true, ca: 'test-ca' },
            max: 5,
            min: 1,
            statement_timeout: 12000,
            connectionTimeoutMillis: 750,
        });
        expect(String(state.pools[2].options.application_name)).toMatch(/^fervor-egress-\d+$/);
        expect(database.coreDb.plane).toBe('core');
        expect(database.marketDb.plane).toBe('market');
        expect(database.egressDb.plane).toBe('egress');
        expect(database.default.options).toBe(state.pools[0].options);
        expect(database.default.connect).toBeTypeOf('function');
        expect(database.default.end).toBeTypeOf('function');
    });

    it('discards a client when rollback cannot restore transaction state', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const original = new Error('work failed');
        const client = state.pools[0].client;
        client.query
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('rollback failed'));

        await expect(database.coreDb.transaction(async () => {
            throw original;
        })).rejects.toBe(original);
        expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
        expect(client.query).toHaveBeenNthCalledWith(2, 'ROLLBACK');
        expect(client.release).toHaveBeenCalledWith(true);
    });

    it('attempts to drain both pools when one shutdown fails', async () => {
        const failure = new Error('core drain failed');
        state.pools[0].end.mockRejectedValueOnce(failure);
        await expect(database.closeDatabase()).rejects.toBe(failure);
        expect(state.pools[0].end).toHaveBeenCalledOnce();
        expect(state.pools[1].end).toHaveBeenCalledOnce();
        expect(state.pools[2].end).toHaveBeenCalledOnce();
    });
});
