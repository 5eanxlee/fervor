import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { catalogProof } from '../../db/tools/catalog-proof.mjs';
import { runProc } from '../../db/tools/flyway-runner.mjs';

const source = process.env.DATABASE_URL;
if (!source) throw new Error('DATABASE_URL is required');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const suffix = `${process.pid}_${randomBytes(4).toString('hex')}`;
const baseName = `fervor_legacy_${suffix}`;
const adminUrl = new URL(source);
adminUrl.pathname = '/postgres';
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const databases = [];

const databaseUrl = (name) => {
    const value = new URL(source);
    value.pathname = `/${name}`;
    return value.toString();
};
const migrationEnv = (name, extra = {}) => {
    const env = {
        ...process.env,
        MIGRATION_OFFLINE: 'true',
        MIGRATION_COLOCATED: 'true',
        ...extra,
        CORE_DATABASE_URL: databaseUrl(name),
    };
    delete env.CORE_FLYWAY_URL;
    return env;
};
const runNode = (script, args, env, capture = false) => runProc(process.execPath, [script, ...args], {
    cwd: root,
    env,
    capture,
    timeoutMs: Number(process.env.MIGRATION_TIMEOUT_MS ?? 600_000) + 60_000,
    graceMs: 10_000,
});
const createDatabase = async (name, template) => {
    databases.push(name);
    const suffixSql = template ? ` TEMPLATE "${template}"` : '';
    await admin.query(`CREATE DATABASE "${name}"${suffixSql}`);
};
const withDatabase = async (name, work) => {
    const client = new pg.Client({ connectionString: databaseUrl(name) });
    await client.connect();
    try {
        return await work(client);
    } finally {
        await client.end();
    }
};

