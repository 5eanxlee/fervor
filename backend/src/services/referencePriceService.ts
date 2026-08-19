import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { jupiterRate, rateHeader } from './jupiterRateService';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

const finiteNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

export interface RefPrice {
    mint: string;
    usdPrice: number;
    blockId?: number;
    fetchedAt: string;
    stale: boolean;
    source: string;
    sourceEventId?: string;
    confidence: number;
    estimated?: boolean;
}

export interface PriceSource {
    getUsd(mint: string, at?: string): Promise<RefPrice | null>;
}

interface CacheEntry {
    value: RefPrice;
    fetchedMs: number;
}

export class ReferencePriceService implements PriceSource {
    private readonly cache = new Map<string, CacheEntry>();
    private readonly inFlight = new Map<string, Promise<RefPrice | null>>();

    constructor(private readonly http: AxiosInstance = axios) {}

    async getSolUsd(at?: string): Promise<RefPrice | null> {
        return this.getUsd(SOL_MINT, at);
    }

    async getUsd(mint: string, _at?: string): Promise<RefPrice | null> {
        const cached = this.cache.get(mint);
        const now = Date.now();
        if (cached && now - cached.fetchedMs <= env.REF_PRICE_TTL_MS) return cached.value;

        const active = this.inFlight.get(mint);
        if (active) return active;

        const request = this.fetchUsd(mint, cached).finally(() => this.inFlight.delete(mint));
        this.inFlight.set(mint, request);
        return request;
    }

    private async fetchUsd(mint: string, cached?: CacheEntry): Promise<RefPrice | null> {
        try {
            if (await jupiterRate.reserve('main') > 0) return this.staleValue(cached);
            const baseUrl = env.JUPITER_API_URL.replace(/\/$/, '');
            const response = await this.http.get(`${baseUrl}/price/v3`, {
                params: { ids: mint },
                headers: env.JUPITER_API_KEY ? { 'x-api-key': env.JUPITER_API_KEY } : undefined,
                timeout: 5000,
            });
            await jupiterRate.observeResult('main', {
                status: response.status,
                header: (name) => rateHeader(response.headers, name),
            });
            const data = response.data?.[mint];
            const usdPrice = finiteNumber(data?.usdPrice);
            if (usdPrice === undefined || usdPrice <= 0) return this.staleValue(cached);

            const fetchedMs = Date.now();
            const value: RefPrice = {
                mint,
                usdPrice,
                blockId: finiteNumber(data?.blockId),
                fetchedAt: new Date(fetchedMs).toISOString(),
                stale: false,
                source: 'jupiter_price_v3',
                confidence: 0.8,
                estimated: true,
            };
            this.cache.set(mint, { value, fetchedMs });
            return value;
        } catch (error) {
            if (axios.isAxiosError(error) && error.response) {
                await jupiterRate.observeResult('main', {
                    status: error.response.status,
                    header: (name) => rateHeader(error.response?.headers, name),
                });
            }
            return this.staleValue(cached);
        }
    }

    private staleValue(cached?: CacheEntry): RefPrice | null {
        if (!cached || Date.now() - cached.fetchedMs > env.REF_PRICE_MAX_STALE_MS) return null;
        return { ...cached.value, stale: true, confidence: Math.min(cached.value.confidence, 0.5) };
    }
}

export const referencePrices = new ReferencePriceService();
