import type { NormalizedTradeEvent } from '../../types';
import { Cardinality, cardinalityExactLimit, type StoredCardinality } from './cardinality';
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

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;

const safeCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const safeTime = (value: unknown): value is number =>
    safeCount(value) && value <= 8_640_000_000_000_000;

const hasKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
    Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

const textList = (value: unknown): value is string[] => Array.isArray(value)
    && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 256)
    && new Set(value).size === value.length;

const exactCardinality = (value: unknown, limit: number): Cardinality => {
    const stored = recordOf(value);
    if (!stored
        || !hasKeys(stored, ['mode', 'values'])
        || stored.mode !== 'exact'
        || !textList(stored.values)
        || stored.values.length > limit) {
        throw new Error('Invalid exact rolling cardinality');
    }
    for (let index = 1; index < stored.values.length; index += 1) {
        if (stored.values[index - 1] >= stored.values[index]) {
            throw new Error('Exact rolling cardinality is not canonical');
        }
    }
    return new Cardinality({ mode: 'exact', values: stored.values });
};

const storedCardinality = (value: unknown, limit: number): Cardinality => {
    const stored = recordOf(value);
    if (stored?.mode === 'exact') return exactCardinality(value, Math.min(limit, cardinalityExactLimit));
    if (!stored
        || !hasKeys(stored, ['mode', 'data'])
        || stored.mode !== 'hll'
        || typeof stored.data !== 'string'
        || limit <= cardinalityExactLimit) {
        throw new Error('Invalid rolling cardinality');
    }
    const cardinality = new Cardinality({ mode: 'hll', data: stored.data });
    if (cardinality.result().value === 0) throw new Error('Empty rolling cardinality sketch');
    return cardinality;
};

const legacyCardinality = (value: unknown, limit: number): Cardinality => {
    if (!textList(value) || value.length > limit) throw new Error('Invalid legacy rolling cardinality');
    const result = new Cardinality();
    for (const item of value) result.add(item);
    return result;
};

export class RollingMetricBook {
    private readonly windows = emptyWindows();

    constructor(readonly tokenMint: string, private revision = 0) {}

    static hydrate(value: unknown): RollingMetricBook {
        const snapshot = recordOf(value);
        const windows = recordOf(snapshot?.windows);
        if (!snapshot
            || !hasKeys(snapshot, ['version', 'revision', 'tokenMint', 'windows'])
            || (snapshot.version !== 1 && snapshot.version !== 2)
            || typeof snapshot.tokenMint !== 'string'
            || snapshot.tokenMint.length === 0
            || snapshot.tokenMint.length > 128
            || !safeCount(snapshot.revision)
            || !windows
            || !hasKeys(windows, windowNames)
            || windowNames.some((name) => !Array.isArray(windows[name]))) {
            throw new Error('Unsupported rolling metric snapshot');
        }
        const book = new RollingMetricBook(snapshot.tokenMint, snapshot.revision);
        for (const name of windowNames) {
            let priorStart = -1;
            for (const candidate of windows[name] as unknown[]) {
                const stored = recordOf(candidate);
                if (!stored
                    || !hasKeys(stored, snapshot.version === 1
                        ? ['startMs', 'volumeUsd', 'buyCount', 'sellCount', 'txCount', 'buyers', 'sellers']
                        : ['startMs', 'volumeMicroUsd', 'buyCount', 'sellCount', 'txCount', 'buyers', 'sellers'])
                    || !safeTime(stored.startMs)
                    || (snapshot.version === 2 && stored.startMs % BUCKET_MS[name] !== 0)
                    || stored.startMs <= priorStart
                    || !safeCount(stored.buyCount)
                    || !safeCount(stored.sellCount)
                    || !safeCount(stored.txCount)
                    || stored.txCount === 0
                    || stored.buyCount + stored.sellCount !== stored.txCount
                    || stored.txCount > snapshot.revision) {
                    throw new Error(`Invalid ${name} rolling metric bucket`);
                }
                if (snapshot.version === 1
                    && (typeof stored.volumeUsd !== 'number'
                        || !Number.isFinite(stored.volumeUsd)
                        || stored.volumeUsd < 0)) {
                    throw new Error(`Invalid ${name} rolling volume`);
                }
                const volumeMicroUsd = snapshot.version === 1
                    ? Math.round(stored.volumeUsd as number * 1_000_000)
                    : stored.volumeMicroUsd;
                if (!safeCount(volumeMicroUsd)) throw new Error(`Invalid ${name} rolling volume`);
                const buyers = snapshot.version === 1
                    ? legacyCardinality(stored.buyers, stored.buyCount)
                    : storedCardinality(stored.buyers, stored.buyCount);
                const sellers = snapshot.version === 1
                    ? legacyCardinality(stored.sellers, stored.sellCount)
                    : storedCardinality(stored.sellers, stored.sellCount);
                priorStart = stored.startMs;
                book.windows[name].set(stored.startMs, {
                    startMs: stored.startMs,
                    volumeMicroUsd,
                    buyCount: stored.buyCount,
                    sellCount: stored.sellCount,
                    txCount: stored.txCount,
                    buyers,
                    sellers,
                });
            }
        }
        return book;
    }

    clone(): RollingMetricBook {
        return RollingMetricBook.hydrate(this.serialize());
    }

    add(trade: NormalizedTradeEvent, nowMs: number): boolean {
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

    metrics(nowMs: number): RollingWindowMetrics {
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
