import crypto from 'crypto';
import {
    FeedTick,
    FervorSupplyPolicy,
    MetricQuality,
    NormalizedMarketEvent,
    NormalizedMarketState,
    NormalizedTradeEvent,
    ProviderRawEvent,
    safeSlot,
    SourceProvenance,
    u64Text,
} from '../../types';
import { deriveFervorMetrics, fervorInputContract } from './metricEngine';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const rawU64 = (value: unknown, field: string): string | undefined => {
    if (value === undefined || value === null) return undefined;
    const parsed = u64Text(value);
    if (parsed === undefined || parsed === '0') {
        throw new TypeError(`${field} must be a positive exact u64 string`);
    }
    return parsed;
};

const optionalSlot = (value: unknown): number | undefined => {
    if (value === undefined || value === null) return undefined;
    const slot = safeSlot(value);
    if (slot === undefined) throw new TypeError('slot must be a safe nonnegative integer');
    return slot;
};

export const toFiniteNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
};

export const stableHash = (parts: Array<string | number | undefined | null>): string =>
    crypto.createHash('sha256').update(parts.map((part) => part ?? '').join(':')).digest('hex');

export const calculateMarketCapUsd = (
    priceUsd?: number,
    circulatingSupply?: number,
    supplyPolicy?: FervorSupplyPolicy
): number | undefined => deriveFervorMetrics({ priceUsd, circulatingSupply, supplyPolicy }).marketCapUsd;

export const calculateFdvUsd = (
    priceUsd?: number,
    totalSupply?: number
): number | undefined => deriveFervorMetrics({ priceUsd, totalSupply }).fdvUsd;

const provenanceFromRaw = (raw: ProviderRawEvent, confidence = raw.confidence): SourceProvenance => ({
    source: raw.provider,
    sourceEventId: raw.sourceEventId,
    slot: optionalSlot(raw.slot),
    signature: raw.signature,
    receivedAt: raw.receivedAt,
    observedAt: raw.observedAt,
    confidence,
    stale: raw.stale,
    commitment: raw.commitment,
});

const qualityFromRaw = (raw: ProviderRawEvent, estimated: boolean): MetricQuality => ({
    sourceEventId: raw.sourceEventId,
    observedAt: raw.observedAt,
    confidence: raw.confidence,
    stale: raw.stale,
    estimated,
    commitment: raw.commitment,
});