await admin.connect();
try {
    await createDatabase(baseName);
    const baselineSql = fs.readFileSync(path.join(root, 'db/core/migrations/V001__baseline.sql'), 'utf8');
    const expected = await withDatabase(baseName, async (client) => {
        await client.query('BEGIN');
        try {
            await client.query(baselineSql);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        return catalogProof(client);
    });

    const driftCases = [
        {
            name: 'wrong_index',
            sql: 'DROP INDEX idx_users_wallet_address; CREATE INDEX idx_users_wallet_address ON users(email)',
        },
        {
            name: 'wrong_type',
            sql: 'ALTER TABLE token_data ALTER COLUMN name TYPE text',
        },
        {
            name: 'wrong_default',
            sql: 'ALTER TABLE token_data ALTER COLUMN last_updated DROP DEFAULT',
        },
        {
            name: 'wrong_nullability',
            sql: 'ALTER TABLE token_alerts ALTER COLUMN token_address DROP NOT NULL',
        },
        {
            name: 'missing_constraint',
            sql: 'ALTER TABLE token_alerts DROP CONSTRAINT token_alerts_threshold_type_check',
        },
        {
            name: 'missing_partition',
            sql: 'DROP TABLE candle_projection_events_31',
        },
        {
            name: 'wrong_replica_identity',
            sql: 'ALTER TABLE token_data REPLICA IDENTITY FULL',
        },
        {
            name: 'relation_acl',
            sql: 'GRANT SELECT ON token_data TO PUBLIC',
        },
        {
            name: 'column_acl',
            sql: 'GRANT SELECT (name) ON token_data TO PUBLIC',
        },
        {
            name: 'function_acl',
            sql: 'REVOKE EXECUTE ON FUNCTION update_updated_at_column() FROM PUBLIC',
        },
        {
            name: 'default_acl',
            sql: 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC',
        },
        {
            name: 'wrong_parent',
            sql: 'ALTER TABLE candle_projection_events DETACH PARTITION candle_projection_events_31',
        },
        {
            name: 'extra_relation',
            sql: 'CREATE TABLE unexpected_legacy_table (id bigint PRIMARY KEY)',
        },
    ];

    for (const drift of driftCases) {
        const name = `${baseName}_${drift.name}`;
        await createDatabase(name, baseName);
        await withDatabase(name, (client) => client.query(drift.sql));
        const result = await runNode('db/tools/adopt-migrations.mjs', ['--plane=core', '--apply'], migrationEnv(name, {
            CORE_LEGACY_CATALOG_SHA256: expected.digest,
            MIGRATION_CHANGE_ID: `ci-${drift.name}`,
        }), true);
        if (result.code === 0 || !result.stderr.includes('Legacy catalog digest mismatch')) {
            throw new Error(`Legacy drift was not rejected: ${drift.name}`);
        }
        await withDatabase(name, async (client) => {
            const history = await client.query("SELECT to_regclass('fervor_core_meta.fervor_core_history') AS name");
            if (history.rows[0].name !== null) throw new Error(`Rejected drift committed history: ${drift.name}`);
        });
    }

    const dataName = `${baseName}_data_drift`;
    await createDatabase(dataName, baseName);
    await withDatabase(dataName, (client) => client.query("INSERT INTO users (email) VALUES ('missing@example.com')"));
    const dataResult = await runNode('db/tools/adopt-migrations.mjs', ['--plane=core', '--apply'], migrationEnv(dataName, {
        CORE_LEGACY_CATALOG_SHA256: expected.digest,
        MIGRATION_CHANGE_ID: 'ci-data-drift',
    }), true);
    if (dataResult.code === 0 || !dataResult.stderr.includes('Legacy data proof failed')) {
        throw new Error('Legacy data drift was not rejected');
    }
    await withDatabase(dataName, async (client) => {
        const history = await client.query("SELECT to_regclass('fervor_core_meta.fervor_core_history') AS name");
        if (history.rows[0].name !== null) throw new Error('Rejected data drift committed history');
    });

    const normalName = `${baseName}_normal_reject`;
    await createDatabase(normalName, baseName);
    const normal = await runNode('db/tools/run-migrations.mjs', ['--plane=core'], migrationEnv(normalName), true);
    if (normal.code === 0 || !`${normal.stdout}\n${normal.stderr}`.includes('V001 requires an empty public schema')) {
        throw new Error('Normal V1 migration did not reject the populated legacy schema');
    }

    const adoption = await runNode('db/tools/adopt-migrations.mjs', ['--plane=core', '--apply'], migrationEnv(baseName, {
        CORE_LEGACY_CATALOG_SHA256: expected.digest,
        MIGRATION_CHANGE_ID: 'ci-verified-adoption',
    }));
    if (adoption.code !== 0) throw new Error(`Verified legacy adoption failed with ${adoption.signal ?? adoption.code}`);

    await withDatabase(baseName, async (client) => {
        const history = await client.query(`
            SELECT installed_rank, version, description, type, script,
                   checksum, installed_by, execution_time, success
              FROM fervor_core_meta.fervor_core_history
             ORDER BY installed_rank
        `);
        if (history.rowCount !== 2) throw new Error('Controlled baseline history row count is wrong');
        const [baseline, schema] = history.rows;
        if (baseline.installed_rank !== 1 || baseline.version !== '001'
            || baseline.description !== `verified_legacy_${expected.digest.slice(0, 12)}`
            || baseline.type !== 'BASELINE' || baseline.script !== baseline.description
            || baseline.checksum !== null || baseline.execution_time !== 0 || !baseline.success) {
            throw new Error('Controlled baseline row is not Flyway-compatible');
        }
        if (schema.installed_rank !== 2 || schema.version !== null
            || schema.description !== '<< Flyway Schema Creation >>' || schema.type !== 'SCHEMA'
            || schema.script !== '"fervor_core_meta"' || schema.checksum !== null
            || schema.execution_time !== 0 || !schema.success
            || schema.installed_by !== baseline.installed_by) {
            throw new Error('Controlled schema marker is not Flyway-compatible');
        }
        const indexes = await client.query(`
            SELECT indexname
              FROM pg_indexes
             WHERE schemaname = 'fervor_core_meta'
               AND tablename = 'fervor_core_history'
             ORDER BY indexname
        `);
        if (JSON.stringify(indexes.rows.map((row) => row.indexname))
            !== JSON.stringify(['fervor_core_history_pk', 'fervor_core_history_s_idx'])) {
            throw new Error('Controlled Flyway history indexes are incomplete');
        }
    });

    const repeat = await runNode('db/tools/run-migrations.mjs', ['--plane=core'], migrationEnv(baseName));
    if (repeat.code !== 0) throw new Error(`Post-adoption migration failed with ${repeat.signal ?? repeat.code}`);
} finally {
    for (const database of databases.reverse()) {
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [database]);
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    }
    await admin.end();
}

console.log('migration legacy: guarded adoption and catalog/data drift rejection verified');
