import { z } from 'zod';
import { addressSchema } from './execution';

export const ALERT_WINDOWS = ['1m', '5m', '1h', '6h', '24h'] as const;
export type AlertWindow = typeof ALERT_WINDOWS[number];

export const ALERT_THRESHOLD_TYPES = [
    'price',
    'market_cap',
    'liquidity',
    ...ALERT_WINDOWS.map((window) => `volume_${window}` as const),
    ...ALERT_WINDOWS.map((window) => `buy_count_${window}` as const),
    ...ALERT_WINDOWS.map((window) => `sell_count_${window}` as const),
    ...ALERT_WINDOWS.map((window) => `tx_count_${window}` as const),
] as const;

export type AlertThresholdType = typeof ALERT_THRESHOLD_TYPES[number];
export const alertThresholdSchema = z.enum(ALERT_THRESHOLD_TYPES);

export const thresholdLabel = (type: AlertThresholdType): string => {
    if (type === 'market_cap') return 'Market Cap';
    return type.split('_').map((part) => {
        if (part === 'tx') return 'Tx';
        return part.replace(/^./, (value) => value.toUpperCase());
    }).join(' ');
};

export const thresholdIsUsd = (type: AlertThresholdType): boolean =>
    type === 'price' || type === 'market_cap' || type === 'liquidity' || type.startsWith('volume_');

const thresholdValue = z.preprocess(
    (value) => typeof value === 'string' && value.trim() ? Number(value) : value,
    z.number().positive().finite().max(1e30)
);

export const alertCreateSchema = z.object({
    tokenAddress: addressSchema,
    thresholdType: alertThresholdSchema,
    thresholdValue,
    condition: z.enum(['above', 'below']),
    notificationType: z.enum(['telegram', 'discord']),
}).strict();

export const alertUpdateSchema = z.object({
    thresholdValue: thresholdValue.optional(),
    condition: z.enum(['above', 'below']).optional(),
    isActive: z.boolean().optional(),
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: 'Set at least one alert field',
});

export const alertCandidateSchema = z.object({
    alertId: z.string().uuid(),
    userId: z.string().uuid(),
    tokenAddress: addressSchema,
    thresholdType: alertThresholdSchema,
    thresholdValue,
    condition: z.enum(['above', 'below']),
    currentValue: z.number().finite().nonnegative(),
    notificationType: z.enum(['telegram', 'discord']),
    signature: z.string().min(1).max(128),
    slot: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    sourceEventId: z.string().min(1).max(180),
    observedAt: z.string().datetime(),
    receivedAt: z.string().datetime(),
    matchedAt: z.string().datetime(),
    idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/),
    engineVersion: z.string().min(1).max(64),
    alertGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    basisCommitment: z.enum(['processed', 'confirmed', 'finalized']).optional(),
    metricConfidence: z.number().min(0).max(1),
    metricEstimated: z.boolean(),
    metricVersion: z.string().min(1).max(32),
    metricRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

export const alertNotificationJobSchema = z.object({
    alertEventId: z.string().uuid(),
    alertId: z.string().uuid(),
    userId: z.string().uuid(),
    tokenAddress: addressSchema,
    currentValue: z.number().finite().nonnegative(),
    notificationType: z.enum(['telegram', 'discord']),
    idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/),
    triggeredAt: z.string().datetime(),
}).strict();
