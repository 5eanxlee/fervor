import type { TokenCandle } from './api';

export const replayControlContract = 'fervor-replay-control-command-v1' as const;

export type ReplaySpeed = 1 | 20 | 100 | 'max';
export type ReplayStatus = 'paused' | 'running' | 'complete' | 'stopped';

export interface ReplayCut {
    runId: string;
    epoch: number;
    sourceReplaySha256: string;
    cursor: number;
    total: number;
    status: ReplayStatus;
    now: string | null;
}

export interface ReplayRolling {
    volumeUsd: Record<string, number>;
    buyCount: Record<string, number>;
    sellCount: Record<string, number>;
    txCount: Record<string, number>;
}

export interface ReplayProjection {
    cursor: number;
    now: string | null;
    latestUsd: { value: number; observedAt: string } | null;
    latestSol: { value: number; observedAt: string } | null;
    rolling: ReplayRolling;
    pricedRolling: ReplayRolling;
}

export interface ReplayState {
    tokenMint: string;
    busy: boolean;
    mutating: boolean;
    failure: string | null;
    snapshot: ReplayCut;
    projection: ReplayProjection;
    paper: { modelSha256: string; orderCount: number; factCount: number };
    alerts: { modelSha256: string; definitionCount: number };
}

export interface ReplayTrade {
    kind: 'trade';
    idempotencyKey: string;
    tokenMint: string;
    observedAt: string;
    side?: 'buy' | 'sell';
    maker?: string;
    signature?: string;
    eventIndex?: number;
    tokenAmount?: number;
    tokenAmountRaw?: string;
    tokenDecimals?: number;
    solAmount?: number;
    usdAmount?: number;
    priceUsd?: number;
    supply?: {
        rawAmount: string;
        decimals: number;
        fixed: boolean;
    };
}

export type ReplayOp =
    | { op: 'play'; speed: ReplaySpeed }
    | { op: 'pause' }
    | { op: 'step' }
    | { op: 'seek'; target: number };

export type ReplayControl = {
    contract: typeof replayControlContract;
    epoch: number;
    cursor: number;
    fact: number;
} & ReplayOp;

export interface ReplayControlResult {
    control: {
        contract: 'fervor-replay-control-action-v1';
        op: ReplayControl['op'];
        applied: boolean;
        revision: { epoch: number; cursor: number; fact: number };
    };
    state: ReplayState;
}

const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const address = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const isLatest = (value: unknown): boolean => value === null || (object(value)
    && finite(value.value) && value.value > 0 && typeof value.observedAt === 'string');

const isRolling = (value: unknown): value is ReplayRolling => {
    if (!object(value)) return false;
    const numericRecord = (item: unknown): boolean => object(item)
        && Object.values(item).every((entry) => finite(entry) && entry >= 0);
    return numericRecord(value.volumeUsd) && numericRecord(value.buyCount)
        && numericRecord(value.sellCount) && numericRecord(value.txCount);
};

export const isReplayProjection = (value: unknown): value is ReplayProjection => {
    if (!object(value)) return false;
    return Number.isSafeInteger(value.cursor) && Number(value.cursor) >= 0
        && (value.now === null || typeof value.now === 'string')
        && isLatest(value.latestUsd)
        && isLatest(value.latestSol)
        && isRolling(value.rolling)
        && isRolling(value.pricedRolling);
};

export const isReplayState = (value: unknown): value is ReplayState => {
    if (!object(value) || !object(value.snapshot) || !isReplayProjection(value.projection)
        || !object(value.paper) || !object(value.alerts)) return false;
    const snapshot = value.snapshot;
    return typeof value.tokenMint === 'string' && address.test(value.tokenMint)
        && typeof value.busy === 'boolean'
        && typeof value.mutating === 'boolean'
        && (value.failure === null || typeof value.failure === 'string')
        && typeof snapshot.runId === 'string'
        && Number.isSafeInteger(snapshot.epoch) && Number(snapshot.epoch) >= 1
        && Number.isSafeInteger(snapshot.cursor) && Number(snapshot.cursor) >= 0
        && Number.isSafeInteger(snapshot.total) && Number(snapshot.total) >= Number(snapshot.cursor)
        && ['paused', 'running', 'complete', 'stopped'].includes(String(snapshot.status))
        && value.projection.cursor === snapshot.cursor
        && Number.isSafeInteger(value.paper.factCount) && Number(value.paper.factCount) >= 0;
};

