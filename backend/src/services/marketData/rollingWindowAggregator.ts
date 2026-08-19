export const ROLLING_WINDOWS_MS = {
    '1m': 60_000,
    '5m': 5 * 60_000,
    '1h': 60 * 60_000,
    '6h': 6 * 60 * 60_000,
    '24h': 24 * 60 * 60_000,
} as const;

export type RollingWindowName = keyof typeof ROLLING_WINDOWS_MS;

export interface RollingWindowMetrics {
    volumeUsd: Record<RollingWindowName, number>;
    buyCount: Record<RollingWindowName, number>;
    sellCount: Record<RollingWindowName, number>;
    txCount: Record<RollingWindowName, number>;
    uniqueBuyers: Record<RollingWindowName, number>;
    uniqueSellers: Record<RollingWindowName, number>;
    uniqueExact: Record<RollingWindowName, boolean>;
    uniqueErrorPct: Record<RollingWindowName, number>;
}
