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

    it('exposes an exact on-chain supply observation for the Fervor metric input contract', async () => {
        post.mockResolvedValue({ data: { result: {
            context: { slot: 1234 },
            value: {
                amount: '123456789012345',
                decimals: 6,
                uiAmountString: '123456789.012345',
            },
        } } } as any);

        await expect(new HeliusTokenService().getSupply('mint-address')).resolves.toMatchObject({
            mint: 'mint-address',
            rawAmount: '123456789012345',
            uiAmount: '123456789.012345',
            decimals: 6,
            totalSupply: 123456789.012345,
            slot: 1234,
            source: 'helius_rpc',
            stale: false,
        });
    });

    it('normalizes fungible metadata and exact supply fields', async () => {
        post.mockImplementation(async (_url, body: any) => {
            if (body.method === 'getAsset') {
                return { data: { result: {
                    interface: 'FungibleToken',
                    content: {
                        json_uri: 'https://metadata.example/token.json',
                        links: { image: 'https://images.example/token.png', external_url: 'https://token.example' },
                        metadata: { name: 'Test Token', symbol: 'TEST', description: 'Token description' },
                    },
                    creators: [{ verified: true }],
                } } } as any;
            }
            return { data: { result: { value: {
                amount: '123456789012345',
                decimals: 6,
                uiAmountString: '123456789.012345',
            } } } } as any;
        });

        await expect(new HeliusTokenService().getMetadata('mint-address')).resolves.toMatchObject({
            mint: 'mint-address',
            name: 'Test Token',
            symbol: 'TEST',
            decimals: 6,
            totalSupply: '123456789012345',
            totalSupplyFormatted: '123456789.012345',
        });
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
            if (body.method === 'getTokenSupply') {
                return { data: { result: { value: {
                    amount: '1000000000', decimals: 6, uiAmountString: '1000',
                } } } } as any;
            }
            return { data: { result: { value: [
                { data: { parsed: { info: { owner: 'wallet-a' } } } },
                { data: { parsed: { info: { owner: 'wallet-a' } } } },
                { data: { parsed: { info: { owner: 'wallet-b' } } } },
            ] } } } as any;
        });

        await expect(new HeliusTokenService().getHolders('mint-address')).resolves.toEqual({
            items: [
                { owner: 'wallet-a', amount: 150, supplyPercent: 15 },
                { owner: 'wallet-b', amount: 25, supplyPercent: 2.5 },
            ],
            totalSupply: 1000,
            top10Percent: 17.5,
            source: 'helius',
        });
    });
});
