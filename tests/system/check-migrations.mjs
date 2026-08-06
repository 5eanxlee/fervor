import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { byteCompare, canonicalJson, canonicalManifest } from '../../db/tools/catalog-proof.mjs';
import { cleanEnv, runProc } from '../../db/tools/flyway-runner.mjs';
import { flywayImage, sourceFor, toJdbc, toPg } from '../../db/tools/migration-config.mjs';
import { read, resolveRoot } from './spec-utils.mjs';

const planes = ['core', 'market'];
const required = new Map([
    ['flyway.createSchemas', 'true'],
    ['flyway.failOnMissingLocations', 'true'],
    ['flyway.placeholderReplacement', 'false'],
    ['flyway.validateMigrationNaming', 'true'],
    ['flyway.validateOnMigrate', 'true'],
    ['flyway.cleanDisabled', 'true'],
    ['flyway.baselineOnMigrate', 'false'],
    ['flyway.outOfOrder', 'false'],
    ['flyway.postgresql.transactional.lock', 'false'],
]);

const parseConf = (text) => new Map(text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
        const index = line.indexOf('=');
        if (index < 1) throw new Error(`Invalid Flyway setting: ${line}`);
        return [line.slice(0, index), line.slice(index + 1)];
    }));

const validateConf = (plane, conf) => {
    for (const [key, value] of required) {
        if (conf.get(key) !== value) throw new Error(`${plane} must set ${key}=${value}`);
    }
    if (conf.get('flyway.locations') !== `filesystem:/flyway/db/${plane}/migrations`) {
        throw new Error(`${plane} migration location is not isolated`);
    }
    if (conf.get('flyway.table') !== `fervor_${plane}_history`) {
        throw new Error(`${plane} history table is not isolated`);
    }
    if (conf.get('flyway.defaultSchema') !== `fervor_${plane}_meta`
        || conf.get('flyway.schemas') !== `fervor_${plane}_meta`) {
        throw new Error(`${plane} migration metadata schema is not isolated`);
    }
    const lock = plane === 'core' ? 1 : 2;
    const initSql = `SET statement_timeout = '60s'; DO $fervor$ BEGIN IF NOT pg_try_advisory_lock(1937006964, ${lock}) THEN RAISE EXCEPTION 'fervor migration lock unavailable' USING ERRCODE = '55P03'; END IF; END $fervor$`;
    if (conf.get('flyway.initSql') !== initSql) {
        throw new Error(`${plane} migration lock is not shared, nonblocking, and runner-bounded`);
    }
    if ([...conf.keys()].some((key) => key.toLowerCase().includes('callback'))) {
        throw new Error(`${plane} must not configure Flyway callbacks with the session migration lock`);
    }
};

const migrationPattern = /^V[0-9]+(?:_[0-9]+)*__[a-z0-9_]+\.sql$/;
const legacyConcurrent = new Map([
    ['V007__execution_reconcile_index.sql', {
        digest: '5655f539cc5aed85e921713e1d145cbe9d2507a0fbe95a0fae92f49a7c57f7e5',
        indexes: ['trade_exec_reconcile_due_idx'],
        restart: false,
    }],
    ['V008__observability_indexes.sql', {
        digest: '3dc720ff1468af01ce4f8e2ed5350679e0d8ff7fdf8b274add0292be057cb227',
        indexes: [
            'event_outbox_failed_idx', 'notification_backlog_idx', 'order_stuck_idx',
            'tokens_observed_idx', 'trade_exec_signed_stuck_idx',
            'trade_exec_chain_stuck_idx', 'trade_exec_recovery_stats_idx',
        ],
        restart: true,
    }],
]);
const destructive = new RegExp([
    '\\b(?:DROP|TRUNCATE|REVOKE|EXECUTE)\\b',
    '\\bDELETE\\s+FROM\\b',
    '\\bMERGE\\b[\\s\\S]*?\\bWHEN\\s+MATCHED\\b[\\s\\S]*?\\bTHEN\\s+DELETE\\b',
    '\\bALTER\\s+(?:TABLE|TYPE|DOMAIN|FUNCTION|PROCEDURE|SEQUENCE|VIEW|MATERIALIZED\\s+VIEW)\\b[\\s\\S]*?\\b(?:RENAME|SET\\s+SCHEMA|OWNER\\s+TO|DETACH\\s+PARTITION|SET\\s+(?:UN)?LOGGED|ALTER\\s+COLUMN[\\s\\S]*?\\b(?:TYPE|SET\\s+NOT\\s+NULL))\\b',
].join('|'), 'i');
// Applied migrations retain their checksum-locked legacy review tag; new
// forward migrations use the Fervor tag.
const reviewTag = /^-- (?:stride|fervor): destructive-review=[a-z0-9._/-]+$/m;

const policyText = (sql) => {
    let result = '';
    let index = 0;
    let blockDepth = 0;
    while (index < sql.length) {
        if (blockDepth > 0) {
            if (sql.startsWith('/*', index)) {
                blockDepth += 1;
                index += 2;
            } else if (sql.startsWith('*/', index)) {
                blockDepth -= 1;
                index += 2;
            } else {
                index += 1;
            }
            result += ' ';
            continue;
        }
        if (sql.startsWith('--', index)) {
            const newline = sql.indexOf('\n', index + 2);
            index = newline < 0 ? sql.length : newline;
            result += ' ';
            continue;
        }
        if (sql.startsWith('/*', index)) {
            blockDepth = 1;
            index += 2;
            result += ' ';
            continue;
        }
        const quote = sql[index];
        if (quote === "'" || quote === '"') {
            const escaped = quote === "'" && index > 0
                && /[eE]/.test(sql[index - 1])
                && (index < 2 || !/[a-zA-Z0-9_$]/.test(sql[index - 2]));
            index += 1;
            while (index < sql.length) {
                if (escaped && sql[index] === '\\') {
                    index += 2;
                } else if (sql[index] === quote && sql[index + 1] === quote) {
                    index += 2;
                } else if (sql[index] === quote) {
                    index += 1;
                    break;
                } else {
                    index += 1;
                }
            }
            result += ' ';
            continue;
        }
        if (quote === '$') {
            const marker = sql.slice(index).match(/^(?:\$[a-zA-Z_][a-zA-Z0-9_]*\$|\$\$)/)?.[0];
            if (marker) {
                result += ' ';
                index += marker.length;
                continue;
            }
        }
        result += quote;
        index += 1;
    }
    if (blockDepth !== 0) throw new Error('Unterminated SQL block comment');
    return result.replace(/\s+/g, ' ');
};

const needsReview = (sql) => destructive.test(policyText(sql));

for (const sql of [
    'DROP/* nested /* comment */ still */TABLE t',
    'DELETE/* comment */FROM t',
    'DROP OWNED BY role_name',
    `ALTER TABLE t ${' '.repeat(300)} DROP COLUMN value`,
    "DO $$ BEGIN EXECUTE 'TRUNCATE t'; END $$",
    'MERGE INTO target USING source ON target.id = source.id WHEN MATCHED THEN DELETE',
    'ALTER TABLE parent DETACH PARTITION child',
    'ALTER TABLE ledger SET UNLOGGED',
]) {
    if (!needsReview(sql)) throw new Error(`Destructive SQL policy failed open: ${sql.slice(0, 60)}`);
}
for (const sql of [
    'ALTER TABLE child ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES parent(id) ON DELETE CASCADE',
    "INSERT INTO audit_log(message) VALUES ('DROP TABLE is rejected')",
    '-- DROP TABLE mentioned in a comment\nSELECT 1',
]) {
    if (needsReview(sql)) throw new Error(`Destructive SQL policy produced a false positive: ${sql}`);
}
if (canonicalJson({ z: 1, a: { y: 2, x: 3 } }) !== '{"a":{"x":3,"y":2},"z":1}') {
    throw new Error('Catalog JSON keys are not bytewise canonical');
}
const unicode = canonicalManifest([{ name: 'ä' }, { name: 'z' }, { name: 'a\u0308' }]);
if (JSON.stringify(JSON.parse(unicode).map((item) => item.name)) !== JSON.stringify(['a\u0308', 'z', 'ä'])
    || byteCompare('ä', 'z') <= 0) {
    throw new Error('Catalog row ordering depends on locale instead of UTF-8 bytes');
}
let migrationCount = 0;

