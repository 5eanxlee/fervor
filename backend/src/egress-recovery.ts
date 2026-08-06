import { closeDatabase } from './config/database';
import { env } from './config/env';
import { runBatchLoop } from './services/batchLoop';
import { EgressRecovery } from './services/orders/egressRecovery';
import { WorkerProbe } from './services/workerProbe';

const recovery = new EgressRecovery();
const probe = new WorkerProbe(
    'egress_recovery',
    env.EGRESS_HEALTH_PORT,
    env.EGRESS_MAX_ERRORS,
    Math.max(env.EGRESS_ACQUIRE_MS, env.EGRESS_RECOVERY_MS) * 3
);
const shutdown = new AbortController();

const loop = async (): Promise<void> => {
    await probe.start();
    console.log(`[egress-recovery] Started with batch size ${env.EGRESS_RECOVERY_BATCH}`);
    try {
        await runBatchLoop(
            'egress-recovery', recovery, probe, shutdown.signal,
            env.EGRESS_RECOVERY_MS, env.EGRESS_ACQUIRE_MS
        );
    } finally {
        await probe.stop();
    }
};

const stop = (signal: string): void => {
    console.log(`[egress-recovery] Received ${signal}, stopping`);
    shutdown.abort();
};

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

if (require.main === module) {
    loop()
        .catch((error) => {
            console.error('[egress-recovery] Fatal error', error);
            process.exitCode = 1;
        })
        .finally(() => closeDatabase());
}
