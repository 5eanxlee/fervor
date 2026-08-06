import { describe, expect, it } from 'vitest';
import { createRetentionDb, loadRetention } from '../src/config/retention';

describe('retention config', () => {
    it('bounds worker batch and timing controls', () => {
        expect(loadRetention({ RETENTION_BATCH: '1000' })).toMatchObject({
            batch: 1000,
            batchMs: 15_000,
            intervalMs: 30_000,
        });
        expect(() => loadRetention({ RETENTION_BATCH: '1001' })).toThrow(/between 1 and 1000/);
        expect(() => loadRetention({ RETENTION_BATCH_MS: '999' })).toThrow(/between 1000 and 60000/);
    });

    it('rejects production URL credentials and TLS downgrades', () => {
        const config = loadRetention({});
        expect(() => createRetentionDb(config, {
            NODE_ENV: 'production',
            MAINT_DATABASE_URL: 'postgresql://maintenance@core.example/fervor',
            MAINT_DB_SSL_MODE: 'verify-full',
        })).toThrow(/discrete maintenance database fields/);
        expect(() => createRetentionDb(config, {
            NODE_ENV: 'production',
            MAINT_DB_SSL_MODE: 'disable',
        })).toThrow(/requires MAINT_DB_SSL_MODE=verify-full/);
    });

    it('rejects connection-string option injection in development', () => {
        const config = loadRetention({});
        expect(() => createRetentionDb(config, {
            NODE_ENV: 'development',
            MAINT_DATABASE_URL: 'postgresql://fervor@localhost/fervor?sslmode=disable',
        })).toThrow(/query-free PostgreSQL database URL/);
    });
});
