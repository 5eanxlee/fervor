import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ReplayGatewayError, type ReplayGateway } from '../replay/replayGateway';
import { metrics } from '../metrics';
import {
    rtContract,
    type RtControl,
    type RtDelta,
    type RtFrame,
    type RtHello,
    type RtSnapshot,
    type RtStream,
} from './protocol';

export const replayStreams = ['trade', 'market', 'replay'] as const satisfies readonly RtStream[];

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const time = z.string().datetime({ offset: true });
const sessionSchema = z.object({
    id: hash,
    sourceReplaySha256: hash,
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    now: time.nullable(),
}).passthrough();
const replayStateSchema = z.object({
    tokenMint: address,
    busy: z.boolean(),
    mutating: z.boolean(),
    failure: z.string().nullable(),
    snapshot: z.object({
        runId: z.string(),
        epoch: z.number().int(),
        sourceReplaySha256: hash,
        cursor: z.number().int().min(0),
        total: z.number().int().min(0),
        status: z.enum(['paused', 'running', 'complete', 'stopped']),
        now: time.nullable(),
    }).strict(),
    projection: z.unknown(),
    paper: z.unknown(),
    alerts: z.unknown(),
}).strict();
const snapshotSchema = z.object({
    success: z.literal(true),
    contract: z.literal('fervor-replay-api-v1'),
    mode: z.literal('historical_replay'),
    session: sessionSchema,
    data: z.object({ state: replayStateSchema }).strict(),
}).strict();
const tradeSchema = z.object({
    kind: z.literal('trade'),
    idempotencyKey: z.string().min(1).max(256),
    tokenMint: address,
    observedAt: time,
}).passthrough();
const replayEventSchema = z.object({
    runId: z.string(),
    epoch: z.number().int(),
    sourceReplaySha256: hash,
    cursor: z.number().int().min(0),
    usdPriced: z.boolean(),
    trade: tradeSchema,
}).strict();
const pageSchema = z.object({
    contract: z.literal('fervor-replay-delta-v1'),
    sourceReplaySha256: hash,
    runId: z.string(),
    epoch: z.number().int(),
    after: z.number().int().min(0),
    cutCursor: z.number().int().min(0),
    cutAt: time.nullable(),
    next: z.number().int().min(0).nullable(),
    items: z.array(replayEventSchema).max(500),
}).strict();
const deltaSchema = z.object({
    success: z.literal(true),
    contract: z.literal('fervor-replay-api-v1'),
    mode: z.literal('historical_replay'),
    session: sessionSchema,
    data: z.object({ page: pageSchema }).strict(),
}).strict();

type ReplayState = z.infer<typeof replayStateSchema>;
type FeedListener = (frame: RtFrame) => void;

interface FeedCut {
    readonly sessionId: string;
    readonly sourceSha: string;
    readonly runId: string;
    readonly epoch: number;
    readonly cursor: number;
    readonly now: string | null;
    readonly state: ReplayState;
}

export interface ReplayResume {
    readonly sessionId: string;
    readonly epoch: number;
    readonly cursors: Readonly<Partial<Record<RtStream, string>>>;
}

export interface ReplaySeed {
    readonly frames: readonly RtFrame[];
    readonly resumed: boolean;
}

export interface ReplayFeedConfig {
    readonly pollMs: number;
    readonly resumeEvents: number;
    readonly heartbeatMs: number;
    readonly maxSubs: number;
}

const defaultConfig: ReplayFeedConfig = {
    pollMs: 20,
    resumeEvents: 20_000,
    heartbeatMs: 15_000,
    maxSubs: 32,
};

export class ReplayFeedError extends Error {
    constructor(message: string, readonly retryable = true) {
        super(message);
        this.name = 'ReplayFeedError';
    }
}

const now = (): string => new Date().toISOString();
const cursorOf = (value: number): string => String(value);
const stateCursor = (state: ReplayState): string => `r:${createHash('sha256')
    .update(JSON.stringify({
        busy: state.busy,
        mutating: state.mutating,
        failure: state.failure,
        snapshot: state.snapshot,
        paper: state.paper,
        alerts: state.alerts,
    }))
    .digest('hex')}`;
const cutCursor = (cut: FeedCut, stream: (typeof replayStreams)[number]): string =>
    stream === 'replay' ? stateCursor(cut.state) : cursorOf(cut.cursor);
const feedError = (error: unknown): ReplayFeedError => {
    if (error instanceof ReplayFeedError) return error;
    if (error instanceof ReplayGatewayError) {
        return new ReplayFeedError('Historical replay gateway failed', error.retryable);
    }
    return new ReplayFeedError('Historical replay feed returned invalid data', false);
};

