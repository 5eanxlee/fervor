import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import pg from 'pg';
import { runFlyway } from './flyway-runner.mjs';
import { historyName } from './flyway-history.mjs';
import { sourceFor, toJdbc, toPg } from './migration-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envName = process.env.MIGRATION_ENV_FILE;
if (envName) {
    const envFile = path.isAbsolute(envName) ? envName : path.join(root, envName);
    if (!fs.existsSync(envFile)) throw new Error(`MIGRATION_ENV_FILE does not exist: ${envFile}`);
    loadEnvFile(envFile);
}

const plans = {
    '007': {
        script: 'V007__execution_reconcile_index.sql',
        description: 'execution reconcile index',
        indexes: [
            ['trade_exec_reconcile_due_idx', 'trade_executions'],
        ],
    },
    '008': {
        script: 'V008__observability_indexes.sql',
        description: 'observability indexes',
        indexes: [
            ['event_outbox_failed_idx', 'event_outbox'],
            ['notification_backlog_idx', 'notification_deliveries'],
            ['order_stuck_idx', 'order_intents'],
            ['tokens_observed_idx', 'tokens'],
            ['trade_exec_signed_stuck_idx', 'trade_executions'],
            ['trade_exec_chain_stuck_idx', 'trade_executions'],
            ['trade_exec_recovery_stats_idx', 'trade_executions'],
        ],
    },
    '009': {
        script: 'V009__notification_backlog_index.sql',
        description: 'notification backlog index',
        indexes: [
            ['notification_backlog_idx', 'notification_deliveries'],
        ],
    },
    '010': {
        script: 'V010__order_stuck_index.sql',
        description: 'order stuck index',
        indexes: [
            ['order_stuck_idx', 'order_intents'],
        ],
    },
    '011': {
        script: 'V011__tokens_observed_index.sql',
        description: 'tokens observed index',
        indexes: [
            ['tokens_observed_idx', 'tokens'],
        ],
    },
    '012': {
        script: 'V012__execution_signed_index.sql',
        description: 'execution signed index',
        indexes: [
            ['trade_exec_signed_stuck_idx', 'trade_executions'],
        ],
    },
    '013': {
        script: 'V013__execution_chain_index.sql',
        description: 'execution chain index',
        indexes: [
            ['trade_exec_chain_stuck_idx', 'trade_executions'],
        ],
    },
    '014': {
        script: 'V014__execution_stats_index.sql',
        description: 'execution stats index',
        indexes: [
            ['trade_exec_recovery_stats_idx', 'trade_executions'],
        ],
    },
    '017': {
        script: 'V017__attempt_deadline_index.sql',
        description: 'attempt deadline index',
        indexes: [
            ['action_attempts_deadline_idx', 'action_attempts'],
        ],
    },
    '018': {
        script: 'V018__blob_expiry_index.sql',
        description: 'blob expiry index',
        indexes: [
            ['order_tx_blobs_expiry_idx', 'order_tx_blobs'],
        ],
    },
    '020': {
        script: 'V020__schedule_fill_index.sql',
        description: 'schedule fill index',
        unique: true,
        indexes: [
            ['order_schedules_fill_idx', 'order_schedules'],
        ],
        shapes: {
            order_schedules_fill_idx: {
                keys: ['fill_id'],
                predicate: 'fill_id IS NOT NULL',
            },
        },
    },
    '021': {
        script: 'V021__resolved_anomaly_index.sql',
        description: 'resolved anomaly index',
        indexes: [
            ['order_anomalies_resolved_journal_idx', 'order_anomalies'],
        ],
        shapes: {
            order_anomalies_resolved_journal_idx: {
                keys: ['resolution_journal'],
                predicate: "state::text = 'resolved'::text AND resolution_journal IS NOT NULL",
            },
        },
    },
    '024': {
        script: 'V024__action_provider_due_index.sql',
        description: 'action provider due index',
        plane: 'core',
        unique: false,
        indexes: [
            ['order_actions_provider_due_idx', 'order_actions'],
        ],
        shapes: {
            order_actions_provider_due_idx: {
                keys: ['provider', 'due_at', 'id'],
                predicate: "(work_state::text = ANY (ARRAY['queued'::character varying, 'ready'::character varying, 'reconciling'::character varying]::text[])) AND outcome::text = 'pending'::text AND block_reason IS NULL",
            },
        },
    },
    '025': {
        script: 'V025__action_predecessor_index.sql',
        description: 'action predecessor index',
        plane: 'core',
        unique: false,
        indexes: [
            ['order_actions_predecessor_idx', 'order_actions'],
        ],
        shapes: {
            order_actions_predecessor_idx: {
                keys: ['order_id', 'expected_ver', 'id'],
                predicate: "work_state::text <> 'done'::text",
            },
        },
    },
    '028': {
        script: 'V028__action_fact_index.sql',
        description: 'action fact index',
        plane: 'core',
        unique: true,
        indexes: [
            ['action_obs_fact_idx', 'action_obs'],
        ],
        shapes: {
            action_obs_fact_idx: {
                keys: ['action_id', 'fact_key', 'fact_rev'],
                predicate: 'fact_key IS NOT NULL',
            },
        },
    },
    '029': {
        script: 'V029__action_lineage_index.sql',
        description: 'action lineage index',
        plane: 'core',
        unique: true,
        indexes: [
            ['action_obs_supersedes_idx', 'action_obs'],
        ],
        shapes: {
            action_obs_supersedes_idx: {
                keys: ['supersedes'],
                predicate: 'supersedes IS NOT NULL',
            },
        },
    },
    '038': {
        script: 'V038__order_operation_index.sql',
        description: 'order operation index',
        plane: 'core',
        unique: false,
        indexes: [
            ['order_intents_unknown_op_idx', 'order_intents'],
        ],
        shapes: {
            order_intents_unknown_op_idx: {
                keys: ['provider', 'user_id', 'updated_at', 'id'],
                predicate: "error_code::text = 'provider_outcome_unknown'::text OR op_state::text = 'started'::text",
            },
        },
    },
    '040': {
        script: 'V040__order_operation_cutover_index.sql',
        description: 'order operation cutover index',
        plane: 'core',
        unique: false,
        indexes: [
            ['order_intents_op_cutover_idx', 'order_intents'],
        ],
        shapes: {
            order_intents_op_cutover_idx: {
                keys: ['id'],
                predicate: "op_token IS NOT NULL OR op_lease_until IS NOT NULL OR op_state IS NOT NULL OR error_code::text = 'provider_outcome_unknown'::text",
            },
        },
    },
    '051': {
        script: 'V051__asset_order_circuit_index.sql',
        description: 'asset order circuit index',
        plane: 'core',
        unique: false,
        indexes: [
            ['asset_obligations_order_block_idx', 'asset_obligations'],
        ],
        shapes: {
            asset_obligations_order_block_idx: {
                keys: ['order_id', 'opened_at', 'id'],
                predicate: "(state::text = ANY (ARRAY['open'::character varying, 'review'::character varying]::text[])) AND blocks_actions AND order_id IS NOT NULL",
            },
        },
    },
    '052': {
        script: 'V052__asset_action_circuit_index.sql',
        description: 'asset action circuit index',
        plane: 'core',
        unique: false,
        indexes: [
            ['asset_obligations_action_block_idx', 'asset_obligations'],
        ],
        shapes: {
            asset_obligations_action_block_idx: {
                keys: ['action_id', 'opened_at', 'id'],
                predicate: "(state::text = ANY (ARRAY['open'::character varying, 'review'::character varying]::text[])) AND blocks_actions AND action_id IS NOT NULL",
            },
        },
    },
    '053': {
        script: 'V053__asset_scope_circuit_index.sql',
        description: 'asset scope circuit index',
        plane: 'core',
        unique: false,
        indexes: [
            ['asset_obligations_scope_block_idx', 'asset_obligations'],
        ],
        shapes: {
            asset_obligations_scope_block_idx: {
                keys: ['cluster', 'wallet_address', 'mint', 'opened_at', 'id'],
                predicate: "(state::text = ANY (ARRAY['open'::character varying, 'review'::character varying]::text[])) AND blocks_actions",
            },
        },
    },
    '053.1': {
        script: 'V053_1__asset_order_scope_index.sql',
        description: 'asset order scope index',
        plane: 'core',
        unique: false,
        indexes: [
            ['order_intents_action_scope_idx', 'order_intents'],
        ],
        shapes: {
            order_intents_action_scope_idx: {
                keys: ['cluster', 'wallet_address', 'id'],
                predicate: "state::text = ANY (ARRAY['preparing'::character varying, 'prepared'::character varying, 'activating'::character varying, 'open'::character varying, 'executing'::character varying, 'partially_filled'::character varying, 'cancel_pending'::character varying, 'expired'::character varying]::text[])",
            },
        },
    },
};

