import pg from 'pg';
import { sourceFor, toPg } from '../../db/tools/migration-config.mjs';
import { assertPlaneSplit } from '../../db/tools/plane-split.mjs';

const timeoutMs = Number(process.env.MIGRATION_CHECK_TIMEOUT_MS ?? 30_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error('MIGRATION_CHECK_TIMEOUT_MS must be an integer from 1000 to 300000');
}

const planes = {
    core: 'fervor_core_meta.fervor_core_history',
    market: 'fervor_market_meta.fervor_market_history',
};
const colocated = process.env.MIGRATION_COLOCATED === 'true';
const production = process.env.MIGRATION_ENV === 'production' || process.env.NODE_ENV === 'production';
if (colocated && production) throw new Error('Production migration checks cannot accept colocated planes');

const connect = async (plane) => {
    const name = plane.toUpperCase();
    const source = sourceFor(plane, process.env, true);
    const client = new pg.Client({
        ...toPg(source, name),
        application_name: `fervor-history-check-${plane}`,
        connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
        query_timeout: timeoutMs,
    });
    let connected = false;
    try {
        await client.connect();
        connected = true;
        await client.query(`SET statement_timeout = '${timeoutMs}ms'`);
        return client;
    } catch (error) {
        if (connected) await client.end();
        throw error;
    }
};

const verifyHistory = async (client, plane) => {
    const table = planes[plane];
    const result = await client.query(`
        SELECT installed_rank, version, type, success
          FROM ${table}
         ORDER BY installed_rank
    `);
    if (result.rows.some((row) => !row.success)) throw new Error(`${table} contains a failed migration`);
    const versioned = result.rows.filter((row) => row.version !== null);
    if (versioned.length === 0) throw new Error(`${table} has no versioned migration`);
    if (versioned[0].version !== '001' || !['SQL', 'BASELINE'].includes(versioned[0].type)) {
        throw new Error(`${table} does not start with SQL or BASELINE version 001`);
    }
    if (versioned.slice(1).some((row) => row.type !== 'SQL')) {
        throw new Error(`${table} contains a later non-SQL versioned migration`);
    }
};

const core = await connect('core');
try {
    const market = await connect('market');
    try {
        if (!colocated) await assertPlaneSplit(core, market);
        await verifyHistory(core, 'core');
        const schema = await core.query(`
            SELECT to_regclass('public.users') AS users,
                   to_regclass('public.trade_executions') AS executions,
                   to_regclass('public.event_outbox') AS outbox
        `);
        if (Object.values(schema.rows[0]).some((value) => value === null)) {
            throw new Error('Core baseline schema is incomplete');
        }
        await verifyHistory(market, 'market');
    } finally {
        await market.end();
    }
} finally {
    await core.end();
}

console.log(`migration db: ${colocated ? 'development-colocated' : 'split-plane'} histories and core baseline verified`);
