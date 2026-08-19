import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FeedTick, MetricQuality } from '../../types';
import { alertThresholdSchema, type AlertThresholdType } from '../../types/alerts';
import { addressSchema } from '../../types/execution';
import { qualityForThreshold, thresholdMatches, valueForThreshold } from '../alertValue';
import type { MetricReplay } from '../marketData/metricReplay';
import { ReplayCoordinator, type ReplayEvent, type ReplaySnapshot } from './coordinator';
import { ReplayProjection, type ProjectionView } from './projection';
import { replayWalletTrade, type ReplayWalletTrade } from './replayWallet';

export const replayAlertModelContract = 'fervor-replay-alert-model-v1' as const;
export const replayNotificationContract = 'fervor-replay-in-app-v1' as const;
export const replayWalletNotificationContract = 'fervor-replay-wallet-in-app-v1' as const;
export const replayNotificationPageContract = 'fervor-replay-notification-page-v1' as const;

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const metricAlertSchema = z.object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    tokenMint: addressSchema,
    thresholdType: alertThresholdSchema,
    thresholdValue: z.number().positive().finite().max(1e30),
    condition: z.enum(['above', 'below']),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    policy: z.literal('one_shot'),
}).strict();
const walletAlertSchema = z.object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    tokenMint: addressSchema,
    wallet: addressSchema,
    side: z.enum(['buy', 'sell', 'any']),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    policy: z.literal('one_shot'),
}).strict();
const alertSchema = z.union([metricAlertSchema, walletAlertSchema]);
const modelSchema = z.object({
    contract: z.literal(replayAlertModelContract),
    sourceReplaySha256: hash,
    alerts: z.array(alertSchema).max(1_000),
}).strict();

export type ReplayAlert = Readonly<z.infer<typeof alertSchema>>;
export type ReplayMetricAlert = Readonly<z.infer<typeof metricAlertSchema>>;
export type ReplayWalletAlert = Readonly<z.infer<typeof walletAlertSchema>>;

export interface ReplayAlertModel {
    readonly contract: typeof replayAlertModelContract;
    readonly sourceReplaySha256: string;
    readonly alerts: readonly ReplayAlert[];
    readonly modelSha256: string;
}

interface ReplayDelivery {
    readonly channel: 'in_app';
    readonly status: 'available';
    readonly attempts: 0;
    readonly availableAt: string;
    readonly external: false;
}

const inAppDelivery = (availableAt: string): ReplayDelivery => Object.freeze({
    channel: 'in_app',
    status: 'available',
    attempts: 0,
    availableAt,
    external: false,
});

export interface ReplayMetricNotification {
    readonly contract: typeof replayNotificationContract;
    readonly notificationKey: string;
    readonly sourceReplaySha256: string;
    readonly runId: string;
    readonly epoch: number;
    readonly modelSha256: string;
    readonly alertId: string;
    readonly alertGeneration: number;
    readonly userId: string;
    readonly tokenMint: string;
    readonly thresholdType: AlertThresholdType;
    readonly thresholdValue: number;
    readonly condition: 'above' | 'below';
    readonly currentValue: number;
    readonly metricCursor: number;
    readonly metricEventId: string;
    readonly qualitySourceEventId: string;
    readonly signature: string;
    readonly slot: number;
    readonly observedAt: string;
    readonly matchedAt: string;
    readonly metricConfidence: number;
    readonly metricEstimated: boolean;
    readonly basisCommitment: 'processed' | 'confirmed' | 'finalized';
    readonly engineVersion: 'fervor-replay-alert-v1';
    readonly delivery: ReplayDelivery;
}

export interface ReplayWalletNotification {
    readonly contract: typeof replayWalletNotificationContract;
    readonly notificationKey: string;
    readonly sourceReplaySha256: string;
    readonly runId: string;
    readonly epoch: number;
    readonly modelSha256: string;
    readonly alertId: string;
    readonly alertGeneration: number;
    readonly userId: string;
    readonly tokenMint: string;
    readonly wallet: string;
    readonly watchSide: 'buy' | 'sell' | 'any';
    readonly activity: ReplayWalletTrade;
    readonly matchedAt: string;
    readonly engineVersion: 'fervor-replay-wallet-alert-v1';
    readonly delivery: ReplayDelivery;
}

export type ReplayNotification = ReplayMetricNotification | ReplayWalletNotification;

export interface ReplayNotificationPage {
    readonly contract: typeof replayNotificationPageContract;
    readonly sourceReplaySha256: string;
    readonly runId: string;
    readonly epoch: number;
    readonly modelSha256: string;
    readonly cutCursor: number;
    readonly cutAt: string | null;
    readonly definitionCount: number;
    readonly triggeredCount: number;
    readonly armedCount: number;
    readonly unavailableCount: number;
    readonly unavailableTypes: readonly AlertThresholdType[];
    readonly after: number;
    readonly next: number | null;
    readonly notificationsSha256: string;
    readonly items: readonly ReplayNotification[];
}

