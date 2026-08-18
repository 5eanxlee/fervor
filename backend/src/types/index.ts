import type { AlertThresholdType, AlertWindow } from './alerts';
import type { MetricQuality } from './marketData';

export interface User {
    id: string;
    wallet_address: string;
    email?: string;
    telegram_chat_id?: string;
    discord_user_id?: string;
    created_at: Date;
    updated_at: Date;
}

export interface TokenAlert {
    id: string;
    user_id: string;
    token_address: string;
    token_name?: string;
    token_symbol?: string;
    threshold_type: AlertThresholdType;
    threshold_value: number;
    condition: 'above' | 'below';
    notification_type: 'telegram' | 'discord';
    is_active: boolean;
    is_triggered: boolean;
    generation: number;
    triggered_at?: Date;
    created_at: Date;
    updated_at: Date;
}

export interface MonitoredToken {
    token_address: string;
    token_name?: string | null;
    token_symbol?: string | null;
    active_alert_count: number;
    shard_id: number;
    shard_count: number;
    status: 'active' | 'paused' | 'disabled';
    last_subscribed_at?: Date;
    last_tick_at?: Date;
    created_at: Date;
    updated_at: Date;
}

export interface FeedTick {
    tokenAddress: string;
    signature: string;
    slot: number;
    blockTime: number;
    price?: number;
    marketCap?: number;
    liquidity?: number;
    volume?: Partial<Record<AlertWindow, number>>;
    buyCount?: Partial<Record<AlertWindow, number>>;
    sellCount?: Partial<Record<AlertWindow, number>>;
    txCount?: Partial<Record<AlertWindow, number>>;
    usdValue: number;
    baseAmount?: string;
    swapType?: 'buy' | 'sell';
    sourceExchange?: string;
    observationSource?: import('./marketData').MarketSource;
    inputContract?: 'fervor-market-input-v1';
    receivedAt: string;
    sourceEventId?: string;
    observedAt?: string;
    priceObservedAt?: string;
    commitment?: 'processed' | 'confirmed' | 'finalized';
    confidence?: number;
    stale?: boolean;
    metricSource?: 'fervor_engine';
    metricVersion?: string;
    metricRevision?: number;
    metricQuality?: Partial<Record<'price' | 'market_cap' | 'fdv' | 'liquidity' | 'rolling' | 'supply', MetricQuality>>;
}

export * from './marketData';
export * from './alerts';
export * from './amount';
export * from './assets';
export * from './execution';
export * from './orders';
export * from './orderActions';
export * from './wallets';

export interface AlertEvent {
    id: string;
    alert_id: string;
    user_id: string;
    token_address: string;
    threshold_type: AlertThresholdType;
    threshold_value: number;
    condition: 'above' | 'below';
    current_value: number;
    notification_type: 'telegram' | 'discord';
    idempotency_key: string;
    created_at: Date;
}

export interface AlertNotificationJob {
    alertEventId: string;
    alertId: string;
    userId: string;
    tokenAddress: string;
    currentValue: number;
    notificationType: 'telegram' | 'discord';
    idempotencyKey: string;
    triggeredAt: string;
}

export interface AlertCandidate {
    alertId: string;
    userId: string;
    tokenAddress: string;
    thresholdType: AlertThresholdType;
    thresholdValue: number;
    condition: 'above' | 'below';
    currentValue: number;
    notificationType: 'telegram' | 'discord';
    signature: string;
    slot?: number;
    sourceEventId?: string;
    observedAt: string;
    receivedAt: string;
    matchedAt: string;
    idempotencyKey: string;
    engineVersion: string;
    alertGeneration: number;
    basisCommitment?: 'processed' | 'confirmed' | 'finalized';
    metricConfidence: number;
    metricEstimated: boolean;
    metricVersion: string;
    metricRevision?: number;
}

export interface TokenData {
    address: string;
    name: string;
    symbol: string;
    price: number;
    market_cap?: number;
    fdv?: number;
    liquidity_usd?: number;
    stale?: boolean;
    source?: string;
    observed_at?: Date | string;
    logo?: string;
    last_updated: Date;
}

export interface TokenMetadata {
    mint: string;
    standard: string;
    name: string;
    symbol: string;
    logo: string;
    decimals: number;
    metadataUri: string;
    fullyDilutedValue?: string;
    totalSupply: string;
    totalSupplyFormatted: string;
    links?: {
        website?: string;
        twitter?: string;
        telegram?: string;
    };
    description: string | null;
    isVerifiedContract?: boolean;
    possibleSpam?: boolean;
}

export interface TokenHolder {
    owner: string;
    amount: number;
    amountUsd?: number;
    supplyPercent?: number;
}

export interface TokenHolders {
    items: TokenHolder[];
    totalSupply?: number;
    top10Percent?: number;
    source: 'helius';
}

export interface TokenPair {
    tokenAddress: string;
    tokenName: string;
    tokenSymbol: string;
    tokenLogo: string;
    tokenDecimals: string;
    pairTokenType: string;
    liquidityUsd: number;
}

export interface TokenPairData {
    exchangeAddress: string;
    exchangeName: string;
    exchangeLogo: string;
    pairLabel: string;
    pairAddress: string;
    usdPrice: number;
    usdPrice24hrPercentChange: number;
    usdPrice24hrUsdChange: number;
    liquidityUsd: number;
    baseToken: string;
    quoteToken: string;
    pair: TokenPair[];
}

export interface TokenPairsResponse {
    cursor?: string;
    pageSize: number;
    page: number;
    pairs: TokenPairData[];
}

export interface NotificationQueue {
    id: string;
    alert_id: string;
    type: 'telegram' | 'discord';
    recipient: string;
    subject: string;
    message: string;
    status: 'pending' | 'sent' | 'failed';
    attempts: number;
    created_at: Date;
    sent_at?: Date;
}

export interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    message?: string;
    error?: string;
}

import { Request } from 'express';

export interface AuthRequest extends Request {
    user?: User;
}
