import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pullFlyway, runFlyway } from '../../db/tools/flyway-runner.mjs';
import { toJdbc } from '../../db/tools/migration-config.mjs';

const source = process.env.DATABASE_URL;
if (!source) throw new Error('DATABASE_URL is required');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const timeoutMs = Number(process.env.MIGRATION_TIMEOUT_MS ?? 600_000);
const name = `fervor_order_${process.pid}_${randomBytes(4).toString('hex')}`;
const badName = `${name}_bad_event`;
const policyName = `${name}_bad_policy`;
const cutoverName = `${name}_bad_cutover`;
const shapeName = `${name}_bad_op_index`;
const adminUrl = new URL(source);
adminUrl.pathname = '/postgres';
const dbUrl = new URL(source);
dbUrl.pathname = `/${name}`;
const badUrl = new URL(source);
badUrl.pathname = `/${badName}`;
const policyUrl = new URL(source);
policyUrl.pathname = `/${policyName}`;
const cutoverUrl = new URL(source);
cutoverUrl.pathname = `/${cutoverName}`;
const shapeUrl = new URL(source);
shapeUrl.pathname = `/${shapeName}`;
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const clients = new Set();
let writerRun = false;
let writerTask;
let madeRuntimeRole = false;
let madeMaintenanceRole = false;

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

const migrate = (target, targetUrl = dbUrl) => runFlyway({
    root,
    plane: 'core',
    target: toJdbc(targetUrl.toString(), 'CORE'),
    command: 'migrate',
    timeoutMs,
    extra: [`-target=${target}`],
    capture: true,
});

