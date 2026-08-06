import { env } from './config/env';
import { closeDatabase } from './config/database';
import { ExecutionReconciler } from './services/execution/executionReconciler';
import { ExecutionService } from './services/execution/executionService';

const reconciler = new ExecutionReconciler();
const execution = new ExecutionService();
let stopped = false;

const delay = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, env.EXECUTION_RECONCILE_MS));

const loop = async (): Promise<void> => {
    const recovery = execution.capabilities().provider === 'jupiter_swap_v2';
    if (!env.SOLANA_RPC_URL && !recovery) {
        console.log('[execution-reconciler] Disabled because execution recovery and Solana RPC are not configured');
        return;
    }
    console.log(
        `[execution-reconciler] Started with batch size ${env.EXECUTION_RECONCILE_BATCH}`
        + ` and concurrency ${Math.min(env.EXECUTION_RECONCILE_BATCH, env.EGRESS_DB_POOL_MAX)}`
    );
    while (!stopped) {
        if (env.SOLANA_RPC_URL) {
            await reconciler.runBatch().catch((error) => {
                console.error('[execution-reconciler] RPC batch failed', error);
            });
        }
        if (recovery) {
            await execution.recoverBatch().catch((error) => {
                console.error('[execution-reconciler] Recovery batch failed', error);
            });
        }
        if (!stopped) await delay();
    }
};

const stop = (signal: string): void => {
    console.log(`[execution-reconciler] Received ${signal}, stopping`);
    stopped = true;
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

if (require.main === module) {
    loop()
        .catch((error) => {
            console.error('[execution-reconciler] Fatal error', error);
            process.exitCode = 1;
        })
        .finally(() => closeDatabase());
}