for (const plane of planes) {
    const conf = parseConf(read(resolveRoot(`db/flyway/${plane}.conf`)));
    validateConf(plane, conf);
    const directory = resolveRoot(`db/${plane}/migrations`);
    const files = fs.readdirSync(directory).sort();
    if (files.some((file) => /^(?:before|after)/i.test(file))) {
        throw new Error(`${plane} must not add Flyway callback files with the session migration lock`);
    }
    const sqlFiles = files.filter((file) => file.endsWith('.sql'));
    if (sqlFiles.length === 0) throw new Error(`${plane} has no migration lineage`);
    const versions = sqlFiles.map((file) => file.split('__', 1)[0].replace(/^V0*/, ''));
    if (new Set(versions).size !== versions.length) throw new Error(`${plane} migration versions must be unique`);

    for (const file of sqlFiles) {
        migrationCount += 1;
        if (!migrationPattern.test(file)) throw new Error(`Invalid migration name: ${file}`);
        const sql = read(path.join(directory, file));
        const sidecar = `${file}.conf`;
        const concurrent = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(sql);
        if (concurrent) {
            if (!files.includes(sidecar)) throw new Error(`${file} needs ${sidecar}`);
            if (!/^executeInTransaction=false\s*$/m.test(read(path.join(directory, sidecar)))) {
                throw new Error(`${sidecar} must disable the transaction`);
            }
            if (!/SET\s+lock_timeout/i.test(sql) || /SET\s+LOCAL\s+lock_timeout/i.test(sql)) {
                throw new Error(`${file} needs a session lock timeout`);
            }
            for (const setting of ['statement_timeout', 'idle_in_transaction_session_timeout']) {
                if (!new RegExp(`SET\\s+${setting}`, 'i').test(sql)
                    || new RegExp(`SET\\s+LOCAL\\s+${setting}`, 'i').test(sql)) {
                    throw new Error(`${file} needs a session ${setting}`);
                }
            }
            const creates = [...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+([a-z0-9_]+)/ig)];
            const legacy = plane === 'core' ? legacyConcurrent.get(file) : undefined;
            if (legacy) {
                const digest = createHash('sha256').update(sql).digest('hex');
                if (digest !== legacy.digest
                    || JSON.stringify(creates.map((match) => match[1])) !== JSON.stringify(legacy.indexes)) {
                    throw new Error(`${file} is an immutable applied migration; hardening must be forward-only`);
                }
                if (legacy.restart) {
                    for (const create of creates) {
                        const drop = new RegExp(`DROP\\s+INDEX\\s+CONCURRENTLY\\s+IF\\s+EXISTS\\s+${create[1]}\\s*;`, 'i');
                        if (!drop.test(sql) || sql.search(drop) > create.index) {
                            throw new Error(`${file} changed its reviewed interrupted-artifact cleanup`);
                        }
                    }
                }
            } else {
                if (creates.length !== 1) throw new Error(`${file} must own exactly one concurrent index`);
                const index = creates[0][1];
                const drop = new RegExp(`DROP\\s+INDEX\\s+CONCURRENTLY\\s+IF\\s+EXISTS\\s+${index}\\s*;`, 'i');
                if (!drop.test(sql) || sql.search(drop) > creates[0].index) {
                    throw new Error(`${file} must remove its exact interrupted artifact before rebuilding`);
                }
            }
        } else {
            if (files.includes(sidecar)) throw new Error(`${sidecar} is unnecessary`);
            for (const setting of ['lock_timeout', 'statement_timeout', 'idle_in_transaction_session_timeout']) {
                if (!new RegExp(`SET\\s+LOCAL\\s+${setting}`, 'i').test(sql)) {
                    throw new Error(`${file} must set local ${setting}`);
                }
            }
        }
        if (needsReview(sql) && !reviewTag.test(sql)) {
            throw new Error(`${file} needs a reviewed destructive SQL annotation`);
        }
        if (!/SET\s+(?:LOCAL\s+)?search_path\s*=\s*public/i.test(sql)) {
            throw new Error(`${file} must target the public application schema explicitly`);
        }
    }
}

const baseline = read(resolveRoot('db/core/migrations/V001__baseline.sql'));
for (const guard of [
    'V001 requires an empty public schema',
    "c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')",
    "d.classid = 'pg_proc'::regclass",
    "d.classid = 'pg_type'::regclass",
    'FROM pg_operator',
    'FROM pg_collation',
    'FROM pg_extension',
    'FROM pg_default_acl',
]) {
    if (!baseline.includes(guard)) throw new Error(`Core V1 object guard is incomplete: ${guard}`);
}
if (!baseline.includes('application objects found')) {
    throw new Error('Core V1 must refuse a populated public schema');
}

const exact = read(resolveRoot('db/core/migrations/V002__exact_domains.sql'));
for (const contract of [
    'CREATE DOMAIN sol_u64 AS NUMERIC',
    'VALUE = trunc(VALUE)',
    'VALUE BETWEEN 0 AND 18446744073709551615',
    'CREATE DOMAIN wide_uint AS NUMERIC',
    'CREATE DOMAIN wide_int AS NUMERIC',
]) {
    if (!exact.includes(contract)) throw new Error(`Core exact-domain contract is missing: ${contract}`);
}
if (/CREATE DOMAIN sol_u64 AS NUMERIC\s*\(20\s*,\s*0\)/i.test(exact)) {
    throw new Error('sol_u64 rounds fractional input before its domain constraint');
}
for (const [table, columns] of Object.entries({
    trades: { token_amount_raw: 'sol_u64', quote_amount_raw: 'sol_u64' },
    trade_quotes: { input_amount: 'sol_u64', output_amount: 'sol_u64', min_output_amount: 'sol_u64' },
    trade_executions: {
        expected_input_amount: 'sol_u64', expected_output_amount: 'sol_u64',
        actual_input_amount: 'sol_u64', actual_output_amount: 'sol_u64',
    },
    order_intents: { input_amount: 'sol_u64' },
    wallet_activity: { quantity_base: 'sol_u64', value_micro_usd: 'wide_uint' },
    wallet_positions: {
        quantity_base: 'wide_uint', cost_micro_usd: 'wide_uint',
        realized_pnl_micro_usd: 'wide_int', untracked_sold_base: 'wide_uint',
    },
})) {
    const blocks = [...exact.matchAll(new RegExp(`ALTER TABLE ${table}\\b[\\s\\S]*?;`, 'g'))]
        .map((match) => match[0]).join('\n');
    for (const [column, type] of Object.entries(columns)) {
        if (!new RegExp(`ALTER COLUMN ${column} TYPE ${type}\\b`).test(blocks)) {
            throw new Error(`${table}.${column} is not mapped to ${type}`);
        }
    }
}

const custody = read(resolveRoot('db/core/migrations/V003__custody_ledger.sql'));
for (const contract of [
    'CREATE TABLE asset_accounts',
    'CREATE TABLE asset_journals',
    'CREATE TABLE asset_entries',
    'CREATE TABLE asset_evidence',
    'CREATE TABLE asset_obligations',
    'amount sol_u64 NOT NULL CHECK (amount > 0)',
    'UNIQUE (source, cluster, source_key)',
    "source <> 'chain' OR (signature IS NOT NULL AND slot IS NOT NULL AND commitment IS NOT NULL)",
    'CREATE CONSTRAINT TRIGGER asset_journal_balanced',
    'DEFERRABLE INITIALLY DEFERRED',
    'CREATE FUNCTION set_asset_journal_state',
    'confirmed order vault attribution cannot be negative',
    'a journal used to clear an obligation cannot be reversed',
    'CREATE VIEW asset_balances',
    'CREATE VIEW asset_circuits',
]) {
    if (!custody.includes(contract)) throw new Error(`Core custody contract is missing: ${contract}`);
}
if (/\b(?:REAL|FLOAT|DOUBLE PRECISION)\b/i.test(policyText(custody))) {
    throw new Error('Custody accounting cannot use approximate numeric types');
}
if (/ON\s+DELETE\s+CASCADE/i.test(custody)) {
    throw new Error('Custody evidence and journal facts cannot cascade on delete');
}

const custodyFixes = read(resolveRoot('db/core/migrations/V004__custody_invariants.sql'));
for (const contract of [
    'CREATE TABLE asset_chain_events',
    'UNIQUE (cluster, signature, instruction_index, event_index)',
    'CREATE UNIQUE INDEX asset_evidence_chain_commit_idx',
    'CREATE UNIQUE INDEX asset_evidence_legacy_key_idx',
    'ADD COLUMN legacy_source_key VARCHAR(220)',
    'chain observation does not match its canonical event binding',
    'FOR UPDATE OF journal',
    '(NEW.action_id IS NULL OR journal.action_id = NEW.action_id)',
    'evidence.vault_address IS NOT DISTINCT FROM NEW.vault_address',
    'CREATE CONSTRAINT TRIGGER asset_reversal_pair',
    'DEFERRABLE INITIALLY DEFERRED',
]) {
    if (!custodyFixes.includes(contract)) throw new Error(`Core custody repair is missing: ${contract}`);
}
if (/wallet_address, mint, slot\s*\n\s*\)\) > 1/.test(custodyFixes)) {
    throw new Error('Canonical chain movement preflight cannot include an observation slot');
}
if (/\b(?:REAL|FLOAT|DOUBLE PRECISION)\b/i.test(policyText(custodyFixes))) {
    throw new Error('Custody repairs cannot use approximate numeric types');
}
if (/ON\s+DELETE\s+CASCADE/i.test(custodyFixes)) {
    throw new Error('Custody repair facts cannot cascade on delete');
}

const executionRecovery = read(resolveRoot('db/core/migrations/V005__execution_recovery.sql'));
for (const contract of [
    'ADD COLUMN broadcast_started_at TIMESTAMPTZ',
    'ADD COLUMN broadcast_count INTEGER NOT NULL DEFAULT 0',
    'trade_exec_broadcast_count CHECK (broadcast_count >= 0) NOT VALID',
    'trade_exec_broadcast_shape',
    'VALIDATE CONSTRAINT trade_exec_broadcast_count',
    'VALIDATE CONSTRAINT trade_exec_broadcast_shape',
    'CREATE INDEX trade_exec_recovery_idx',
    "WHERE state = 'signed' AND signature IS NOT NULL AND broadcast_started_at IS NOT NULL",
]) {
    if (!executionRecovery.includes(contract)) throw new Error(`Core execution recovery is missing: ${contract}`);
}

