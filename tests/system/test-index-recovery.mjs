import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { cleanEnv, pullFlyway, runFlyway, runProc } from '../../db/tools/flyway-runner.mjs';
import { toJdbc } from '../../db/tools/migration-config.mjs';

const source = process.env.DATABASE_URL;
if (!source) throw new Error('DATABASE_URL is required');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const timeoutMs = Number(process.env.MIGRATION_TIMEOUT_MS ?? 600_000);
const name = `fervor_index_${process.pid}_${randomBytes(4).toString('hex')}`;
const adminUrl = new URL(source);
adminUrl.pathname = '/postgres';
const dbUrl = new URL(source);
dbUrl.pathname = `/${name}`;
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const clients = new Set();
let writerRun = false;
let writerTask;

const open = async () => {
    const client = new pg.Client({ connectionString: dbUrl.toString() });
    await client.connect();
    clients.add(client);
    return client;
};

const close = async (client) => {
    clients.delete(client);
    await client.end();
};

const migrate = (target) => runFlyway({
    root,
    plane: 'core',
    target: toJdbc(dbUrl.toString(), 'CORE'),
    command: 'migrate',
    timeoutMs,
    extra: [`-target=${target}`],
    capture: true,
});

const seed = async (client, userId) => {
    const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
    const inputMint = 'So11111111111111111111111111111111111111112';
    const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    await client.query('INSERT INTO users (id, wallet_address) VALUES ($1, $2)', [userId, wallet]);
    await client.query(`
        WITH quotes AS (
            INSERT INTO trade_quotes (
                id, user_id, wallet_address, provider, provider_quote_id,
                input_mint, output_mint, input_amount, output_amount,
                min_output_amount, slippage_bps, transaction_digest,
                integrity_digest, expires_at
            )
            SELECT gen_random_uuid(), $1, $2, 'recovery', 'seed-q-' || n,
                   $3, $4, 1, 2, 1, 100,
                   repeat(md5('tx-' || n), 2), repeat(md5('int-' || n), 2),
                   CURRENT_TIMESTAMP + INTERVAL '1 hour'
              FROM generate_series(1, 50000) AS n
            RETURNING id, provider_quote_id
        )
        INSERT INTO trade_executions (
            id, quote_id, user_id, wallet_address, provider, idempotency_key,
            state, signature, input_mint, output_mint, expected_input_amount,
            expected_output_amount, signed_tx_digest, submitted_at, updated_at
        )
        SELECT gen_random_uuid(), id, $1, $2, 'recovery', 'seed-e-' || provider_quote_id,
               'submitted', repeat('5', 88), $3, $4, 1, 2,
               repeat(md5('signed-' || provider_quote_id), 2),
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          FROM quotes
    `, [userId, wallet, inputMint, outputMint]);
    await client.query(`
        INSERT INTO event_outbox (stream, event_key, payload, status)
        SELECT 'recovery', 'event-' || n, '{}'::jsonb,
               CASE WHEN n % 5 = 0 THEN 'failed' ELSE 'published' END
          FROM generate_series(1, 20000) AS n
    `);
    await client.query(`
        INSERT INTO notification_deliveries (channel, idempotency_key, status, user_id)
        SELECT 'discord', 'delivery-' || n,
               CASE WHEN n % 5 = 0 THEN 'pending' ELSE 'delivered' END, $1
          FROM generate_series(1, 20000) AS n
    `, [userId]);
    await client.query(`
        INSERT INTO order_intents (
            id, user_id, provider, client_order_id, request_digest, wallet_address,
            order_type, state, input_mint, output_mint, input_amount, trigger_mint,
            params, expires_at
        )
        SELECT gen_random_uuid(), $1, 'recovery', 'order-' || n,
               repeat(md5('order-' || n), 2), $2, 'single',
               CASE WHEN n % 5 = 0 THEN 'preparing' ELSE 'filled' END,
               $3, $4, 1, $4, '{}'::jsonb, CURRENT_TIMESTAMP + INTERVAL '1 hour'
          FROM generate_series(1, 20000) AS n
    `, [userId, wallet, inputMint, outputMint]);
    await client.query(`
        INSERT INTO tokens (mint, observed_at)
        SELECT 'recovery-mint-' || n,
               CASE WHEN n % 5 = 0 THEN CURRENT_TIMESTAMP ELSE NULL END
          FROM generate_series(1, 20000) AS n
    `);
};

const startWriter = async (userId) => {
    const writer = await open();
    writerRun = true;
    const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
    const inputMint = 'So11111111111111111111111111111111111111112';
    const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const stats = { writes: 0, maxMs: 0 };
    writerTask = (async () => {
        while (writerRun) {
            const started = Date.now();
            const key = `live-${stats.writes}-${randomUUID()}`;
            await writer.query(`
                WITH quote AS (
                    INSERT INTO trade_quotes (
                        id, user_id, wallet_address, provider, provider_quote_id,
                        input_mint, output_mint, input_amount, output_amount,
                        min_output_amount, slippage_bps, transaction_digest,
                        integrity_digest, expires_at
                    )
                    VALUES (
                        gen_random_uuid(), $1, $2, 'recovery', $3,
                        $4, $5, 1, 2, 1, 100, repeat('a', 64),
                        repeat('b', 64), CURRENT_TIMESTAMP + INTERVAL '1 hour'
                    )
                    RETURNING id
                )
                INSERT INTO trade_executions (
                    id, quote_id, user_id, wallet_address, provider, idempotency_key,
                    state, signature, input_mint, output_mint, expected_input_amount,
                    expected_output_amount, signed_tx_digest, submitted_at
                )
                SELECT gen_random_uuid(), id, $1, $2, 'recovery', $3,
                       'submitted', repeat('6', 88), $4, $5, 1, 2,
                       repeat('c', 64), CURRENT_TIMESTAMP
                  FROM quote
            `, [userId, wallet, key, inputMint, outputMint]);
            stats.writes += 1;
            stats.maxMs = Math.max(stats.maxMs, Date.now() - started);
            await delay(2);
        }
        await close(writer);
        return stats;
    })();
    return stats;
};

