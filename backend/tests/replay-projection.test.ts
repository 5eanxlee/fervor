import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointStore } from '../src/services/replay/checkpointStore';
import { ReplayCoordinator } from '../src/services/replay/coordinator';
import {
    parseReplayCheckpoint,
    ReplayProjection,
} from '../src/services/replay/projection';
import { ReplayScheduler, type ReplaySpeed } from '../src/services/replay/scheduler';
import {
    replayMint as mint,
    replaySha as sourceSha,
    replayTape as replay,
} from './helpers/replayTape';

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const resign = (value: any): any => {
    const { checkpointSha256: _prior, ...payload } = value;
    value.checkpointSha256 = createHash('sha256')
        .update('fervor-replay-checkpoint-v1')
        .update('\0')
        .update(JSON.stringify(payload))
        .digest('hex');
    return value;
};

describe('replay projection checkpoints', () => {
    it('restores a cut and deterministically continues without stale work', () => {
        const source = replay();
        const baseline = new ReplayCoordinator(source, 'baseline');
        const baselineProjection = ReplayProjection.start(baseline);
        baseline.resume();
        baselineProjection.apply(baseline.next()!);
        baselineProjection.apply(baseline.next()!);
        expect(() => baselineProjection.checkpoint(baseline)).toThrow('running replay');
        baseline.pause();

        const midpoint = baselineProjection.checkpoint(baseline);
        const portable = JSON.parse(JSON.stringify(midpoint));
        expect(parseReplayCheckpoint(portable)).toEqual(midpoint);
        expect(midpoint).toMatchObject({
            contract: 'fervor-replay-checkpoint-v1',
            cut: { cursor: 2 },
            all: { revision: 2 },
            priced: { revision: 1 },
        });

        baseline.resume();
        const staleTail = baseline.next()!;
        baselineProjection.apply(staleTail);
        const finalBaseline = baselineProjection.checkpoint(baseline);

        const restarted = new ReplayCoordinator(source, 'restarted');
        const restored = ReplayProjection.restore(restarted, portable);
        expect(restarted.snapshot()).toMatchObject({ cursor: 2, epoch: 2, status: 'paused' });
        expect(() => restored.apply(staleTail)).toThrow('stale or out of sequence');
        restarted.resume();
        restored.apply(restarted.next()!);

        expect(restored.view()).toEqual(baselineProjection.view());
        expect(restored.view().rolling.txCount['1m']).toBe(3);
        expect(restored.view().pricedRolling.txCount['1m']).toBe(2);
        expect(restored.checkpoint(restarted)).toEqual(finalBaseline);
    });

    it('rejects corruption before changing the coordinator', () => {
        const source = replay();
        const first = { ...source.sourceTrades[0], slot: 42, txIndex: 1 };
        const second = {
            ...source.sourceTrades[1],
            slot: 42,
            txIndex: 0,
            observedAt: first.observedAt,
        };
        expect(() => new ReplayCoordinator(
            { ...source, sourceTrades: [first, second, source.sourceTrades[2]] },
            'unordered'
        )).toThrow('canonical chain order');

        const coordinator = new ReplayCoordinator(source, 'source');
        const projection = ReplayProjection.start(coordinator);
        projection.apply(coordinator.step()!);
        const checkpoint = projection.checkpoint(coordinator);

        const target = new ReplayCoordinator(source, 'target');
        const before = target.snapshot();
        const corrupt = JSON.parse(JSON.stringify(checkpoint));
        corrupt.checkpointSha256 = '0'.repeat(64);
        expect(() => ReplayProjection.restore(target, corrupt)).toThrow('checksum differs');
        expect(target.snapshot()).toEqual(before);

        const wrongHead = JSON.parse(JSON.stringify(checkpoint));
        wrongHead.latestTrade.tradeId = 'f'.repeat(64);
        expect(() => ReplayProjection.restore(target, resign(wrongHead))).toThrow('head differs');
        expect(target.snapshot()).toEqual(before);

        const wrongRollup = JSON.parse(JSON.stringify(checkpoint));
        wrongRollup.priced.windows['1m'][0].volumeMicroUsd += 1;
        expect(() => ReplayProjection.restore(target, resign(wrongRollup))).toThrow('state differs');
        expect(target.snapshot()).toEqual(before);

        expect(() => target.restore(null)).toThrow('cut is invalid');
        expect(target.snapshot()).toEqual(before);
    });

    it('atomically stores one canonical checkpoint across concurrent writers', async () => {
        const source = replay();
        const coordinator = new ReplayCoordinator(source, 'durable');
        const projection = ReplayProjection.start(coordinator);
        projection.apply(coordinator.step()!);
        const checkpoint = projection.checkpoint(coordinator);
        const temp = await mkdtemp(path.join(os.tmpdir(), 'fervor-checkpoint-'));
        tempDirs.push(temp);
        const store = new CheckpointStore(path.join(temp, 'store'));

        const keys = await Promise.all(Array.from({ length: 8 }, () => store.write(checkpoint)));
        expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(1);
        await expect(new CheckpointStore(store.root).read(keys[0])).resolves.toEqual(checkpoint);

        const sourceDir = path.join(store.root, sourceSha, 'fervor-replay-checkpoint-v1');
        const files = await readdir(sourceDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/\.json$/);
        await expect(store.read({ ...keys[0], ignored: true })).rejects.toThrow('key is invalid');
        await expect(store.nearest(sourceSha, 0)).resolves.toBeNull();
        await expect(store.nearest(sourceSha, 1)).resolves.toEqual(checkpoint);
        await expect(store.nearest(sourceSha, 100)).resolves.toEqual(checkpoint);

        const divergent = JSON.parse(JSON.stringify(checkpoint));
        divergent.latestUsd.value += 1;
        await expect(store.write(resign(divergent))).rejects.toThrow('collides');
        expect(await readdir(sourceDir)).toEqual(files);

        projection.apply(coordinator.step()!);
        const second = projection.checkpoint(coordinator);
        await store.write(second);
        await expect(store.nearest(sourceSha, 1)).resolves.toEqual(checkpoint);
        await expect(store.nearest(sourceSha, 2)).resolves.toEqual(second);
        await expect(store.nearest(sourceSha, 100)).resolves.toEqual(second);

        await writeFile(
            path.join(sourceDir, '.999.00000000-0000-4000-8000-000000000000.tmp'),
            '{'
        );
        await expect(store.nearest(sourceSha, 2)).resolves.toEqual(second);

        await writeFile(path.join(sourceDir, files[0]), '{');
        await expect(store.read(keys[0])).rejects.toThrow('invalid');
        await expect(store.nearest(sourceSha, 1)).rejects.toThrow('invalid');
    });
});

