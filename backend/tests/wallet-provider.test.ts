import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { HeliusWalletProvider } from '../src/services/wallets/heliusWalletProvider';
import { WalletProviderError } from '../src/services/wallets/provider';

const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
const originalKey = env.HELIUS_API_KEY;

afterEach(() => {
    env.HELIUS_API_KEY = originalKey;
    vi.unstubAllGlobals();
});

describe('Helius wallet provider', () => {
    it('requests finalized full history with ATA and bounded live filters', async () => {
        env.HELIUS_API_KEY = 'test-key';
        const signature = '5'.repeat(88);
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            jsonrpc: '2.0',
            result: {
                data: [{ slot: 901, transaction: { signatures: [signature] }, meta: { err: null } }],
                paginationToken: '900:2',
            },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);

        const page = await new HeliusWalletProvider().history(wallet, {
            cursor: '901:3',
            afterSlot: 800,
        });

        expect(page).toMatchObject({
            nextCursor: '900:2',
            newestSignature: signature,
            newestSlot: 901,
        });
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toContain('api-key=test-key');
        const body = JSON.parse(String(init?.body));
        expect(body.method).toBe('getTransactionsForAddress');
        expect(body.params).toEqual([wallet, expect.objectContaining({
            transactionDetails: 'full',
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
            commitment: 'finalized',
            sortOrder: 'desc',
            paginationToken: '901:3',
            filters: {
                status: 'succeeded',
                tokenAccounts: 'balanceChanged',
                slot: { gt: 800 },
            },
        })]);
    });

    it('surfaces provider rate limits with Retry-After delay', async () => {
        env.HELIUS_API_KEY = 'test-key';
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            jsonrpc: '2.0', error: { code: -32429, message: 'rate limited' },
        }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '2' } })));

        const error = await new HeliusWalletProvider().history(wallet).catch((value) => value);
        expect(error).toBeInstanceOf(WalletProviderError);
        expect(error).toMatchObject({
            code: 'provider_rate_limited',
            retryable: true,
            retryAfterMs: 2000,
        });
    });
});