const stopWriter = async () => {
    writerRun = false;
    return writerTask ? writerTask : { writes: 0, maxMs: 0 };
};

const seedObsAction = async (client, userId) => {
    const order = await client.query(`
        SELECT id FROM order_intents WHERE user_id = $1 ORDER BY id LIMIT 1
    `, [userId]);
    if (!order.rows[0]) throw new Error('Observation recovery fixture has no order');
    const actionId = randomUUID();
    await client.query(`
        INSERT INTO order_epochs (
            scope, epoch, region, mode, authority, proof_hash, source_key
        ) VALUES (
            'provider:recovery', 1, 'ci', 'live', 'index-recovery',
            repeat('d', 64), 'index-recovery:epoch:1'
        )
    `);
    await client.query('ALTER TABLE order_actions DISABLE TRIGGER order_actions_transition_guard');
    try {
        await client.query(`
            INSERT INTO order_actions (
                id, order_id, user_id, kind, rule_ver, client_key, req_hash,
                desired_hash, expected_ver, work_state, effect_state, outcome,
                provider, due_at, completed_at
            ) VALUES (
                $1, $2, $3, 'provider_sync', 1, 'index-recovery-proof',
                repeat('e', 64), repeat('f', 64), 0, 'done', 'present',
                'succeeded', 'recovery', clock_timestamp(), clock_timestamp()
            )
        `, [actionId, order.rows[0].id, userId]);
    } finally {
        await client.query('ALTER TABLE order_actions ENABLE TRIGGER order_actions_transition_guard');
    }
    await client.query(`
        INSERT INTO action_obs (
            id, action_id, source, cluster, source_key, fact_key, fact_rev,
            query_kind, verdict, predicate, rule_ver, provider, desired_hash,
            effect_hash, provider_order_id, payload_hash, payload_ver, payload
        ) VALUES (
            gen_random_uuid(), $1, 'provider', 'mainnet-beta',
            'index-recovery:base-source', 'index-recovery:base-fact', 1,
            'found', 'presence', 'provider_sync.provider.effect.v1', 1,
            'recovery', repeat('f', 64), repeat('f', 64), 'recovery-order',
            repeat('1', 64), 1, '{}'
        )
    `, [actionId]);
    return actionId;
};

const startObsWriter = async (actionId) => {
    const writer = await open();
    writerRun = true;
    const stats = { writes: 0, maxMs: 0 };
    writerTask = (async () => {
        while (writerRun) {
            const started = Date.now();
            const key = `index-recovery:live:${stats.writes}:${randomUUID()}`;
            const baseId = randomUUID();
            await writer.query(`
                INSERT INTO action_obs (
                    id, action_id, source, cluster, source_key, fact_key, fact_rev,
                    query_kind, verdict, predicate, rule_ver, provider, desired_hash,
                    payload_hash, payload_ver, payload
                ) VALUES (
                    $3, $1, 'provider', 'mainnet-beta', $2 || ':base', $2, 1,
                    'unchecked', 'context', 'provider_sync.provider.effect.v1', 1,
                    'recovery', repeat('f', 64), repeat('2', 64), 1, '{}'
                )
            `, [actionId, key, baseId]);
            await writer.query(`
                INSERT INTO action_obs (
                    id, action_id, source, cluster, source_key, fact_key, fact_rev,
                    supersedes, query_kind, verdict, predicate, rule_ver, provider,
                    desired_hash, payload_hash, payload_ver, payload
                ) VALUES (
                    gen_random_uuid(), $1, 'provider', 'mainnet-beta', $2 || ':rev2',
                    $2, 2, $3, 'unchecked', 'context',
                    'provider_sync.provider.effect.v1', 1, 'recovery', repeat('f', 64),
                    repeat('3', 64), 1, '{}'
                )
            `, [actionId, key, baseId]);
            stats.writes += 2;
            stats.maxMs = Math.max(stats.maxMs, Date.now() - started);
            await delay(2);
        }
        await close(writer);
        return stats;
    })();
    writerTask.catch(() => {
        // stopWriter or outer cleanup observes the authoritative failure.
    });
    return stats;
};

const seedAssetCircuits = async (client, userId, actionId) => {
    const anchor = await client.query(`
        SELECT action.order_id, order_row.wallet_address, order_row.input_mint,
               coalesce(order_row.cluster, 'mainnet-beta') AS cluster
          FROM order_actions action
          JOIN order_intents order_row ON order_row.id = action.order_id
         WHERE action.id = $1
    `, [actionId]);
    if (!anchor.rows[0]) throw new Error('Asset recovery fixture has no action aggregate');
    await client.query(`
        INSERT INTO asset_obligations (
            id, obligation_key, req_hash, order_id, cluster, wallet_address,
            mint, kind, amount, reason
        )
        SELECT gen_random_uuid(), 'index-recovery:asset:order:' || order_row.id::text,
               repeat(md5('asset-order:' || order_row.id::text), 2), order_row.id,
               coalesce(order_row.cluster, 'mainnet-beta'), order_row.wallet_address,
               order_row.input_mint, 'deficit', 1, 'Circuit index recovery seed'
          FROM order_intents order_row
         WHERE order_row.user_id = $1
         ORDER BY order_row.id
         LIMIT 15000
    `, [userId]);
    await client.query(`
        INSERT INTO asset_obligations (
            id, obligation_key, req_hash, action_id, cluster, wallet_address,
            mint, kind, amount, reason
        )
        SELECT gen_random_uuid(), 'index-recovery:asset:action:' || n,
               repeat(md5('asset-action:' || n), 2), $1, $2, $3,
               $4, 'deficit', 1, 'Circuit action index recovery seed'
          FROM generate_series(1, 5000) n
    `, [actionId, anchor.rows[0].cluster, anchor.rows[0].wallet_address,
        anchor.rows[0].input_mint]);
    return anchor.rows[0];
};

