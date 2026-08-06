import { createRetentionDb, loadRetention } from './config/retention';
import { runBatchLoop } from './services/batchLoop';
import { BlobRetention } from './services/orders/blobRetention';
import { WorkerProbe } from './services/workerProbe';

const config = loadRetention();
const db = createRetentionDb(config);
const retention = new BlobRetention(db, config.batch, config.batchMs);
const probe = new WorkerProbe(
    'blob_retention',
    config.healthPort,
    config.maxErrors,
    Math.max(config.batchMs, config.intervalMs) * 3
);
const shutdown = new AbortController();

const loop = async (): Promise<void> => {
    await probe.start();
    console.log(`[blob-retention] Started with batch size ${config.batch}`);
    try {
        await runBatchLoop(
            'blob-retention', retention, probe, shutdown.signal,
            config.intervalMs, config.batchMs
        );
    } finally {
        await probe.stop();
    }
};

const stop = (signal: string): void => {
    console.log(`[blob-retention] Received ${signal}, stopping`);
    shutdown.abort();
};

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

if (require.main === module) {
    loop()
        .catch((error) => {
            console.error('[blob-retention] Fatal error', error);
            process.exitCode = 1;
        })
        .finally(() => db.close());
}