const normalizeFixtureTrade = (raw: ProviderRawEvent): NormalizedMarketEvent[] => {
    if (!isRecord(raw.payload)) return [];
    if (raw.payload.success === false) return [];
    const tokenMint = typeof raw.payload.tokenMint === 'string' ? raw.payload.tokenMint : raw.tokenMint;
    const signature = typeof raw.payload.signature === 'string' ? raw.payload.signature : raw.signature;
    if (!tokenMint || !signature) return [];

    const priceUsd = toFiniteNumber(raw.payload.priceUsd);
    const priceSol = toFiniteNumber(raw.payload.priceSol);
    const usdAmount = toFiniteNumber(raw.payload.usdAmount);
    const solAmount = toFiniteNumber(raw.payload.solAmount);
    const tokenAmount = toFiniteNumber(raw.payload.tokenAmount);
    const quoteAmount = toFiniteNumber(raw.payload.quoteAmount);
    const totalSupply = toFiniteNumber(raw.payload.totalSupply);
    const circulatingSupply = toFiniteNumber(raw.payload.circulatingSupply);
    const supplyPolicy = circulatingSupply !== undefined
        && raw.provider === 'fixture'
        ? 'fixture_supply_v1'
        : undefined;
    const derived = deriveFervorMetrics({
        priceUsd,
        totalSupply,
        circulatingSupply,
        supplyPolicy,
        liquidityUsd: toFiniteNumber(raw.payload.liquidityUsd),
    });
    const instructionIndex = toFiniteNumber(raw.payload.instructionIndex) ?? 0;
    const eventIndex = toFiniteNumber(raw.payload.eventIndex) ?? 0;
    const side = raw.payload.side === 'buy' || raw.payload.side === 'sell' ? raw.payload.side : undefined;
    const protocol = typeof raw.payload.protocol === 'string' ? raw.payload.protocol : undefined;
    const poolAddress = typeof raw.payload.poolAddress === 'string' ? raw.payload.poolAddress : raw.poolAddress;
    const provenance = {
        ...provenanceFromRaw(raw),
        signature,
    };

    return [
        {
            ...provenance,
            kind: 'trade',
            idempotencyKey: stableHash([signature, instructionIndex, eventIndex]),
            tokenMint,
            poolAddress,
            protocol,
            maker: typeof raw.payload.maker === 'string' ? raw.payload.maker : undefined,
            side,
            tokenAmount,
            quoteMint: typeof raw.payload.quoteMint === 'string' ? raw.payload.quoteMint : undefined,
            quoteAmount,
            tokenAmountRaw: rawU64(raw.payload.tokenAmountRaw, 'tokenAmountRaw'),
            quoteAmountRaw: rawU64(raw.payload.quoteAmountRaw, 'quoteAmountRaw'),
            tokenDecimals: toFiniteNumber(raw.payload.tokenDecimals),
            quoteDecimals: toFiniteNumber(raw.payload.quoteDecimals),
            solAmount,
            usdAmount,
            priceSol,
            priceUsd,
            priceQuote: toFiniteNumber(raw.payload.priceQuote),
            instructionIndex,
            eventIndex,
            programId: typeof raw.payload.programId === 'string' ? raw.payload.programId : undefined,
            route: Array.isArray(raw.payload.route)
                ? raw.payload.route.filter((item): item is string => typeof item === 'string')
                : undefined,
            quoteKind: raw.payload.quoteKind === 'wsol' || raw.payload.quoteKind === 'usdc' || raw.payload.quoteKind === 'usdt' || raw.payload.quoteKind === 'native_sol'
                ? raw.payload.quoteKind
                : undefined,
            decodeVersion: typeof raw.payload.decodeVersion === 'string' ? raw.payload.decodeVersion : undefined,
            computeUnits: toFiniteNumber(raw.payload.computeUnits),
        },
        {
            ...provenance,
            kind: 'market_state',
            idempotencyKey: stableHash([tokenMint, raw.provider, raw.observedAt.slice(0, 19)]),
            source: derived.metricSource,
            observationSource: raw.provider,
            inputContract: fervorInputContract,
            metricSource: derived.metricSource,
            metricVersion: derived.metricVersion,
            tokenMint,
            poolAddress,
            protocol,
            priceUsd,
            priceSol,
            marketCapUsd: derived.marketCapUsd,
            fdvUsd: derived.fdvUsd,
            liquidityUsd: derived.liquidityUsd,
            liquiditySol: toFiniteNumber(raw.payload.liquiditySol),
            totalSupply,
            circulatingSupply,
            supplyPolicy,
            priceSourceEventId: raw.sourceEventId,
            priceObservedAt: raw.observedAt,
            metricQuality: {
                price: priceUsd === undefined ? undefined : qualityFromRaw(raw, false),
                market_cap: derived.marketCapUsd === undefined ? undefined : qualityFromRaw(raw, true),
                fdv: derived.fdvUsd === undefined ? undefined : qualityFromRaw(raw, true),
                liquidity: derived.liquidityUsd === undefined ? undefined : qualityFromRaw(raw, false),
                supply: totalSupply === undefined ? undefined : qualityFromRaw(raw, false),
            },
            stale: priceUsd === undefined,
        },
    ];
};

const normalizeProviderMarketState = (raw: ProviderRawEvent): NormalizedMarketEvent[] => {
    if (!isRecord(raw.payload)) return [];
    const tokenMint = typeof raw.payload.tokenMint === 'string'
        ? raw.payload.tokenMint
        : typeof raw.payload.address === 'string'
            ? raw.payload.address
            : raw.tokenMint;
    if (!tokenMint) return [];

    const priceUsd = toFiniteNumber(raw.payload.priceUsd ?? raw.payload.price ?? raw.payload.usdPrice);
    const totalSupply = toFiniteNumber(raw.payload.totalSupply ?? raw.payload.total_supply);
    const circulatingSupply = toFiniteNumber(raw.payload.circulatingSupply ?? raw.payload.circulating_supply);
    const derived = deriveFervorMetrics({
        priceUsd,
        totalSupply,
        circulatingSupply,
        liquidityUsd: toFiniteNumber(raw.payload.liquidityUsd ?? raw.payload.liquidity),
    });

    return [{
        ...provenanceFromRaw(raw),
        kind: 'market_state',
        idempotencyKey: stableHash([tokenMint, raw.provider, raw.observedAt.slice(0, 19)]),
        source: derived.metricSource,
        observationSource: raw.provider,
        inputContract: fervorInputContract,
        metricSource: derived.metricSource,
        metricVersion: derived.metricVersion,
        tokenMint,
        poolAddress: raw.poolAddress,
        priceUsd,
        marketCapUsd: derived.marketCapUsd,
        fdvUsd: derived.fdvUsd,
        liquidityUsd: derived.liquidityUsd,
        totalSupply,
        circulatingSupply: undefined,
        priceSourceEventId: raw.sourceEventId,
        priceObservedAt: raw.observedAt,
        metricQuality: {
            price: priceUsd === undefined ? undefined : qualityFromRaw(raw, false),
            market_cap: derived.marketCapUsd === undefined ? undefined : qualityFromRaw(raw, true),
            fdv: derived.fdvUsd === undefined ? undefined : qualityFromRaw(raw, true),
            liquidity: derived.liquidityUsd === undefined ? undefined : qualityFromRaw(raw, false),
            supply: totalSupply === undefined ? undefined : qualityFromRaw(raw, false),
        },
        stale: priceUsd === undefined,
    }];
};

