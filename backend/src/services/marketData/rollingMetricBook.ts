import { NormalizedTradeEvent } from '../../types';
import { Cardinality, StoredCardinality } from './cardinality';
import { ROLLING_WINDOWS_MS, RollingWindowMetrics, RollingWindowName } from './rollingWindowAggregator';

const BUCKET_MS: Record<RollingWindowName, number> = {
    '1m': 5_000,
    '5m': 30_000,
    '1h': 60_000,
    '6h': 5 * 60_000,
    '24h': 15 * 60_000,
};

interface MetricBucket {
    startMs: number;
    volumeMicroUsd: number;
    buyCount: number;
    sellCount: number;
    txCount: number;
    buyers: Cardinality;
    sellers: Cardinality;
}

interface StoredBucket extends Omit<MetricBucket, 'buyers' | 'sellers'> {
    buyers: StoredCardinality;
    sellers: StoredCardinality;
}

export interface StoredRollup {
    version: 2;
    revision: number;
    tokenMint: string;
    windows: Record<RollingWindowName, StoredBucket[]>;
}

interface LegacyBucket {
    startMs: number;
    volumeUsd: number;
    buyCount: number;
    sellCount: number;
    txCount: number;
    buyers: string[];
    sellers: string[];
}

interface LegacyRollup {
    version: 1;
    revision: number;
    tokenMint: string;
    windows: Record<RollingWindowName, LegacyBucket[]>;
}

const windowNames = Object.keys(ROLLING_WINDOWS_MS) as RollingWindowName[];

const emptyMetrics = (): RollingWindowMetrics => ({
    volumeUsd: { '1m': 0, '5m': 0, '1h': 0, '6h': 0, '24h': 0 },
    buyCount: { '1m': 0, '5m': 0, '1h': 0, '6h': 0, '24h': 0 },
    sellCount: { '1m': 0, '5m': 0, '1h': 0, '6h': 0, '24h': 0 },
    txCount: { '1m': 0, '5m': 0, '1h': 0, '6h': 0, '24h': 0 },
    uniqueBuyers: { '1m': 0, '5m': 0, '1h': 0, '6h': 0, '24h': 0 },
    uniqueSellers: { '1m': 0, '5m': 0, '1h': 0, '6h': 0, '24h': 0 },
    uniqueExact: { '1m': true, '5m': true, '1h': true, '6h': true, '24h': true },
    uniqueErrorPct: { '1m': 0, '5m': 0, '1h': 0, '6h': 0, '24h': 0 },
});

const emptyWindows = (): Record<RollingWindowName, Map<number, MetricBucket>> => ({
    '1m': new Map(),
    '5m': new Map(),
    '1h': new Map(),
    '6h': new Map(),
    '24h': new Map(),
});

export class RollingMetricBook {
    private readonly windows = emptyWindows();

    constructor(readonly tokenMint: string, private revision = 0) {}

    static hydrate(value: StoredRollup | LegacyRollup): RollingMetricBook {
        if (![1, 2].includes(value.version) || !value.tokenMint) {
            throw new Error('Unsupported rolling metric snapshot');
        }
        const book = new RollingMetricBook(value.tokenMint, Number(value.revision) || 0);
        for (const name of windowNames) {
            if (value.version === 1) {
                for (const stored of value.windows[name] || []) {
                    if (!Number.isFinite(stored.startMs)) continue;
                    book.windows[name].set(stored.startMs, {
                        startMs: stored.startMs,
                        volumeMicroUsd: Math.round(stored.volumeUsd * 1_000_000),
                        buyCount: stored.buyCount,
                        sellCount: stored.sellCount,
                        txCount: stored.txCount,
                        buyers: new Cardinality({ mode: 'exact', values: stored.buyers }),
                        sellers: new Cardinality({ mode: 'exact', values: stored.sellers }),
                    });
                }
            } else {
                for (const stored of value.windows[name] || []) {
                    if (!Number.isFinite(stored.startMs)) continue;
                    book.windows[name].set(stored.startMs, {
                        startMs: stored.startMs,
                        volumeMicroUsd: stored.volumeMicroUsd,
                        buyCount: stored.buyCount,
                        sellCount: stored.sellCount,
                        txCount: stored.txCount,
                        buyers: new Cardinality(stored.buyers),
                        sellers: new Cardinality(stored.sellers),
                    });
                }
            }
        }
        return book;
    }

