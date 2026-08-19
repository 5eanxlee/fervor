import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Clock } from '../clock';
import { recipientHash, retryDelayMs } from '../notifications/utils';
import type {
    NotificationChannel,
    NotificationProvider,
    NotificationSendInput,
    ProviderSendResult,
} from '../notifications/types';
import {
    replayNotificationContract,
    type ReplayNotification,
    type ReplayNotificationPage,
} from './replayAlerts';

export const replaySendPermitContract = 'fervor-replay-send-permit-v1' as const;
export const replaySendMessageContract = 'fervor-replay-message-v1' as const;
export const replaySendResultContract = 'fervor-replay-send-result-v1' as const;

const attemptsMax = 3;
const retryBaseMs = 500;
const retryMaxMs = 30_000;
const permitMaxMs = 15 * 60_000;
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const targetSchema = z.object({
    notificationKey: hash,
    channel: z.enum(['telegram', 'discord']),
    recipient: z.string().min(1).max(256).refine((value) => value === value.trim()),
}).strict();
const permitSchema = z.object({
    contract: z.literal(replaySendPermitContract),
    mode: z.literal('historical_replay'),
    acknowledgement: z.literal('external_historical_replay'),
    sourceReplaySha256: hash,
    runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
    epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    modelSha256: hash,
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    targets: z.array(targetSchema).min(1).max(100),
}).strict().superRefine((permit, context) => {
    const issued = Date.parse(permit.issuedAt);
    const expires = Date.parse(permit.expiresAt);
    if (expires <= issued || expires - issued > permitMaxMs) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid permit lifetime' });
    }
    const seen = new Set<string>();
    for (const target of permit.targets) {
        const key = `${target.notificationKey}:${target.channel}`;
        if (seen.has(key)) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate permit target' });
            break;
        }
        seen.add(key);
    }
});

type Target = Readonly<z.infer<typeof targetSchema>>;
type PermitInput = z.infer<typeof permitSchema>;

export type ReplaySendPermit = Readonly<Omit<PermitInput, 'targets'> & {
    readonly targets: readonly Target[];
    readonly permitSha256: string;
}>;

export interface ReplaySendMessage {
    readonly contract: typeof replaySendMessageContract;
    readonly mode: 'historical_replay';
    readonly label: 'FERVOR REPLAY';
    readonly sourceReplaySha256: string;
    readonly runId: string;
    readonly epoch: number;
    readonly notificationKey: string;
    readonly historicalAt: string;
    readonly text: string;
}

export interface ReplaySendProvider extends NotificationProvider<ReplaySendMessage> {
    readonly replayMode: 'local_fixture';
}

export interface ReplaySendView {
    readonly sourceReplaySha256: string;
    readonly runId: string;
    readonly epoch: number;
    readonly modelSha256: string;
    readonly cutCursor: number;
    readonly notification: ReplayNotification;
}

export interface ReplaySendTimer extends Clock {
    wait(delayMs: number): Promise<void>;
    random(): number;
}

export type ReplaySendReason =
    | 'notification_missing'
    | 'cut_invalid'
    | 'permit_invalid'
    | 'permit_inactive'
    | 'permit_mismatch'
    | 'target_missing'
    | 'permit_changed'
    | 'provider_unavailable'
    | 'attempts_exhausted';

export interface ReplaySendAttempt {
    readonly seq: number;
    readonly attemptedAt: string;
    readonly outcome: 'accepted' | 'retryable' | 'permanent' | 'ambiguous';
    readonly errorCode?: string;
    readonly retryDelayMs?: number;
}

export interface ReplaySendResult {
    readonly contract: typeof replaySendResultContract;
    readonly notificationKey: string;
    readonly channel: NotificationChannel;
    readonly status: 'sent' | 'failed' | 'ambiguous' | 'fenced';
    readonly reason?: ReplaySendReason;
    readonly context?: Readonly<{
        sourceReplaySha256: string;
        runId: string;
        epoch: number;
        modelSha256: string;
        permitSha256: string;
        recipientHash: string;
    }>;
    readonly attemptCount: number;
    readonly attempts: readonly ReplaySendAttempt[];
}

export interface ReplaySendDeps {
    readonly getView: (key: string) => ReplaySendView | null | Promise<ReplaySendView | null>;
    readonly getPermit: () => unknown | Promise<unknown>;
    readonly provider: ReplaySendProvider;
    readonly timer?: ReplaySendTimer;
}

interface Auth {
    readonly permit: ReplaySendPermit;
    readonly context: NonNullable<ReplaySendResult['context']>;
    readonly input: NotificationSendInput<ReplaySendMessage>;
}

type AuthResult = { readonly value: Auth } | { readonly reason: ReplaySendReason };

const digest = (contract: string, value: unknown): string => createHash('sha256')
    .update(contract)
    .update('\0')
    .update(JSON.stringify(value))
    .digest('hex');

