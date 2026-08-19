import { createHash } from 'node:crypto';
import { z } from 'zod';
import { addressSchema } from '../../types/execution';
import { RollingMetricBook, type StoredRollup } from '../marketData/rollingMetricBook';
import {
    parseReplayCut,
    ReplayCoordinator,
    type ReplayCut,
    type ReplayEvent,
    type ReplaySnapshot,
} from './coordinator';

export const replayCheckpointContract = 'fervor-replay-checkpoint-v1' as const;

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const time = z.string().datetime({ offset: true });
const latestTradeSchema = z.object({
    tradeId: hash,
    observedAt: time,
}).strict();
const latestPriceSchema = latestTradeSchema.extend({
    value: z.number().positive().finite(),
    sourceEventId: z.string().min(1).max(180).nullable(),
}).strict();
const checkpointSchema = z.object({
    contract: z.literal(replayCheckpointContract),
    cut: z.unknown(),
    tokenMint: addressSchema,
    all: z.unknown(),
    priced: z.unknown(),
    latestTrade: latestTradeSchema.nullable(),
    latestUsd: latestPriceSchema.nullable(),
    latestSol: latestPriceSchema.nullable(),
    checkpointSha256: hash,
}).strict();

type LatestTrade = Readonly<z.infer<typeof latestTradeSchema>>;
type LatestPrice = Readonly<z.infer<typeof latestPriceSchema>>;

export interface ReplayCheckpoint {
    readonly contract: typeof replayCheckpointContract;
    readonly cut: ReplayCut;
    readonly tokenMint: string;
    readonly all: StoredRollup;
    readonly priced: StoredRollup;
    readonly latestTrade: LatestTrade | null;
    readonly latestUsd: LatestPrice | null;
    readonly latestSol: LatestPrice | null;
    readonly checkpointSha256: string;
}

export interface ProjectionView {
    readonly cursor: number;
    readonly now: string | null;
    readonly latestTrade: LatestTrade | null;
    readonly latestUsd: LatestPrice | null;
    readonly latestSol: LatestPrice | null;
    readonly rolling: ReturnType<RollingMetricBook['metrics']>;
    readonly pricedRolling: ReturnType<RollingMetricBook['metrics']>;
}

type CheckpointPayload = Omit<ReplayCheckpoint, 'checkpointSha256'>;

const digest = (payload: CheckpointPayload): string => createHash('sha256')
    .update(replayCheckpointContract)
    .update('\0')
    .update(JSON.stringify(payload))
    .digest('hex');

const payloadOf = (
    cut: ReplayCut,
    tokenMint: string,
    all: StoredRollup,
    priced: StoredRollup,
    latestTrade: LatestTrade | null,
    latestUsd: LatestPrice | null,
    latestSol: LatestPrice | null
): CheckpointPayload => ({
    contract: replayCheckpointContract,
    cut,
    tokenMint,
    all,
    priced,
    latestTrade: latestTrade === null ? null : Object.freeze({ ...latestTrade }),
    latestUsd: latestUsd === null ? null : Object.freeze({ ...latestUsd }),
    latestSol: latestSol === null ? null : Object.freeze({ ...latestSol }),
});

interface DecodedCheckpoint {
    checkpoint: ReplayCheckpoint;
    all: RollingMetricBook;
    priced: RollingMetricBook;
}

type ReplayBinding = Pick<ReplaySnapshot, 'runId' | 'epoch' | 'sourceReplaySha256'>;

interface ProjectionState {
    all: RollingMetricBook;
    priced: RollingMetricBook;
    cursor: number;
    now: string | null;
    latestTrade: LatestTrade | null;
    latestUsd: LatestPrice | null;
    latestSol: LatestPrice | null;
}

const pricedWithin = (all: StoredRollup, priced: StoredRollup): boolean => {
    for (const name of Object.keys(all.windows) as (keyof StoredRollup['windows'])[]) {
        const allBuckets = new Map(all.windows[name].map((bucket) => [bucket.startMs, bucket]));
        for (const bucket of priced.windows[name]) {
            const total = allBuckets.get(bucket.startMs);
            if (!total
                || bucket.volumeMicroUsd !== total.volumeMicroUsd
                || bucket.buyCount > total.buyCount
                || bucket.sellCount > total.sellCount
                || bucket.txCount > total.txCount) {
                return false;
            }
        }
    }
    return true;
};

