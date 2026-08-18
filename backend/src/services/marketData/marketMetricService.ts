import crypto from 'crypto';
import { FeedTick, MetricQuality, NormalizedMarketState, NormalizedTradeEvent } from '../../types';
import { MarketEventStorageService } from './marketEventStorageService';
import { MarketMetricRepository, MetricBase } from './marketMetricRepository';
import { stableHash } from './hash';
import { RollingMetricBook } from './rollingMetricBook';
import { redisStreams, STREAMS, tickStream } from '../redisStreamService';
import { env } from '../../config/env';
import { deriveFervorMetrics, fervorInputContract, fervorMetricVersion } from './metricEngine';
import { FervorInputSource, marketInputs } from './marketInputService';

export interface MetricProjectOptions {
    nowMs?: number;
    publish?: boolean;
    loadInputs?: boolean;
}

const validTrade = (trade: NormalizedTradeEvent): boolean => Boolean(
    trade.kind === 'trade'
    && /^[0-9a-f]{64}$/.test(trade.idempotencyKey)
    && trade.tokenMint
    && trade.sourceEventId
    && typeof trade.priceUsd === 'number'
    && Number.isFinite(trade.priceUsd)
    && trade.priceUsd > 0
    && typeof trade.usdAmount === 'number'
    && Number.isFinite(trade.usdAmount)
    && trade.usdAmount > 0
    && (trade.side === 'buy' || trade.side === 'sell')
    && trade.confidence >= 0
    && trade.confidence <= 1
    && !trade.stale
);

const inputHash = (trade: NormalizedTradeEvent): string => crypto.createHash('sha256').update(JSON.stringify([
    trade.idempotencyKey,
    trade.source,
    trade.sourceEventId,
    trade.tokenMint,
    trade.poolAddress ?? null,
    trade.protocol ?? null,
    trade.maker ?? null,
    trade.side,
    trade.tokenAmount ?? null,
    trade.quoteMint ?? null,
    trade.quoteAmount ?? null,
    trade.tokenAmountRaw ?? null,
    trade.quoteAmountRaw ?? null,
    trade.tokenDecimals ?? null,
    trade.quoteDecimals ?? null,
    trade.solAmount ?? null,
    trade.priceSol ?? null,
    trade.priceQuote ?? null,
    trade.priceUsd,
    trade.usdAmount,
    trade.usdSource ?? null,
    trade.usdObservedAt ?? null,
    trade.usdBlockId ?? null,
    trade.signature ?? null,
    trade.slot ?? null,
    trade.instructionIndex ?? null,
    trade.eventIndex ?? null,
    trade.programId ?? null,
    trade.route ?? null,
    trade.quoteKind ?? null,
    trade.decodeVersion ?? null,
    trade.computeUnits ?? null,
    trade.observedAt,
    trade.confidence,
    trade.stale,
    trade.commitment ?? null,
])).digest('hex');

const isLater = (trade: NormalizedTradeEvent, base: MetricBase): boolean => {
    if (!base.latestObservedAt) return true;
    const time = Date.parse(trade.observedAt) - Date.parse(base.latestObservedAt);
    if (time !== 0) return time > 0;
    const slot = trade.slot ?? -1;
    const latestSlot = base.latestSlot ?? -1;
    if (slot !== latestSlot) return slot > latestSlot;
    return trade.idempotencyKey > (base.latestEventKey || '');
};

const combineQuality = (left: MetricQuality, right?: MetricQuality): MetricQuality => {
    if (!right) return { ...left, confidence: 0, stale: true, estimated: true };
    return {
        sourceEventId: stableHash([left.sourceEventId, right.sourceEventId]),
        observedAt: Date.parse(left.observedAt) <= Date.parse(right.observedAt)
            ? left.observedAt
            : right.observedAt,
        confidence: Math.min(left.confidence, right.confidence),
        stale: left.stale || right.stale,
        estimated: left.estimated || right.estimated,
        commitment: left.commitment,
    };
};

export class MarketMetricService {
    constructor(
        private readonly inputs: FervorInputSource = marketInputs,
        private readonly repository = new MarketMetricRepository(),
        private readonly storage = new MarketEventStorageService()
    ) {}

