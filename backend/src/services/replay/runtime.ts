import type { MetricReplay } from '../marketData/metricReplay';
import {
    CheckpointStore,
    ReplaySessionStore,
    type SessionKey,
} from './checkpointStore';
import {
    ReplayCoordinator,
    type ReplayDeltaResult,
    type ReplayEvent,
    type ReplaySnapshot,
} from './coordinator';
import {
    ReplayPaperBroker,
    type PaperFact,
    type PaperOrder,
} from './paperBroker';
import {
    projectPaperPortfolio,
    type PaperPortfolio,
} from './paperPortfolio';
import {
    projectReplayParticipants,
    type ReplayParticipants,
} from './participants';
import { normalizeModel, type PaperModel } from './paperTypes';
import { ReplayProjection, type ProjectionView } from './projection';
import {
    normalizeReplayAlertModel,
    projectReplayNotifications,
    type ReplayAlertModel,
    type ReplayNotificationPage,
} from './replayAlerts';
import {
    replayWalletPage,
    type ReplayWalletPage,
} from './replayWallet';
import { ReplayScheduler } from './scheduler';
import { createReplaySession } from './sessionCheckpoint';
import {
    projectWalletPortfolio,
    type WalletPortfolio,
} from './walletPortfolio';

const deniedEnv = [
    'ALLOW_LIVE_SUBMISSION',
    'AWS_ACCESS_KEY_ID',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_PROFILE',
    'AWS_ROLE_ARN',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_SESSION_TOKEN',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'BOT_GATEWAY_ENABLED',
    'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
    'CORE_DATABASE_URL',
    'DATABASE_URL',
    'DISCORD_BOT_TOKEN',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'HELIUS_API_KEY',
    'HELIUS_API_URL',
    'JUPITER_API_KEY',
    'JUPITER_API_URL',
    'MARKET_DATABASE_URL',
    'ORDER_MODE',
    'REDIS_URL',
    'SOLANA_RPC_URL',
    'TELEGRAM_BOT_TOKEN',
    'TRADING_MODE',
    'TX_KMS_KEY_ID',
    'WALLET_TRACKING_MODE',
] as const;

export interface ReplayState {
    readonly tokenMint: string;
    readonly solUsd: number | null;
    readonly busy: boolean;
    readonly mutating: boolean;
    readonly failure: string | null;
    readonly snapshot: ReplaySnapshot;
    readonly projection: ProjectionView;
    readonly paper: {
        readonly modelSha256: string;
        readonly orderCount: number;
        readonly factCount: number;
    };
    readonly alerts: {
        readonly modelSha256: string;
        readonly definitionCount: number;
    };
}

export interface SavedReplay {
    readonly key: SessionKey;
    readonly state: ReplayState;
}

interface ActiveRun {
    readonly abort: AbortController;
    readonly done: Promise<ReplayState>;
}

