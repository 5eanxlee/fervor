export type ChartValueMode = 'price' | 'market_cap';

export const CHART_TIMEFRAME_OPTIONS = [
    { id: '1s', label: '1s', menuLabel: '1 second', group: 'Seconds', seconds: 1 },
    { id: '5s', label: '5s', menuLabel: '5 seconds', group: 'Seconds', seconds: 5 },
    { id: '15s', label: '15s', menuLabel: '15 seconds', group: 'Seconds', seconds: 15 },
    { id: '30s', label: '30s', menuLabel: '30 seconds', group: 'Seconds', seconds: 30 },
    { id: '1m', label: '1m', menuLabel: '1 minute', group: 'Minutes', seconds: 60 },
    { id: '3m', label: '3m', menuLabel: '3 minutes', group: 'Minutes', seconds: 180 },
    { id: '5m', label: '5m', menuLabel: '5 minutes', group: 'Minutes', seconds: 300 },
    { id: '15m', label: '15m', menuLabel: '15 minutes', group: 'Minutes', seconds: 900 },
    { id: '30m', label: '30m', menuLabel: '30 minutes', group: 'Minutes', seconds: 1800 },
    { id: '1h', label: '1h', menuLabel: '1 hour', group: 'Hours', seconds: 3600 },
    { id: '4h', label: '4h', menuLabel: '4 hours', group: 'Hours', seconds: 14400 },
    { id: '6h', label: '6h', menuLabel: '6 hours', group: 'Hours', seconds: 21600 },
    { id: '12h', label: '12h', menuLabel: '12 hours', group: 'Hours', seconds: 43200 },
    { id: '24h', label: '24h', menuLabel: '24 hours', group: 'Hours', seconds: 86400 },
] as const;

export const CHART_TIMEFRAME_GROUPS = ['Seconds', 'Minutes', 'Hours'] as const;
export type ChartTimeframe = typeof CHART_TIMEFRAME_OPTIONS[number]['id'];

export interface ChartCandle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volumeUsd: number;
    volumeTokens: number;
    tradeCount: number;
    buyCount: number;
    sellCount: number;
    uniqueBuyers: number;
    uniqueSellers: number;
    marketCapUsd: number;
    liquidityUsd: number;
}

export interface ChartTradeMarker {
    timestamp: number;
    price: number;
    side: 'buy' | 'sell' | 'event';
    label: string;
    intensity: 'low' | 'medium' | 'high';
}

export interface ChartAlertLine {
    label: string;
    marketCapUsd: number;
    priceUsd: number;
    color: string;
}

export interface ChartDataset {
    tokenAddress: string;
    tokenSymbol: string;
    totalSupply: number;
    intervalSeconds: number;
    candles: ChartCandle[];
    markers: ChartTradeMarker[];
    alertLines: ChartAlertLine[];
    source: { mode: 'live' | 'historical_replay' };
    metrics: {
        candleCount: number;
        tradeCount: number;
        buyCount: number;
        sellCount: number;
        volume1mUsd: number;
        volume5mUsd: number;
        peakMarketCapUsd: number;
        finalMarketCapUsd: number;
        peakLiquidityUsd: number;
        finalLiquidityUsd: number;
        uniqueBuyers: number;
        uniqueSellers: number;
        durationSeconds: number;
    };
}

export function getTimeframeSeconds(timeframe: ChartTimeframe): number {
    return CHART_TIMEFRAME_OPTIONS.find(option => option.id === timeframe)?.seconds ?? 1;
}

export function getTimeframeLabel(timeframe: ChartTimeframe): string {
    return CHART_TIMEFRAME_OPTIONS.find(option => option.id === timeframe)?.label ?? '1s';
}

export function formatInterval(seconds: number): string {
    const value = Math.max(1, Math.floor(seconds));
    if (value % 86_400 === 0) return `${value / 86_400}d`;
    if (value % 3_600 === 0) return `${value / 3_600}h`;
    if (value % 60 === 0) return `${value / 60}m`;
    return `${value}s`;
}

export function latestLogicalRange(candleCount: number, compact: boolean): { from: number; to: number } {
    const rightOffset = compact ? 8 : 12;
    const visibleBars = compact ? 140 : 180;
    const to = Math.max(0, candleCount - 1) + rightOffset;
    return { from: to - visibleBars, to };
}

export function toDisplayValue(value: number, totalSupply: number, valueMode: ChartValueMode): number {
    return valueMode === 'market_cap' ? value * totalSupply : value;
}

export function formatAxisValue(value: number, valueMode: ChartValueMode): string {
    if (valueMode === 'market_cap') {
        const abs = Math.abs(value);
        const sign = value < 0 ? '-' : '';
        const compact = (scaled: number, suffix: string) => {
            const digits = scaled < 10 && Math.abs(scaled - Math.round(scaled)) >= 0.05 ? 1 : 0;
            return `${sign}${scaled.toFixed(digits)}${suffix}`;
        };
        if (abs >= 1_000_000_000) return compact(abs / 1_000_000_000, 'B');
        if (abs >= 1_000_000) return compact(abs / 1_000_000, 'M');
        if (abs >= 1_000) return compact(abs / 1_000, 'K');
        return `${sign}${Math.round(abs)}`;
    }
    return value < 0 ? `-$${formatPrice(Math.abs(value))}` : `$${formatPrice(value)}`;
}

export function formatCompact(value: number): string {
    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
    return `${sign}$${abs.toFixed(2)}`;
}

export function formatPrice(value: number): string {
    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    if (abs < 1e-12) return '0.00';
    if (abs >= 1) return `${sign}${abs.toFixed(2)}`;
    if (abs >= 0.01) return `${sign}${abs.toFixed(4)}`;
    if (abs >= 0.0001) return `${sign}${abs.toFixed(6)}`;
    return `${sign}${abs.toExponential(3)}`;
}
