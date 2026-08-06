import { z } from 'zod';
import { addressSchema } from './execution';

export const trackWalletSchema = z.object({
    walletAddress: addressSchema,
    label: z.string().trim().min(1).max(64).optional(),
    notify: z.boolean().default(false),
}).strict();

export const updateWalletSchema = z.object({
    label: z.string().trim().min(1).max(64).nullable().optional(),
    notify: z.boolean().optional(),
    status: z.enum(['active', 'paused']).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export type TrackWalletRequest = z.infer<typeof trackWalletSchema>;
export type UpdateWalletRequest = z.infer<typeof updateWalletSchema>;

export interface TrackedWallet {
    id: string;
    walletAddress: string;
    label?: string;
    notify: boolean;
    status: 'active' | 'paused';
    lastSignature?: string;
    lastSlot?: number;
    backfillComplete: boolean;
    backfillPages: number;
    createdAt: string;
    updatedAt: string;
}

export interface WalletActivity {
    id: string;
    trackedWalletId: string;
    walletAddress: string;
    kind: 'swap' | 'transfer_in' | 'transfer_out';
    tokenMint?: string;
    tokenDecimals?: number;
    side?: 'buy' | 'sell';
    quantityBase?: string;
    valueMicroUsd?: string;
    signature: string;
    slot?: number;
    source: string;
    occurredAt: string;
}

export interface WalletPosition {
    trackedWalletId: string;
    tokenMint: string;
    tokenDecimals: number;
    quantityBase: string;
    costMicroUsd: string;
    unknownCostBase: string;
    realizedPnlMicroUsd: string;
    unresolvedSoldBase: string;
    untrackedSoldBase: string;
    currentValueMicroUsd?: string;
    unrealizedPnlMicroUsd?: string;
    priceUsd?: string;
    priceObservedAt?: string;
    updatedAt: string;
}

export interface WalletPortfolio {
    trackedWalletId: string;
    marketValueMicroUsd: string;
    costMicroUsd: string;
    realizedPnlMicroUsd: string;
    unrealizedPnlMicroUsd?: string;
    pnlComplete: boolean;
    historyComplete: boolean;
    pricedAssets: number;
    unpricedAssets: number;
    positions: WalletPosition[];
}

export interface WalletPortfolioPoint {
    at: string;
    marketValueMicroUsd: string;
    costMicroUsd: string;
    realizedPnlMicroUsd: string;
    pnlComplete: boolean;
    pricedAssets: number;
    unpricedAssets: number;
}
