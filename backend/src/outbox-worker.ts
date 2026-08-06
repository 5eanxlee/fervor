import { env } from './config/env';
import { closeDatabase } from './config/database';
import { eventOutbox } from './services/eventOutbox';
import { redisStreams } from './services/redisStreamService';

let running = true;
let lastPrune = 0;

const wait = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
});

const loop = async (): Promise<void> => {
    await redisStreams.connect();
    console.log(`[outbox-worker] Started publisher ${process.pid}`);
    while (running) {
        const published = await eventOutbox.flushDue();
        if (Date.now() - lastPrune > 3_600_000) {
            await eventOutbox.prune().catch((error) => console.error('[outbox-worker] Prune failed:', error));
            lastPrune = Date.now();
        }
        if (published === 0) await wait(env.OUTBOX_POLL_MS);
    }
};

const shutdown = (signal: string): void => {
    console.log(`[outbox-worker] Received ${signal}`);
    running = false;
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

loop()
    .catch((error) => {
        console.error('[outbox-worker] Fatal error:', error);
        process.exitCode = 1;
    })
    .finally(() => Promise.all([redisStreams.close(), closeDatabase()]));
