import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NormalizedTradeEvent } from '../src/types';
import type { MetricReplay } from '../src/services/marketData/metricReplay';
import { CheckpointStore } from '../src/services/replay/checkpointStore';
import { ReplayCoordinator } from '../src/services/replay/coordinator';
import {
    parseReplayCheckpoint,
    ReplayProjection,
} from '../src/services/replay/projection';

const mint = 'YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf';
const sourceSha = '1'.repeat(64);
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

const trade = (index: number): NormalizedTradeEvent => ({
    kind: 'trade',
    source: 'old_faithful',
    sourceEventId: `source:${index}`,
    idempotencyKey: index.toString(16).padStart(64, '0'),
    tokenMint: mint,
    maker: `wallet-${index}`,
    side: index === 1 ? 'sell' : 'buy',
    priceSol: index + 1,
    slot: 42 + index,
    txIndex: 0,
    instructionIndex: 0,
    eventIndex: 0,
    observedAt: new Date(Date.UTC(2024, 10, 19, 0, 0, index * 10)).toISOString(),
    receivedAt: new Date(Date.UTC(2024, 10, 19, 0, 0, index * 10)).toISOString(),
    confidence: 1,
    stale: false,
});

const replay = (): MetricReplay => {
    const sourceTrades = [trade(0), trade(1), trade(2)];
    const priced = [0, 2].map((index) => ({
        ...sourceTrades[index],
        priceUsd: (index + 1) * 100,
        usdAmount: (index + 1) * 20,
        usdSourceEventId: `fx:${index}`,
    }));
    return {
        source: { mint, trades: sourceTrades.length, replaySha256: sourceSha },
        sourceTrades,
        trades: priced,
    } as unknown as MetricReplay;
};

describe('replay projection checkpoints', () => {
    it('restores a cut and deterministically continues without stale work', () => {
        const source = replay();
        const baseline = new ReplayCoordinator(source, 'baseline');
        const baselineProjection = ReplayProjection.start(baseline);
        baseline.resume();
        baselineProjection.apply(baseline.next()!);
        baselineProjection.apply(baseline.next()!);
        expect(() => baselineProjection.checkpoint(baseline)).toThrow('Running');
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

        const sourceDir = path.join(store.root, sourceSha);
        const files = await readdir(sourceDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/\.json$/);
        await expect(store.read({ ...keys[0], ignored: true })).rejects.toThrow('key is invalid');

        await writeFile(path.join(sourceDir, files[0]), '{');
        await expect(store.read(keys[0])).rejects.toThrow('invalid');
    });
});