const rawWithPayload = (raw: ProviderRawEvent, payload: Record<string, unknown>, type: ProviderRawEvent['type']): ProviderRawEvent => ({
    ...raw,
    type,
    tokenMint: typeof payload.tokenMint === 'string' ? payload.tokenMint : raw.tokenMint,
    poolAddress: typeof payload.poolAddress === 'string' ? payload.poolAddress : raw.poolAddress,
    signature: typeof payload.signature === 'string' ? payload.signature : raw.signature,
    slot: payload.slot === undefined ? optionalSlot(raw.slot) : optionalSlot(payload.slot),
    payload,
});

const normalizeDecodedProviderPayload = (raw: ProviderRawEvent): NormalizedMarketEvent[] => {
    if (!isRecord(raw.payload)) return [];

    const payload = raw.payload;
    const candidates = [
        payload,
        isRecord(payload.trade) ? payload.trade : undefined,
        isRecord(payload.marketState) ? payload.marketState : undefined,
        isRecord(payload.market_state) ? payload.market_state : undefined,
        isRecord(payload.parsed) ? payload.parsed : undefined,
        isRecord(payload.decoded) ? payload.decoded : undefined,
    ].filter((item): item is Record<string, unknown> => !!item);

    const normalized: NormalizedMarketEvent[] = [];
    for (const candidate of candidates) {
        if (
            candidate.kind === 'market_state' ||
            candidate.type === 'market_state' ||
            candidate.priceUsd !== undefined ||
            candidate.marketCapUsd !== undefined ||
            candidate.market_cap !== undefined
        ) {
            normalized.push(...normalizeProviderMarketState(rawWithPayload(raw, candidate, 'market_state')));
        }

        if (
            candidate.kind === 'trade' ||
            candidate.type === 'trade' ||
            candidate.usdAmount !== undefined ||
            candidate.tokenAmount !== undefined ||
            candidate.side === 'buy' ||
            candidate.side === 'sell'
        ) {
            normalized.push(...normalizeFixtureTrade(rawWithPayload(raw, candidate, 'fixture_trade')));
        }
    }

    const seen = new Set<string>();
    return normalized.filter((event) => {
        const key = `${event.kind}:${event.idempotencyKey}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

export const normalizeProviderRawEvent = (raw: ProviderRawEvent): NormalizedMarketEvent[] => {
    if (raw.type === 'transaction' || raw.type === 'account') return normalizeDecodedProviderPayload(raw);
    if (raw.type === 'fixture_trade') return normalizeFixtureTrade(raw);
    if (raw.type === 'market_state') return normalizeProviderMarketState(raw);
    return [];
};

export const marketStateToFeedTick = (state: NormalizedMarketState): FeedTick | null => {
    if (!state.tokenMint || !state.signature && !state.sourceEventId) return null;
    const price = state.priceUsd;
    const marketCap = state.marketCapUsd;
    if (price !== undefined && !Number.isFinite(price)) return null;
    if (marketCap !== undefined && !Number.isFinite(marketCap)) return null;

    return {
        tokenAddress: state.tokenMint,
        signature: state.signature || state.sourceEventId,
        slot: state.slot || 0,
        blockTime: Math.floor(new Date(state.observedAt).getTime() / 1000),
        price,
        marketCap,
        liquidity: state.liquidityUsd,
        volume: state.volumeUsd,
        buyCount: state.buyCount,
        sellCount: state.sellCount,
        txCount: state.txCount,
        usdValue: 0,
        sourceExchange: state.protocol || state.observationSource,
        observationSource: state.observationSource,
        inputContract: state.inputContract,
        receivedAt: state.receivedAt,
        sourceEventId: state.sourceEventId,
        observedAt: state.observedAt,
        priceObservedAt: state.priceObservedAt || state.observedAt,
        commitment: state.commitment,
        confidence: state.confidence,
        stale: state.stale,
        metricSource: state.metricSource,
        metricVersion: state.metricVersion,
        metricRevision: state.metricRevision,
        metricQuality: state.metricQuality,
    };
};