const startAssetWriter = async (anchor) => {
    const writer = await open();
    writerRun = true;
    const stats = { writes: 0, maxMs: 0 };
    writerTask = (async () => {
        while (writerRun) {
            const started = Date.now();
            const key = `index-recovery:asset:live:${stats.writes}:${randomUUID()}`;
            await writer.query(`
                INSERT INTO asset_obligations (
                    id, obligation_key, req_hash, order_id, cluster, wallet_address,
                    mint, kind, amount, reason
                ) VALUES (
                    gen_random_uuid(), $1::text, repeat(md5($1::text), 2), $2, $3, $4,
                    $5, 'deficit', 1, 'Concurrent circuit index recovery write'
                )
            `, [key, anchor.order_id, anchor.cluster, anchor.wallet_address, anchor.input_mint]);
            stats.writes += 1;
            stats.maxMs = Math.max(stats.maxMs, Date.now() - started);
            await delay(2);
        }
        await close(writer);
        return stats;
    })();
    writerTask.catch(() => {
        // stopWriter or outer cleanup observes the authoritative failure.
    });
    return stats;
};

const failV7 = async (control) => {
    const blocker = await open();
    await blocker.query('BEGIN');
    await blocker.query(`
        UPDATE trade_executions
           SET updated_at = updated_at
         WHERE id = (SELECT id FROM trade_executions ORDER BY id LIMIT 1)
    `);
    const migration = migrate('007').then(() => null, (error) => error);

    let visible = false;
    let pid;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await control.query(`
            SELECT activity.pid,
                   to_regclass('public.trade_exec_reconcile_due_idx') IS NOT NULL AS visible
              FROM pg_stat_activity activity
             WHERE activity.datname = current_database()
               AND activity.query LIKE 'CREATE INDEX CONCURRENTLY trade_exec_reconcile_due_idx%'
             LIMIT 1
        `);
        if (result.rowCount === 1 && result.rows[0].visible) {
            visible = true;
            pid = result.rows[0].pid;
            break;
        }
        await delay(25);
    }
    if (!visible) throw new Error('Interrupted V007 fixture never exposed its in-progress index');
    const killed = await control.query('SELECT pg_cancel_backend($1) AS killed', [pid]);
    if (!killed.rows[0].killed) throw new Error('Failed to cancel the V007 index builder');
    const error = await migration;
    if (!(error instanceof Error)) throw new Error('Interrupted V007 build unexpectedly succeeded');
    await blocker.query('ROLLBACK');
    await close(blocker);

    const invalid = await control.query(`
        SELECT i.indisvalid, i.indisready
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_index i ON i.indexrelid = c.oid
         WHERE n.nspname = 'public'
           AND c.relname = 'trade_exec_reconcile_due_idx'
    `);
    if (invalid.rowCount !== 1 || invalid.rows[0].indisvalid) {
        throw new Error('Interrupted V007 did not leave the invalid artifact required by the drill');
    }
    const history = await control.query(`
        SELECT count(*)::int AS count
          FROM fervor_core_meta.fervor_core_history
         WHERE version = '007' AND success = false
    `);
    if (history.rows[0].count !== 1) throw new Error('V007 failure was not recorded in Flyway history');
};

const failV8 = async () => {
    const blocker = await open();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE notification_deliveries IN ACCESS EXCLUSIVE MODE');
    let failed = false;
    try {
        await migrate('008');
    } catch (error) {
        failed = error instanceof Error && error.message.includes('lock timeout');
    } finally {
        await blocker.query('ROLLBACK');
        await close(blocker);
    }
    if (!failed) throw new Error('V008 lock-conflict fixture did not fail with a lock timeout');
};

const recoveryProc = (version, mode, env, timeout = timeoutMs) => runProc(process.execPath, [
    'db/tools/recover-indexes.mjs', '--plane=core', `--version=${version}`, mode,
], {
    cwd: root,
    env,
    capture: true,
    timeoutMs: timeout + 60_000,
});

const recoverV7 = async () => {
    const baseEnv = cleanEnv({
        CORE_DATABASE_URL: dbUrl.toString(),
        MIGRATION_COLOCATED: 'true',
        MIGRATION_TIMEOUT_MS: String(timeoutMs),
    });
    const inspect = await recoveryProc('007', '--inspect', baseEnv);
    if (inspect.timedOut || inspect.code !== 0) {
        throw new Error(`V007 recovery inspection failed: ${inspect.stderr.trim()}`);
    }
    const report = JSON.parse(inspect.stdout);
    const apply = await recoveryProc('007', '--apply', {
        ...baseEnv,
        MIGRATION_RECOVERY_APPROVED: 'true',
        MIGRATION_CHANGE_ID: 'ci/index-recovery-v7',
        MIGRATION_RECOVERY_CHECKSUM: String(report.checksum),
    });
    if (apply.timedOut || apply.code !== 0) {
        throw new Error(`V007 recovery apply failed: ${[apply.stdout, apply.stderr].join('\n').trim()}`);
    }
    const result = JSON.parse(apply.stdout);
    if (result.action !== 'recovered' || result.version !== '007' || result.indexes !== 1) {
        throw new Error('V007 recovery apply returned an unexpected result');
    }
};