    clone(): RollingMetricBook {
        return RollingMetricBook.hydrate(this.serialize());
    }

    add(trade: NormalizedTradeEvent, nowMs = Date.now()): boolean {
        if (trade.tokenMint !== this.tokenMint) return false;
        const observedMs = Date.parse(trade.observedAt);
        if (!Number.isFinite(observedMs)) return false;
        if (observedMs > nowMs + 30_000 || observedMs <= nowMs - ROLLING_WINDOWS_MS['24h']) return false;
        const volumeMicroUsd = Math.round((trade.usdAmount || 0) * 1_000_000);
        if (!Number.isSafeInteger(volumeMicroUsd) || volumeMicroUsd < 0) return false;

        for (const name of windowNames) {
            const bucketMs = BUCKET_MS[name];
            const startMs = Math.floor(observedMs / bucketMs) * bucketMs;
            let bucket = this.windows[name].get(startMs);
            if (!bucket) {
                bucket = {
                    startMs,
                    volumeMicroUsd: 0,
                    buyCount: 0,
                    sellCount: 0,
                    txCount: 0,
                    buyers: new Cardinality(),
                    sellers: new Cardinality(),
                };
                this.windows[name].set(startMs, bucket);
            }
            const nextVolume = bucket.volumeMicroUsd + volumeMicroUsd;
            if (!Number.isSafeInteger(nextVolume)) return false;
            bucket.volumeMicroUsd = nextVolume;
            bucket.txCount += 1;
            if (trade.side === 'buy') {
                bucket.buyCount += 1;
                if (trade.maker) bucket.buyers.add(trade.maker);
            }
            if (trade.side === 'sell') {
                bucket.sellCount += 1;
                if (trade.maker) bucket.sellers.add(trade.maker);
            }
        }
        this.prune(nowMs);
        this.revision += 1;
        return true;
    }

    metrics(nowMs = Date.now()): RollingWindowMetrics {
        this.prune(nowMs);
        const result = emptyMetrics();
        for (const name of windowNames) {
            const minMs = nowMs - ROLLING_WINDOWS_MS[name];
            const buyers = new Cardinality();
            const sellers = new Cardinality();
            for (const bucket of this.windows[name].values()) {
                if (bucket.startMs + BUCKET_MS[name] <= minMs) continue;
                result.volumeUsd[name] += bucket.volumeMicroUsd;
                result.buyCount[name] += bucket.buyCount;
                result.sellCount[name] += bucket.sellCount;
                result.txCount[name] += bucket.txCount;
                buyers.merge(bucket.buyers);
                sellers.merge(bucket.sellers);
            }
            result.volumeUsd[name] /= 1_000_000;
            const buyerCount = buyers.result();
            const sellerCount = sellers.result();
            result.uniqueBuyers[name] = buyerCount.value;
            result.uniqueSellers[name] = sellerCount.value;
            result.uniqueExact[name] = buyerCount.exact && sellerCount.exact;
            result.uniqueErrorPct[name] = Math.max(buyerCount.errorPct, sellerCount.errorPct);
        }
        return result;
    }

    serialize(): StoredRollup {
        const windows = {} as StoredRollup['windows'];
        for (const name of windowNames) {
            windows[name] = Array.from(this.windows[name].values())
                .sort((left, right) => left.startMs - right.startMs)
                .map((bucket) => ({
                    startMs: bucket.startMs,
                    volumeMicroUsd: bucket.volumeMicroUsd,
                    buyCount: bucket.buyCount,
                    sellCount: bucket.sellCount,
                    txCount: bucket.txCount,
                    buyers: bucket.buyers.serialize(),
                    sellers: bucket.sellers.serialize(),
                }));
        }
        return { version: 2, revision: this.revision, tokenMint: this.tokenMint, windows };
    }

    private prune(nowMs: number): void {
        for (const name of windowNames) {
            const minMs = nowMs - ROLLING_WINDOWS_MS[name];
            for (const [startMs] of this.windows[name]) {
                if (startMs + BUCKET_MS[name] <= minMs) this.windows[name].delete(startMs);
            }
        }
    }
}