const args = process.argv.slice(2);
const planeArgs = args.filter((arg) => arg.startsWith('--plane='));
const versionArgs = args.filter((arg) => arg.startsWith('--version='));
const plane = planeArgs[0]?.slice('--plane='.length);
const version = versionArgs[0]?.slice('--version='.length);
const inspect = args.includes('--inspect');
const apply = args.includes('--apply');
const unknown = args.filter((arg) => !['--inspect', '--apply'].includes(arg)
    && !arg.startsWith('--plane=') && !arg.startsWith('--version='));

if (unknown.length > 0) throw new Error(`Unknown recovery option: ${unknown.join(', ')}`);
if (planeArgs.length !== 1 || plane !== 'core') throw new Error('Recovery requires --plane=core');
if (versionArgs.length !== 1 || !plans[version]) {
    throw new Error(
        'Recovery requires a registered version: 007..014, 017..018, 020..021, 024..025, 028..029, 038, 040, 051..053, or 053.1'
    );
}
if (inspect === apply) throw new Error('Choose exactly one of --inspect or --apply');

const timeoutMs = Number(process.env.MIGRATION_TIMEOUT_MS ?? 3_600_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
    throw new Error('MIGRATION_TIMEOUT_MS must be an integer from 1000 to 3600000');
}

const plan = plans[version];
const source = sourceFor(plane, process.env, true);
const target = toJdbc(source, 'CORE');
const history = historyName(plane);
const client = new pg.Client({
    ...toPg(source, 'CORE'),
    application_name: `fervor-index-recovery-${version}`,
    connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
    query_timeout: timeoutMs,
});