export class ReplayFeed {
    readonly enabled: boolean;
    readonly ownerId?: string;
    private readonly config: ReplayFeedConfig;
    private readonly listeners = new Set<FeedListener>();
    private readonly history: RtDelta[] = [];
    private readonly heads: Record<(typeof replayStreams)[number], string> = {
        trade: '0',
        market: '0',
        replay: '0',
    };
    private base?: FeedCut;
    private opening?: Promise<void>;
    private syncing?: Promise<void>;
    private timer?: NodeJS.Timeout;
    private closed = false;
    private failures = 0;

    constructor(
        private readonly gateway: ReplayGateway,
        config: Partial<ReplayFeedConfig> = {}
    ) {
        this.enabled = gateway.enabled;
        this.ownerId = gateway.ownerId;
        this.config = { ...defaultConfig, ...config };
        if (!Number.isSafeInteger(this.config.pollMs) || this.config.pollMs < 5
            || !Number.isSafeInteger(this.config.resumeEvents) || this.config.resumeEvents < 500
            || !Number.isSafeInteger(this.config.heartbeatMs) || this.config.heartbeatMs < 1_000
            || !Number.isSafeInteger(this.config.maxSubs) || this.config.maxSubs < 1) {
            throw new Error('Realtime replay feed limits are invalid');
        }
    }

    async ready(): Promise<void> {
        if (!this.enabled) throw new ReplayFeedError('Historical replay is unavailable', false);
        if (this.closed) throw new ReplayFeedError('Historical replay feed is closed', false);
        this.opening ??= this.open().catch((error) => {
            this.opening = undefined;
            throw feedError(error);
        });
        return this.opening;
    }

    hello(): RtHello {
        const cut = this.requireBase();
        return {
            contract: rtContract,
            type: 'hello',
            mode: 'historical_replay',
            sessionId: cut.sessionId,
            epoch: cut.epoch,
            sentAt: now(),
            heartbeatMs: this.config.heartbeatMs,
            maxSubs: this.config.maxSubs,
        };
    }

    supports(tokenMint: string, streams: readonly RtStream[]): boolean {
        const cut = this.requireBase();
        return tokenMint === cut.state.tokenMint
            && streams.every((stream) => (replayStreams as readonly RtStream[]).includes(stream));
    }

    seed(streams: readonly RtStream[], resume?: ReplayResume): ReplaySeed {
        const cut = this.requireBase();
        if (!this.supports(cut.state.tokenMint, streams)) {
            throw new ReplayFeedError('Realtime replay subscription is unavailable', false);
        }
        if (resume
            && resume.sessionId === cut.sessionId
            && resume.epoch === cut.epoch) {
            const resumed = this.paths(streams, resume.cursors);
            if (resumed !== null) return { frames: resumed, resumed: true };
        }

        const snapshot = this.snapshot(streams, cut);
        const tail = this.paths(streams, Object.fromEntries(
            streams.map((stream) => [
                stream,
                cutCursor(cut, stream as (typeof replayStreams)[number]),
            ])
        ));
        if (tail === null) {
            throw new ReplayFeedError('Realtime replay snapshot is outside the resume window');
        }
        const frames: RtFrame[] = [];
        if (resume) frames.push(this.resync('resume_window_missed', cut));
        frames.push(snapshot, ...tail);
        return { frames, resumed: false };
    }