const recoverV8 = async (control) => {
    const baseEnv = cleanEnv({
        CORE_DATABASE_URL: dbUrl.toString(),
        MIGRATION_COLOCATED: 'true',
        MIGRATION_TIMEOUT_MS: String(timeoutMs),
    });
    const recover = (mode, env = baseEnv) => recoveryProc('008', mode, env);
    const inspect = await recover('--inspect');
    if (inspect.timedOut || inspect.code !== 0) {
        throw new Error(`Index recovery inspection failed: ${inspect.stderr.trim()}`);
    }
    const report = JSON.parse(inspect.stdout);
    if (report.action !== 'inspection_only' || report.version !== '008') {
        throw new Error('Index recovery inspection returned an unexpected plan');
    }

    const approved = {
        ...baseEnv,
        MIGRATION_RECOVERY_APPROVED: 'true',
        MIGRATION_CHANGE_ID: 'ci/index-recovery',
        MIGRATION_RECOVERY_CHECKSUM: String(report.checksum),
    };
    const wrongChecksum = await recover('--apply', {
        ...approved,
        MIGRATION_RECOVERY_CHECKSUM: String(report.checksum + 1),
    });
    if (wrongChecksum.code === 0 || !wrongChecksum.stderr.includes('reviewed inspection checksum')) {
        throw new Error('Recovery accepted an unreviewed checksum');
    }

    const missingApproval = await recover('--apply', {
        ...approved,
        MIGRATION_RECOVERY_APPROVED: 'false',
    });
    if (missingApproval.code === 0 || !missingApproval.stderr.includes('MIGRATION_RECOVERY_APPROVED=true')) {
        throw new Error('Recovery accepted a missing approval');
    }

    const prior = await control.query(`
        SELECT checksum
          FROM fervor_core_meta.fervor_core_history
         WHERE version = '006' AND success = true
    `);
    await control.query(`
        UPDATE fervor_core_meta.fervor_core_history
           SET checksum = checksum + 1
         WHERE version = '006' AND success = true
    `);
    try {
        const drift = await recover('--inspect');
        if (drift.code === 0 || !drift.stderr.includes('refusing repair')) {
            throw new Error('Recovery accepted unrelated checksum drift');
        }
    } finally {
        await control.query(`
            UPDATE fervor_core_meta.fervor_core_history
               SET checksum = $1
             WHERE version = '006' AND success = true
        `, [prior.rows[0].checksum]);
    }

    await control.query('CREATE TABLE order_stuck_idx (id integer)');
    try {
        const collision = await recover('--inspect');
        if (collision.code === 0 || !collision.stderr.includes('reviewed recovery target')) {
            throw new Error('Recovery accepted a same-name non-index object');
        }
    } finally {
        await control.query('DROP TABLE order_stuck_idx');
    }

    const apply = await recover('--apply', approved);
    if (apply.timedOut || apply.code !== 0) {
        throw new Error(`Index recovery apply failed: ${[apply.stdout, apply.stderr].join('\n').trim()}`);
    }
    const result = JSON.parse(apply.stdout);
    if (result.action !== 'recovered' || result.version !== '008' || result.indexes !== 7) {
        throw new Error('Index recovery apply returned an unexpected result');
    }
};

const failV17 = async () => {
    const blocker = await open();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE action_attempts IN ACCESS EXCLUSIVE MODE');
    let failed = false;
    try {
        await migrate('017');
    } catch (error) {
        failed = error instanceof Error && error.message.includes('lock timeout');
    } finally {
        await blocker.query('ROLLBACK');
        await close(blocker);
    }
    if (!failed) throw new Error('V017 lock-conflict fixture did not fail with a lock timeout');
};

const recoverV17 = async () => {
    const baseEnv = cleanEnv({
        CORE_DATABASE_URL: dbUrl.toString(),
        MIGRATION_COLOCATED: 'true',
        MIGRATION_TIMEOUT_MS: String(timeoutMs),
    });
    const inspect = await recoveryProc('017', '--inspect', baseEnv);
    if (inspect.timedOut || inspect.code !== 0) {
        throw new Error(`V017 recovery inspection failed: ${inspect.stderr.trim()}`);
    }
    const report = JSON.parse(inspect.stdout);
    const apply = await recoveryProc('017', '--apply', {
        ...baseEnv,
        MIGRATION_RECOVERY_APPROVED: 'true',
        MIGRATION_CHANGE_ID: 'ci/index-recovery-v17',
        MIGRATION_RECOVERY_CHECKSUM: String(report.checksum),
    });
    if (apply.timedOut || apply.code !== 0) {
        throw new Error(`V017 recovery apply failed: ${[apply.stdout, apply.stderr].join('\n').trim()}`);
    }
    const result = JSON.parse(apply.stdout);
    if (result.action !== 'recovered' || result.version !== '017' || result.indexes !== 1) {
        throw new Error('V017 recovery apply returned an unexpected result');
    }
};

const failV20 = async () => {
    const blocker = await open();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE order_schedules IN ACCESS EXCLUSIVE MODE');
    let failed = false;
    try {
        await migrate('020');
    } catch (error) {
        failed = error instanceof Error && error.message.includes('lock timeout');
    } finally {
        await blocker.query('ROLLBACK');
        await close(blocker);
    }
    if (!failed) throw new Error('V020 lock-conflict fixture did not fail with a lock timeout');
};