const checksum = (file) => {
    const text = fs.readFileSync(file, 'utf8');
    let value = 0;
    const lines = text.split(/\r\n|[\n\r]/);
    for (let index = 0; index < lines.length; index += 1) {
        let line = lines[index];
        if (index === 0 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
        value = crc32(Buffer.from(line, 'utf8'), value);
    }
    return value | 0;
};

const parseJson = (result, operation) => {
    try {
        return JSON.parse(result.stdout);
    } catch (error) {
        throw new Error(`Flyway ${operation} did not return valid JSON`, { cause: error });
    }
};

const normalizedSql = (value) => String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^\((.*)\)$/s, '$1')
    .trim();

const flywayJson = async (command, extra = []) => {
    const result = await runFlyway({
        root,
        plane,
        target,
        command,
        timeoutMs,
        capture: true,
        extra: ['-outputType=json', ...extra],
    });
    return parseJson(result, command);
};

const validateFailure = async () => {
    const result = await flywayJson('validate');
    const invalid = result.invalidMigrations ?? [];
    const only = invalid[0];
    if (result.validationSuccessful !== false
        || invalid.length !== 1
        || only?.version !== version
        || only?.description !== plan.description
        || only?.errorDetails?.errorCode !== 'FAILED_VERSIONED_MIGRATION') {
        throw new Error('Flyway validation must contain only the selected failed migration; refusing repair');
    }
};

