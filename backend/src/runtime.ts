import { closeDatabase } from './config/database';
import { redisStreams } from './services/redisStreamService';

export const closeRuntime = async (extra: Array<() => Promise<unknown>> = []): Promise<void> => {
    const results = await Promise.allSettled([
        redisStreams.close(),
        closeDatabase(),
        ...extra.map((close) => close()),
    ]);
    for (const result of results) {
        if (result.status === 'rejected') {
            console.error('[runtime] Resource close failed', {
                error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
            process.exitCode = 1;
        }
    }
};
