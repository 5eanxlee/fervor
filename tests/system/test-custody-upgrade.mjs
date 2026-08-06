import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { cleanEnv, runFlyway, runProc } from '../../db/tools/flyway-runner.mjs';
import { toJdbc } from '../../db/tools/migration-config.mjs';

const source = process.env.DATABASE_URL;
if (!source) throw new Error('DATABASE_URL is required');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const backendRequire = createRequire(path.join(root, 'backend/package.json'));
const tsNode = backendRequire.resolve('ts-node/dist/bin.js');
const timeoutMs = Number(process.env.MIGRATION_TIMEOUT_MS ?? 600_000);
const suffix = `${process.pid}_${randomBytes(4).toString('hex')}`;
const base = `fervor_custody_${suffix}`;
const databases = [];
const adminUrl = new URL(source);
adminUrl.pathname = '/postgres';
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const v6Sql = fs.readFileSync(path.join(root, 'db/core/migrations/V006__custody_consistency.sql'), 'utf8');
let currentVersion;

const databaseUrl = (name) => {
    const url = new URL(source);
    url.pathname = `/${name}`;
    return url.toString();
};

const migrate = (name, target) => runFlyway({
    root,
    plane: 'core',
    target: toJdbc(databaseUrl(name), 'CORE'),
    command: 'migrate',
    timeoutMs,
    extra: target ? [`-target=${target}`] : [],
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

const seedBase = async (client) => {
    const ids = {
        user: randomUUID(),
        order: randomUUID(),
        walletAccount: randomUUID(),
        vaultAccount: randomUUID(),
    };
    const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
    const vault = '8Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
    const mint = 'So11111111111111111111111111111111111111112';
    const quoteMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    await client.query(
        `INSERT INTO users (id, wallet_address) VALUES ($1, $2)`,
        [ids.user, `CustodyUpgrade${suffix}`]
    );
    await client.query(
        `INSERT INTO order_intents
         (id, user_id, provider, client_order_id, request_digest, wallet_address,
          order_type, state, input_mint, output_mint, input_amount, trigger_mint,
          params, expires_at)
         VALUES ($1, $2, 'fixture', $3, $4, $5, 'single', 'open', $6, $7, '10', $7,
                 '{}'::jsonb, CURRENT_TIMESTAMP + INTERVAL '1 day')`,
        [ids.order, ids.user, `custody-${suffix}-${ids.order}`, 'a'.repeat(64), wallet, mint, quoteMint]
    );
    await client.query(
        `INSERT INTO asset_accounts
         (id, account_key, cluster, wallet_address, order_id, mint, scope, external_id)
         VALUES ($1, $2, 'mainnet-beta', $3, NULL, $4, 'wallet', $5)`,
        [ids.walletAccount, `wallet:${ids.order}`, wallet, mint, `wallet:${ids.order}`]
    );
    await client.query(
        `INSERT INTO asset_accounts
         (id, account_key, cluster, wallet_address, vault_address, order_id, mint, scope, external_id)
         VALUES ($1, $2, 'mainnet-beta', $3, $4, $5, $6, 'vault_attr', $7)`,
        [ids.vaultAccount, `vault:${ids.order}`, wallet, vault, ids.order, mint, `vault:${ids.order}`]
    );
    return { ...ids, wallet, vault, mint };
};

const insertJournal = async (client, baseIds, input) => {
    await client.query(
        `INSERT INTO asset_journals
         (id, effect_key, req_hash, cluster, wallet_address, order_id, action_id, kind,
          reversal_of, occurred_at)
         VALUES ($1, $2, $3, 'mainnet-beta', $4, $5, $6, $7,
                 $8, CURRENT_TIMESTAMP)`,
        [input.id, input.effectKey, input.reqHash, baseIds.wallet, baseIds.order,
            input.actionId, input.kind, input.reversalOf ?? null]
    );
    const reversal = input.kind === 'reversal';
    await client.query(
        `INSERT INTO asset_entries (journal_id, line_no, account_id, side, amount)
         VALUES ($1, 0, $2, $4, 1), ($1, 1, $3, $5, 1)`,
        [input.id, baseIds.vaultAccount, baseIds.walletAccount,
            reversal ? 'credit' : 'debit', reversal ? 'debit' : 'credit']
    );
    await client.query(
        `UPDATE asset_journals SET post_state = 'posted' WHERE id = $1`,
        [input.id]
    );
    const evidenceId = randomUUID();
    const signature = '5'.repeat(88);
    const sourceKey = `legacy:${input.effectKey}`;
    await client.query(
        `INSERT INTO asset_evidence
         (id, journal_id, effect_key, evidence_hash, order_id, action_id, cluster,
          wallet_address, mint, source, source_key, commitment, signature, slot,
          instruction_index, event_index, payload_hash)
         VALUES ($1, $2, $3, $4, $5, $6, 'mainnet-beta', $7, $8, 'chain', $9,
                 'confirmed', $10, 42, 0, $11, $12)`,
        [evidenceId, input.id, input.effectKey, input.evidenceHash, baseIds.order,
            input.actionId, baseIds.wallet, baseIds.mint, sourceKey,
            signature, input.eventIndex, input.payloadHash]
    );
    let finalizedId;
    if (input.crossSlot) {
        finalizedId = randomUUID();
        await client.query(
            `INSERT INTO asset_evidence
             (id, journal_id, effect_key, evidence_hash, order_id, action_id, cluster,
              wallet_address, mint, source, source_key, commitment, signature, slot,
              instruction_index, event_index, payload_hash)
             VALUES ($1, $2, $3, $4, $5, $6, 'mainnet-beta', $7, $8, 'chain', $9,
                     'finalized', $10, 43, 0, $11, $12)`,
            [finalizedId, input.id, input.effectKey, 'f'.repeat(64), baseIds.order,
                input.actionId, baseIds.wallet, baseIds.mint, `${sourceKey}:finalized`,
                signature, input.eventIndex, input.payloadHash]
        );
    }
    await client.query(
        `SELECT set_asset_journal_state($1, 'confirmed')`,
        [input.id]
    );
    return {
        evidenceId,
        finalizedId,
        request: {
            journalId: input.id,
            effectKey: input.effectKey,
            orderId: baseIds.order,
            actionId: input.actionId,
            cluster: 'mainnet-beta',
            walletAddress: baseIds.wallet,
            mint: baseIds.mint,
            source: 'chain',
            sourceKey,
            rawState: '',
            commitment: 'confirmed',
            signature,
            slot: 42,
            instructionIndex: 0,
            eventIndex: input.eventIndex,
            payloadHash: input.payloadHash,
        },
    };
};

const seedCleared = async (name, mismatch, crossSlot = false) => withDatabase(name, async (client) => {
    const ids = await seedBase(client);
    const journalId = randomUUID();
    const actionId = randomUUID();
    await client.query('BEGIN');
    try {
        const proof = await insertJournal(client, ids, {
            id: journalId,
            effectKey: `legacy-proof:${name}`,
            reqHash: 'b'.repeat(64),
            evidenceHash: 'c'.repeat(64),
            payloadHash: 'd'.repeat(64),
            actionId,
            kind: 'deposit',
            eventIndex: 1,
            crossSlot,
        });
        await client.query(
            `INSERT INTO asset_obligations
             (id, obligation_key, req_hash, order_id, action_id, cluster, wallet_address,
              vault_address, mint, kind, state, clear_evidence_id, reason, cleared_at)
             VALUES ($1, $2, $3, $4, $5, 'mainnet-beta', $6, $7, $8,
                     'provider_missing', 'cleared', $9, $10, CURRENT_TIMESTAMP)`,
            [randomUUID(), `legacy-obligation:${name}`, 'e'.repeat(64), ids.order,
                mismatch ? randomUUID() : actionId, ids.wallet, ids.vault, ids.mint,
                proof.evidenceId, 'Legacy clear fixture']
        );
        await client.query('COMMIT');
        return proof;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
});

const replayLegacy = async (name, proof) => {
    const result = await runProc(
        process.execPath,
        [tsNode, '--transpile-only', 'tests/helpers/replayLegacyEvidence.ts'],
        {
            cwd: path.join(root, 'backend'),
            capture: true,
            timeoutMs: 30_000,
            env: cleanEnv({
                NODE_ENV: 'test',
                CORE_DATABASE_URL: databaseUrl(name),
                MARKET_DATABASE_URL: databaseUrl(name),
                DB_COLOCATED: 'true',
                DB_POOL_MAX: '1',
                JWT_SECRET: 'custody-replay-secret-with-sufficient-length',
                LEGACY_EVIDENCE_JSON: JSON.stringify(proof.request),
                LEGACY_EVIDENCE_ID: proof.evidenceId,
            }),
        }
    );
    if (result.timedOut || result.code !== 0) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        throw new Error(`Legacy evidence replay failed with ${result.signal ?? result.code}${detail ? `: ${detail}` : ''}`);
    }
};

const seedBrokenReversal = async (name) => withDatabase(name, async (client) => {
    const ids = await seedBase(client);
    const actionId = randomUUID();
    const originalId = randomUUID();
    await client.query('BEGIN');
    try {
        await insertJournal(client, ids, {
            id: originalId,
            effectKey: `legacy-original:${name}`,
            reqHash: '1'.repeat(64),
            evidenceHash: '2'.repeat(64),
            payloadHash: '3'.repeat(64),
            actionId,
            kind: 'deposit',
            eventIndex: 2,
        });
        await insertJournal(client, ids, {
            id: randomUUID(),
            effectKey: `legacy-reversal:${name}`,
            reqHash: '4'.repeat(64),
            evidenceHash: '5'.repeat(64),
            payloadHash: '6'.repeat(64),
            actionId,
            kind: 'reversal',
            reversalOf: originalId,
            eventIndex: 3,
        });
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
});

const expectV6Failure = async (name, message) => {
    await migrate(name, '005');
    await withDatabase(name, async (client) => {
        let failure;
        try {
            await client.query(v6Sql);
        } catch (error) {
            failure = error;
        }
        if (!(failure instanceof Error) || !failure.message.includes(message)) {
            throw failure ?? new Error(`V006 accepted invalid fixture: ${message}`);
        }
        const state = await client.query(
            `SELECT to_regprocedure('asset_obligation_guard()') IS NOT NULL AS guard,
                    EXISTS (SELECT 1 FROM fervor_core_meta.fervor_core_history WHERE version = '006') AS v6`
        );
        if (!state.rows[0].guard || state.rows[0].v6) {
            throw new Error(`Rejected V006 left inconsistent migration state for ${name}`);
        }
    });
};

await admin.connect();
try {
    await createDatabase(base);
    await migrate(base, '003');

    const valid = `${base}_valid`;
    const obligation = `${base}_obligation`;
    const reversal = `${base}_reversal`;
    await createDatabase(valid, base);
    await createDatabase(obligation, base);
    await createDatabase(reversal, base);

    const proof = await seedCleared(valid, false, true);
    await migrate(valid);
    await withDatabase(valid, async (client) => {
        const rows = await client.query(
            `SELECT source_key, legacy_source_key, evidence_hash, vault_address,
                    chain_event_id, commitment, slot
               FROM asset_evidence WHERE source = 'chain' ORDER BY commitment`
        );
        if (rows.rowCount !== 2
            || rows.rows.some((row) => !row.source_key.endsWith(`:${row.commitment}`))
            || rows.rows[0].evidence_hash !== 'c'.repeat(64)
            || rows.rows[0].legacy_source_key !== proof.request.sourceKey
            || rows.rows.some((row) => !row.vault_address || !row.chain_event_id)
            || new Set(rows.rows.map((row) => row.chain_event_id)).size !== 1
            || new Set(rows.rows.map((row) => Number(row.slot))).size !== 2) {
            throw new Error('Non-empty V003 evidence was not upgraded without rewriting its legacy hash');
        }
        const history = await client.query(
            'SELECT version FROM fervor_core_meta.fervor_core_history WHERE success ORDER BY installed_rank DESC LIMIT 1'
        );
        currentVersion = history.rows[0]?.version;
        if (!currentVersion) throw new Error('Custody upgrade did not record a current migration version');
    });
    await replayLegacy(valid, proof);

    await seedCleared(obligation, true);
    await expectV6Failure(obligation, 'legacy clearing evidence is not an active identity-matched proof');

    await seedBrokenReversal(reversal);
    await expectV6Failure(reversal, 'legacy reversal pair is not atomically consistent');
} finally {
    for (const database of databases.reverse()) {
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [database]);
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    }
    await admin.end();
}

if (process.env.CUSTODY_PROOF_PATH) {
    await fs.promises.writeFile(process.env.CUSTODY_PROOF_PATH, JSON.stringify({
        version: 1,
        baseVersion: '003',
        currentVersion,
        crossSlotReplay: true,
        corruptCases: 2,
    }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

console.log('custody upgrade: cross-slot observations and original replay identity preserved; corrupt states rejected');
