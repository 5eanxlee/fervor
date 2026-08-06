import { abortable } from './providerCall';

interface BatchTask {
    runBatch: (batch?: number, signal?: AbortSignal) => Promise<number>;
}

interface BatchHealth {
    success: () => void;
    failure: () => boolean;
}

export const waitForBatch = (delayMs: number, signal: AbortSignal): Promise<void> => (
    new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(done, delayMs);
        timer.unref?.();
        signal.addEventListener('abort', done, { once: true });
        function done(): void {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        }
    })
);

export const runBatchLoop = async (
    name: string,
    task: BatchTask,
    health: BatchHealth,
    signal: AbortSignal,
    delayMs: number,
    batchMs: number,
    onError: (error: unknown) => void = (error) => {
        console.error(`[${name}] Batch failed`, error);
    }
): Promise<void> => {
    while (!signal.aborted) {
        const batch = new AbortController();
        const timeout = setTimeout(() => batch.abort(Object.assign(
            new Error(`${name} batch timed out`), { name: 'TimeoutError' }
        )), batchMs);
        timeout.unref?.();
        const abort = (): void => batch.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        try {
            await abortable(
                task.runBatch(undefined, batch.signal),
                batch.signal,
                () => Object.assign(new Error(`${name} batch timed out`), {
                    name: 'TimeoutError',
                })
            );
            health.success();
        } catch (error) {
            if (signal.aborted) return;
            onError(error);
            if (health.failure()) {
                throw Object.assign(
                    new Error(`${name} reached its consecutive failure limit`),
                    { cause: error }
                );
            }
        } finally {
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
        }
        if (!signal.aborted) await waitForBatch(delayMs, signal);
    }
};
