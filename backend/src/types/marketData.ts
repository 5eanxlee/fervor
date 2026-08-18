export type MarketSource = string;

export type FervorSupplyPolicy = 'fervor_mint_supply_v1';

export type NormalizedEventKind =
    | 'trade'
    | 'token'
    | 'pool'
    | 'liquidity'
    | 'market_state';

export interface SourceProvenance {
    source: MarketSource;
    sourceEventId: string;
    slot?: number;
    signature?: string;
    receivedAt: string;
    observedAt: string;
    confidence: number;
    stale: boolean;
    commitment?: 'processed' | 'confirmed' | 'finalized';
}

export interface MetricQuality {
    sourceEventId: string;
    observedAt: string;
    confidence: number;
    stale: boolean;
    estimated: boolean;
    commitment?: 'processed' | 'confirmed' | 'finalized';
}

export interface NormalizedTradeEvent extends SourceProvenance {
    kind: 'trade';
    idempotencyKey: string;
    tokenMint: string;
    poolAddress?: string;
    protocol?: string;
    maker?: string;
    side?: 'buy' | 'sell';
    tokenAmount?: number;
    quoteMint?: string;
    quoteAmount?: number;
    tokenAmountRaw?: string;
    quoteAmountRaw?: string;
    tokenDecimals?: number;
    quoteDecimals?: number;
    solAmount?: number;
    usdAmount?: number;
    priceSol?: number;
    priceUsd?: number;
    priceQuote?: number;
    usdSource?: string;
    usdObservedAt?: string;
    usdBlockId?: number;
    instructionIndex?: number;
    eventIndex?: number;
    programId?: string;
    route?: string[];
    quoteKind?: 'wsol' | 'usdc' | 'usdt' | 'native_sol';
    decodeVersion?: string;
    computeUnits?: number;
}

export interface NormalizedTokenEvent extends SourceProvenance {
    kind: 'token';
    idempotencyKey: string;
    tokenMint: string;
    decimals?: number;
    name?: string;
    symbol?: string;
    image?: string;
    metadataUri?: string;
    socials?: Record<string, string>;
    creator?: string;
    deployer?: string;
    launchpad?: string;
    lifecycleStatus?: 'created' | 'bonding' | 'migrating' | 'migrated' | 'trading' | 'unknown';
}

export interface NormalizedPoolEvent extends SourceProvenance {
    kind: 'pool';
    idempotencyKey: string;
    poolAddress: string;
    protocol: string;
    baseMint: string;
    quoteMint?: string;
    launchpad?: string;
    poolAccounts?: Record<string, string>;
    lifecycleStatus?: 'created' | 'active' | 'migrated' | 'closed' | 'unknown';
}

export interface NormalizedLiquidityEvent extends SourceProvenance {
    kind: 'liquidity';
    idempotencyKey: string;
    tokenMint: string;
    poolAddress?: string;
    protocol?: string;
    tokenReserve?: number;
    solReserve?: number;
    liquidityUsd?: number;
    liquiditySol?: number;
    changeType?: 'add' | 'remove' | 'sync' | 'unknown';
}

export interface NormalizedMarketState extends Omit<SourceProvenance, 'source'> {
    kind: 'market_state';
    idempotencyKey: string;
    source: 'fervor_engine';
    observationSource: MarketSource;
    inputContract: 'fervor-market-input-v1';
    metricSource: 'fervor_engine';
    metricVersion: string;
    tokenMint: string;
    poolAddress?: string;
    protocol?: string;
    priceUsd?: number;
    priceSol?: number;
    marketCapUsd?: number;
    fdvUsd?: number;
    liquidityUsd?: number;
    liquiditySol?: number;
    totalSupply?: number;
    circulatingSupply?: number;
    supplyPolicy?: FervorSupplyPolicy;
    volumeUsd?: Partial<Record<'1m' | '5m' | '1h' | '6h' | '24h', number>>;
    buyCount?: Partial<Record<'1m' | '5m' | '1h' | '6h' | '24h', number>>;
    sellCount?: Partial<Record<'1m' | '5m' | '1h' | '6h' | '24h', number>>;
    txCount?: Partial<Record<'1m' | '5m' | '1h' | '6h' | '24h', number>>;
    uniqueBuyers?: Partial<Record<'1m' | '5m' | '1h' | '6h' | '24h', number>>;
    uniqueSellers?: Partial<Record<'1m' | '5m' | '1h' | '6h' | '24h', number>>;
    uniqueExact?: Partial<Record<'1m' | '5m' | '1h' | '6h' | '24h', boolean>>;
    uniqueErrorPct?: Partial<Record<'1m' | '5m' | '1h' | '6h' | '24h', number>>;
    metricRevision?: number;
    priceSourceEventId?: string;
    priceObservedAt?: string;
    metricQuality?: Partial<Record<'price' | 'market_cap' | 'fdv' | 'liquidity' | 'rolling' | 'supply', MetricQuality>>;
}

export type NormalizedMarketEvent =
    | NormalizedTradeEvent
    | NormalizedTokenEvent
    | NormalizedPoolEvent
    | NormalizedLiquidityEvent
    | NormalizedMarketState;

export interface TokenMarketStateView {
    tokenMint: string;
    priceUsd?: number;
    priceSol?: number;
    marketCapUsd?: number;
    fdvUsd?: number;
    liquidityUsd?: number;
    totalSupply?: number;
    circulatingSupply?: number;
    source: MarketSource;
    observedAt: string;
    stale: boolean;
    confidence: number;
}
