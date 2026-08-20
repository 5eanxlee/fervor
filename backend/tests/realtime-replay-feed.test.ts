import { describe, expect, it, vi } from 'vitest';
import type {
    ReplayCall,
    ReplayGateway,
    ReplayReply,
} from '../src/services/replay/replayGateway';
import {
    ReplayFeed,
    ReplayFeedError,
} from '../src/services/realtime/replayFeed';

const mint = 'So11111111111111111111111111111111111111112';
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sourceSha = 'a'.repeat(64);
const sessionId = 'b'.repeat(64);
const runId = 'rt-run';
const at = (second: number): string => `2024-11-19T00:00:${String(second).padStart(2, '0')}.000Z`;

const state = (cursor: number, epoch = 1) => ({
    tokenMint: mint,
    busy: false,
    mutating: false,
    failure: null,
    snapshot: {
        runId,
        epoch,
        sourceReplaySha256: sourceSha,
        cursor,
        total: 10,
        status: 'paused',
        now: cursor === 0 ? null : at(cursor),
        nextAt: cursor === 10 ? null : at(cursor + 1),
    },
    projection: { cursor },
    paper: { orderCount: 0, factCount: 0 },
    alerts: { definitionCount: 0 },
});

const snapshot = (cursor: number, epoch = 1): ReplayReply => ({
    status: 200,
    body: {
        success: true,
        contract: 'fervor-replay-api-v1',
        mode: 'historical_replay',
        session: {
            id: sessionId,
            sourceReplaySha256: sourceSha,
            runId,
            epoch,
            cursor,
            now: cursor === 0 ? null : at(cursor),
        },
        data: { state: state(cursor, epoch) },
    },
});

const event = (cursor: number, epoch = 1) => ({
    runId,
    epoch,
    sourceReplaySha256: sourceSha,
    cursor,
    usdPriced: true,
    trade: {
        kind: 'trade',
        idempotencyKey: `trade-${cursor}`,
        tokenMint: mint,
        observedAt: at(cursor + 1),
        side: cursor % 2 === 0 ? 'buy' : 'sell',
        priceUsd: cursor + 1,
    },
});

const deltas = (after: number, count: number, cutCursor: number): ReplayReply => ({
    status: 200,
    body: {
        success: true,
        contract: 'fervor-replay-api-v1',
        mode: 'historical_replay',
        session: {
            id: sessionId,
            sourceReplaySha256: sourceSha,
            runId,
            epoch: 1,
            cursor: cutCursor,
            now: cutCursor === 0 ? null : at(cutCursor),
        },
        data: {
            page: {
                contract: 'fervor-replay-delta-v1',
                sourceReplaySha256: sourceSha,
                runId,
                epoch: 1,
                after,
                cutCursor,
                cutAt: cutCursor === 0 ? null : at(cutCursor),
                next: after + count < cutCursor ? after + count : null,
                items: Array.from({ length: count }, (_, index) => event(after + index)),
            },
        },
    },
});

const gateway = (...replies: ReplayReply[]): ReplayGateway & {
    call: ReturnType<typeof vi.fn<(input: ReplayCall) => Promise<ReplayReply>>>;
} => {
    const queue = [...replies];
    return {
        enabled: true,
        ownerId,
        call: vi.fn(async () => {
            const reply = queue.shift();
            if (!reply) throw new Error('Unexpected replay call');
            return reply;
        }),
    };
};

describe('realtime replay feed', () => {
    it('reads one upstream delta page and fans it out to every listener', async () => {
        const upstream = gateway(snapshot(0), deltas(0, 2, 2), snapshot(2));
        const feed = new ReplayFeed(upstream, { pollMs: 60_000 });
        const first: string[] = [];
        const second: string[] = [];
        feed.watch((frame) => first.push(frame.type));
        feed.watch((frame) => second.push(frame.type));

        await feed.ready();
        await feed.sync();
        await feed.close();

        expect(upstream.call).toHaveBeenCalledTimes(3);
        expect(first).toEqual(['delta', 'delta', 'delta', 'delta']);
        expect(second).toEqual(first);
        expect(feed.hello()).toMatchObject({
            mode: 'historical_replay',
            sessionId,
            epoch: 1,
        });
    });

    it('serves an exact snapshot or a bounded resume chain', async () => {
        const upstream = gateway(snapshot(0), deltas(0, 2, 2), snapshot(2));
        const feed = new ReplayFeed(upstream, { pollMs: 60_000 });
        await feed.ready();
        await feed.sync();

        const fresh = feed.seed(['trade', 'market']);
        expect(fresh.resumed).toBe(false);
        expect(fresh.frames).toHaveLength(1);
        expect(fresh.frames[0]).toMatchObject({
            type: 'snapshot',
            cut: { trade: '2', market: '2' },
            data: { trade: { nextAt: at(3) } },
        });

        const resumed = feed.seed(['trade'], {
            sessionId,
            epoch: 1,
            cursors: { trade: '1' },
        });
        expect(resumed.resumed).toBe(true);
        expect(resumed.frames).toMatchObject([{
            type: 'delta',
            stream: 'trade',
            prior: '1',
            cursor: '2',
        }]);

        const stale = feed.seed(['trade'], {
            sessionId: 'c'.repeat(64),
            epoch: 1,
            cursors: { trade: '1' },
        });
        expect(stale.resumed).toBe(false);
        expect(stale.frames.map((frame) => frame.type)).toEqual(['control', 'snapshot']);
        await feed.close();
    });

    it('rebases all clients when the replay epoch changes', async () => {
        const upstream = gateway(snapshot(2), { status: 409, body: {} }, snapshot(0, 2));
        const feed = new ReplayFeed(upstream, { pollMs: 60_000 });
        const frames: string[] = [];
        feed.watch((frame) => frames.push(frame.type));

        await feed.ready();
        await feed.sync();
        await feed.close();

        expect(frames).toEqual(['control', 'snapshot']);
        expect(feed.hello().epoch).toBe(2);
    });

    it('publishes replay controls that change without advancing a trade', async () => {
        const changed = snapshot(0);
        (changed.body as any).data.state.busy = true;
        (changed.body as any).data.state.snapshot.status = 'running';
        const upstream = gateway(snapshot(0), deltas(0, 0, 0), changed);
        const feed = new ReplayFeed(upstream, { pollMs: 60_000 });
        const frames: any[] = [];
        feed.watch((frame) => frames.push(frame));

        await feed.ready();
        await feed.sync();
        await feed.close();

        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject({
            type: 'delta',
            stream: 'replay',
            delivery: 'state',
            data: { busy: true, snapshot: { status: 'running' } },
        });
        expect(frames[0].cursor).not.toBe(frames[0].prior);
    });

    it('rejects gaps rather than publishing an invented sequence', async () => {
        const badPage = deltas(0, 1, 1);
        (badPage.body as any).data.page.items[0].cursor = 1;
        const upstream = gateway(snapshot(0), badPage);
        const feed = new ReplayFeed(upstream, { pollMs: 60_000 });

        await feed.ready();
        await expect(feed.sync()).rejects.toEqual(expect.objectContaining<ReplayFeedError>({
            retryable: false,
        }));
        await feed.close();
    });
});
