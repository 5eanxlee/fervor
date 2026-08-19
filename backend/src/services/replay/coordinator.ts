import { createHash } from 'node:crypto';
import { VirtualClock } from '../clock';
import type { NormalizedTradeEvent } from '../../types';
import type { MetricReplay } from '../marketData/metricReplay';
import { hasTradeOrder, tradeOrder } from '../marketData/tradeOrder';

export type ReplayStatus = 'paused' | 'running' | 'complete' | 'stopped';
export const replayCutContract = 'fervor-replay-cut-v1' as const;
export const replayDeltaContract = 'fervor-replay-delta-v1' as const;
export const replayResyncContract = 'fervor-replay-resync-v1' as const;

export interface ReplayEvent {
    readonly runId: string;
    readonly epoch: number;
    readonly sourceReplaySha256: string;
    readonly cursor: number;
    readonly usdPriced: boolean;
    readonly trade: Readonly<NormalizedTradeEvent>;
}

export interface ReplaySnapshot {
    readonly runId: string;
    readonly epoch: number;
    readonly sourceReplaySha256: string;
    readonly cursor: number;
    readonly total: number;
    readonly status: ReplayStatus;
    readonly now: string | null;
}

export interface ReplayCut {
    readonly contract: typeof replayCutContract;
    readonly sourceReplaySha256: string;
    readonly cursor: number;
    readonly now: string | null;
    readonly prefixSha256: string;
}

export interface ReplayHead {
    readonly cut: ReplayCut;
    readonly tradeId: string | null;
    readonly usdTradeId: string | null;
    readonly solTradeId: string | null;
}

export interface ReplayDeltaPage {
    readonly contract: typeof replayDeltaContract;
    readonly sourceReplaySha256: string;
    readonly runId: string;
    readonly epoch: number;
    readonly after: number;
    readonly cutCursor: number;
    readonly cutAt: string | null;
    readonly next: number | null;
    readonly items: readonly ReplayEvent[];
}

export interface ReplayResync {
    readonly contract: typeof replayResyncContract;
    readonly reason: 'epoch_changed' | 'cursor_ahead' | 'cursor_changed' | 'paper_changed';
    readonly sourceReplaySha256: string;
    readonly runId: string;
    readonly requested: Readonly<
        { epoch: number; after: number }
        | { epoch: number; cursor: number; fact?: number }
    >;
    readonly cut: {
        readonly epoch: number;
        readonly cursor: number;
        readonly now: string | null;
        readonly fact?: number;
    };
}

export type ReplayDeltaResult =
    | { readonly page: ReplayDeltaPage; readonly resync?: never }
    | { readonly page?: never; readonly resync: ReplayResync };

const hashPattern = /^[0-9a-f]{64}$/;

export const parseReplayCut = (value: unknown): ReplayCut => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Replay cut is invalid');
    }
    const cut = value as Record<string, unknown>;
    const keys = ['contract', 'sourceReplaySha256', 'cursor', 'now', 'prefixSha256'];
    const validTime = cut.now === null || (typeof cut.now === 'string'
        && Number.isFinite(Date.parse(cut.now))
        && new Date(Date.parse(cut.now)).toISOString() === cut.now);
    if (Object.keys(cut).length !== keys.length
        || keys.some((key) => !Object.prototype.hasOwnProperty.call(cut, key))
        || cut.contract !== replayCutContract
        || typeof cut.sourceReplaySha256 !== 'string'
        || !hashPattern.test(cut.sourceReplaySha256)
        || !Number.isSafeInteger(cut.cursor)
        || (cut.cursor as number) < 0
        || !validTime
        || typeof cut.prefixSha256 !== 'string'
        || !hashPattern.test(cut.prefixSha256)) {
        throw new Error('Replay cut is invalid');
    }
    return Object.freeze({
        contract: replayCutContract,
        sourceReplaySha256: cut.sourceReplaySha256,
        cursor: cut.cursor as number,
        now: cut.now as string | null,
        prefixSha256: cut.prefixSha256,
    });
};

export class ReplayCoordinator {
    private clock = new VirtualClock(0);
    private readonly events: NormalizedTradeEvent[];
    private readonly times: number[] = [];
    private readonly sourceSha: string;
    private epoch = 1;
    private cursor = 0;
    private status: ReplayStatus = 'paused';
    readonly tokenMint: string;

