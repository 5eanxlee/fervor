import readline from 'node:readline';
import path from 'node:path';
import { z } from 'zod';
import { buildMetricReplay } from './services/marketData/metricReplay';
import { CheckpointStore } from './services/replay/checkpointStore';
import {
    assertReplayIsolation,
    ReplayRuntime,
    type ReplayState,
} from './services/replay/runtime';

const usage = 'Usage: replay-lab --replay <replay-dir> --checkpoints <checkpoint-dir> --run <run-id>';
const requestId = z.string().min(1).max(64).optional();
const commandSchema = z.discriminatedUnion('op', [
    z.object({ id: requestId, op: z.literal('status') }).strict(),
    z.object({ id: requestId, op: z.literal('play'), speed: z.union([
        z.literal(1), z.literal(20), z.literal(100), z.literal('max'),
    ]) }).strict(),
    z.object({ id: requestId, op: z.literal('pause') }).strict(),
    z.object({ id: requestId, op: z.literal('step') }).strict(),
    z.object({ id: requestId, op: z.literal('seek'), cursor: z.number().int().nonnegative() }).strict(),
    z.object({ id: requestId, op: z.literal('checkpoint') }).strict(),
    z.object({ id: requestId, op: z.literal('stop') }).strict(),
]);

type Command = z.infer<typeof commandSchema>;

const parseArgs = (): { replay: string; checkpoints: string; runId: string } => {
    const values = new Map<string, string>();
    for (let index = 2; index < process.argv.length; index += 2) {
        const name = process.argv[index];
        const value = process.argv[index + 1];
        if (!['--replay', '--checkpoints', '--run'].includes(name)
            || !value
            || values.has(name)) {
            throw new Error(usage);
        }
        values.set(name, value);
    }
    const replay = values.get('--replay');
    const checkpoints = values.get('--checkpoints');
    const runId = values.get('--run');
    if (!replay || !checkpoints || !runId || values.size !== 3) throw new Error(usage);
    const replayPath = path.resolve(replay);
    const checkpointPath = path.resolve(checkpoints);
    if (checkpointPath === replayPath || checkpointPath.startsWith(`${replayPath}${path.sep}`)) {
        throw new Error('Replay checkpoints must be outside the immutable corpus directory');
    }
    return { replay: replayPath, checkpoints: checkpointPath, runId };
};

const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const write = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
};

const success = (command: Command, state: ReplayState, extra = {}): void => {
    write({ id: command.id ?? null, ok: true, op: command.op, ...extra, state });
};

const main = async (): Promise<void> => {
    assertReplayIsolation(process.env);
    const args = parseArgs();
    const replay = await buildMetricReplay(args.replay);
    const runtime = new ReplayRuntime(
        replay,
        args.runId,
        new CheckpointStore(args.checkpoints)
    );
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    let queue = Promise.resolve();

    const dispatch = async (line: string): Promise<void> => {
        let id: string | null = null;
        try {
            if (Buffer.byteLength(line) > 16_384) throw new Error('Replay command is too large');
            const raw: unknown = JSON.parse(line);
            if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
                const candidate = (raw as { id?: unknown }).id;
                if (typeof candidate === 'string' && candidate.length <= 64) id = candidate;
            }
            const command = commandSchema.parse(raw);
            if (command.op === 'status') return success(command, runtime.state());
            if (command.op === 'play') {
                const done = runtime.play(command.speed);
                success(command, runtime.state());
                void done.then((state) => write({ event: 'idle', state }));
                return;
            }
            if (command.op === 'pause') return success(command, await runtime.pause());
            if (command.op === 'step') return success(command, runtime.step());
            if (command.op === 'seek') return success(command, await runtime.seek(command.cursor));
            if (command.op === 'checkpoint') {
                const saved = await runtime.checkpoint();
                return success(command, saved.state, { key: saved.key });
            }
            const state = await runtime.stop();
            success(command, state);
            input.close();
        } catch (error) {
            write({ id, ok: false, error: errorText(error) });
        }
    };

    input.on('line', (line) => {
        if (line.trim()) queue = queue.then(() => dispatch(line));
    });
    process.once('SIGINT', () => input.close());
    process.once('SIGTERM', () => input.close());
    write({ event: 'ready', state: runtime.state() });

    await new Promise<void>((resolve) => {
        input.once('close', () => {
            queue = queue.then(async () => {
                if (runtime.state().snapshot.status === 'stopped') return;
                const state = await runtime.pause();
                const saved = await runtime.checkpoint();
                write({ event: 'closed', key: saved.key, state });
            }).catch((error) => {
                write({ event: 'close_failed', error: errorText(error) });
                process.exitCode = 1;
            });
            void queue.finally(resolve);
        });
    });
};

main().catch((error) => {
    console.error(errorText(error));
    process.exitCode = 1;
});
