import { z } from 'zod';
import { PriceSource, RefPrice, SOL_MINT } from '../referencePriceService';

export const fxTapeContract = 'fervor-fx-tape-v1' as const;
export const fxPolicy = 'fervor-sol-usd-v1' as const;
export const stablePolicy = 'fervor-stable-usd-v1' as const;

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const stableMints = new Set([USDC_MINT, USDT_MINT]);
const approvedPools = new Map<string, readonly [string, string]>([
    ['58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2', ['raydium_amm_v4', USDC_MINT]],
    ['7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX', ['raydium_amm_v4', USDT_MINT]],
    ['3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv', ['raydium_clmm', USDC_MINT]],
    ['3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF', ['raydium_clmm', USDT_MINT]],
]);
const raw = z.string().regex(/^[1-9]\d*$/);
const time = z.string().datetime({ offset: true });

const poolSchema = z.object({
    poolAddress: z.string().min(32).max(44),
    protocol: z.string().min(1).max(32),
    stableMint: z.string().min(32).max(44),
    solRaw: raw,
    stableRaw: raw,
    priceMicroUsd: raw,
    observationCount: z.number().int().positive(),
    firstObservedAt: time,
    lastObservedAt: time,
    sourceEventIds: z.array(z.string().min(1).max(180)).min(1),
}).strict();

export const fxPointSchema = z.object({
    contract: z.literal(fxTapeContract),
    policy: z.literal(fxPolicy),
    sourceEventId: z.string().min(1).max(180),
    bucketStart: time,
    bucketMs: z.literal(30_000),
    observedAt: time,
    validUntil: time,
    maxAgeMs: z.literal(90_000),
    priceMicroUsd: raw,
    poolSpreadBps: z.number().int().min(0).max(200),
    quality: z.enum(['cross_pool', 'single_pool']),
    estimated: z.literal(true),
    confidence: z.number().min(0).max(1),
    inputCount: z.number().int().positive(),
    observationCount: z.number().int().positive(),
    poolCount: z.number().int().positive().max(4),
    pools: z.array(poolSchema).min(1).max(4),
    commitment: z.literal('finalized'),
}).strict();

export type FxPoint = z.infer<typeof fxPointSchema>;

interface IndexedPoint {
    value: FxPoint;
    bucketMs: number;
    observedMs: number;
    validMs: number;
    priceUsd: number;
}

const parseTime = (value: string): number => {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid FX tape timestamp: ${value}`);
    return parsed;
};

const compareRaw = (left: bigint, right: bigint): number => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
};

const indexPoint = (value: FxPoint): IndexedPoint => {
    const bucketMs = parseTime(value.bucketStart);
    const observedMs = parseTime(value.observedAt);
    const validMs = parseTime(value.validUntil);
    const priceMicroUsd = Number(value.priceMicroUsd);
    const lineage = value.pools.flatMap((pool) => pool.sourceEventIds);
    const poolObservations = value.pools.reduce((total, pool) => total + pool.observationCount, 0);
    const poolPrices = value.pools
        .map((pool) => BigInt(pool.priceMicroUsd))
        .sort(compareRaw);
    const middle = Math.floor(poolPrices.length / 2);
    const median = poolPrices.length % 2 === 1
        ? poolPrices[middle]
        : (poolPrices[middle - 1] + poolPrices[middle]) / 2n;
    const spread = (poolPrices.at(-1)! - poolPrices[0]) * 10_000n / median;
    const poolsValid = value.pools.every((pool) => {
        const firstMs = parseTime(pool.firstObservedAt);
        const lastMs = parseTime(pool.lastObservedAt);
        const approved = approvedPools.get(pool.poolAddress);
        return approved?.[0] === pool.protocol
            && approved[1] === pool.stableMint
            && pool.sourceEventIds.length === pool.observationCount
            && firstMs >= bucketMs
            && firstMs <= lastMs
            && lastMs < bucketMs + value.bucketMs
            && BigInt(pool.stableRaw) * 1_000_000_000n / BigInt(pool.solRaw) === BigInt(pool.priceMicroUsd);
    });
    const valid = Number.isSafeInteger(priceMicroUsd)
        && priceMicroUsd > 0
        && poolsValid
        && BigInt(value.priceMicroUsd) === median
        && BigInt(value.poolSpreadBps) === spread
        && bucketMs % value.bucketMs === 0
        && observedMs >= bucketMs
        && observedMs < bucketMs + value.bucketMs
        && validMs === observedMs + value.maxAgeMs
        && value.poolCount === value.pools.length
        && value.observationCount === poolObservations
        && value.inputCount >= value.observationCount
        && lineage.length === value.observationCount
        && new Set(lineage).size === lineage.length
        && observedMs === Math.max(...value.pools.map((pool) => parseTime(pool.lastObservedAt)))
        && value.quality === (value.poolCount > 1 ? 'cross_pool' : 'single_pool');
    if (!valid) throw new Error(`FX tape point violates ${fxTapeContract}: ${value.sourceEventId}`);
    return { value, bucketMs, observedMs, validMs, priceUsd: priceMicroUsd / 1_000_000 };
};

export class FxTapeSource implements PriceSource {
    private readonly points: IndexedPoint[];

    constructor(input: readonly unknown[]) {
        const ids = new Set<string>();
        let lastBucket = -Infinity;
        this.points = z.array(fxPointSchema).parse(input).map(indexPoint);
        for (const point of this.points) {
            if (point.bucketMs <= lastBucket || !ids.add(point.value.sourceEventId)) {
                throw new Error('FX tape is not strictly ordered and unique');
            }
            lastBucket = point.bucketMs;
        }
    }

    async getUsd(mint: string, at?: string): Promise<RefPrice | null> {
        if (!at) return null;
        const atMs = Date.parse(at);
        if (!Number.isFinite(atMs)) return null;
        if (stableMints.has(mint)) {
            return {
                mint,
                usdPrice: 1,
                fetchedAt: new Date(atMs).toISOString(),
                stale: false,
                source: stablePolicy,
                sourceEventId: `${stablePolicy}:${atMs}`,
                confidence: 0.95,
                estimated: true,
            };
        }
        if (mint !== SOL_MINT) return null;

        let low = 0;
        let high = this.points.length - 1;
        let found: IndexedPoint | undefined;
        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const point = this.points[middle];
            if (point.observedMs <= atMs) {
                found = point;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        if (!found || atMs > found.validMs) return null;
        return {
            mint,
            usdPrice: found.priceUsd,
            fetchedAt: found.value.observedAt,
            stale: false,
            source: found.value.policy,
            sourceEventId: found.value.sourceEventId,
            confidence: found.value.confidence,
            estimated: found.value.estimated,
        };
    }
}
