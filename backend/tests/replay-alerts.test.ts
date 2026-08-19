import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MetricReplay } from '../src/services/marketData/metricReplay';
import {
    CheckpointStore,
    ReplaySessionStore,
} from '../src/services/replay/checkpointStore';
import type { ReplaySnapshot } from '../src/services/replay/coordinator';
import {
    paperModelContract,
    type PaperModelInput,
} from '../src/services/replay/paperBroker';
import {
    normalizeReplayAlertModel,
    projectReplayNotifications,
    replayAlertModelContract,
    replayNotificationContract,
    replayWalletNotificationContract,
    type ReplayMetricNotification,
    type ReplayNotification,
    type ReplayWalletNotification,
} from '../src/services/replay/replayAlerts';
import { replayWalletPage } from '../src/services/replay/replayWallet';
import { ReplayRuntime } from '../src/services/replay/runtime';
import { replayMint, replaySha, replayTape } from './helpers/replayTape';

const tempDirs: string[] = [];
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666',
    '77777777-7777-4777-8777-777777777777',
];
const paperModel: PaperModelInput = {
    contract: paperModelContract,
    latency: { clientMs: 0, buildMs: 0, submitMs: 0 },
    participationBps: 10_000,
    maxLookaheadMs: 60_000,
    priceGuardBps: 0,
    protocolFeeBps: 0,
    fixedFees: [],
    partialFill: 'allow',
};

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const source = (): MetricReplay => {
    const replay = replayTape(4);
    const decorate = (trade: MetricReplay['sourceTrades'][number], index: number) => ({
        ...trade,
        maker: replayMint,
        protocol: 'pump_fun',
        signature: String(index + 5).repeat(88),
        commitment: 'finalized' as const,
    });
    return {
        ...replay,
        sourceTrades: replay.sourceTrades.map(decorate),
        trades: replay.trades.map((trade) => decorate(
            trade,
            replay.sourceTrades.findIndex((sourceTrade) =>
                sourceTrade.idempotencyKey === trade.idempotencyKey)
        )),
    };
};

const modelInput = () => ({
    contract: replayAlertModelContract,
    sourceReplaySha256: replaySha,
    alerts: [
        {
            id: ids[0], userId, tokenMint: replayMint, thresholdType: 'price',
            thresholdValue: 100, condition: 'above', generation: 1, policy: 'one_shot',
        },
        {
            id: ids[1], userId, tokenMint: replayMint, thresholdType: 'price',
            thresholdValue: 200, condition: 'above', generation: 1, policy: 'one_shot',
        },
        {
            id: ids[2], userId, tokenMint: replayMint, thresholdType: 'volume_1m',
            thresholdValue: 20, condition: 'above', generation: 1, policy: 'one_shot',
        },
        {
            id: ids[3], userId, tokenMint: replayMint, thresholdType: 'tx_count_1m',
            thresholdValue: 2, condition: 'above', generation: 1, policy: 'one_shot',
        },
        {
            id: ids[4], userId, tokenMint: replayMint, thresholdType: 'market_cap',
            thresholdValue: 1, condition: 'above', generation: 1, policy: 'one_shot',
        },
    ],
} as const);

const walletModelInput = () => ({
    contract: replayAlertModelContract,
    sourceReplaySha256: replaySha,
    alerts: [
        {
            id: ids[5], userId, tokenMint: replayMint, wallet: replayMint,
            side: 'buy', generation: 1, policy: 'one_shot',
        },
        {
            id: ids[6], userId, tokenMint: replayMint, wallet: replayMint,
            side: 'sell', generation: 1, policy: 'one_shot',
        },
    ],
} as const);

const metricItems = (items: readonly ReplayNotification[]): readonly ReplayMetricNotification[] =>
    items.filter((item): item is ReplayMetricNotification =>
        item.contract === replayNotificationContract);

const walletItems = (items: readonly ReplayNotification[]): readonly ReplayWalletNotification[] =>
    items.filter((item): item is ReplayWalletNotification =>
        item.contract === replayWalletNotificationContract);

const snapshot = (epoch = 1): ReplaySnapshot => ({
    runId: 'alerts-a',
    epoch,
    sourceReplaySha256: replaySha,
    cursor: 4,
    total: 4,
    status: 'complete',
    now: '2024-11-19T00:00:30.000Z',
});

