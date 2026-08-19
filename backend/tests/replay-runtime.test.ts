import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    CheckpointStore,
    ReplaySessionStore,
} from '../src/services/replay/checkpointStore';
import {
    paperModelContract,
    type PaperModelInput,
} from '../src/services/replay/paperBroker';
import {
    assertReplayIsolation,
    ReplayRuntime,
} from '../src/services/replay/runtime';
import { replayMint, replayQuoteMint, replayTape } from './helpers/replayTape';

const tempDirs: string[] = [];
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

describe('replay runtime', () => {
    it('refuses inherited external dependency configuration without exposing values', () => {
        expect(() => assertReplayIsolation({ PATH: '/bin', NODE_ENV: 'test' })).not.toThrow();
        const secret = 'do-not-echo-this-value';
        expect(() => assertReplayIsolation({
            DATABASE_URL: secret,
            TELEGRAM_BOT_TOKEN: secret,
        })).toThrow('DATABASE_URL, TELEGRAM_BOT_TOKEN');
        let message = '';
        try {
            assertReplayIsolation({ JUPITER_API_KEY: secret });
        } catch (error) {
            message = String(error);
        }
        expect(message).toContain('JUPITER_API_KEY');
        expect(message).not.toContain(secret);
    });

    it('serializes controls and restores the nearest checkpoint on one epoch-fenced owner', async () => {
        const temp = await mkdtemp(path.join(os.tmpdir(), 'fervor-runtime-'));
        tempDirs.push(temp);
        const source = replayTape(1_025);
        const store = new CheckpointStore(path.join(temp, 'checkpoints'));
        const sessions = new ReplaySessionStore(store.root);
        const runtime = await ReplayRuntime.open(
            source, 'runtime-a', store, sessions, paperModel
        );

        const running = runtime.play('max');
        expect(runtime.state()).toMatchObject({
            busy: true,
            snapshot: { cursor: 512, status: 'running' },
        });
        expect(() => runtime.step()).toThrow('paused run');
        await expect(runtime.pause()).resolves.toMatchObject({
            busy: false,
            snapshot: { cursor: 512, status: 'paused' },
        });
        await expect(running).resolves.toMatchObject({ snapshot: { cursor: 512 } });

        expect(runtime.step()).toMatchObject({ snapshot: { cursor: 513, status: 'paused' } });
        const saved = await runtime.checkpoint();
        expect(saved).toMatchObject({ key: { cursor: 513 }, state: { busy: false } });
        await expect(runtime.play(10)).resolves.toMatchObject({
            failure: 'Replay speed is invalid',
            snapshot: { cursor: 513, status: 'paused' },
        });
        await expect(runtime.play('max')).resolves.toMatchObject({
            failure: null,
            snapshot: { cursor: 1_025, status: 'complete' },
        });

        const first = await runtime.seek(600);
        expect(first).toMatchObject({
            busy: false,
            snapshot: { cursor: 600, status: 'paused' },
        });
        const restored = await ReplayRuntime.open(
            source, 'runtime-b', store, sessions, paperModel
        );
        const second = await restored.seek(600);
        expect(second.projection).toEqual(first.projection);
        expect(second.snapshot.epoch).toBeGreaterThan(1);

        await expect(restored.seek(100)).resolves.toMatchObject({
            snapshot: { cursor: 100, status: 'paused' },
        });
        await expect(restored.stop()).resolves.toMatchObject({
            snapshot: { cursor: 100, status: 'stopped' },
        });
        await expect(restored.checkpoint()).rejects.toThrow('stopped replay');
    });

    it('recovers paper orders atomically and resets them on an explicit seek', async () => {
        const temp = await mkdtemp(path.join(os.tmpdir(), 'fervor-paper-runtime-'));
        tempDirs.push(temp);
        const source = replayTape();
        const store = new CheckpointStore(path.join(temp, 'checkpoints'));
        const sessions = new ReplaySessionStore(store.root);
        const runtime = await ReplayRuntime.open(
            source, 'paper-runtime', store, sessions, paperModel
        );

        runtime.place({
            id: 'runtime-buy',
            kind: 'market',
            side: 'buy',
            tokenMint: replayMint,
            quoteMint: replayQuoteMint,
            inputRaw: '50',
            reference: { quoteRaw: '1', tokenRaw: '1' },
        });
        await expect(runtime.checkpoint()).resolves.toMatchObject({ key: { seq: 0, cursor: 0 } });
        runtime.step();
        expect(runtime.state().snapshot.now).toBe('2024-11-19T00:00:00.000Z');
        await runtime.checkpoint();
        runtime.step();
        const filled = await runtime.checkpoint();
        expect(filled).toMatchObject({ key: { seq: 2, cursor: 2 } });
        expect(runtime.orders()[0]).toMatchObject({
            id: 'runtime-buy', status: 'filled', filledInputRaw: '50',
        });
        expect(runtime.portfolio()).toMatchObject({
            orderCount: 1,
            factCount: 4,
            fillCount: 1,
            basisComplete: true,
            positions: [{
                tokenMint: replayMint,
                quoteMint: replayQuoteMint,
                openQuantityRaw: '50',
                openCostRaw: '50',
            }],
        });

        const restored = await ReplayRuntime.open(
            source, 'paper-runtime', store, sessions, paperModel
        );
        expect(restored.state()).toMatchObject({
            snapshot: { cursor: 2 },
            paper: { factCount: 4, orderCount: 1 },
        });
        expect(restored.orders()).toEqual(runtime.orders());
        expect(restored.portfolio()).toEqual(runtime.portfolio());
        expect(restored.state().snapshot.epoch).toBeGreaterThan(
            filled.state.snapshot.epoch
        );
        await expect(restored.checkpoint()).resolves.toMatchObject({ key: { seq: 3 } });

        await restored.seek(0);
        expect(restored.state()).toMatchObject({
            snapshot: { cursor: 0 },
            paper: { factCount: 0, orderCount: 0 },
        });
        expect(restored.portfolio()).toMatchObject({
            orderCount: 0,
            factCount: 0,
            fillCount: 0,
            netFlows: [],
            feeTotals: [],
            positions: [],
        });
        await expect(restored.checkpoint()).resolves.toMatchObject({ key: { seq: 4, cursor: 0 } });

        const reset = await ReplayRuntime.open(
            source, 'paper-runtime', store, sessions, paperModel
        );
        expect(reset.state()).toMatchObject({
            snapshot: { cursor: 0 },
            paper: { factCount: 0, orderCount: 0 },
        });
    });
});
