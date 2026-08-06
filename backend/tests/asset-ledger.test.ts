import { describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { DbQuery } from '../src/config/database';
import { AssetError, AssetLedger } from '../src/services/assets/assetLedger';
import { canonicalJson } from '../src/services/orders/canonicalJson';
import {
    assetAccountSchema,
    assetClaimSchema,
    assetEvidenceSchema,
    assetJournalSchema,
    obligationClearSchema,
} from '../src/types';

const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
const vault = '8Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
const mint = 'So11111111111111111111111111111111111111112';
const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const orderId = '10000000-0000-4000-8000-000000000001';
const journalId = '20000000-0000-4000-8000-000000000001';
const accountA = '30000000-0000-4000-8000-000000000001';
const accountB = '30000000-0000-4000-8000-000000000002';
const evidenceId = '40000000-0000-4000-8000-000000000001';
const chainEventId = '50000000-0000-4000-8000-000000000001';
const signature = '5'.repeat(88);
const payloadHash = 'a'.repeat(64);
const providerDoc = { source: 'jupiter', type: 'fill', ver: 1 };
const providerHash = crypto.createHash('sha256').update(canonicalJson(providerDoc)).digest('hex');

const result = (rows: Record<string, unknown>[] = []) => ({ rows, rowCount: rows.length }) as any;

const evidenceRow = (params: unknown[], overrides: Record<string, unknown> = {}) => ({
    id: params[0],
    journal_id: params[1],
    effect_key: params[2],
    evidence_hash: params[3],
    order_id: params[4],
    action_id: params[5],
    source: params[6],
    source_key: params[7],
    cluster: params[8],
    wallet_address: params[9],
    vault_address: params[10],
    mint: params[11],
    raw_state: params[12],
    commitment: params[13],
    signature: params[14],
    slot: params[15],
    instruction_index: params[16],
    event_index: params[17],
    payload_hash: params[18],
    payload: typeof params[19] === 'string' ? JSON.parse(params[19] as string) : params[19],
    payload_canon: params[20],
    source_at: params[21],
    chain_event_id: params[22],
    legacy_source_key: null,
    ...overrides,
});

const journal = (entries = [
    { accountId: accountB, side: 'credit' as const, amount: '10' },
    { accountId: accountA, side: 'debit' as const, amount: '10' },
]) => ({
    effectKey: 'deposit:provider-request-1',
    cluster: 'mainnet-beta' as const,
    walletAddress: wallet,
    orderId,
    kind: 'deposit' as const,
    entries,
    metadata: { provider: 'jupiter' },
    occurredAt: '2026-08-03T00:00:00.000Z',
});

const chainEvidence = () => ({
    effectKey: 'deposit:provider-request-1',
    orderId,
    cluster: 'mainnet-beta' as const,
    walletAddress: wallet,
    vaultAddress: vault,
    mint,
    source: 'chain' as const,
    commitment: 'confirmed' as const,
    signature,
    slot: 42,
    instructionIndex: 3,
    eventIndex: 1,
    payloadHash,
});

describe('asset ledger contracts', () => {
    it('requires complete order vault attribution identity', () => {
        expect(() => assetAccountSchema.parse({
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            mint,
            scope: 'vault_attr',
            externalId: 'order-vault',
        })).toThrow(/requires a vault and order/i);

        expect(assetAccountSchema.parse({
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            vaultAddress: vault,
            orderId,
            mint,
            scope: 'vault_attr',
            externalId: 'order-vault',
        })).toMatchObject({ vaultAddress: vault, orderId });
    });

    it('keeps journal amounts exact and reversal identity explicit', () => {
        expect(assetJournalSchema.parse(journal([
            { accountId: accountA, side: 'debit', amount: '18446744073709551615' },
            { accountId: accountB, side: 'credit', amount: '18446744073709551615' },
        ])).entries[0].amount).toBe('18446744073709551615');
        expect(() => assetJournalSchema.parse(journal([
            { accountId: accountA, side: 'debit', amount: '18446744073709551616' },
            { accountId: accountB, side: 'credit', amount: '18446744073709551616' },
        ]))).toThrow();
        expect(() => assetJournalSchema.parse({ ...journal(), kind: 'reversal' })).toThrow(/reversalOf/);
        expect(() => assetJournalSchema.parse(journal([
            { accountId: accountA, side: 'debit', amount: '1' },
            { accountId: accountA, side: 'credit', amount: '1' },
        ]))).toThrow(/distinct accounts/);
        expect(() => assetJournalSchema.parse({
            ...journal(), metadata: { oversized: 'x'.repeat(16_385) },
        })).toThrow(/16 KiB/);
    });

    it('requires exact Solana chain evidence with a safe slot', () => {
        expect(assetEvidenceSchema.parse(chainEvidence())).toMatchObject({
            signature,
            slot: 42,
            sourceKey: `${signature}:3:1:confirmed`,
        });
        expect(() => assetEvidenceSchema.parse({ ...chainEvidence(), signature: 'malformed' })).toThrow();
        expect(() => assetEvidenceSchema.parse({ ...chainEvidence(), slot: undefined })).toThrow(/signature, slot, commitment/);
        expect(() => assetEvidenceSchema.parse({ ...chainEvidence(), eventIndex: undefined })).toThrow(/event index/);
        expect(assetEvidenceSchema.parse({
            ...chainEvidence(), sourceKey: 'legacy:provider-proof', rawState: '   ',
        })).toMatchObject({
            sourceKey: `${signature}:3:1:confirmed`,
            legacyKey: 'legacy:provider-proof',
            rawState: undefined,
        });
        expect(() => assetEvidenceSchema.parse({ ...chainEvidence(), slot: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    });

    it('requires exactly one immutable obligation clearing fact', () => {
        expect(() => obligationClearSchema.parse({})).toThrow();
        expect(() => obligationClearSchema.parse({ evidenceId, journalId })).toThrow();
        expect(obligationClearSchema.parse({ evidenceId })).toEqual({ evidenceId });
    });

    it('requires provider claims to preserve every exact asset leg', () => {
        const evidence = (partMint: string, sourceKey: string) => ({
            effectKey: 'provider:jupiter:effect:claim-1',
            orderId,
            cluster: 'mainnet-beta' as const,
            walletAddress: wallet,
            vaultAddress: vault,
            mint: partMint,
            source: 'provider' as const,
            sourceKey,
            signature,
            payloadHash: providerHash,
            payload: providerDoc,
        });
        const claim = {
            obligation: {
                obligationKey: 'provider:jupiter:claim:claim-1',
                orderId,
                cluster: 'mainnet-beta' as const,
                walletAddress: wallet,
                vaultAddress: vault,
                mint,
                kind: 'fill_unverified' as const,
                amount: '10',
                reason: 'Provider fill awaits chain proof',
            },
            parts: [
                { role: 'input' as const, mint, amount: '10', evidence: evidence(mint, 'provider:fill:input') },
                { role: 'output' as const, mint: outputMint, amount: '20', evidence: evidence(outputMint, 'provider:fill:output') },
            ],
        };
        expect(assetClaimSchema.parse(claim).parts).toHaveLength(2);
        expect(() => assetClaimSchema.parse({
            ...claim,
            parts: [claim.parts[0], { ...claim.parts[1], evidence: claim.parts[0].evidence }],
        })).toThrow(/distinct evidence/);
        expect(() => assetClaimSchema.parse({
            ...claim,
            parts: [claim.parts[0], {
                ...claim.parts[1],
                evidence: { ...claim.parts[1].evidence, signature: '6'.repeat(88) },
            }],
        })).toThrow(/one provider document/);
        expect(() => assetClaimSchema.parse({
            ...claim,
            parts: [claim.parts[0], {
                ...claim.parts[1],
                evidence: { ...claim.parts[1].evidence, payloadHash: 'b'.repeat(64) },
            }],
        })).toThrow(/one provider document/);
    });

    it('atomically replays a multi-mint provider claim', async () => {
        let evidenceNo = 0;
        const obligationId = '50000000-0000-4000-8000-000000000002';
        const db = vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('INSERT INTO asset_evidence')) {
                evidenceNo += 1;
                return result([evidenceRow(params, { id: `40000000-0000-4000-8000-00000000000${evidenceNo}` })]);
            }
            if (sql.includes('INSERT INTO asset_obligations')) {
                return result([{
                    id: obligationId,
                    req_hash: params[2],
                    claim_ver: params[14],
                    claim_count: params[15],
                    claim_hash: params[16],
                }]);
            }
            if (sql.includes('INSERT INTO asset_claim_parts')) return result([{ obligation_id: obligationId }]);
            throw new Error(`Unexpected SQL: ${sql}`);
        }) as unknown as DbQuery;
        const tx = async <T>(work: (query: DbQuery) => Promise<T>) => work(db);
        const ledger = new AssetLedger(db, tx);
        const providerEvidence = (partMint: string, sourceKey: string) => ({
            effectKey: 'provider:jupiter:effect:claim-2', orderId,
            cluster: 'mainnet-beta' as const, walletAddress: wallet, vaultAddress: vault,
            mint: partMint, source: 'provider' as const, sourceKey, signature,
            payloadHash: providerHash, payload: providerDoc,
        });

        await expect(ledger.claim({
            obligation: {
                obligationKey: 'provider:jupiter:claim:claim-2', orderId,
                cluster: 'mainnet-beta', walletAddress: wallet, vaultAddress: vault,
                mint, kind: 'fill_unverified', amount: '10', reason: 'Awaiting chain fill',
            },
            parts: [
                { role: 'input', mint, amount: '10', evidence: providerEvidence(mint, 'provider:claim-2:input') },
                { role: 'output', mint: outputMint, amount: '20', evidence: providerEvidence(outputMint, 'provider:claim-2:output') },
            ],
        })).resolves.toBe(obligationId);
        expect(db).toHaveBeenCalledTimes(5);
    });

    it('canonicalizes entry order before computing the idempotency hash', async () => {
        const documents: Array<Record<string, any>> = [];
        const db = vi.fn(async (sql: string, params: unknown[] = []) => {
            expect(sql).toContain('post_asset_journal');
            documents.push(JSON.parse(String(params[0])));
            return result([{ id: journalId }]);
        }) as unknown as DbQuery;
        const ledger = new AssetLedger(db);

        await ledger.post(journal());
        await ledger.post(journal([...journal().entries].reverse()));

        expect(documents).toHaveLength(2);
        expect(documents[0].reqHash).toBe(documents[1].reqHash);
        expect(documents[0].entries.map((entry: Record<string, unknown>) => entry.accountId))
            .toEqual([accountA, accountB]);
        expect(documents[0].entries.map((entry: Record<string, unknown>) => entry.amount))
            .toEqual(['10', '10']);
    });

    it('rejects reversal journals outside the atomic workflow', async () => {
        const db = vi.fn(async (sql: string) => {
            if (sql.includes('SELECT kind FROM asset_journals')) return result([{ kind: 'reversal' }]);
            throw new Error(`Unexpected SQL: ${sql}`);
        }) as unknown as DbQuery;
        const tx = async <T>(work: (query: DbQuery) => Promise<T>) => work(db);
        const ledger = new AssetLedger(db, tx);
        await expect(ledger.post({
            ...journal(),
            kind: 'reversal',
            reversalOf: journalId,
        })).rejects.toMatchObject({ code: 'invalid_reversal' });
        expect(db).not.toHaveBeenCalled();

        await expect(ledger.promote(journalId, 'confirmed', chainEvidence()))
            .rejects.toMatchObject({ code: 'invalid_reversal' });
        expect(db).toHaveBeenCalledTimes(1);
    });

    it('writes chain evidence before promoting a journal', async () => {
        const calls: string[] = [];
        const db = vi.fn(async (sql: string, params: unknown[] = []) => {
            calls.push(sql);
            if (sql.includes('SELECT kind FROM asset_journals')) return result([{ kind: 'deposit' }]);
            if (sql.includes('INSERT INTO asset_chain_events')) return result([{ id: chainEventId }]);
            if (sql.includes('INSERT INTO asset_evidence')) {
                return result([evidenceRow(params)]);
            }
            if (sql.includes('set_asset_journal_state')) return result([{ changed: true }]);
            throw new Error(`Unexpected SQL: ${sql}`);
        }) as unknown as DbQuery;
        const tx = async <T>(work: (query: DbQuery) => Promise<T>) => work(db);
        const ledger = new AssetLedger(db, tx);

        await expect(ledger.promote(journalId, 'confirmed', {
            ...chainEvidence(),
            source: 'provider',
            sourceKey: 'provider:receipt',
            signature: undefined,
            slot: undefined,
            commitment: undefined,
        })).rejects.toMatchObject({ code: 'invalid_evidence' });
        expect(db).not.toHaveBeenCalled();

        await ledger.promote(journalId, 'confirmed', chainEvidence());
        expect(calls).toHaveLength(4);
        expect(calls[0]).toContain('SELECT kind FROM asset_journals');
        expect(calls[1]).toContain('INSERT INTO asset_chain_events');
        expect(calls[2]).toContain('INSERT INTO asset_evidence');
        expect(calls[3]).toContain('set_asset_journal_state');
    });

    it('rejects a payload whose canonical hash was supplied incorrectly', async () => {
        const db = vi.fn() as unknown as DbQuery;
        const tx = async <T>(work: (query: DbQuery) => Promise<T>) => work(db);
        const ledger = new AssetLedger(db, tx);
        await expect(ledger.evidence({
            effectKey: 'provider:jupiter:effect:bad-hash',
            orderId,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            vaultAddress: vault,
            mint,
            source: 'provider',
            sourceKey: 'provider:jupiter:bad-hash',
            signature,
            payloadHash: 'b'.repeat(64),
            payload: providerDoc,
        })).rejects.toMatchObject({ code: 'invalid_evidence' });
        expect(db).not.toHaveBeenCalled();
    });

    it('rejects evidence-key and obligation-clear idempotency conflicts', async () => {
        let proofParams: unknown[] = [];
        const db = vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('INSERT INTO asset_chain_events')) return result([{
                id: chainEventId,
            }]);
            if (sql.includes('INSERT INTO asset_evidence')) {
                proofParams = params;
                return result();
            }
            if (sql.includes('SELECT * FROM asset_evidence')) {
                return result([evidenceRow(proofParams, { payload_hash: 'b'.repeat(64) })]);
            }
            if (sql.includes('UPDATE asset_obligations')) return result();
            if (sql.includes('clear_evidence_id')) {
                return result([{
                    state: 'cleared',
                    clear_evidence_id: evidenceId,
                    clear_journal_id: null,
                }]);
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }) as unknown as DbQuery;
        const tx = async <T>(work: (query: DbQuery) => Promise<T>) => work(db);
        const ledger = new AssetLedger(db, tx);

        await expect(ledger.evidence(chainEvidence())).rejects.toMatchObject({
            code: 'evidence_conflict',
        });
        await expect(ledger.clear('50000000-0000-4000-8000-000000000001', {
            evidenceId: '40000000-0000-4000-8000-000000000002',
        })).rejects.toEqual(expect.objectContaining<Partial<AssetError>>({
            code: 'obligation_conflict',
        }));
    });

    it('replays migrated evidence only through its preserved legacy identity', async () => {
        const db = vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('legacy_source_key')) {
                return result([evidenceRow([
                    evidenceId, undefined, chainEvidence().effectKey, 'f'.repeat(64), orderId,
                    undefined, 'chain', `${signature}:3:1:confirmed`, 'mainnet-beta', wallet,
                    vault, mint, null, 'confirmed', signature, 42, 3, 1, payloadHash,
                    null, null, null, chainEventId,
                ], { legacy_source_key: params[1] })]);
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        }) as unknown as DbQuery;
        const tx = async <T>(work: (query: DbQuery) => Promise<T>) => work(db);
        const ledger = new AssetLedger(db, tx);

        const replayed = await ledger.evidence({
            ...chainEvidence(), vaultAddress: undefined, sourceKey: 'legacy:provider-proof',
        });
        expect(replayed).toBe(evidenceId);
        expect(db).toHaveBeenCalledTimes(1);
    });

    it('does not allow an unknown legacy key to create chain evidence', async () => {
        const db = vi.fn(async () => result()) as unknown as DbQuery;
        const tx = async <T>(work: (query: DbQuery) => Promise<T>) => work(db);
        const ledger = new AssetLedger(db, tx);

        await expect(ledger.evidence({
            ...chainEvidence(), sourceKey: 'legacy:unknown',
        })).rejects.toMatchObject({ code: 'evidence_conflict' });
        expect(db).toHaveBeenCalledTimes(1);
    });
});
