import { fervorSupplyContract, type FervorSupplyInput } from '../../types/marketData';
import { parseU64 } from '../../types/amount';

export const fervorMetricSource = 'fervor_engine' as const;
export const fervorMetricVersion = 'fervor-market-v2' as const;
export const fervorInputContract = 'fervor-market-input-v2' as const;

export interface FervorMetricInput {
    tokenMint: string;
    priceUsd?: number;
    supply?: FervorSupplyInput;
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

export const supplyAmount = (
    supply: FervorSupplyInput | undefined,
    tokenMint: string
): number | undefined => {
    if (!supply
        || supply.contract !== fervorSupplyContract
        || supply.tokenMint !== tokenMint
        || supply.fixed !== true
        || !Number.isInteger(supply.decimals)
        || supply.decimals < 0
        || supply.decimals > 18) return undefined;
    const raw = parseU64(supply.rawAmount);
    if (raw === undefined || raw === 0n) return undefined;
    const divisor = 10n ** BigInt(supply.decimals);
    if (raw > BigInt(Number.MAX_SAFE_INTEGER) * divisor) return undefined;
    const amount = Number(raw) / Number(divisor);
    return Number.isFinite(amount) && amount > 0 && amount <= Number.MAX_SAFE_INTEGER
        ? amount
        : undefined;
};

const product = (left: number | undefined, right: number | undefined): number | undefined => {
    if (left === undefined || right === undefined) return undefined;
    const value = left * right;
    return Number.isFinite(value) && value >= 0 ? value : undefined;
};

/**
 * The sole public derivation boundary for canonical market metrics.
 *
 * Providers contribute observations only. In particular, upstream market-cap
 * and FDV values are intentionally absent from this input contract.
 */
export const deriveFervorMetrics = (input: FervorMetricInput): FervorMetricValue => {
    const priceUsd = nonNegative(input.priceUsd);
    const totalSupply = supplyAmount(input.supply, input.tokenMint);

    return {
        metricSource: fervorMetricSource,
        metricVersion: fervorMetricVersion,
        marketCapUsd: undefined,
        fdvUsd: product(priceUsd, totalSupply),
        liquidityUsd: nonNegative(input.liquidityUsd),
    };
};
