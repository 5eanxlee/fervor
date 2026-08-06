import { env } from './config/env';
import { WalletIndexerService } from './services/wallets/walletIndexerService';
import { closeRuntime } from './runtime';

const service = new WalletIndexerService();
let stopped = false;

const loop = async (): Promise<void> => {
    while (!stopped) {
        await service.runBatch().catch((error) => console.error('[wallet-indexer] Batch failed', error));
        await new Promise((resolve) => setTimeout(resolve, env.WALLET_POLL_INTERVAL_MS));
    }
};

const stop = (): void => { stopped = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

if (require.main === module) {
    loop()
        .catch((error) => {
            console.error('[wallet-indexer] Fatal error', error);
            process.exitCode = 1;
        })
        .finally(() => closeRuntime());
}
