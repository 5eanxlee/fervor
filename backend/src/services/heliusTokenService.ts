import axios from 'axios';
import { env } from '../config/env';
import type { TokenHolders, TokenMetadata } from '../types';

interface RpcResult<T> {
    result?: T;
    error?: { code?: number; message?: string };
}

interface LargeAccount {
    address: string;
    amount: string;
    decimals: number;
    uiAmountString: string;
}

interface ParsedAccount {
    data?: {
        parsed?: {
            info?: { owner?: string };
        };
    };
}

interface Asset {
    interface?: string;
    content?: {
        json_uri?: string;
        files?: Array<{ uri?: string; cdn_uri?: string }>;
        links?: Record<string, string>;
        metadata?: {
            name?: string;
            symbol?: string;
            description?: string;
            token_standard?: string;
        };
    };
    token_info?: {
        symbol?: string;
        decimals?: number;
    };
}

const finite = (value: unknown): number | undefined => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

export class HeliusTokenService {
    static isConfigured(): boolean {
        return Boolean(env.HELIUS_API_KEY);
    }

    private endpoint(): string {
        if (!env.HELIUS_API_KEY) throw new Error('Helius token reads are not configured');
        const url = new URL(env.HELIUS_API_URL);
        url.searchParams.set('api-key', env.HELIUS_API_KEY);
        return url.toString();
    }

    private async rpc<T>(method: string, params: unknown): Promise<T> {
        const response = await axios.post<RpcResult<T>>(this.endpoint(), {
            jsonrpc: '2.0',
            id: 'fervor-token-read',
            method,
            params,
        }, {
            timeout: env.WALLET_TIMEOUT_MS,
            headers: { 'content-type': 'application/json' },
        });
        if (response.data.error || response.data.result === undefined) {
            throw new Error(response.data.error?.message || `${method} returned no result`);
        }
        return response.data.result;
    }

    async getMetadata(mint: string): Promise<TokenMetadata> {
        const asset = await this.rpc<Asset>('getAsset', {
            id: mint,
            displayOptions: { showFungible: true },
        });
        const links = asset.content?.links || {};
        const metadata = asset.content?.metadata || {};
        const file = asset.content?.files?.[0];
        const decimals = finite(asset.token_info?.decimals);

        return {
            mint,
            standard: asset.interface || metadata.token_standard || 'FungibleToken',
            name: metadata.name || 'Unknown Token',
            symbol: metadata.symbol || asset.token_info?.symbol || 'UNKNOWN',
            logo: links.image || file?.cdn_uri || file?.uri || '',
            decimals: decimals !== undefined && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255
                ? decimals
                : undefined,
            metadataUri: asset.content?.json_uri || '',
            links: {
                website: links.external_url || links.website,
                twitter: links.twitter,
                telegram: links.telegram,
            },
            description: metadata.description || null,
        };
    }

    async getHolders(mint: string, limit = 20, ownedSupply?: number): Promise<TokenHolders> {
        const cappedLimit = Math.min(20, Math.max(1, limit));
        const largest = await this.rpc<{ value: LargeAccount[] }>(
            'getTokenLargestAccounts',
            [mint, { commitment: 'confirmed' }]
        );
        const totalSupply = finite(ownedSupply);
        const usableSupply = totalSupply !== undefined && totalSupply > 0 ? totalSupply : undefined;
        const accounts = largest.value.slice(0, cappedLimit);
        if (accounts.length === 0) {
            return {
                items: [],
                totalSupply: usableSupply,
                top10Percent: usableSupply === undefined ? undefined : 0,
                source: 'helius',
            };
        }

        const owners = await this.rpc<{ value: Array<ParsedAccount | null> }>('getMultipleAccounts', [
            accounts.map((account) => account.address),
            { encoding: 'jsonParsed', commitment: 'confirmed' },
        ]);
        const byOwner = new Map<string, number>();
        accounts.forEach((account, index) => {
            const owner = owners.value[index]?.data?.parsed?.info?.owner;
            const amount = finite(account.uiAmountString);
            if (!owner || amount === undefined || amount <= 0) return;
            byOwner.set(owner, (byOwner.get(owner) || 0) + amount);
        });

        const items = [...byOwner.entries()]
            .map(([owner, amount]) => ({
                owner,
                amount,
                supplyPercent: usableSupply === undefined ? undefined : amount / usableSupply * 100,
            }))
            .sort((left, right) => right.amount - left.amount)
            .slice(0, cappedLimit);

        return {
            items,
            totalSupply: usableSupply,
            top10Percent: usableSupply === undefined
                ? undefined
                : items.slice(0, 10).reduce((sum, item) => sum + (item.supplyPercent || 0), 0),
            source: 'helius',
        };
    }
}