const recoverV20 = async (control) => {
    const baseEnv = cleanEnv({
        CORE_DATABASE_URL: dbUrl.toString(),
        MIGRATION_COLOCATED: 'true',
        MIGRATION_TIMEOUT_MS: String(timeoutMs),
    });
    await control.query('CREATE INDEX order_schedules_fill_idx ON order_schedules (fill_id)');
    const nonUnique = await recoveryProc('020', '--inspect', baseEnv);
    if (nonUnique.code === 0 || !nonUnique.stderr.includes('reviewed recovery target')) {
        throw new Error('V020 recovery accepted a same-name non-unique artifact');
    }
    await control.query('DROP INDEX order_schedules_fill_idx');

    await control.query(`
        CREATE UNIQUE INDEX order_schedules_fill_idx ON order_schedules (order_id)
    `);
    const wrongShape = await recoveryProc('020', '--inspect', baseEnv);
    if (wrongShape.code === 0 || !wrongShape.stderr.includes('reviewed recovery target')) {
        throw new Error('V020 recovery accepted a unique index with the wrong key or predicate');
    }
    await control.query('DROP INDEX order_schedules_fill_idx');

    await control.query(`
        CREATE UNIQUE INDEX order_schedules_fill_idx ON order_schedules (fill_id)
        WHERE fill_id IS NOT NULL
    `);
    const prior = await control.query(`
        SELECT 'order_schedules_fill_idx'::regclass::oid AS oid
    `);
    const inspect = await recoveryProc('020', '--inspect', baseEnv);
    if (inspect.timedOut || inspect.code !== 0) {
        throw new Error(`V020 recovery inspection failed: ${inspect.stderr.trim()}`);
    }
    const report = JSON.parse(inspect.stdout);
    if (report.indexes[0]?.unique !== true) {
        throw new Error('V020 recovery inspection did not preserve unique-index identity');
    }
    if (JSON.stringify(report.indexes[0]?.keys) !== JSON.stringify(['fill_id'])
        || !String(report.indexes[0]?.predicate).includes('fill_id IS NOT NULL')) {
        throw new Error('V020 recovery inspection did not report the observed index shape');
    }
    const apply = await recoveryProc('020', '--apply', {
        ...baseEnv,
        MIGRATION_RECOVERY_APPROVED: 'true',
        MIGRATION_CHANGE_ID: 'ci/index-recovery-v20',
        MIGRATION_RECOVERY_CHECKSUM: String(report.checksum),
    });
    if (apply.timedOut || apply.code !== 0) {
        throw new Error(`V020 recovery apply failed: ${[apply.stdout, apply.stderr].join('\n').trim()}`);
    }
    const result = JSON.parse(apply.stdout);
    if (result.action !== 'recovered' || result.version !== '020' || result.indexes !== 1) {
        throw new Error('V020 recovery apply returned an unexpected result');
    }
    const replaced = await control.query(`
        SELECT 'order_schedules_fill_idx'::regclass::oid AS oid
    `);
    if (replaced.rows[0].oid === prior.rows[0].oid) {
        throw new Error('V020 recovery did not replace the reviewed pre-existing artifact');
    }
};

const failV24 = async () => {
    const blocker = await open();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE order_actions IN ACCESS EXCLUSIVE MODE');
    let failed = false;
    try {
        await migrate('024');
    } catch (error) {
        failed = error instanceof Error && error.message.includes('lock timeout');
    } finally {
        await blocker.query('ROLLBACK');
        await close(blocker);
    }
    if (!failed) throw new Error('V024 lock-conflict fixture did not fail with a lock timeout');
};

const recoverV24 = async () => {
    const baseEnv = cleanEnv({
        CORE_DATABASE_URL: dbUrl.toString(),
        MIGRATION_COLOCATED: 'true',
        MIGRATION_TIMEOUT_MS: String(timeoutMs),
    });
    const inspect = await recoveryProc('024', '--inspect', baseEnv);
    if (inspect.timedOut || inspect.code !== 0) {
        throw new Error(`V024 recovery inspection failed: ${inspect.stderr.trim()}`);
    }
    const report = JSON.parse(inspect.stdout);
    const apply = await recoveryProc('024', '--apply', {
        ...baseEnv,
        MIGRATION_RECOVERY_APPROVED: 'true',
        MIGRATION_CHANGE_ID: 'ci/index-recovery-v24',
        MIGRATION_RECOVERY_CHECKSUM: String(report.checksum),
    });
    if (apply.timedOut || apply.code !== 0) {
        throw new Error(`V024 recovery apply failed: ${[apply.stdout, apply.stderr].join('\n').trim()}`);
    }
    const result = JSON.parse(apply.stdout);
    if (result.action !== 'recovered' || result.version !== '024' || result.indexes !== 1) {
        throw new Error('V024 recovery apply returned an unexpected result');
    }
};

const failV25 = async () => {
    const blocker = await open();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE order_actions IN ACCESS EXCLUSIVE MODE');
    let failed = false;
    try {
        await migrate('025');
    } catch (error) {
        failed = error instanceof Error && error.message.includes('lock timeout');
    } finally {
        await blocker.query('ROLLBACK');
        await close(blocker);
    }
    if (!failed) throw new Error('V025 lock-conflict fixture did not fail with a lock timeout');
};

const recoverV25 = async () => {
    const baseEnv = cleanEnv({
        CORE_DATABASE_URL: dbUrl.toString(),
        MIGRATION_COLOCATED: 'true',
        MIGRATION_TIMEOUT_MS: String(timeoutMs),
    });
    const inspect = await recoveryProc('025', '--inspect', baseEnv);
    if (inspect.timedOut || inspect.code !== 0) {
        throw new Error(`V025 recovery inspection failed: ${inspect.stderr.trim()}`);
    }
    const report = JSON.parse(inspect.stdout);
    const apply = await recoveryProc('025', '--apply', {
        ...baseEnv,
        MIGRATION_RECOVERY_APPROVED: 'true',
        MIGRATION_CHANGE_ID: 'ci/index-recovery-v25',
        MIGRATION_RECOVERY_CHECKSUM: String(report.checksum),
    });
    if (apply.timedOut || apply.code !== 0) {
        throw new Error(`V025 recovery apply failed: ${[apply.stdout, apply.stderr].join('\n').trim()}`);
    }
    const result = JSON.parse(apply.stdout);
    if (result.action !== 'recovered' || result.version !== '025' || result.indexes !== 1) {
        throw new Error('V025 recovery apply returned an unexpected result');
    }
};

