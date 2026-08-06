import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';

export interface RetentionConfig {
    batch: number;
    batchMs: number;
    intervalMs: number;
    healthPort: number;
    maxErrors: number;
}

export interface RetentionDb {
    getClient: () => Promise<PoolClient>;
    close: () => Promise<void>;
}

const integer = (
    source: NodeJS.ProcessEnv,
    key: string,
    fallback: number,
    min: number,
    max: number
): number => {
    const raw = source[key];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${key} must be an integer between ${min} and ${max}`);
    }
    return value;
};

const required = (source: NodeJS.ProcessEnv, key: string): string => {
    const value = source[key]?.trim();
    if (!value) throw new Error(`${key} is required`);
    return value;
};

const secret = (source: NodeJS.ProcessEnv, key: string): string => {
    const file = required(source, key);
    const value = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    if (!value) throw new Error(`${key} points to an empty file`);
    return value;
};

export const loadRetention = (
    source: NodeJS.ProcessEnv = process.env
): RetentionConfig => ({
    batch: integer(source, 'RETENTION_BATCH', 256, 1, 1000),
    batchMs: integer(source, 'RETENTION_BATCH_MS', 15_000, 1_000, 60_000),
    intervalMs: integer(source, 'RETENTION_INTERVAL_MS', 30_000, 1_000, 300_000),
    healthPort: integer(source, 'RETENTION_HEALTH_PORT', 9466, 1, 65_535),
    maxErrors: integer(source, 'RETENTION_MAX_ERRORS', 5, 1, 100),
});

export const createRetentionDb = (
    config: RetentionConfig,
    source: NodeJS.ProcessEnv = process.env
): RetentionDb => {
    const production = source.NODE_ENV === 'production';
    const url = source.MAINT_DATABASE_URL?.trim();
    if (production && url) {
        throw new Error('Production retention requires discrete maintenance database fields');
    }

    const mode = source.MAINT_DB_SSL_MODE?.trim() || 'disable';
    if (!['disable', 'verify-full'].includes(mode)) {
        throw new Error('MAINT_DB_SSL_MODE must be disable or verify-full');
    }
    if (production && mode !== 'verify-full') {
        throw new Error('Production retention requires MAINT_DB_SSL_MODE=verify-full');
    }
    const ssl = mode === 'verify-full' ? {
        rejectUnauthorized: true,
        ca: secret(source, 'MAINT_DB_CA_FILE'),
    } : false;

    let pool: Pool;
    if (url) {
        const parsed = new URL(url);
        if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
            || !parsed.pathname || parsed.pathname === '/'
            || parsed.search || parsed.hash) {
            throw new Error('MAINT_DATABASE_URL must be a query-free PostgreSQL database URL');
        }
        pool = new Pool({
            connectionString: url,
            ssl,
            max: 1,
            connectionTimeoutMillis: config.batchMs,
            statement_timeout: config.batchMs,
            application_name: `fervor-retention-${process.pid}`,
        });
    } else {
        pool = new Pool({
            host: required(source, 'MAINT_DB_HOST'),
            port: integer(source, 'MAINT_DB_PORT', 5432, 1, 65_535),
            database: required(source, 'MAINT_DB_NAME'),
            user: required(source, 'MAINT_DB_USER'),
            password: secret(source, 'MAINT_DB_PASSWORD_FILE'),
            ssl,
            max: 1,
            connectionTimeoutMillis: config.batchMs,
            statement_timeout: config.batchMs,
            application_name: `fervor-retention-${process.pid}`,
        });
    }
    pool.on('error', (error) => {
        console.error('[blob-retention] Idle database client error', {
            name: error.name,
            message: error.message,
        });
    });
    return {
        getClient: () => pool.connect(),
        close: () => pool.end(),
    };
};
