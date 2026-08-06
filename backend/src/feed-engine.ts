import { FeedEngineService } from './services/feedEngine';
import { closeRuntime } from './runtime';

const service = new FeedEngineService();

const shutdown = async (signal: string) => {
    console.log(`[feed-engine] Received ${signal}, shutting down...`);
    await service.stop();
    await closeRuntime();
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

service.start().catch((error) => {
    console.error('[feed-engine] Failed to start:', error);
    process.exitCode = 1;
    return closeRuntime();
});
