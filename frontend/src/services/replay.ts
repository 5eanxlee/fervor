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
    chartPriceUsd?: number;
    chartPriceSource?: 'curve_spot';
    displayPriceUsd?: number;
    replayCursor?: number;
    supply?: {
        rawAmount: string;
        decimals: number;
        fixed: boolean;
    };
}

export interface ReplayDeltaPage {
    epoch: number;
    after: number;
    cutCursor: number;
    next: number | null;
    items: Array<{
        cursor: number;
        epoch: number;
        trade: ReplayTrade;
    }>;
}

export interface ReplayParticipant {
    wallet: string;
    boughtRaw: string;
    soldRaw: string;
    balanceRaw: string;
    pricedBuyRaw: string;
    boughtUsd: number;
    soldUsd: number;
    boughtSol: number;
    soldSol: number;
    tradeCount: number;
    buyCount: number;
    sellCount: number;
    pricedTradeCount: number;
    firstTradeAt: string;
    lastTradeAt: string;
}

export interface ReplayParticipants {
    contract: 'fervor-replay-participants-v1';
    sourceReplaySha256: string;
    runId: string;
    epoch: number;
    cutCursor: number;
    cutAt: string | null;
    tokenMint: string;
    tokenDecimals: number;
    supplyRaw: string;
    traderCount: number;
    holderCount: number;
    top10Percent: number;
    coverage: {
        source: 'verified_trade_tape';
        scope: 'observed_trade_balance';
        openingBalanceKnown: false;
        transfersIncluded: false;
        tradeCount: number;
        pricedTradeCount: number;
        priceCoverageBps: number;
    };
    items: ReplayParticipant[];
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
    && (value.chartPriceUsd === undefined || finite(value.chartPriceUsd))
    && (value.displayPriceUsd === undefined || finite(value.displayPriceUsd))
    && (value.usdAmount === undefined || finite(value.usdAmount));

export const isReplayDeltaPage = (value: unknown): value is ReplayDeltaPage => object(value)
    && Number.isSafeInteger(value.epoch) && Number(value.epoch) >= 1
    && Number.isSafeInteger(value.after) && Number(value.after) >= 0
    && Number.isSafeInteger(value.cutCursor) && Number(value.cutCursor) >= Number(value.after)
    && (value.next === null || (Number.isSafeInteger(value.next) && Number(value.next) >= Number(value.after)))
    && Array.isArray(value.items)
    && value.items.every((item) => object(item)
        && Number.isSafeInteger(item.cursor) && Number(item.cursor) >= 0
        && Number.isSafeInteger(item.epoch) && Number(item.epoch) === Number(value.epoch)
        && isReplayTrade(item.trade));

const unsigned = (value: unknown): value is string =>
    typeof value === 'string' && /^\d+$/.test(value);
const signed = (value: unknown): value is string =>
    typeof value === 'string' && /^-?\d+$/.test(value);
const count = (value: unknown): value is number =>
    Number.isSafeInteger(value) && Number(value) >= 0;

const isReplayParticipant = (value: unknown): value is ReplayParticipant => object(value)
    && typeof value.wallet === 'string' && address.test(value.wallet)
    && unsigned(value.boughtRaw) && unsigned(value.soldRaw)
    && signed(value.balanceRaw) && unsigned(value.pricedBuyRaw)
    && finite(value.boughtUsd) && value.boughtUsd >= 0
    && finite(value.soldUsd) && value.soldUsd >= 0
    && finite(value.boughtSol) && value.boughtSol >= 0
    && finite(value.soldSol) && value.soldSol >= 0
    && count(value.tradeCount) && count(value.buyCount) && count(value.sellCount)
    && count(value.pricedTradeCount)
    && typeof value.firstTradeAt === 'string' && Number.isFinite(Date.parse(value.firstTradeAt))
    && typeof value.lastTradeAt === 'string' && Number.isFinite(Date.parse(value.lastTradeAt));

export const isReplayParticipants = (value: unknown): value is ReplayParticipants => {
    if (!object(value) || !object(value.coverage) || !Array.isArray(value.items)) return false;
    return value.contract === 'fervor-replay-participants-v1'
        && typeof value.sourceReplaySha256 === 'string'
        && typeof value.runId === 'string'
        && count(value.epoch) && value.epoch >= 1
        && count(value.cutCursor)
        && (value.cutAt === null || (typeof value.cutAt === 'string'
            && Number.isFinite(Date.parse(value.cutAt))))
        && typeof value.tokenMint === 'string' && address.test(value.tokenMint)
        && count(value.tokenDecimals) && value.tokenDecimals <= 18
        && unsigned(value.supplyRaw)
        && count(value.traderCount) && count(value.holderCount)
        && finite(value.top10Percent) && value.top10Percent >= 0 && value.top10Percent <= 100
        && value.coverage.source === 'verified_trade_tape'
        && value.coverage.scope === 'observed_trade_balance'
        && value.coverage.openingBalanceKnown === false
        && value.coverage.transfersIncluded === false
        && count(value.coverage.tradeCount)
        && count(value.coverage.pricedTradeCount)
        && count(value.coverage.priceCoverageBps) && value.coverage.priceCoverageBps <= 10_000
        && value.items.length === value.traderCount
        && value.items.every(isReplayParticipant);
};

const top10Percent = (items: ReplayParticipant[], supplyRaw: string): number => {
    const top = items.map((item) => BigInt(item.balanceRaw))
        .filter((balance) => balance > BigInt(0))
        .sort((left, right) => left === right ? 0 : left > right ? -1 : 1)
        .slice(0, 10)
        .reduce((sum, balance) => sum + balance, BigInt(0));
    const supply = BigInt(supplyRaw);
    return supply === BigInt(0)
        ? 0
        : Number(top * BigInt(1_000_000) / supply) / 10_000;
};

export const advanceReplayParticipants = (
    current: ReplayParticipants,
    trades: ReplayTrade[]
): ReplayParticipants | undefined => {
    const rows = new Map(current.items.map((item) => [item.wallet, { ...item }]));
    let cursor = current.cutCursor;
    let cutAt = current.cutAt;
    let priced = current.coverage.pricedTradeCount;
    for (const trade of [...trades].sort((left, right) =>
        Number(left.replayCursor ?? 0) - Number(right.replayCursor ?? 0))) {
        if (!Number.isSafeInteger(trade.replayCursor) || trade.replayCursor! < cursor) continue;
        if (trade.replayCursor !== cursor || !trade.maker || !address.test(trade.maker)
            || !trade.tokenAmountRaw || !unsigned(trade.tokenAmountRaw)) return undefined;
        const amount = BigInt(trade.tokenAmountRaw);
        const prior = rows.get(trade.maker);
        const row: ReplayParticipant = prior ?? {
            wallet: trade.maker,
            boughtRaw: '0',
            soldRaw: '0',
            balanceRaw: '0',
            pricedBuyRaw: '0',
            boughtUsd: 0,
            soldUsd: 0,
            boughtSol: 0,
            soldSol: 0,
            tradeCount: 0,
            buyCount: 0,
            sellCount: 0,
            pricedTradeCount: 0,
            firstTradeAt: trade.observedAt,
            lastTradeAt: trade.observedAt,
        };
        const hasUsd = finite(trade.usdAmount) && trade.usdAmount! > 0;
        row.tradeCount += 1;
        row.lastTradeAt = trade.observedAt;
        if (hasUsd) {
            row.pricedTradeCount += 1;
            priced += 1;
        }
        if (trade.side === 'buy') {
            row.buyCount += 1;
            row.boughtRaw = (BigInt(row.boughtRaw) + amount).toString();
            row.boughtUsd += hasUsd ? trade.usdAmount! : 0;
            row.boughtSol += finite(trade.solAmount) && trade.solAmount! > 0 ? trade.solAmount! : 0;
            if (hasUsd) row.pricedBuyRaw = (BigInt(row.pricedBuyRaw) + amount).toString();
        } else {
            row.sellCount += 1;
            row.soldRaw = (BigInt(row.soldRaw) + amount).toString();
            row.soldUsd += hasUsd ? trade.usdAmount! : 0;
            row.soldSol += finite(trade.solAmount) && trade.solAmount! > 0 ? trade.solAmount! : 0;
        }
        row.balanceRaw = (BigInt(row.boughtRaw) - BigInt(row.soldRaw)).toString();
        rows.set(row.wallet, row);
        cursor += 1;
        cutAt = trade.observedAt;
    }
    const items = Array.from(rows.values())
        .sort((left, right) => left.wallet.localeCompare(right.wallet));
    const holderCount = items.filter((item) => BigInt(item.balanceRaw) > BigInt(0)).length;
    return {
        ...current,
        cutCursor: cursor,
        cutAt,
        traderCount: items.length,
        holderCount,
        top10Percent: top10Percent(items, current.supplyRaw),
        coverage: {
            ...current.coverage,
            tradeCount: cursor,
            pricedTradeCount: priced,
            priceCoverageBps: cursor === 0 ? 0 : Math.floor(priced * 10_000 / cursor),
        },
        items,
    };
};

export const chartPriceOf = (trade: ReplayTrade): number | undefined => {
    const value = finite(trade.displayPriceUsd)
        ? trade.displayPriceUsd
        : finite(trade.chartPriceUsd) ? trade.chartPriceUsd : trade.priceUsd;
    return finite(value) && value > 0 ? value : undefined;
};

const sourcePriceOf = (trade: ReplayTrade): number | undefined => {
    const value = finite(trade.chartPriceUsd) ? trade.chartPriceUsd : trade.priceUsd;
    return finite(value) && value > 0 ? value : undefined;
};

const weightedMedianPrice = (trades: ReplayTrade[]): number | undefined => {
    const points = trades.slice(0, 24).flatMap((trade) => {
        const price = sourcePriceOf(trade);
        if (price === undefined) return [];
        const weight = finite(trade.usdAmount) && trade.usdAmount > 0 ? trade.usdAmount : 0.01;
        return [{ price, weight }];
    }).sort((left, right) => left.price - right.price);
    const midpoint = points.reduce((sum, point) => sum + point.weight, 0) / 2;
    let weight = 0;
    for (const point of points) {
        weight += point.weight;
        if (weight >= midpoint) return point.price;
    }
    return points.at(-1)?.price;
};

export const volumePrice = (prior: number, price: number, usdAmount: number): number => {
    if (!finite(prior) || prior <= 0 || !finite(price) || price <= 0) return price;
    const logMove = Math.log(price / prior);
    if (Math.abs(logMove) <= Math.log(1.15)) return price;
    const notional = finite(usdAmount) && usdAmount > 0 ? usdAmount : 0;
    const weight = notional / (notional + 25);
    return prior * Math.exp(logMove * weight);
};

export const stabilizeReplayPrices = (
    trades: ReplayTrade[],
    initialPrice?: number
): ReplayTrade[] => {
    let prior = finite(initialPrice) && initialPrice > 0
        ? initialPrice
        : weightedMedianPrice(trades);
    return trades.map((trade) => {
        const sourcePrice = sourcePriceOf(trade);
        if (sourcePrice === undefined) return trade;
        const displayPrice = trade.chartPriceSource === 'curve_spot' || prior === undefined
            ? sourcePrice
            : volumePrice(prior, sourcePrice, Number(trade.usdAmount || 0));
        prior = displayPrice;
        return { ...trade, displayPriceUsd: displayPrice };
    });
};

export const replayTickDelay = (pending: number, usdAmount: number, quick = false): number => {
    if (quick) return 16;
    const queueSize = Number.isSafeInteger(pending) && pending > 0 ? pending : 1;
    const notional = finite(usdAmount) && usdAmount > 0 ? usdAmount : 0;
    const volumeBoost = 1 + Math.min(0.4, Math.log10(notional + 1) * 0.1);
    return Math.max(28, Math.min(110, Math.round(700 / (queueSize + 1) / volumeBoost)));
};

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
        const price = chartPriceOf(trade);
        if (price === undefined) continue;
        const observed = Date.parse(trade.observedAt);
        if (!Number.isFinite(observed)) continue;
        const timestamp = Math.floor(observed / intervalMs) * intervalMs;
        const found = next.get(timestamp);
        const volume = finite(trade.usdAmount) && trade.usdAmount >= 0 ? trade.usdAmount : 0;
        if (found && found.txCount > 0) {
            found.high = Math.max(found.high, price);
            found.low = Math.min(found.low, price);
            found.close = price;
            found.volumeUsd += volume;
            found.buyCount += trade.side === 'buy' ? 1 : 0;
            found.sellCount += trade.side === 'sell' ? 1 : 0;
            found.txCount += 1;
        } else {
            next.set(timestamp, {
                timestamp,
                open: price,
                high: price,
                low: price,
                close: price,
                volumeUsd: volume,
                buyCount: trade.side === 'buy' ? 1 : 0,
                sellCount: trade.side === 'sell' ? 1 : 0,
                txCount: 1,
            });
        }
    }
    const ordered = Array.from(next.values()).sort((left, right) => left.timestamp - right.timestamp);
    const filled: TokenCandle[] = [];
    for (const candle of ordered) {
        const previous = filled.at(-1);
        const missing = previous ? Math.round((candle.timestamp - previous.timestamp) / intervalMs) - 1 : 0;
        if (previous && missing > 0 && missing <= 120) {
            for (let index = 1; index <= missing; index += 1) {
                filled.push({
                    timestamp: previous.timestamp + intervalMs * index,
                    open: previous.close,
                    high: previous.close,
                    low: previous.close,
                    close: previous.close,
                    volumeUsd: 0,
                    buyCount: 0,
                    sellCount: 0,
                    txCount: 0,
                });
            }
        }
        filled.push(candle);
    }
    return filled.slice(-limit);
};
