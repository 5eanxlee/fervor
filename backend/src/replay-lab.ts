import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import { z } from 'zod';
import { buildMetricReplay } from './services/marketData/metricReplay';
import {
    CheckpointStore,
    ReplaySessionStore,
} from './services/replay/checkpointStore';
import { paperOrderSchema } from './services/replay/paperBroker';
import {
    assertReplayIsolation,
    ReplayRuntime,
    type ReplayState,
} from './services/replay/runtime';

const usage = 'Usage: replay-lab --replay <replay-dir> --checkpoints <checkpoint-dir> --model <paper-model.json> --run <run-id>';
const requestId = z.string().min(1).max(64).optional();
const orderId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const commandSchema = z.discriminatedUnion('op', [
    z.object({ id: requestId, op: z.literal('status') }).strict(),
    z.object({ id: requestId, op: z.literal('play'), speed: z.union([
        z.literal(1), z.literal(20), z.literal(100), z.literal('max'),
    ]) }).strict(),
    z.object({ id: requestId, op: z.literal('pause') }).strict(),
    z.object({ id: requestId, op: z.literal('step') }).strict(),
    z.object({ id: requestId, op: z.literal('seek'), cursor: z.number().int().nonnegative() }).strict(),
    z.object({ id: requestId, op: z.literal('place'), order: paperOrderSchema }).strict(),
    z.object({ id: requestId, op: z.literal('cancel'), orderId }).strict(),
    z.object({ id: requestId, op: z.literal('portfolio') }).strict(),
    z.object({
        id: requestId,
        op: z.literal('orders'),
        after: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(100).optional(),
    }).strict(),
    z.object({
        id: requestId,
        op: z.literal('facts'),
        after: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(500).optional(),
    }).strict(),
    z.object({ id: requestId, op: z.literal('checkpoint') }).strict(),
    z.object({ id: requestId, op: z.literal('stop') }).strict(),
]);

type Command = z.infer<typeof commandSchema>;

const parseArgs = (): { replay: string; checkpoints: string; model: string; runId: string } => {
    const values = new Map<string, string>();
    for (let index = 2; index < process.argv.length; index += 2) {
        const name = process.argv[index];
        const value = process.argv[index + 1];
        if (!['--replay', '--checkpoints', '--model', '--run'].includes(name)
            || !value
            || values.has(name)) {
            throw new Error(usage);
        }
        values.set(name, value);
    }
    const replay = values.get('--replay');
    const checkpoints = values.get('--checkpoints');
    const model = values.get('--model');
    const runId = values.get('--run');
    if (!replay || !checkpoints || !model || !runId || values.size !== 4) throw new Error(usage);
    const replayPath = path.resolve(replay);
    const checkpointPath = path.resolve(checkpoints);
    if (checkpointPath === replayPath || checkpointPath.startsWith(`${replayPath}${path.sep}`)) {
        throw new Error('Replay checkpoints must be outside the immutable corpus directory');
    }
    return { replay: replayPath, checkpoints: checkpointPath, model: path.resolve(model), runId };
};

const readModel = async (file: string): Promise<unknown> => {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size === 0 || info.size > 16_384) {
            throw new Error('Paper model file has an invalid shape or size');
        }
        const bytes = await handle.readFile();
        if (bytes.length !== info.size) throw new Error('Paper model changed while being read');
        return JSON.parse(bytes.toString('utf8')) as unknown;
    } finally {
        await handle.close();
    }
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
    const [replay, paperModel] = await Promise.all([
        buildMetricReplay(args.replay),
        readModel(args.model),
    ]);
    const runtime = await ReplayRuntime.open(
        replay,
        args.runId,
        new CheckpointStore(args.checkpoints),
        new ReplaySessionStore(args.checkpoints),
        paperModel
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
            if (command.op === 'place') {
                const order = runtime.place(command.order);
                return success(command, runtime.state(), { order });
            }
            if (command.op === 'cancel') {
                const order = runtime.cancel(command.orderId);
                return success(command, runtime.state(), { order });
            }
            if (command.op === 'portfolio') {
                return success(command, runtime.state(), { portfolio: runtime.portfolio() });
            }
            if (command.op === 'orders') {
                return success(command, runtime.state(), {
                    orders: runtime.orders(command.after, command.limit),
                });
            }
            if (command.op === 'facts') {
                return success(command, runtime.state(), {
                    facts: runtime.facts(command.after, command.limit),
                });
            }
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