const readState = async () => {
    const failed = await client.query(`
        SELECT installed_rank, version, description, script, checksum, success
          FROM ${history}
         WHERE success = false
         ORDER BY installed_rank
    `);
    if (failed.rowCount !== 1) {
        throw new Error(`Expected exactly one failed migration in ${history}; found ${failed.rowCount}`);
    }
    const row = failed.rows[0];
    if (row.version !== version || row.description !== plan.description || row.script !== plan.script) {
        throw new Error('Failed history row does not match the selected recovery plan');
    }

    const localChecksum = checksum(path.join(root, 'db/core/migrations', plan.script));
    if (row.checksum !== localChecksum) {
        throw new Error(`Failed migration checksum does not match the immutable local script: history=${row.checksum}, local=${localChecksum}`);
    }

    const names = plan.indexes.map(([name]) => name);
    const artifacts = await client.query(`
        SELECT c.relname AS name,
               c.relkind AS kind,
               t.relname AS table_name,
               tn.nspname AS table_schema,
               i.indisvalid,
               i.indisready,
               i.indisunique,
               i.indisprimary,
               ARRAY(
                   SELECT pg_get_indexdef(c.oid, position, true)
                     FROM generate_series(1, i.indnkeyatts) position
                    ORDER BY position
               ) AS index_keys,
               pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
               EXISTS (SELECT 1 FROM pg_constraint x WHERE x.conindid = c.oid) AS constrained
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_index i ON i.indexrelid = c.oid
          LEFT JOIN pg_class t ON t.oid = i.indrelid
          LEFT JOIN pg_namespace tn ON tn.oid = t.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname = ANY($1::text[])
         ORDER BY c.relname
    `, [names]);

    const expected = new Map(plan.indexes);
    const expectsUnique = plan.unique === true;
    for (const artifact of artifacts.rows) {
        const shape = plan.shapes?.[artifact.name];
        if (artifact.kind !== 'i'
            || artifact.table_schema !== 'public'
            || artifact.table_name !== expected.get(artifact.name)
            || artifact.indisunique !== expectsUnique
            || artifact.indisprimary
            || artifact.constrained
            || (shape && (
                JSON.stringify(artifact.index_keys) !== JSON.stringify(shape.keys)
                || normalizedSql(artifact.predicate) !== normalizedSql(shape.predicate)
            ))) {
            throw new Error(`Index artifact ${artifact.name} does not match its reviewed recovery target`);
        }
    }
    return { row, localChecksum, artifacts: artifacts.rows };
};

const acquireLock = async () => {
    const waitMs = Math.min(timeoutMs, 60_000);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        const result = await client.query('SELECT pg_try_advisory_lock(1937006964, 1) AS acquired');
        if (result.rows[0].acquired) return;
        await client.query('SELECT pg_sleep(0.1)');
    }
    throw new Error(`Core migration lock was not available within ${waitMs} ms`);
};

const releaseLock = async () => {
    const result = await client.query('SELECT pg_advisory_unlock(1937006964, 1) AS released');
    if (result.rows[0].released !== true) throw new Error('Core migration lock was not held at release');
};

const verifyFinal = async () => {
    const row = await client.query(`
        SELECT success
          FROM ${history}
         WHERE version = $1
         ORDER BY installed_rank DESC
         LIMIT 1
    `, [version]);
    if (row.rowCount !== 1 || row.rows[0].success !== true) {
        throw new Error(`Migration ${version} was not recorded successfully`);
    }

    const names = plan.indexes.map(([name]) => name);
    const indexes = await client.query(`
        SELECT c.relname AS name, t.relname AS table_name,
               i.indisvalid, i.indisready, i.indisunique,
               ARRAY(
                   SELECT pg_get_indexdef(c.oid, position, true)
                     FROM generate_series(1, i.indnkeyatts) position
                    ORDER BY position
               ) AS index_keys,
               pg_get_expr(i.indpred, i.indrelid, true) AS predicate
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_index i ON i.indexrelid = c.oid
          JOIN pg_class t ON t.oid = i.indrelid
         WHERE n.nspname = 'public'
           AND c.relname = ANY($1::text[])
         ORDER BY c.relname
    `, [names]);
    const expected = new Map(plan.indexes);
    const expectsUnique = plan.unique === true;
    if (indexes.rowCount !== names.length || indexes.rows.some((item) => (
        item.table_name !== expected.get(item.name) || !item.indisvalid || !item.indisready
        || item.indisunique !== expectsUnique
        || (plan.shapes?.[item.name] && (
            JSON.stringify(item.index_keys) !== JSON.stringify(plan.shapes[item.name].keys)
            || normalizedSql(item.predicate) !== normalizedSql(plan.shapes[item.name].predicate)
        ))
    ))) {
        throw new Error(`Migration ${version} did not produce the complete valid index set`);
    }
};

