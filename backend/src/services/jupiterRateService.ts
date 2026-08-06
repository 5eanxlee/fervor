import { env } from '../config/env';
import { metrics } from './metrics';
import { abortable } from './providerCall';
import { redisStreams } from './redisStreamService';

export type JupiterBucket = 'main' | 'execute';

export interface RateResult {
    status: number;
    header: (name: string) => string | null | undefined;
}

export const rateHeader = (headers: unknown, name: string): string | undefined => {
    if (!headers || typeof headers !== 'object') return undefined;
    const value = headers as Record<string, unknown> & { get?: (key: string) => unknown };
    const raw = typeof value.get === 'function' ? value.get.call(headers, name) : value[name];
    return raw === undefined || raw === null ? undefined : String(raw);
};

const safeDelay = (value: number): number | undefined => (
    Number.isFinite(value) && value >= 0
        ? Math.min(value, env.JUPITER_RETRY_MAX_MS)
        : undefined
);

const resetDelay = (header: RateResult['header']): number | undefined => {
    const reset = Number(header('x-ratelimit-reset'));
    if (!Number.isFinite(reset) || reset <= 0) return undefined;
    return safeDelay(Math.max(0, reset * 1000 - Date.now()));
};

const retryDelay = (header: RateResult['header']): number | undefined => {
    const raw = header('retry-after');
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return seconds >= 0 ? safeDelay(seconds * 1000) : undefined;
    const at = Date.parse(raw);
    return Number.isFinite(at) ? safeDelay(Math.max(0, at - Date.now())) : undefined;
};

export const jupiterDelay = (result: RateResult): number | undefined => {
    const remaining = Number(result.header('x-ratelimit-remaining'));
    const limited = result.status === 429 || (Number.isFinite(remaining) && remaining <= 1);
    const retry = retryDelay(result.header);
    const reset = limited ? resetDelay(result.header) : undefined;
    const fallback = result.status === 429 ? 1000 : undefined;
    const delays = [retry, reset, fallback].filter(
        (value): value is number => value !== undefined
    );
    return delays.length > 0 ? Math.max(...delays) : undefined;
};

export class JupiterRateService {
    private readonly localGate = new Map<JupiterBucket, number>();

    private localDelay(bucket: JupiterBucket): number {
        const until = this.localGate.get(bucket) || 0;
        const delay = until - Date.now();
        if (delay > 0) return delay;
        this.localGate.delete(bucket);
        return 0;
    }

    private holdLocal(bucket: JupiterBucket, delay?: number): void {
        if (!env.REDIS_URL || delay === undefined) return;
        this.localGate.set(bucket, Math.max(this.localGate.get(bucket) || 0, Date.now() + delay));
    }

    async reserve(bucket: JupiterBucket, signal?: AbortSignal): Promise<number> {
        if (!env.REDIS_URL) return 0;
        const local = this.localDelay(bucket);
        if (local > 0) return local;
        const bounded = <T>(work: Promise<T>): Promise<T> => signal
            ? abortable(work, signal, () => Object.assign(new Error('Rate reservation aborted'), { name: 'AbortError' }))
            : work;
        const gate = await bounded(redisStreams.rateDelay('provider', [`jupiter:${bucket}`]));
        const observedGate = this.localDelay(bucket);
        if (gate > 0 || observedGate > 0) return Math.max(gate, observedGate);
        const windows = bucket === 'execute'
            ? [{ key: 'jupiter:execute', limit: env.JUPITER_EXEC_RATE_PER_SEC, windowMs: 1000 }]
            : [{ key: 'jupiter:main', limit: env.JUPITER_RATE_PER_MIN, windowMs: 60_000 }];
        const delay = await bounded(redisStreams.reserveSliding('provider', windows));
        const lateGate = this.localDelay(bucket);
        if (lateGate > 0) return Math.max(delay, lateGate);
        if (delay > 0) metrics.increment('fervor_jupiter_rate_deferred', { bucket });
        return delay;
    }

    async observe(bucket: JupiterBucket, response: Response): Promise<number | undefined> {
        return this.observeResult(bucket, {
            status: response.status,
            header: (name) => response.headers.get(name),
        });
    }

    observeSoon(bucket: JupiterBucket, response: Response): number | undefined {
        const result = {
            status: response.status,
            header: (name: string) => response.headers.get(name),
        };
        const delay = jupiterDelay(result);
        this.holdLocal(bucket, delay);
        void this.observeResult(bucket, result).catch(() => {
            metrics.increment('fervor_jupiter_rate_observe_errors', { bucket });
        });
        return delay;
    }

    async observeResult(bucket: JupiterBucket, result: RateResult): Promise<number | undefined> {
        const delay = jupiterDelay(result);
        this.holdLocal(bucket, delay);
        if (!env.REDIS_URL) return undefined;
        if (delay !== undefined) {
            await redisStreams.setRateGate('provider', `jupiter:${bucket}`, Math.max(1, delay));
            return delay;
        }
        return undefined;
    }
}

export const jupiterRate = new JupiterRateService();
