import { Pool } from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { env } from './env';
import { metrics } from '../services/metrics';

export type DbPlane = 'core' | 'market' | 'egress';
export type DbQuery = <T extends QueryResultRow = any>(
    text: string,
    params?: unknown[]
) => Promise<QueryResult<T>>;

export interface DbStats {
    total: number;
    idle: number;
    waiting: number;
    max: number;
    min: number;
}

export interface Database {
    readonly plane: DbPlane;
    query: DbQuery;
    getClient: () => Promise<PoolClient>;
    transaction: <T>(work: (db: DbQuery) => Promise<T>) => Promise<T>;
    stats: () => DbStats;
    close: () => Promise<void>;
}

interface DatabaseOptions {
    plane: DbPlane;
    url: string;
    max: number;
    min: number;
    timeoutMs: number;
    connectMs?: number;
}

const ssl = env.DB_SSL_MODE === 'disable' ? false : {
    rejectUnauthorized: env.DB_SSL_MODE === 'verify-full',
    ...(env.DB_SSL_CA ? { ca: env.DB_SSL_CA.replace(/\\n/g, '\n') } : {}),
};

const createDatabase = (
    { plane, url, max, min, timeoutMs, connectMs }: DatabaseOptions
): { db: Database; pool: Pool } => {
    const pool = new Pool({
        connectionString: url,
        ssl,
        max,
        min,
        idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
        connectionTimeoutMillis: connectMs ?? env.DB_CONNECT_TIMEOUT_MS,
        statement_timeout: timeoutMs,
        application_name: `fervor-${plane}-${process.pid}`,
    });

    pool.on('error', (error) => {
        metrics.increment('fervor_db_pool_errors', { plane });
        console.error('[database] Idle client error', {
            plane,
            name: error.name,
            message: error.message,
        });
    });

    const query: DbQuery = async (text, params) => {
        const started = process.hrtime.bigint();
        try {
            const result = await pool.query(text, params);
            const duration = Number(process.hrtime.bigint() - started) / 1_000_000;
            metrics.observe('fervor_db_query_duration_ms', duration, { plane, outcome: 'ok' });
            metrics.increment('fervor_db_queries', { plane });
            if (env.DB_LOG_QUERIES) {
                console.log('[database] Executed query', {
                    plane,
                    text,
                    duration,
                    rows: result.rowCount,
                });
            }
            return result;
        } catch (error) {
            const duration = Number(process.hrtime.bigint() - started) / 1_000_000;
            metrics.observe('fervor_db_query_duration_ms', duration, { plane, outcome: 'error' });
            metrics.increment('fervor_db_query_errors', { plane });
            console.error('[database] Query error', {
                plane,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    };

    const transaction = async <T>(work: (db: DbQuery) => Promise<T>): Promise<T> => {
        const client = await pool.connect();
        const db: DbQuery = (text, params) => client.query(text, params);
        let discard = false;
        try {
            await client.query('BEGIN');
            const result = await work(db);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                discard = true;
                metrics.increment('fervor_db_rollback_errors', { plane });
                console.error('[database] Rollback failed', {
                    plane,
                    error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                });
            }
            throw error;
        } finally {
            client.release(discard);
        }
    };

    return {
        pool,
        db: {
            plane,
            query,
            getClient: () => pool.connect(),
            transaction,
            stats: () => ({
                total: pool.totalCount,
                idle: pool.idleCount,
                waiting: pool.waitingCount,
                max,
                min,
            }),
            close: () => pool.end(),
        },
    };
};

const core = createDatabase({
    plane: 'core',
    url: env.CORE_DATABASE_URL,
    max: env.CORE_DB_POOL_MAX,
    min: env.CORE_DB_POOL_MIN,
    timeoutMs: env.CORE_DB_TIMEOUT_MS,
});

const market = createDatabase({
    plane: 'market',
    url: env.MARKET_DATABASE_URL,
    max: env.MARKET_DB_POOL_MAX,
    min: env.MARKET_DB_POOL_MIN,
    timeoutMs: env.MARKET_DB_TIMEOUT_MS,
});

const egress = createDatabase({
    plane: 'egress',
    url: env.CORE_DATABASE_URL,
    max: env.EGRESS_DB_POOL_MAX,
    min: env.EGRESS_DB_POOL_MIN,
    timeoutMs: env.CORE_DB_TIMEOUT_MS,
    connectMs: Math.min(env.DB_CONNECT_TIMEOUT_MS, env.EGRESS_ACQUIRE_MS),
});

export const coreDb = core.db;
export const marketDb = market.db;
export const egressDb = egress.db;

// Existing repositories remain on the core plane until their market tables are
// migrated and backfilled. New code should select a plane explicitly.
export const query = coreDb.query;
export const getClient = coreDb.getClient;
export const transaction = coreDb.transaction;

export const poolStats = (): Record<DbPlane, DbStats> => ({
    core: coreDb.stats(),
    market: marketDb.stats(),
    egress: egressDb.stats(),
});

export const closeDatabase = async (): Promise<void> => {
    const results = await Promise.allSettled([coreDb.close(), marketDb.close(), egressDb.close()]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
};

// Preserve the pre-plane default export for any external consumer that used
// the node-postgres Pool contract. Named repositories remain pinned above.
export default core.pool;
