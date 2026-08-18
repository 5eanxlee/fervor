import { describe, expect, it } from 'vitest';
import { DbQuery } from '../src/config/database';
import { WalletIndexerService, normalizeHeliusActivity } from '../src/services/wallets/walletIndexerService';
import { WalletService } from '../src/services/wallets/walletService';

const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
const token = 'So11111111111111111111111111111111111111112';
const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('wallet tracking', () => {
    it('normalizes enhanced swap transfers into replay-safe token activity', () => {
        const activities = normalizeHeliusActivity(wallet, {
            signature: '5'.repeat(88),
            timestamp: 1_700_000_000,
            slot: 123,
            type: 'SWAP',
            source: 'JUPITER',
            tokenTransfers: [
                {
                    mint: usdc,
                    fromUserAccount: wallet,
                    toUserAccount: '8'.repeat(44),
                    rawTokenAmount: { tokenAmount: '125000000', decimals: 6 },
                },
                {
                    mint: token,
                    fromUserAccount: '9'.repeat(44),
                    toUserAccount: wallet,
                    rawTokenAmount: { tokenAmount: '500000000', decimals: 9 },
                },
            ],
        });

        expect(activities).toHaveLength(2);
        expect(activities[0]).toMatchObject({
            kind: 'swap',
            tokenMint: usdc,
            side: 'sell',
            quantityBase: '125000000',
            valueMicroUsd: '125000000',
        });
        expect(activities[1]).toMatchObject({
            kind: 'swap',
            tokenMint: token,
            side: 'buy',
            quantityBase: '500000000',
            valueMicroUsd: '125000000',
            slot: 123,
        });
    });

    it('normalizes full transaction balance deltas without floating-point arithmetic', () => {
        const activities = normalizeHeliusActivity(wallet, {
            slot: 321,
            transactionIndex: 4,
            blockTime: 1_700_000_000,
            transaction: { signatures: ['4'.repeat(88)] },
            meta: {
                err: null,
                preTokenBalances: [
                    { mint: usdc, owner: wallet, uiTokenAmount: { amount: '125000000', decimals: 6 } },
                ],
                postTokenBalances: [
                    { mint: usdc, owner: wallet, uiTokenAmount: { amount: '0', decimals: 6 } },
                    { mint: token, owner: wallet, uiTokenAmount: { amount: '500000000', decimals: 9 } },
                ],
            },
        });

        expect(activities).toEqual([
            expect.objectContaining({
                idempotencyKey: `${'4'.repeat(88)}:${usdc}:sell`,
                kind: 'swap',
                tokenMint: usdc,
                tokenDecimals: 6,
                side: 'sell',
                quantityBase: '125000000',
                valueMicroUsd: '125000000',
            }),
            expect.objectContaining({
                idempotencyKey: `${'4'.repeat(88)}:${token}:buy`,
                kind: 'swap',
                tokenMint: token,
                tokenDecimals: 9,
                side: 'buy',
                quantityBase: '500000000',
                valueMicroUsd: '125000000',
                slot: 321,
                txIndex: 4,
                commitment: 'finalized',
            }),
        ]);
    });

    it('projects native SOL balance changes as a first-class portfolio asset', () => {
        const [activity] = normalizeHeliusActivity(wallet, {
            slot: 400,
            blockTime: 1_700_000_002,
            transaction: {
                signatures: ['2'.repeat(88)],
                message: { accountKeys: [{ pubkey: wallet }] },
            },
            meta: {
                err: null,
                preBalances: ['2000000000'],
                postBalances: ['1499995000'],
                preTokenBalances: [],
                postTokenBalances: [],
            },
        });

        expect(activity).toMatchObject({
            tokenMint: token,
            tokenDecimals: 9,
            side: 'sell',
            quantityBase: '500005000',
            kind: 'transfer_out',
        });
    });

    it('keeps multi-asset balance changes but refuses to invent USD execution values', () => {
        const otherToken = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6GPHgCeqsUxBUNR';
        const activities = normalizeHeliusActivity(wallet, {
            slot: 322,
            blockTime: 1_700_000_001,
            transaction: { signatures: ['3'.repeat(88)] },
            meta: {
                err: null,
                preTokenBalances: [],
                postTokenBalances: [
                    { mint: token, owner: wallet, uiTokenAmount: { amount: '2', decimals: 9 } },
                    { mint: otherToken, owner: wallet, uiTokenAmount: { amount: '3', decimals: 5 } },
                ],
            },
        });

        expect(activities.map((activity) => ({
            mint: activity.tokenMint,
            kind: activity.kind,
            value: activity.valueMicroUsd,
        }))).toEqual([
            { mint: otherToken, kind: 'transfer_in', value: undefined },
            { mint: token, kind: 'transfer_in', value: undefined },
        ]);
    });

    it('never reconstructs raw transfer amounts from floating-point UI values', () => {
        const base = {
            signature: '6'.repeat(88),
            timestamp: 1_700_000_000,
            slot: 124,
            type: 'SWAP',
            tokenTransfers: [{
                mint: token,
                fromUserAccount: '9'.repeat(44),
                toUserAccount: wallet,
                tokenAmount: 9007199.254740993,
                rawTokenAmount: { decimals: 9 },
            }],
        };

        expect(normalizeHeliusActivity(wallet, base)).toEqual([]);
        expect(normalizeHeliusActivity(wallet, {
            ...base,
            tokenTransfers: [{
                ...base.tokenTransfers[0],
                rawTokenAmount: { tokenAmount: 9007199254740993, decimals: 9 },
            }],
        })).toEqual([]);
    });

    it('does not persist an unsafe provider slot as an approximate bigint', () => {
        const [activity] = normalizeHeliusActivity(wallet, {
            signature: '7'.repeat(88),
            timestamp: 1_700_000_000,
            slot: '9007199254740992',
            type: 'TRANSFER',
            tokenTransfers: [{
                mint: token,
                fromUserAccount: '9'.repeat(44),
                toUserAccount: wallet,
                rawTokenAmount: { tokenAmount: '1', decimals: 9 },
            }],
        });
        expect(activity.slot).toBeUndefined();
    });

    it('omits unsafe bigint slots from wallet API records', async () => {
        const now = new Date();
        const db = (async () => ({
            rows: [{
                id: 'tracked-1',
                wallet_address: wallet,
                notify: false,
                status: 'active',
                last_slot: '9007199254740992',
                created_at: now,
                updated_at: now,
            }],
            rowCount: 1,
        })) as DbQuery;

        await expect(new WalletService(db).get('user-1', 'tracked-1')).resolves.toMatchObject({
            id: 'tracked-1',
            lastSlot: undefined,
        });
    });

    it('omits unsafe bigint slots from wallet activity records', async () => {
        const now = new Date();
        const db = (async () => ({
            rows: [{
                event_key: 'activity-1',
                wallet_address: wallet,
                kind: 'swap',
                token_mint: token,
                token_decimals: 9,
                side: 'buy',
                quantity_base: '1',
                value_micro_usd: '1',
                signature: '5'.repeat(88),
                slot: '9007199254740992',
                provider: 'helius_history_v2',
                occurred_at: now,
            }],
            rowCount: 1,
        })) as DbQuery;

        await expect(new WalletService(db, db).activity('user-1', 'tracked-1')).resolves.toEqual([
            expect.objectContaining({ id: 'activity-1', slot: undefined }),
        ]);
    });

    it('serves the legacy core projection until the market replay reaches version two', async () => {
        const now = new Date();
        let coreCalls = 0;
        let marketCalled = false;
        const core = (async () => {
            coreCalls += 1;
            if (coreCalls === 1) {
                return {
                    rows: [{ source_id: 'source-1', projection_version: 1 }],
                    rowCount: 1,
                };
            }
            return {
                rows: [{
                    event_key: 'legacy-activity-1',
                    wallet_address: wallet,
                    kind: 'transfer_in',
                    token_mint: token,
                    side: 'buy',
                    quantity_base: '42',
                    signature: '5'.repeat(88),
                    provider: 'legacy',
                    occurred_at: now,
                }],
                rowCount: 1,
            };
        }) as DbQuery;
        const market = (async () => {
            marketCalled = true;
            return { rows: [], rowCount: 0 };
        }) as DbQuery;

        const activity = await new WalletService(core, market).activity('user-1', 'tracked-1');
        expect(activity[0]).toMatchObject({ id: 'legacy-activity-1', quantityBase: '42' });
        expect(marketCalled).toBe(false);
    });

    it('never rounds an unsafe provider slot into the wallet checkpoint', async () => {
        const provider = {
            name: 'helius_history_v2' as const,
            history: async () => ({
                transactions: [{ signature: '8'.repeat(88), slot: '9007199254740992', tokenTransfers: [] }],
            }),
        };
        let checkpoint: unknown;
        let checkpointSql = '';
        let calls = 0;
        const db = (async (sql: string, params: unknown[] = []) => {
            calls += 1;
            if (calls === 1) {
                return {
                    rows: [{
                        id: 'source-1',
                        wallet_address: wallet,
                        last_signature: 'older',
                        backfill_complete: true,
                    }],
                    rowCount: 1,
                };
            }
            checkpointSql = sql;
            checkpoint = params[2];
            return { rows: [], rowCount: 0 };
        }) as DbQuery;

        const projections = {
            append: async () => ({ created: false, key: 'key', payload: {}, published: true }),
            appendMany: async () => [],
            rebuild: async () => 0,
            snapshotNow: async () => undefined,
            pending: async () => [],
            markPublished: async () => undefined,
            markPublishError: async () => undefined,
        };
        await expect(new WalletIndexerService(provider, db, projections as any).runBatch(1)).resolves.toBe(1);
        expect(checkpoint).toBeNull();
        expect(checkpointSql).toContain('WHEN $3::bigint IS NULL THEN last_slot');
        expect(checkpointSql).not.toContain('COALESCE($3, 0)');
    });

    it('overlaps the checkpoint slot so a second signature in that slot is indexed', async () => {
        let request: any;
        const provider = {
            name: 'helius_history_v2' as const,
            history: async (_wallet: string, value: any) => {
                request = value;
                return { transactions: [] };
            },
        };
        let calls = 0;
        const db = (async () => {
            calls += 1;
            if (calls === 1) {
                return {
                    rows: [{
                        id: 'source-1',
                        wallet_address: wallet,
                        last_signature: 'first-signature-in-slot',
                        last_slot: 900,
                        backfill_complete: true,
                        poll_seq: 1,
                        lease_token: 'lease-1',
                    }],
                    rowCount: 1,
                };
            }
            return { rows: [], rowCount: 1 };
        }) as DbQuery;
        const projections = {
            appendMany: async () => [],
            snapshotNow: async () => undefined,
            pending: async () => [],
            markPublished: async () => undefined,
            markPublishError: async () => undefined,
        };

        await new WalletIndexerService(provider, db, projections as any).runBatch(1);
        expect(request).toMatchObject({ afterSlot: 899 });
    });
});