const observedBy = (rollup: StoredRollup, atMs: number | undefined): boolean =>
    Object.values(rollup.windows).every((buckets) => buckets.every((bucket) =>
        atMs !== undefined && bucket.startMs <= atMs));

const decodeCheckpoint = (value: unknown): DecodedCheckpoint => {
    const envelope = checkpointSchema.parse(value);
    const cut = parseReplayCut(envelope.cut);
    if ((envelope.all as { version?: unknown } | null)?.version !== 2
        || (envelope.priced as { version?: unknown } | null)?.version !== 2) {
        throw new Error('Replay checkpoint requires current rolling snapshots');
    }
    const all = RollingMetricBook.hydrate(envelope.all);
    const priced = RollingMetricBook.hydrate(envelope.priced);
    const allStored = all.serialize();
    const pricedStored = priced.serialize();
    const payload = payloadOf(
        cut,
        envelope.tokenMint,
        allStored,
        pricedStored,
        envelope.latestTrade,
        envelope.latestUsd,
        envelope.latestSol
    );
    if (digest(payload) !== envelope.checkpointSha256) {
        throw new Error('Replay checkpoint checksum differs');
    }
    const pricedCount = pricedStored.revision;
    const atMs = cut.now === null ? undefined : Date.parse(cut.now);
    const invalidLatest = (latest: LatestTrade | null): boolean => latest !== null
        && (atMs === undefined || Date.parse(latest.observedAt) > atMs);
    if (allStored.tokenMint !== envelope.tokenMint
        || pricedStored.tokenMint !== envelope.tokenMint
        || allStored.revision !== cut.cursor
        || pricedCount > cut.cursor
        || !pricedWithin(allStored, pricedStored)
        || !observedBy(allStored, atMs)
        || !observedBy(pricedStored, atMs)
        || (cut.cursor === 0) !== (envelope.latestTrade === null)
        || (pricedCount === 0) !== (envelope.latestUsd === null)
        || (envelope.latestTrade !== null && envelope.latestTrade.observedAt !== cut.now)
        || invalidLatest(envelope.latestUsd)
        || invalidLatest(envelope.latestSol)) {
        throw new Error('Replay checkpoint state differs from its cut');
    }
    return {
        checkpoint: { ...payload, checkpointSha256: envelope.checkpointSha256 },
        all,
        priced,
    };
};

export const parseReplayCheckpoint = (value: unknown): ReplayCheckpoint =>
    decodeCheckpoint(value).checkpoint;

export class ReplayProjection {
    private constructor(
        private readonly binding: ReplayBinding,
        readonly tokenMint: string,
        private readonly state: ProjectionState
    ) {}

    static start(coordinator: ReplayCoordinator): ReplayProjection {
        const snapshot = coordinator.snapshot();
        if (snapshot.cursor !== 0 || snapshot.now !== null || snapshot.status === 'stopped') {
            throw new Error('Replay projection must start at an empty active cursor');
        }
        return new ReplayProjection(
            snapshot,
            coordinator.tokenMint,
            {
                all: new RollingMetricBook(coordinator.tokenMint),
                priced: new RollingMetricBook(coordinator.tokenMint),
                cursor: 0,
                now: null,
                latestTrade: null,
                latestUsd: null,
                latestSol: null,
            }
        );
    }

    static restore(coordinator: ReplayCoordinator, value: unknown): ReplayProjection {
        const decoded = decodeCheckpoint(value);
        if (decoded.checkpoint.tokenMint !== coordinator.tokenMint
            || decoded.checkpoint.cut.sourceReplaySha256 !== coordinator.snapshot().sourceReplaySha256) {
            throw new Error('Replay checkpoint belongs to another tape');
        }
        const head = coordinator.head(decoded.checkpoint.cut);
        if (decoded.checkpoint.latestTrade?.tradeId !== (head.tradeId ?? undefined)
            || decoded.checkpoint.latestUsd?.tradeId !== (head.usdTradeId ?? undefined)
            || decoded.checkpoint.latestSol?.tradeId !== (head.solTradeId ?? undefined)) {
            throw new Error('Replay checkpoint head differs from the verified tape');
        }
        const snapshot = coordinator.restore(decoded.checkpoint.cut);
        return new ReplayProjection(
            snapshot,
            decoded.checkpoint.tokenMint,
            {
                all: decoded.all,
                priced: decoded.priced,
                cursor: snapshot.cursor,
                now: snapshot.now,
                latestTrade: decoded.checkpoint.latestTrade,
                latestUsd: decoded.checkpoint.latestUsd,
                latestSol: decoded.checkpoint.latestSol,
            }
        );
    }

