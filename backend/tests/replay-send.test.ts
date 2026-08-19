import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { MetricReplay } from '../src/services/marketData/metricReplay';
import type {
    NotificationChannel,
    NotificationSendInput,
    ProviderSendResult,
} from '../src/services/notifications/types';
import type { ReplaySnapshot } from '../src/services/replay/coordinator';
import {
    normalizeReplayAlertModel,
    projectReplayNotifications,
    replayAlertModelContract,
    type ReplayNotificationPage,
} from '../src/services/replay/replayAlerts';
import {
    normalizeReplaySendPermit,
    replaySendPermitContract,
    replaySendView,
    sendReplayNotification,
    type ReplaySendMessage,
    type ReplaySendProvider,
    type ReplaySendTimer,
} from '../src/services/replay/replaySend';
import { replayMint, replaySha, replayTape } from './helpers/replayTape';

const servers: LocalSink[] = [];
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const alertId = '11111111-1111-4111-8111-111111111111';
const wallStart = Date.parse('2026-08-19T07:00:00.000Z');

interface FakeReply {
    readonly status?: number;
    readonly retryAfter?: number;
    readonly close?: boolean;
}

interface CapturedRequest {
    readonly path: string;
    readonly body: {
        readonly recipient: string;
        readonly text: string;
        readonly requestKey: string;
    };
}

class LocalSink {
    readonly requests: CapturedRequest[] = [];
    readonly replies: FakeReply[] = [];
    private readonly server: Server;
    private baseUrl = '';

