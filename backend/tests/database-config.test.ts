import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';

const secret = 'a'.repeat(64);

describe('database plane configuration', () => {
    it('requires explicit planes unless co-location is acknowledged', () => {
        expect(() => parseEnv({
            NODE_ENV: 'test',
            DATABASE_URL: 'postgres://db/fervor',
            JWT_SECRET: secret,
        } as NodeJS.ProcessEnv)).toThrow(/DB_COLOCATED=true/);

        const parsed = parseEnv({
            NODE_ENV: 'test',
            DATABASE_URL: 'postgres://db/fervor',
            DB_COLOCATED: 'true',
            JWT_SECRET: secret,
        } as NodeJS.ProcessEnv);

        expect(parsed.CORE_DATABASE_URL).toBe('postgres://db/fervor');
        expect(parsed.MARKET_DATABASE_URL).toBe('postgres://db/fervor');

        expect(() => parseEnv({
            NODE_ENV: 'test',
            CORE_DATABASE_URL: 'postgres://db/core',
            MARKET_DATABASE_URL: 'postgres://db/market',
            JWT_SECRET: secret,
        } as NodeJS.ProcessEnv)).toThrow(/shared database endpoint requires DB_COLOCATED=true/i);
    });

    it('resolves independent connection budgets for each plane', () => {
        const parsed = parseEnv({
            NODE_ENV: 'test',
            CORE_DATABASE_URL: 'postgres://core/fervor',
            MARKET_DATABASE_URL: 'postgres://market/fervor',
            CORE_DB_POOL_MAX: '18',
            CORE_DB_POOL_MIN: '2',
            MARKET_DB_POOL_MAX: '7',
            MARKET_DB_POOL_MIN: '1',
            EGRESS_DB_POOL_MAX: '5',
            EGRESS_DB_POOL_MIN: '1',
            EGRESS_ACQUIRE_MS: '750',
            EGRESS_RECOVERY_MS: '1500',
            EGRESS_RECOVERY_BATCH: '128',
            EGRESS_HEALTH_PORT: '9466',
            EGRESS_MAX_ERRORS: '7',
            CORE_DB_TIMEOUT_MS: '12000',
            MARKET_DB_TIMEOUT_MS: '6000',
            JWT_SECRET: secret,
        } as NodeJS.ProcessEnv);

        expect(parsed).toMatchObject({
            CORE_DB_POOL_MAX: 18,
            CORE_DB_POOL_MIN: 2,
            MARKET_DB_POOL_MAX: 7,
            MARKET_DB_POOL_MIN: 1,
            EGRESS_DB_POOL_MAX: 5,
            EGRESS_DB_POOL_MIN: 1,
            EGRESS_ACQUIRE_MS: 750,
            EGRESS_RECOVERY_MS: 1500,
            EGRESS_RECOVERY_BATCH: 128,
            EGRESS_HEALTH_PORT: 9466,
            EGRESS_MAX_ERRORS: 7,
            CORE_DB_TIMEOUT_MS: 12000,
            MARKET_DB_TIMEOUT_MS: 6000,
        });
    });

    it('keeps common pool settings as a bounded compatibility fallback', () => {
        const parsed = parseEnv({
            NODE_ENV: 'test',
            CORE_DATABASE_URL: 'postgres://core/fervor',
            MARKET_DATABASE_URL: 'postgres://market/fervor',
            DB_POOL_MAX: '12',
            DB_POOL_MIN: '1',
            JWT_SECRET: secret,
        } as NodeJS.ProcessEnv);

        expect(parsed.CORE_DB_POOL_MAX).toBe(12);
        expect(parsed.MARKET_DB_POOL_MAX).toBe(12);
        expect(parsed.CORE_DB_POOL_MIN).toBe(1);
        expect(parsed.MARKET_DB_POOL_MIN).toBe(1);
        expect(parsed.EGRESS_DB_POOL_MAX).toBe(4);
        expect(parsed.EGRESS_DB_POOL_MIN).toBe(0);
    });

    it('rejects invalid per-plane connection budgets', () => {
        expect(() => parseEnv({
            NODE_ENV: 'test',
            CORE_DATABASE_URL: 'postgres://core/fervor',
            MARKET_DATABASE_URL: 'postgres://market/fervor',
            CORE_DB_POOL_MAX: '4',
            CORE_DB_POOL_MIN: '5',
            JWT_SECRET: secret,
        } as NodeJS.ProcessEnv)).toThrow(/CORE_DB_POOL_MIN cannot exceed CORE_DB_POOL_MAX/);

        expect(() => parseEnv({
            NODE_ENV: 'test',
            CORE_DATABASE_URL: 'postgres://core/fervor',
            MARKET_DATABASE_URL: 'postgres://market/fervor',
            MARKET_DB_POOL_MAX: '4',
            MARKET_DB_POOL_MIN: '5',
            JWT_SECRET: secret,
        } as NodeJS.ProcessEnv)).toThrow(/MARKET_DB_POOL_MIN cannot exceed MARKET_DB_POOL_MAX/);

        expect(() => parseEnv({
            NODE_ENV: 'test',
            CORE_DATABASE_URL: 'postgres://core/fervor',
            MARKET_DATABASE_URL: 'postgres://market/fervor',
            EGRESS_DB_POOL_MAX: '2',
            EGRESS_DB_POOL_MIN: '3',
            JWT_SECRET: secret,
        } as NodeJS.ProcessEnv)).toThrow(/EGRESS_DB_POOL_MIN cannot exceed EGRESS_DB_POOL_MAX/);
    });

    it('rejects ambiguous or malformed database URLs', () => {
        const base = {
            NODE_ENV: 'test',
            MARKET_DATABASE_URL: 'postgres://market/fervor',
            JWT_SECRET: secret,
        } as NodeJS.ProcessEnv;

        expect(() => parseEnv({
            ...base,
            CORE_DATABASE_URL: 'https://core/fervor',
        })).toThrow(/must use postgres or postgresql/);
        expect(() => parseEnv({
            ...base,
            CORE_DATABASE_URL: 'postgres://core',
        })).toThrow(/must name a database/);
        expect(() => parseEnv({
            ...base,
            CORE_DATABASE_URL: 'postgres://core/fervor?sslmode=disable',
        })).toThrow(/Database URL TLS parameters are not allowed/);
        expect(() => parseEnv({
            ...base,
            CORE_DATABASE_URL: 'postgres://core/fervor?host=other',
        })).toThrow(/Database URL query parameters are not allowed/);
    });

    it('fails closed on production co-location and implicit plane URLs', () => {
        const base = {
            NODE_ENV: 'production',
            JWT_SECRET: secret,
            REDIS_URL: 'redis://redis:6379',
        } as NodeJS.ProcessEnv;

        expect(() => parseEnv({
            ...base,
            DATABASE_URL: 'postgres://db/fervor',
            DB_COLOCATED: 'true',
        })).toThrow(/Production runtime cannot use DB_COLOCATED=true/);

        expect(() => parseEnv({
            ...base,
            DATABASE_URL: 'postgres://db/fervor',
        })).toThrow(/Production runtime requires explicit CORE_DATABASE_URL and MARKET_DATABASE_URL/);

        expect(() => parseEnv({
            ...base,
            CORE_DATABASE_URL: 'postgres://db/fervor',
            MARKET_DATABASE_URL: 'postgres://db/fervor',
        })).toThrow(/Production runtime requires distinct core and market database endpoints/);

        expect(() => parseEnv({
            ...base,
            CORE_DATABASE_URL: 'postgres://db.example/fervor_core',
            MARKET_DATABASE_URL: 'postgres://db.example./fervor_market',
        })).toThrow(/Production runtime requires distinct core and market database endpoints/);

        expect(() => parseEnv({
            ...base,
            CORE_DATABASE_URL: 'postgres://db/core',
            MARKET_DATABASE_URL: 'postgres://db/market',
        })).toThrow(/Production runtime requires distinct core and market database endpoints/);

        expect(() => parseEnv({
            ...base,
            CORE_DATABASE_URL: 'postgres://core/fervor',
            MARKET_DATABASE_URL: 'postgres://market/fervor',
            DB_SSL_MODE: 'require',
        })).toThrow(/Production runtime requires DB_SSL_MODE=verify-full/);
    });
});