const failEvidenceIndex = async (version) => {
    const blocker = await open();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE action_obs IN ACCESS EXCLUSIVE MODE');
    let failed = false;
    try {
        await migrate(version);
    } catch (error) {
        failed = error instanceof Error && error.message.includes('lock timeout');
    } finally {
        await blocker.query('ROLLBACK');
        await close(blocker);
    }
    if (!failed) throw new Error(`V${version} lock-conflict fixture did not fail with a lock timeout`);
};

const failAssetIndex = async (version) => {
    const blocker = await open();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE asset_obligations IN ACCESS EXCLUSIVE MODE');
    let failed = false;
    try {
        await migrate(version);
    } catch (error) {
        failed = error instanceof Error && error.message.includes('lock timeout');
    } finally {
        await blocker.query('ROLLBACK');
        await close(blocker);
    }
    if (!failed) throw new Error(`V${version} asset-index fixture did not fail with a lock timeout`);
};

const recoverIndex = async (version) => {
    const baseEnv = cleanEnv({
        CORE_DATABASE_URL: dbUrl.toString(),
        MIGRATION_COLOCATED: 'true',
        MIGRATION_TIMEOUT_MS: String(timeoutMs),
    });
    const inspect = await recoveryProc(version, '--inspect', baseEnv);
    if (inspect.timedOut || inspect.code !== 0) {
        throw new Error(`V${version} recovery inspection failed: ${inspect.stderr.trim()}`);
    }
    const report = JSON.parse(inspect.stdout);
    const apply = await recoveryProc(version, '--apply', {
        ...baseEnv,
        MIGRATION_RECOVERY_APPROVED: 'true',
        MIGRATION_CHANGE_ID: `ci/index-recovery-v${version}`,
        MIGRATION_RECOVERY_CHECKSUM: String(report.checksum),
    });
    if (apply.timedOut || apply.code !== 0) {
        throw new Error(
            `V${version} recovery apply failed: ${[apply.stdout, apply.stderr].join('\n').trim()}`
        );
    }
    const result = JSON.parse(apply.stdout);
    if (result.action !== 'recovered' || result.version !== version || result.indexes !== 1) {
        throw new Error(`V${version} recovery apply returned an unexpected result`);
    }
};

const failOrderIndex = async (version) => {
    const blocker = await open();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE order_intents IN ACCESS EXCLUSIVE MODE');
    let failed = false;
    try {
        await migrate(version);
    } catch (error) {
        failed = error instanceof Error && error.message.includes('lock timeout');
    } finally {
        await blocker.query('ROLLBACK');
        await close(blocker);
    }
    if (!failed) throw new Error(`V${version} lock-conflict fixture did not fail with a lock timeout`);
};

const failV40 = async (control) => {
    const blocker = await open();
    await blocker.query('BEGIN');
    await blocker.query(`
        UPDATE order_intents
           SET updated_at = updated_at
         WHERE id = (SELECT id FROM order_intents ORDER BY id LIMIT 1)
    `);
    const migration = migrate('040').then(() => null, (error) => error);

    let pid;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await control.query(`
            SELECT activity.pid
              FROM pg_stat_activity activity
             WHERE activity.datname = current_database()
               AND activity.query LIKE 'CREATE INDEX CONCURRENTLY order_intents_op_cutover_idx%'
               AND to_regclass('public.order_intents_op_cutover_idx') IS NOT NULL
             LIMIT 1
        `);
        if (result.rowCount === 1) {
            pid = result.rows[0].pid;
            break;
        }
        await delay(25);
    }
    if (pid === undefined) {
        throw new Error('Interrupted V040 fixture never exposed its in-progress index');
    }
    const killed = await control.query('SELECT pg_cancel_backend($1) AS killed', [pid]);
    if (!killed.rows[0].killed) throw new Error('Failed to cancel the V040 index builder');
    const error = await migration;
    if (!(error instanceof Error)) throw new Error('Interrupted V040 build unexpectedly succeeded');
    await blocker.query('ROLLBACK');
    await close(blocker);

    const invalid = await control.query(`
        SELECT index_row.indisvalid, index_row.indisready
          FROM pg_index index_row
         WHERE index_row.indexrelid = 'public.order_intents_op_cutover_idx'::regclass
    `);
    if (invalid.rowCount !== 1 || invalid.rows[0].indisvalid) {
        throw new Error('Interrupted V040 did not leave its invalid index artifact');
    }
    const history = await control.query(`
        SELECT count(*)::int AS count
          FROM fervor_core_meta.fervor_core_history
         WHERE version = '040' AND success = false
    `);
    if (history.rows[0].count !== 1) {
        throw new Error('V040 failure was not recorded in Flyway history');
    }
};

const recoverOrderIndex = async (version) => {
    const baseEnv = cleanEnv({
        CORE_DATABASE_URL: dbUrl.toString(),
        MIGRATION_COLOCATED: 'true',
        MIGRATION_TIMEOUT_MS: String(timeoutMs),
    });
    const inspect = await recoveryProc(version, '--inspect', baseEnv);
    if (inspect.timedOut || inspect.code !== 0) {
        throw new Error(`V${version} recovery inspection failed: ${inspect.stderr.trim()}`);
    }
    const report = JSON.parse(inspect.stdout);
    const apply = await recoveryProc(version, '--apply', {
        ...baseEnv,
        MIGRATION_RECOVERY_APPROVED: 'true',
        MIGRATION_CHANGE_ID: `ci/index-recovery-v${version}`,
        MIGRATION_RECOVERY_CHECKSUM: String(report.checksum),
    });
    if (apply.timedOut || apply.code !== 0) {
        throw new Error(
            `V${version} recovery apply failed: ${[apply.stdout, apply.stderr].join('\n').trim()}`
        );
    }
    const result = JSON.parse(apply.stdout);
    if (result.action !== 'recovered' || result.version !== version || result.indexes !== 1) {
        throw new Error(`V${version} recovery apply returned an unexpected result`);
    }
};