const rejectBadEventUpgrade = async () => {
    if (!/^fervor_order_[a-zA-Z0-9_]+$/.test(badName)) {
        throw new Error('Unsafe mismatched-event database name');
    }
    await admin.query(`CREATE DATABASE "${badName}"`);
    await migrate('015', badUrl);
    const bad = new pg.Client({ connectionString: badUrl.toString() });
    await bad.connect();
    try {
        const userId = randomUUID();
        const orderId = randomUUID();
        const eventId = randomUUID();
        const at = new Date().toISOString();
        const wallet = `BadEventWallet${randomBytes(8).toString('hex')}`;
        await bad.query(
            'INSERT INTO users (id, wallet_address) VALUES ($1, $2)',
            [userId, wallet]
        );
        await bad.query(`
            INSERT INTO order_intents (
                id, user_id, provider, client_order_id, request_digest, wallet_address,
                order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                params, expires_at
            ) VALUES (
                $1, $2, 'fixture', 'bad-event-upgrade', repeat('a', 64), $3,
                'single', 'open', $4, $5, 1, $5, '{}'::jsonb,
                clock_timestamp() + INTERVAL '1 day'
            )
        `, [orderId, userId, wallet,
            'So11111111111111111111111111111111111111112',
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']);
        await bad.query(`
            INSERT INTO order_event_keys (
                event_key, event_id, order_id, event_type, order_ver, event_hash, occurred_at
            ) VALUES ('upgrade:event:corrupt', $1, $2, 'upgrade.corrupt', 0, repeat('b', 64), $3)
        `, [eventId, orderId, at]);
        await bad.query('ALTER TABLE order_events DISABLE TRIGGER order_events_guard');
        await bad.query(`
            INSERT INTO order_events (
                id, order_id, state, occurred_at, event_key, event_type,
                event_hash, order_ver, trace_id, actor_kind
            ) VALUES (
                gen_random_uuid(), $1, 'open', $2, 'upgrade:event:corrupt',
                'upgrade.corrupt', repeat('c', 64), 0, 'trace-corrupt', 'system'
            )
        `, [orderId, at]);
        await bad.query('ALTER TABLE order_events ENABLE TRIGGER order_events_guard');
    } finally {
        await bad.end();
    }
    let rejected = false;
    try {
        await migrate('030', badUrl);
    } catch (error) {
        rejected = error instanceof Error;
    }
    if (!rejected) throw new Error('V019 accepted a mismatched legacy event reservation claim');
};

const rejectBadPolicyUpgrade = async () => {
    if (!/^fervor_order_[a-zA-Z0-9_]+$/.test(policyName)) {
        throw new Error('Unsafe invalid-policy database name');
    }
    await admin.query(`CREATE DATABASE "${policyName}"`);
    await migrate('015', policyUrl);
    const bad = new pg.Client({ connectionString: policyUrl.toString() });
    await bad.connect();
    try {
        const userId = randomUUID();
        const orderId = randomUUID();
        const actionId = randomUUID();
        const attemptId = randomUUID();
        const wallet = `BadPolicyWallet${randomBytes(8).toString('hex')}`;
        await bad.query('INSERT INTO users (id, wallet_address) VALUES ($1, $2)', [userId, wallet]);
        await bad.query(`
            INSERT INTO order_intents (
                id, user_id, provider, client_order_id, request_digest, wallet_address,
                order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                params, expires_at
            ) VALUES (
                $1, $2, 'fixture', 'bad-policy-upgrade', repeat('a', 64), $3,
                'single', 'open', $4, $5, 1, $5, '{}'::jsonb,
                clock_timestamp() + INTERVAL '1 day'
            )
        `, [orderId, userId, wallet,
            'So11111111111111111111111111111111111111112',
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']);
        await bad.query(`
            INSERT INTO order_epochs (
                scope, epoch, region, mode, authority, proof_hash, source_key
            ) VALUES (
                'provider:fixture', 1, 'ci', 'live', 'upgrade',
                repeat('b', 64), 'bad-policy:epoch'
            )
        `);
        await bad.query('ALTER TABLE order_actions DISABLE TRIGGER order_actions_guard');
        await bad.query(`
            INSERT INTO order_actions (
                id, order_id, user_id, kind, client_key, req_hash, desired_hash,
                expected_ver, action_ver, work_state, effect_state, outcome,
                provider, attempt_count, due_at, lease_owner, lease_gen,
                lease_until, write_scope, write_epoch, ambiguity_at
            ) VALUES (
                $1, $2, $3, 'provider_sync', 'bad-policy', repeat('c', 64),
                repeat('d', 64), 0, 1, 'dispatching', 'possible', 'pending',
                'fixture', 1, clock_timestamp(), 'bad-policy-worker', 1,
                clock_timestamp() + INTERVAL '1 hour', 'provider:fixture', 1,
                clock_timestamp()
            )
        `, [actionId, orderId, userId]);
        await bad.query('ALTER TABLE order_actions ENABLE TRIGGER order_actions_guard');
        await bad.query('ALTER TABLE action_attempts DISABLE TRIGGER action_attempts_guard');
        await bad.query(`
            INSERT INTO action_attempts (
                id, action_id, seq, lease_gen, write_scope, write_epoch,
                endpoint, method, provider, req_hash, desired_hash, send_state,
                started_at, deadline_at, completed_at, http_class, error_code
            ) VALUES (
                $1, $2, 1, 1, 'provider:fixture', 1, '/bad-policy', 'GET',
                'fixture', repeat('c', 64), repeat('d', 64), 'response_recorded',
                clock_timestamp() - INTERVAL '2 seconds',
                clock_timestamp() + INTERVAL '1 minute',
                clock_timestamp() - INTERVAL '1 second',
                'server_error', 'provider_error'
            )
        `, [attemptId, actionId]);
        await bad.query('ALTER TABLE action_attempts ENABLE TRIGGER action_attempts_guard');
    } finally {
        await bad.end();
    }

    await migrate('022', policyUrl);
    let rejected = false;
    try {
        await migrate('022.1', policyUrl);
    } catch (error) {
        rejected = error instanceof Error;
    }
    if (!rejected) throw new Error('V022.1 accepted a historical invalid response policy fact');
};

const rejectLegacyWriterCutover = async () => {
    if (!/^fervor_order_[a-zA-Z0-9_]+$/.test(cutoverName)) {
        throw new Error('Unsafe legacy-writer database name');
    }
    await admin.query(`CREATE DATABASE "${cutoverName}"`);
    await migrate('039', cutoverUrl);
    const legacy = new pg.Client({ connectionString: cutoverUrl.toString() });
    await legacy.connect();
    try {
        const userId = randomUUID();
        const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
        await legacy.query('INSERT INTO users (id, wallet_address) VALUES ($1, $2)', [userId, wallet]);
        await legacy.query(`
            INSERT INTO order_intents (
                id, user_id, provider, client_order_id, request_digest, wallet_address,
                order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                params, expires_at, op_token, op_lease_until
            ) VALUES (
                gen_random_uuid(), $1, 'legacy', 'legacy-cutover', repeat('a', 64), $2,
                'single', 'preparing', $3, $4, 1, $4, '{}'::jsonb,
                clock_timestamp() + INTERVAL '1 day', 'legacy-writer-token',
                clock_timestamp() + INTERVAL '1 minute'
            )
        `, [userId, wallet,
            'So11111111111111111111111111111111111111112',
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']);
    } finally {
        await legacy.end();
    }
    await migrate('040', cutoverUrl);
    let rejected = false;
    try {
        await migrate('041', cutoverUrl);
    } catch (error) {
        rejected = error instanceof Error;
    }
    if (!rejected) throw new Error('V041 accepted an undrained prior mutation writer');
};

const rejectBadCutoverIndex = async () => {
    if (!/^fervor_order_[a-zA-Z0-9_]+$/.test(shapeName)) {
        throw new Error('Unsafe cutover-index database name');
    }
    await admin.query(`CREATE DATABASE "${shapeName}"`);
    await migrate('043', shapeUrl);
    const shape = new pg.Client({ connectionString: shapeUrl.toString() });
    await shape.connect();
    try {
        await shape.query('DROP INDEX order_intents_op_cutover_idx');
        await shape.query(`
            CREATE INDEX order_intents_op_cutover_idx
                ON order_intents (user_id)
                WHERE op_token IS NOT NULL
                   OR op_lease_until IS NOT NULL
                   OR op_state IS NOT NULL
                   OR error_code = 'provider_outcome_unknown'
        `);
    } finally {
        await shape.end();
    }
    let rejected = false;
    try {
        await migrate('044', shapeUrl);
    } catch (error) {
        rejected = error instanceof Error;
    }
    if (!rejected) throw new Error('V044 accepted a mismatched operation audit index');
};

const expectReject = async (operation, label) => {
    try {
        await operation();
    } catch (error) {
        const expectedCodes = new Set([
            '22023', '23503', '23505', '23514', '25001', '40001', '55000',
        ]);
        if (!(error instanceof Error) || !expectedCodes.has(error.code)) {
            throw new Error(`Order schema rejected ${label} for an unexpected reason`, { cause: error });
        }
        return error;
    }
    throw new Error(`Order schema accepted ${label}`);
};

const policy = JSON.parse(fs.readFileSync(
    path.join(root, 'backend/src/contracts/orderPolicy.json'), 'utf8'
));
if (policy.version !== 1) throw new Error('Order action policy version is unsupported');
const exactKeys = (value, expected, name) => {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
        throw new Error(`Order ${name} policy keys do not match the action contract`);
    }
};
exactKeys(policy.dispatch, policy.actions, 'dispatch');
exactKeys(policy.evidence, policy.actions, 'evidence');
exactKeys(policy.http, policy.httpClasses, 'HTTP');
exactKeys(policy.proof, [
    'providerAbsence', 'providerAbsenceQuery', 'chainAbsenceQuery',
], 'proof');
const dispatchRules = policy.dispatch;

const statusValid = (kind, status) => {
    const rule = policy.http[kind];
    return rule.ranges.some(([low, high]) => status >= low && status <= high)
        && !rule.exclude.includes(status);
};

const waitForLock = async (control, appName) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await control.query(`
            SELECT wait_event_type, wait_event
              FROM pg_stat_activity
             WHERE datname = current_database()
               AND application_name = $1
               AND wait_event IS NOT NULL
        `, [appName]);
        if (result.rowCount === 1) return result.rows[0];
        await delay(20);
    }
    throw new Error(`${appName} did not reach its intended lock wait`);
};

const waitForRelationLock = async (control, relation, mode) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const result = await control.query(`
            SELECT activity.wait_event_type, activity.wait_event
              FROM pg_locks relation_lock
              JOIN pg_stat_activity activity ON activity.pid = relation_lock.pid
             WHERE relation_lock.database = (SELECT oid FROM pg_database WHERE datname = current_database())
               AND relation_lock.relation = $1::regclass
               AND relation_lock.mode = $2
               AND NOT relation_lock.granted
        `, [relation, mode]);
        if (result.rowCount === 1) return result.rows[0];
        await delay(20);
    }
    throw new Error(`${relation} did not reach its intended ${mode} wait`);
};

const startWriter = async (userId, wallet, inputMint, outputMint) => {
    const writer = await open();
    const stats = { writes: 0, maxMs: 0 };
    writerRun = true;
    writerTask = (async () => {
        while (writerRun) {
            const started = Date.now();
            const key = `live-${stats.writes}-${randomUUID()}`;
            await writer.query(`
                INSERT INTO order_intents (
                    id, user_id, provider, client_order_id, request_digest, wallet_address,
                    order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                    params, expires_at
                ) VALUES (
                    gen_random_uuid(), $1, 'legacy', $2::text, repeat(md5($2::text), 2), $3,
                    'single', 'preparing', $4, $5, 1, $5, '{}'::jsonb,
                    CURRENT_TIMESTAMP + INTERVAL '1 day'
                )
            `, [userId, key, wallet, inputMint, outputMint]);
            stats.writes += 1;
            stats.maxMs = Math.max(stats.maxMs, Date.now() - started);
            await delay(2);
        }
        await close(writer);
        return stats;
    })();
    writerTask.catch(() => {
        // stopWriter or the outer cleanup observes the authoritative failure.
    });
    return stats;
};

const stopWriter = async () => {
    writerRun = false;
    return writerTask ? writerTask : { writes: 0, maxMs: 0 };
};

await pullFlyway();
await admin.connect();
try {
    const runtimeRole = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'core_runtime'");
    const maintenanceRole = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'core_maintenance'");
    if (runtimeRole.rowCount === 0 || maintenanceRole.rowCount === 0) {
        let roleGuarded = false;
        try {
            await runFlyway({
                root,
                plane: 'core',
                target: toJdbc(adminUrl.toString(), 'CORE'),
                command: 'validate',
                timeoutMs,
                configFiles: '/flyway/db/flyway/core.conf,/flyway/db/flyway/core-production.conf',
                capture: true,
            });
        } catch (error) {
            roleGuarded = error instanceof Error
                && [error.message, error.stdout, error.stderr]
                    .some((value) => String(value || '').includes('required core transaction roles are missing or unsafe'));
        }
        if (!roleGuarded) throw new Error('Production migration preflight accepted missing transaction roles');
    }
    if (runtimeRole.rowCount === 0) {
        await admin.query('CREATE ROLE core_runtime NOLOGIN');
        await admin.query('GRANT core_runtime TO CURRENT_USER');
        madeRuntimeRole = true;
    }
    if (maintenanceRole.rowCount === 0) {
        await admin.query('CREATE ROLE core_maintenance NOLOGIN');
        await admin.query('GRANT core_maintenance TO CURRENT_USER');
        madeMaintenanceRole = true;
    }
    if (!/^fervor_order_[a-zA-Z0-9_]+$/.test(name)) throw new Error('Unsafe order schema database name');
    await admin.query(`CREATE DATABASE "${name}"`);
    await migrate('014');

    const db = await open();
    const userId = randomUUID();
    const orderId = randomUUID();
    const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
    const inputMint = 'So11111111111111111111111111111111111111112';
    const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    await db.query('INSERT INTO users (id, wallet_address) VALUES ($1, $2)', [userId, wallet]);
    await db.query(`
        INSERT INTO order_intents (
            id, user_id, provider, client_order_id, request_digest, wallet_address,
            order_type, state, input_mint, output_mint, input_amount, trigger_mint,
            params, expires_at
        ) VALUES (
            $1, $2, 'fixture', 'legacy-anchor', repeat('a', 64), $3,
            'single', 'open', $4, $5, 1000, $5, '{}'::jsonb,
            CURRENT_TIMESTAMP + INTERVAL '1 day'
        )
    `, [orderId, userId, wallet, inputMint, outputMint]);
    await db.query(`
        INSERT INTO order_intents (
            id, user_id, provider, client_order_id, request_digest, wallet_address,
            order_type, state, input_mint, output_mint, input_amount, trigger_mint,
            params, expires_at
        )
        SELECT gen_random_uuid(), $1, 'legacy', 'seed-' || n, repeat(md5('seed-' || n), 2),
               $2, 'single', 'filled', $3, $4, 1, $4, '{}'::jsonb,
               CURRENT_TIMESTAMP + INTERVAL '1 day'
          FROM generate_series(1, 20000) AS n
    `, [userId, wallet, inputMint, outputMint]);

    const live = await startWriter(userId, wallet, inputMint, outputMint);
    await delay(25);
    await migrate('015');
    const stats = await stopWriter();
    if (stats.writes < 5 || stats.writes !== live.writes || stats.maxMs > 5_000) {
        throw new Error(`Legacy writer was not healthy through V015: ${JSON.stringify(stats)}`);
    }

    const legacy = await db.query(`
        SELECT cluster, family, strategy_kind, trigger_state, fill_state,
               funds_state, remaining_in, filled_in, filled_out, order_ver, req_ver
          FROM order_intents WHERE id = $1
    `, [orderId]);
    if (legacy.rowCount !== 1
        || legacy.rows[0].order_ver !== '0'
        || Object.entries(legacy.rows[0]).some(([key, value]) => key !== 'order_ver' && value !== null)) {
        throw new Error('V015 rewrote the legacy aggregate instead of expanding it');
    }

    const nMinusOne = randomUUID();
    await db.query(`
        INSERT INTO order_intents (
            id, user_id, provider, client_order_id, request_digest, wallet_address,
            order_type, state, input_mint, output_mint, input_amount, trigger_mint,
            params, expires_at
        ) VALUES (
            $1, $2, 'legacy', 'post-v15-n-minus-one', repeat('b', 64), $3,
            'single', 'preparing', $4, $5, 1, $5, '{}'::jsonb,
            CURRENT_TIMESTAMP + INTERVAL '1 day'
        )
    `, [nMinusOne, userId, wallet, inputMint, outputMint]);
    const compatible = await db.query('SELECT order_ver, cluster FROM order_intents WHERE id = $1', [nMinusOne]);
    if (compatible.rows[0].order_ver !== '0' || compatible.rows[0].cluster !== null) {
        throw new Error('N-1 order writes did not retain the compatibility defaults');
    }

    const pendingKey = 'upgrade:event:pending';
    const pendingId = randomUUID();
    const pendingAt = new Date().toISOString();
    await db.query(`
        INSERT INTO order_event_keys (
            event_key, event_id, order_id, event_type, order_ver, event_hash, occurred_at
        ) VALUES ($1, $2, $3, 'upgrade.pending', 0, repeat('1', 64), $4)
    `, [pendingKey, pendingId, orderId, pendingAt]);

    const exactKey = 'upgrade:event:exact';
    const exactId = randomUUID();
    const exactAt = new Date().toISOString();
    await db.query(`
        INSERT INTO order_event_keys (
            event_key, event_id, order_id, event_type, order_ver, event_hash, occurred_at
        ) VALUES ($1, $2, $3, 'upgrade.exact', 0, repeat('5', 64), $4)
    `, [exactKey, exactId, orderId, exactAt]);
    await db.query(`
        INSERT INTO order_events (
            id, order_id, state, metadata, occurred_at, event_key, event_type,
            event_hash, order_ver, trace_id, actor_kind
        ) VALUES (
            $1, $2, 'open', '{"upgrade":"exact"}'::jsonb, $3, $4,
            'upgrade.exact', repeat('5', 64), 0, 'trace-upgrade-exact', 'system'
        )
    `, [exactId, orderId, exactAt, exactKey]);

    const upgradeAction = randomUUID();
    await db.query(`
        INSERT INTO order_epochs (scope, epoch, region, mode, authority, proof_hash, source_key)
        VALUES ('provider:upgrade', 1, 'ci', 'live', 'upgrade', repeat('2', 64), 'upgrade:epoch:1')
    `);
    await db.query(`
        INSERT INTO order_actions (
            id, order_id, user_id, kind, client_key, req_hash, desired_hash,
            expected_ver, work_state, effect_state, outcome, provider, due_at,
            lease_owner, lease_gen, lease_until, write_scope, write_epoch, completed_at
        ) VALUES (
            $1, $2, $3, 'provider_sync', 'upgrade-terminal', repeat('3', 64), repeat('4', 64),
            0, 'done', 'present', 'succeeded', 'upgrade', clock_timestamp(),
            'stale-upgrade-worker', 1, clock_timestamp() + INTERVAL '1 day',
            'provider:upgrade', 1, clock_timestamp()
        )
    `, [upgradeAction, orderId, userId]);

    await migrate('023');
    const stagedIndexes = await db.query(`
        SELECT to_regclass('public.action_obs_fact_idx') AS fact_idx,
               to_regclass('public.action_obs_supersedes_idx') AS lineage_idx
    `);
    if (stagedIndexes.rows[0].fact_idx !== null
        || stagedIndexes.rows[0].lineage_idx !== null) {
        throw new Error('V023 built observation uniqueness with a write-blocking index');
    }
    const legacyObs = '00000000-0000-4000-8000-000000000001';
    const lineageBase = randomUUID();
    await db.query(`
        INSERT INTO action_obs (
            id, action_id, source, cluster, source_key, query_kind, provider,
            desired_hash, payload_hash, payload_ver, payload
        ) VALUES (
            $1, $2, 'provider', 'mainnet-beta', 'upgrade:legacy:source',
            'queried_no_evidence', 'upgrade', repeat('4', 64), repeat('7', 64), 1, '{}'
        )
    `, [legacyObs, upgradeAction]);
    const legacyShape = await db.query(`
        SELECT fact_key, verdict, predicate
          FROM action_obs
         WHERE id = $1
    `, [legacyObs]);
    if (legacyShape.rows[0]?.fact_key !== null
        || legacyShape.rows[0]?.verdict !== 'context'
        || legacyShape.rows[0]?.predicate !== 'legacy_unqualified') {
        throw new Error('V023 did not retain a V015 observation as non-decisive context');
    }

    const isolation = await open();
    await isolation.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await expectReject(() => isolation.query(`
        INSERT INTO action_obs (
            id, action_id, source, cluster, source_key, fact_key, fact_rev,
            query_kind, verdict, predicate, rule_ver, provider, desired_hash,
            payload_hash, payload_ver, payload
        ) VALUES (
            gen_random_uuid(), $1, 'provider', 'mainnet-beta',
            'upgrade:isolation:source', 'upgrade:isolation:fact', 1,
            'unchecked', 'context', 'provider_sync.provider.effect.v1', 1,
            'upgrade', repeat('4', 64), repeat('8', 64), 1, '{}'
        )
    `, [upgradeAction]), 'a repeatable-read versioned observation before uniqueness indexes');
    await isolation.query('ROLLBACK');
    await close(isolation);

    await db.query(`
        INSERT INTO action_obs (
            id, action_id, source, cluster, source_key, fact_key, fact_rev,
            query_kind, verdict, predicate, rule_ver, provider, desired_hash,
            effect_hash, provider_order_id, payload_hash, payload_ver, payload
        ) VALUES (
            $2, $1, 'provider', 'mainnet-beta',
            'upgrade:race:base-source', 'upgrade:race:base-fact', 1,
            'found', 'presence', 'provider_sync.provider.effect.v1', 1,
            'upgrade', repeat('4', 64), repeat('4', 64), 'upgrade-race-order',
            repeat('8', 64), 1, '{}'
        )
    `, [upgradeAction, lineageBase]);

    const raceFact = 'upgrade:race:fact';
    const raceInsert = `
        INSERT INTO action_obs (
            id, action_id, source, cluster, source_key, fact_key, fact_rev,
            query_kind, verdict, predicate, rule_ver, provider, desired_hash,
            payload_hash, payload_ver, payload
        ) VALUES (
            $1, $2, 'provider', 'mainnet-beta', $3, $4, 1,
            'unchecked', 'context', 'provider_sync.provider.effect.v1', 1,
            'upgrade', repeat('4', 64), repeat('9', 64), 1, '{}'
        )
    `;
    const raceA = await open();
    const raceB = await open();
    await Promise.all([raceA.query('BEGIN'), raceB.query('BEGIN')]);
    await raceA.query(raceInsert, [randomUUID(), upgradeAction, 'upgrade:race:a', raceFact]);
    let raceSettled = false;
    const raceBlocked = raceB.query(
        raceInsert,
        [randomUUID(), upgradeAction, 'upgrade:race:b', raceFact]
    ).then(
        () => { raceSettled = true; return { error: undefined }; },
        (error) => { raceSettled = true; return { error }; }
    );
    await delay(50);
    if (raceSettled) throw new Error('V023 duplicate fact race did not serialize');
    await raceA.query('COMMIT');
    await expectReject(async () => {
        const result = await raceBlocked;
        if (result.error !== undefined) throw result.error;
    }, 'a concurrent duplicate fact revision before V028');
    await raceB.query('ROLLBACK');
    await Promise.all([close(raceA), close(raceB)]);

    const successorInsert = `
        INSERT INTO action_obs (
            id, action_id, source, cluster, source_key, fact_key, fact_rev,
            supersedes, query_kind, verdict, predicate, rule_ver, provider,
            desired_hash, effect_hash, provider_order_id, payload_hash,
            payload_ver, payload
        ) VALUES (
            $1, $2, 'provider', 'mainnet-beta', $3,
            'upgrade:race:base-fact', 2, $4, 'found', 'presence',
            'provider_sync.provider.effect.v1', 1, 'upgrade', repeat('4', 64),
            repeat('4', 64), 'upgrade-race-order', repeat('a', 64), 1, '{}'
        )
    `;
    const successorA = await open();
    const successorB = await open();
    await Promise.all([successorA.query('BEGIN'), successorB.query('BEGIN')]);
    await successorA.query(successorInsert, [
        randomUUID(), upgradeAction, 'upgrade:successor:a', lineageBase,
    ]);
    let successorSettled = false;
    const successorBlocked = successorB.query(successorInsert, [
        randomUUID(), upgradeAction, 'upgrade:successor:b', lineageBase,
    ]).then(
        () => { successorSettled = true; return { error: undefined }; },
        (error) => { successorSettled = true; return { error }; }
    );
    await delay(50);
    if (successorSettled) throw new Error('V023 competing successor race did not serialize');
    await successorA.query('COMMIT');
    await expectReject(async () => {
        const result = await successorBlocked;
        if (result.error !== undefined) throw result.error;
    }, 'a competing observation successor before V029');
    await successorB.query('ROLLBACK');
    await Promise.all([close(successorA), close(successorB)]);
    const successorCount = await db.query(`
        SELECT count(*)::int AS count FROM action_obs WHERE supersedes = $1
    `, [lineageBase]);
    if (successorCount.rows[0].count !== 1) {
        throw new Error('V023 competing successor race did not leave exactly one lineage child');
    }

    const gapObs = randomUUID();
    const gapInsert = `
        INSERT INTO action_obs (
            id, action_id, source, cluster, source_key, fact_key, fact_rev,
            query_kind, verdict, predicate, rule_ver, provider, desired_hash,
            effect_hash, provider_order_id, payload_hash, payload_ver, payload
        ) VALUES (
            $1, $2, 'provider', 'mainnet-beta', 'upgrade:gap:source',
            'upgrade:gap:fact', 1, 'found', 'presence',
            'provider_sync.provider.effect.v1', 1, 'upgrade', repeat('4', 64),
            repeat('4', 64), 'upgrade-gap-order', repeat('6', 64), 1, '{}'
        )
        ON CONFLICT DO NOTHING
        RETURNING id
    `;
    const firstGap = await db.query(gapInsert, [gapObs, upgradeAction]);
    const replayGap = await db.query(gapInsert, [gapObs, upgradeAction]);
    if (firstGap.rowCount !== 1 || replayGap.rowCount !== 0) {
        throw new Error('V023 deployment gap did not preserve exact observation replay');
    }

    await migrate('026');
    const egressOrder = randomUUID();
    await db.query(`
        INSERT INTO order_intents (
            id, user_id, provider, client_order_id, request_digest, wallet_address,
            order_type, state, input_mint, output_mint, input_amount, trigger_mint,
            params, expires_at
        ) VALUES (
            $1, $2, 'upgrade', 'legacy-egress-order', repeat('9', 64), $3,
            'single', 'open', $4, $5, 1, $5, '{}'::jsonb,
            clock_timestamp() + INTERVAL '1 day'
        )
    `, [egressOrder, userId, wallet, inputMint, outputMint]);
    const prepareEgress = async (kind, deadlineMs = 60_000) => {
        const actionId = randomUUID();
        const attemptId = randomUUID();
        const reqHash = randomBytes(32).toString('hex');
        const desiredHash = randomBytes(32).toString('hex');
        const deadline = new Date(Date.now() + deadlineMs);
        await db.query(`
            INSERT INTO order_actions (
                id, order_id, user_id, kind, client_key, req_hash, desired_hash,
                expected_ver, work_state, effect_state, outcome, provider, due_at
            ) VALUES (
                $1, $2, $3, 'provider_sync', $4, $5, $6, 0,
                'queued', 'not_possible', 'pending', 'upgrade', clock_timestamp()
            )
        `, [actionId, egressOrder, userId, `legacy-egress-${kind}`, reqHash, desiredHash]);
        await db.query(`
            UPDATE order_actions
               SET action_ver = 1, lease_owner = 'legacy-egress-worker', lease_gen = 1,
                   lease_until = clock_timestamp() + INTERVAL '2 minutes',
                   write_scope = 'provider:upgrade', write_epoch = 1
             WHERE id = $1
        `, [actionId]);
        await db.query(`
            UPDATE order_actions SET action_ver = 2, work_state = 'ready' WHERE id = $1
        `, [actionId]);
        await db.query(`
            UPDATE order_actions
               SET action_ver = 3, work_state = 'dispatching', effect_state = 'possible',
                   attempt_count = 1, ambiguity_at = clock_timestamp()
             WHERE id = $1
        `, [actionId]);
        await db.query(`
            INSERT INTO action_attempts (
                id, action_id, seq, lease_gen, write_scope, write_epoch,
                endpoint, method, provider, req_hash, desired_hash, send_state,
                started_at, deadline_at
            ) VALUES (
                $1, $2, 1, 1, 'provider:upgrade', 1, $3, 'GET', 'upgrade',
                $4, $5, 'started', clock_timestamp(), $6
            )
        `, [attemptId, actionId, `/legacy-egress/${kind}`, reqHash, desiredHash, deadline]);
        return { actionId, attemptId, deadline };
    };
    const legacyInsert = `
        INSERT INTO action_egress (
            attempt_id, action_id, lease_owner, lease_gen, write_scope,
            write_epoch, provider, endpoint, method, req_hash, body_hash,
            desired_hash, blob_action_id
        )
        SELECT attempt.id, action.id, action.lease_owner, attempt.lease_gen,
               attempt.write_scope, attempt.write_epoch, attempt.provider,
               attempt.endpoint, attempt.method, attempt.req_hash,
               attempt.body_hash, attempt.desired_hash, attempt.blob_action_id
          FROM order_actions action
          JOIN action_attempts attempt ON attempt.action_id = action.id
         WHERE action.id = $1 AND attempt.id = $2
    `;
    const legacyKinds = ['completed', 'concurrent', 'rolling', 'reserved', 'expired'];
    const legacyEgress = new Map();
    for (const kind of legacyKinds) {
        const prepared = await prepareEgress(kind, kind === 'expired' ? 2_000 : 60_000);
        legacyEgress.set(kind, prepared);
        await db.query(legacyInsert, [prepared.actionId, prepared.attemptId]);
    }

    await db.query(`
        UPDATE action_egress SET completed_at = clock_timestamp() WHERE attempt_id = $1
    `, [legacyEgress.get('completed').attemptId]);

    const oldWriter = await open();
    await oldWriter.query('BEGIN');
    await oldWriter.query(`
        UPDATE action_egress SET completed_at = clock_timestamp() WHERE attempt_id = $1
    `, [legacyEgress.get('concurrent').attemptId]);
    let deploySettled = false;
    let deployError;
    const deployV30 = migrate('030')
        .catch((error) => { deployError = error; })
        .finally(() => { deploySettled = true; });
    await delay(100);
    const deployWaited = !deploySettled;
    await oldWriter.query('COMMIT');
    await close(oldWriter);
    await deployV30;
    if (deployError) throw deployError;
    if (!deployWaited) {
        throw new Error('V030 did not wait for the concurrent N-1 completion transaction');
    }

    await db.query(`
        UPDATE action_egress SET completed_at = clock_timestamp() WHERE attempt_id = $1
    `, [legacyEgress.get('rolling').attemptId]);
    await migrate('031');
    await db.query(`
        UPDATE action_egress SET completed_at = clock_timestamp() WHERE attempt_id = $1
    `, [legacyEgress.get('reserved').attemptId]);

    const expired = legacyEgress.get('expired');
    await delay(Math.max(0, expired.deadline.getTime() - Date.now()) + 25);
    await expectReject(() => db.query(`
        UPDATE action_egress SET started_at = clock_timestamp() WHERE attempt_id = $1
    `, [expired.attemptId]), 'V031 transport start after its PostgreSQL deadline');
    await db.query(`
        UPDATE action_egress
           SET completed_at = clock_timestamp(), end_kind = 'deadline_before_start'
         WHERE attempt_id = $1
    `, [expired.attemptId]);

    const phaseRows = await db.query(`
        SELECT attempt_id, forwarded_at, started_at, completed_at, phase_ver, end_kind
          FROM action_egress
         WHERE attempt_id = ANY($1::uuid[])
    `, [[...legacyEgress.values()].map((value) => value.attemptId)]);
    const phase = (kind) => phaseRows.rows.find(
        (row) => row.attempt_id === legacyEgress.get(kind).attemptId
    );
    for (const kind of ['completed', 'concurrent']) {
        if (phase(kind)?.started_at !== null || phase(kind)?.completed_at === null
            || phase(kind)?.phase_ver !== null || phase(kind)?.end_kind !== null) {
            throw new Error(`V031 changed the immutable V026 ${kind} compatibility fact`);
        }
    }
    if (phase('rolling')?.started_at?.getTime() !== phase('rolling')?.forwarded_at?.getTime()
        || phase('rolling')?.completed_at === null || phase('rolling')?.phase_ver !== null
        || phase('rolling')?.end_kind !== null) {
        throw new Error('V030 did not promote an N-1 rolling completion from its V026 boundary');
    }
    if (phase('reserved')?.started_at?.getTime() !== phase('reserved')?.forwarded_at?.getTime()
        || phase('reserved')?.completed_at === null || phase('reserved')?.phase_ver !== 2
        || phase('reserved')?.end_kind !== 'legacy_settled') {
        throw new Error('V031 did not label an N-1 direct completion explicitly');
    }
    if (phase('expired')?.started_at !== null || phase('expired')?.completed_at === null
        || phase('expired')?.phase_ver !== 2
        || phase('expired')?.end_kind !== 'deadline_before_start') {
        throw new Error('V031 did not durably close the reserved attempt before transport start');
    }
    const expiredInflight = await db.query(`
        SELECT count(*)::int AS count
          FROM action_egress
         WHERE completed_at IS NULL AND attempt_id = $1
    `, [expired.attemptId]);
    if (expiredInflight.rows[0].count !== 0) {
        throw new Error('V031 no-start terminal fact remained in the in-flight egress set');
    }
    await migrate('033');

    const cutover = await prepareEgress('cutover');
    const reservation = await open();
    const epochWriter = await open();
    await reservation.query('BEGIN');
    await reservation.query(legacyInsert, [cutover.actionId, cutover.attemptId]);
    let epochSettled = false;
    const epochAdvance = epochWriter.query(`
        INSERT INTO order_epochs (
            scope, epoch, region, mode, authority, proof_hash, source_key
        ) VALUES (
            'provider:upgrade', 2, 'ci', 'frozen', 'isolation-test',
            repeat('d', 64), 'upgrade:epoch-isolation:read-committed'
        )
    `).then(
        () => { epochSettled = true; return { error: undefined }; },
        (error) => { epochSettled = true; return { error }; }
    );
    await delay(50);
    if (epochSettled) {
        throw new Error('read committed epoch advancement did not wait for egress reservation');
    }
    await reservation.query('COMMIT');
    const epochResult = await epochAdvance;
    if (epochResult.error?.code !== '55P03') {
        throw epochResult.error ?? new Error(
            'read committed epoch advancement ignored a newly committed egress reservation'
        );
    }
    await db.query(`
        UPDATE action_egress SET completed_at = clock_timestamp() WHERE attempt_id = $1
    `, [cutover.attemptId]);
    await Promise.all([close(reservation), close(epochWriter)]);

    for (const [isolationLevel, label] of [
        ['REPEATABLE READ', 'repeatable read write epoch advancement'],
        ['SERIALIZABLE', 'serializable write epoch advancement'],
    ]) {
        const epochWriter = await open();
        await epochWriter.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
        await expectReject(() => epochWriter.query(`
            INSERT INTO order_epochs (
                scope, epoch, region, mode, authority, proof_hash, source_key
            ) VALUES (
                $1, 1, 'ci', 'live', 'isolation-test', repeat('d', 64), $2
            )
        `, [
            `provider:isolation-${isolationLevel.toLowerCase().replaceAll(' ', '-')}`,
            `upgrade:epoch-isolation:${isolationLevel}`,
        ]), label);
        await epochWriter.query('ROLLBACK');
        await close(epochWriter);
    }

    await migrate('035');
    const recoveryRows = [];
    for (const kind of ['recoverable-a', 'recoverable-b', 'legacy-crash']) {
        recoveryRows.push(await prepareEgress(kind, 2_000));
    }
    const versionedInsert = `
        INSERT INTO action_egress (
            attempt_id, action_id, lease_owner, lease_gen, write_scope,
            write_epoch, provider, endpoint, method, req_hash, body_hash,
            desired_hash, blob_action_id, writer_ver
        )
        SELECT attempt.id, action.id, action.lease_owner, attempt.lease_gen,
               attempt.write_scope, attempt.write_epoch, attempt.provider,
               attempt.endpoint, attempt.method, attempt.req_hash,
               attempt.body_hash, attempt.desired_hash, attempt.blob_action_id, $3
          FROM order_actions action
          JOIN action_attempts attempt ON attempt.action_id = action.id
         WHERE action.id = $1 AND attempt.id = $2
    `;
    for (const [index, row] of recoveryRows.entries()) {
        await db.query(versionedInsert, [
            row.actionId, row.attemptId, index < 2 ? 2 : null,
        ]);
    }
    await delay(Math.max(
        0,
        ...recoveryRows.map((row) => row.deadline.getTime() - Date.now())
    ) + 25);
    const lockedId = recoveryRows[0].attemptId;
    const lockClient = await open();
    const recoverer = await open();
    await lockClient.query('BEGIN');
    await lockClient.query(
        'SELECT attempt_id FROM action_egress WHERE attempt_id = $1 FOR UPDATE',
        [lockedId]
    );
    await recoverer.query("SET statement_timeout = '500ms'");
    const skipped = await recoverer.query(
        'SELECT attempt_id FROM recover_action_egress(1)'
    );
    if (skipped.rowCount !== 1 || skipped.rows[0].attempt_id === lockedId) {
        throw new Error('V034 recovery did not skip a contended egress row');
    }
    await lockClient.query('COMMIT');
    const unlocked = await recoverer.query(
        'SELECT attempt_id FROM recover_action_egress(1)'
    );
    await Promise.all([close(lockClient), close(recoverer)]);
    const recoveredIds = [...skipped.rows, ...unlocked.rows]
        .map((row) => row.attempt_id).sort();
    const expectedRecovered = recoveryRows.slice(0, 2)
        .map((row) => row.attemptId).sort();
    if (JSON.stringify(recoveredIds) !== JSON.stringify(expectedRecovered)) {
        throw new Error('V034 did not recover each trusted never-started reservation exactly once');
    }
    const recoveryFacts = await db.query(`
        SELECT attempt_id, writer_ver, started_at, completed_at, end_kind
          FROM action_egress
         WHERE attempt_id = ANY($1::uuid[])
         ORDER BY attempt_id
    `, [recoveryRows.map((row) => row.attemptId)]);
    const legacyCrash = recoveryFacts.rows.find(
        (row) => row.attempt_id === recoveryRows[2].attemptId
    );
    if (legacyCrash?.writer_ver !== null || legacyCrash?.completed_at !== null) {
        throw new Error('V034 swept an ambiguous legacy reservation');
    }
    for (const row of recoveryFacts.rows.filter((fact) => fact.writer_ver === 2)) {
        if (row.started_at !== null || row.completed_at === null
            || row.end_kind !== 'deadline_before_start') {
            throw new Error('V034 wrote an invalid recovered terminal fact');
        }
    }
    await expectReject(
        () => db.query('SELECT attempt_id FROM recover_action_egress(0)'),
        'an unbounded egress recovery batch'
    );
    await expectReject(
        () => db.query('SELECT attempt_id FROM recover_action_egress(NULL)'),
        'a null egress recovery batch'
    );
    await db.query(`
        UPDATE action_egress
           SET completed_at = clock_timestamp(), end_kind = 'deadline_before_start'
         WHERE attempt_id = $1
    `, [recoveryRows[2].attemptId]);

    const collisionId = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    await db.query(`
        INSERT INTO action_obs (
            id, action_id, source, cluster, source_key, fact_key, fact_rev,
            query_kind, verdict, predicate, rule_ver, provider, desired_hash,
            effect_hash, provider_order_id, payload_hash, payload_ver, payload
        ) VALUES (
            $1, $2, 'provider', 'mainnet-beta', 'upgrade:legacy-collision:source',
            $3, 1, 'found', 'presence', 'provider_sync.provider.effect.v1', 1,
            'upgrade', repeat('4', 64), repeat('4', 64), 'upgrade-collision-order',
            repeat('b', 64), 1, '{}'
        )
    `, [collisionId, upgradeAction, `legacy:${legacyObs}`]);
    const collision = await db.query(`
        SELECT id FROM action_obs_current WHERE action_id = $1 AND fact_key = $2
    `, [upgradeAction, `legacy:${legacyObs}`]);
    if (collision.rowCount !== 1 || collision.rows[0].id !== collisionId) {
        throw new Error('V032 allowed legacy context to hide colliding versioned evidence');
    }

    await expectReject(() => db.query(`
        INSERT INTO action_obs (
            id, action_id, source, cluster, source_key, fact_key, fact_rev,
            query_kind, verdict, predicate, rule_ver, provider, desired_hash,
            provider_order_id, payload_hash, payload_ver, payload
        ) VALUES (
            gen_random_uuid(), $1, 'provider', 'mainnet-beta',
            'upgrade:absence:source', 'upgrade:absence:fact', 1,
            'found', 'absence', 'provider_sync.provider.effect.v1', 1,
            'upgrade', repeat('4', 64), 'upgrade-order', repeat('a', 64), 1, '{}'
        )
    `, [upgradeAction]), 'provider absence without an admitted proof capability');
    await expectReject(() => db.query(`
        INSERT INTO order_proof_caps (
            provider, rule_ver, provider_absence, source_key
        ) VALUES ('upgrade', 1, true, 'runtime:unauthorized-capability')
    `), 'a runtime provider proof capability grant');

    const upgrade = await db.query(`
        SELECT action.action_ver, action.lease_owner, action.lease_gen,
               action.lease_until, action.write_scope, action.write_epoch,
               key.materialized_at,
               anomaly.detail->>'leaseOwner' AS repaired_owner
          FROM order_actions action
          JOIN order_event_keys key ON key.event_key = $2
          JOIN order_anomalies anomaly
            ON anomaly.anomaly_key = 'migration:v19:terminal-fence:' || action.id::text
         WHERE action.id = $1
    `, [upgradeAction, pendingKey]);
    if (upgrade.rowCount !== 1
        || upgrade.rows[0].action_ver !== '1'
        || upgrade.rows[0].lease_owner !== null
        || upgrade.rows[0].lease_gen !== '1'
        || upgrade.rows[0].lease_until !== null
        || upgrade.rows[0].write_scope !== null
        || upgrade.rows[0].write_epoch !== null
        || upgrade.rows[0].materialized_at !== null
        || upgrade.rows[0].repaired_owner !== 'stale-upgrade-worker') {
        throw new Error('V019 did not audit terminal-fence repair and recover a V015 pending event key');
    }
    const upgradedEvents = await db.query(`
        SELECT key.event_key, key.event_id, key.order_id, key.action_id,
               key.event_type, key.order_ver, key.event_hash, key.occurred_at,
               key.materialized_at,
               event.id AS target_id, event.state AS target_state,
               event.metadata AS target_metadata, event.trace_id, event.actor_kind
          FROM order_event_keys key
          LEFT JOIN order_events event ON event.event_key = key.event_key
         WHERE key.event_key IN ($1, $2)
         ORDER BY key.event_key
    `, [exactKey, pendingKey]);
    const exact = upgradedEvents.rows.find((row) => row.event_key === exactKey);
    const pending = upgradedEvents.rows.find((row) => row.event_key === pendingKey);
    if (exact?.event_id !== exactId
        || exact.order_id !== orderId
        || exact.action_id !== null
        || exact.event_type !== 'upgrade.exact'
        || exact.order_ver !== '0'
        || exact.event_hash !== '5'.repeat(64)
        || new Date(exact.occurred_at).toISOString() !== exactAt
        || exact.materialized_at === null
        || exact.target_id !== exactId
        || exact.target_state !== 'open'
        || JSON.stringify(exact.target_metadata) !== JSON.stringify({ upgrade: 'exact' })
        || exact.trace_id !== 'trace-upgrade-exact'
        || exact.actor_kind !== 'system'
        || pending?.event_id !== pendingId
        || pending.order_id !== orderId
        || pending.event_type !== 'upgrade.pending'
        || pending.order_ver !== '0'
        || pending.event_hash !== '1'.repeat(64)
        || new Date(pending.occurred_at).toISOString() !== pendingAt
        || pending.materialized_at !== null
        || pending.target_id !== null) {
        throw new Error('V019 did not preserve exact events and recover only unclaimed reservations');
    }
    await rejectBadEventUpgrade();
    await rejectBadPolicyUpgrade();
    await rejectLegacyWriterCutover();
    await rejectBadCutoverIndex();
    await migrate('036');

    const methods = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
    const dispatchCases = [];
    for (const [kind, rule] of Object.entries(dispatchRules)) {
        for (const method of methods) {
            for (const body of [false, true]) {
                for (const blob of [false, true]) {
                    dispatchCases.push({
                        kind,
                        method,
                        body,
                        blob,
                        expected: rule.methods.includes(method)
                            && rule.body === body && rule.blob === blob,
                    });
                }
            }
        }
    }
    const dispatchMismatch = await db.query(`
        SELECT * FROM (
            SELECT item.*, action_dispatch_valid(
                item.kind::varchar, item.method::varchar, item.body, item.blob
            ) AS actual
              FROM jsonb_to_recordset($1::jsonb) AS item(
                  kind text, method text, body boolean, blob boolean, expected boolean
              )
        ) checked
        WHERE actual IS DISTINCT FROM expected
    `, [JSON.stringify(dispatchCases)]);
    if (dispatchMismatch.rowCount !== 0) {
        throw new Error(`Database dispatch matrix diverged: ${JSON.stringify(dispatchMismatch.rows)}`);
    }

    const classes = policy.httpClasses;
    const statuses = [null, ...Array.from({ length: 500 }, (_, index) => index + 100)];
    const httpCases = [];
    for (const kind of classes) {
        for (const status of statuses) {
            for (const error of [false, true]) {
                for (const message of [false, true]) {
                    httpCases.push({
                        kind,
                        status,
                        error,
                        message,
                        expected: kind === 'success'
                            ? statusValid(kind, status) && !error && !message
                            : (kind === 'transport_error' || kind === 'timeout'
                                ? status === null && error
                                : statusValid(kind, status) && error),
                    });
                }
            }
        }
    }
    const httpMismatch = await db.query(`
        SELECT * FROM (
            SELECT item.*, action_http_valid(
                item.kind::varchar, item.status, item.error, item.message
            ) AS actual
              FROM jsonb_to_recordset($1::jsonb) AS item(
                  kind text, status integer, error boolean, message boolean, expected boolean
              )
        ) checked
        WHERE actual IS DISTINCT FROM expected
    `, [JSON.stringify(httpCases)]);
    if (httpMismatch.rowCount !== 0) {
        throw new Error(`Database HTTP fact matrix diverged: ${JSON.stringify(httpMismatch.rows)}`);
    }

    const sourceCases = Object.entries(policy.evidence).flatMap(([kind, allowed]) => (
        ['provider', 'chain'].map((source) => ({
            kind,
            source,
            expected: allowed.includes(source),
        }))
    ));
    const sourceMismatch = await db.query(`
        SELECT * FROM (
            SELECT item.*, action_source_valid(
                item.kind::varchar, item.source::varchar
            ) AS actual
              FROM jsonb_to_recordset($1::jsonb) AS item(
                  kind text, source text, expected boolean
              )
        ) checked
        WHERE actual IS DISTINCT FROM expected
    `, [JSON.stringify(sourceCases)]);
    if (sourceMismatch.rowCount !== 0) {
        throw new Error(`Database evidence-source matrix diverged: ${JSON.stringify(sourceMismatch.rows)}`);
    }
    const proofCaps = await db.query(`
        SELECT provider
          FROM order_proof_caps
         WHERE rule_ver = 1 AND provider_absence
         ORDER BY provider
    `);
    if (JSON.stringify(proofCaps.rows.map((row) => row.provider))
        !== JSON.stringify([...policy.proof.providerAbsence].sort())) {
        throw new Error('Database provider-absence capabilities diverged from the policy contract');
    }
    const absenceCases = ['provider', 'chain'].flatMap((source) => (
        ['found', 'expired_unseen', 'queried_no_evidence', 'unchecked'].map((query) => ({
            source,
            query,
            expected: query === (source === 'chain'
                ? policy.proof.chainAbsenceQuery
                : policy.proof.providerAbsenceQuery),
        }))
    ));
    const absenceMismatch = await db.query(`
        SELECT * FROM (
            SELECT item.*, action_absence_query_valid(
                item.source::varchar, item.query::varchar
            ) AS actual
              FROM jsonb_to_recordset($1::jsonb) AS item(
                  source text, query text, expected boolean
              )
        ) checked
        WHERE actual IS DISTINCT FROM expected
    `, [JSON.stringify(absenceCases)]);
    if (absenceMismatch.rowCount !== 0) {
        throw new Error(`Database absence-query policy diverged: ${JSON.stringify(absenceMismatch.rows)}`);
    }

    await db.query(`
        UPDATE order_intents
           SET cluster = 'mainnet-beta', family = 'price', strategy_kind = 'single',
               trigger_state = 'open', fill_state = 'none', funds_state = 'vaulted',
               remaining_in = input_amount, filled_in = 0, filled_out = 0, req_ver = 1
         WHERE id = $1
    `, [orderId]);

    await db.query(`
        INSERT INTO order_epochs (scope, epoch, mode, authority, proof_hash, source_key)
        VALUES ('provider:jupiter', 1, 'frozen', 'ci', repeat('1', 64), 'epoch:1')
    `);
    await db.query(`
        INSERT INTO order_epochs (scope, epoch, region, mode, authority, proof_hash, source_key)
        VALUES ('provider:jupiter', 2, 'us-west-2', 'live', 'ci', repeat('2', 64), 'epoch:2')
    `);
    await expectReject(() => db.query(`
        INSERT INTO order_epochs (scope, epoch, region, mode, authority, proof_hash, source_key)
        VALUES ('provider:jupiter', 4, 'us-east-1', 'live', 'ci', repeat('4', 64), 'epoch:4')
    `), 'a nonmonotonic write epoch');
    await expectReject(() => db.query(
        "UPDATE order_epochs SET mode = 'frozen' WHERE scope = 'provider:jupiter' AND epoch = 2"
    ), 'write epoch mutation');

    const legId = randomUUID();
    await db.query(`
        INSERT INTO order_legs (
            id, order_id, leg_no, role, condition, alloc_amt,
            target_usd, slip_bps
        ) VALUES ($1, $2, 0, 'primary', 'above', 1000, 250, 100)
    `, [legId, orderId]);

    const actionId = randomUUID();
    const reqHash = 'c'.repeat(64);
    const desiredHash = 'd'.repeat(64);
    await db.query(`
        INSERT INTO order_actions (
            id, order_id, user_id, leg_id, kind, client_key, req_hash, desired_hash,
            expected_ver, work_state, effect_state, outcome, provider, due_at
        ) VALUES (
            $1, $2, $3, $4, 'activate', 'activate-1', $5, $6,
            0, 'queued', 'not_possible', 'pending', 'jupiter', CURRENT_TIMESTAMP
        )
    `, [actionId, orderId, userId, legId, reqHash, desiredHash]);
    await expectReject(() => db.query(`
        INSERT INTO order_actions (
            id, order_id, user_id, kind, client_key, req_hash, desired_hash,
            expected_ver, work_state, effect_state, outcome, provider, due_at, completed_at
        ) VALUES (
            gen_random_uuid(), $1, $2, 'edit', 'invalid-terminal', repeat('e', 64), repeat('f', 64),
            0, 'done', 'present', 'failed', 'jupiter', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
    `, [orderId, userId]), 'an invalid terminal action tuple');

    const renewAction = randomUUID();
    await db.query(`
        INSERT INTO order_actions (
            id, order_id, user_id, kind, client_key, req_hash, desired_hash,
            expected_ver, work_state, effect_state, outcome, provider, due_at
        ) VALUES (
            $1, $2, $3, 'provider_sync', 'clock-renew', repeat('1', 64), repeat('2', 64),
            0, 'queued', 'not_possible', 'pending', 'jupiter', clock_timestamp()
        )
    `, [renewAction, orderId, userId]);
    await db.query(`
        UPDATE order_actions
           SET action_ver = 1, work_state = 'ready', lease_owner = 'clock-renew-worker',
               lease_gen = 1, lease_until = clock_timestamp() + INTERVAL '350 milliseconds',
               write_scope = 'provider:jupiter', write_epoch = 2
         WHERE id = $1
    `, [renewAction]);
    const renewTx = await open();
    try {
        await renewTx.query('BEGIN');
        await renewTx.query('SELECT 1');
        await renewTx.query('SELECT pg_sleep(0.45)');
        await expectReject(() => renewTx.query(`
            UPDATE order_actions
               SET action_ver = 2, lease_until = clock_timestamp() + INTERVAL '5 minutes'
             WHERE id = $1
        `, [renewAction]), 'lease renewal after wall-clock expiry in a paused transaction');
        await renewTx.query('ROLLBACK');
    } finally {
        await renewTx.query('ROLLBACK').catch(() => {});
        await close(renewTx);
    }

    const clockAttemptAction = randomUUID();
    const clockAttempt = randomUUID();
    await db.query(`
        INSERT INTO order_actions (
            id, order_id, user_id, kind, client_key, req_hash, desired_hash,
            expected_ver, work_state, effect_state, outcome, provider, due_at
        ) VALUES (
            $1, $2, $3, 'provider_sync', 'clock-attempt', repeat('3', 64), repeat('4', 64),
            0, 'queued', 'not_possible', 'pending', 'jupiter', clock_timestamp()
        )
    `, [clockAttemptAction, orderId, userId]);
    await db.query(`
        UPDATE order_actions
           SET action_ver = 1, work_state = 'ready',
               lease_owner = 'clock-attempt-worker', lease_gen = 1,
               lease_until = clock_timestamp() + INTERVAL '350 milliseconds',
               write_scope = 'provider:jupiter', write_epoch = 2
         WHERE id = $1
    `, [clockAttemptAction]);
    await db.query(`
        UPDATE order_actions
           SET action_ver = 2, work_state = 'dispatching', effect_state = 'possible',
               ambiguity_at = clock_timestamp(), attempt_count = 1
         WHERE id = $1
    `, [clockAttemptAction]);
    const attemptTx = await open();
    try {
        await attemptTx.query('BEGIN');
        await attemptTx.query('SELECT 1');
        await attemptTx.query('SELECT pg_sleep(0.45)');
        await expectReject(() => attemptTx.query(`
            INSERT INTO action_attempts (
                id, action_id, seq, lease_gen, write_scope, write_epoch, endpoint,
                method, provider, req_hash, desired_hash, send_state, started_at, deadline_at
            ) VALUES (
                $1, $2, 1, 1, 'provider:jupiter', 2, '/clock-attempt', 'GET',
                'jupiter', repeat('3', 64), repeat('4', 64), 'started',
                clock_timestamp(), clock_timestamp() + INTERVAL '10 seconds'
            )
        `, [clockAttempt, clockAttemptAction]),
        'attempt start after wall-clock lease expiry in a paused transaction');
        await attemptTx.query('ROLLBACK');
    } finally {
        await attemptTx.query('ROLLBACK').catch(() => {});
        await close(attemptTx);
    }

    const clockReadAction = randomUUID();
    const clockReadAttempt = randomUUID();
    const clockSignature = '4'.repeat(88);
    const clockMessage = '5'.repeat(64);
    await db.query(`
        INSERT INTO order_actions (
            id, order_id, user_id, kind, client_key, req_hash, desired_hash,
            expected_ver, work_state, effect_state, outcome, provider, due_at
        ) VALUES (
                $1, $2, $3, 'activate', 'clock-read', repeat('6', 64), repeat('7', 64),
            0, 'queued', 'not_possible', 'pending', 'jupiter', clock_timestamp()
        )
    `, [clockReadAction, orderId, userId]);
    await db.query(`
        UPDATE order_actions
           SET action_ver = 1, work_state = 'ready',
               message_hash = $2, first_signature = $3,
               lease_owner = 'clock-read-worker', lease_gen = 1,
               lease_until = clock_timestamp() + INTERVAL '2 seconds',
               write_scope = 'provider:jupiter', write_epoch = 2
         WHERE id = $1
    `, [clockReadAction, clockMessage, clockSignature]);
    await db.query(`
        UPDATE order_actions
           SET action_ver = 2, work_state = 'dispatching', effect_state = 'possible',
               ambiguity_at = clock_timestamp(), attempt_count = 1
         WHERE id = $1
    `, [clockReadAction]);
    await db.query(`
        INSERT INTO order_tx_blobs (
            action_id, order_id, cluster, wallet_address, alg, ciphertext, nonce,
            wrapped_key, key_id, aad_hash, message_hash, first_signature, byte_size, expires_at
        ) VALUES (
            $1, $2, 'mainnet-beta', $3, 'aes_256_gcm', decode(repeat('11', 33), 'hex'),
            decode(repeat('22', 12), 'hex'), decode(repeat('33', 32), 'hex'),
            'kms:clock', repeat('8', 64), $4, $5, 256, clock_timestamp() + INTERVAL '1 hour'
        )
    `, [clockReadAction, orderId, wallet, clockMessage, clockSignature]);
    await db.query(`
        INSERT INTO action_attempts (
            id, action_id, seq, lease_gen, write_scope, write_epoch, endpoint,
            method, provider, req_hash, body_hash, desired_hash, blob_action_id,
            send_state, started_at, deadline_at
        ) VALUES (
            $1, $2, 1, 1, 'provider:jupiter', 2, '/clock-read', 'POST',
            'jupiter', repeat('6', 64), repeat('a', 64), repeat('7', 64), $2,
            'started', clock_timestamp(), clock_timestamp() + INTERVAL '10 seconds'
        )
    `, [clockReadAttempt, clockReadAction]);
    await expectReject(() => db.query(`
        UPDATE action_attempts
           SET send_state = 'response_recorded',
               completed_at = clock_timestamp(),
               http_class = 'success',
               http_status = 500
         WHERE id = $1
    `, [clockReadAttempt]), 'a contradictory normalized HTTP response fact');
    const readTx = await open();
    try {
        await readTx.query('BEGIN');
        await readTx.query('SELECT 1');
        await readTx.query('SELECT pg_sleep(2.1)');
        await expectReject(() => readTx.query(`
            INSERT INTO order_blob_reads (
                id, access_key, action_id, attempt_id, lease_gen,
                write_scope, write_epoch, gateway, purpose
            ) VALUES (
                gen_random_uuid(), 'clock-read-expired', $1, $2, 1,
                'provider:jupiter', 2, 'gateway-clock', 'dispatch'
            )
        `, [clockReadAction, clockReadAttempt]),
        'blob read after wall-clock lease expiry in a paused transaction');
        await readTx.query('ROLLBACK');
    } finally {
        await readTx.query('ROLLBACK').catch(() => {});
        await close(readTx);
    }

    // Prove expiry is sampled after waits inside each trigger, not merely after
    // time spent before the statement began.
    await db.query(`
        UPDATE order_actions
           SET action_ver = 2, lease_owner = 'clock-renew-worker-2', lease_gen = 2,
               lease_until = clock_timestamp() + INTERVAL '800 milliseconds'
         WHERE id = $1
    `, [renewAction]);
    const renewBlocker = await open();
    const renewWorker = await open();
    try {
        await renewBlocker.query('BEGIN');
        await renewBlocker.query(`
            SELECT pg_advisory_xact_lock(hashtextextended('provider:jupiter', 1937006964))
        `);
        await renewWorker.query("SET application_name = 'fervor-order-renew-wait'");
        const renewal = renewWorker.query(`
            UPDATE order_actions
               SET action_ver = 3, lease_until = clock_timestamp() + INTERVAL '5 minutes'
             WHERE id = $1
        `, [renewAction]).then(() => null, (error) => error);
        const lock = await waitForLock(db, 'fervor-order-renew-wait');
        if (lock.wait_event !== 'advisory') {
            throw new Error(`Lease renewal waited on ${JSON.stringify(lock)} instead of its epoch fence`);
        }
        await delay(950);
        await renewBlocker.query('COMMIT');
        const error = await renewal;
        if (!(error instanceof Error) || error.code !== '40001') {
            throw new Error('Order schema accepted lease renewal after expiry during an advisory-lock wait',
                { cause: error ?? undefined });
        }
    } finally {
        await renewBlocker.query('ROLLBACK').catch(() => {});
        await close(renewBlocker);
        await close(renewWorker);
    }

    await db.query(`
        UPDATE order_actions
           SET action_ver = 3, lease_owner = 'clock-attempt-worker-2', lease_gen = 2,
               lease_until = clock_timestamp() + INTERVAL '800 milliseconds'
         WHERE id = $1
    `, [clockAttemptAction]);
    const attemptBlocker = await open();
    const attemptWorker = await open();
    try {
        await attemptBlocker.query('BEGIN');
        await attemptBlocker.query(`
            SELECT pg_advisory_xact_lock(hashtextextended('provider:jupiter', 1937006964))
        `);
        await attemptWorker.query("SET application_name = 'fervor-order-attempt-wait'");
        const attemptStart = attemptWorker.query(`
            INSERT INTO action_attempts (
                id, action_id, seq, lease_gen, write_scope, write_epoch, endpoint,
                method, provider, req_hash, desired_hash, send_state, started_at, deadline_at
            ) VALUES (
                gen_random_uuid(), $1, 1, 2, 'provider:jupiter', 2, '/clock-attempt-wait',
                'GET', 'jupiter', repeat('3', 64), repeat('4', 64), 'started',
                clock_timestamp(), clock_timestamp() + INTERVAL '10 seconds'
            )
        `, [clockAttemptAction]).then(() => null, (error) => error);
        const lock = await waitForLock(db, 'fervor-order-attempt-wait');
        if (lock.wait_event !== 'advisory') {
            throw new Error(`Attempt start waited on ${JSON.stringify(lock)} instead of its epoch fence`);
        }
        await delay(950);
        await attemptBlocker.query('COMMIT');
        const error = await attemptStart;
        if (!(error instanceof Error) || error.code !== '40001') {
            throw new Error('Order schema accepted attempt start after expiry during an advisory-lock wait',
                { cause: error ?? undefined });
        }
    } finally {
        await attemptBlocker.query('ROLLBACK').catch(() => {});
        await close(attemptBlocker);
        await close(attemptWorker);
    }

    const blockedReadAttempt = randomUUID();
    await db.query(`
        UPDATE order_actions
           SET action_ver = 3, attempt_count = 2,
               lease_owner = 'clock-read-worker-2', lease_gen = 2,
               lease_until = clock_timestamp() + INTERVAL '800 milliseconds'
         WHERE id = $1
    `, [clockReadAction]);
    await db.query(`
        INSERT INTO action_attempts (
            id, action_id, seq, lease_gen, write_scope, write_epoch, endpoint,
            method, provider, req_hash, body_hash, desired_hash, blob_action_id,
            send_state, started_at, deadline_at
        ) VALUES (
            $1, $2, 2, 2, 'provider:jupiter', 2, '/clock-read-wait', 'POST',
            'jupiter', repeat('6', 64), repeat('b', 64), repeat('7', 64), $2,
            'started', clock_timestamp(), clock_timestamp() + INTERVAL '10 seconds'
        )
    `, [blockedReadAttempt, clockReadAction]);
    const readBlocker = await open();
    const readWorker = await open();
    try {
        await readBlocker.query('BEGIN');
        await readBlocker.query('SELECT id FROM order_actions WHERE id = $1 FOR UPDATE', [clockReadAction]);
        await readWorker.query("SET application_name = 'fervor-order-blob-wait'");
        const blobRead = readWorker.query(`
            INSERT INTO order_blob_reads (
                id, access_key, action_id, attempt_id, lease_gen,
                write_scope, write_epoch, gateway, purpose
            ) VALUES (
                gen_random_uuid(), 'clock-read-lock-expired', $1, $2, 2,
                'provider:jupiter', 2, 'gateway-clock', 'dispatch'
            )
        `, [clockReadAction, blockedReadAttempt]).then(() => null, (error) => error);
        const lock = await waitForLock(db, 'fervor-order-blob-wait');
        if (!['Lock', 'LWLock'].includes(lock.wait_event_type)) {
            throw new Error(`Blob access reached an unexpected wait: ${JSON.stringify(lock)}`);
        }
        await delay(950);
        await readBlocker.query('COMMIT');
        const error = await blobRead;
        if (!(error instanceof Error) || error.code !== '23514') {
            throw new Error('Order schema accepted blob read after expiry during an action-row wait',
                { cause: error ?? undefined });
        }
    } finally {
        await readBlocker.query('ROLLBACK').catch(() => {});
        await close(readBlocker);
        await close(readWorker);
    }

    const terminalAction = randomUUID();
    await db.query(`
        INSERT INTO order_actions (
            id, order_id, user_id, kind, client_key, req_hash, desired_hash,
            expected_ver, work_state, effect_state, outcome, provider, due_at
        ) VALUES (
            $1, $2, $3, 'provider_sync', 'terminal-fence', repeat('8', 64), repeat('9', 64),
            0, 'queued', 'not_possible', 'pending', 'jupiter', clock_timestamp()
        )
    `, [terminalAction, orderId, userId]);
    await db.query(`
        UPDATE order_actions
           SET action_ver = 1, work_state = 'ready', lease_owner = 'terminal-worker',
               lease_gen = 1, lease_until = clock_timestamp() + INTERVAL '5 minutes',
               write_scope = 'provider:jupiter', write_epoch = 2
         WHERE id = $1
    `, [terminalAction]);
    await db.query(`
        UPDATE order_actions
           SET action_ver = 2, work_state = 'dispatching', effect_state = 'possible',
               ambiguity_at = clock_timestamp(), attempt_count = 1
         WHERE id = $1
    `, [terminalAction]);
    await expectReject(() => db.query(`
        INSERT INTO action_obs (
            id, action_id, source, cluster, source_key, fact_key, fact_rev,
            query_kind, verdict, predicate, rule_ver, signature, slot,
            instruction_index, event_index, commitment, desired_hash,
            payload_hash, payload_ver, payload
        ) VALUES (
            gen_random_uuid(), $1, 'chain', 'mainnet-beta', 'terminal-fence:chain-source',
            'terminal-fence:chain-fact', 1, 'found', 'context',
            'provider_sync.chain.effect.v1', 1, repeat('5', 88), 1,
            0, 0, 'confirmed', repeat('9', 64), repeat('a', 64), 1, '{}'
        )
    `, [terminalAction]), 'a disallowed provider-sync chain observation');
    await db.query('BEGIN');
    await db.query(`
        INSERT INTO action_obs (
            id, action_id, source, cluster, source_key, fact_key, fact_rev,
            query_kind, verdict, predicate, rule_ver, provider, norm_state,
            desired_hash, effect_hash, provider_order_id, payload_hash, payload_ver, payload
        ) VALUES (
            gen_random_uuid(), $1, 'provider', 'mainnet-beta', 'terminal-fence:source',
            'terminal-fence:fact', 1, 'found', 'presence',
            'provider_sync.provider.effect.v1', 1, 'jupiter', 'present',
            repeat('9', 64), repeat('9', 64), 'terminal-order', repeat('a', 64), 1, '{}'
        )
    `, [terminalAction]);
    await db.query('SAVEPOINT terminal_fence_check');
    await expectReject(() => db.query(`
        UPDATE order_actions
           SET action_ver = 3, work_state = 'done', effect_state = 'present',
               outcome = 'succeeded', completed_at = clock_timestamp()
         WHERE id = $1
    `, [terminalAction]), 'a terminal action that retains its write fence');
    await db.query('ROLLBACK TO SAVEPOINT terminal_fence_check');
    await db.query(`
        UPDATE order_actions
           SET action_ver = 3, work_state = 'done', effect_state = 'present',
               outcome = 'succeeded', completed_at = clock_timestamp(),
               lease_owner = NULL, lease_until = NULL, write_scope = NULL, write_epoch = NULL
         WHERE id = $1
    `, [terminalAction]);
    await db.query('COMMIT');

    await db.query(`
        UPDATE order_actions
           SET action_ver = 1, work_state = 'ready', lease_owner = 'worker-a',
               lease_gen = 1, lease_until = CURRENT_TIMESTAMP + INTERVAL '5 minutes',
               write_scope = 'provider:jupiter', write_epoch = 2
         WHERE id = $1
    `, [actionId]);
    await expectReject(() => db.query(`
        UPDATE order_actions
           SET action_ver = 2, lease_gen = 3
         WHERE id = $1
    `, [actionId]), 'a skipped lease generation');
    await expectReject(() => db.query(`
        UPDATE order_actions
           SET action_ver = 2, lease_until = CURRENT_TIMESTAMP - INTERVAL '1 second'
         WHERE id = $1
    `, [actionId]), 'an expired active action lease');

    await db.query(`
        INSERT INTO order_epochs (scope, epoch, region, mode, authority, proof_hash, source_key)
        VALUES ('provider:fence', 1, 'us-west-2', 'live', 'ci', repeat('a', 64), 'fence:epoch:1')
    `);
    const fenceAction = randomUUID();
    await db.query(`
        INSERT INTO order_actions (
            id, order_id, user_id, kind, client_key, req_hash, desired_hash,
            expected_ver, work_state, effect_state, outcome, provider, due_at
        ) VALUES (
            $1, $2, $3, 'provider_sync', 'fence-action', repeat('a', 64), repeat('b', 64),
            0, 'queued', 'not_possible', 'pending', 'fence', CURRENT_TIMESTAMP
        )
    `, [fenceAction, orderId, userId]);
    const claimant = await open();
    const freezer = await open();
    let claimDone = false;
    try {
        await claimant.query('BEGIN');
        await claimant.query(`
            UPDATE order_actions
               SET action_ver = 1, lease_owner = 'fence-worker', lease_gen = 1,
                   lease_until = CURRENT_TIMESTAMP + INTERVAL '5 minutes',
                   write_scope = 'provider:fence', write_epoch = 1
             WHERE id = $1
        `, [fenceAction]);
        await freezer.query("SET application_name = 'order_epoch_freezer'");
        let freezeDone = false;
        let freezeError;
        const freeze = freezer.query(`
            INSERT INTO order_epochs (scope, epoch, mode, authority, proof_hash, source_key)
            VALUES ('provider:fence', 2, 'frozen', 'ci', repeat('c', 64), 'fence:epoch:2')
        `).then(() => {
            freezeDone = true;
        }, (error) => {
            freezeDone = true;
            freezeError = error;
        });
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked && !freezeDone; attempt += 1) {
            const activity = await db.query(`
                SELECT wait_event FROM pg_stat_activity
                 WHERE application_name = 'order_epoch_freezer' AND state = 'active'
            `);
            blocked = activity.rows.some((row) => row.wait_event === 'advisory');
            if (!blocked) await delay(10);
        }
        if (!blocked || freezeDone) {
            throw new Error('Epoch freeze did not wait for the in-flight shared action fence');
        }
        await claimant.query('COMMIT');
        claimDone = true;
        await freeze;
        if (freezeError) throw freezeError;
    } finally {
        if (!claimDone) await claimant.query('ROLLBACK').catch(() => {});
        await Promise.allSettled([close(claimant), close(freezer)]);
    }
    await expectReject(() => db.query(`
        UPDATE order_actions SET action_ver = 2, due_at = CURRENT_TIMESTAMP WHERE id = $1
    `, [fenceAction]), 'work under a frozen action epoch');
    await db.query(`
        UPDATE order_actions
           SET action_ver = 2, lease_owner = NULL, lease_until = NULL,
               write_scope = NULL, write_epoch = NULL
         WHERE id = $1
    `, [fenceAction]);
    await db.query(`
        CREATE TEMP TABLE order_epoch_current (
            scope VARCHAR(64), epoch BIGINT, mode VARCHAR(12)
        )
    `);
    await db.query(`
        INSERT INTO order_epoch_current VALUES ('provider:fence', 1, 'live')
    `);
    await expectReject(() => db.query(`
        UPDATE order_actions
           SET action_ver = 3, lease_owner = 'spoof-worker', lease_gen = 2,
               lease_until = CURRENT_TIMESTAMP + INTERVAL '5 minutes',
               write_scope = 'provider:fence', write_epoch = 1
         WHERE id = $1
    `, [fenceAction]), 'an untrusted temporary epoch shadow');
    await db.query('DROP TABLE pg_temp.order_epoch_current');
    await expectReject(() => db.query('DELETE FROM order_actions WHERE id = $1', [fenceAction]),
        'action deletion');

    const signature = '5'.repeat(88);
    const messageHash = '6'.repeat(64);
    await db.query(`
        UPDATE order_actions
           SET action_ver = 2, message_hash = $2, first_signature = $3,
               recent_blockhash = $4, last_valid_height = 12345
         WHERE id = $1
    `, [actionId, messageHash, signature, '7'.repeat(44)]);
    await db.query(`
        INSERT INTO order_tx_blobs (
            action_id, order_id, cluster, wallet_address, alg, ciphertext, nonce,
            wrapped_key, key_id, aad_hash, message_hash, first_signature, byte_size, expires_at
        ) VALUES (
            $1, $2, 'mainnet-beta', $3, 'aes_256_gcm', decode(repeat('aa', 33), 'hex'),
            decode(repeat('bb', 12), 'hex'), decode(repeat('cc', 32), 'hex'),
            'kms:test', repeat('8', 64), $4, $5, 256, CURRENT_TIMESTAMP + INTERVAL '1 hour'
        )
    `, [actionId, orderId, wallet, messageHash, signature]);
    await db.query('CREATE TEMP TABLE order_tx_blobs (action_id UUID)');
    await expectReject(() => db.query(`
        UPDATE order_actions SET action_ver = 3, message_hash = repeat('a', 64) WHERE id = $1
    `, [actionId]), 'a committed transaction identity rewrite');
    await expectReject(() => db.query(`
        UPDATE order_actions
           SET action_ver = 3, recent_blockhash = $2, last_valid_height = 12346
         WHERE id = $1
    `, [actionId, '8'.repeat(44)]), 'a committed transaction validity rewrite');
    await db.query('DROP TABLE pg_temp.order_tx_blobs');

    const attemptId = randomUUID();
    await db.query('BEGIN');
    try {
        await db.query(`
            UPDATE order_actions
               SET action_ver = 3, work_state = 'dispatching', effect_state = 'possible',
                   ambiguity_at = CURRENT_TIMESTAMP, attempt_count = 1
             WHERE id = $1
        `, [actionId]);
        await db.query(`
            INSERT INTO action_attempts (
                id, action_id, seq, lease_gen, write_scope, write_epoch, endpoint, method,
                provider, req_hash, body_hash, desired_hash, provider_req_id, blob_action_id,
                send_state, started_at, deadline_at
            ) VALUES (
                $1, $2, 1, 1, 'provider:jupiter', 2, '/trigger/v2/createOrder', 'POST',
                'jupiter', $3, repeat('9', 64), $4, 'provider-request-1', $2,
                'started', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '10 seconds'
            )
        `, [attemptId, actionId, reqHash, desiredHash]);
        await db.query('COMMIT');
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    }
    await expectReject(() => db.query(`
        UPDATE order_actions
           SET action_ver = 4, work_state = 'reconciling', effect_state = 'conflict',
               lease_owner = NULL, lease_until = NULL, write_scope = NULL, write_epoch = NULL
         WHERE id = $1
    `, [actionId]), 'action conflict without current conflict evidence');

    const readId = randomUUID();
    await db.query(`
        INSERT INTO order_blob_reads (
            id, access_key, action_id, attempt_id, lease_gen, write_scope,
            write_epoch, gateway, purpose
        ) VALUES ($1, 'blob-read-1', $2, $3, 1, 'provider:jupiter', 2, 'gateway-a', 'dispatch')
    `, [readId, actionId, attemptId]);
    await expectReject(() => db.query(
        "UPDATE order_blob_reads SET gateway = 'gateway-b' WHERE id = $1", [readId]
    ), 'blob-access fact mutation');
    await expectReject(() => db.query(
        'UPDATE order_tx_blobs SET key_id = $2 WHERE action_id = $1', [actionId, 'kms:other']
    ), 'ciphertext metadata rewrite');

    await db.query(`
        UPDATE action_attempts
           SET send_state = 'response_recorded', completed_at = CURRENT_TIMESTAMP,
               http_status = 202, http_class = 'success', response_hash = repeat('a', 64),
               provider_effect_id = 'provider-order-1'
         WHERE id = $1
    `, [attemptId]);
    await expectReject(() => db.query(
        "UPDATE action_attempts SET error_code = 'late' WHERE id = $1", [attemptId]
    ), 'a second attempt response');
    await expectReject(() => db.query('DELETE FROM action_attempts WHERE id = $1', [attemptId]),
        'attempt deletion');

    const purgeAction = randomUUID();
    const purgeSignature = '6'.repeat(88);
    const purgeMessage = '7'.repeat(64);
    await db.query(`
        INSERT INTO order_actions (
            id, order_id, user_id, kind, client_key, req_hash, desired_hash,
            expected_ver, work_state, effect_state, outcome, provider, message_hash,
            first_signature, due_at
        ) VALUES (
            $1, $2, $3, 'provider_sync', 'purge-terminal', repeat('8', 64), repeat('9', 64),
            0, 'queued', 'not_possible', 'pending', 'jupiter', $4, $5, clock_timestamp()
        )
    `, [purgeAction, orderId, userId, purgeMessage, purgeSignature]);
    await db.query(`
        UPDATE order_actions
           SET action_ver = 1, work_state = 'ready', lease_owner = 'purge-worker',
               lease_gen = 1, lease_until = clock_timestamp() + INTERVAL '5 minutes',
               write_scope = 'provider:jupiter', write_epoch = 2
         WHERE id = $1
    `, [purgeAction]);
    await db.query(`
        UPDATE order_actions
           SET action_ver = 2, work_state = 'dispatching', effect_state = 'possible',
               ambiguity_at = clock_timestamp(), attempt_count = 1
         WHERE id = $1
    `, [purgeAction]);
    await db.query('BEGIN');
    await db.query(`
        INSERT INTO action_obs (
            id, action_id, source, cluster, source_key, fact_key, fact_rev,
            query_kind, verdict, predicate, rule_ver, provider, norm_state,
            desired_hash, effect_hash, provider_order_id, payload_hash, payload_ver, payload
        ) VALUES (
            gen_random_uuid(), $1, 'provider', 'mainnet-beta', 'purge-terminal:source',
            'purge-terminal:fact', 1, 'found', 'presence',
            'provider_sync.provider.effect.v1', 1, 'jupiter', 'present',
            repeat('9', 64), repeat('9', 64), 'purge-order', repeat('b', 64), 1, '{}'
        )
    `, [purgeAction]);
    await db.query(`
        UPDATE order_actions
           SET action_ver = 3, work_state = 'done', effect_state = 'present',
               outcome = 'succeeded', completed_at = clock_timestamp(),
               lease_owner = NULL, lease_until = NULL, write_scope = NULL, write_epoch = NULL
         WHERE id = $1
    `, [purgeAction]);
    await db.query('COMMIT');
    await db.query(`
        INSERT INTO order_tx_blobs (
            action_id, order_id, cluster, wallet_address, alg, ciphertext, nonce,
            wrapped_key, key_id, aad_hash, message_hash, first_signature, byte_size, expires_at
        ) VALUES (
            $1, $2, 'mainnet-beta', $3, 'aes_256_gcm', decode(repeat('44', 33), 'hex'),
            decode(repeat('55', 12), 'hex'), decode(repeat('66', 32), 'hex'),
            'kms:purge', repeat('a', 64), $4, $5, 256, clock_timestamp() + INTERVAL '1 second'
        )
    `, [purgeAction, orderId, wallet, purgeMessage, purgeSignature]);
    await expectReject(() => db.query(
        "SELECT purge_order_tx_blob($1, 'kms-proof:early', clock_timestamp())", [purgeAction]
    ), 'transaction blob purge before its retention deadline');
    await delay(1100);
    const purged = await db.query(
        "SELECT purge_order_tx_blob($1, 'kms-proof:destroyed', clock_timestamp()) AS changed",
        [purgeAction]
    );
    if (purged.rows[0]?.changed !== true) throw new Error('Expired transaction blob was not purged');
    const tombstone = await db.query(`
        SELECT key_id, destroy_ref, purged_at IS NOT NULL AS purged,
               octet_length(ciphertext) AS cipher_size,
               octet_length(nonce) AS nonce_size,
               octet_length(wrapped_key) AS key_size
          FROM order_tx_blobs WHERE action_id = $1
    `, [purgeAction]);
    if (tombstone.rows[0]?.key_id !== 'destroyed'
        || tombstone.rows[0]?.destroy_ref !== 'kms-proof:destroyed'
        || tombstone.rows[0]?.purged !== true
        || tombstone.rows[0]?.cipher_size !== 17
        || tombstone.rows[0]?.nonce_size !== 12
        || tombstone.rows[0]?.key_size !== 32) {
        throw new Error('Expired transaction blob was not reduced to its destruction tombstone');
    }
    const repurge = await db.query(
        "SELECT purge_order_tx_blob($1, 'kms-proof:again', clock_timestamp()) AS changed",
        [purgeAction]
    );
    if (repurge.rows[0]?.changed !== false) throw new Error('Transaction blob purge was not idempotent');
    await expectReject(() => db.query(`
        UPDATE order_actions SET action_ver = 1, error_code = 'rewrite' WHERE id = $1
    `, [purgeAction]), 'rewrite of a terminal action after key destruction');

    const providerObs = randomUUID();
    await db.query(`
        INSERT INTO action_obs (
            id, action_id, attempt_id, source, cluster, source_key, fact_key, fact_rev,
            query_kind, verdict, predicate, rule_ver, provider,
            raw_state, norm_state, desired_hash, effect_hash, provider_req_id,
            provider_order_id, payload_hash, payload_ver, payload
        ) VALUES (
            $1, $2, $3, 'provider', 'mainnet-beta', 'provider:order:1',
            'provider:order:fact', 1, 'found', 'context', 'activate.provider.effect.v1', 1, 'jupiter',
            'open', 'open', $4, repeat('b', 64), 'provider-request-1',
            'provider-order-1', repeat('c', 64), 1, '{"state":"open"}'::jsonb
        )
    `, [providerObs, actionId, attemptId, desiredHash]);
    await expectReject(() => db.query(
        "UPDATE action_obs SET norm_state = 'filled' WHERE id = $1", [providerObs]
    ), 'provider observation mutation');
    await expectReject(() => db.query(`
        INSERT INTO action_obs (
            id, action_id, source, cluster, source_key, fact_key, fact_rev,
            query_kind, verdict, predicate, rule_ver, provider,
            desired_hash, payload_hash, payload_ver
        ) VALUES (
            gen_random_uuid(), $1, 'provider', 'mainnet-beta', 'provider:wrong:1',
            'provider:wrong:fact', 1, 'queried_no_evidence', 'context',
            'activate.provider.effect.v1', 1, 'wrong-provider', $2, repeat('0', 64), 1
        )
    `, [actionId, desiredHash]), 'cross-provider action evidence');

    const confirmedObs = randomUUID();
    await db.query(`
        INSERT INTO action_obs (
            id, action_id, source, cluster, source_key, fact_key, fact_rev,
            query_kind, verdict, predicate, rule_ver, raw_state, norm_state,
            desired_hash, effect_hash, signature, slot, instruction_index, event_index,
            commitment, payload_hash, payload_ver
        ) VALUES (
            $1, $2, 'chain', 'mainnet-beta', 'chain:fill:confirmed', 'chain:fill:fact', 1,
            'found', 'context', 'activate.chain.effect.v1', 1, 'confirmed',
            'fill', $3, repeat('d', 64), $4, 42, 3, 1, 'confirmed', repeat('e', 64), 1
        )
    `, [confirmedObs, actionId, desiredHash, signature]);
    const fillOne = randomUUID();
    await db.query(`
        INSERT INTO order_fills (
            id, fill_key, rev, order_id, leg_id, action_id, obs_id, provider,
            provider_fill_id, state, cluster, signature, slot, instruction_index,
            event_index, commitment, input_mint, output_mint, input_amt, output_amt,
            remaining_in, price_num, price_den
        ) VALUES (
            $1, 'fill:semantic:1', 1, $2, $3, $4, $5, 'jupiter', 'fill-provider-1',
            'confirmed', 'mainnet-beta', $6, 42, 3, 1, 'confirmed', $7, $8,
            400, 800, 600, 2, 1
        )
    `, [fillOne, orderId, legId, actionId, confirmedObs, signature, inputMint, outputMint]);
    await expectReject(() => db.query(`
        INSERT INTO order_fills (
            id, fill_key, rev, order_id, leg_id, action_id, obs_id, provider, state,
            cluster, signature, slot, instruction_index, event_index, commitment,
            input_mint, output_mint, input_amt, output_amt, remaining_in
        ) VALUES (
            gen_random_uuid(), 'fill:provider-only', 1, $1, $2, $3, $4, 'jupiter', 'confirmed',
            'mainnet-beta', $5, 42, 3, 2, 'confirmed', $6, $7, 1, 2, 999
        )
    `, [orderId, legId, actionId, providerObs, signature, inputMint, outputMint]),
    'a provider-only durable fill');

    const finalObs = randomUUID();
    await db.query(`
        INSERT INTO action_obs (
            id, action_id, source, cluster, source_key, fact_key, fact_rev, supersedes,
            query_kind, verdict, predicate, rule_ver, raw_state, norm_state,
            desired_hash, effect_hash, signature, slot, instruction_index, event_index,
            commitment, payload_hash, payload_ver
        ) VALUES (
            $1, $2, 'chain', 'mainnet-beta', 'chain:fill:finalized', 'chain:fill:fact', 2, $3,
            'found', 'context', 'activate.chain.effect.v1', 1, 'finalized',
            'fill', $4, repeat('f', 64), $5, 42, 3, 1, 'finalized', repeat('1', 64), 1
        )
    `, [finalObs, actionId, confirmedObs, desiredHash, signature]);
    const fillTwo = randomUUID();
    await db.query(`
        INSERT INTO order_fills (
            id, fill_key, rev, supersedes, order_id, leg_id, action_id, obs_id, provider,
            provider_fill_id, state, cluster, signature, slot, instruction_index,
            event_index, commitment, input_mint, output_mint, input_amt, output_amt,
            remaining_in, price_num, price_den
        ) VALUES (
            $1, 'fill:semantic:1', 2, $2, $3, $4, $5, $6, 'jupiter', 'fill-provider-1',
            'finalized', 'mainnet-beta', $7, 42, 3, 1, 'finalized', $8, $9,
            400, 800, 600, 2, 1
        )
    `, [fillTwo, fillOne, orderId, legId, actionId, finalObs, signature, inputMint, outputMint]);
    await expectReject(() => db.query('UPDATE order_fills SET remaining_in = 599 WHERE id = $1', [fillTwo]),
        'fill mutation');

    const partialSchedule = randomUUID();
    await db.query(`
        INSERT INTO order_schedules (id, order_id, leg_id, round_no, state, intended_in, due_at)
        VALUES ($1, $2, $3, 1, 'planned', 500, CURRENT_TIMESTAMP)
    `, [partialSchedule, orderId, legId]);
    await db.query("UPDATE order_schedules SET state = 'due', version = 1 WHERE id = $1", [partialSchedule]);
    await db.query(`
        UPDATE order_schedules SET state = 'attempted', action_id = $2, version = 2 WHERE id = $1
    `, [partialSchedule, actionId]);
    await expectReject(() => db.query(`
        UPDATE order_schedules
           SET state = 'filled', fill_id = $2, filled_in = 400, filled_out = 800, version = 3
         WHERE id = $1
    `, [partialSchedule, fillTwo]),
    'a partial schedule principal that differs from its intended amount');

    const scheduleId = randomUUID();
    await db.query(`
        INSERT INTO order_schedules (id, order_id, leg_id, round_no, state, intended_in, due_at)
        VALUES ($1, $2, $3, 0, 'planned', 400, CURRENT_TIMESTAMP)
    `, [scheduleId, orderId, legId]);
    await db.query(`
        UPDATE order_schedules
           SET state = 'due', version = 1
         WHERE id = $1
    `, [scheduleId]);
    await db.query(`
        UPDATE order_schedules
           SET state = 'attempted', action_id = $2, version = 2
         WHERE id = $1
    `, [scheduleId, actionId]);
    await expectReject(() => db.query(`
        UPDATE order_schedules
           SET state = 'filled', fill_id = $2, filled_in = 399, filled_out = 800, version = 3
         WHERE id = $1
    `, [scheduleId, fillTwo]), 'a schedule amount that differs from its finalized fill');
    await db.query(`
        UPDATE order_schedules
           SET state = 'filled', fill_id = $2, filled_in = 400, filled_out = 800, version = 3
         WHERE id = $1
    `, [scheduleId, fillTwo]);

    const duplicateSchedule = randomUUID();
    await db.query(`
        INSERT INTO order_schedules (id, order_id, leg_id, round_no, state, intended_in, due_at)
        VALUES ($1, $2, $3, 2, 'planned', 400, CURRENT_TIMESTAMP)
    `, [duplicateSchedule, orderId, legId]);
    await db.query("UPDATE order_schedules SET state = 'due', version = 1 WHERE id = $1", [duplicateSchedule]);
    await db.query(`
        UPDATE order_schedules SET state = 'attempted', action_id = $2, version = 2 WHERE id = $1
    `, [duplicateSchedule, actionId]);
    await expectReject(() => db.query(`
        UPDATE order_schedules
           SET state = 'filled', fill_id = $2, filled_in = 400, filled_out = 800, version = 3
         WHERE id = $1
    `, [duplicateSchedule, fillTwo]), 'reuse of one finalized fill by a second schedule');

    const longFillKey = 'k'.repeat(181);
    const longObs = randomUUID();
    const longFill = randomUUID();
    const longSchedule = randomUUID();
    await db.query(`
        INSERT INTO action_obs (
            id, action_id, source, cluster, source_key, fact_key, fact_rev,
            query_kind, verdict, predicate, rule_ver, raw_state, norm_state,
            desired_hash, effect_hash, signature, slot, instruction_index, event_index,
            commitment, payload_hash, payload_ver
        ) VALUES (
            $1, $2, 'chain', 'mainnet-beta', 'chain:fill:long-key', 'chain:fill:long-fact', 1,
            'found', 'context', 'activate.chain.effect.v1', 1, 'finalized',
            'fill', $3, repeat('a', 64), $4, 42, 3, 2,
            'finalized', repeat('b', 64), 1
        )
    `, [longObs, actionId, desiredHash, signature]);
    await db.query(`
        INSERT INTO order_fills (
            id, fill_key, rev, order_id, leg_id, action_id, obs_id, provider,
            provider_fill_id, state, cluster, signature, slot, instruction_index,
            event_index, commitment, input_mint, output_mint, input_amt, output_amt,
            remaining_in, price_num, price_den
        ) VALUES (
            $1, $2, 1, $3, $4, $5, $6, 'jupiter', 'fill-provider-long',
            'finalized', 'mainnet-beta', $7, 42, 3, 2, 'finalized', $8, $9,
            100, 200, 500, 2, 1
        )
    `, [longFill, longFillKey, orderId, legId, actionId, longObs, signature, inputMint, outputMint]);
    await db.query(`
        INSERT INTO order_schedules (id, order_id, leg_id, round_no, state, intended_in, due_at)
        VALUES ($1, $2, $3, 3, 'planned', 100, CURRENT_TIMESTAMP)
    `, [longSchedule, orderId, legId]);
    await db.query("UPDATE order_schedules SET state = 'due', version = 1 WHERE id = $1", [longSchedule]);
    await db.query(`
        UPDATE order_schedules SET state = 'attempted', action_id = $2, version = 2 WHERE id = $1
    `, [longSchedule, actionId]);
    await db.query(`
        UPDATE order_schedules
           SET state = 'filled', fill_id = $2, filled_in = 100, filled_out = 200, version = 3
         WHERE id = $1
    `, [longSchedule, longFill]);
    const longKeyStored = await db.query('SELECT fill_key FROM order_fills WHERE id = $1', [longFill]);
    if (longKeyStored.rows[0]?.fill_key !== longFillKey) {
        throw new Error('Order schema did not preserve a 181-byte finalized fill key');
    }

    await expectReject(() => db.query(`
        INSERT INTO order_fills (
            id, fill_key, rev, supersedes, order_id, leg_id, action_id, obs_id, provider,
            provider_fill_id, state, cluster, signature, slot, instruction_index,
            event_index, commitment, input_mint, output_mint, input_amt, output_amt,
            remaining_in, price_num, price_den
        ) VALUES (
            gen_random_uuid(), 'fill:semantic:1', 3, $1, $2, $3, $4, $5, 'jupiter',
            'fill-provider-1', 'disputed', 'mainnet-beta', $6, 42, 3, 1,
            'finalized', $7, $8, 400, 800, 600, 2, 1
        )
    `, [fillTwo, orderId, legId, actionId, finalObs, signature, inputMint, outputMint]),
    'revision of a financially consumed fill lineage');
    await expectReject(() => db.query('DELETE FROM order_schedules WHERE id = $1', [scheduleId]),
        'schedule deletion');

    const pendingEventId = randomUUID();
    const pendingEventAt = new Date().toISOString();
    await db.query(`
        INSERT INTO order_event_keys (
            event_key, event_id, order_id, action_id, event_type, order_ver,
            event_hash, occurred_at
        ) VALUES (
            'order:event:pending', $1, $2, $3, 'action.pending', 1,
            repeat('6', 64), $4
        )
    `, [pendingEventId, orderId, actionId, pendingEventAt]);
    await expectReject(() => db.query(`
        UPDATE order_event_keys SET materialized_at = clock_timestamp()
         WHERE event_key = 'order:event:pending'
    `), 'direct event reservation consumption without its event');
    const pendingEvent = await db.query(`
        SELECT materialized_at FROM order_event_keys WHERE event_key = 'order:event:pending'
    `);
    if (pendingEvent.rows[0]?.materialized_at !== null) {
        throw new Error('Rejected event reservation consumption still burned its key');
    }

    const eventId = randomUUID();
    const eventAt = new Date().toISOString();
    await db.query('BEGIN');
    try {
        await db.query(`
            INSERT INTO order_event_keys (
                event_key, event_id, order_id, action_id, event_type, order_ver,
                event_hash, occurred_at
            ) VALUES ('order:event:1', $1, $2, $3, 'action.dispatched', 1, repeat('2', 64), $4)
        `, [eventId, orderId, actionId, eventAt]);
        await db.query(`
            INSERT INTO order_events (
                id, order_id, state, metadata, occurred_at, event_key, event_type,
                event_hash, order_ver, action_id, trace_id, actor_kind
            ) VALUES (
                $1, $2, 'dispatching', '{}'::jsonb, $3, 'order:event:1',
                'action.dispatched', repeat('2', 64), 1, $4, 'trace-1', 'system'
            )
        `, [eventId, orderId, eventAt, actionId]);
        await db.query('COMMIT');
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    }
    const consumed = await db.query(
        'SELECT materialized_at IS NOT NULL AS consumed FROM order_event_keys WHERE event_key = $1',
        ['order:event:1']
    );
    if (consumed.rows[0]?.consumed !== true) {
        throw new Error('Target lifecycle event did not consume its identity reservation');
    }
    await expectReject(() => db.query(`
        INSERT INTO order_events (
            id, order_id, state, metadata, occurred_at, event_key, event_type,
            event_hash, order_ver, action_id, trace_id, actor_kind
        ) VALUES (
            $1, $2, 'dispatching', '{}'::jsonb, $3, 'order:event:1',
            'action.dispatched', repeat('2', 64), 1, $4, 'trace-1', 'system'
        )
    `, [eventId, orderId, eventAt, actionId]), 'a second materialization of one event reservation');
    await expectReject(() => db.query("UPDATE order_events SET state = 'filled' WHERE id = $1", [eventId]),
        'target lifecycle event mutation');
    await expectReject(() => db.query('DELETE FROM order_events WHERE id = $1', [eventId]),
        'target lifecycle event deletion');
    const legacyEvent = randomUUID();
    await db.query(
        "INSERT INTO order_events (id, order_id, state) VALUES ($1, $2, 'legacy')",
        [legacyEvent, orderId]
    );
    await expectReject(() => db.query(`
        UPDATE order_events
           SET event_key = 'legacy:promotion', event_type = 'order.promoted',
               event_hash = repeat('3', 64), order_ver = 2, action_id = $2,
               trace_id = 'trace-promotion', actor_kind = 'system'
         WHERE id = $1
    `, [legacyEvent, actionId]), 'promotion of a legacy event around identity reservation');
    await db.query('DELETE FROM order_events WHERE id = $1', [legacyEvent]);

    const anomalyId = randomUUID();
    await db.query(`
        INSERT INTO order_anomalies (
            id, anomaly_key, order_id, action_id, scope, kind, severity, detail_hash
        ) VALUES ($1, 'anomaly:epoch', $2, $3, 'action', 'stale_epoch', 'critical', repeat('3', 64))
    `, [anomalyId, orderId, actionId]);
    await db.query(`
        UPDATE order_anomalies
           SET state = 'resolved', resolution_hash = repeat('4', 64), resolved_at = CURRENT_TIMESTAMP
         WHERE id = $1
    `, [anomalyId]);
    await expectReject(() => db.query('DELETE FROM order_anomalies WHERE id = $1', [anomalyId]),
        'anomaly deletion');
    await expectReject(() => db.query(`
        INSERT INTO order_anomalies (
            id, anomaly_key, order_id, action_id, scope, kind, severity, detail_hash
        ) VALUES (gen_random_uuid(), 'anomaly:no-obligation', $1, $2, 'order',
                  'provider_conflict', 'critical', repeat('5', 64))
    `, [orderId, actionId]), 'a financial anomaly without an obligation');

    const obligationId = randomUUID();
    await db.query(`
        INSERT INTO asset_obligations (
            id, obligation_key, req_hash, order_id, action_id, cluster,
            wallet_address, mint, kind, reason
        ) VALUES (
            $1, 'obligation:provider-conflict', repeat('6', 64), $2, $3, 'mainnet-beta',
            $4, $5, 'evidence_conflict', 'Provider and chain fill evidence disagree'
        )
    `, [obligationId, orderId, actionId, wallet, inputMint]);
    const financialAnomaly = randomUUID();
    await db.query(`
        INSERT INTO order_anomalies (
            id, anomaly_key, order_id, action_id, obligation_id, scope,
            kind, severity, detail_hash
        ) VALUES (
            $1, 'anomaly:provider-conflict', $2, $3, $4, 'order',
            'provider_conflict', 'critical', repeat('7', 64)
        )
    `, [financialAnomaly, orderId, actionId, obligationId]);
    await expectReject(() => db.query(`
        UPDATE order_anomalies
           SET state = 'resolved', resolution_obs = $2, resolved_at = CURRENT_TIMESTAMP
         WHERE id = $1
    `, [financialAnomaly, finalObs]), 'financial anomaly resolution with an active obligation');
    const clearEvent = randomUUID();
    const clearEvidence = randomUUID();
    await db.query(`
        INSERT INTO asset_chain_events (
            id, cluster, signature, instruction_index, event_index, slot, effect_key,
            order_id, action_id, wallet_address, mint
        ) VALUES (
            $1, 'mainnet-beta', $2, 3, 1, 42, 'obligation:provider-conflict:clear',
            $3, $4, $5, $6
        )
    `, [clearEvent, signature, orderId, actionId, wallet, inputMint]);
    await db.query(`
        INSERT INTO asset_evidence (
            id, chain_event_id, effect_key, evidence_hash, order_id, action_id, cluster,
            wallet_address, mint, source, source_key, raw_state, commitment, signature,
            slot, instruction_index, event_index, payload_hash
        ) VALUES (
            $1, $2, 'obligation:provider-conflict:clear', repeat('8', 64), $3, $4,
            'mainnet-beta', $5, $6, 'chain', $7 || ':3:1:finalized',
            'finalized', 'finalized', $7, 42, 3, 1, repeat('9', 64)
        )
    `, [clearEvidence, clearEvent, orderId, actionId, wallet, inputMint, signature]);
    await db.query(`
        UPDATE asset_obligations
           SET state = 'cleared', clear_evidence_id = $2
         WHERE id = $1
    `, [obligationId, clearEvidence]);
    await db.query(`
        UPDATE order_anomalies
           SET state = 'resolved', resolution_obs = $2, resolved_at = CURRENT_TIMESTAMP
         WHERE id = $1
    `, [financialAnomaly, finalObs]);

    const debitId = randomUUID();
    const creditId = randomUUID();
    const journalId = randomUUID();
    await db.query(`
        INSERT INTO asset_accounts (
            id, account_key, cluster, wallet_address, order_id, mint, scope, external_id
        ) VALUES
            ($1, 'anomaly:debit', 'mainnet-beta', $3, $4, $5, 'wallet', 'anomaly-debit'),
            ($2, 'anomaly:credit', 'mainnet-beta', $3, $4, $5, 'suspense', 'anomaly-credit')
    `, [debitId, creditId, wallet, orderId, inputMint]);
    const journal = {
        id: journalId,
        effectKey: 'anomaly:resolution:journal',
        reqHash: 'a'.repeat(64),
        cluster: 'mainnet-beta',
        walletAddress: wallet,
        orderId,
        legId,
        actionId,
        kind: 'fee',
        reversalOf: '',
        metadata: {},
        occurredAt: new Date().toISOString(),
        entries: [
            { lineNo: 0, accountId: debitId, side: 'debit', amount: '1' },
            { lineNo: 1, accountId: creditId, side: 'credit', amount: '1' },
        ],
    };
    await db.query('SELECT post_asset_journal($1::jsonb)', [JSON.stringify(journal)]);
    const journalEvent = randomUUID();
    const journalEvidence = randomUUID();
    const journalSignature = '7'.repeat(88);
    await db.query(`
        INSERT INTO asset_chain_events (
            id, cluster, signature, instruction_index, event_index, slot, journal_id,
            effect_key, order_id, action_id, wallet_address, mint
        ) VALUES (
            $1, 'mainnet-beta', $2, 4, 2, 43, $3,
            'anomaly:resolution:journal', $4, $5, $6, $7
        )
    `, [journalEvent, journalSignature, journalId, orderId, actionId, wallet, inputMint]);
    await db.query(`
        INSERT INTO asset_evidence (
            id, journal_id, chain_event_id, effect_key, evidence_hash, order_id, action_id,
            cluster, wallet_address, mint, source, source_key, raw_state, commitment,
            signature, slot, instruction_index, event_index, payload_hash
        ) VALUES (
            $1, $2, $3, 'anomaly:resolution:journal', repeat('c', 64), $4, $5,
            'mainnet-beta', $6, $7, 'chain', $8 || ':4:2:confirmed', 'confirmed',
            'confirmed', $8, 43, 4, 2, repeat('d', 64)
        )
    `, [
        journalEvidence, journalId, journalEvent, orderId, actionId,
        wallet, inputMint, journalSignature,
    ]);
    const confirmed = await db.query(
        "SELECT set_asset_journal_state($1, 'confirmed') AS changed", [journalId]
    );
    if (confirmed.rows[0]?.changed !== true) throw new Error('Resolution journal was not confirmed');
    const journalAnomaly = randomUUID();
    await db.query(`
        INSERT INTO order_anomalies (
            id, anomaly_key, order_id, action_id, scope, kind, severity, detail_hash
        ) VALUES (
            $1, 'anomaly:journal', $2, $3, 'action', 'stale_epoch', 'warning', repeat('b', 64)
        )
    `, [journalAnomaly, orderId, actionId]);
    await db.query(`
        UPDATE order_anomalies
           SET state = 'resolved', resolution_journal = $2, resolved_at = clock_timestamp()
         WHERE id = $1
    `, [journalAnomaly, journalId]);
    await expectReject(() => db.query(
        "SELECT set_asset_journal_state($1, 'reversed')", [journalId]
    ), 'reversal of a journal consumed by a resolved anomaly');

    const cursorId = randomUUID();
    await db.query(`
        INSERT INTO order_sync_cursors (
            id, user_id, provider, cluster, wallet_address, stream, next_at
        ) VALUES ($1, $2, 'jupiter', 'mainnet-beta', $3, 'history', CURRENT_TIMESTAMP)
    `, [cursorId, userId, wallet]);
    await db.query(`
        UPDATE order_sync_cursors
           SET version = 1, lease_owner = 'sync-a', lease_gen = 1,
               lease_until = CURRENT_TIMESTAMP + INTERVAL '5 minutes'
         WHERE id = $1
    `, [cursorId]);
    await expectReject(() => db.query(`
        UPDATE order_sync_cursors
           SET version = 2, lease_owner = 'sync-b', lease_gen = 2
         WHERE id = $1
    `, [cursorId]), 'an unexpired sync lease takeover');
    await db.query(`
        UPDATE order_sync_cursors
           SET version = 2, lease_owner = NULL, lease_until = NULL,
               cursor_value = 'cursor-1', cursor_hash = repeat('8', 64), high_slot = 42,
               high_at = CURRENT_TIMESTAMP, checked_at = CURRENT_TIMESTAMP
         WHERE id = $1
    `, [cursorId]);
    await expectReject(() => db.query(`
        UPDATE order_sync_cursors
           SET version = 3, high_slot = 41
         WHERE id = $1
    `, [cursorId]), 'a regressing sync high-water mark');
    await expectReject(() => db.query('DELETE FROM order_sync_cursors WHERE id = $1', [cursorId]),
        'sync cursor deletion and reinsertion reset');
    await expectReject(() => db.query(`
        INSERT INTO order_sync_cursors (
            id, user_id, provider, cluster, wallet_address, stream,
            lease_owner, lease_gen, lease_until, version
        ) VALUES (
            gen_random_uuid(), $1, 'jupiter', 'mainnet-beta', $2, 'chain',
            'seeded-owner', 1, clock_timestamp() + INTERVAL '5 minutes', 1
        )
    `, [userId, wallet]), 'a sync cursor seeded with an active lease');

    await db.query(`
        INSERT INTO order_actions (
            id, order_id, user_id, kind, client_key, req_hash, desired_hash,
            expected_ver, work_state, effect_state, outcome, provider, due_at
        )
        SELECT gen_random_uuid(), $1, $2, 'provider_sync', 'plan-' || n,
               repeat(md5('request-' || n), 2), repeat(md5('desired-' || n), 2),
               0, 'queued', 'not_possible', 'pending', 'jupiter',
               CURRENT_TIMESTAMP + (n || ' milliseconds')::interval
          FROM generate_series(1, 10000) AS n
    `, [orderId, userId]);
    await db.query('ANALYZE order_actions, order_sync_cursors');
    const actionPlan = await db.query(`
        EXPLAIN (FORMAT JSON)
        SELECT id FROM order_actions
         WHERE work_state IN ('queued', 'ready', 'reconciling')
           AND block_reason IS NULL AND due_at <= CURRENT_TIMESTAMP + INTERVAL '1 hour'
         ORDER BY due_at, id LIMIT 100
    `);
    if (!JSON.stringify(actionPlan.rows).includes('order_actions_due_idx')) {
        throw new Error('Due-action planner did not use the bounded hot-set index');
    }

    const current = await db.query(`
        SELECT (SELECT epoch FROM order_epoch_current WHERE scope = 'provider:jupiter') AS epoch,
               (SELECT rev FROM order_fill_current WHERE fill_key = 'fill:semantic:1') AS fill_rev
    `);
    if (current.rows[0].epoch !== '2' || current.rows[0].fill_rev !== 2) {
        throw new Error('Current epoch or fill revision projection is incorrect');
    }

    await migrate('037');
    await expectReject(() => db.query(`
        UPDATE order_intents
           SET op_kind = 'edit', op_state = 'reserved'
         WHERE id = $1
    `, [orderId]), 'an incomplete provider operation fact');
    await db.query(`
        UPDATE order_intents
           SET op_kind = 'edit', op_state = 'reserved',
               op_req_hash = repeat('a', 64), op_want_hash = repeat('b', 64),
               op_detail = '{"request":{"providerOrderId":"upgrade"},"want":{"triggerPriceUsd":42}}'::jsonb
         WHERE id = $1
    `, [orderId]);
    await db.query(`
        UPDATE order_intents
           SET op_state = 'started', op_started_at = clock_timestamp()
         WHERE id = $1
    `, [orderId]);
    await expectReject(() => db.query(`
        UPDATE order_intents SET op_want_hash = repeat('c', 64) WHERE id = $1
    `, [orderId]), 'a started provider operation identity rewrite');
    await db.query(`
        UPDATE order_intents
           SET op_kind = NULL, op_state = NULL, op_req_hash = NULL,
               op_want_hash = NULL, op_detail = NULL, op_started_at = NULL
         WHERE id = $1
    `, [orderId]);
    await migrate('038');
    const operationIndex = await db.query(`
        SELECT indisvalid, indisready
          FROM pg_index
         WHERE indexrelid = 'order_intents_unknown_op_idx'::regclass
    `);
    if (operationIndex.rowCount !== 1 || !operationIndex.rows[0].indisvalid
        || !operationIndex.rows[0].indisready) {
        throw new Error('Provider operation reconciliation index is invalid');
    }
    await migrate('039');
    const quarantinedBlob = await db.query(`
        SELECT action.work_state, action.effect_state, action.outcome, action.block_reason,
               blob.aad_ver, blob.raw_hash,
               EXISTS (
                   SELECT 1 FROM order_anomalies anomaly
                    WHERE anomaly.anomaly_key = 'migration:v39:signed-policy:' || action.id::text
                      AND anomaly.state = 'open' AND anomaly.blocks_actions
               ) AS anomaly
          FROM order_actions action
          JOIN order_tx_blobs blob ON blob.action_id = action.id
         WHERE action.id = $1
    `, [clockReadAction]);
    if (quarantinedBlob.rows[0]?.work_state !== 'parked'
        || quarantinedBlob.rows[0]?.effect_state !== 'possible'
        || quarantinedBlob.rows[0]?.outcome !== 'manual_review'
        || quarantinedBlob.rows[0]?.block_reason !== 'operator_hold'
        || quarantinedBlob.rows[0]?.aad_ver !== 1
        || quarantinedBlob.rows[0]?.raw_hash !== null
        || quarantinedBlob.rows[0]?.anomaly !== true) {
        throw new Error('V039 did not quarantine an undecryptable legacy signed action');
    }

    const v2Order = randomUUID();
    const v2Action = randomUUID();
    const v2Attempt = randomUUID();
    const v2Message = 'c'.repeat(64);
    const v2Signature = '7'.repeat(88);
    const v2Blockhash = '8'.repeat(44);
    await db.query(`
        INSERT INTO order_intents (
            id, user_id, provider, client_order_id, request_digest, wallet_address,
            order_type, state, input_mint, output_mint, input_amount, trigger_mint,
            params, expires_at, cluster
        ) VALUES (
            $1, $2, 'jupiter', 'blob-v2-order', repeat('d', 64), $3,
            'single', 'prepared', $4, $5, 1, $5, '{}'::jsonb,
            clock_timestamp() + INTERVAL '1 day', 'mainnet-beta'
        )
    `, [v2Order, userId, wallet, inputMint, outputMint]);
    await db.query(`
        INSERT INTO order_actions (
            id, order_id, user_id, kind, client_key, req_hash, desired_hash,
            expected_ver, work_state, effect_state, outcome, provider, due_at
        ) VALUES (
            $1, $2, $3, 'activate', 'blob-v2-action', repeat('e', 64), repeat('f', 64),
            0, 'queued', 'not_possible', 'pending', 'jupiter', clock_timestamp()
        )
    `, [v2Action, v2Order, userId]);
    await db.query(`
        UPDATE order_actions
           SET action_ver = 1, work_state = 'awaiting_sig', message_hash = $2,
               recent_blockhash = $3, last_valid_height = 500000000
         WHERE id = $1
    `, [v2Action, v2Message, v2Blockhash]);
    await expectReject(() => db.query(`
        UPDATE order_actions
           SET action_ver = 2, last_valid_height = 500000001
         WHERE id = $1
    `, [v2Action]), 'a prepared transaction validity rewrite before blob binding');
    await db.query(`
        UPDATE order_actions
           SET action_ver = 2, work_state = 'ready', first_signature = $2
         WHERE id = $1
    `, [v2Action, v2Signature]);
    await expectReject(() => db.query(`
        INSERT INTO order_tx_blobs (
            action_id, order_id, cluster, wallet_address, alg, ciphertext, nonce,
            wrapped_key, key_id, aad_hash, message_hash, first_signature, byte_size, expires_at
        ) VALUES (
            $1, $2, 'mainnet-beta', $3, 'aes_256_gcm', decode(repeat('11', 33), 'hex'),
            decode(repeat('22', 12), 'hex'), decode(repeat('33', 32), 'hex'),
            'kms:v2', repeat('a', 64), $4, $5, 256, clock_timestamp() + INTERVAL '1 minute'
        )
    `, [v2Action, v2Order, wallet, v2Message, v2Signature]),
    'an N-1 signed blob bind without reconstructable authenticated data');
    await db.query(`
        INSERT INTO order_tx_blobs (
            action_id, order_id, cluster, wallet_address, alg, ciphertext, nonce,
            wrapped_key, key_id, aad_hash, message_hash, raw_hash,
            first_signature, byte_size, expires_at, aad_ver
        ) VALUES (
            $1, $2, 'mainnet-beta', $3, 'aes_256_gcm', decode(repeat('11', 33), 'hex'),
            decode(repeat('22', 12), 'hex'), decode(repeat('33', 32), 'hex'),
            'kms:v2', repeat('a', 64), $4, repeat('b', 64),
            $5, 256, clock_timestamp() + INTERVAL '1 minute', 2
        )
    `, [v2Action, v2Order, wallet, v2Message, v2Signature]);
    await db.query(`
        UPDATE order_actions
           SET action_ver = 3, lease_owner = 'blob-v2-worker', lease_gen = 1,
               lease_until = clock_timestamp() + INTERVAL '45 seconds',
               write_scope = 'provider:jupiter', write_epoch = 2
         WHERE id = $1
    `, [v2Action]);
    await db.query(`
        UPDATE order_actions
           SET action_ver = 4, work_state = 'dispatching', effect_state = 'possible',
               ambiguity_at = clock_timestamp(), attempt_count = 1
         WHERE id = $1
    `, [v2Action]);
    await expectReject(() => db.query(`
        INSERT INTO action_attempts (
            id, action_id, seq, lease_gen, write_scope, write_epoch, endpoint,
            method, provider, req_hash, body_hash, desired_hash, blob_action_id,
            send_state, started_at, deadline_at
        ) VALUES (
            gen_random_uuid(), $1, 1, 1, 'provider:jupiter', 2, '/blob-v2-late',
            'POST', 'jupiter', repeat('e', 64), repeat('1', 64), repeat('f', 64), $1,
            'started', clock_timestamp(), clock_timestamp() + INTERVAL '2 minutes'
        )
    `, [v2Action]), 'a signed attempt whose blob expires before its deadline');
    await db.query(`
        INSERT INTO action_attempts (
            id, action_id, seq, lease_gen, write_scope, write_epoch, endpoint,
            method, provider, req_hash, body_hash, desired_hash, blob_action_id,
            send_state, started_at, deadline_at
        ) VALUES (
            $1, $2, 1, 1, 'provider:jupiter', 2, '/blob-v2',
            'POST', 'jupiter', repeat('e', 64), repeat('1', 64), repeat('f', 64), $2,
            'started', clock_timestamp(), clock_timestamp() + INTERVAL '10 seconds'
        )
    `, [v2Attempt, v2Action]);
    await expectReject(() => db.query(`
        INSERT INTO order_blob_reads (
            id, access_key, action_id, attempt_id, lease_owner,
            lease_gen, write_scope, write_epoch, gateway, purpose
        ) VALUES (
            gen_random_uuid(), 'blob-v2-wrong-owner', $1, $2, 'other-worker',
            1, 'provider:jupiter', 2, 'gateway-v2', 'dispatch'
        )
    `, [v2Action, v2Attempt]), 'a blob read from the wrong lease owner');
    await expectReject(() => db.query(`
        INSERT INTO order_blob_reads (
            id, access_key, action_id, attempt_id,
            lease_gen, write_scope, write_epoch, gateway, purpose
        ) VALUES (
            gen_random_uuid(), 'blob-v2-n-minus-one', $1, $2,
            1, 'provider:jupiter', 2, 'gateway-v2', 'dispatch'
        )
    `, [v2Action, v2Attempt]), 'an N-1 blob read without its lease owner');
    await db.query(`
        INSERT INTO order_blob_reads (
            id, access_key, action_id, attempt_id, lease_owner,
            lease_gen, write_scope, write_epoch, gateway, purpose
        ) VALUES (
            gen_random_uuid(), 'blob-v2-read', $1, $2, 'blob-v2-worker',
            1, 'provider:jupiter', 2, 'gateway-v2', 'dispatch'
        )
    `, [v2Action, v2Attempt]);
    await migrate('040');
    await db.query('ANALYZE order_intents');
    const naturalCutoverPlan = await db.query(`
        EXPLAIN (FORMAT JSON)
        SELECT id FROM order_intents
         WHERE op_token IS NOT NULL
            OR op_lease_until IS NOT NULL
            OR op_state IS NOT NULL
            OR error_code = 'provider_outcome_unknown'
         LIMIT 1
    `);
    if (!JSON.stringify(naturalCutoverPlan.rows).includes('order_intents_op_cutover_idx')) {
        throw new Error('Natural operation cutover audit did not use its bounded partial index');
    }
    await db.query('SET enable_seqscan = off');
    const cutoverPlan = await db.query(`
        EXPLAIN (FORMAT JSON)
        SELECT id FROM order_intents
         WHERE op_token IS NOT NULL
            OR op_lease_until IS NOT NULL
            OR op_state IS NOT NULL
            OR error_code = 'provider_outcome_unknown'
         LIMIT 1
    `);
    await db.query('RESET enable_seqscan');
    if (!JSON.stringify(cutoverPlan.rows).includes('order_intents_op_cutover_idx')) {
        throw new Error('Forced operation cutover audit did not use its bounded partial index');
    }
    await migrate('041');
    await migrate('042');
    await migrate('043');

    await db.query(
        'SELECT assert_blob_access($1, $2, $3, $4, $5, $6)',
        [v2Action, v2Attempt, 'blob-v2-worker', 1, 'provider:jupiter', 2]
    );
    const replayedRead = await db.query(`
        INSERT INTO order_blob_reads (
            id, access_key, action_id, attempt_id, lease_owner,
            lease_gen, write_scope, write_epoch, gateway, purpose
        ) VALUES (
            gen_random_uuid(), 'blob-v2-read', $1, $2, 'blob-v2-worker',
            1, 'provider:jupiter', 2, 'gateway-v2', 'dispatch'
        )
        ON CONFLICT (access_key) DO NOTHING
        RETURNING id
    `, [v2Action, v2Attempt]);
    if (replayedRead.rowCount !== 0) {
        throw new Error('Exact blob-access retry created a second authorization fact');
    }

    const blobReader = await open();
    const blobResponder = await open();
    try {
        await blobReader.query('BEGIN');
        await blobReader.query(`
            INSERT INTO order_blob_reads (
                id, access_key, action_id, attempt_id, lease_owner,
                lease_gen, write_scope, write_epoch, gateway, purpose
            ) VALUES (
                gen_random_uuid(), 'blob-v2-response-race', $1, $2, 'blob-v2-worker',
                1, 'provider:jupiter', 2, 'gateway-v2', 'dispatch'
            )
        `, [v2Action, v2Attempt]);
        await blobResponder.query("SET application_name = 'fervor-blob-response-race'");
        const response = blobResponder.query(`
            UPDATE action_attempts
               SET send_state = 'response_recorded', completed_at = clock_timestamp(),
                   http_status = 202, http_class = 'success', response_hash = repeat('f', 64),
                   provider_effect_id = 'blob-v2-effect'
             WHERE id = $1
        `, [v2Attempt]).then(() => null, (error) => error);
        const lock = await waitForLock(db, 'fervor-blob-response-race');
        if (!['Lock', 'LWLock'].includes(lock.wait_event_type)) {
            throw new Error(`Blob response reached an unexpected wait: ${JSON.stringify(lock)}`);
        }
        await blobReader.query(`
            SELECT action.id
              FROM order_actions action
              JOIN order_intents order_row ON order_row.id = action.order_id
              LEFT JOIN order_tx_blobs blob ON blob.action_id = action.id
             WHERE action.id = $1
        `, [v2Action]);
        await blobReader.query('COMMIT');
        const error = await response;
        if (error !== null) {
            throw new Error('Blob read and response lock order did not converge', { cause: error });
        }
    } finally {
        await blobReader.query('ROLLBACK').catch(() => {});
        await blobResponder.query('ROLLBACK').catch(() => {});
        await close(blobReader);
        await close(blobResponder);
    }
    await expectReject(() => db.query(
        'SELECT assert_blob_access($1, $2, $3, $4, $5, $6)',
        [v2Action, v2Attempt, 'blob-v2-worker', 1, 'provider:jupiter', 2]
    ), 'a blob-access retry after its attempt response');
    await migrate('044');
    await migrate('045');

    await expectReject(() => db.query(`
        INSERT INTO order_intents (
            id, user_id, provider, client_order_id, request_digest, wallet_address,
            order_type, state, input_mint, output_mint, input_amount, trigger_mint,
            params, expires_at, op_token, op_lease_until
        ) VALUES (
            gen_random_uuid(), $1, 'legacy', 'post-cutover-old-insert', repeat('4', 64), $2,
            'single', 'preparing', $3, $4, 1, $4, '{}'::jsonb,
            clock_timestamp() + INTERVAL '1 day', 'n-minus-one-insert',
            clock_timestamp() + INTERVAL '1 minute'
        )
    `, [userId, wallet, inputMint, outputMint]), 'an N-1 factless mutation insert');
    await expectReject(() => db.query(`
        UPDATE order_intents
           SET op_token = 'n-minus-one-acquire',
               op_lease_until = clock_timestamp() + INTERVAL '1 minute'
         WHERE id = $1
    `, [orderId]), 'an N-1 factless mutation lease');

    await db.query(`
        UPDATE order_intents
           SET op_token = 'writer-v2-reservation',
               op_lease_until = clock_timestamp() + INTERVAL '1 minute',
               op_kind = 'edit', op_state = 'reserved',
               op_req_hash = repeat('5', 64), op_want_hash = repeat('6', 64),
               op_detail = '{"request":{"providerOrderId":"cutover"},"want":{"triggerPriceUsd":42}}'::jsonb,
               op_started_at = NULL, unknown_at = NULL, unknown_detail = NULL,
               op_writer = 2, op_ver = op_ver + 1
         WHERE id = $1
    `, [orderId]);
    await expectReject(() => db.query(
        'DELETE FROM order_intents WHERE id = $1', [orderId]
    ), 'direct deletion of an active provider operation fact');

    const deleteUser = randomUUID();
    const deleteOrder = randomUUID();
    await db.query(
        'INSERT INTO users (id, wallet_address) VALUES ($1, $2)',
        [deleteUser, `DeleteBarrierWallet${randomBytes(8).toString('hex')}`]
    );
    await db.query(`
        INSERT INTO order_intents (
            id, user_id, provider, client_order_id, request_digest, wallet_address,
            order_type, state, input_mint, output_mint, input_amount, trigger_mint,
            params, expires_at
        ) VALUES (
            $1, $2, 'fixture', 'delete-barrier', repeat('7', 64), $3,
            'single', 'open', $4, $5, 1, $5, '{}'::jsonb,
            clock_timestamp() + INTERVAL '1 day'
        )
    `, [deleteOrder, deleteUser, `DeleteOrderWallet${randomBytes(8).toString('hex')}`,
        inputMint, outputMint]);
    await db.query(`
        UPDATE order_intents
           SET op_token = 'delete-barrier-token',
               op_lease_until = clock_timestamp() + INTERVAL '1 minute',
               op_kind = 'edit', op_state = 'reserved',
               op_req_hash = repeat('7', 64), op_want_hash = repeat('8', 64),
               op_detail = '{"request":{"providerOrderId":"delete"},"want":{"triggerPriceUsd":42}}'::jsonb,
               op_writer = 2, op_ver = op_ver + 1
         WHERE id = $1
    `, [deleteOrder]);
    await expectReject(() => db.query(
        'DELETE FROM users WHERE id = $1', [deleteUser]
    ), 'cascaded deletion of an active provider operation fact');
    await db.query(`
        UPDATE order_intents
           SET op_token = NULL, op_lease_until = NULL,
               op_kind = NULL, op_state = NULL, op_req_hash = NULL, op_want_hash = NULL,
               op_detail = NULL, op_started_at = NULL, unknown_at = NULL, unknown_detail = NULL,
               op_writer = NULL
         WHERE id = $1
    `, [deleteOrder]);
    await db.query('DELETE FROM users WHERE id = $1', [deleteUser]);
    await expectReject(() => db.query(`
        UPDATE order_intents
           SET op_token = 'n-minus-one-takeover',
               op_lease_until = clock_timestamp() + INTERVAL '2 minutes'
         WHERE id = $1
    `, [orderId]), 'an N-1 takeover of a versioned reservation');
    await expectReject(() => db.query(`
        UPDATE order_intents
           SET op_kind = NULL
         WHERE id = $1
    `, [orderId]), 'a null-hole provider operation fact');
    await db.query(`
        UPDATE order_intents
           SET op_state = 'started', op_started_at = clock_timestamp()
         WHERE id = $1
    `, [orderId]);
    await expectReject(() => db.query(`
        UPDATE order_intents
           SET op_state = 'reserved', op_started_at = NULL
         WHERE id = $1
    `, [orderId]), 'a started provider operation downgrade');
    await db.query(`
        UPDATE order_intents
           SET error_code = 'provider_outcome_unknown',
               error_message = 'cutover test ambiguity',
               unknown_at = clock_timestamp(),
               unknown_detail = '{"providerCode":"timeout","evidence":{}}'::jsonb,
               op_token = NULL, op_lease_until = NULL,
               op_ver = op_ver + 1
         WHERE id = $1
    `, [orderId]);
    await expectReject(() => db.query(`
        UPDATE order_intents
           SET error_code = NULL, error_message = NULL,
               op_kind = NULL, op_state = NULL, op_req_hash = NULL,
               op_want_hash = NULL, op_detail = NULL, op_started_at = NULL,
               unknown_at = NULL, unknown_detail = NULL
         WHERE id = $1
    `, [orderId]), 'an N-1 clear of a started provider operation');
    await db.query(`
        UPDATE order_intents
           SET error_code = NULL, error_message = NULL,
               op_kind = NULL, op_state = NULL, op_req_hash = NULL,
               op_want_hash = NULL, op_detail = NULL, op_started_at = NULL,
               unknown_at = NULL, unknown_detail = NULL,
               op_writer = NULL
         WHERE id = $1
    `, [orderId]);
    const clearedOp = await db.query(
        'SELECT op_ver FROM order_intents WHERE id = $1', [orderId]
    );
    if (clearedOp.rows[0]?.op_ver !== '2') {
        throw new Error('Resolved provider operation reset its lifetime generation');
    }
    await db.query(`
        UPDATE order_intents
           SET op_token = 'writer-v2-next-reservation',
               op_lease_until = clock_timestamp() + INTERVAL '1 minute',
               op_kind = 'edit', op_state = 'reserved',
               op_req_hash = repeat('9', 64), op_want_hash = repeat('a', 64),
               op_detail = '{"request":{"providerOrderId":"next"},"want":{"triggerPriceUsd":43}}'::jsonb,
               op_writer = 2, op_ver = op_ver + 1
         WHERE id = $1
    `, [orderId]);
    await db.query(`
        UPDATE order_intents
           SET op_token = NULL, op_lease_until = NULL,
               op_kind = NULL, op_state = NULL, op_req_hash = NULL, op_want_hash = NULL,
               op_detail = NULL, op_started_at = NULL, unknown_at = NULL, unknown_detail = NULL,
               op_writer = NULL
         WHERE id = $1
    `, [orderId]);
    const nextOp = await db.query(
        'SELECT op_ver FROM order_intents WHERE id = $1', [orderId]
    );
    if (nextOp.rows[0]?.op_ver !== '3') {
        throw new Error('Provider operation lifetime generation did not advance monotonically');
    }
    await migrate('048');
    const legacyClaimOrder = randomUUID();
    const legacyClaimAction = randomUUID();
    const legacyEvidence = randomUUID();
    const legacyObligation = randomUUID();
    const vault = '8Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
    await db.query(`
        INSERT INTO order_intents (
            id, user_id, provider, provider_order_id, client_order_id, request_digest,
            wallet_address, order_type, state, input_mint, output_mint, input_amount,
            trigger_mint, params, receiver_address, cluster, expires_at
        ) VALUES (
            $1, $2, 'jupiter_trigger_v2', $3, $4, repeat('b', 64),
            $5, 'single', 'open', $6, $7, 5, $7, '{}'::jsonb, $8,
            'mainnet-beta', clock_timestamp() + INTERVAL '1 day'
        )
    `, [legacyClaimOrder, userId, `provider-${legacyClaimOrder}`, `claim-${legacyClaimOrder}`,
        wallet, inputMint, outputMint, vault]);
    await db.query('BEGIN');
    try {
        await db.query(`
            INSERT INTO asset_evidence (
                id, effect_key, evidence_hash, order_id, action_id, source, source_key,
                cluster, wallet_address, vault_address, mint, raw_state,
                payload_hash, source_at
            ) VALUES (
                $1, $2, repeat('c', 64), $3, $4, 'provider', $5,
                'mainnet-beta', $6, $7, $8, 'success', repeat('d', 64), clock_timestamp()
            )
        `, [legacyEvidence, `legacy-effect:${legacyClaimOrder}`, legacyClaimOrder,
            legacyClaimAction, `legacy-source:${legacyClaimOrder}`, wallet, vault, inputMint]);
        await db.query(`
            INSERT INTO asset_obligations (
                id, obligation_key, req_hash, order_id, action_id, cluster, wallet_address,
                vault_address, mint, kind, amount, open_evidence_id, reason
            ) VALUES (
                $1, $2, repeat('e', 64), $3, $4, 'mainnet-beta', $5,
                $6, $7, 'deposit_unknown', 5, $8, 'Legacy provider claim'
            )
        `, [legacyObligation, `legacy-claim:${legacyClaimOrder}`, legacyClaimOrder,
            legacyClaimAction, wallet, vault, inputMint, legacyEvidence]);
        await db.query(`
            INSERT INTO asset_claim_parts (
                obligation_id, line_no, role, mint, amount, evidence_id, part_hash
            ) VALUES ($1, 0, 'movement', $2, 5, $3, repeat('f', 64))
        `, [legacyObligation, inputMint, legacyEvidence]);
        await db.query('COMMIT');
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    }
    await db.query(`
        CREATE VIEW asset_circuit_probe AS
        SELECT obligation_id, mint FROM asset_circuits
    `);
    await db.query('GRANT SELECT ON asset_circuits, asset_circuit_probe TO core_runtime');
    await migrate('049');
    const claimView = await db.query(`
        SELECT to_regclass('asset_circuit_probe') IS NOT NULL AS dependency_kept,
               has_table_privilege('core_runtime', 'asset_circuits', 'SELECT') AS grant_kept,
               has_table_privilege('core_runtime', 'asset_circuit_probe', 'SELECT') AS probe_grant
    `);
    if (claimView.rows[0]?.dependency_kept !== true
        || claimView.rows[0]?.grant_kept !== true
        || claimView.rows[0]?.probe_grant !== true) {
        throw new Error(`Provider claim view compatibility was not preserved: ${JSON.stringify(claimView.rows[0])}`);
    }
    const legacyClaim = await db.query(`
        SELECT obligation.claim_ver, obligation.claim_count,
               obligation.claim_hash IS NOT NULL AS has_hash,
               evidence.payload IS NULL AS payload_absent,
               anomaly.kind, anomaly.blocks_actions
          FROM asset_obligations obligation
          JOIN asset_evidence evidence ON evidence.id = obligation.open_evidence_id
          JOIN order_anomalies anomaly ON anomaly.obligation_id = obligation.id
         WHERE obligation.id = $1
    `, [legacyObligation]);
    if (legacyClaim.rows[0]?.claim_ver !== 1
        || legacyClaim.rows[0]?.claim_count !== 1
        || legacyClaim.rows[0]?.has_hash !== true
        || legacyClaim.rows[0]?.payload_absent !== true
        || legacyClaim.rows[0]?.kind !== 'policy_violation'
        || legacyClaim.rows[0]?.blocks_actions !== true) {
        throw new Error(`Legacy provider claim was not quarantined: ${JSON.stringify(legacyClaim.rows[0])}`);
    }
    await migrate('050');
    const txAcl = await db.query(`
        SELECT count(DISTINCT fn.oid)::integer AS function_count,
               count(*) FILTER (
                   WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
               )::integer AS public_exec
          FROM pg_proc fn
          CROSS JOIN LATERAL aclexplode(
              coalesce(fn.proacl, acldefault('f', fn.proowner))
          ) acl
         WHERE fn.oid IN (
             to_regprocedure('assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)'),
             to_regprocedure('order_blob_read_guard()'),
             to_regprocedure('purge_order_tx_blob(uuid,character varying,timestamp with time zone)')
         )
    `);
    if (txAcl.rows[0]?.function_count !== 3
        || txAcl.rows[0]?.public_exec !== 0) {
        throw new Error(`Transaction runtime function ACL is not least privilege: ${JSON.stringify(txAcl.rows[0])}`);
    }
    const roleAcl = await db.query(`
        SELECT has_function_privilege(
                   'core_runtime',
                   'assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)',
                   'EXECUTE'
               ) AS runtime_assert,
               has_function_privilege('core_runtime', 'order_blob_read_guard()', 'EXECUTE') AS runtime_guard,
               has_function_privilege(
                   'core_runtime',
                   'purge_order_tx_blob(uuid,character varying,timestamp with time zone)',
                   'EXECUTE'
               ) AS runtime_purge,
               has_function_privilege(
                   'core_maintenance',
                   'purge_order_tx_blob(uuid,character varying,timestamp with time zone)',
                   'EXECUTE'
               ) AS maintenance_purge,
               has_function_privilege(
                   'core_maintenance',
                   'assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)',
                   'EXECUTE'
               ) AS maintenance_assert
    `);
    if (roleAcl.rows[0]?.runtime_assert !== true
        || roleAcl.rows[0]?.runtime_guard !== false
        || roleAcl.rows[0]?.runtime_purge !== false
        || roleAcl.rows[0]?.maintenance_purge !== true
        || roleAcl.rows[0]?.maintenance_assert !== false) {
        throw new Error(`Transaction production role ACL is not least privilege: ${JSON.stringify(roleAcl.rows[0])}`);
    }
    await db.query('SET ROLE core_runtime');
    try {
        const runtimeError = await expectReject(() => db.query(
            `SELECT assert_blob_access(
                gen_random_uuid(), gen_random_uuid(), 'acl-runtime', 1, 'acl-scope', 1
            )`
        ), 'runtime execution of signed-blob authorization');
        if (runtimeError.code !== '23514') {
            throw new Error(`Runtime blob authorization failed below the function boundary: ${runtimeError.code}`);
        }
        let purgeDenied = false;
        try {
            await db.query(
                "SELECT purge_order_tx_blob(gen_random_uuid(), 'runtime-denied', clock_timestamp())"
            );
        } catch (error) {
            purgeDenied = error instanceof Error && error.code === '42501';
        }
        if (!purgeDenied) throw new Error('Runtime role can execute the maintenance purge');
    } finally {
        await db.query('RESET ROLE');
    }

    await db.query('SET ROLE core_maintenance');
    try {
        const purged = await db.query(
            "SELECT purge_order_tx_blob(gen_random_uuid(), 'maintenance-check', clock_timestamp()) AS purged"
        );
        if (purged.rows[0]?.purged !== false) {
            throw new Error('Maintenance purge did not execute through its security-definer boundary');
        }
        let assertDenied = false;
        try {
            await db.query(`SELECT assert_blob_access(
                gen_random_uuid(), gen_random_uuid(), 'maintenance-denied', 1, 'acl-scope', 1
            )`);
        } catch (error) {
            assertDenied = error instanceof Error && error.code === '42501';
        }
        if (!assertDenied) throw new Error('Maintenance role can execute runtime blob authorization');
    } finally {
        await db.query('RESET ROLE');
    }
    await migrate('051');
    await migrate('052');
    await migrate('053');
    await migrate('054');
    await db.query('GRANT CREATE ON SCHEMA public TO PUBLIC');
    await migrate('055');
    let identityRejected = false;
    try {
        await migrate('056');
    } catch (error) {
        identityRejected = error instanceof Error
            && [error.message, error.stdout, error.stderr]
                .some((value) => String(value || '').includes(
                    'asset circuit upgrade found crossed or dangling action identity'
                ));
    }
    if (!identityRejected) {
        throw new Error('Asset circuit upgrade accepted a dangling legacy action identity');
    }
    await db.query(`
        INSERT INTO order_actions (
            id, order_id, user_id, kind, client_key, req_hash, desired_hash,
            expected_ver, work_state, effect_state, outcome, provider, due_at
        ) VALUES (
            $1, $2, $3, 'provider_sync', $4, repeat('1', 64), repeat('2', 64),
            0, 'queued', 'not_possible', 'pending', 'jupiter_trigger_v2',
            clock_timestamp()
        )
    `, [legacyClaimAction, legacyClaimOrder, userId,
        `legacy-claim-repair:${legacyClaimAction}`]);
    await migrate('056');
    await expectReject(() => db.query(`
        INSERT INTO asset_obligations (
            id, obligation_key, req_hash, order_id, action_id, cluster,
            wallet_address, mint, kind, amount, reason
        ) VALUES (
            gen_random_uuid(), $1, repeat('2', 64), $2, gen_random_uuid(),
            'mainnet-beta', $3, $4, 'provider_missing', 1,
            'Future dangling action must fail closed'
        )
    `, [`future-dangling:${legacyClaimOrder}`, legacyClaimOrder, wallet, inputMint]),
    'a future dangling asset action identity');
    const legacyAclRole = `core_legacy_acl_${process.pid}_${randomBytes(3).toString('hex')}`;
    if (!/^core_legacy_acl_[a-zA-Z0-9_]+$/.test(legacyAclRole)) {
        throw new Error('Unsafe legacy ACL fixture role');
    }
    await admin.query(`CREATE ROLE "${legacyAclRole}" NOLOGIN`);
    await db.query(`GRANT EXECUTE ON FUNCTION purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ)
        TO "${legacyAclRole}"`);
    await db.query(`GRANT EXECUTE ON FUNCTION assert_blob_access(
        UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT
    ) TO core_runtime WITH GRANT OPTION`);
    await db.query('SET ROLE core_runtime');
    try {
        await db.query(`GRANT EXECUTE ON FUNCTION assert_blob_access(
            UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT
        ) TO "${legacyAclRole}"`);
    } finally {
        await db.query('RESET ROLE');
    }
    await migrate('057');
    const legacyV2Input = randomUUID();
    const legacyV2Output = randomUUID();
    const legacyV2Claim = randomUUID();
    const legacyV2Doc = '{"event":"legacy-v2","ver":1}';
    const legacyV2CrossedDoc = '{"event":"legacy-v2-crossed","ver":1}';
    const legacyV2Payload = createHash('sha256').update(legacyV2Doc).digest('hex');
    const legacyV2CrossedPayload = createHash('sha256')
        .update(legacyV2CrossedDoc).digest('hex');
    const legacyV2InputHash = createHash('sha256')
        .update(`input|${inputMint}|2|${legacyV2Input}`).digest('hex');
    const legacyV2OutputHash = createHash('sha256')
        .update(`output|${outputMint}|3|${legacyV2Output}`).digest('hex');
    const legacyV2ClaimHash = createHash('sha256')
        .update(`0|${legacyV2InputHash}\n1|${legacyV2OutputHash}`).digest('hex');
    await db.query('BEGIN');
    try {
        await db.query(`
            INSERT INTO asset_evidence (
                id, effect_key, evidence_hash, order_id, action_id, source, source_key,
                cluster, wallet_address, vault_address, mint, raw_state, signature,
                payload_hash, payload, source_at
            ) VALUES
                ($1, $3, repeat('6', 64), $4, $5, 'provider', $6,
                 'mainnet-beta', $7, $8, $9, 'success', repeat('6', 88),
                 $10, $11::jsonb, '2026-08-03T20:00:00Z'),
                ($2, $3, repeat('7', 64), $4, $5, 'provider', $12,
                 'mainnet-beta', $7, $8, $13, 'success', repeat('6', 88),
                 $14, $15::jsonb, '2026-08-03T20:00:00Z')
        `, [legacyV2Input, legacyV2Output, `legacy-v2-effect:${legacyClaimOrder}`,
            legacyClaimOrder, legacyClaimAction, `legacy-v2-input:${legacyClaimOrder}`,
            wallet, vault, inputMint, legacyV2Payload, legacyV2Doc,
            `legacy-v2-output:${legacyClaimOrder}`, outputMint,
            legacyV2CrossedPayload, legacyV2CrossedDoc]);
        await db.query(`
            INSERT INTO asset_obligations (
                id, obligation_key, req_hash, order_id, action_id, cluster, wallet_address,
                vault_address, mint, kind, amount, open_evidence_id, reason,
                claim_ver, claim_count, claim_hash
            ) VALUES (
                $1, $2, repeat('8', 64), $3, $4, 'mainnet-beta', $5,
                $6, $7, 'fill_unverified', 2, $8, 'Pre-V058 canonical recovery',
                2, 2, $9
            )
        `, [legacyV2Claim, `legacy-v2-claim:${legacyClaimOrder}`, legacyClaimOrder,
            legacyClaimAction, wallet, vault, inputMint, legacyV2Input, legacyV2ClaimHash]);
        await db.query(`
            INSERT INTO asset_claim_parts (
                obligation_id, line_no, role, mint, amount, evidence_id, part_hash
            ) VALUES
                ($1, 0, 'input', $2, 2, $3, $4),
                ($1, 1, 'output', $5, 3, $6, $7)
        `, [legacyV2Claim, inputMint, legacyV2Input, legacyV2InputHash,
            outputMint, legacyV2Output, legacyV2OutputHash]);
        await db.query('COMMIT');
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    }
    await migrate('058');

    const legacySwapQuote = randomUUID();
    const legacySwapExec = randomUUID();
    await db.query(`
        INSERT INTO trade_quotes (
            id, user_id, wallet_address, provider, provider_quote_id,
            input_mint, output_mint, input_amount, output_amount,
            min_output_amount, slippage_bps, fee_payer, transaction_digest,
            integrity_digest, state, expires_at
        ) VALUES (
            $1, $2, $3, 'jupiter_swap_v2', $4, $5, $6, 1, 2, 1, 100,
            $3, repeat('a', 64), repeat('b', 64), 'consumed',
            clock_timestamp() + INTERVAL '1 hour'
        )
    `, [legacySwapQuote, userId, wallet, `v59-cutover:${legacySwapQuote}`,
        inputMint, outputMint]);
    await db.query(`
        INSERT INTO trade_executions (
            id, quote_id, user_id, wallet_address, provider, idempotency_key,
            state, signature, input_mint, output_mint, expected_input_amount,
            expected_output_amount, signed_tx_digest
        ) VALUES (
            $1, $2, $3, $4, 'jupiter_swap_v2', $5, 'signed', repeat('5', 88),
            $6, $7, 1, 2, repeat('c', 64)
        )
    `, [legacySwapExec, legacySwapQuote, userId, wallet,
        `v59-cutover:${legacySwapExec}`, inputMint, outputMint]);

    const legacySwap = await open();
    await legacySwap.query('BEGIN');
    await legacySwap.query(`
        UPDATE trade_executions
           SET op_token = 'n-minus-one-v59',
               op_lease_until = clock_timestamp() + INTERVAL '1 minute',
               broadcast_started_at = clock_timestamp(),
               broadcast_count = 1
         WHERE id = $1
    `, [legacySwapExec]);
    let cutoverError;
    const deployV59 = migrate('059')
        .catch((error) => { cutoverError = error; });
    const cutoverWait = await waitForRelationLock(
        db, 'trade_executions', 'ShareRowExclusiveLock'
    );
    if (cutoverWait.wait_event_type !== 'Lock') {
        throw new Error(`V059 did not wait at its execution write barrier: ${JSON.stringify(cutoverWait)}`);
    }
    await legacySwap.query('COMMIT');
    await close(legacySwap);
    await deployV59;
    if (!(cutoverError instanceof Error)
        || ![cutoverError.message, cutoverError.stdout, cutoverError.stderr]
            .some((value) => String(value || '').includes(
                'execution blob cutover requires drained Jupiter claims'
            ))) {
        throw new Error('V059 accepted an N-1 worker paused between claim and swap egress');
    }
    await db.query(`
        UPDATE trade_executions
           SET op_token = NULL, op_lease_until = NULL
         WHERE id = $1
    `, [legacySwapExec]);
    await migrate('059');
    await expectReject(() => db.query(`
        UPDATE trade_executions
           SET op_token = 'n-minus-one-after-v59',
               op_lease_until = clock_timestamp() + INTERVAL '1 minute',
               broadcast_count = broadcast_count + 1
         WHERE id = $1
    `, [legacySwapExec]), 'an N-1 swap claim after the V059 cutover');
    await db.query(`
        UPDATE trade_executions
           SET state = 'confirmed',
               actual_input_amount = 1,
               actual_output_amount = 2,
               confirmed_at = clock_timestamp(),
               op_token = 'n-minus-one-v60',
               op_lease_until = clock_timestamp() + INTERVAL '1 minute'
         WHERE id = $1
    `, [legacySwapExec]);
    let settlementCutoverError;
    try {
        await migrate('060');
    } catch (error) {
        settlementCutoverError = error;
    }
    if (!(settlementCutoverError instanceof Error)
        || ![settlementCutoverError.message, settlementCutoverError.stdout, settlementCutoverError.stderr]
            .some((value) => String(value || '').includes(
                'execution settlement cutover requires drained Jupiter claims'
            ))) {
        throw new Error('V060 accepted an N-1 worker with unresolved provider amounts');
    }
    await db.query(`
        UPDATE trade_executions
           SET op_token = NULL, op_lease_until = NULL
         WHERE id = $1
    `, [legacySwapExec]);
    await migrate('060');
    await migrate('061');
    const otocoId = randomUUID();
    await db.query(`
        INSERT INTO order_intents (
            id, user_id, provider, client_order_id, request_digest, wallet_address,
            order_type, state, input_mint, output_mint, input_amount, trigger_mint,
            params, expires_at
        ) VALUES (
            $1, $2, 'fixture', 'otoco-migration-gate', repeat('9', 64), $3,
            'otoco', 'open', $4, $5, 1, $5, '{"orderType":"otoco"}'::jsonb,
            clock_timestamp() + INTERVAL '1 day'
        )
    `, [otocoId, userId, wallet, inputMint, outputMint]);
    await expectReject(() => db.query(`
        UPDATE order_intents SET order_type = 'unchecked' WHERE id = $1
    `, [otocoId]), 'an unknown price-order strategy after V061');
    const separatedSwap = await db.query(`
        SELECT state, actual_input_amount::text AS actual_input,
               actual_output_amount::text AS actual_output,
               provider_input_amount::text AS provider_input,
               provider_output_amount::text AS provider_output,
               settlement_status
          FROM trade_executions WHERE id = $1
    `, [legacySwapExec]);
    if (JSON.stringify(separatedSwap.rows[0]) !== JSON.stringify({
        state: 'submitted',
        actual_input: null,
        actual_output: null,
        provider_input: '1',
        provider_output: '2',
        settlement_status: 'pending',
    })) {
        throw new Error(`V060 did not separate provider acknowledgement: ${JSON.stringify(separatedSwap.rows[0])}`);
    }
    await expectReject(() => db.query(`
        UPDATE trade_executions SET state = 'confirmed' WHERE id = $1
    `, [legacySwapExec]), 'provider-only swap confirmation');
    await expectReject(() => db.query(`
        UPDATE trade_executions SET provider_output_amount = 3 WHERE id = $1
    `, [legacySwapExec]), 'provider acknowledgement mutation');
    await db.query(`
        INSERT INTO execution_settlements (
            execution_id, signature, commitment, slot, status,
            input_amount, output_amount, fee_lamports,
            provider_input_amount, provider_output_amount, payload_hash
        ) VALUES (
            $1, repeat('5', 88), 'confirmed', 91, 'verified',
            1, 2, 5000, 1, 2, repeat('d', 64)
        )
    `, [legacySwapExec]);
    await db.query(`
        UPDATE trade_executions
           SET state = 'confirmed', actual_input_amount = 1, actual_output_amount = 2,
               settlement_status = 'verified', settlement_slot = 91,
               settlement_commitment = 'confirmed', settlement_fee_lamports = 5000
         WHERE id = $1
    `, [legacySwapExec]);
    await expectReject(() => db.query(`
        UPDATE trade_executions SET actual_output_amount = 3 WHERE id = $1
    `, [legacySwapExec]), 'settlement aggregate mutation');
    await expectReject(() => db.query(`
        UPDATE trade_executions SET signature = repeat('6', 88) WHERE id = $1
    `, [legacySwapExec]), 'settled execution signature mutation');
    await expectReject(() => db.query(`
        UPDATE trade_executions SET state = 'finalized' WHERE id = $1
    `, [legacySwapExec]), 'finalization without finalized evidence');
    await expectReject(() => db.query(`
        INSERT INTO execution_settlements (
            execution_id, signature, commitment, slot, status,
            input_amount, output_amount, fee_lamports,
            provider_input_amount, provider_output_amount, payload_hash
        ) VALUES (
            $1, repeat('5', 88), 'finalized', 91, 'verified',
            1, 3, 5000, 1, 2, repeat('e', 64)
        )
    `, [legacySwapExec]), 'divergent finalized settlement');
    await db.query(`
        INSERT INTO execution_settlements (
            execution_id, signature, commitment, slot, status,
            input_amount, output_amount, fee_lamports,
            provider_input_amount, provider_output_amount, payload_hash
        ) VALUES (
            $1, repeat('5', 88), 'finalized', 91, 'verified',
            1, 2, 5000, 1, 2, repeat('f', 64)
        )
    `, [legacySwapExec]);
    await db.query(`
        UPDATE trade_executions
           SET state = 'finalized', settlement_commitment = 'finalized'
         WHERE id = $1
    `, [legacySwapExec]);
    await expectReject(() => db.query(`
        UPDATE execution_settlements SET payload_hash = repeat('a', 64)
         WHERE execution_id = $1 AND commitment = 'confirmed'
    `, [legacySwapExec]), 'settlement evidence mutation');
    const noAckQuote = randomUUID();
    const noAckExec = randomUUID();
    await db.query(`
        INSERT INTO trade_quotes (
            id, user_id, wallet_address, provider, provider_quote_id,
            input_mint, output_mint, input_amount, output_amount,
            min_output_amount, slippage_bps, fee_payer, transaction_digest,
            integrity_digest, state, expires_at
        ) VALUES (
            $1, $2, $3, 'fixture', $4, $5, $6, 1, 2, 1, 100,
            $3, repeat('1', 64), repeat('2', 64), 'consumed',
            clock_timestamp() + INTERVAL '1 hour'
        )
    `, [noAckQuote, userId, wallet, `no-ack:${noAckQuote}`, inputMint, outputMint]);
    await db.query(`
        INSERT INTO trade_executions (
            id, quote_id, user_id, wallet_address, provider, idempotency_key,
            state, signature, input_mint, output_mint, expected_input_amount,
            expected_output_amount, signed_tx_digest
        ) VALUES (
            $1, $2, $3, $4, 'fixture', $5, 'submitted', repeat('6', 88),
            $6, $7, 1, 2, repeat('3', 64)
        )
    `, [noAckExec, noAckQuote, userId, wallet, `no-ack:${noAckExec}`, inputMint, outputMint]);
    await db.query(`
        INSERT INTO execution_settlements (
            execution_id, signature, commitment, slot, status,
            input_amount, output_amount, fee_lamports, payload_hash
        ) VALUES (
            $1, repeat('6', 88), 'confirmed', 92, 'verified',
            1, 2, 5000, repeat('4', 64)
        )
    `, [noAckExec]);
    await expectReject(() => db.query(`
        UPDATE trade_executions
           SET provider_input_amount = 1, provider_output_amount = 2
         WHERE id = $1
    `, [noAckExec]), 'provider acknowledgement added after chain evidence');
    const crossedClear = await expectReject(() => db.query(`
        UPDATE asset_obligations
           SET state = 'cleared', clear_journal_id = gen_random_uuid()
         WHERE id = $1
    `, [legacyV2Claim]), 'clearing a crossed legacy provider claim');
    if (!crossedClear.message.includes('provider claim legs do not share')) {
        throw new Error(`Crossed legacy claim failed outside document validation: ${crossedClear.message}`);
    }
    const legacyV2Canon = await db.query(`
        SELECT count(*)::integer AS rows,
               count(*) FILTER (WHERE payload_canon IS NULL)::integer AS legacy_rows
          FROM asset_evidence WHERE id IN ($1, $2)
    `, [legacyV2Input, legacyV2Output]);
    if (legacyV2Canon.rows[0]?.rows !== 2 || legacyV2Canon.rows[0]?.legacy_rows !== 2) {
        throw new Error('V058 did not preserve verifiable pre-canonical provider claims');
    }
    const payloadError = await expectReject(() => db.query(`
        INSERT INTO asset_evidence (
            id, effect_key, evidence_hash, order_id, source, source_key,
            cluster, wallet_address, vault_address, mint, raw_state, signature,
            payload_hash, payload, payload_canon, source_at
        ) VALUES (
            gen_random_uuid(), $1, repeat('3', 64), $2, 'provider', $3,
            'mainnet-beta', $4, $5, $6, 'success', repeat('5', 88),
            encode(digest(convert_to('{"amount":"1"}', 'UTF8'), 'sha256'), 'hex'),
            '{"amount":"2"}'::jsonb, '{"amount":"1"}', clock_timestamp()
        )
    `, [`provider-payload-mismatch:${legacyClaimOrder}`, legacyClaimOrder,
        `provider-payload-mismatch:${legacyClaimOrder}`, wallet, vault, inputMint]),
    'provider evidence with mismatched canonical payload bytes');
    if (payloadError.code !== '23514') {
        throw new Error(`Provider payload mismatch returned ${payloadError.code}`);
    }
    const noncanonicalError = await expectReject(() => db.query(`
        INSERT INTO asset_evidence (
            id, effect_key, evidence_hash, order_id, source, source_key,
            cluster, wallet_address, vault_address, mint, raw_state, signature,
            payload_hash, payload, payload_canon, source_at
        ) VALUES (
            gen_random_uuid(), $1, repeat('4', 64), $2, 'provider', $3,
            'mainnet-beta', $4, $5, $6, 'success', repeat('5', 88),
            encode(digest(convert_to(' { "b":"2", "a":"1" } ', 'UTF8'), 'sha256'), 'hex'),
            '{"a":"1","b":"2"}'::jsonb, ' { "b":"2", "a":"1" } ', clock_timestamp()
        )
    `, [`provider-payload-noncanon:${legacyClaimOrder}`, legacyClaimOrder,
        `provider-payload-noncanon:${legacyClaimOrder}`, wallet, vault, inputMint]),
    'provider evidence with noncanonical payload bytes');
    if (noncanonicalError.code !== '23514') {
        throw new Error(`Provider noncanonical payload returned ${noncanonicalError.code}`);
    }
    await expectReject(() => db.query(`
        INSERT INTO asset_claim_parts (
            obligation_id, line_no, role, mint, amount, evidence_id, part_hash
        ) VALUES ($1, 1, 'movement', $2, 5, $3, repeat('9', 64))
    `, [legacyObligation, inputMint, legacyEvidence]),
    'a new claim part on a legacy or non-versioned obligation');
    const repeatable = await open();
    try {
        await repeatable.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const orderIso = await expectReject(() => repeatable.query(`
            INSERT INTO order_intents (
                id, user_id, provider, client_order_id, request_digest, wallet_address,
                order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                params, cluster, expires_at
            ) VALUES (
                gen_random_uuid(), $1, 'fixture', $2, repeat('5', 64), $3,
                'single', 'open', $4, $5, 1, $5, '{}'::jsonb,
                'mainnet-beta', clock_timestamp() + INTERVAL '1 day'
            )
        `, [userId, `repeatable-order:${legacyClaimOrder}`, wallet, inputMint, outputMint]),
        'a repeatable-read order scope write');
        if (orderIso.code !== '25001') throw new Error(`Order isolation returned ${orderIso.code}`);
        await repeatable.query('ROLLBACK');
        await repeatable.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const actionIso = await expectReject(() => repeatable.query(`
            UPDATE order_actions
               SET action_ver = action_ver + 1, due_at = due_at
             WHERE id = $1
        `, [legacyClaimAction]), 'a repeatable-read financial action write');
        if (actionIso.code !== '25001') throw new Error(`Action isolation returned ${actionIso.code}`);
        await repeatable.query('ROLLBACK');
    } finally {
        await close(repeatable);
    }
    const resetAcl = await db.query(`
        SELECT has_function_privilege(
                   $1,
                   'purge_order_tx_blob(uuid,character varying,timestamp with time zone)',
                   'EXECUTE'
               ) AS rogue_exec,
               has_function_privilege(
                   $1,
                   'assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)',
                   'EXECUTE'
               ) AS delegated_exec,
               EXISTS (
                   SELECT 1
                     FROM pg_proc fn
                     CROSS JOIN LATERAL aclexplode(
                         coalesce(fn.proacl, acldefault('f', fn.proowner))
                     ) acl
                    WHERE fn.oid = 'assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)'::regprocedure
                      AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'core_runtime')
                      AND acl.privilege_type = 'EXECUTE'
                      AND acl.is_grantable
               ) AS runtime_grantable
    `, [legacyAclRole]);
    if (resetAcl.rows[0]?.rogue_exec !== false
        || resetAcl.rows[0]?.delegated_exec !== false
        || resetAcl.rows[0]?.runtime_grantable !== false) {
        throw new Error(`V057 retained a legacy function ACL: ${JSON.stringify(resetAcl.rows[0])}`);
    }
    await admin.query(`DROP ROLE "${legacyAclRole}"`);
    const retentionAcl = await db.query(`
        SELECT has_function_privilege(
                   'core_runtime',
                   'purge_expired_blobs(integer,character varying)',
                   'EXECUTE'
               ) AS runtime_purge,
               has_function_privilege(
                   'core_maintenance',
                   'purge_expired_blobs(integer,character varying)',
                   'EXECUTE'
               ) AS maintenance_purge
    `);
    if (retentionAcl.rows[0]?.runtime_purge !== false
        || retentionAcl.rows[0]?.maintenance_purge !== true) {
        throw new Error(`Blob retention ACL is not isolated: ${JSON.stringify(retentionAcl.rows[0])}`);
    }
    await db.query('SET ROLE core_runtime');
    try {
        let denied = false;
        try {
            await db.query("SELECT purge_expired_blobs(1, 'runtime-denied')");
        } catch (error) {
            denied = error instanceof Error && error.code === '42501';
        }
        if (!denied) throw new Error('Runtime role can execute blob retention');
    } finally {
        await db.query('RESET ROLE');
    }
    await db.query('SET ROLE core_maintenance');
    try {
        const empty = await db.query(
            "SELECT purge_expired_blobs(1, 'maintenance-empty') AS purged"
        );
        if (empty.rows[0]?.purged !== 0) {
            throw new Error('Maintenance retention did not run through its bounded function');
        }
    } finally {
        await db.query('RESET ROLE');
    }
    const circuitCatalog = await db.query(`
        SELECT (
                   SELECT count(*)::integer
                     FROM pg_class relation
                     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                     JOIN pg_index index_row ON index_row.indexrelid = relation.oid
                    WHERE namespace.nspname = 'public'
                      AND relation.relname IN (
                          'asset_obligations_order_block_idx',
                          'asset_obligations_action_block_idx',
                          'asset_obligations_scope_block_idx',
                          'order_intents_action_scope_idx'
                      )
                      AND index_row.indisvalid AND index_row.indisready
               ) AS valid_indexes,
               to_regprocedure('asset_circuit_lock()') IS NOT NULL AS has_lock,
               to_regprocedure('asset_lock_claim_scope(uuid)') IS NOT NULL AS has_claim_lock,
               EXISTS (
                   SELECT 1
                     FROM pg_constraint constraint_row
                    WHERE constraint_row.conrelid = 'asset_obligations'::regclass
                      AND constraint_row.conname = 'asset_obligations_action_fk'
                      AND constraint_row.contype = 'f'
                      AND constraint_row.convalidated
               ) AS action_fk,
               EXISTS (
                   SELECT 1 FROM pg_trigger trigger_row
                    WHERE trigger_row.tgrelid = 'asset_obligations'::regclass
                      AND trigger_row.tgname = 'asset_obligations_circuit_lock'
                      AND trigger_row.tgenabled <> 'D'
               ) AS has_trigger
    `);
    if (circuitCatalog.rows[0]?.valid_indexes !== 4
        || circuitCatalog.rows[0]?.has_lock !== true
        || circuitCatalog.rows[0]?.has_claim_lock !== true
        || circuitCatalog.rows[0]?.action_fk !== true
        || circuitCatalog.rows[0]?.has_trigger !== true) {
        throw new Error(`Asset circuit catalog is incomplete: ${JSON.stringify(circuitCatalog.rows[0])}`);
    }

    const circuitLock = await open();
    const circuitWriter = await open();
    const circuitApp = `fervor-circuit-${process.pid}`;
    await circuitWriter.query(`SET application_name = '${circuitApp}'`);
    await circuitLock.query('BEGIN');
    await circuitLock.query(
        'SELECT id FROM order_intents WHERE id = $1 FOR UPDATE', [legacyClaimOrder]
    );
    const circuitInsert = circuitWriter.query(`
        INSERT INTO asset_obligations (
            id, obligation_key, req_hash, order_id, cluster, wallet_address,
            mint, kind, amount, reason
        ) VALUES (
            gen_random_uuid(), $1, repeat('1', 64), $2, 'mainnet-beta', $3,
            $4, 'deficit', 1, 'Circuit lock qualification'
        )
    `, [`circuit-lock:${legacyClaimOrder}`, legacyClaimOrder, wallet, inputMint]);
    const circuitWait = await waitForLock(db, circuitApp);
    if (circuitWait.wait_event_type !== 'Lock') {
        throw new Error(`Circuit writer did not wait on the aggregate lock: ${JSON.stringify(circuitWait)}`);
    }
    await circuitLock.query('COMMIT');
    await circuitInsert;
    await Promise.all([close(circuitLock), close(circuitWriter)]);

    let crossedAction = false;
    try {
        await db.query(`
            INSERT INTO asset_obligations (
                id, obligation_key, req_hash, order_id, action_id, cluster,
                wallet_address, mint, kind, amount, reason
            ) VALUES (
                gen_random_uuid(), $1, repeat('2', 64), $2, $3, 'mainnet-beta',
                $4, $5, 'deficit', 1, 'Crossed action qualification'
            )
        `, [`circuit-cross:${legacyClaimOrder}`, legacyClaimOrder, upgradeAction,
            wallet, inputMint]);
    } catch (error) {
        crossedAction = error instanceof Error && error.code === '23514'
            && error.message.includes('crosses its order or wallet boundary');
    }
    if (!crossedAction) throw new Error('Asset circuit accepted a crossed action identity');

    const hardened = await db.query(`
        SELECT bool_and(
                   CASE
                       WHEN fn.proname IN (
                           'assert_blob_access', 'purge_order_tx_blob', 'purge_expired_blobs'
                       )
                           THEN fn.prosecdef
                       ELSE NOT fn.prosecdef
                   END
               ) AS modes,
               bool_and(
                   fn.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
               ) AS paths,
               has_schema_privilege('core_runtime', 'public', 'CREATE') AS runtime_create,
               has_schema_privilege('core_maintenance', 'public', 'CREATE') AS maintenance_create,
               EXISTS (
                   SELECT 1
                     FROM pg_namespace namespace
                     CROSS JOIN LATERAL aclexplode(
                         coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
                     ) acl
                    WHERE namespace.nspname = 'public'
                      AND acl.grantee = 0
                      AND acl.privilege_type = 'CREATE'
               ) AS public_create
          FROM pg_proc fn
         WHERE fn.oid IN (
             'assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)'::regprocedure,
             'order_blob_read_guard()'::regprocedure,
             'purge_order_tx_blob(uuid,character varying,timestamp with time zone)'::regprocedure,
             'purge_expired_blobs(integer,character varying)'::regprocedure
         )
    `);
    if (hardened.rows[0]?.modes !== true
        || hardened.rows[0]?.paths !== true
        || hardened.rows[0]?.runtime_create !== false
        || hardened.rows[0]?.maintenance_create !== false
        || hardened.rows[0]?.public_create !== false) {
        throw new Error(`Transaction role context is unsafe: ${JSON.stringify(hardened.rows[0])}`);
    }
    await db.query('SELECT assert_tx_roles()');

    const validateProduction = () => runFlyway({
        root,
        plane: 'core',
        target: toJdbc(dbUrl.toString(), 'CORE'),
        command: 'validate',
        timeoutMs,
        configFiles: '/flyway/db/flyway/core.conf,/flyway/db/flyway/core-production.conf',
        capture: true,
    });
    const expectProductionReject = async (label, expected) => {
        let rejected = false;
        try {
            await validateProduction();
        } catch (error) {
            rejected = error instanceof Error
                && [error.message, error.stdout, error.stderr]
                    .some((value) => String(value || '').includes(expected));
        }
        if (!rejected) throw new Error(`Production preflight accepted ${label}`);
    };
    await validateProduction();

    const rogueAclRole = `core_rogue_acl_${process.pid}_${randomBytes(3).toString('hex')}`;
    if (!/^core_rogue_acl_[a-zA-Z0-9_]+$/.test(rogueAclRole)) {
        throw new Error('Unsafe rogue ACL fixture role');
    }
    await admin.query(`CREATE ROLE "${rogueAclRole}" NOLOGIN`);
    await db.query(`GRANT EXECUTE ON FUNCTION
        purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ) TO "${rogueAclRole}"`);
    try {
        await expectProductionReject(
            'an unrelated security-definer function grantee',
            'transaction function ACL has unauthorized grantee or grant option'
        );
    } finally {
        await db.query(`REVOKE ALL ON FUNCTION
            purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ) FROM "${rogueAclRole}"`);
        await admin.query(`DROP ROLE "${rogueAclRole}"`);
    }

    await db.query(`GRANT EXECUTE ON FUNCTION assert_blob_access(
        UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT
    ) TO core_runtime WITH GRANT OPTION`);
    try {
        await expectProductionReject(
            'a runtime function grant option',
            'transaction function ACL has unauthorized grantee or grant option'
        );
    } finally {
        await db.query(`REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION assert_blob_access(
            UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT
        ) FROM core_runtime`);
    }
    await validateProduction();

    await db.query(`
        GRANT EXECUTE ON FUNCTION purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ)
            TO core_runtime
    `);
    try {
        await expectProductionReject(
            'an inherited/effective maintenance ACL',
            'transaction caller roles have unsafe effective function privileges'
        );
    } finally {
        await db.query(`
            REVOKE ALL ON FUNCTION purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ)
                FROM core_runtime
        `);
    }

    await db.query(`
        REVOKE ALL ON FUNCTION assert_blob_access(
            UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT
        ) FROM core_runtime
    `);
    try {
        await expectProductionReject(
            'a no-op/missing runtime ACL',
            'transaction caller roles have unsafe effective function privileges'
        );
    } finally {
        await db.query(`
            GRANT EXECUTE ON FUNCTION assert_blob_access(
                UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT
            ) TO core_runtime
        `);
    }

    await db.query('GRANT CREATE ON SCHEMA public TO PUBLIC');
    try {
        await expectProductionReject(
            'PUBLIC schema creation',
            'public schema remains writable by transaction callers or PUBLIC'
        );
    } finally {
        await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    }

    const parentRole = `core_unsafe_${process.pid}_${randomBytes(3).toString('hex')}`;
    if (!/^core_unsafe_[a-zA-Z0-9_]+$/.test(parentRole)) {
        throw new Error('Unsafe role fixture name');
    }
    await admin.query(`CREATE ROLE "${parentRole}" NOLOGIN CREATEDB`);
    try {
        await admin.query(`GRANT "${parentRole}" TO core_runtime`);
        await expectProductionReject(
            'a transitive privileged parent role',
            'core transaction roles must not inherit or set parent role'
        );
    } finally {
        await admin.query(`REVOKE "${parentRole}" FROM core_runtime`);
        await admin.query(`DROP ROLE "${parentRole}"`);
    }
    await validateProduction();

    let shadowCreated = false;
    let schemaDenied = false;
    await db.query('SET ROLE core_runtime');
    try {
        try {
            await db.query(`
                CREATE FUNCTION public.btrim(VARCHAR) RETURNS TEXT
                LANGUAGE sql IMMUTABLE AS 'SELECT $1::text'
            `);
            shadowCreated = true;
        } catch (error) {
            schemaDenied = error instanceof Error && error.code === '42501';
        }
    } finally {
        await db.query('RESET ROLE');
    }
    if (shadowCreated) await db.query('DROP FUNCTION public.btrim(VARCHAR)');
    if (!schemaDenied) throw new Error('Runtime role can shadow a security-definer dependency');

    const history = await db.query(`
        SELECT version, success
          FROM fervor_core_meta.fervor_core_history
         WHERE version IN (
             '015', '016', '017', '018', '019', '020', '021', '022',
             '022.1', '023', '024', '025', '026', '027', '028', '029', '030', '031', '032', '033', '034', '035', '036', '037', '038', '039', '040', '041', '042', '043', '044', '045', '046', '047', '048', '049', '050', '051', '052', '053', '054', '055', '056', '057', '058', '059', '060', '061'
         )
         ORDER BY version
    `);
    if (history.rowCount !== 48 || history.rows.some((row) => !row.success)) {
        throw new Error('Flyway did not record V015 through V061 exactly once');
    }
    await close(db);
    await migrate('061');
    console.log(`order schema: V015-V061 identity, expiry, lock-order, retention, signed policy, durable decrypt, exact provider claims, exact production ACLs, multi-mint asset circuits, canonical evidence, swap blob and settlement gates, OTOCO constraint, egress, drained cutovers, and N-1 rejection gates passed with ${stats.writes} concurrent writes (max ${stats.maxMs} ms)`);
} finally {
    writerRun = false;
    if (writerTask) {
        try {
            await writerTask;
        } catch {
            // The primary qualification failure remains authoritative.
        }
    }
    await Promise.allSettled([...clients].map((client) => client.end()));
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [name]);
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [badName]);
    await admin.query(`DROP DATABASE IF EXISTS "${badName}"`);
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [policyName]);
    await admin.query(`DROP DATABASE IF EXISTS "${policyName}"`);
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [cutoverName]);
    await admin.query(`DROP DATABASE IF EXISTS "${cutoverName}"`);
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [shapeName]);
    await admin.query(`DROP DATABASE IF EXISTS "${shapeName}"`);
    if (madeRuntimeRole) await admin.query('DROP ROLE core_runtime');
    if (madeMaintenanceRole) await admin.query('DROP ROLE core_maintenance');
    await admin.end();
}