const custodyConsistency = read(resolveRoot('db/core/migrations/V006__custody_consistency.sql'));
for (const contract of [
    'LOCK TABLE asset_journals, asset_chain_events, asset_evidence, asset_obligations',
    'legacy clearing evidence is not an active identity-matched proof',
    'legacy reversal pair is not atomically consistent',
    'SELECT evidence.journal_id INTO clearing_journal',
    'FOR UPDATE OF journal',
    'evidence.journal_id = OLD.id',
    'Slot of the first accepted observation',
]) {
    if (!custodyConsistency.includes(contract)) throw new Error(`Core custody consistency is missing: ${contract}`);
}
if (custodyConsistency.includes('chain_event.slot <> NEW.slot')) {
    throw new Error('Canonical chain movements cannot bind a fork-dependent slot');
}
const custodyUpgrade = read(resolveRoot('tests/system/test-custody-upgrade.mjs'));
for (const proof of [
    "await migrate(base, '003')",
    'Non-empty V003 evidence was not upgraded',
    'legacy clearing evidence is not an active identity-matched proof',
    'legacy reversal pair is not atomically consistent',
]) {
    if (!custodyUpgrade.includes(proof)) throw new Error(`Custody upgrade proof is missing: ${proof}`);
}
const migrationScripts = JSON.parse(read(resolveRoot('package.json'))).scripts;
if (migrationScripts?.['test:migration-custody'] !== 'node tests/system/test-custody-upgrade.mjs') {
    throw new Error('Custody upgrade proof must be available as an npm script');
}
const custodyProofCheck = read(resolveRoot('tests/system/check-custody-proof.mjs'));
for (const contract of ['baseVersion', 'currentVersion', 'crossSlotReplay', 'corruptCases', 'await link(path, verifiedPath)']) {
    if (!custodyProofCheck.includes(contract)) throw new Error(`Custody proof check is missing: ${contract}`);
}

const executionIndex = read(resolveRoot('db/core/migrations/V007__execution_reconcile_index.sql'));
for (const contract of [
    'CREATE INDEX CONCURRENTLY trade_exec_reconcile_due_idx',
    'ON trade_executions (updated_at, id)',
    "state IN ('submitted', 'processed', 'confirmed')",
    "state = 'signed' AND broadcast_started_at IS NOT NULL",
]) {
    if (!executionIndex.includes(contract)) throw new Error(`Execution reconciliation index is missing: ${contract}`);
}

const observabilityIndexes = [
    'V008__observability_indexes.sql',
    'V009__notification_backlog_index.sql',
    'V010__order_stuck_index.sql',
    'V011__tokens_observed_index.sql',
    'V012__execution_signed_index.sql',
    'V013__execution_chain_index.sql',
    'V014__execution_stats_index.sql',
].map((file) => read(resolveRoot(`db/core/migrations/${file}`))).join('\n');
for (const index of [
    'event_outbox_failed_idx',
    'notification_backlog_idx',
    'order_stuck_idx',
    'tokens_observed_idx',
    'trade_exec_signed_stuck_idx',
    'trade_exec_chain_stuck_idx',
    'trade_exec_recovery_stats_idx',
]) {
    if (!observabilityIndexes.includes(`CREATE INDEX CONCURRENTLY ${index}`)) {
        throw new Error(`Operational metrics index is missing: ${index}`);
    }
}
const indexRecovery = read(resolveRoot('db/tools/recover-indexes.mjs'));
const indexDrill = read(resolveRoot('tests/system/test-index-recovery.mjs'));
for (const contract of [
    "['event_outbox_failed_idx', 'event_outbox']",
    "['notification_backlog_idx', 'notification_deliveries']",
    "['order_stuck_idx', 'order_intents']",
    "['tokens_observed_idx', 'tokens']",
    "['trade_exec_signed_stuck_idx', 'trade_executions']",
    "['trade_exec_chain_stuck_idx', 'trade_executions']",
    "['trade_exec_recovery_stats_idx', 'trade_executions']",
    "['action_attempts_deadline_idx', 'action_attempts']",
    "['order_tx_blobs_expiry_idx', 'order_tx_blobs']",
    "['order_schedules_fill_idx', 'order_schedules']",
    "['order_anomalies_resolved_journal_idx', 'order_anomalies']",
    "['order_actions_provider_due_idx', 'order_actions']",
    "['order_actions_predecessor_idx', 'order_actions']",
    "['action_obs_fact_idx', 'action_obs']",
    "['action_obs_supersedes_idx', 'action_obs']",
    "['order_intents_unknown_op_idx', 'order_intents']",
    "['order_intents_op_cutover_idx', 'order_intents']",
    "['asset_obligations_order_block_idx', 'asset_obligations']",
    "['asset_obligations_action_block_idx', 'asset_obligations']",
    "['asset_obligations_scope_block_idx', 'asset_obligations']",
    "['order_intents_action_scope_idx', 'order_intents']",
    'pg_get_indexdef(c.oid, position, true)',
    'pg_get_expr(i.indpred, i.indrelid, true)',
]) {
    if (!indexRecovery.includes(contract)) throw new Error(`Concurrent-index recovery is incomplete: ${contract}`);
}
for (const contract of [
    "const migration = migrate('007')", "recoveryProc('007'", "result.indexes !== 7",
    "recoveryProc('017'", "result.version !== '017'", "recoveryProc('020'",
    "result.version !== '020'", "recoveryProc('024'", "result.version !== '024'",
    "recoveryProc('025'", "result.version !== '025'",
    "failEvidenceIndex('028')", "recoverIndex('028')",
    "failEvidenceIndex('029')", "recoverIndex('029')",
    "failOrderIndex('038')", "recoverOrderIndex('038')",
    'failV40(control)', "recoverOrderIndex('040')",
    "for (const version of ['051', '052', '053'])", 'await failAssetIndex(version)',
    'await recoverIndex(version)',
    "failOrderIndex('053.1')", "recoverOrderIndex('053.1')",
    'await seedAssetCircuits(control, userId, obsAction)',
    'await startAssetWriter(assetAnchor)',
    'Asset obligation writer did not survive V051-V053.1 recovery',
    "[assetPlans[0].rows, 'asset_obligations_order_block_idx']",
    "[assetPlans[1].rows, 'asset_obligations_action_block_idx']",
    "[assetPlans[2].rows, 'asset_obligations_scope_block_idx']",
    "[assetPlans[3].rows, 'order_intents_action_scope_idx']",
    'Interrupted V040 did not leave its invalid index artifact',
    'V040 failure was not recorded in Flyway history',
    "$2 || ':rev2'", 'supersedes, query_kind, verdict',
    'V020 recovery accepted a same-name non-unique artifact',
    'V020 recovery accepted a unique index with the wrong key or predicate',
]) {
    if (!indexDrill.includes(contract)) throw new Error(`Concurrent-index drill is incomplete: ${contract}`);
}