await pullFlyway();
await admin.connect();
try {
    if (!/^fervor_index_[a-zA-Z0-9_]+$/.test(name)) throw new Error('Unsafe recovery test database name');
    await admin.query(`CREATE DATABASE "${name}"`);
    await migrate('006');
    const control = await open();
    const userId = randomUUID();
    await seed(control, userId);
    const live = await startWriter(userId);

    await failV7(control);
    await recoverV7();
    const v7 = await control.query(`
        SELECT i.indisvalid, i.indisready
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_index i ON i.indexrelid = c.oid
         WHERE n.nspname = 'public'
           AND c.relname = 'trade_exec_reconcile_due_idx'
    `);
    if (v7.rowCount !== 1 || !v7.rows[0].indisvalid || !v7.rows[0].indisready) {
        throw new Error('V007 retry did not replace its invalid index');
    }
    await control.query('SET enable_seqscan = off');
    const plan = await control.query(`
        EXPLAIN (FORMAT JSON)
        SELECT id
          FROM trade_executions
         WHERE signature IS NOT NULL
           AND (state IN ('submitted', 'processed', 'confirmed')
                OR (state = 'signed' AND broadcast_started_at IS NOT NULL))
         ORDER BY updated_at, id
         LIMIT 100
    `);
    if (!JSON.stringify(plan.rows).includes('trade_exec_reconcile_due_idx')) {
        throw new Error('Recovered V007 query plan does not use its index');
    }

    await failV8();
    const failed = await control.query(`
        SELECT count(*)::int AS count
          FROM fervor_core_meta.fervor_core_history
         WHERE version = '008' AND success = false
    `);
    if (failed.rows[0].count !== 1) throw new Error('V008 failure was not recorded in Flyway history');
    await recoverV8(control);
    await migrate('014');

    const indexes = await control.query(`
        SELECT count(*)::int AS count
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_index i ON i.indexrelid = c.oid
         WHERE n.nspname = 'public'
           AND c.relname = ANY($1::text[])
           AND i.indisvalid
           AND i.indisready
    `, [[
        'event_outbox_failed_idx',
        'notification_backlog_idx',
        'order_stuck_idx',
        'tokens_observed_idx',
        'trade_exec_signed_stuck_idx',
        'trade_exec_chain_stuck_idx',
        'trade_exec_recovery_stats_idx',
    ]]);
    if (indexes.rows[0].count !== 7) throw new Error('Recovered V008 index set is incomplete');
    await delay(25);
    const stats = await stopWriter();
    if (live.writes < 10 || stats.writes !== live.writes || stats.maxMs > 5_000) {
        throw new Error(`Concurrent writer did not stay healthy: ${JSON.stringify(stats)}`);
    }

    await migrate('016');
    await failV17();
    const failedV17 = await control.query(`
        SELECT count(*)::int AS count
          FROM fervor_core_meta.fervor_core_history
         WHERE version = '017' AND success = false
    `);
    if (failedV17.rows[0].count !== 1) throw new Error('V017 failure was not recorded in Flyway history');
    await recoverV17();
    await migrate('019');
    await failV20();
    const failedV20 = await control.query(`
        SELECT count(*)::int AS count
          FROM fervor_core_meta.fervor_core_history
         WHERE version = '020' AND success = false
    `);
    if (failedV20.rows[0].count !== 1) throw new Error('V020 failure was not recorded in Flyway history');
    await recoverV20(control);
    await migrate('023');
    await failV24();
    const failedV24 = await control.query(`
        SELECT count(*)::int AS count
          FROM fervor_core_meta.fervor_core_history
         WHERE version = '024' AND success = false
    `);
    if (failedV24.rows[0].count !== 1) throw new Error('V024 failure was not recorded in Flyway history');
    await recoverV24();
    await failV25();
    const failedV25 = await control.query(`
        SELECT count(*)::int AS count
          FROM fervor_core_meta.fervor_core_history
         WHERE version = '025' AND success = false
    `);
    if (failedV25.rows[0].count !== 1) throw new Error('V025 failure was not recorded in Flyway history');
    await recoverV25();
    await migrate('027');
    const obsAction = await seedObsAction(control, userId);
    const obsLive = await startObsWriter(obsAction);
    await failEvidenceIndex('028');
    const failedV28 = await control.query(`
        SELECT count(*)::int AS count
          FROM fervor_core_meta.fervor_core_history
         WHERE version = '028' AND success = false
    `);
    if (failedV28.rows[0].count !== 1) throw new Error('V028 failure was not recorded in Flyway history');
    await recoverIndex('028');
    await failEvidenceIndex('029');
    const failedV29 = await control.query(`
        SELECT count(*)::int AS count
          FROM fervor_core_meta.fervor_core_history
         WHERE version = '029' AND success = false
    `);
    if (failedV29.rows[0].count !== 1) throw new Error('V029 failure was not recorded in Flyway history');
    await recoverIndex('029');
    await delay(25);
    const obsStats = await stopWriter();
    if (obsLive.writes < 10 || obsStats.writes !== obsLive.writes || obsStats.maxMs > 7_000) {
        throw new Error(`Observation writer did not survive V028/V029 recovery: ${JSON.stringify(obsStats)}`);
    }
    await migrate('037');
    await failOrderIndex('038');
    await recoverOrderIndex('038');
    await migrate('039');
    await failV40(control);
    await recoverOrderIndex('040');
    await migrate('050');
    const assetAnchor = await seedAssetCircuits(control, userId, obsAction);
    const assetLive = await startAssetWriter(assetAnchor);
    for (const version of ['051', '052', '053']) {
        await failAssetIndex(version);
        const failedAsset = await control.query(`
            SELECT count(*)::int AS count
              FROM fervor_core_meta.fervor_core_history
             WHERE version = $1 AND success = false
        `, [version]);
        if (failedAsset.rows[0].count !== 1) {
            throw new Error(`V${version} failure was not recorded in Flyway history`);
        }
        await recoverIndex(version);
    }
    await failOrderIndex('053.1');
    const failedOrderScope = await control.query(`
        SELECT count(*)::int AS count
          FROM fervor_core_meta.fervor_core_history
         WHERE version = '053.1' AND success = false
    `);
    if (failedOrderScope.rows[0].count !== 1) {
        throw new Error('V053.1 failure was not recorded in Flyway history');
    }
    await recoverOrderIndex('053.1');
    await delay(25);
    const assetStats = await stopWriter();
    if (assetLive.writes < 10 || assetStats.writes !== assetLive.writes
        || assetStats.maxMs > 7_000) {
        throw new Error(
            `Asset obligation writer did not survive V051-V053.1 recovery: ${JSON.stringify(assetStats)}`
        );
    }
    await migrate('054');
    await control.query('SET enable_seqscan = off');
    const assetPlans = [];
    assetPlans.push(await control.query(`
            EXPLAIN (FORMAT JSON)
            SELECT id
              FROM asset_obligations
             WHERE state IN ('open', 'review')
               AND blocks_actions
               AND order_id = $1
             ORDER BY opened_at, id
             LIMIT 1
        `, [assetAnchor.order_id]));
    assetPlans.push(await control.query(`
            EXPLAIN (FORMAT JSON)
            SELECT id
              FROM asset_obligations
             WHERE state IN ('open', 'review')
               AND blocks_actions
               AND action_id = $1
             ORDER BY opened_at, id
             LIMIT 1
        `, [obsAction]));
    assetPlans.push(await control.query(`
            EXPLAIN (FORMAT JSON)
            SELECT id
              FROM asset_obligations
             WHERE state IN ('open', 'review')
               AND blocks_actions
               AND cluster = $1
               AND wallet_address = $2
               AND mint = $3
             ORDER BY opened_at, id
             LIMIT 1
        `, [assetAnchor.cluster, assetAnchor.wallet_address, assetAnchor.input_mint]));
    assetPlans.push(await control.query(`
            EXPLAIN (FORMAT JSON)
            SELECT id
              FROM order_intents
             WHERE cluster = $1
               AND wallet_address = $2
               AND state IN (
                   'preparing', 'prepared', 'activating', 'open', 'executing',
                   'partially_filled', 'cancel_pending', 'expired'
               )
               AND $3 IN (input_mint, output_mint)
             ORDER BY id
        `, [assetAnchor.cluster, assetAnchor.wallet_address, assetAnchor.input_mint]));
    for (const [planRows, indexName] of [
        [assetPlans[0].rows, 'asset_obligations_order_block_idx'],
        [assetPlans[1].rows, 'asset_obligations_action_block_idx'],
        [assetPlans[2].rows, 'asset_obligations_scope_block_idx'],
        [assetPlans[3].rows, 'order_intents_action_scope_idx'],
    ]) {
        if (!JSON.stringify(planRows).includes(indexName)) {
            throw new Error(`Recovered asset-circuit query plan does not use ${indexName}`);
        }
    }
    const orderIndexes = await control.query(`
        SELECT relation.relname, index_row.indisunique
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          JOIN pg_index index_row ON index_row.indexrelid = relation.oid
         WHERE namespace.nspname = 'public'
           AND relation.relname = ANY($1::text[])
           AND index_row.indisvalid
           AND index_row.indisready
    `, [[
        'action_attempts_deadline_idx',
        'order_tx_blobs_expiry_idx',
        'order_schedules_fill_idx',
        'order_anomalies_resolved_journal_idx',
        'order_actions_provider_due_idx',
        'order_actions_predecessor_idx',
        'action_obs_fact_idx',
        'action_obs_supersedes_idx',
        'order_intents_unknown_op_idx',
        'order_intents_op_cutover_idx',
        'asset_obligations_order_block_idx',
        'asset_obligations_action_block_idx',
        'asset_obligations_scope_block_idx',
        'order_intents_action_scope_idx',
    ]]);
    const unique = ['order_schedules_fill_idx', 'action_obs_fact_idx', 'action_obs_supersedes_idx'];
    if (orderIndexes.rowCount !== 14
        || unique.some((name) => !orderIndexes.rows.find((row) => row.relname === name)?.indisunique)) {
        throw new Error(
            'Order recovery indexes are incomplete after V017, V020, V024, V025, V028, V029, V038, V040, and V051-V053.1 repair'
        );
    }
    await close(control);
    console.log(`index recovery: V007, V008, V017, V020, V024, V025, V028, V029, V038, V040, and V051-V053.1 guarded repair passed with ${stats.writes + obsStats.writes + assetStats.writes} concurrent writes (max ${Math.max(stats.maxMs, obsStats.maxMs, assetStats.maxMs)} ms)`);
} finally {
    writerRun = false;
    if (writerTask) {
        try {
            await writerTask;
        } catch {
            // The primary drill failure remains authoritative.
        }
    }
    await Promise.allSettled([...clients].map((client) => client.end()));
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [name]);
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
}
