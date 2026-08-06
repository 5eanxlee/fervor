import fs from 'node:fs';
import tls from 'node:tls';
import pg from 'pg';
import { assertPlaneSplit } from './plane-split.mjs';

const timeoutSec = Number(process.env.MIGRATION_TIMEOUT_SEC);
if (!Number.isSafeInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 3600) {
    throw new Error('MIGRATION_TIMEOUT_SEC must be an integer from 1 to 3600');
}
const timeoutMs = timeoutSec * 1000;
const deadline = setTimeout(() => {
    process.stderr.write('PostgreSQL split-plane preflight exceeded its deadline\n');
    process.exit(70);
}, timeoutMs);

const field = (plane, key, pattern, max) => {
    const name = `${plane.toUpperCase()}_DB_${key}`;
    const value = process.env[name] ?? '';
    if (!pattern.test(value) || value.length > max) throw new Error(`${name} is invalid`);
    return value;
};

const secret = (file, name) => {
    const value = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    if (!value || /[\u0000\r\n]/.test(value)) throw new Error(`${name} secret is missing or invalid`);
    return value;
};

const ca = (file, name) => {
    const value = fs.readFileSync(file, 'utf8');
    if (!value.includes('-----BEGIN CERTIFICATE-----') || /\u0000/.test(value)) {
        throw new Error(`${name} CA is missing or invalid`);
    }
    return value;
};

const config = (plane) => {
    const portText = field(plane, 'PORT', /^[1-9][0-9]{0,4}$/, 5);
    const port = Number(portText);
    if (port > 65535) throw new Error(`${plane.toUpperCase()}_DB_PORT is outside 1..65535`);
    const caFile = `/run/secrets/${plane}_db_ca`;
    const host = field(plane, 'HOST', /^(?![.-])(?!.*(?:\.\.|\.-|-\.))[A-Za-z0-9.-]+(?<![.-])$/, 253);
    return {
        host,
        port,
        database: field(plane, 'NAME', /^[A-Za-z0-9_-]+$/, 63),
        user: field(plane, 'USER', /^[A-Za-z0-9_-]+$/, 63),
        password: secret(`/run/secrets/${plane}_db_password`, `${plane} database password`),
        ssl: {
            ca: ca(caFile, `${plane} database`),
            rejectUnauthorized: true,
            checkServerIdentity: (_name, cert) => tls.checkServerIdentity(host, cert),
        },
        application_name: `fervor-plane-split-${plane}`,
        connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
        query_timeout: timeoutMs,
    };
};

const clients = [new pg.Client(config('core')), new pg.Client(config('market'))];
const connected = [];
const failures = [];
try {
    const attempts = await Promise.allSettled(clients.map((client) => client.connect()));
    for (let index = 0; index < attempts.length; index += 1) {
        if (attempts[index].status === 'fulfilled') connected.push(clients[index]);
    }
    failures.push(...attempts.filter((item) => item.status === 'rejected').map((item) => item.reason));
    if (failures.length === 0) {
        await Promise.all(clients.map((client) => client.query(`SET statement_timeout = '${timeoutMs}ms'`)));
        await assertPlaneSplit(clients[0], clients[1]);
        console.log('migration split: distinct PostgreSQL clusters verified');
    }
} catch (error) {
    failures.push(error);
} finally {
    clearTimeout(deadline);
    const cleanup = await Promise.allSettled(connected.map((client) => client.end()));
    failures.push(...cleanup.filter((item) => item.status === 'rejected').map((item) => item.reason));
}
if (failures.length > 0) throw new AggregateError(failures, 'PostgreSQL split-plane preflight failed');