export const replayFromRt = (value: unknown): ReplayState | undefined => {
    if (!object(value) || typeof value.tokenMint !== 'string'
        || !isReplayProjection(value.market) || !object(value.replay)) return undefined;
    const candidate = {
        tokenMint: value.tokenMint,
        projection: value.market,
        ...value.replay,
    };
    return isReplayState(candidate) ? candidate : undefined;
};

export const replaySlice = (
    current: ReplayState,
    value: unknown
): ReplayState | undefined => {
    if (!object(value)) return undefined;
    const candidate = { ...current, ...value };
    return isReplayState(candidate) ? candidate : undefined;
};

export const isReplayTrade = (value: unknown): value is ReplayTrade => object(value)
    && value.kind === 'trade'
    && typeof value.idempotencyKey === 'string'
    && typeof value.tokenMint === 'string' && address.test(value.tokenMint)
    && typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt))
    && (value.side === 'buy' || value.side === 'sell')
    && (value.priceUsd === undefined || finite(value.priceUsd))
    && (value.usdAmount === undefined || finite(value.usdAmount));

export const supplyOf = (trade: ReplayTrade): number | undefined => {
    const supply = trade.supply;
    if (!supply || !supply.fixed || !/^\d+$/.test(supply.rawAmount)
        || !Number.isInteger(supply.decimals) || supply.decimals < 0 || supply.decimals > 18) return undefined;
    const value = Number(supply.rawAmount) / 10 ** supply.decimals;
    return finite(value) && value > 0 ? value : undefined;
};

export const amountOf = (trade: ReplayTrade): number | undefined => {
    if (finite(trade.tokenAmount)) return trade.tokenAmount;
    if (!trade.tokenAmountRaw || !/^\d+$/.test(trade.tokenAmountRaw)
        || !Number.isInteger(trade.tokenDecimals) || trade.tokenDecimals! < 0
        || trade.tokenDecimals! > 18) return undefined;
    const value = Number(trade.tokenAmountRaw) / 10 ** trade.tokenDecimals!;
    return finite(value) ? value : undefined;
};

export const mergeCandles = (
    current: TokenCandle[],
    trades: ReplayTrade[],
    intervalSeconds: number,
    limit = 2_000
): TokenCandle[] => {
    const next = new Map(current.map((candle) => [candle.timestamp, { ...candle }]));
    const intervalMs = intervalSeconds * 1_000;
    for (const trade of trades) {
        if (!finite(trade.priceUsd) || trade.priceUsd <= 0) continue;
        const observed = Date.parse(trade.observedAt);
        if (!Number.isFinite(observed)) continue;
        const timestamp = Math.floor(observed / intervalMs) * intervalMs;
        const found = next.get(timestamp);
        const volume = finite(trade.usdAmount) && trade.usdAmount >= 0 ? trade.usdAmount : 0;
        if (found) {
            found.high = Math.max(found.high, trade.priceUsd);
            found.low = Math.min(found.low, trade.priceUsd);
            found.close = trade.priceUsd;
            found.volumeUsd += volume;
            found.buyCount += trade.side === 'buy' ? 1 : 0;
            found.sellCount += trade.side === 'sell' ? 1 : 0;
            found.txCount += 1;
        } else {
            next.set(timestamp, {
                timestamp,
                open: trade.priceUsd,
                high: trade.priceUsd,
                low: trade.priceUsd,
                close: trade.priceUsd,
                volumeUsd: volume,
                buyCount: trade.side === 'buy' ? 1 : 0,
                sellCount: trade.side === 'sell' ? 1 : 0,
                txCount: 1,
            });
        }
    }
    return Array.from(next.values())
        .sort((left, right) => left.timestamp - right.timestamp)
        .slice(-limit);
};