let locked = false;
await client.connect();
try {
    await client.query(`SET statement_timeout = '${Math.min(timeoutMs, 480_000)}ms'`);
    await client.query("SET lock_timeout = '5s'");
    await validateFailure();
    let state = await readState();

    if (inspect) {
        console.log(JSON.stringify({
            plane,
            version,
            script: plan.script,
            checksum: state.localChecksum,
            indexes: plan.indexes.map(([name, table]) => {
                const found = state.artifacts.find((item) => item.name === name);
                return {
                    name,
                    table,
                    unique: plan.unique === true,
                    keys: found?.index_keys ?? null,
                    predicate: found?.predicate ?? null,
                    state: !found ? 'absent' : (found.indisvalid && found.indisready ? 'valid' : 'invalid'),
                };
            }),
            action: 'inspection_only',
        }));
    } else {
        if (process.env.MIGRATION_RECOVERY_APPROVED !== 'true') {
            throw new Error('MIGRATION_RECOVERY_APPROVED=true is required for index recovery');
        }
        const changeId = process.env.MIGRATION_CHANGE_ID;
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{2,79}$/.test(changeId ?? '')) {
            throw new Error('MIGRATION_CHANGE_ID must identify the approved recovery record');
        }
        if (process.env.MIGRATION_RECOVERY_CHECKSUM !== String(state.localChecksum)) {
            throw new Error('MIGRATION_RECOVERY_CHECKSUM must equal the reviewed inspection checksum');
        }

        await acquireLock();
        locked = true;
        state = await readState();
        if (process.env.MIGRATION_RECOVERY_CHECKSUM !== String(state.localChecksum)) {
            throw new Error('Migration checksum changed after lock acquisition');
        }
        for (const [name] of plan.indexes) {
            await client.query(`DROP INDEX CONCURRENTLY IF EXISTS public.${name}`);
        }
        const remains = await client.query(`
            SELECT c.relname
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public'
               AND c.relname = ANY($1::text[])
        `, [plan.indexes.map(([name]) => name)]);
        if (remains.rowCount !== 0) throw new Error('Failed index artifacts remain after cleanup');
        await releaseLock();
        locked = false;

        const repair = await flywayJson('repair');
        const removed = repair.migrationsRemoved ?? [];
        if (removed.length !== 1
            || removed[0].version !== version
            || (repair.migrationsAligned ?? []).length !== 0
            || (repair.migrationsDeleted ?? []).length !== 0) {
            throw new Error('Flyway repair changed history beyond the selected failed migration');
        }

        const clean = await flywayJson('validate');
        if (clean.validationSuccessful !== true || (clean.invalidMigrations ?? []).length !== 0) {
            throw new Error('Flyway history was not clean after repair');
        }
        await flywayJson('migrate', [`-target=${version}`]);
        const final = await flywayJson('validate');
        if (final.validationSuccessful !== true || (final.invalidMigrations ?? []).length !== 0) {
            throw new Error('Flyway validation failed after recovered migration');
        }
        await verifyFinal();
        console.log(JSON.stringify({
            plane,
            version,
            script: plan.script,
            checksum: state.localChecksum,
            changeId,
            indexes: plan.indexes.length,
            action: 'recovered',
        }));
    }
} finally {
    if (locked) {
        try {
            await releaseLock();
        } catch {
            // The primary recovery failure remains authoritative.
        }
    }
    await client.end();
}
