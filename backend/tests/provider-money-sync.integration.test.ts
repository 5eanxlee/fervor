import bs58 from 'bs58';
import { randomBytes, randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrderProvider, ProviderOrderSnapshot } from '../src/services/orders/provider';

const suite = process.env.RUN_INFRA_TESTS === 'true' ? describe : describe.skip;

suite('provider money sync infrastructure', () => {
    let query: typeof import('../src/config/database').query;
    let getClient: typeof import('../src/config/database').getClient;
    let transaction: typeof import('../src/config/database').transaction;
    let closeDatabase: typeof import('../src/config/database').closeDatabase;
    let OrderService: typeof import('../src/services/orders/orderService').OrderService;
    const userId = randomUUID();
    const orderId = randomUUID();
    const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
    const vault = '8Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
    const inputMint = 'So11111111111111111111111111111111111111112';
    const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const depositSignature = bs58.encode(Buffer.alloc(64, 8));
    const signature = bs58.encode(Buffer.alloc(64, 9));
    const providerId = `provider-${randomUUID()}`;
    const marker = randomBytes(8).toString('hex');

    const snapshot = (overrides: Partial<ProviderOrderSnapshot> = {}): ProviderOrderSnapshot => ({
        providerOrderId: providerId,
        orderType: 'single',
        updatedAt: '2026-08-03T20:00:01.000Z',
        walletAddress: wallet,
        vaultAddress: vault,
        inputMint,
        outputMint,
        inputAmount: '10',
        remainingInput: '7',
        inputUsed: '3',
        outputAmount: '9',
        fillPercent: 0.3,
        state: 'partially_filled',
        rawState: 'partial_fill_success',
        fillSignature: signature,
        moneyEvents: [
            {
                type: 'deposit', state: 'success', signature: depositSignature,
                occurredAt: '2026-08-03T19:59:59.000Z', mint: inputMint, amount: '10',
            },
            {
                type: 'fill', state: 'success', signature,
                occurredAt: '2026-08-03T20:00:00.000Z',
                mint: inputMint, amount: '3', outputMint, outputAmount: '9',
                orderContext: 'buy_above',
            },
        ],
        ...overrides,
    });

    beforeAll(async () => {
        process.env.CORE_DATABASE_URL ??= 'postgresql://fervor@localhost:55432/fervor';
        process.env.MARKET_DATABASE_URL ??= process.env.CORE_DATABASE_URL;
        process.env.DB_COLOCATED ??= 'true';
        ({ query, getClient, transaction, closeDatabase } = await import('../src/config/database'));
        ({ OrderService } = await import('../src/services/orders/orderService'));
        await query('INSERT INTO users (id, wallet_address) VALUES ($1, $2)', [userId, `MoneySync${marker}`]);
        await query(
            `INSERT INTO order_intents
             (id, user_id, provider, provider_order_id, client_order_id, request_digest,
              wallet_address, order_type, state, input_mint, output_mint, input_amount,
              trigger_mint, params, receiver_address, cluster, expires_at)
             VALUES ($1, $2, 'jupiter_trigger_v2', $3, $4, repeat('a', 64),
                     $5, 'single', 'open', $6, $7, '10', $7, '{}'::jsonb, $8,
                     'mainnet-beta', clock_timestamp() + INTERVAL '1 day')`,
            [orderId, userId, providerId, `money-sync-${marker}`, wallet, inputMint, outputMint, vault]
        );
    });

    afterAll(async () => {
        await closeDatabase?.();
    });

    it('atomically projects provider movement evidence without claiming settlement', async () => {
        const history = vi.fn().mockResolvedValue([snapshot()]);
        const provider = {
            name: 'jupiter_trigger_v2', requiresAuth: true, custody: 'third_party_vault', history,
        } as unknown as OrderProvider;
        const service = new OrderService(provider, query, transaction);

        await service.sync(userId, 'provider-token');
        await service.sync(userId, 'provider-token');

        const facts = await query(
            `SELECT order_row.state, order_row.provider_at,
                    (SELECT count(*)::int FROM asset_obligations WHERE order_id = $1) AS obligations,
                    (SELECT count(*)::int FROM asset_claim_parts part
                      JOIN asset_obligations obligation ON obligation.id = part.obligation_id
                     WHERE obligation.order_id = $1) AS parts,
                    (SELECT count(*)::int FROM asset_evidence WHERE order_id = $1) AS evidence,
                    (SELECT count(*)::int FROM asset_journals WHERE order_id = $1) AS journals,
                    (SELECT count(DISTINCT mint)::int FROM asset_circuits WHERE order_id = $1) AS blocked_mints
               FROM order_intents order_row WHERE order_row.id = $1`,
            [orderId]
        );
        expect(facts.rows[0]).toMatchObject({
            state: 'partially_filled',
            obligations: 2,
            parts: 3,
            evidence: 3,
            journals: 0,
            blocked_mints: 2,
        });
        expect(facts.rows[0].provider_at).toEqual(new Date('2026-08-03T20:00:01.000Z'));
    });

    it('rolls the projection back when a provider reuses a movement identity', async () => {
        const conflict = snapshot({
            updatedAt: '2026-08-03T20:00:02.000Z',
            remainingInput: '6', inputUsed: '4', outputAmount: '10',
            moneyEvents: [
                {
                    type: 'deposit', state: 'success', signature: depositSignature,
                    occurredAt: '2026-08-03T19:59:59.000Z', mint: inputMint, amount: '10',
                },
                {
                    type: 'fill', state: 'success', signature,
                    occurredAt: '2026-08-03T20:00:00.000Z',
                    mint: inputMint, amount: '4', outputMint, outputAmount: '10',
                    orderContext: 'buy_above',
                },
            ],
        });
        const provider = {
            name: 'jupiter_trigger_v2', requiresAuth: true, custody: 'third_party_vault',
            history: vi.fn().mockResolvedValue([conflict]),
        } as unknown as OrderProvider;
        const service = new OrderService(provider, query, transaction);

        await expect(service.sync(userId, 'provider-token')).rejects.toMatchObject({
            code: 'evidence_conflict',
        });
        const current = await query('SELECT provider_at FROM order_intents WHERE id = $1', [orderId]);
        expect(current.rows[0].provider_at).toEqual(new Date('2026-08-03T20:00:01.000Z'));
    });

    it('takes the wallet scope before reciprocal provider order locks', async () => {
        const firstId = randomUUID();
        const secondId = randomUUID();
        const firstProvider = `provider-${firstId}`;
        const secondProvider = `provider-${secondId}`;
        await query(`
            INSERT INTO order_intents (
                id, user_id, provider, provider_order_id, client_order_id, request_digest,
                wallet_address, order_type, state, input_mint, output_mint, input_amount,
                trigger_mint, params, receiver_address, cluster, expires_at
            ) VALUES
                ($1, $3, 'jupiter_trigger_v2', $4, $5, repeat('b', 64), $6,
                 'single', 'open', $7, $8, 10, $8, '{}'::jsonb, $9,
                 'mainnet-beta', clock_timestamp() + INTERVAL '1 day'),
                ($2, $3, 'jupiter_trigger_v2', $10, $11, repeat('c', 64), $6,
                 'single', 'open', $8, $7, 10, $7, '{}'::jsonb, $9,
                 'mainnet-beta', clock_timestamp() + INTERVAL '1 day')
        `, [firstId, secondId, userId, firstProvider, `scope-a-${marker}`, wallet,
            inputMint, outputMint, vault, secondProvider, `scope-b-${marker}`]);

        const history = (providerOrderId: string, input: string, output: string, byte: number) => ({
            name: 'jupiter_trigger_v2', requiresAuth: true, custody: 'third_party_vault',
            history: vi.fn().mockResolvedValue([snapshot({
                providerOrderId,
                inputMint: input,
                outputMint: output,
                remainingInput: '9',
                inputUsed: '1',
                outputAmount: '1',
                fillPercent: 0.1,
                fillSignature: bs58.encode(Buffer.alloc(64, byte)),
                moneyEvents: [
                    {
                        type: 'deposit', state: 'success',
                        signature: bs58.encode(Buffer.alloc(64, byte + 1)),
                        occurredAt: '2026-08-03T19:59:59.000Z', mint: input, amount: '10',
                    },
                    {
                        type: 'fill', state: 'success', signature: bs58.encode(Buffer.alloc(64, byte)),
                        occurredAt: '2026-08-03T20:00:00.000Z', mint: input, amount: '1',
                        outputMint: output, outputAmount: '1', orderContext: 'buy_above',
                    },
                ],
            })]),
        } as unknown as OrderProvider);

        let locked!: () => void;
        let release!: () => void;
        const ready = new Promise<void>((resolve) => { locked = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const heldTx = async <T>(work: (db: typeof query) => Promise<T>): Promise<T> => {
            const client = await getClient();
            try {
                await client.query('BEGIN');
                const db = (async (sql: string, params?: unknown[]) => {
                    const result = await client.query(sql, params);
                    if (sql.includes('SELECT * FROM order_intents WHERE id = $1 FOR UPDATE')) {
                        locked();
                        await gate;
                    }
                    return result;
                }) as typeof query;
                const result = await work(db);
                await client.query('COMMIT');
                return result;
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }
        };

        const first = new OrderService(history(firstProvider, inputMint, outputMint, 10), query, heldTx);
        const second = new OrderService(history(secondProvider, outputMint, inputMint, 12), query, transaction);
        const firstSync = first.sync(userId, 'provider-token');
        await ready;
        let secondSettled = false;
        const secondSync = second.sync(userId, 'provider-token')
            .finally(() => { secondSettled = true; });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(secondSettled).toBe(false);
        release();
        await expect(Promise.all([firstSync, secondSync])).resolves.toHaveLength(2);
    }, 15_000);
});
