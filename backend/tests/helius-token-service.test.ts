import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { HeliusTokenService } from '../src/services/heliusTokenService';

vi.mock('axios', () => ({
    default: { post: vi.fn() },
}));

const post = vi.mocked(axios.post);
const originalKey = env.HELIUS_API_KEY;

describe('Helius token reads', () => {
    beforeEach(() => {
        env.HELIUS_API_KEY = 'helius-test-key';
        post.mockReset();
    });

    afterEach(() => {
        env.HELIUS_API_KEY = originalKey;
    });

    it('normalizes fungible metadata without importing provider supply', async () => {
        post.mockResolvedValue({ data: { result: {
            interface: 'FungibleToken',
            content: {
                json_uri: 'https://metadata.example/token.json',
                links: { image: 'https://images.example/token.png', external_url: 'https://token.example' },
                metadata: { name: 'Test Token', symbol: 'TEST', description: 'Token description' },
            },
            token_info: { decimals: 6 },
        } } } as any);

        const metadata = await new HeliusTokenService().getMetadata('mint-address');
        expect(metadata).toMatchObject({
            mint: 'mint-address',
            name: 'Test Token',
            symbol: 'TEST',
            decimals: 6,
        });
        expect(metadata).not.toHaveProperty('totalSupply');
        expect(post).toHaveBeenCalledTimes(1);
        expect((post.mock.calls[0][1] as any).method).toBe('getAsset');
    });

    it('resolves owners, aggregates duplicate accounts, and derives concentration', async () => {
        post.mockImplementation(async (_url, body: any) => {
            if (body.method === 'getTokenLargestAccounts') {
                return { data: { result: { value: [
                    { address: 'account-a', uiAmountString: '100' },
                    { address: 'account-b', uiAmountString: '50' },
                    { address: 'account-c', uiAmountString: '25' },
                ] } } } as any;
            }
            return { data: { result: { value: [
                { data: { parsed: { info: { owner: 'wallet-a' } } } },
                { data: { parsed: { info: { owner: 'wallet-a' } } } },
                { data: { parsed: { info: { owner: 'wallet-b' } } } },
            ] } } } as any;
        });

        await expect(new HeliusTokenService().getHolders('mint-address', 20, 1000)).resolves.toEqual({
            items: [
                { owner: 'wallet-a', amount: 150, supplyPercent: 15 },
                { owner: 'wallet-b', amount: 25, supplyPercent: 2.5 },
            ],
            totalSupply: 1000,
            top10Percent: 17.5,
            source: 'helius',
        });
        expect(post.mock.calls.map((call) => (call[1] as any).method)).toEqual([
            'getTokenLargestAccounts',
            'getMultipleAccounts',
        ]);
    });

    it('omits concentration when Fervor supply is unavailable', async () => {
        post.mockImplementation(async (_url, body: any) => body.method === 'getTokenLargestAccounts'
            ? { data: { result: { value: [{ address: 'account-a', uiAmountString: '100' }] } } } as any
            : { data: { result: { value: [
                { data: { parsed: { info: { owner: 'wallet-a' } } } },
            ] } } } as any);

        await expect(new HeliusTokenService().getHolders('mint-address')).resolves.toEqual({
            items: [{ owner: 'wallet-a', amount: 100, supplyPercent: undefined }],
            totalSupply: undefined,
            top10Percent: undefined,
            source: 'helius',
        });
    });
});