describe('replay alerts', () => {
    it('matches inclusive thresholds once under virtual time and delivers only in-app', () => {
        const replay = source();
        const model = normalizeReplayAlertModel(modelInput(), replaySha, replayMint);
        const page = projectReplayNotifications(replay, snapshot(), model, 0, 500);

        expect(page).toMatchObject({
            definitionCount: 5,
            triggeredCount: 4,
            armedCount: 0,
            unavailableCount: 1,
            unavailableTypes: ['market_cap'],
            next: null,
        });
        const items = metricItems(page.items);
        expect(items.map((item) => ({
            id: item.alertId,
            cursor: item.metricCursor,
            value: item.currentValue,
        }))).toEqual([
            { id: ids[0], cursor: 0, value: 100 },
            { id: ids[2], cursor: 0, value: 20 },
            { id: ids[3], cursor: 1, value: 2 },
            { id: ids[1], cursor: 2, value: 300 },
        ]);
        expect(items[0]).toMatchObject({
            contract: replayNotificationContract,
            matchedAt: '2024-11-19T00:00:00.000Z',
            metricEstimated: true,
            basisCommitment: 'finalized',
            delivery: {
                channel: 'in_app',
                status: 'available',
                attempts: 0,
                external: false,
            },
        });
        expect(new Set(page.items.map((item) => item.notificationKey)).size).toBe(4);

        const middle = projectReplayNotifications(replay, snapshot(), model, 1, 2);
        expect(middle).toMatchObject({ after: 1, next: 3 });
        expect(metricItems(middle.items).map((item) => item.metricCursor)).toEqual([0, 1]);
        expect(middle.notificationsSha256).toBe(page.notificationsSha256);
    });

    it('projects tracked-wallet buys and sells once from owned activity identities', () => {
        const replay = source();
        const model = normalizeReplayAlertModel(walletModelInput(), replaySha, replayMint);
        const empty = projectReplayNotifications(replay, {
            ...snapshot(), cursor: 0, status: 'paused', now: null,
        }, model, 0, 500);
        expect(empty).toMatchObject({
            definitionCount: 2,
            triggeredCount: 0,
            armedCount: 2,
            unavailableCount: 0,
            items: [],
        });

        const first = projectReplayNotifications(replay, snapshot(1), model, 0, 500);
        const items = walletItems(first.items);
        expect(first).toMatchObject({
            definitionCount: 2,
            triggeredCount: 2,
            armedCount: 0,
            unavailableCount: 0,
        });
        expect(items.map((item) => ({
            id: item.alertId,
            watchSide: item.watchSide,
            cursor: item.activity.cursor,
            side: item.activity.side,
            matchedAt: item.matchedAt,
        }))).toEqual([
            {
                id: ids[5], watchSide: 'buy', cursor: 0, side: 'buy',
                matchedAt: '2024-11-19T00:00:00.000Z',
            },
            {
                id: ids[6], watchSide: 'sell', cursor: 1, side: 'sell',
                matchedAt: '2024-11-19T00:00:10.000Z',
            },
        ]);
        expect(items.map((item) => item.activity)).toEqual(
            replayWalletPage(snapshot(), replay.sourceTrades, replayMint, 0, 500).items.slice(0, 2)
        );
        expect(items.every((item) => !item.delivery.external)).toBe(true);

        const next = walletItems(
            projectReplayNotifications(replay, snapshot(2), model, 0, 500).items
        );
        expect(next.map((item) => item.activity.activityKey))
            .toEqual(items.map((item) => item.activity.activityKey));
        expect(next.map((item) => item.notificationKey))
            .not.toEqual(items.map((item) => item.notificationKey));
    });

    it('canonicalizes the model and fences notification identity by replay epoch', () => {
        const replay = source();
        const input = modelInput();
        const model = normalizeReplayAlertModel(input, replaySha, replayMint);
        expect(normalizeReplayAlertModel({
            ...input,
            alerts: [...input.alerts].reverse(),
        }, replaySha, replayMint).modelSha256).toBe(model.modelSha256);

        const first = projectReplayNotifications(replay, snapshot(1), model, 0, 500);
        const next = projectReplayNotifications(replay, snapshot(2), model, 0, 500);
        expect(metricItems(next.items).map((item) => item.metricEventId))
            .toEqual(metricItems(first.items).map((item) => item.metricEventId));
        expect(next.items.map((item) => item.notificationKey))
            .not.toEqual(first.items.map((item) => item.notificationKey));
        expect(() => normalizeReplayAlertModel({
            ...input,
            alerts: [...input.alerts, input.alerts[0]],
        }, replaySha, replayMint)).toThrow('does not match');
        expect(() => normalizeReplayAlertModel({
            ...input,
            sourceReplaySha256: 'f'.repeat(64),
        }, replaySha, replayMint)).toThrow('does not match');
    });

    it('rebuilds notifications from the restored cut and clears them on seek', async () => {
        const temp = await mkdtemp(path.join(os.tmpdir(), 'fervor-alert-runtime-'));
        tempDirs.push(temp);
        const replay = source();
        const store = new CheckpointStore(path.join(temp, 'checkpoints'));
        const sessions = new ReplaySessionStore(store.root);
        const runtime = await ReplayRuntime.open(
            replay, 'alert-runtime', store, sessions, paperModel, modelInput()
        );
        runtime.step();
        runtime.step();
        runtime.step();
        const before = runtime.notifications(0, 500);
        expect(before).toMatchObject({ cutCursor: 3, triggeredCount: 4 });
        await runtime.checkpoint();

        const restored = await ReplayRuntime.open(
            replay, 'alert-runtime', store, sessions, paperModel, modelInput()
        );
        const after = restored.notifications(0, 500);
        expect(metricItems(after.items).map((item) => item.metricEventId))
            .toEqual(metricItems(before.items).map((item) => item.metricEventId));
        expect(after.epoch).toBe(2);
        await restored.seek(0);
        expect(restored.notifications()).toMatchObject({
            cutCursor: 0,
            triggeredCount: 0,
            armedCount: 0,
            unavailableCount: 5,
            items: [],
        });
    });
});
