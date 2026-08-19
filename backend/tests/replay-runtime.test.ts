import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointStore } from '../src/services/replay/checkpointStore';
import {
    assertReplayIsolation,
    ReplayRuntime,
} from '../src/services/replay/runtime';
import { replayTape } from './helpers/replayTape';

const tempDirs: string[] = [];

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
        const runtime = new ReplayRuntime(source, 'runtime-a', store);

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
        const restored = new ReplayRuntime(source, 'runtime-b', store);
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
});