    constructor() {
        this.server = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            request.on('end', () => {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                this.requests.push({ path: request.url ?? '/', body });
                const reply = this.replies.shift() ?? { status: 200 };
                if (reply.close) {
                    request.socket.destroy();
                    return;
                }
                if (reply.retryAfter !== undefined) {
                    response.setHeader('Retry-After', String(reply.retryAfter));
                }
                response.statusCode = reply.status ?? 200;
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({ id: `local-${this.requests.length}` }));
            });
        });
    }

    async start(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => {
                this.server.off('error', reject);
                resolve();
            });
        });
        const address = this.server.address() as AddressInfo;
        this.baseUrl = `http://127.0.0.1:${address.port}`;
        servers.push(this);
    }

    provider(sendChannel: NotificationChannel): ReplaySendProvider {
        const base = new URL(this.baseUrl);
        if (base.hostname !== '127.0.0.1') throw new Error('Fixture sink must use loopback');
        return {
            channel: sendChannel,
            providerName: `local-${sendChannel}`,
            replayMode: 'local_fixture',
            isConfigured: () => true,
            send: async (
                input: NotificationSendInput<ReplaySendMessage>
            ): Promise<ProviderSendResult> => {
                try {
                    const response = await fetch(`${this.baseUrl}/${sendChannel}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            recipient: input.recipient,
                            text: input.payload.text,
                            requestKey: input.requestKey,
                        }),
                    });
                    if (response.ok) {
                        const body = await response.json() as { id?: unknown };
                        return {
                            kind: 'accepted',
                            providerMessageId: typeof body.id === 'string' ? body.id : undefined,
                        };
                    }
                    const retryAfter = Number(response.headers.get('retry-after'));
                    if (response.status === 429 || response.status >= 500) {
                        return {
                            kind: 'retryable_failure',
                            effect: 'none',
                            errorCode: String(response.status),
                            errorMessage: 'Local fixture requested retry',
                            retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0
                                ? retryAfter * 1_000
                                : undefined,
                        };
                    }
                    return {
                        kind: 'permanent_failure',
                        errorCode: String(response.status),
                        errorMessage: 'Local fixture rejected delivery',
                    };
                } catch (error) {
                    return {
                        kind: 'retryable_failure',
                        effect: sendChannel === 'telegram' ? 'unknown' : 'none',
                        errorCode: error instanceof Error ? error.name : 'network_error',
                        errorMessage: 'Local fixture connection failed',
                    };
                }
            },
        };
    }

    async close(): Promise<void> {
        await new Promise<void>((resolve, reject) => this.server.close((error) =>
            error ? reject(error) : resolve()));
    }
}

class TestClock implements ReplaySendTimer {
    readonly waits: number[] = [];
    afterWait?: () => void;

    constructor(private value: number) {}

    nowMs(): number {
        return this.value;
    }

    random(): number {
        return 0;
    }

    wait = async (delayMs: number): Promise<void> => {
        this.waits.push(delayMs);
        this.value += delayMs;
        this.afterWait?.();
    };
}

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

const source = (): MetricReplay => {
    const replay = replayTape(1);
    const trade = {
        ...replay.sourceTrades[0],
        maker: replayMint,
        protocol: 'pump_fun',
        signature: '5'.repeat(88),
        commitment: 'finalized' as const,
    };
    return { ...replay, sourceTrades: [trade], trades: [{ ...trade, ...replay.trades[0] }] };
};

const page = (epoch = 1): ReplayNotificationPage => {
    const replay = source();
    const model = normalizeReplayAlertModel({
        contract: replayAlertModelContract,
        sourceReplaySha256: replaySha,
        alerts: [{
            id: alertId,
            userId,
            tokenMint: replayMint,
            thresholdType: 'price',
            thresholdValue: 100,
            condition: 'above',
            generation: 1,
            policy: 'one_shot',
        }],
    }, replaySha, replayMint);
    const snapshot: ReplaySnapshot = {
        sourceReplaySha256: replaySha,
        runId: 'send-a',
        epoch,
        cursor: 1,
        total: 1,
        status: 'complete',
        now: '2024-11-19T00:00:00.000Z',
    };
    return projectReplayNotifications(replay, snapshot, model, 0, 500);
};

const permit = (
    inbox: ReplayNotificationPage,
    targets: readonly { channel: NotificationChannel; recipient: string }[]
) => ({
    contract: replaySendPermitContract,
    mode: 'historical_replay',
    acknowledgement: 'external_historical_replay',
    sourceReplaySha256: inbox.sourceReplaySha256,
    runId: inbox.runId,
    epoch: inbox.epoch,
    modelSha256: inbox.modelSha256,
    issuedAt: new Date(wallStart - 1_000).toISOString(),
    expiresAt: new Date(wallStart + 10 * 60_000).toISOString(),
    targets: targets.map((target) => ({
        notificationKey: inbox.items[0].notificationKey,
        ...target,
    })),
});

const runner = (
    inbox: () => ReplayNotificationPage,
    permitSource: () => unknown,
    providers: readonly ReplaySendProvider[],
    clock = new TestClock(wallStart)
) => ({
    send: (key: string, sendChannel: NotificationChannel) => {
        const provider = providers.find((candidate) => candidate.channel === sendChannel);
        if (!provider) throw new Error('Test provider is missing');
        return sendReplayNotification(key, sendChannel, {
            getView: (notificationKey) => replaySendView(inbox(), notificationKey),
            getPermit: permitSource,
            provider,
            timer: clock,
        });
    },
});

describe('replay external send guard', () => {
    it('requires an explicit target and sends unmistakably historical fixture messages', async () => {
        const sink = new LocalSink();
        await sink.start();
        const inbox = page();
        const input = permit(inbox, [
            { channel: 'telegram', recipient: 'replay-chat-1' },
            { channel: 'discord', recipient: 'replay-user-1' },
        ]);
        const normalized = normalizeReplaySendPermit(input);
        expect(normalizeReplaySendPermit({
            ...input, targets: [...input.targets].reverse(),
        }).permitSha256).toBe(normalized.permitSha256);

        const send = runner(
            () => inbox,
            () => input,
            [sink.provider('telegram'), sink.provider('discord')]
        );
        const telegram = await send.send(inbox.items[0].notificationKey, 'telegram');
        const discord = await send.send(inbox.items[0].notificationKey, 'discord');

        expect([telegram.status, discord.status]).toEqual(['sent', 'sent']);
        expect(sink.requests).toHaveLength(2);
        expect(sink.requests.every((request) =>
            request.body.text.startsWith('FERVOR REPLAY - HISTORICAL DATA\n')
            && request.body.text.includes(`Corpus: ${replaySha}`)
            && request.body.text.includes('Historical time: 2024-11-19T00:00:00.000Z'))
        ).toBe(true);
        expect(JSON.stringify([telegram, discord])).not.toContain('replay-chat-1');
        expect(JSON.stringify([telegram, discord])).not.toContain('replay-user-1');
    });

    it('does not call a provider without a valid permit and selected destination', async () => {
        const sink = new LocalSink();
        await sink.start();
        const inbox = page();
        const key = inbox.items[0].notificationKey;
        const invalid = runner(() => inbox, () => ({}), [sink.provider('telegram')]);
        await expect(invalid.send(key, 'telegram')).resolves.toMatchObject({
            status: 'fenced', reason: 'permit_invalid', attemptCount: 0,
        });
        const untargeted = runner(
            () => inbox,
            () => permit(inbox, [{ channel: 'discord', recipient: 'replay-user-1' }]),
            [sink.provider('telegram')]
        );
        await expect(untargeted.send(key, 'telegram')).resolves.toMatchObject({
            status: 'fenced', reason: 'target_missing', attemptCount: 0,
        });
        const wrongEpoch = permit(
            inbox, [{ channel: 'telegram', recipient: 'replay-chat-1' }]
        );
        const mismatched = runner(
            () => inbox,
            () => ({ ...wrongEpoch, epoch: wrongEpoch.epoch + 1 }),
            [sink.provider('telegram')]
        );
        await expect(mismatched.send(key, 'telegram')).resolves.toMatchObject({
            status: 'fenced', reason: 'permit_mismatch', attemptCount: 0,
        });
        expect(sink.requests).toHaveLength(0);
    });

    it('honors Retry-After and rechecks authority before retrying', async () => {
        const sink = new LocalSink();
        await sink.start();
        sink.replies.push({ status: 429, retryAfter: 2 }, { status: 200 });
        const inbox = page();
        const clock = new TestClock(wallStart);
        const send = runner(
            () => inbox,
            () => permit(inbox, [{ channel: 'discord', recipient: 'replay-user-1' }]),
            [sink.provider('discord')],
            clock
        );
        await expect(send.send(inbox.items[0].notificationKey, 'discord')).resolves.toMatchObject({
            status: 'sent',
            attemptCount: 2,
            attempts: [{ outcome: 'retryable', retryDelayMs: 2_000 }, { outcome: 'accepted' }],
        });
        expect(clock.waits).toEqual([2_000]);
        expect(sink.requests).toHaveLength(2);
    });

    it('fences a delayed retry after the replay seeks to a new epoch', async () => {
        const sink = new LocalSink();
        await sink.start();
        sink.replies.push({ status: 503 }, { status: 200 });
        let inbox = page(1);
        const key = inbox.items[0].notificationKey;
        const permitted = permit(inbox, [{ channel: 'discord', recipient: 'replay-user-1' }]);
        const clock = new TestClock(wallStart);
        clock.afterWait = () => { inbox = page(2); };
        const send = runner(
            () => inbox,
            () => permitted,
            [sink.provider('discord')],
            clock
        );
        await expect(send.send(key, 'discord')).resolves.toMatchObject({
            status: 'fenced', reason: 'permit_changed', attemptCount: 1,
        });
        expect(sink.requests).toHaveLength(1);
    });

    it('fences a retry when the destination is removed from the permit', async () => {
        const sink = new LocalSink();
        await sink.start();
        sink.replies.push({ status: 503 }, { status: 200 });
        const inbox = page();
        let current: unknown = permit(inbox, [
            { channel: 'discord', recipient: 'replay-user-1' },
            { channel: 'telegram', recipient: 'replay-chat-1' },
        ]);
        const clock = new TestClock(wallStart);
        clock.afterWait = () => {
            const value = current as ReturnType<typeof permit>;
            current = {
                ...value,
                targets: value.targets.filter((target) => target.channel !== 'discord'),
            };
        };
        const send = runner(
            () => inbox,
            () => current,
            [sink.provider('discord')],
            clock
        );
        await expect(send.send(inbox.items[0].notificationKey, 'discord')).resolves.toMatchObject({
            status: 'fenced', reason: 'permit_changed', attemptCount: 1,
        });
        expect(sink.requests).toHaveLength(1);
    });

    it('never retries an ambiguous effect and bounds retry-safe failures', async () => {
        const ambiguousSink = new LocalSink();
        await ambiguousSink.start();
        ambiguousSink.replies.push({ close: true });
        const inbox = page();
        const telegramPermit = permit(
            inbox, [{ channel: 'telegram', recipient: 'replay-chat-1' }]
        );
        const ambiguous = runner(
            () => inbox,
            () => telegramPermit,
            [ambiguousSink.provider('telegram')]
        );
        await expect(ambiguous.send(
            inbox.items[0].notificationKey, 'telegram'
        )).resolves.toMatchObject({
            status: 'ambiguous', attemptCount: 1,
            attempts: [{ outcome: 'ambiguous' }],
        });
        expect(ambiguousSink.requests).toHaveLength(1);

        const rejectedSink = new LocalSink();
        await rejectedSink.start();
        rejectedSink.replies.push({ status: 403 });
        const rejected = runner(
            () => inbox,
            () => telegramPermit,
            [rejectedSink.provider('telegram')]
        );
        await expect(rejected.send(
            inbox.items[0].notificationKey, 'telegram'
        )).resolves.toMatchObject({
            status: 'failed', attemptCount: 1,
            attempts: [{ outcome: 'permanent', errorCode: '403' }],
        });
        expect(rejectedSink.requests).toHaveLength(1);

        const retrySink = new LocalSink();
        await retrySink.start();
        retrySink.replies.push({ status: 503 }, { status: 503 }, { status: 503 });
        const discordPermit = permit(
            inbox, [{ channel: 'discord', recipient: 'replay-user-1' }]
        );
        const exhausted = runner(
            () => inbox,
            () => discordPermit,
            [retrySink.provider('discord')]
        );
        await expect(exhausted.send(
            inbox.items[0].notificationKey, 'discord'
        )).resolves.toMatchObject({
            status: 'failed', reason: 'attempts_exhausted', attemptCount: 3,
        });
        expect(retrySink.requests).toHaveLength(3);
    });
});
