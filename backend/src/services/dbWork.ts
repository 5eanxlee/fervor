import type { PoolClient } from 'pg';
import { abortable, boundedSignal } from './providerCall';

interface ClientSource {
    getClient: () => Promise<PoolClient>;
}

export const withDbClient = async <T>(
    source: ClientSource,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    label: string,
    use: (client: PoolClient) => Promise<T>
): Promise<T> => {
    const bound = boundedSignal(timeoutMs, signal);
    const pending = source.getClient();
    let client: PoolClient | undefined;
    let discard = false;
    const timeout = () => Object.assign(new Error(`${label} database timed out`), {
        name: 'TimeoutError',
    });
    try {
        client = await abortable(pending, bound.signal, timeout);
        return await abortable(use(client), bound.signal, timeout);
    } catch (error) {
        discard = bound.signal.aborted;
        if (!client && discard) {
            void pending.then(
                (late) => late.release(true),
                () => undefined
            );
        }
        throw error;
    } finally {
        bound.close();
        client?.release(discard);
    }
};