const systemTimer: ReplaySendTimer = {
    nowMs: Date.now,
    wait: (waitMs) => delay(waitMs),
    random: Math.random,
};

export const normalizeReplaySendPermit = (value: unknown): ReplaySendPermit => {
    const input = permitSchema.parse(value);
    const targets = Object.freeze([...input.targets]
        .sort((left, right) => left.notificationKey.localeCompare(right.notificationKey)
            || left.channel.localeCompare(right.channel))
        .map((target) => Object.freeze(target)));
    const permit = Object.freeze({ ...input, targets });
    return Object.freeze({
        ...permit,
        permitSha256: digest(replaySendPermitContract, permit),
    });
};

export const replaySendView = (
    page: ReplayNotificationPage,
    notificationKey: string
): ReplaySendView | null => {
    const notification = page.items.find((item) => item.notificationKey === notificationKey);
    return notification ? Object.freeze({
        sourceReplaySha256: page.sourceReplaySha256,
        runId: page.runId,
        epoch: page.epoch,
        modelSha256: page.modelSha256,
        cutCursor: page.cutCursor,
        notification,
    }) : null;
};

const validView = (view: ReplaySendView, key: string): boolean => {
    const notification = view.notification;
    const cursor = notification.contract === replayNotificationContract
        ? notification.metricCursor
        : notification.activity.cursor;
    return notification.notificationKey === key
        && notification.sourceReplaySha256 === view.sourceReplaySha256
        && notification.runId === view.runId
        && notification.epoch === view.epoch
        && notification.modelSha256 === view.modelSha256
        && notification.delivery.external === false
        && notification.delivery.channel === 'in_app'
        && Number.isSafeInteger(view.cutCursor)
        && view.cutCursor > cursor;
};

const message = (notification: ReplayNotification): ReplaySendMessage => {
    const details = notification.contract === replayNotificationContract
        ? [
            `Alert: ${notification.thresholdType} ${notification.condition} ${notification.thresholdValue}`,
            `Observed: ${notification.currentValue}`,
            `Signature: ${notification.signature}`,
        ]
        : [
            `Tracked wallet: ${notification.wallet}`,
            `Activity: ${notification.activity.side} ${notification.activity.tokenAmountRaw} raw token units`,
            `Signature: ${notification.activity.signature}`,
        ];
    return Object.freeze({
        contract: replaySendMessageContract,
        mode: 'historical_replay',
        label: 'FERVOR REPLAY',
        sourceReplaySha256: notification.sourceReplaySha256,
        runId: notification.runId,
        epoch: notification.epoch,
        notificationKey: notification.notificationKey,
        historicalAt: notification.matchedAt,
        text: [
            'FERVOR REPLAY - HISTORICAL DATA',
            `Historical time: ${notification.matchedAt}`,
            `Corpus: ${notification.sourceReplaySha256}`,
            `Run: ${notification.runId} / epoch ${notification.epoch}`,
            `Token: ${notification.tokenMint}`,
            ...details,
        ].join('\n'),
    });
};

const sendInput = (
    notification: ReplayNotification,
    target: Target,
    permitSha256: string
): NotificationSendInput<ReplaySendMessage> => {
    const recipientSha = recipientHash(target.recipient);
    const requestKey = digest(replaySendMessageContract, {
        notificationKey: notification.notificationKey,
        channel: target.channel,
        recipientHash: recipientSha,
        permitSha256,
    });
    return {
        deliveryId: requestKey,
        alertEventId: notification.contract === replayNotificationContract
            ? notification.metricEventId
            : notification.activity.activityKey,
        alertId: notification.alertId,
        userId: notification.userId,
        recipient: target.recipient,
        recipientHash: recipientSha,
        payload: message(notification),
        idempotencyKey: requestKey,
        requestKey,
        locale: 'en',
        timezone: 'UTC',
    };
};

const authorize = async (
    key: string,
    channel: NotificationChannel,
    deps: ReplaySendDeps,
    timer: ReplaySendTimer
): Promise<AuthResult> => {
    const view = await deps.getView(key);
    if (!view) return { reason: 'notification_missing' };
    if (!validView(view, key)) return { reason: 'cut_invalid' };
    let permit: ReplaySendPermit;
    try {
        permit = normalizeReplaySendPermit(await deps.getPermit());
    } catch {
        return { reason: 'permit_invalid' };
    }
    const now = timer.nowMs();
    if (!Number.isSafeInteger(now)
        || now < Date.parse(permit.issuedAt)
        || now > Date.parse(permit.expiresAt)) return { reason: 'permit_inactive' };
    if (permit.sourceReplaySha256 !== view.sourceReplaySha256
        || permit.runId !== view.runId
        || permit.epoch !== view.epoch
        || permit.modelSha256 !== view.modelSha256) return { reason: 'permit_mismatch' };
    const target = permit.targets.find((item) =>
        item.notificationKey === key && item.channel === channel);
    if (!target) return { reason: 'target_missing' };
    const input = sendInput(view.notification, target, permit.permitSha256);
    return { value: {
        permit,
        context: Object.freeze({
            sourceReplaySha256: view.sourceReplaySha256,
            runId: view.runId,
            epoch: view.epoch,
            modelSha256: view.modelSha256,
            permitSha256: permit.permitSha256,
            recipientHash: input.recipientHash,
        }),
        input,
    } };
};