const orderSchema = read(resolveRoot('db/core/migrations/V015__order_schema.sql'));
const orderFixes = read(resolveRoot('db/core/migrations/V016__order_schema_fixes.sql'));
const orderLockFixes = read(resolveRoot('db/core/migrations/V019__order_lock_fixes.sql'));
if ((orderSchema.match(/LANGUAGE plpgsql\s+SET search_path = pg_catalog, public, pg_temp AS \$\$/g) ?? []).length !== 14) {
    throw new Error('Every order trigger function must pin a trusted search path');
}
for (const contract of [
    'ADD COLUMN order_ver BIGINT NOT NULL DEFAULT 0',
    'ADD CONSTRAINT order_intents_cluster_v2',
    'CREATE TABLE order_epochs',
    'CREATE VIEW order_epoch_current',
    'CREATE TABLE order_legs',
    'CREATE TABLE order_actions',
    'CREATE TABLE order_tx_blobs',
    'CREATE TABLE action_attempts',
    'CREATE TABLE order_blob_reads',
    'CREATE TABLE action_obs',
    'CREATE TABLE order_fills',
    'CREATE VIEW order_fill_current',
    'CREATE TABLE order_schedules',
    'CREATE TABLE order_anomalies',
    'CREATE TABLE order_sync_cursors',
    'CREATE TABLE order_event_keys',
    'CREATE INDEX order_actions_due_idx',
    'CREATE FUNCTION order_epoch_guard',
    'CREATE FUNCTION order_action_guard',
    'CREATE FUNCTION action_attempt_guard',
    'CREATE FUNCTION order_fill_guard',
    'active action lease requires its current live provider epoch',
    'pg_advisory_xact_lock_shared(hashtextextended(NEW.write_scope, 1937006964))',
    'committed transaction identity cannot change',
    'attempt start does not match the active action fence',
    'observation does not match its action effect, provider, or cluster',
    "OLD.state = 'planned' AND NEW.state IN ('due', 'skipped', 'cancelled')",
    'financial anomaly cannot resolve while its obligation is active',
    'sync cursor high-water marks cannot regress',
    'lease generation must remain stable or advance by one',
    'sync lease generation must remain stable or advance by one',
    "NEW.state IN ('retracted', 'disputed')",
    'target order events are append-only',
]) {
    if (!orderSchema.includes(contract)) throw new Error(`Core order schema is missing: ${contract}`);
}
if (/\b(?:REAL|FLOAT|DOUBLE PRECISION)\b/i.test(policyText(orderSchema))) {
    throw new Error('Order financial and trigger facts cannot use approximate numeric types');
}
if (/ON\s+DELETE\s+CASCADE/i.test(orderSchema)) {
    throw new Error('Order actions, attempts, observations, fills, and audit facts cannot cascade on delete');
}
for (const contract of [
    'clock_timestamp()',
    'attempt does not match the active action fence',
    'blob access does not match its active outbound attempt',
    'sync cursors cannot be deleted',
    'sync cursor must start without a lease at version zero',
    'ADD COLUMN materialized_at TIMESTAMPTZ',
    'event reservation may only be consumed once',
    'legacy events cannot be promoted',
    'ADD COLUMN destroy_ref VARCHAR(180)',
    'CREATE FUNCTION purge_order_tx_blob',
    'terminal attempt recovery',
    'schedule completion must match the current finalized fill exactly',
    'a financially consumed fill lineage cannot be revised',
    'FOR SHARE;',
    'journal consumed by a resolved anomaly cannot be reversed',
]) {
    if (!orderFixes.includes(contract)) throw new Error(`Core order-schema fix is missing: ${contract}`);
}
if (/ON\s+DELETE\s+CASCADE/i.test(orderFixes)) {
    throw new Error('Order-schema fixes cannot add cascading audit deletion');
}
for (const contract of [
    'terminal action must release its active write fence',
    'matched := FOUND;\n        IF matched THEN\n            PERFORM pg_advisory_xact_lock_shared',
    'event reservation may only be consumed by its exact visible event',
    'AFTER INSERT ON order_events',
    'target order event has no exact deterministic reservation',
    'order-event reservation is claimed by duplicate or mismatched target rows',
    'migration:v19:terminal-fence:',
    'LOCK TABLE order_actions IN SHARE ROW EXCLUSIVE MODE',
    'LOCK TABLE order_event_keys, order_events IN SHARE ROW EXCLUSIVE MODE',
    'target_key order_fills.fill_key%TYPE',
    'fill.input_amt = NEW.intended_in',
    'used.fill_id = NEW.fill_id',
    'schedule completion must match one unconsumed current finalized fill exactly',
]) {
    if (!orderLockFixes.includes(contract)) throw new Error(`Core order-lock fix is missing: ${contract}`);
}
if (/ON\s+DELETE\s+CASCADE/i.test(orderLockFixes)) {
    throw new Error('Order-lock fixes cannot add cascading audit deletion');
}
const orderDeadlineIndex = read(resolveRoot('db/core/migrations/V017__attempt_deadline_index.sql'));
const orderExpiryIndex = read(resolveRoot('db/core/migrations/V018__blob_expiry_index.sql'));
const scheduleFillIndex = read(resolveRoot('db/core/migrations/V020__schedule_fill_index.sql'));
const resolvedAnomalyIndex = read(resolveRoot('db/core/migrations/V021__resolved_anomaly_index.sql'));
const attemptDispatchGuard = read(resolveRoot('db/core/migrations/V022__attempt_dispatch_guard.sql'));
const actionPolicy = read(resolveRoot('db/core/migrations/V022_1__action_policy.sql'));
const actionEvidenceRules = read(resolveRoot('db/core/migrations/V023__action_evidence_rules.sql'));
const actionProviderIndex = read(resolveRoot('db/core/migrations/V024__action_provider_due_index.sql'));
const actionPredecessorIndex = read(resolveRoot('db/core/migrations/V025__action_predecessor_index.sql'));
const actionEgress = read(resolveRoot('db/core/migrations/V026__action_egress.sql'));
const policyAudit = read(resolveRoot('db/core/migrations/V027__action_policy.sql'));
const actionFactIndex = read(resolveRoot('db/core/migrations/V028__action_fact_index.sql'));
const actionLineageIndex = read(resolveRoot('db/core/migrations/V029__action_lineage_index.sql'));
const actionEgressPhase = read(resolveRoot('db/core/migrations/V030__action_egress_phase.sql'));
const actionEgressTerminal = read(resolveRoot('db/core/migrations/V031__action_egress_terminal.sql'));
const evidencePolicyFix = read(resolveRoot('db/core/migrations/V032__evidence_policy_fix.sql'));
const epochIsolation = read(resolveRoot('db/core/migrations/V033__epoch_isolation.sql'));
const egressRecovery = read(resolveRoot('db/core/migrations/V034__egress_recovery.sql'));
const egressRecoveryGuard = read(resolveRoot('db/core/migrations/V035__egress_recovery_guard.sql'));
const signedTxHardening = read(resolveRoot('db/core/migrations/V039__transaction_blob_hardening.sql'));
const opCutoverIndex = read(resolveRoot('db/core/migrations/V040__order_operation_cutover_index.sql'));
const opCutover = read(resolveRoot('db/core/migrations/V041__order_operation_cutover.sql'));
const opValidate = read(resolveRoot('db/core/migrations/V042__order_operation_validate.sql'));
const txRuntimeFixes = read(resolveRoot('db/core/migrations/V043__transaction_runtime_fixes.sql'));
const opReplaySafety = read(resolveRoot('db/core/migrations/V044__operation_replay_safety.sql'));
const opReplayValidate = read(resolveRoot('db/core/migrations/V045__operation_replay_validate.sql'));
const txRuntimeHardening = read(resolveRoot('db/core/migrations/V047__transaction_runtime_hardening.sql'));
const txRoleAcl = read(resolveRoot('db/core/migrations/V048__transaction_role_acl.sql'));
const providerClaimIntegrity = read(resolveRoot('db/core/migrations/V049__provider_claim_integrity.sql'));
const txRoleEnforcement = read(resolveRoot('db/core/migrations/V050__transaction_role_enforcement.sql'));
const txRoleHardening = read(resolveRoot('db/core/migrations/V055__transaction_role_hardening.sql'));
const claimCircuitLock = read(resolveRoot('db/core/migrations/V056__asset_claim_circuit_lock.sql'));
const txAclAllowlist = read(resolveRoot('db/core/migrations/V057__transaction_acl_allowlist.sql'));
const providerEvidenceIntegrity = read(resolveRoot('db/core/migrations/V058__provider_evidence_integrity.sql'));
const executionTxBlobs = read(resolveRoot('db/core/migrations/V059__execution_tx_blobs.sql'));
const executionSettlement = read(resolveRoot('db/core/migrations/V060__execution_settlement.sql'));
if (createHash('sha256').update(attemptDispatchGuard).digest('hex')
    !== '81095308a15b41f1e2686c93fcf1da1eb0b701dd1a7a0f1185a88c61884495c3') {
    throw new Error('Applied V022 checksum changed; policy fixes require a forward migration');
}
for (const contract of [
    'CREATE TABLE execution_tx_blobs',
    'LOCK TABLE trade_executions IN SHARE ROW EXCLUSIVE MODE',
    'execution blob cutover requires drained Jupiter claims',
    'CREATE TRIGGER execution_tx_blobs_guard',
    'CREATE TRIGGER trade_executions_broadcast_guard',
    'BEFORE INSERT OR UPDATE ON trade_executions',
    'managed swap transaction identity is immutable',
    'managed swap broadcast markers are immutable',
    'managed swap broadcast requires a live encrypted transaction blob',
    'GRANT INSERT ON TABLE execution_tx_blobs TO core_runtime',
    'CREATE FUNCTION assert_execution_blob_acl()',
    'PERFORM public.assert_execution_blob_acl()',
]) {
    if (!executionTxBlobs.includes(contract)) {
        throw new Error(`Execution transaction blob migration is missing: ${contract}`);
    }
}
for (const contract of [
    'CREATE TABLE execution_settlements',
    'LOCK TABLE trade_executions IN SHARE ROW EXCLUSIVE MODE',
    'execution settlement cutover requires drained Jupiter claims',
    'provider settlement amounts are immutable',
    'execution signature is immutable once observed',
    'execution aggregate requires exact immutable settlement evidence',
    'finalized execution settlement differs from confirmed evidence',
    'managed swap confirmation requires independent settlement evidence',
    'observed execution settlement state cannot be discarded',
    'NEW.settlement_commitment IS DISTINCT FROM NEW.state',
    'BEFORE INSERT OR UPDATE OR DELETE ON execution_settlements',
    "settlement_status NOT IN ('verified', 'mismatch')",
]) {
    if (!executionSettlement.includes(contract)) {
        throw new Error(`Execution settlement migration is missing: ${contract}`);
    }
}
for (const [sql, contract] of [
    [orderDeadlineIndex, 'CREATE INDEX CONCURRENTLY action_attempts_deadline_idx'],
    [orderExpiryIndex, 'CREATE INDEX CONCURRENTLY order_tx_blobs_expiry_idx'],
    [scheduleFillIndex, 'CREATE UNIQUE INDEX CONCURRENTLY order_schedules_fill_idx'],
    [resolvedAnomalyIndex, 'CREATE INDEX CONCURRENTLY order_anomalies_resolved_journal_idx'],
    [actionProviderIndex, 'CREATE INDEX CONCURRENTLY order_actions_provider_due_idx'],
    [actionPredecessorIndex, 'CREATE INDEX CONCURRENTLY order_actions_predecessor_idx'],
    [actionFactIndex, 'CREATE UNIQUE INDEX CONCURRENTLY action_obs_fact_idx'],
    [actionLineageIndex, 'CREATE UNIQUE INDEX CONCURRENTLY action_obs_supersedes_idx'],
]) {
    if (!sql.includes(contract)) throw new Error(`Order operational index is missing: ${contract}`);
}
for (const contract of [
    'CREATE FUNCTION action_dispatch_valid',
    'CREATE FUNCTION action_http_valid',
    'CREATE TRIGGER action_attempt_policy_guard',
    'existing action attempt violates the versioned policy',
]) {
    if (!actionPolicy.includes(contract)) {
        throw new Error(`Early action policy migration is missing: ${contract}`);
    }
}
for (const contract of [
    'ALTER FUNCTION public.assert_tx_roles() RENAME TO assert_tx_role_base',
    'CREATE FUNCTION public.assert_tx_acl()',
    'CREATE FUNCTION public.assert_tx_roles()',
    'PERFORM public.assert_tx_role_base()',
    'PERFORM public.assert_tx_acl()',
    'pg_catalog.aclexplode(',
    'acl.grantee NOT IN',
    'acl.is_grantable',
    'transaction function ACL has unauthorized grantee or grant option',
    'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
    'GRANT EXECUTE ON FUNCTION public.assert_blob_access',
    'GRANT EXECUTE ON FUNCTION public.purge_order_tx_blob',
]) {
    if (!txAclAllowlist.includes(contract)) {
        throw new Error(`Transaction function ACL allowlist is missing: ${contract}`);
    }
}
for (const contract of [
    'CREATE FUNCTION assert_blob_access(',
    'PERFORM 1 FROM order_intents stored WHERE stored.id = target_order FOR SHARE',
    'PERFORM assert_blob_access(',
    'CREATE OR REPLACE FUNCTION purge_order_tx_blob',
    'FROM order_tx_blobs blob',
]) {
    if (!txRuntimeFixes.includes(contract)) {
        throw new Error(`Transaction runtime lock fix is missing: ${contract}`);
    }
}
if (!opCutoverIndex.includes('CREATE INDEX CONCURRENTLY order_intents_op_cutover_idx')) {
    throw new Error('Operation writer cutover index is missing');
}
for (const contract of [
    'ADD COLUMN op_writer SMALLINT',
    'ADD COLUMN op_ver BIGINT NOT NULL DEFAULT 0',
    'operation writer cutover requires drained prior writers and reconciled legacy operations',
    'ADD CONSTRAINT order_intents_op_shape_v3 CHECK ((',
    ') IS TRUE) NOT VALID',
    'started provider mutation cannot return to reserved',
    'started provider mutation lease change requires a new writer version',
    'provider mutation reservation requires writer version 2',
    'BEFORE INSERT OR UPDATE ON order_intents',
]) {
    if (!opCutover.includes(contract)) {
        throw new Error(`Operation writer cutover is missing: ${contract}`);
    }
}
if (!opValidate.includes('VALIDATE CONSTRAINT order_intents_op_shape_v3')) {
    throw new Error('Operation writer cutover validation is missing');
}
for (const contract of [
    'LOCK TABLE order_intents IN ACCESS EXCLUSIVE MODE',
    'BEFORE INSERT OR UPDATE OR DELETE ON order_intents',
    'active provider mutation fact cannot be deleted',
    "pg_get_indexdef(index_row.indexrelid, 1, true) = 'id'",
    'SET LOCAL enable_seqscan = off',
    'SET LOCAL enable_bitmapscan = off',
    'SET LOCAL enable_indexscan = on',
    'SET LOCAL enable_indexonlyscan = on',
    'operation replay cutover requires drained writers and reconciled unknown outcomes',
    'ADD CONSTRAINT order_intents_op_shape_v4 CHECK ((',
    'op_ver >= 0',
    'started provider mutation must preserve its lifetime generation when cleared',
]) {
    if (!opReplaySafety.includes(contract)) {
        throw new Error(`Operation replay cutover is missing: ${contract}`);
    }
}
if (!opReplayValidate.includes('VALIDATE CONSTRAINT order_intents_op_shape_v4')) {
    throw new Error('Operation replay cutover validation is missing');
}
for (const contract of [
    'REVOKE ALL ON FUNCTION assert_blob_access',
    'REVOKE ALL ON FUNCTION order_blob_read_guard()',
    'REVOKE ALL ON FUNCTION purge_order_tx_blob',
    'GRANT EXECUTE ON FUNCTION assert_blob_access',
    'TO CURRENT_USER',
]) {
    if (!txRuntimeHardening.includes(contract)) {
        throw new Error(`Transaction runtime ACL hardening is missing: ${contract}`);
    }
}
const prodCoreConf = parseConf(read(resolveRoot('db/flyway/core-production.conf')));
const prodCoreInit = prodCoreConf.get('flyway.initSql') || '';
if (prodCoreConf.size !== 1) {
    throw new Error('Production core Flyway overlay may only replace the connection init SQL');
}
for (const contract of [
    "rolname = 'core_runtime'",
    'TO core_runtime',
    "rolname = 'core_maintenance'",
    'TO core_maintenance',
]) {
    if (!txRoleAcl.includes(contract)) {
        throw new Error(`Transaction production role ACL is missing: ${contract}`);
    }
}
for (const contract of [
    'ADD COLUMN payload JSONB',
    'ADD COLUMN claim_ver SMALLINT',
    'ADD COLUMN claim_count SMALLINT',
    'ADD COLUMN claim_hash CHAR(64)',
    'DISABLE TRIGGER asset_obligation_write_guard',
    'ENABLE TRIGGER asset_obligation_write_guard',
    'version 2 claim part lacks its exact signed provider document',
    'provider claims require one complete settlement journal',
    'CREATE OR REPLACE VIEW asset_circuits',
]) {
    if (!providerClaimIntegrity.includes(contract)) {
        throw new Error(`Provider claim integrity is missing: ${contract}`);
    }
}
for (const contract of [
    'ADD COLUMN payload_canon TEXT',
    'CREATE FUNCTION asset_json_canon(value JSONB)',
    "ORDER BY pg_catalog.convert_to(item.key, 'UTF8')",
    'CREATE FUNCTION asset_payload_guard()',
    'NEW.payload_canon::jsonb IS DISTINCT FROM NEW.payload',
    'NEW.payload_canon IS DISTINCT FROM public.asset_json_canon(NEW.payload)',
    "pg_catalog.convert_to(NEW.payload_canon, 'UTF8')",
    'CREATE FUNCTION asset_assert_claim_doc(target UUID)',
    'evidence.signature IS DISTINCT FROM opening.signature',
    'evidence.payload_canon, public.asset_json_canon(evidence.payload)',
    'PERFORM asset_assert_claim_doc(NEW.id)',
    'PERFORM asset_assert_claim_doc(NEW.obligation_id)',
    'CREATE FUNCTION asset_claim_clear_guard()',
    "proof.source = 'chain'",
    'proof.signature = opening.signature',
    'proof.effect_key = opening.effect_key',
]) {
    if (!providerEvidenceIntegrity.includes(contract)) {
        throw new Error(`Provider evidence integrity is missing: ${contract}`);
    }
}
for (const contract of [
    "rolname = 'core_runtime'",
    "rolname = 'core_maintenance'",
    "pg_has_role('core_runtime', 'core_maintenance', 'MEMBER')",
    'SECURITY DEFINER',
    'REVOKE CREATE ON SCHEMA public',
    'TO core_runtime',
    'TO core_maintenance',
    'FROM core_runtime',
    'FROM core_maintenance',
]) {
    if (!txRoleEnforcement.includes(contract)) {
        throw new Error(`Transaction production role enforcement is missing: ${contract}`);
    }
}
for (const contract of [
    'SET search_path = pg_catalog, pg_temp',
    'FROM public.order_actions',
    'FROM public.order_tx_blobs',
    'pg_catalog.btrim(proof)',
    'REVOKE CREATE ON SCHEMA public FROM PUBLIC',
    'CREATE FUNCTION public.assert_tx_roles()',
    'WITH RECURSIVE parents(root_oid, role_oid)',
    'role.rolcreatedb',
    'role.rolreplication',
    'transaction caller roles have unsafe effective function privileges',
    'public schema has untrusted creator role',
    'PERFORM public.assert_tx_roles()',
]) {
    if (!txRoleHardening.includes(contract)) {
        throw new Error(`Transaction role hardening is missing: ${contract}`);
    }
}
for (const contract of [
    'asset circuit upgrade found crossed or dangling action identity',
    'ADD CONSTRAINT asset_obligations_action_fk',
    'CREATE FUNCTION asset_lock_claim_scope(target UUID)',
    'SELECT obligation.mint',
    'SELECT part.mint',
    'ORDER BY order_row.id',
    'FOR UPDATE OF order_row',
    'PERFORM asset_lock_claim_scope(NEW.id)',
]) {
    if (!claimCircuitLock.includes(contract)) {
        throw new Error(`Provider claim circuit locking is missing: ${contract}`);
    }
}
for (const contract of [
    "rolname = 'core_runtime'",
    "rolname = 'core_maintenance'",
    'WITH RECURSIVE parents(root_oid, role_oid)',
    "version = ''055'' AND success",
    "pg_catalog.to_regprocedure('public.assert_tx_roles()')",
    'PERFORM public.assert_tx_roles()',
    "ERRCODE = '42501'",
]) {
    if (!prodCoreInit.includes(contract)) {
        throw new Error(`Production Flyway role preflight is missing: ${contract}`);
    }
}
const roleRunner = read(resolveRoot('db/tools/run-migrations.mjs'));
const roleCompose = read(resolveRoot('db/tools/compose-flyway.sh'));
if (!roleRunner.includes('core-production.conf')
    || !roleRunner.includes('configFiles: flywayConfig(item)')
    || !roleCompose.includes('core-production.conf')) {
    throw new Error('Production migration entrypoints do not enforce the transaction-role preflight');
}
for (const contract of [
    'CREATE OR REPLACE FUNCTION recover_action_egress(batch_size INTEGER)',
    'batch_size IS NULL OR batch_size < 1 OR batch_size > 1000',
    'FOR UPDATE OF egress SKIP LOCKED',
    'LIMIT batch_size',
]) {
    if (!egressRecoveryGuard.includes(contract)) {
        throw new Error(`Action egress recovery guard is missing: ${contract}`);
    }
}
for (const contract of [
    'ADD COLUMN aad_ver SMALLINT NOT NULL DEFAULT 1',
    'ALTER COLUMN aad_ver SET DEFAULT 2',
    'ADD COLUMN raw_hash CHAR(64)',
    'ADD COLUMN lease_owner VARCHAR(128)',
    'committed prepared transaction identity cannot change',
    'new encrypted transaction blobs require durable version-2 identity',
    'attempt transaction blob does not outlive its transport deadline',
    'egress transaction blob is unavailable for its full deadline',
    'blob access does not match one live outbound authorization',
    'action.lease_owner <> NEW.lease_owner',
    'migration:v39:signed-policy:',
]) {
    if (!signedTxHardening.includes(contract)) {
        throw new Error(`Signed transaction hardening is missing: ${contract}`);
    }
}
for (const contract of [
    'ADD COLUMN rule_ver SMALLINT NOT NULL DEFAULT 1',
    'CREATE TABLE order_proof_caps',
    "VALUES ('fixture', 1, true, 'migration:v23:fixture-proof-v1')",
    'CREATE OR REPLACE VIEW action_obs_current',
    'CREATE FUNCTION action_effect_derived',
    'CREATE FUNCTION action_obs_reduction_guard',
    'CREATE FUNCTION action_source_valid',
    'CREATE FUNCTION evidence_anomaly_guard',
    'DEFERRABLE INITIALLY DEFERRED',
    'CREATE FUNCTION order_action_transition_guard',
    'observation correction must extend one exact fact lineage',
    'action effect does not match its current decisive evidence',
    'action cannot enter conflict without current conflict evidence',
    'observation fact revision already exists',
    'legacy observation has an invalid compatibility shape',
    'versioned observation writes require read committed while uniqueness indexes are unavailable',
    'decisive action evidence must settle the action atomically',
]) {
    if (!actionEvidenceRules.includes(contract)) {
        throw new Error(`Action evidence reduction is missing: ${contract}`);
    }
}
if (actionEvidenceRules.includes('LOCK TABLE order_actions, action_obs')
    || actionEvidenceRules.includes('CREATE UNIQUE INDEX action_obs_')) {
    throw new Error('Action evidence migration performs a write-blocking index rollout');
}
for (const contract of [
    'CREATE TABLE action_egress',
    'CREATE INDEX action_egress_inflight_idx',
    'CREATE TRIGGER order_anomalies_00_lock',
    'Serialize every blocking anomaly producer with action start and provider egress',
    'CREATE FUNCTION action_egress_guard',
    'pg_advisory_xact_lock_shared',
    'attempt.deadline_at > action.lease_until',
    "epoch.mode = 'live'",
    'anomaly.blocks_actions',
    "RAISE EXCEPTION 'egress does not match one active fenced attempt'",
    'NEW.forwarded_at := now_at',
    "RAISE EXCEPTION 'action egress is append-once'",
]) {
    if (!actionEgress.includes(contract)) {
        throw new Error(`Action mutation egress boundary is missing: ${contract}`);
    }
}
for (const contract of [
    'ADD COLUMN started_at TIMESTAMPTZ',
    'ADD CONSTRAINT action_egress_phase_order',
    "to_jsonb(NEW) - ARRAY['started_at', 'completed_at']",
    'NEW.started_at := clock_timestamp()',
    'egress transport deadline elapsed before start',
    'NEW.started_at := OLD.forwarded_at',
    'Durable reservation time; conservative at-most-once boundary, not proof of network I/O',
]) {
    if (!actionEgressPhase.includes(contract)) {
        throw new Error(`Action egress phase migration is missing: ${contract}`);
    }
}
for (const contract of [
    'ADD COLUMN phase_ver SMALLINT',
    'ADD COLUMN end_kind VARCHAR(24)',
    'ADD CONSTRAINT action_egress_terminal_v2',
    "NEW.end_kind = 'deadline_before_start'",
    "NEW.end_kind := 'legacy_settled'",
    "write epoch has an unexpired durable egress authorization",
    'CREATE OR REPLACE FUNCTION order_epoch_guard()',
]) {
    if (!actionEgressTerminal.includes(contract)) {
        throw new Error(`Action egress terminal migration is missing: ${contract}`);
    }
}
for (const contract of [
    'WHERE fact_key IS NOT NULL',
    'CREATE FUNCTION action_absence_query_valid',
    'ADD CONSTRAINT action_obs_absence_query_v1',
    "WHEN 'provider' THEN query_kind = 'found'",
    "WHEN 'chain' THEN query_kind = 'expired_unseen'",
]) {
    if (!evidencePolicyFix.includes(contract)) {
        throw new Error(`Evidence policy correction is missing: ${contract}`);
    }
}
for (const contract of [
    'CREATE FUNCTION order_epoch_isolation_guard()',
    "current_setting('transaction_isolation') <> 'read committed'",
    "write epoch advancement requires read committed isolation",
    'CREATE TRIGGER order_epochs_00_isolation',
]) {
    if (!epochIsolation.includes(contract)) {
        throw new Error(`Epoch isolation guard is missing: ${contract}`);
    }
}
for (const contract of [
    'ADD COLUMN writer_ver SMALLINT',
    'ADD CONSTRAINT action_egress_writer_ver',
    'CREATE FUNCTION recover_action_egress(batch_size INTEGER)',
    'FOR UPDATE OF egress SKIP LOCKED',
    'attempt.deadline_at <= clock_timestamp()',
    'egress.writer_ver = 2',
    "end_kind = 'deadline_before_start'",
]) {
    if (!egressRecovery.includes(contract)) {
        throw new Error(`Action egress crash recovery is missing: ${contract}`);
    }
}
for (const contract of [
    'ADD CONSTRAINT action_attempt_http_fact',
    'existing action attempt violates its admitted dispatch policy',
    "RAISE EXCEPTION 'attempt fence is no longer active' USING ERRCODE = '40001'",
    'action.req_hash <> NEW.req_hash',
]) {
    if (!attemptDispatchGuard.includes(contract)) {
        throw new Error(`Attempt dispatch hardening is missing: ${contract}`);
    }
}
for (const contract of [
    "tgname = 'action_attempt_policy_guard'",
    'action attempt policy drift occurred after V022.1',
    'NOT action_dispatch_valid(',
    'NOT action_http_valid(',
]) {
    if (!policyAudit.includes(contract)) {
        throw new Error(`Forward action policy migration is missing: ${contract}`);
    }
}
for (const constraint of [
    'order_intents_cluster_v2', 'order_intents_family_v2', 'order_intents_kind_v2',
    'order_intents_trigger_v2', 'order_intents_fill_v2', 'order_intents_funds_v2',
    'order_intents_amounts_v2', 'order_intents_version_v2', 'order_events_target_shape',
]) {
    if (!new RegExp(`ADD CONSTRAINT ${constraint}[\\s\\S]*?NOT VALID`).test(orderSchema)) {
        throw new Error(`Existing order rows would be scanned while adding ${constraint}`);
    }
}
const orderDrill = read(resolveRoot('tests/system/test-order-schema.mjs'));
for (const contract of [
    "await migrate('014')", "await migrate('015')", "await migrate('022.1', policyUrl)",
    "await migrate('035')", "await migrate('038')", "await migrate('039')",
    "await migrate('040')", "await migrate('041')", "await migrate('042')",
    "await migrate('043')", "await migrate('044')", "await migrate('045')",
    'Legacy writer was not healthy through V015',
    'an expired active action lease', 'cross-provider action evidence',
    'lease renewal after wall-clock expiry in a paused transaction',
    'lease renewal after expiry during an advisory-lock wait',
    'attempt start after wall-clock lease expiry in a paused transaction',
    'attempt start after expiry during an advisory-lock wait',
    'blob read after wall-clock lease expiry in a paused transaction',
    'blob read after expiry during an action-row wait',
    'Epoch freeze did not wait for the in-flight shared action fence',
    'an untrusted temporary epoch shadow',
    'a committed transaction identity rewrite',
    'a provider-only durable fill', 'financial anomaly resolution with an active obligation',
    'a schedule amount that differs from its finalized fill',
    'a partial schedule principal that differs from its intended amount',
    'reuse of one finalized fill by a second schedule',
    'a 181-byte finalized fill key',
    'revision of a financially consumed fill lineage',
    'reversal of a journal consumed by a resolved anomaly',
    'a regressing sync high-water mark', 'sync cursor deletion and reinsertion reset',
    'a second materialization of one event reservation',
    'direct event reservation consumption without its event',
    'promotion of a legacy event around identity reservation',
    'transaction blob purge before its retention deadline',
    'a committed transaction validity rewrite',
    'an incomplete provider operation fact',
    'a started provider operation identity rewrite',
    'V041 accepted an undrained prior mutation writer',
    'an N-1 factless mutation insert',
    'an N-1 factless mutation lease',
    'an N-1 takeover of a versioned reservation',
    'a null-hole provider operation fact',
    'a started provider operation downgrade',
    'an N-1 clear of a started provider operation',
    'Natural operation cutover audit did not use its bounded partial index',
    'Forced operation cutover audit did not use its bounded partial index',
    'V044 accepted a mismatched operation audit index',
    'direct deletion of an active provider operation fact',
    'cascaded deletion of an active provider operation fact',
    'Resolved provider operation reset its lifetime generation',
    'Provider operation lifetime generation did not advance monotonically',
    'a prepared transaction validity rewrite before blob binding',
    'an N-1 signed blob bind without reconstructable authenticated data',
    'a signed attempt whose blob expires before its deadline',
    'a blob read from the wrong lease owner',
    'an N-1 blob read without its lease owner',
    'Exact blob-access retry created a second authorization fact',
    'Blob read and response lock order did not converge',
    'a blob-access retry after its attempt response',
    'a terminal action that retains its write fence',
    'V019 did not audit terminal-fence repair and recover a V015 pending event key',
    'V019 did not preserve exact events and recover only unclaimed reservations',
    'V019 accepted a mismatched legacy event reservation claim',
    'V023 built observation uniqueness with a write-blocking index',
    'V023 deployment gap did not preserve exact observation replay',
    'V023 competing successor race did not serialize',
    'V032 allowed legacy context to hide colliding versioned evidence',
    'repeatable read write epoch advancement',
    'serializable write epoch advancement',
    'read committed epoch advancement did not wait for egress reservation',
    'V034 did not recover each trusted never-started reservation exactly once',
    'V034 recovery did not skip a contended egress row',
    'V034 swept an ambiguous legacy reservation',
    'a null egress recovery batch',
    'Database dispatch matrix diverged',
    'Database HTTP fact matrix diverged',
    'Database evidence-source matrix diverged',
    'Database absence-query policy diverged',
    'action conflict without current conflict evidence',
    'a disallowed provider-sync chain observation',
    'Expired transaction blob was not reduced to its destruction tombstone',
    'target lifecycle event mutation', 'order_actions_due_idx',
]) {
    if (!orderDrill.includes(contract)) throw new Error(`Order schema qualification is incomplete: ${contract}`);
}