    async project(
        trade: NormalizedTradeEvent,
        options: MetricProjectOptions = {}
    ): Promise<'committed' | 'duplicate'> {
        const nowMs = options.nowMs ?? Date.now();
        if (!validTrade(trade)) throw new Error('Trade is not eligible for metric projection');
        const inputs = options.loadInputs === false ? null : await this.inputs.get(trade.tokenMint);
        const empty = new RollingMetricBook(trade.tokenMint).serialize();
        const stored = await this.repository.apply(
            {
                eventKey: trade.idempotencyKey,
                inputHash: inputHash(trade),
                tokenMint: trade.tokenMint,
                sourceEventId: trade.sourceEventId,
                slot: trade.slot,
                observedAt: trade.observedAt,
            },
            empty,
            (base) => {
                const book = RollingMetricBook.hydrate(base.rollup);
                if (!book.add(trade, nowMs)) throw new Error('Trade is outside the rolling metric horizon');
                const rollup = book.serialize();
                const rolling = book.metrics(nowMs);
                const prior = base.state;
                const later = isLater(trade, base) || !prior?.priceUsd;
                const priceUsd = later ? trade.priceUsd : prior!.priceUsd;
                const priceSol = later ? trade.priceSol : prior?.priceSol;
                const totalSupply = inputs?.supply?.totalSupply ?? prior?.totalSupply;
                const supplyPolicy = inputs?.supply?.supplyPolicy ?? prior?.supplyPolicy;
                const circulatingSupply = inputs?.supply?.supplyPolicy
                    ? inputs.supply.circulatingSupply
                    : prior?.supplyPolicy
                        ? prior.circulatingSupply
                        : undefined;
                const liquidityUsd = inputs?.liquidity?.liquidityUsd ?? prior?.liquidityUsd;
                const derived = deriveFervorMetrics({
                    priceUsd,
                    totalSupply,
                    circulatingSupply,
                    supplyPolicy,
                    liquidityUsd,
                });
                const latestObservedAt = later ? trade.observedAt : base.latestObservedAt!;
                const latestSlot = later ? trade.slot ?? null : base.latestSlot;
                const latestEventKey = later ? trade.idempotencyKey : base.latestEventKey!;
                const priceSourceEventId = later
                    ? stableHash([trade.sourceEventId, trade.usdSource, trade.usdBlockId, trade.usdObservedAt])
                    : prior?.priceSourceEventId || prior?.sourceEventId || trade.sourceEventId;
                const priceQuality = later ? {
                    sourceEventId: priceSourceEventId,
                    observedAt: trade.observedAt,
                    confidence: trade.confidence,
                    stale: trade.stale,
                    estimated: Boolean(trade.usdSource),
                    commitment: trade.commitment,
                } : prior?.metricQuality?.price || {
                    sourceEventId: prior?.priceSourceEventId || trade.sourceEventId,
                    observedAt: latestObservedAt,
                    confidence: prior!.confidence,
                    stale: prior!.stale,
                    estimated: true,
                };
                const supplyQuality = inputs?.supply ? {
                    sourceEventId: inputs.supply.sourceEventId,
                    observedAt: inputs.supply.observedAt,
                    confidence: inputs.supply.confidence,
                    stale: inputs.supply.stale,
                    estimated: true,
                } : prior?.metricQuality?.supply;
                const liquidityQuality = inputs?.liquidity ? {
                    sourceEventId: inputs.liquidity.sourceEventId,
                    observedAt: inputs.liquidity.observedAt,
                    confidence: inputs.liquidity.confidence,
                    stale: inputs.liquidity.stale,
                    estimated: false,
                } : prior?.metricQuality?.liquidity;
                const rollingQuality = {
                    sourceEventId: trade.sourceEventId,
                    observedAt: trade.observedAt,
                    confidence: trade.confidence,
                    stale: trade.stale,
                    estimated: true,
                    commitment: trade.commitment,
                };
                const state: NormalizedMarketState = {
                    kind: 'market_state',
                    source: derived.metricSource,
                    observationSource: later ? trade.source : prior!.observationSource,
                    inputContract: inputs?.contract ?? prior?.inputContract ?? fervorInputContract,
                    sourceEventId: `metric:${trade.sourceEventId}`,
                    idempotencyKey: stableHash([trade.idempotencyKey, fervorMetricVersion]),
                    metricSource: derived.metricSource,
                    metricVersion: derived.metricVersion,
                    tokenMint: trade.tokenMint,
                    poolAddress: later ? trade.poolAddress : prior?.poolAddress,
                    protocol: later ? trade.protocol : prior?.protocol,
                    priceUsd,
                    priceSol,
                    marketCapUsd: derived.marketCapUsd,
                    fdvUsd: derived.fdvUsd,
                    liquidityUsd: derived.liquidityUsd,
                    totalSupply,
                    circulatingSupply,
                    supplyPolicy,
                    volumeUsd: rolling.volumeUsd,
                    buyCount: rolling.buyCount,
                    sellCount: rolling.sellCount,
                    txCount: rolling.txCount,
                    uniqueBuyers: rolling.uniqueBuyers,
                    uniqueSellers: rolling.uniqueSellers,
                    uniqueExact: rolling.uniqueExact,
                    uniqueErrorPct: rolling.uniqueErrorPct,
                    slot: trade.slot,
                    signature: trade.signature,
                    observedAt: latestObservedAt,
                    receivedAt: new Date(nowMs).toISOString(),
                    confidence: later ? trade.confidence : prior!.confidence,
                    stale: Boolean(!later && prior?.stale),
                    commitment: trade.commitment,
                    metricRevision: rollup.revision,
                    priceSourceEventId: later
                        ? priceSourceEventId
                        : prior?.priceSourceEventId || prior?.sourceEventId,
                    priceObservedAt: latestObservedAt,
                    metricQuality: {
                        price: priceQuality,
                        market_cap: circulatingSupply === undefined
                            ? undefined
                            : combineQuality(priceQuality, supplyQuality),
                        fdv: totalSupply === undefined
                            ? undefined
                            : combineQuality(priceQuality, supplyQuality),
                        liquidity: liquidityQuality,
                        supply: supplyQuality,
                        rolling: rollingQuality,
                    },
                };
                const tick: FeedTick = {
                    tokenAddress: trade.tokenMint,
                    signature: trade.signature || trade.sourceEventId,
                    slot: trade.slot || 0,
                    blockTime: Math.floor(Date.parse(trade.observedAt) / 1000),
                    price: state.priceUsd,
                    marketCap: state.marketCapUsd,
                    liquidity: state.liquidityUsd,
                    volume: state.volumeUsd,
                    buyCount: state.buyCount,
                    sellCount: state.sellCount,
                    txCount: state.txCount,
                    usdValue: trade.usdAmount!,
                    baseAmount: trade.tokenAmountRaw,
                    swapType: trade.side,
                    sourceExchange: trade.protocol || trade.source,
                    observationSource: state.observationSource,
                    inputContract: state.inputContract,
                    receivedAt: state.receivedAt,
                    sourceEventId: state.sourceEventId,
                    observedAt: trade.observedAt,
                    priceObservedAt: latestObservedAt,
                    commitment: trade.commitment,
                    confidence: state.confidence,
                    stale: state.stale,
                    metricSource: state.metricSource,
                    metricVersion: state.metricVersion,
                    metricRevision: rollup.revision,
                    metricQuality: state.metricQuality,
                };
                return {
                    rollup,
                    state,
                    tick,
                    latestObservedAt,
                    latestSlot,
                    latestEventKey,
                };
            }
        );
        if (!stored.published) {
            if (options.publish !== false) {
                await this.deliver(trade.idempotencyKey, stored.state, stored.tick);
            } else {
                await this.repository.markPublished(trade.idempotencyKey);
            }
        }
        return stored.created ? 'committed' : 'duplicate';
    }

    async redrive(limit = 250): Promise<number> {
        const pending = await this.repository.pending(limit);
        for (const event of pending) await this.deliver(event.eventKey, event.state, event.tick);
        return pending.length;
    }

    async prune(cutoff: Date, limit = 5_000): Promise<number> {
        return this.repository.prunePublished(cutoff, limit);
    }

    private async deliver(eventKey: string, state: NormalizedMarketState, tick: FeedTick): Promise<void> {
        await this.storage.persist([state]);
        await redisStreams.publishOnce(STREAMS.marketStates, `${eventKey}:state`, state, 604_800);
        await redisStreams.publishOnce(
            tickStream(env.FEED_SHARD_ID, env.FEED_SHARD_COUNT),
            `${eventKey}:tick`,
            tick,
            604_800
        );
        await this.repository.markPublished(eventKey);
    }
}