    constructor(replay: MetricReplay, private readonly runId: string) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(runId)) {
            throw new Error('Replay run ID is invalid');
        }
        this.tokenMint = replay.source.mint;
        this.sourceSha = replay.source.replaySha256;
        const enriched = new Map(replay.trades.map((trade) => [trade.idempotencyKey, trade]));
        if (enriched.size !== replay.trades.length) {
            throw new Error('Replay projection contains duplicate trade identities');
        }
        let prior: NormalizedTradeEvent | undefined;
        this.events = replay.sourceTrades.map((source) => {
            const observedMs = Date.parse(source.observedAt);
            if (!hasTradeOrder(source)
                || !Number.isSafeInteger(observedMs)
                || (prior !== undefined && (tradeOrder(prior, source) >= 0
                    || observedMs < Date.parse(prior.observedAt)))) {
                throw new Error('Replay trade tape is not in canonical chain order');
            }
            prior = source;
            this.times.push(observedMs);
            const trade = enriched.get(source.idempotencyKey) ?? source;
            enriched.delete(source.idempotencyKey);
            return trade;
        });
        if (this.events.length !== replay.source.trades || enriched.size > 0) {
            throw new Error('Replay trade tape differs from its verified projection');
        }
    }

    snapshot(): ReplaySnapshot {
        return {
            runId: this.runId,
            epoch: this.epoch,
            sourceReplaySha256: this.sourceSha,
            cursor: this.cursor,
            total: this.events.length,
            status: this.status,
            now: this.cursor === 0 ? null : new Date(this.clock.nowMs()).toISOString(),
        };
    }

    currentStatus(): ReplayStatus {
        return this.status;
    }

    pause(): void {
        if (this.status === 'stopped') throw new Error('Stopped replay cannot be paused');
        if (this.status === 'running') this.status = 'paused';
    }

    resume(): void {
        if (this.status === 'complete' || this.status === 'stopped') {
            throw new Error(`${this.status} replay cannot be resumed`);
        }
        this.status = 'running';
    }

    step(): ReplayEvent | undefined {
        if (this.status === 'complete') return undefined;
        if (this.status !== 'paused') throw new Error('Replay step requires a paused run');
        return this.take();
    }

    next(): ReplayEvent | undefined {
        if (this.status === 'complete') return undefined;
        if (this.status !== 'running') throw new Error('Replay next requires a running run');
        return this.take();
    }

    stop(): void {
        this.status = 'stopped';
    }

    seek(cursor: number): ReplaySnapshot {
        if (this.status === 'stopped') throw new Error('Stopped replay cannot seek');
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.events.length) {
            throw new Error('Replay seek cursor is outside the tape');
        }
        return this.move(cursor, this.epoch);
    }

    cut(): ReplayCut {
        return Object.freeze({
            contract: replayCutContract,
            sourceReplaySha256: this.sourceSha,
            cursor: this.cursor,
            now: this.timeAt(this.cursor),
            prefixSha256: this.prefixHash(this.cursor),
        });
    }

    head(value: unknown): ReplayHead {
        const cut = this.matchCut(value);
        const latest = cut.cursor === 0 ? undefined : this.events[cut.cursor - 1];
        let usdTradeId: string | null = null;
        let solTradeId: string | null = null;
        for (let index = cut.cursor - 1; index >= 0 && (!usdTradeId || !solTradeId); index -= 1) {
            const trade = this.events[index];
            if (!usdTradeId && trade.priceUsd !== undefined && trade.usdAmount !== undefined) {
                usdTradeId = trade.idempotencyKey;
            }
            if (!solTradeId && trade.priceSol !== undefined) solTradeId = trade.idempotencyKey;
        }
        return {
            cut,
            tradeId: latest?.idempotencyKey ?? null,
            usdTradeId,
            solTradeId,
        };
    }

    deltas(epoch: number, after: number, limit: number): ReplayDeltaResult {
        if (!Number.isSafeInteger(epoch) || epoch < 1
            || !Number.isSafeInteger(after) || after < 0
            || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
            throw new Error('Replay delta page is invalid');
        }
        const cut = this.snapshot();
        const reason = epoch !== cut.epoch
            ? 'epoch_changed'
            : after > cut.cursor ? 'cursor_ahead' : null;
        if (reason !== null) {
            return {
                resync: Object.freeze({
                    contract: replayResyncContract,
                    reason,
                    sourceReplaySha256: cut.sourceReplaySha256,
                    runId: cut.runId,
                    requested: Object.freeze({ epoch, after }),
                    cut: Object.freeze({ epoch: cut.epoch, cursor: cut.cursor, now: cut.now }),
                }),
            };
        }
        const end = Math.min(cut.cursor, after + limit);
        const items: ReplayEvent[] = [];
        for (let cursor = after; cursor < end; cursor += 1) {
            items.push(this.eventAt(cursor, cut.epoch));
        }
        return {
            page: Object.freeze({
                contract: replayDeltaContract,
                sourceReplaySha256: cut.sourceReplaySha256,
                runId: cut.runId,
                epoch: cut.epoch,
                after,
                cutCursor: cut.cursor,
                cutAt: cut.now,
                next: end < cut.cursor ? end : null,
                items: Object.freeze(items),
            }),
        };
    }

    restore(value: unknown, afterEpoch: number = this.epoch): ReplaySnapshot {
        if (!Number.isSafeInteger(afterEpoch) || afterEpoch < 1) {
            throw new Error('Replay restore epoch is invalid');
        }
        return this.move(this.matchCut(value).cursor, afterEpoch);
    }

    private matchCut(value: unknown): ReplayCut {
        const cut = parseReplayCut(value);
        if (cut.sourceReplaySha256 !== this.sourceSha
            || cut.cursor > this.events.length
            || cut.now !== this.timeAt(cut.cursor)
            || cut.prefixSha256 !== this.prefixHash(cut.cursor)) {
            throw new Error('Replay cut does not match the verified tape');
        }
        return cut;
    }

    accepts(event: Pick<ReplayEvent, 'runId' | 'epoch' | 'sourceReplaySha256'>): boolean {
        return this.status !== 'stopped'
            && event.runId === this.runId
            && event.epoch === this.epoch
            && event.sourceReplaySha256 === this.sourceSha;
    }

    nextDelayMs(): number | null {
        if (this.cursor === this.events.length || this.status === 'stopped') return null;
        if (this.cursor === 0) return 0;
        return this.times[this.cursor] - this.clock.nowMs();
    }

    private take(): ReplayEvent {
        const event = this.eventAt(this.cursor, this.epoch);
        const trade = event.trade;
        this.clock.advanceTo(this.times[this.cursor]);
        this.cursor += 1;
        if (this.cursor === this.events.length) this.status = 'complete';
        return event;
    }

    private eventAt(cursor: number, epoch: number): ReplayEvent {
        const trade = this.events[cursor];
        return Object.freeze({
            runId: this.runId,
            epoch,
            sourceReplaySha256: this.sourceSha,
            cursor,
            usdPriced: trade.priceUsd !== undefined && trade.usdAmount !== undefined,
            trade,
        });
    }

    private timeAt(cursor: number): string | null {
        return cursor === 0 ? null : new Date(this.times[cursor - 1]).toISOString();
    }

    private move(cursor: number, afterEpoch: number): ReplaySnapshot {
        const epoch = Math.max(this.epoch, afterEpoch);
        if (epoch === Number.MAX_SAFE_INTEGER) throw new Error('Replay epoch is exhausted');
        this.epoch = epoch + 1;
        this.cursor = cursor;
        const nowMs = cursor === 0 ? 0 : this.times[cursor - 1];
        this.clock = new VirtualClock(nowMs);
        this.status = cursor === this.events.length ? 'complete' : 'paused';
        return this.snapshot();
    }

    private prefixHash(cursor: number): string {
        const hash = createHash('sha256');
        hash.update(replayCutContract);
        hash.update('\0');
        hash.update(this.sourceSha);
        for (let index = 0; index < cursor; index += 1) {
            hash.update('\0');
            hash.update(this.events[index].idempotencyKey);
        }
        return hash.digest('hex');
    }
}