const receipt = (
    key: string,
    channel: NotificationChannel,
    status: ReplaySendResult['status'],
    attempts: readonly ReplaySendAttempt[],
    reason?: ReplaySendReason,
    context?: ReplaySendResult['context']
): ReplaySendResult => Object.freeze({
    contract: replaySendResultContract,
    notificationKey: key,
    channel,
    status,
    ...(reason ? { reason } : {}),
    ...(context ? { context } : {}),
    attemptCount: attempts.length,
    attempts: Object.freeze([...attempts]),
});

const attempt = (
    seq: number,
    attemptedAt: string,
    result: ProviderSendResult,
    retryMs?: number
): ReplaySendAttempt => Object.freeze({
    seq,
    attemptedAt,
    outcome: result.kind === 'accepted'
        ? 'accepted'
        : result.kind === 'permanent_failure'
            ? 'permanent'
            : result.effect === 'unknown' ? 'ambiguous' : 'retryable',
    ...(result.kind === 'accepted' || !result.errorCode ? {} : { errorCode: result.errorCode }),
    ...(retryMs === undefined ? {} : { retryDelayMs: retryMs }),
});

export const sendReplayNotification = async (
    key: string,
    channel: NotificationChannel,
    deps: ReplaySendDeps
): Promise<ReplaySendResult> => {
    const timer = deps.timer ?? systemTimer;
    if (deps.provider.replayMode !== 'local_fixture' || deps.provider.channel !== channel) {
        return receipt(key, channel, 'fenced', [], 'provider_unavailable');
    }
    const attempts: ReplaySendAttempt[] = [];
    let first: Auth | undefined;
    for (let seq = 1; seq <= attemptsMax; seq += 1) {
        const auth = await authorize(key, channel, deps, timer);
        if ('reason' in auth) {
            return receipt(
                key, channel, 'fenced', attempts,
                first ? 'permit_changed' : auth.reason, first?.context
            );
        }
        first ??= auth.value;
        if (auth.value.context.permitSha256 !== first.context.permitSha256
            || auth.value.context.recipientHash !== first.context.recipientHash) {
            return receipt(key, channel, 'fenced', attempts, 'permit_changed', first.context);
        }
        let configured = false;
        try {
            configured = deps.provider.isConfigured();
        } catch {
            configured = false;
        }
        if (!configured) {
            return receipt(key, channel, 'fenced', attempts, 'provider_unavailable', first.context);
        }
        const now = timer.nowMs();
        if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) {
            return receipt(key, channel, 'fenced', attempts, 'permit_inactive', first.context);
        }
        let providerResult: ProviderSendResult;
        try {
            providerResult = await deps.provider.send(auth.value.input);
        } catch (error) {
            providerResult = {
                kind: 'retryable_failure',
                effect: 'unknown',
                errorCode: error instanceof Error ? error.name : 'provider_error',
                errorMessage: 'Fixture provider threw before recording a result',
            };
        }
        const attemptedAt = new Date(now).toISOString();
        if (providerResult.kind === 'accepted') {
            attempts.push(attempt(seq, attemptedAt, providerResult));
            return receipt(key, channel, 'sent', attempts, undefined, first.context);
        }
        if (providerResult.kind === 'permanent_failure') {
            attempts.push(attempt(seq, attemptedAt, providerResult));
            return receipt(key, channel, 'failed', attempts, undefined, first.context);
        }
        if (providerResult.effect === 'unknown') {
            attempts.push(attempt(seq, attemptedAt, providerResult));
            return receipt(key, channel, 'ambiguous', attempts, undefined, first.context);
        }
        if (seq === attemptsMax) {
            attempts.push(attempt(seq, attemptedAt, providerResult));
            return receipt(key, channel, 'failed', attempts, 'attempts_exhausted', first.context);
        }
        const retryMs = retryDelayMs(
            seq, providerResult.retryAfterMs, retryBaseMs, retryMaxMs, timer.random
        );
        attempts.push(attempt(seq, attemptedAt, providerResult, retryMs));
        if (timer.nowMs() + retryMs > Date.parse(first.permit.expiresAt)) {
            return receipt(key, channel, 'fenced', attempts, 'permit_inactive', first.context);
        }
        await timer.wait(retryMs);
    }
    throw new Error('Replay send attempt bound failed');
};
