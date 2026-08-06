import { AlertThresholdType, AlertWindow, FeedTick, MetricQuality } from '../types';

const windows = new Set<AlertWindow>(['1m', '5m', '1h', '6h', '24h']);

export const valueForThreshold = (type: AlertThresholdType, tick: FeedTick): number | undefined => {
    if (type === 'price') return tick.price;
    if (type === 'market_cap') return tick.marketCap;
    if (type === 'liquidity') return tick.liquidity;

    const [metric, suffix, windowValue] = type.split('_');
    const window = (windowValue || suffix) as AlertWindow;
    if (!windows.has(window)) return undefined;
    if (metric === 'volume') return tick.volume?.[window];
    if (metric === 'buy' && suffix === 'count') return tick.buyCount?.[window];
    if (metric === 'sell' && suffix === 'count') return tick.sellCount?.[window];
    if (metric === 'tx' && suffix === 'count') return tick.txCount?.[window];
    return undefined;
};

export const qualityForThreshold = (type: AlertThresholdType, tick: FeedTick): MetricQuality | undefined => {
    if (type === 'price') return tick.metricQuality?.price;
    if (type === 'market_cap') return tick.metricQuality?.market_cap;
    if (type === 'liquidity') return tick.metricQuality?.liquidity;
    return tick.metricQuality?.rolling;
};