describe('replay scheduler', () => {
    const fakeTimer = (waits: number[]) => {
        let now = 0;
        return {
            nowMs: () => now,
            wait: async (delayMs: number) => {
                waits.push(delayMs);
                now += delayMs;
            },
            advance: (delayMs: number) => { now += delayMs; },
        };
    };

    const runAt = async (speed: ReplaySpeed, workMs = 0) => {
        const source = replay();
        const coordinator = new ReplayCoordinator(source, `speed-${speed}`);
        const projection = ReplayProjection.start(coordinator);
        const waits: number[] = [];
        const timer = fakeTimer(waits);
        const scheduler = new ReplayScheduler(
            coordinator,
            (event) => {
                projection.apply(event);
                timer.advance(workMs);
            },
            timer
        );
        const result = await scheduler.run(speed);
        return { checkpoint: projection.checkpoint(coordinator), result, waits };
    };

    it('changes pacing without changing canonical output', async () => {
        const one = await runAt(1);
        const twenty = await runAt(20);
        const hundred = await runAt(100);
        const lagged = await runAt(100, 25);
        const maximum = await runAt('max');

        expect(one.waits).toEqual([10_000, 10_000]);
        expect(twenty.waits).toEqual([500, 500]);
        expect(hundred.waits).toEqual([100, 100]);
        expect(lagged.waits).toEqual([75, 75]);
        expect(maximum.waits).toEqual([]);
        expect([one, twenty, hundred, lagged, maximum].map(({ result }) => result))
            .toEqual(Array(5).fill(expect.objectContaining({
                emitted: 3,
                snapshot: expect.objectContaining({ cursor: 3, status: 'complete' }),
            })));
        expect(twenty.checkpoint).toEqual(one.checkpoint);
        expect(hundred.checkpoint).toEqual(one.checkpoint);
        expect(lagged.checkpoint).toEqual(one.checkpoint);
        expect(maximum.checkpoint).toEqual(one.checkpoint);
    });

    it('spreads same-second trade bursts across their source second', async () => {
        const base = replay(5);
        const times = [
            '2024-11-19T00:00:00.000Z',
            '2024-11-19T00:00:00.000Z',
            '2024-11-19T00:00:00.000Z',
            '2024-11-19T00:00:00.000Z',
            '2024-11-19T00:00:01.000Z',
        ];
        const source = {
            ...base,
            sourceTrades: base.sourceTrades.map((trade, index) => ({
                ...trade,
                observedAt: times[index],
            })),
            trades: base.trades.map((trade, index) => ({
                ...trade,
                observedAt: times[index],
            })),
        };
        const coordinator = new ReplayCoordinator(source, 'same-second');
        const waits: number[] = [];
        const timer = fakeTimer(waits);

        expect(coordinator.snapshot()).toMatchObject({
            cursor: 0,
            nextAt: times[0],
        });
        await new ReplayScheduler(coordinator, () => undefined, timer).run(1);

        expect(waits).toEqual([250, 250, 250, 250]);
        expect(coordinator.snapshot()).toMatchObject({
            cursor: 5,
            status: 'complete',
            nextAt: null,
        });
    });

    it('compresses a migration-sized idle gap and still spreads the resumed burst', async () => {
        const base = replay(4);
        const times = [
            '2024-11-19T00:00:00.000Z',
            '2024-11-19T00:02:53.000Z',
            '2024-11-19T00:02:53.000Z',
            '2024-11-19T00:02:54.000Z',
        ];
        const source = {
            ...base,
            sourceTrades: base.sourceTrades.map((trade, index) => ({
                ...trade,
                observedAt: times[index],
            })),
            trades: base.trades.map((trade, index) => ({
                ...trade,
                observedAt: times[index],
            })),
        };
        const coordinator = new ReplayCoordinator(source, 'migration-gap');
        const waits: number[] = [];
        const replayTimes: string[] = [];
        await new ReplayScheduler(
            coordinator,
            (event) => replayTimes.push(event.trade.replayAt!),
            fakeTimer(waits)
        ).run(1);

        expect(waits).toEqual([1_000, 500, 500]);
        expect(Date.parse(replayTimes[1]) - Date.parse(replayTimes[0])).toBe(1_000);
        expect(replayTimes.map((value) => Date.parse(value))).toEqual([
            Date.parse(times[0]),
            Date.parse(times[0]) + 1_000,
            Date.parse(times[0]) + 1_500,
            Date.parse(times[0]) + 2_000,
        ]);
        expect(coordinator.snapshot().now).toBe(times[3]);
    });

    it('does not emit across a pause or pre-aborted run', async () => {
        const source = replay();
        const coordinator = new ReplayCoordinator(source, 'controlled');
        const projection = ReplayProjection.start(coordinator);
        const scheduler = new ReplayScheduler(
            coordinator,
            (event) => projection.apply(event),
            { nowMs: () => 0, wait: async () => { coordinator.pause(); } }
        );

        await expect(scheduler.run(1)).resolves.toMatchObject({
            emitted: 1,
            snapshot: { cursor: 1, status: 'paused' },
        });
        const aborted = new AbortController();
        aborted.abort();
        await expect(scheduler.run(1, aborted.signal)).resolves.toMatchObject({
            emitted: 0,
            snapshot: { cursor: 1, status: 'paused' },
        });
        await expect(new ReplayScheduler(
            coordinator,
            (event) => projection.apply(event),
            { nowMs: () => 0, wait: async () => undefined }
        ).run('max', undefined, 2)).resolves.toMatchObject({
            emitted: 1,
            snapshot: { cursor: 2, status: 'paused' },
        });
        await expect(new ReplayScheduler(
            coordinator,
            (event) => projection.apply(event),
            { nowMs: () => 0, wait: async () => undefined }
        ).run('max')).resolves.toMatchObject({ emitted: 1, snapshot: { status: 'complete' } });
    });

    it('yields maximum-speed work in bounded bursts and rejects a second driver', async () => {
        const fast = new ReplayCoordinator(replay(514), 'bounded');
        const waits: number[] = [];
        await expect(new ReplayScheduler(
            fast,
            () => undefined,
            { nowMs: () => 0, wait: async (delayMs) => { waits.push(delayMs); } }
        ).run('max')).resolves.toMatchObject({ emitted: 514, snapshot: { status: 'complete' } });
        expect(waits).toEqual([0]);

        const controlled = new ReplayCoordinator(replay(), 'single-driver');
        let release = (): void => undefined;
        const waiting = new Promise<void>((resolve) => { release = resolve; });
        const scheduler = new ReplayScheduler(
            controlled,
            () => undefined,
            { nowMs: () => 0, wait: async () => waiting }
        );
        const running = scheduler.run(1);
        await expect(scheduler.run(20)).rejects.toThrow('already active');
        controlled.pause();
        release();
        await expect(running).resolves.toMatchObject({
            emitted: 1,
            snapshot: { cursor: 1, status: 'paused' },
        });
    });

    it('stops a run whose sink rejects an emitted event', async () => {
        const coordinator = new ReplayCoordinator(replay(), 'failed-sink');
        const failure = new Error('sink failed');
        const scheduler = new ReplayScheduler(coordinator, () => { throw failure; });

        await expect(scheduler.run('max')).rejects.toBe(failure);
        expect(coordinator.snapshot()).toMatchObject({ cursor: 1, status: 'stopped' });
        await expect(scheduler.run(10)).rejects.toThrow('speed is invalid');

        const timed = new ReplayCoordinator(replay(), 'failed-timer');
        let reads = 0;
        const backward = new ReplayScheduler(timed, () => undefined, {
            nowMs: () => reads++ === 0 ? 1 : 0,
            wait: async () => undefined,
        });
        await expect(backward.run(1)).rejects.toThrow('not monotonic');
        expect(timed.snapshot()).toMatchObject({ cursor: 0, status: 'paused' });
        await expect(backward.run('max', undefined, 4)).rejects.toThrow('target cursor');

        const stopped = new ReplayCoordinator(replay(), 'stopped-checkpoint');
        const projection = ReplayProjection.start(stopped);
        stopped.stop();
        expect(() => projection.checkpoint(stopped)).toThrow('stopped replay');
    });
});
