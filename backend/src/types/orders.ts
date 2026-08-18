import { z } from 'zod';
import { amountSchema } from './amount';
import { addressSchema } from './execution';

const orderBase = z.object({
    walletAddress: addressSchema,
    inputMint: addressSchema,
    outputMint: addressSchema,
    inputAmount: amountSchema,
    triggerMint: addressSchema,
    expiresAt: z.string().datetime(),
    clientOrderId: z.string().trim().min(16).max(128),
}).refine((value) => value.inputMint !== value.outputMint, {
    message: 'Input and output mints must be different',
    path: ['outputMint'],
}).refine((value) => new Date(value.expiresAt).getTime() > Date.now() + 60_000, {
    message: 'Order expiry must be at least one minute in the future',
    path: ['expiresAt'],
});

const singleOrder = orderBase.and(z.object({
    orderType: z.literal('single'),
    triggerCondition: z.enum(['above', 'below']),
    triggerPriceUsd: z.number().positive().finite().optional(),
    trailingBps: z.number().int().min(50).max(9000).optional(),
    slippageBps: z.number().int().min(0).max(10000).optional(),
})).refine((value) => Number(value.triggerPriceUsd !== undefined) + Number(value.trailingBps !== undefined) === 1, {
    message: 'Set exactly one of triggerPriceUsd or trailingBps',
    path: ['triggerPriceUsd'],
}).refine((value) => !value.trailingBps || (
    value.triggerCondition === 'below'
        ? value.triggerMint === value.inputMint
        : value.triggerMint === value.outputMint
), {
    message: 'Trailing trigger mint does not match the order direction',
    path: ['triggerMint'],
});

const ocoOrder = orderBase.and(z.object({
    orderType: z.literal('oco'),
    takeProfitPriceUsd: z.number().positive().finite(),
    stopLossPriceUsd: z.number().positive().finite(),
    takeProfitSlippageBps: z.number().int().min(0).max(10000).optional(),
    stopLossSlippageBps: z.number().int().min(0).max(10000).optional(),
})).refine((value) => value.takeProfitPriceUsd > value.stopLossPriceUsd, {
    message: 'Take-profit price must be greater than stop-loss price',
    path: ['takeProfitPriceUsd'],
});

const otocoOrder = orderBase.and(z.object({
    orderType: z.literal('otoco'),
    triggerCondition: z.enum(['above', 'below']),
    triggerPriceUsd: z.number().positive().finite(),
    takeProfitPriceUsd: z.number().positive().finite(),
    stopLossPriceUsd: z.number().positive().finite(),
    slippageBps: z.number().int().min(0).max(10000).optional(),
    takeProfitSlippageBps: z.number().int().min(0).max(10000).optional(),
    stopLossSlippageBps: z.number().int().min(0).max(10000).optional(),
})).refine((value) => value.takeProfitPriceUsd > value.stopLossPriceUsd, {
    message: 'Take-profit price must be greater than stop-loss price',
    path: ['takeProfitPriceUsd'],
});

export const orderRequestSchema = z.union([singleOrder, ocoOrder, otocoOrder]);
export const orderChallengeSchema = z.object({
    walletAddress: addressSchema,
    type: z.enum(['message', 'transaction']).default('message'),
}).strict();
const messageAuth = z.object({
    type: z.literal('message'),
    walletAddress: addressSchema,
    signature: z.string().trim().min(32).max(256),
}).strict();
const transactionAuth = z.object({
    type: z.literal('transaction'),
    walletAddress: addressSchema,
    signedTransaction: z.string().trim().min(16),
}).strict();
export const orderAuthSchema = z.union([messageAuth, transactionAuth]);
export const orderActivateSchema = z.object({
    signedTransaction: z.string().trim().min(16),
}).strict();
export const orderCancelSchema = z.object({
    signedTransaction: z.string().trim().min(16),
    cancelRequestId: z.string().trim().min(8).max(180),
}).strict();

