import { query, type DbQuery } from '../../config/database';
import { env } from '../../config/env';
import { fervorInputContract } from './metricEngine';

export { fervorInputContract } from './metricEngine';

export interface FervorLiquidityInput {
    liquidityUsd: number;
    source: string;
    sourceEventId: string;
    observedAt: string;
    confidence: number;
    stale: boolean;
}

export interface FervorMarketInput {
    contract: typeof fervorInputContract;
    tokenMint: string;
    liquidity?: FervorLiquidityInput;
}

export interface FervorInputSource {
    get(tokenMint: string): Promise<FervorMarketInput | null>;
}

interface LiquidityCache {
    value: FervorLiquidityInput | null;
    fetchedMs: number;
}

const iso = (value: unknown): string => value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();

export class MarketInputService implements FervorInputSource {
    private readonly liquidity = new Map<string, LiquidityCache>();
    private readonly liquidityReads = new Map<string, Promise<FervorLiquidityInput | undefined>>();

    constructor(private readonly db: DbQuery = query) {}

    async get(tokenMint: string): Promise<FervorMarketInput | null> {
        const liquidity = await this.getLiquidity(tokenMint);
        if (!liquidity) return null;
        return { contract: fervorInputContract, tokenMint, liquidity };
    }

    private async getLiquidity(tokenMint: string): Promise<FervorLiquidityInput | undefined> {
        const cached = this.liquidity.get(tokenMint);
        if (cached && Date.now() - cached.fetchedMs <= env.LIQUIDITY_TTL_MS) {
            return cached.value || undefined;
        }
        const active = this.liquidityReads.get(tokenMint);
        if (active) return active;
        const read = this.readLiquidity(tokenMint, cached).finally(() => this.liquidityReads.delete(tokenMint));
        this.liquidityReads.set(tokenMint, read);
        return read;
    }

    private async readLiquidity(
        tokenMint: string,
        cached?: LiquidityCache
    ): Promise<FervorLiquidityInput | undefined> {
        try {
            const result = await this.db(
                `SELECT liquidity_usd, source, source_event_id, observed_at, confidence, stale
                 FROM liquidity_snapshots
                 WHERE token_mint = $1 AND liquidity_usd IS NOT NULL
                 ORDER BY observed_at DESC
                 LIMIT 1`,
                [tokenMint]
            );
            const row = result.rows[0];
            const liquidityUsd = Number(row?.liquidity_usd);
            const confidence = Number(row?.confidence);
            const valid = row
                && Number.isFinite(liquidityUsd)
                && liquidityUsd >= 0
                && Number.isFinite(confidence)
                && confidence >= 0
                && confidence <= 1;
            const value = valid ? {
                liquidityUsd,
                source: String(row.source),
                sourceEventId: String(row.source_event_id),
                observedAt: iso(row.observed_at),
                confidence,
                stale: Boolean(row.stale),
            } : null;
            this.liquidity.set(tokenMint, { value, fetchedMs: Date.now() });
            return value || undefined;
        } catch {
            return this.staleLiquidity(cached);
        }
    }

    private staleLiquidity(cached?: LiquidityCache): FervorLiquidityInput | undefined {
        if (!cached?.value || Date.now() - cached.fetchedMs > env.MARKET_MAX_STALE_MS) return undefined;
        return {
            ...cached.value,
            confidence: Math.min(cached.value.confidence, 0.5),
            stale: true,
        };
    }
}

export const marketInputs = new MarketInputService();
