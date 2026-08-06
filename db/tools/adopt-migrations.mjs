import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { catalogProof, dataViolations, hasHistory, publicRelations } from './catalog-proof.mjs';
import { recordBaseline } from './flyway-history.mjs';
import { runFlyway } from './flyway-runner.mjs';
import { sourceFor, toJdbc, toPg } from './migration-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envName = process.env.MIGRATION_ENV_FILE;
if (envName) {
    const envFile = path.isAbsolute(envName) ? envName : path.join(root, envName);
    if (!fs.existsSync(envFile)) throw new Error(`MIGRATION_ENV_FILE does not exist: ${envFile}`);
    loadEnvFile(envFile);
}

const args = process.argv.slice(2);
const planeArgs = args.filter((arg) => arg.startsWith('--plane='));
const plane = planeArgs[0]?.slice('--plane='.length);
const inspect = args.includes('--inspect');
const apply = args.includes('--apply');
const unknown = args.filter((arg) => !['--inspect', '--apply'].includes(arg) && !arg.startsWith('--plane='));
if (unknown.length > 0) throw new Error(`Unknown adoption option: ${unknown.join(', ')}`);
if (!['core', 'market'].includes(plane)) throw new Error('--plane=core or --plane=market is required');
if (planeArgs.length !== 1) throw new Error('Adoption requires exactly one migration plane');
if (inspect === apply) throw new Error('Choose exactly one of --inspect or --apply');

const timeoutMs = Number(process.env.MIGRATION_TIMEOUT_MS ?? 600_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
    throw new Error('MIGRATION_TIMEOUT_MS must be an integer from 1000 to 3600000');
}

const name = plane.toUpperCase();
const source = sourceFor(plane, process.env, true);
const client = new pg.Client({
    ...toPg(source, name),
    application_name: `fervor-adopt-${plane}`,
    connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
    query_timeout: timeoutMs,
});

const assertOffline = () => {
    if (process.env.MIGRATION_OFFLINE !== 'true') {
        throw new Error('MIGRATION_OFFLINE=true is required for controlled adoption');
    }
};

const prove = async () => {
    if (await hasHistory(client, plane)) throw new Error(`${plane} Flyway history already exists`);
    const relations = await publicRelations(client);
    if (relations.length === 0) throw new Error('Public schema is empty; use the normal migration runner');
    const proof = await catalogProof(client);
    const violations = await dataViolations(client, root, plane);
    if (violations.length > 0) {
        const detail = violations.map((item) => `${item.check_name}=${item.violations}`).join(', ');
        throw new Error(`Legacy data proof failed: ${detail}`);
    }
    return { ...proof, relations: relations.length };
};

const acquireLock = async () => {
    const lockId = plane === 'core' ? 1 : 2;
    const waitMs = Math.min(timeoutMs, 60_000);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        const result = await client.query('SELECT pg_try_advisory_xact_lock(1937006964, $1) AS acquired', [lockId]);
        if (result.rows[0].acquired) return;
        await client.query('SELECT pg_sleep(0.1)');
    }
    throw new Error(`${plane} migration lock was not available within ${waitMs} ms`);
};

let activeTx = false;
let committed = false;
let connected = false;
try {
    await client.connect();
    connected = true;
    await client.query(`SET statement_timeout = '${timeoutMs}ms'`);
    await client.query("SET idle_in_transaction_session_timeout = '6min'");

    if (inspect) {
        await client.query('BEGIN READ ONLY');
        activeTx = true;
        await client.query('SET LOCAL search_path = pg_catalog, public');
        const proof = await prove();
        await client.query('COMMIT');
        activeTx = false;
        console.log(JSON.stringify({ plane, ...proof }));
    } else {
        assertOffline();
        const expected = process.env[`${name}_LEGACY_CATALOG_SHA256`]?.toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(expected ?? '')) {
            throw new Error(`${name}_LEGACY_CATALOG_SHA256 must be an approved 64-character digest`);
        }
        const changeId = process.env.MIGRATION_CHANGE_ID;
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{2,79}$/.test(changeId ?? '')) {
            throw new Error('MIGRATION_CHANGE_ID must identify the approved change record');
        }

        await client.query('BEGIN');
        activeTx = true;
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '5min'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '6min'");
        await client.query('SET LOCAL search_path = pg_catalog, public');
        await acquireLock();
        const locks = await client.query(`
            SELECT format('%I.%I', n.nspname, c.relname) AS name
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public'
               AND c.relkind IN ('r', 'p', 'm', 'f')
             ORDER BY c.oid
        `);
        if (locks.rows.length === 0) throw new Error('No application tables exist; use the normal migration runner');
        await client.query(`LOCK TABLE ${locks.rows.map((row) => row.name).join(', ')} IN ACCESS EXCLUSIVE MODE`);

        const proof = await prove();
        const matches = timingSafeEqual(Buffer.from(proof.digest, 'hex'), Buffer.from(expected, 'hex'));
        if (!matches) throw new Error(`Legacy catalog digest mismatch: received ${proof.digest}`);

        await recordBaseline(client, plane, proof.digest);
        await client.query('COMMIT');
        activeTx = false;
        committed = true;
        const target = toJdbc(source, name);
        await runFlyway({ root, plane, target, command: 'validate', timeoutMs });
        console.log(`migration adoption: ${plane} baseline 001 recorded for ${changeId} with ${proof.digest}`);
    }
} catch (error) {
    if (activeTx) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // The original adoption failure is authoritative.
        }
    }
    if (committed) {
        throw new Error(`Baseline committed for ${plane}, but Flyway validation failed: ${error.message}`, { cause: error });
    }
    throw error;
} finally {
    if (connected) await client.end();
}
