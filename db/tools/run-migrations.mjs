import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runFlyway } from './flyway-runner.mjs';
import { sourceFor, toJdbc, toPg } from './migration-config.mjs';
import { assertPlaneSplit } from './plane-split.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envName = process.env.MIGRATION_ENV_FILE;
if (envName) {
    const envFile = path.isAbsolute(envName) ? envName : path.join(root, envName);
    if (!fs.existsSync(envFile)) throw new Error(`MIGRATION_ENV_FILE does not exist: ${envFile}`);
    loadEnvFile(envFile);
}

const args = process.argv.slice(2);
const planeArgs = args.filter((arg) => arg.startsWith('--plane='));
const plane = planeArgs[0]?.slice('--plane='.length) ?? 'all';
const validateOnly = args.includes('--validate-only');
const unknown = args.filter((arg) => arg !== '--validate-only' && !arg.startsWith('--plane='));

if (unknown.length > 0) throw new Error(`Unknown migration option: ${unknown.join(', ')}`);
if (!['all', 'core', 'market'].includes(plane)) throw new Error(`Unknown migration plane: ${plane}`);
if (planeArgs.length > 1) throw new Error('Migration plane may be provided only once');
if (args.filter((arg) => arg === '--validate-only').length > 1) {
    throw new Error('--validate-only may be provided only once');
}

const timeoutMs = Number(process.env.MIGRATION_TIMEOUT_MS ?? 3_600_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
    throw new Error('MIGRATION_TIMEOUT_MS must be an integer from 1000 to 3600000');
}

const planes = plane === 'all' ? ['core', 'market'] : [plane];
const targets = new Map(planes.map((item) => {
    const name = item.toUpperCase();
    return [item, toJdbc(sourceFor(item), name)];
}));

const colocated = process.env.MIGRATION_COLOCATED === 'true';
const production = process.env.MIGRATION_ENV === 'production' || process.env.NODE_ENV === 'production';
if (colocated && production) throw new Error('Production migrations cannot use MIGRATION_COLOCATED=true');
const flywayConfig = (item) => production && item === 'core'
    ? '/flyway/db/flyway/core.conf,/flyway/db/flyway/core-production.conf'
    : undefined;

const verifySplit = async () => {
    if (colocated) return;
    const clients = ['core', 'market'].map((item) => new pg.Client({
        ...toPg(sourceFor(item, process.env, true), item.toUpperCase()),
        application_name: `fervor-migration-split-${item}`,
        connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
        query_timeout: timeoutMs,
    }));
    const connected = [];
    const failures = [];
    try {
        const attempts = await Promise.allSettled(clients.map((client) => client.connect()));
        for (let index = 0; index < attempts.length; index += 1) {
            if (attempts[index].status === 'fulfilled') connected.push(clients[index]);
            else failures.push(attempts[index].reason);
        }
        if (failures.length === 0) {
            await Promise.all(clients.map((client) => client.query(`SET statement_timeout = '${timeoutMs}ms'`)));
            await assertPlaneSplit(clients[0], clients[1]);
        }
    } catch (error) {
        failures.push(error);
    }
    const cleanup = await Promise.allSettled(connected.map((client) => client.end()));
    failures.push(...cleanup.filter((item) => item.status === 'rejected').map((item) => item.reason));
    if (failures.length > 0) throw new AggregateError(failures, 'PostgreSQL split-plane preflight failed');
};

// Preflight every selected plane before any schema can advance.
await verifySplit();
for (const item of planes) {
    await runFlyway({
        root, plane: item, target: targets.get(item), command: 'validate', timeoutMs,
        configFiles: flywayConfig(item),
    });
}
if (!validateOnly) {
    for (const item of planes) {
        await runFlyway({
            root, plane: item, target: targets.get(item), command: 'migrate', timeoutMs,
            configFiles: flywayConfig(item),
        });
    }
}