    apply(event: ReplayEvent): void {
        if (event.runId !== this.binding.runId
            || event.epoch !== this.binding.epoch
            || event.sourceReplaySha256 !== this.binding.sourceReplaySha256
            || event.cursor !== this.state.cursor
            || event.trade.tokenMint !== this.tokenMint
            || (event.trade.side !== 'buy' && event.trade.side !== 'sell')) {
            throw new Error('Replay event is stale or out of sequence');
        }
        const nowMs = Date.parse(event.trade.observedAt);
        const usdPriced = event.trade.priceUsd !== undefined && event.trade.usdAmount !== undefined;
        const partialUsd = (event.trade.priceUsd === undefined) !== (event.trade.usdAmount === undefined);
        if (!Number.isSafeInteger(nowMs)
            || (this.state.now !== null && nowMs < Date.parse(this.state.now))
            || partialUsd
            || (usdPriced && (!Number.isFinite(event.trade.priceUsd) || event.trade.priceUsd! <= 0))
            || (event.trade.priceSol !== undefined
                && (!Number.isFinite(event.trade.priceSol) || event.trade.priceSol <= 0))
            || usdPriced !== event.usdPriced
            || !this.state.all.add(event.trade, nowMs)
            || (usdPriced && !this.state.priced.add(event.trade, nowMs))) {
            throw new Error('Replay event cannot update the trade projection');
        }
        const canonicalNow = new Date(nowMs).toISOString();
        this.state.cursor += 1;
        this.state.now = canonicalNow;
        this.state.latestTrade = Object.freeze({
            tradeId: event.trade.idempotencyKey,
            observedAt: canonicalNow,
        });
        if (usdPriced) {
            this.state.latestUsd = Object.freeze({
                tradeId: event.trade.idempotencyKey,
                observedAt: canonicalNow,
                value: event.trade.priceUsd!,
                sourceEventId: event.trade.usdSourceEventId ?? null,
            });
        }
        if (event.trade.priceSol !== undefined) {
            this.state.latestSol = Object.freeze({
                tradeId: event.trade.idempotencyKey,
                observedAt: canonicalNow,
                value: event.trade.priceSol,
                sourceEventId: event.trade.sourceEventId,
            });
        }
    }

    checkpoint(coordinator: ReplayCoordinator): ReplayCheckpoint {
        const snapshot = coordinator.snapshot();
        this.assertBound(snapshot);
        if (snapshot.status === 'running') throw new Error('Running replay cannot checkpoint');
        const payload = payloadOf(
            coordinator.cut(),
            this.tokenMint,
            this.state.all.serialize(),
            this.state.priced.serialize(),
            this.state.latestTrade,
            this.state.latestUsd,
            this.state.latestSol
        );
        return Object.freeze({ ...payload, checkpointSha256: digest(payload) });
    }

    view(): ProjectionView {
        const nowMs = this.state.now === null ? 0 : Date.parse(this.state.now);
        return {
            cursor: this.state.cursor,
            now: this.state.now,
            latestTrade: this.state.latestTrade,
            latestUsd: this.state.latestUsd,
            latestSol: this.state.latestSol,
            rolling: this.state.all.metrics(nowMs),
            pricedRolling: this.state.priced.metrics(nowMs),
        };
    }

    private assertBound(snapshot: ReplaySnapshot): void {
        if (snapshot.runId !== this.binding.runId
            || snapshot.epoch !== this.binding.epoch
            || snapshot.sourceReplaySha256 !== this.binding.sourceReplaySha256
            || snapshot.cursor !== this.state.cursor
            || snapshot.now !== this.state.now) {
            throw new Error('Replay projection is not bound to the coordinator');
        }
    }
}