const modelDigest = (model: Omit<ReplayAlertModel, 'modelSha256'>): string => createHash('sha256')
    .update(replayAlertModelContract)
    .update('\0')
    .update(JSON.stringify(model))
    .digest('hex');

export const normalizeReplayAlertModel = (
    value: unknown,
    sourceReplaySha256: string,
    tokenMint: string
): ReplayAlertModel => {
    const input = modelSchema.parse(value ?? {
        contract: replayAlertModelContract,
        sourceReplaySha256,
        alerts: [],
    });
    const ids = new Set<string>();
    const invalidAlert = input.alerts.some((alert) => {
        if (alert.tokenMint !== tokenMint || ids.has(alert.id)) return true;
        ids.add(alert.id);
        return false;
    });
    if (input.sourceReplaySha256 !== sourceReplaySha256 || invalidAlert) {
        throw new Error('Replay alert model does not match its source');
    }
    const alerts = Object.freeze([...input.alerts]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((alert) => Object.freeze({ ...alert })));
    const model = Object.freeze({
        contract: replayAlertModelContract,
        sourceReplaySha256,
        alerts,
    });
    return Object.freeze({ ...model, modelSha256: modelDigest(model) });
};

const isMetricAlert = (alert: ReplayAlert): alert is ReplayMetricAlert =>
    'thresholdType' in alert;

const metricQuality = (event: ReplayEvent, estimated: boolean, sourceEventId: string): MetricQuality => ({
    sourceEventId,
    observedAt: new Date(Date.parse(event.trade.observedAt)).toISOString(),
    confidence: event.trade.confidence,
    stale: event.trade.stale,
    estimated,
    commitment: event.trade.commitment,
});

const metricTick = (event: ReplayEvent, view: ProjectionView): FeedTick => {
    const observedAt = new Date(Date.parse(event.trade.observedAt)).toISOString();
    const rolling = metricQuality(event, true, event.trade.idempotencyKey);
    const priced = event.usdPriced ? metricQuality(
        event,
        event.trade.usdEstimated ?? true,
        event.trade.usdSourceEventId ?? event.trade.idempotencyKey
    ) : undefined;
    return {
        tokenAddress: event.trade.tokenMint,
        signature: event.trade.signature!,
        slot: event.trade.slot!,
        blockTime: Math.floor(Date.parse(observedAt) / 1_000),
        price: event.usdPriced ? event.trade.priceUsd : undefined,
        volume: view.rolling.volumeUsd,
        buyCount: view.rolling.buyCount,
        sellCount: view.rolling.sellCount,
        txCount: view.rolling.txCount,
        usdValue: event.trade.usdAmount ?? 0,
        receivedAt: observedAt,
        sourceEventId: event.trade.idempotencyKey,
        observedAt,
        commitment: event.trade.commitment,
        confidence: event.trade.confidence,
        stale: event.trade.stale,
        metricSource: 'fervor_engine',
        metricVersion: 'fervor-replay-metric-v1',
        metricRevision: event.cursor + 1,
        metricQuality: {
            ...(priced === undefined ? {} : { price: priced }),
            rolling,
        },
    };
};

const notificationKey = (
    contract: typeof replayNotificationContract | typeof replayWalletNotificationContract,
    snapshot: ReplaySnapshot,
    modelSha256: string,
    alert: ReplayAlert,
    event: ReplayEvent
): string => createHash('sha256')
    .update(contract)
    .update('\0')
    .update(snapshot.sourceReplaySha256)
    .update('\0')
    .update(snapshot.runId)
    .update('\0')
    .update(snapshot.epoch.toString())
    .update('\0')
    .update(modelSha256)
    .update('\0')
    .update(alert.id)
    .update('\0')
    .update(alert.generation.toString())
    .update('\0')
    .update(event.trade.idempotencyKey)
    .digest('hex');

const metricNotification = (
    snapshot: ReplaySnapshot,
    model: ReplayAlertModel,
    alert: ReplayMetricAlert,
    event: ReplayEvent,
    value: number,
    quality: MetricQuality
): ReplayMetricNotification => {
    const observedAt = new Date(Date.parse(event.trade.observedAt)).toISOString();
    return Object.freeze({
        contract: replayNotificationContract,
        notificationKey: notificationKey(
            replayNotificationContract, snapshot, model.modelSha256, alert, event
        ),
        sourceReplaySha256: snapshot.sourceReplaySha256,
        runId: snapshot.runId,
        epoch: snapshot.epoch,
        modelSha256: model.modelSha256,
        alertId: alert.id,
        alertGeneration: alert.generation,
        userId: alert.userId,
        tokenMint: alert.tokenMint,
        thresholdType: alert.thresholdType,
        thresholdValue: alert.thresholdValue,
        condition: alert.condition,
        currentValue: value,
        metricCursor: event.cursor,
        metricEventId: event.trade.idempotencyKey,
        qualitySourceEventId: quality.sourceEventId,
        signature: event.trade.signature!,
        slot: event.trade.slot!,
        observedAt,
        matchedAt: observedAt,
        metricConfidence: quality.confidence,
        metricEstimated: quality.estimated,
        basisCommitment: event.trade.commitment!,
        engineVersion: 'fervor-replay-alert-v1',
        delivery: inAppDelivery(observedAt),
    });
};