export const assertReplayIsolation = (
    source: Readonly<Record<string, string | undefined>>
): void => {
    const found = deniedEnv.filter((name) => source[name]?.trim());
    if (found.length > 0) {
        throw new Error(`Replay runtime refuses external dependency environment: ${found.join(', ')}`);
    }
};

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export class ReplayRuntime {
    private readonly coordinator: ReplayCoordinator;
    private readonly replay: MetricReplay;
    private readonly paperModel: PaperModel;
    private readonly alertModel: ReplayAlertModel;
    private projection: ReplayProjection;
    private paper: ReplayPaperBroker;
    private active: ActiveRun | null = null;
    private mutating = false;
    private failure: string | null = null;
    private sessionSeq = -1;
    private parentSha: string | null = null;
    private readonly trades: MetricReplay['sourceTrades'];

    private constructor(
        replay: MetricReplay,
        runId: string,
        private readonly store: CheckpointStore,
        private readonly sessions: ReplaySessionStore,
        paperModel: unknown,
        alertModel?: unknown
    ) {
        this.replay = replay;
        this.coordinator = new ReplayCoordinator(replay, runId);
        this.trades = replay.sourceTrades;
        this.projection = ReplayProjection.start(this.coordinator);
        this.paperModel = normalizeModel(paperModel);
        this.alertModel = normalizeReplayAlertModel(
            alertModel, replay.source.replaySha256, replay.source.mint
        );
        this.paper = new ReplayPaperBroker(this.coordinator.snapshot(), this.paperModel);
    }

    static async open(
        replay: MetricReplay,
        runId: string,
        store: CheckpointStore,
        sessions: ReplaySessionStore,
        paperModel: unknown,
        alertModel?: unknown
    ): Promise<ReplayRuntime> {
        const runtime = new ReplayRuntime(
            replay, runId, store, sessions, paperModel, alertModel
        );
        await runtime.restoreLatest();
        return runtime;
    }

    state(): ReplayState {
        const replayNow = this.coordinator.snapshot();
        return {
            tokenMint: this.coordinator.tokenMint,
            solUsd: this.solUsd(replayNow.now),
            busy: this.active !== null,
            mutating: this.mutating,
            failure: this.failure,
            snapshot: replayNow,
            projection: this.projection.view(),
            paper: {
                modelSha256: this.paper.modelSha256(),
                orderCount: this.paper.orderCount(),
                factCount: this.paper.factCount(),
            },
            alerts: {
                modelSha256: this.alertModel.modelSha256,
                definitionCount: this.alertModel.alerts.length,
            },
        };
    }

    private solUsd(now: string | null): number | null {
        const points = Array.isArray(this.replay.curve) ? this.replay.curve : [];
        if (now === null) return points.find(point => point.solUsd !== undefined)?.solUsd ?? null;
        const nowMs = Date.parse(now);
        let value: number | undefined;
        for (const point of points) {
            if (Date.parse(point.observedAt) > nowMs) break;
            if (point.solUsd !== undefined && Number.isFinite(point.solUsd) && point.solUsd > 0) {
                value = point.solUsd;
            }
        }
        return value ?? points.find(point => point.solUsd !== undefined)?.solUsd ?? null;
    }

    play(speed: unknown): Promise<ReplayState> {
        this.requireIdle();
        this.failure = null;
        const abort = new AbortController();
        const scheduler = new ReplayScheduler(
            this.coordinator,
            (event) => this.apply(event)
        );
        let task: ActiveRun;
        const done = scheduler.run(speed, abort.signal).then(
            () => this.finish(task, null),
            (error) => this.finish(task, error)
        );
        task = { abort, done };
        this.active = task;
        return done;
    }

    async pause(): Promise<ReplayState> {
        await this.mutate(() => this.pauseRun());
        return this.state();
    }

    private async pauseRun(): Promise<void> {
        const task = this.active;
        if (task !== null) {
            task.abort.abort();
            await task.done;
            return;
        }
        if (this.coordinator.currentStatus() === 'running') this.coordinator.pause();
    }

    step(): ReplayState {
        this.requireIdle();
        this.failure = null;
        const event = this.coordinator.step();
        if (event !== undefined) {
            try {
                this.apply(event);
            } catch (error) {
                this.coordinator.stop();
                this.failure = errorText(error);
                throw error;
            }
        }
        return this.state();
    }

    async seek(cursor: number): Promise<ReplayState> {
        const before = this.coordinator.snapshot();
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > before.total) {
            throw new Error('Replay seek cursor is outside the tape');
        }
        await this.mutate(async () => {
            await this.pauseRun();
            if (this.coordinator.currentStatus() === 'stopped') {
                throw new Error('Stopped replay cannot seek');
            }
            this.failure = null;
            const saved = await this.store.nearest(before.sourceReplaySha256, cursor);
            if (saved === null) {
                this.coordinator.seek(0);
                this.projection = ReplayProjection.start(this.coordinator);
            } else {
                this.projection = ReplayProjection.restore(this.coordinator, saved);
            }
            if (this.coordinator.snapshot().cursor < cursor) {
                await new ReplayScheduler(
                    this.coordinator,
                    (event) => this.projection.apply(event)
                ).run('max', undefined, cursor);
            }
            this.paper = new ReplayPaperBroker(this.coordinator.snapshot(), this.paperModel);
        });
        return this.state();
    }

    async checkpoint(): Promise<SavedReplay> {
        const key = await this.mutate(async (): Promise<SessionKey> => {
            if (this.active !== null) {
                throw new Error('Replay control requires a paused run');
            }
            const replay = this.projection.checkpoint(this.coordinator);
            const paper = this.paper.checkpoint(this.coordinator.snapshot());
            const seq = this.sessionSeq + 1;
            const checkpoint = createReplaySession(seq, this.parentSha, replay, paper);
            await this.store.write(replay);
            const key = await this.sessions.write(checkpoint);
            this.sessionSeq = seq;
            this.parentSha = checkpoint.checkpointSha256;
            return key;
        });
        return { key, state: this.state() };
    }

    place(value: unknown): PaperOrder {
        this.requirePaperControl();
        this.failure = null;
        return this.paper.place(value);
    }

    cancel(orderId: string): PaperOrder {
        this.requirePaperControl();
        this.failure = null;
        return this.paper.cancel(orderId);
    }

    orders(after = 0, limit = 100): readonly PaperOrder[] {
        return this.paper.orders(after, limit);
    }

    findOrder(id: string): PaperOrder | undefined {
        return this.paper.findOrder(id);
    }

    facts(after = 0, limit = 100): readonly PaperFact[] {
        return this.paper.facts(after, limit);
    }

    portfolio(): PaperPortfolio {
        const snapshot = this.coordinator.snapshot();
        return projectPaperPortfolio({
            sourceReplaySha256: snapshot.sourceReplaySha256,
            runId: snapshot.runId,
            modelSha256: this.paper.modelSha256(),
        }, this.paper.orders(), this.paper.facts());
    }

    participants(cursor = this.coordinator.snapshot().cursor): ReplayParticipants {
        return projectReplayParticipants(this.coordinator.snapshot(), this.trades, cursor);
    }

    walletTrades(wallet: unknown, afterCursor = 0, limit = 100): ReplayWalletPage {
        return replayWalletPage(
            this.coordinator.snapshot(), this.trades, wallet, afterCursor, limit
        );
    }

    walletPortfolio(wallet: unknown): WalletPortfolio {
        return projectWalletPortfolio(this.coordinator.snapshot(), this.trades, wallet);
    }

    notifications(after = 0, limit = 100): ReplayNotificationPage {
        return projectReplayNotifications(
            this.replay, this.coordinator.snapshot(), this.alertModel, after, limit
        );
    }

    deltas(epoch: number, after: number, limit = 100): ReplayDeltaResult {
        return this.coordinator.deltas(epoch, after, limit);
    }

    async stop(): Promise<ReplayState> {
        await this.mutate(async () => {
            await this.pauseRun();
            if (this.coordinator.currentStatus() !== 'stopped') this.coordinator.stop();
        });
        return this.state();
    }

    private finish(task: ActiveRun, error: unknown): ReplayState {
        if (this.active === task) this.active = null;
        this.failure = error === null ? null : errorText(error);
        return this.state();
    }

    private requireIdle(): void {
        if (this.active !== null || this.mutating) {
            throw new Error('Replay control requires a paused run');
        }
    }

    private async mutate<T>(task: () => T | Promise<T>): Promise<T> {
        if (this.mutating) throw new Error('Replay mutation is already active');
        this.mutating = true;
        try {
            return await task();
        } finally {
            this.mutating = false;
        }
    }

    private requirePaperControl(): void {
        this.requireIdle();
        if (this.coordinator.currentStatus() !== 'paused') {
            throw new Error('Paper order control requires a paused replay');
        }
    }

    private apply(event: ReplayEvent): void {
        this.projection.apply(event);
        this.paper.apply(event);
        if (this.coordinator.currentStatus() === 'complete') {
            this.paper.finish(this.coordinator.snapshot());
        }
    }

    private async restoreLatest(): Promise<void> {
        const snapshot = this.coordinator.snapshot();
        const saved = await this.sessions.latest(snapshot.sourceReplaySha256, snapshot.runId);
        if (saved === null) return;
        this.projection = ReplayProjection.restore(
            this.coordinator,
            saved.replay,
            saved.paper.epoch
        );
        this.paper = ReplayPaperBroker.restore(
            this.coordinator.snapshot(),
            saved.paper,
            this.paperModel
        );
        this.sessionSeq = saved.seq;
        this.parentSha = saved.checkpointSha256;
    }
}