const compose = read(resolveRoot('docker-compose.prod.yml'));
if (!compose.includes(flywayImage)) throw new Error('Production Compose does not use the pinned Flyway image');
for (const service of ['validate-core:', 'validate-market:', 'verify-split:', 'migrate-core:', 'migrate-market:']) {
    if (!compose.includes(service)) throw new Error(`Production Compose is missing ${service}`);
}
const flywayBlock = compose.slice(compose.indexOf('x-flyway:'), compose.indexOf('services:'));
if (flywayBlock.includes('env_file:')) throw new Error('Flyway services inherit an application env file');
if (/FLYWAY_URL/.test(compose)) throw new Error('Production Compose accepts an arbitrary JDBC URL');
for (const secret of ['core_db_password', 'core_db_ca', 'market_db_password', 'market_db_ca']) {
    if (!compose.includes(`${secret}:`)) throw new Error(`Compose migration secret is missing: ${secret}`);
}
if ((compose.match(/\bfile: \$\{(?:CORE|MARKET)_DB_(?:PASSWORD|CA)_FILE:-\/dev\/null\}/g) ?? []).length !== 4) {
    throw new Error('Production Compose secrets must be standalone file-backed inputs');
}
if (/\$\{(?:CORE|MARKET)_DB_PASSWORD(?::|})/.test(compose)) {
    throw new Error('Production Compose injects a database password through Config.Env');
}
if (!compose.includes('condition: service_completed_successfully')) {
    throw new Error('Compose migrations do not depend on successful all-plane preflight');
}