const singleUpdate = z.object({
    orderType: z.literal('single'),
    triggerPriceUsd: z.number().positive().finite().optional(),
    trailingBps: z.number().int().min(50).max(9000).optional(),
    slippageBps: z.number().int().min(0).max(10000).optional(),
}).strict().refine((value) => value.triggerPriceUsd !== undefined
    || value.trailingBps !== undefined
    || value.slippageBps !== undefined, {
    message: 'Set at least one order parameter',
}).refine((value) => !(value.triggerPriceUsd !== undefined && value.trailingBps !== undefined), {
    message: 'Trigger price and trailing distance are mutually exclusive',
});

const ocoUpdate = z.object({
    orderType: z.literal('oco'),
    takeProfitPriceUsd: z.number().positive().finite().optional(),
    stopLossPriceUsd: z.number().positive().finite().optional(),
    takeProfitSlippageBps: z.number().int().min(0).max(10000).optional(),
    stopLossSlippageBps: z.number().int().min(0).max(10000).optional(),
}).strict().refine((value) => Object.values(value).some((item) => item !== 'oco' && item !== undefined), {
    message: 'Set at least one order parameter',
}).refine((value) => value.takeProfitPriceUsd === undefined
    || value.stopLossPriceUsd === undefined
    || value.takeProfitPriceUsd > value.stopLossPriceUsd, {
    message: 'Take-profit price must be greater than stop-loss price',
});

const otocoUpdate = z.object({
    orderType: z.literal('otoco'),
    triggerPriceUsd: z.number().positive().finite().optional(),
    takeProfitPriceUsd: z.number().positive().finite().optional(),
    stopLossPriceUsd: z.number().positive().finite().optional(),
    slippageBps: z.number().int().min(0).max(10000).optional(),
    takeProfitSlippageBps: z.number().int().min(0).max(10000).optional(),
    stopLossSlippageBps: z.number().int().min(0).max(10000).optional(),
}).strict().refine((value) => Object.values(value).some((item) => item !== 'otoco' && item !== undefined), {
    message: 'Set at least one order parameter',
}).refine((value) => value.takeProfitPriceUsd === undefined
    || value.stopLossPriceUsd === undefined
    || value.takeProfitPriceUsd > value.stopLossPriceUsd, {
    message: 'Take-profit price must be greater than stop-loss price',
});

export const orderUpdateSchema = z.union([singleUpdate, ocoUpdate, otocoUpdate]);

export type OrderRequest = z.infer<typeof orderRequestSchema>;
export type OrderUpdate = z.infer<typeof orderUpdateSchema>;
export type OrderAuth =
    | { type: 'message'; signature: string }
    | { type: 'transaction'; signedTransaction: string };
export type OrderAuthType = OrderAuth['type'];
export type OrderChallenge =
    | { type: 'message'; challenge: string }
    | { type: 'transaction'; transaction: string };
export type OrderProviderName = 'jupiter_trigger_v2';
export type OrderState =
    | 'preparing'
    | 'prepared'
    | 'activating'
    | 'open'
    | 'executing'
    | 'partially_filled'
    | 'filled'
    | 'cancel_pending'
    | 'cancelled'
    | 'expired'
    | 'failed';

export interface PreparedOrder {
    orderId: string;
    provider: OrderProviderName;
    state: OrderState;
    depositRequestId: string;
    transaction: string;
    receiverAddress?: string;
    expiresAt: string;
    custody: 'none' | 'third_party_vault';
}

export interface OrderRecord {
    id: string;
    provider: OrderProviderName;
    providerOrderId?: string;
    clientOrderId: string;
    walletAddress: string;
    orderType: 'single' | 'oco' | 'otoco';
    state: OrderState;
    inputMint: string;
    outputMint: string;
    inputAmount: string;
    triggerMint: string;
    params: Record<string, unknown>;
    depositSignature?: string;
    fillSignature?: string;
    cancelSignature?: string;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
}

export interface OrderCapabilities {
    mode: 'disabled' | 'live';
    provider: OrderProviderName | 'none';
    canPrepare: boolean;
    canActivate: boolean;
    requiresProviderAuth: boolean;
    custody: 'none' | 'third_party_vault';
    orderTypes: Array<'single' | 'trailing' | 'oco' | 'otoco'>;
}
