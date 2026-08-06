import type { FervorSupplyPolicy } from '../../types';

export const fervorMetricSource = 'fervor_engine' as const;
export const fervorMetricVersion = 'fervor-market-v1' as const;
export const fervorInputContract = 'fervor-market-input-v1' as const;

export interface FervorMetricInput {
    priceUsd?: number;
    totalSupply?: number;
    circulatingSupply?: number;
    supplyPolicy?: FervorSupplyPolicy;
    liquidityUsd?: number;
}

export interface FervorMetricValue {
    metricSource: typeof fervorMetricSource;
    metricVersion: typeof fervorMetricVersion;
    marketCapUsd?: number;
    fdvUsd?: number;
    liquidityUsd?: number;
}

const nonNegative = (value: number | undefined): number | undefined =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * The sole public derivation boundary for canonical market metrics.
 *
 * Providers contribute observations only. In particular, upstream market-cap
 * and FDV values are intentionally absent from this input contract.
 */
export const deriveFervorMetrics = (input: FervorMetricInput): FervorMetricValue => {
    const priceUsd = nonNegative(input.priceUsd);
    const totalSupply = nonNegative(input.totalSupply);
    const circulatingSupply = input.supplyPolicy
        ? nonNegative(input.circulatingSupply)
        : undefined;

    return {
        metricSource: fervorMetricSource,
        metricVersion: fervorMetricVersion,
        marketCapUsd: priceUsd === undefined || circulatingSupply === undefined
            ? undefined
            : priceUsd * circulatingSupply,
        fdvUsd: priceUsd === undefined || totalSupply === undefined
            ? undefined
            : priceUsd * totalSupply,
        liquidityUsd: nonNegative(input.liquidityUsd),
    };
};