const rootPackage = JSON.parse(read(resolveRoot('package.json')));
const backendPackage = JSON.parse(read(resolveRoot('backend/package.json')));
if (rootPackage.scripts.migrate !== 'node db/tools/run-migrations.mjs') throw new Error('Root migrate script changed');
for (const script of ['test:migration-race', 'test:order-schema', 'test:migration-legacy', 'test:migration-split', 'test:migrations', 'test:compose', 'migrate:inspect', 'migrate:adopt']) {
    if (!rootPackage.scripts[script]) throw new Error(`Missing ${script} migration command`);
}
if (!backendPackage.scripts.migrate?.includes('npm --prefix .. run migrate')) {
    throw new Error('Backend migration alias must delegate to the root runner');
}
if (fs.existsSync(resolveRoot('backend/src/database/migrate.ts'))) {
    throw new Error('Imperative TypeScript migration runner still exists');
}

const runner = read(resolveRoot('db/tools/run-migrations.mjs'));
const flywayRunner = read(resolveRoot('db/tools/flyway-runner.mjs'));
const adoption = read(resolveRoot('db/tools/adopt-migrations.mjs'));
const history = read(resolveRoot('db/tools/flyway-history.mjs'));
const composeRunner = read(resolveRoot('db/tools/compose-flyway.sh'));
const catalog = read(resolveRoot('db/tools/catalog-proof.mjs'));
const planeSplit = read(resolveRoot('db/tools/plane-split.mjs'));
if (!runner.includes('Preflight every selected plane before any schema can advance')) {
    throw new Error('Local all-plane preflight is not ordered before migration');
}
if (!runner.includes('await verifySplit()') || !runner.includes('assertPlaneSplit')) {
    throw new Error('Local migration runner does not enforce physical plane separation');
}
if (!flywayRunner.includes("child.kill('SIGKILL')") || !flywayRunner.includes("['stop', '--time', '10', name]")) {
    throw new Error('Local Flyway timeout lacks TERM/KILL escalation');
}
for (const contract of [
    'class FlywayRunError', 'error.stdout, error.stderr', 'const procWindow',
    'reserveMs: cleanupReserve(deadline)', 'remove(name, dockerEnv, deadline)',
]) {
    if (!flywayRunner.includes(contract)) throw new Error(`Flyway retry/deadline contract is missing: ${contract}`);
}
if (flywayRunner.includes('...process.env')) throw new Error('Flyway inherits the full application environment');
if (flywayRunner.includes('FLYWAY_PASSWORD: target.password')
    || !flywayRunner.includes('dst=/run/secrets/db-password,readonly')) {
    throw new Error('Local Flyway stores the database password in container metadata');
}
if (!adoption.includes('recordBaseline(client, plane, proof.digest)') || !adoption.includes('timingSafeEqual')) {
    throw new Error('Controlled adoption lacks atomic catalog proof and explicit baseline');
}
if (!history.includes("'BASELINE'") || !history.includes("VALUES (1, '001'")
    || !history.includes("'<< Flyway Schema Creation >>'") || !history.includes("'SCHEMA'")) {
    throw new Error('Controlled adoption does not write a Flyway-compatible baseline row');
}
if (!adoption.includes('MIGRATION_OFFLINE') || !adoption.includes('pg_try_advisory_xact_lock(1937006964')) {
    throw new Error('Controlled adoption lacks an offline gate or shared lock');
}
if (!composeRunner.includes("'-ignoreMigrationPatterns=*:pending'")
    || !composeRunner.includes('timeout --signal=TERM --kill-after=15s')) {
    throw new Error('Compose runner lacks preflight semantics or a hard timeout');
}
for (const field of ['encoding', 'locale_provider', 'collate', 'ctype', 'icu_locale', 'icu_rules', 'collation_version']) {
    if (!catalog.includes(`'${field}'`)) throw new Error(`Catalog server proof omits ${field}`);
}
if (catalog.includes('localeCompare') || (catalog.match(/COLLATE \"C\"/g) ?? []).length < 3
    || !catalog.includes('canonicalManifest')) {
    throw new Error('Catalog proof is not locale-independent and canonically serialized');
}
for (const exact of ['s.seqstart::text', 's.seqincrement::text', 's.seqmax::text', 's.seqmin::text', 's.seqcache::text', 'e.enumsortorder::text']) {
    if (!catalog.includes(exact)) throw new Error(`Catalog proof may lose exact numeric identity: ${exact}`);
}
if (!planeSplit.includes('pg_catalog.pg_control_system()') || !planeSplit.includes('system_identifier')
    || !planeSplit.includes('same PostgreSQL cluster')) {
    throw new Error('Physical plane split proof changed');
}
for (const file of ['db/tools/catalog-proof.mjs', 'db/tools/flyway-history.mjs', 'db/tools/compose-flyway.sh', 'db/tools/compose-plane-split.mjs', 'db/tools/plane-split.mjs', 'tests/system/test-plane-split-live.mjs', 'db/core/adoption/data-checks.sql']) {
    if (!fs.existsSync(resolveRoot(file))) throw new Error(`Missing adoption proof artifact: ${file}`);
}
if (!rootPackage.dependencies?.pg) throw new Error('Root migration scripts do not declare node-postgres');

const bad = parseConf(read(resolveRoot('db/flyway/core.conf')));
bad.set('flyway.cleanDisabled', 'false');
let rejected = false;
try {
    validateConf('core', bad);
} catch {
    rejected = true;
}
if (!rejected) throw new Error('Unsafe Flyway configuration was accepted');

const target = toJdbc('postgresql://fervor:secret@127.0.0.1:55432/fervor?sslmode=require', 'CORE', {});
if (target.url !== 'jdbc:postgresql://host.docker.internal:55432/fervor?sslmode=require'
    || target.user !== 'fervor' || target.password !== 'secret' || target.caFile !== null) {
    throw new Error('Database URL conversion lost connection or credential data');
}

const caFile = resolveRoot('tests/contracts/slo-targets.json');
const secure = toJdbc('postgresql://db:5432/fervor', 'CORE', {
    CORE_DB_USER: 'migrator',
    CORE_DB_SSL_MODE: 'verify-full',
    CORE_DB_SSL_CA: caFile,
    MIGRATION_ENV: 'production',
});
if (!secure.url.includes('sslmode=verify-full') || !secure.url.includes('sslrootcert=%2Fflyway%2Fcerts%2Fdb-ca.pem')) {
    throw new Error('Production TLS policy was not translated into Flyway settings');
}
const pgTarget = toPg('postgresql://fervor:secret@db:5432/fervor?sslmode=require', 'CORE', {});
if (pgTarget.connectionString.includes('sslmode') || pgTarget.ssl === false) {
    throw new Error('Adoption connection did not preserve required TLS');
}
const modeTarget = (host, mode) => toPg(
    `postgresql://fervor:secret@${host}:5432/fervor?sslmode=${mode}&sslrootcert=${encodeURIComponent(caFile)}`,
    'CORE',
    {},
);
const modeMatrix = [
    ['disable', 'db', false, false],
    ['require', 'db', false, false],
    ['verify-ca', 'db', true, true],
    ['verify-full', 'db', true, true],
    ['VERIFY-CA', 'db', true, true],
    ['VERIFY-FULL', 'db', true, true],
    ['verify-full', '127.0.0.1', true, true],
];
for (const [mode, host, rejectUnauthorized, hasIdentityCheck] of modeMatrix) {
    const targetConfig = mode === 'disable'
        ? toPg(`postgresql://fervor:secret@${host}:5432/fervor?sslmode=disable`, 'CORE', {})
        : modeTarget(host, mode);
    const client = new pg.Client(targetConfig);
    if (mode === 'disable') {
        if (client.ssl !== false) throw new Error('PostgreSQL sslmode=disable unexpectedly enabled TLS');
        continue;
    }
    if (client.ssl?.rejectUnauthorized !== rejectUnauthorized
        || (typeof client.ssl?.checkServerIdentity === 'function') !== hasIdentityCheck) {
        throw new Error(`PostgreSQL sslmode=${mode} changed at the node-postgres boundary`);
    }
}
const verifyCa = new pg.Client(modeTarget('db', 'verify-ca')).ssl;
if (verifyCa.checkServerIdentity('wrong.example', { subjectaltname: 'DNS:db' }) !== undefined) {
    throw new Error('PostgreSQL verify-ca performed certificate identity verification');
}
const dnsTls = new pg.Client(modeTarget('db', 'verify-full')).ssl;
const dnsMatch = dnsTls.checkServerIdentity('ignored', { subjectaltname: 'DNS:db' });
const dnsMismatch = dnsTls.checkServerIdentity('db', { subjectaltname: 'DNS:other.example' });
const ipTls = new pg.Client(modeTarget('127.0.0.1', 'verify-full')).ssl;
const ipMatch = ipTls.checkServerIdentity('localhost', { subjectaltname: 'IP Address:127.0.0.1' });
const ipMismatch = ipTls.checkServerIdentity('127.0.0.1', { subjectaltname: 'DNS:localhost' });
if (dnsMatch !== undefined || dnsMismatch?.code !== 'ERR_TLS_CERT_ALTNAME_INVALID'
    || ipMatch !== undefined || ipMismatch?.code !== 'ERR_TLS_CERT_ALTNAME_INVALID') {
    throw new Error('PostgreSQL verify-full did not bind certificate identity to the configured host');
}
const envTls = toPg('postgresql://fervor:secret@db:5432/fervor', 'CORE', {
    CORE_DB_SSL_MODE: 'VERIFY-FULL',
    CORE_DB_SSL_CA: caFile,
    MIGRATION_ENV: 'production',
});
if (envTls.ssl?.rejectUnauthorized !== true || typeof envTls.ssl?.checkServerIdentity !== 'function') {
    throw new Error('Uppercase environment TLS mode bypassed verify-full');
}
for (const mode of ['allow', 'prefer', 'ALLOW', 'PREFER']) {
    let opportunisticRejected = false;
    try {
        modeTarget('db', mode);
    } catch {
        opportunisticRejected = true;
    }
    if (!opportunisticRejected) throw new Error(`Node migration verifier accepted unsupported sslmode=${mode}`);
}
for (const host of ['[::1]', '%3A%3A1', '%5B%3A%3A1%5D']) {
    for (const convert of [toPg, toJdbc]) {
        let ipv6Rejected = false;
        try {
            convert(`postgresql://fervor:secret@${host}:5432/fervor`, 'CORE', {});
        } catch {
            ipv6Rejected = true;
        }
        if (!ipv6Rejected) throw new Error(`Migration URL conversion accepted an IPv6 literal: ${host}`);
    }
}
for (const convert of [toPg, toJdbc]) {
    for (const [value, env] of [
        ['postgresql://fervor:secret@db:5432/fervor?sslmode=', {}],
        ['postgresql://fervor:secret@db:5432/fervor', { CORE_DB_SSL_MODE: '' }],
    ]) {
        let emptyModeRejected = false;
        try {
            convert(value, 'CORE', env);
        } catch {
            emptyModeRejected = true;
        }
        if (!emptyModeRejected) throw new Error('Migration URL conversion accepted an empty TLS mode');
    }
}
let pgFragmentRejected = false;
try {
    toPg('postgresql://fervor:secret@db:5432/fervor#sslmode=disable', 'CORE', {});
} catch {
    pgFragmentRejected = true;
}
if (!pgFragmentRejected) throw new Error('Adoption connection accepted a URL fragment');

for (const unsafe of [
    'jdbc:postgresql://fervor:secret@db:5432/fervor',
    'jdbc:postgresql://db:5432/fervor?password=secret',
    'jdbc:postgresql://db:5432/fervor?SSLPassword=secret',
    'jdbc:postgresql://db:5432/fervor?%73%73%6c%70%61%73%73%77%6f%72%64=secret',
    'jdbc:postgresql://db:5432/fervor?loggerFile=secret.log',
    'jdbc:postgresql://db:5432/fervor#sslmode=disable',
    'jdbc:postgresql://db:5432/',
]) {
    let urlRejected = false;
    try {
        toJdbc(unsafe, 'CORE', { CORE_DB_USER: 'fervor' });
    } catch {
        urlRejected = true;
    }
    if (!urlRejected) throw new Error(`Unsafe JDBC URL was accepted: ${unsafe}`);
}
let tlsRejected = false;
try {
    toJdbc('postgresql://db:5432/fervor', 'CORE', { CORE_DB_USER: 'fervor', MIGRATION_ENV: 'production' });
} catch {
    tlsRejected = true;
}
if (!tlsRejected) throw new Error('Production migration accepted unverified transport');

let fallbackRejected = false;
try {
    sourceFor('market', { DATABASE_URL: 'postgresql://db/fervor' });
} catch {
    fallbackRejected = true;
}
if (!fallbackRejected) throw new Error('Market plane silently fell back to the generic database');
if (sourceFor('market', { DATABASE_URL: 'postgresql://db/fervor', MIGRATION_COLOCATED: 'true' }) !== 'postgresql://db/fervor') {
    throw new Error('Explicit colocated development fallback failed');
}

const scrubbed = cleanEnv({}, { PATH: process.env.PATH, JWT_SECRET: 'must-not-pass', JUPITER_API_KEY: 'must-not-pass' });
if (scrubbed.JWT_SECRET || scrubbed.JUPITER_API_KEY) throw new Error('Migration child environment retained application secrets');
const timeoutStart = Date.now();
const killed = await runProc(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    capture: true,
    env: cleanEnv(),
    timeoutMs: 50,
    graceMs: 50,
});
if (!killed.timedOut || killed.signal !== 'SIGKILL' || Date.now() - timeoutStart > 2_000) {
    throw new Error('Hard process timeout did not escalate to SIGKILL');
}

console.log(`migration spec: ${migrationCount} versioned files, ${planes.length} isolated histories, controlled adoption`);