const walletNotification = (
    snapshot: ReplaySnapshot,
    model: ReplayAlertModel,
    alert: ReplayWalletAlert,
    event: ReplayEvent
): ReplayWalletNotification => {
    const activity = replayWalletTrade(
        snapshot.sourceReplaySha256, event.cursor, event.trade
    );
    const matchedAt = new Date(Date.parse(activity.observedAt)).toISOString();
    return Object.freeze({
        contract: replayWalletNotificationContract,
        notificationKey: notificationKey(
            replayWalletNotificationContract, snapshot, model.modelSha256, alert, event
        ),
        sourceReplaySha256: snapshot.sourceReplaySha256,
        runId: snapshot.runId,
        epoch: snapshot.epoch,
        modelSha256: model.modelSha256,
        alertId: alert.id,
        alertGeneration: alert.generation,
        userId: alert.userId,
        tokenMint: alert.tokenMint,
        wallet: alert.wallet,
        watchSide: alert.side,
        activity,
        matchedAt,
        engineVersion: 'fervor-replay-wallet-alert-v1',
        delivery: inAppDelivery(matchedAt),
    });
};

const notificationDigest = (items: readonly ReplayNotification[]): string => createHash('sha256')
    .update(replayNotificationPageContract)
    .update('\0')
    .update(JSON.stringify(items))
    .digest('hex');

export const projectReplayNotifications = (
    replay: MetricReplay,
    snapshot: ReplaySnapshot,
    model: ReplayAlertModel,
    after = 0,
    limit = 100
): ReplayNotificationPage => {
    if (snapshot.sourceReplaySha256 !== replay.source.replaySha256
        || snapshot.cursor > replay.sourceTrades.length
        || !Number.isSafeInteger(after)
        || !Number.isSafeInteger(limit)
        || after < 0
        || limit < 1
        || limit > 500) {
        throw new Error('Replay notification page is invalid');
    }
    const coordinator = new ReplayCoordinator(replay, snapshot.runId);
    const projection = ReplayProjection.start(coordinator);
    const triggered = new Set<string>();
    const observed = new Set<string>();
    const notifications: ReplayNotification[] = [];
    for (let cursor = 0; cursor < snapshot.cursor; cursor += 1) {
        const event = coordinator.step()!;
        projection.apply(event);
        const tick = metricTick(event, projection.view());
        for (const alert of model.alerts) {
            if (triggered.has(alert.id)) continue;
            if (!isMetricAlert(alert)) {
                if (event.trade.maker !== alert.wallet
                    || (alert.side !== 'any' && event.trade.side !== alert.side)) continue;
                triggered.add(alert.id);
                notifications.push(walletNotification(snapshot, model, alert, event));
                continue;
            }
            const value = valueForThreshold(alert.thresholdType, tick);
            const quality = qualityForThreshold(alert.thresholdType, tick);
            if (value === undefined
                || !Number.isFinite(value)
                || !quality
                || quality.stale
                || !Number.isFinite(quality.confidence)
                || quality.confidence < 0
                || quality.confidence > 1) continue;
            observed.add(alert.id);
            if (!thresholdMatches(alert.condition, alert.thresholdValue, value)) continue;
            triggered.add(alert.id);
            notifications.push(metricNotification(snapshot, model, alert, event, value, quality));
        }
    }
    const rebuilt = coordinator.snapshot();
    if (rebuilt.cursor !== snapshot.cursor || rebuilt.now !== snapshot.now) {
        throw new Error('Replay notification projection differs from its cut');
    }
    const unavailable = model.alerts.filter((alert): alert is ReplayMetricAlert =>
        isMetricAlert(alert) && !triggered.has(alert.id) && !observed.has(alert.id));
    const unavailableTypes = Object.freeze([...new Set(unavailable.map((alert) => alert.thresholdType))]
        .sort());
    const end = Math.min(notifications.length, after + limit);
    return Object.freeze({
        contract: replayNotificationPageContract,
        sourceReplaySha256: snapshot.sourceReplaySha256,
        runId: snapshot.runId,
        epoch: snapshot.epoch,
        modelSha256: model.modelSha256,
        cutCursor: snapshot.cursor,
        cutAt: snapshot.now,
        definitionCount: model.alerts.length,
        triggeredCount: notifications.length,
        armedCount: model.alerts.length - notifications.length - unavailable.length,
        unavailableCount: unavailable.length,
        unavailableTypes,
        after,
        next: end < notifications.length ? end : null,
        notificationsSha256: notificationDigest(notifications),
        items: Object.freeze(notifications.slice(after, end)),
    });
};