    watch(listener: FeedListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async sync(): Promise<void> {
        await this.ready();
        this.syncing ??= this.pull().finally(() => {
            this.syncing = undefined;
        });
        return this.syncing;
    }

    async close(): Promise<void> {
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        await this.syncing?.catch(() => undefined);
        this.listeners.clear();
    }

    private async open(): Promise<void> {
        this.base = await this.loadSnapshot();
        for (const stream of replayStreams) this.heads[stream] = cutCursor(this.base, stream);
        this.schedule(0);
    }

    private async pull(): Promise<void> {
        const started = process.hrtime.bigint();
        try {
            for (let pageCount = 0; pageCount < 32 && !this.closed; pageCount += 1) {
                const cut = this.requireBase();
                const after = Number(this.heads.trade);
                const used = after - cut.cursor;
                if (used >= this.config.resumeEvents) {
                    if (await this.refreshExact()) continue;
                    break;
                }
                const limit = Math.min(500, this.config.resumeEvents - used);
                const reply = await this.gateway.call({
                    method: 'GET',
                    resource: 'deltas',
                    query: `?epoch=${cut.epoch}&after=${after}&limit=${limit}`,
                });
                if (reply.status === 409) {
                    await this.rebase('upstream_resync');
                    break;
                }
                if (reply.status !== 200) {
                    throw new ReplayFeedError('Historical replay delta request failed');
                }
                const envelope = deltaSchema.parse(reply.body);
                const page = envelope.data.page;
                this.assertPage(envelope.session, page, cut, after, limit);
                for (const event of page.items) this.accept(event);
                if (page.next === null) {
                    await this.refreshExact();
                    break;
                }
            }
            this.failures = 0;
            metrics.gauge('fervor_rt_replay_up', 1);
        } catch (error) {
            this.failures += 1;
            metrics.gauge('fervor_rt_replay_up', 0);
            metrics.increment('fervor_rt_replay_errors');
            throw feedError(error);
        } finally {
            metrics.observe(
                'fervor_rt_replay_sync_ms',
                Number(process.hrtime.bigint() - started) / 1_000_000
            );
        }
    }

    private async loadSnapshot(): Promise<FeedCut> {
        const reply = await this.gateway.call({ method: 'GET', resource: 'snapshot' });
        if (reply.status !== 200) throw new ReplayFeedError('Historical replay snapshot failed');
        const envelope = snapshotSchema.parse(reply.body);
        const state = envelope.data.state;
        const snapshot = state.snapshot;
        if (snapshot.runId !== envelope.session.runId
            || snapshot.epoch !== envelope.session.epoch
            || snapshot.sourceReplaySha256 !== envelope.session.sourceReplaySha256
            || snapshot.cursor !== envelope.session.cursor
            || snapshot.now !== envelope.session.now
            || snapshot.cursor > snapshot.total) {
            throw new ReplayFeedError('Historical replay snapshot identity differs', false);
        }
        return Object.freeze({
            sessionId: envelope.session.id,
            sourceSha: envelope.session.sourceReplaySha256,
            runId: envelope.session.runId,
            epoch: envelope.session.epoch,
            cursor: envelope.session.cursor,
            now: envelope.session.now,
            state,
        });
    }

    private async refreshExact(): Promise<boolean> {
        const next = await this.loadSnapshot();
        const prior = this.requireBase();
        if (next.sessionId !== prior.sessionId
            || next.sourceSha !== prior.sourceSha
            || next.runId !== prior.runId
            || next.state.tokenMint !== prior.state.tokenMint) {
            throw new ReplayFeedError('Historical replay source identity changed', false);
        }
        if (next.epoch !== prior.epoch) {
            await this.applyRebase(next, 'epoch_changed');
            return true;
        }
        if (next.cursor !== Number(this.heads.trade)) return false;

        this.pushState('market', cursorOf(next.cursor), next.now, next.state.projection);
        this.pushState('replay', stateCursor(next.state), next.now, {
            busy: next.state.busy,
            mutating: next.state.mutating,
            failure: next.state.failure,
            snapshot: next.state.snapshot,
            paper: next.state.paper,
            alerts: next.state.alerts,
        });
        this.base = next;
        this.trimHistory();
        return true;
    }

    private async rebase(reason: string): Promise<void> {
        await this.applyRebase(await this.loadSnapshot(), reason);
    }

    private async applyRebase(next: FeedCut, reason: string): Promise<void> {
        const prior = this.base;
        if (prior && (next.sessionId !== prior.sessionId
            || next.sourceSha !== prior.sourceSha
            || next.runId !== prior.runId
            || next.state.tokenMint !== prior.state.tokenMint)) {
            throw new ReplayFeedError('Historical replay source identity changed', false);
        }
        this.base = next;
        for (const stream of replayStreams) this.heads[stream] = cutCursor(next, stream);
        this.history.length = 0;
        if (!prior) return;
        this.emit(this.resync(reason, next));
        this.emit(this.snapshot(replayStreams, next));
    }

    private accept(event: z.infer<typeof replayEventSchema>): void {
        const cut = this.requireBase();
        const expected = Number(this.heads.trade);
        if (event.runId !== cut.runId
            || event.epoch !== cut.epoch
            || event.sourceReplaySha256 !== cut.sourceSha
            || event.cursor !== expected
            || event.trade.tokenMint !== cut.state.tokenMint) {
            throw new ReplayFeedError('Historical replay delta sequence differs', false);
        }
        const frame: RtDelta = Object.freeze({
            contract: rtContract,
            type: 'delta',
            mode: 'historical_replay',
            sessionId: cut.sessionId,
            epoch: cut.epoch,
            sentAt: now(),
            stream: 'trade',
            delivery: 'ordered',
            cursor: cursorOf(event.cursor + 1),
            prior: cursorOf(event.cursor),
            scope: { tokenMint: event.trade.tokenMint },
            observedAt: event.trade.observedAt,
            data: event.trade,
        });
        this.heads.trade = frame.cursor;
        this.record(frame);
        this.emit(frame);
    }

    private pushState(
        stream: 'market' | 'replay',
        cursor: string,
        observedAt: string | null,
        data: unknown
    ): void {
        const cut = this.requireBase();
        const next = cursor;
        const prior = this.heads[stream];
        if (next === prior) return;
        const frame: RtDelta = Object.freeze({
            contract: rtContract,
            type: 'delta',
            mode: 'historical_replay',
            sessionId: cut.sessionId,
            epoch: cut.epoch,
            sentAt: now(),
            stream,
            delivery: 'state',
            cursor: next,
            prior,
            scope: { tokenMint: cut.state.tokenMint },
            observedAt,
            data,
        });
        this.heads[stream] = next;
        this.record(frame);
        this.emit(frame);
    }

    private snapshot(streams: readonly RtStream[], cut: FeedCut): RtSnapshot {
        const selected = new Set(streams);
        return {
            contract: rtContract,
            type: 'snapshot',
            mode: 'historical_replay',
            sessionId: cut.sessionId,
            epoch: cut.epoch,
            sentAt: now(),
            cut: Object.fromEntries(streams.map((stream) => [
                stream,
                cutCursor(cut, stream as (typeof replayStreams)[number]),
            ])),
            data: {
                tokenMint: cut.state.tokenMint,
                ...(selected.has('trade') ? { trade: cut.state.snapshot } : {}),
                ...(selected.has('market') ? { market: cut.state.projection } : {}),
                ...(selected.has('replay') ? { replay: {
                    busy: cut.state.busy,
                    mutating: cut.state.mutating,
                    failure: cut.state.failure,
                    snapshot: cut.state.snapshot,
                    paper: cut.state.paper,
                    alerts: cut.state.alerts,
                } } : {}),
            },
        };
    }

    private resync(reason: string, cut: FeedCut): RtControl {
        return {
            contract: rtContract,
            type: 'control',
            mode: 'historical_replay',
            sessionId: cut.sessionId,
            epoch: cut.epoch,
            sentAt: now(),
            code: 'resync_required',
            reason,
            cut: Object.fromEntries(replayStreams.map((stream) => [stream, cutCursor(cut, stream)])),
        };
    }

    private paths(
        streams: readonly RtStream[],
        cursors: Readonly<Partial<Record<RtStream, string>>>
    ): RtDelta[] | null {
        const wanted = new Map<RtStream, Set<RtDelta>>();
        for (const stream of streams) {
            const start = cursors[stream];
            if (start === undefined) return null;
            const target = this.heads[stream as keyof typeof this.heads];
            if (target === undefined) return null;
            let prior = start;
            const chain = new Set<RtDelta>();
            for (const frame of this.history) {
                if (frame.stream !== stream || frame.prior !== prior) continue;
                chain.add(frame);
                prior = frame.cursor;
                if (prior === target) break;
            }
            if (prior !== target) return null;
            wanted.set(stream, chain);
        }
        return this.history.filter((frame) => wanted.get(frame.stream)?.has(frame));
    }

    private assertPage(
        session: z.infer<typeof sessionSchema>,
        page: z.infer<typeof pageSchema>,
        cut: FeedCut,
        after: number,
        limit: number
    ): void {
        const end = after + page.items.length;
        if (session.id !== cut.sessionId
            || session.sourceReplaySha256 !== cut.sourceSha
            || session.runId !== cut.runId
            || session.epoch !== cut.epoch
            || session.cursor !== page.cutCursor
            || session.now !== page.cutAt
            || page.sourceReplaySha256 !== cut.sourceSha
            || page.runId !== cut.runId
            || page.epoch !== cut.epoch
            || page.after !== after
            || page.items.length > limit
            || page.cutCursor < end
            || page.next !== (end < page.cutCursor ? end : null)) {
            throw new ReplayFeedError('Historical replay delta page differs', false);
        }
    }

    private record(frame: RtDelta): void {
        this.history.push(frame);
        this.trimHistory();
    }

    private trimHistory(): void {
        while (this.history.length > this.config.resumeEvents) this.history.shift();
    }

    private emit(frame: RtFrame): void {
        for (const listener of this.listeners) listener(frame);
    }

    private schedule(delay: number): void {
        if (this.closed || this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.sync().catch(() => undefined).finally(() => {
                const backoff = Math.min(1_000, this.config.pollMs * 2 ** Math.min(this.failures, 6));
                this.schedule(this.failures === 0 ? this.config.pollMs : backoff);
            });
        }, delay);
        this.timer.unref();
    }

    private requireBase(): FeedCut {
        if (!this.base) throw new ReplayFeedError('Historical replay feed is not ready');
        return this.base;
    }
}
