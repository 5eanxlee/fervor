import { env } from '../../config/env';
import {
    redisStreams,
    STREAMS,
    type StreamMessage,
    type StreamName,
} from '../redisStreamService';
import { metrics } from '../metrics';

export const marketStreams: readonly StreamName[] = [
    STREAMS.marketTrades,
    STREAMS.marketStates,
    STREAMS.marketCandles,
    STREAMS.alertCandidates,
    STREAMS.alertsTriggered,
];

export interface MarketSseEvent {
    readonly event: string;
    readonly data: unknown;
    readonly id: string;
    readonly delivery: 'exact' | 'ordered' | 'state';
}

export type MarketNotice =
    | { readonly type: 'events'; readonly events: readonly MarketSseEvent[] }
    | { readonly type: 'heartbeat'; readonly at: number }
    | { readonly type: 'source_error'; readonly retryMs: number }
    | { readonly type: 'draining' };

type Listener = (notice: MarketNotice) => void;
type MarketMessage = StreamMessage<unknown> & { readonly stream: StreamName };

export interface MarketReader {
    connect(): Promise<void>;
    read<T>(
        streams: StreamName[],
        ids: string[],
        blockMs: number,
        count: number
    ): Promise<Array<StreamMessage<T> & { stream: StreamName }>>;
}

const tokenOf = (payload: unknown): string | undefined => {
    if (!payload || typeof payload !== 'object') return undefined;
    const value = payload as Record<string, unknown>;
    for (const key of ['tokenMint', 'tokenAddress', 'token_mint', 'token_address']) {
        if (typeof value[key] === 'string') return value[key];
    }
    return undefined;
};

const eventName = (stream: StreamName): string => {
    if (stream === STREAMS.marketTrades) return 'trade';
    if (stream === STREAMS.marketStates) return 'market_state';
    if (stream === STREAMS.marketCandles) return 'candle';
    if (stream === STREAMS.alertCandidates) return 'alert_candidate';
    if (stream === STREAMS.alertsTriggered) return 'alert_triggered';
    return 'message';
};

const deliveryOf = (event: string): MarketSseEvent['delivery'] => {
    if (event === 'alert_candidate' || event === 'alert_triggered') return 'exact';
    return event === 'market_state' ? 'state' : 'ordered';
};

const sanitize = (event: string, payload: unknown): unknown => {
    if (event !== 'alert_candidate' && event !== 'alert_triggered') return payload;
    const value = payload as Record<string, unknown>;
    return {
        tokenAddress: value.tokenAddress,
        thresholdType: value.thresholdType,
        condition: value.condition,
        currentValue: value.currentValue,
        matchedAt: value.matchedAt ?? value.triggeredAt,
        engineVersion: value.engineVersion,
    };
};

export const streamMessagesToSseEvents = (
    messages: readonly MarketMessage[],
    tokenMint: string
): MarketSseEvent[] => messages
    .filter((message) => tokenOf(message.payload) === tokenMint)
    .map((message) => {
        const event = eventName(message.stream);
        return {
            event,
            data: sanitize(event, message.payload),
            id: message.id,
            delivery: deliveryOf(event),
        };
    });

const wait = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
});

export interface MarketFanoutConfig {
    readonly blockMs: number;
    readonly batchSize: number;
    readonly heartbeatMs: number;
}

export class MarketFanout {
    private readonly listeners = new Map<string, Set<Listener>>();
    private running?: Promise<void>;
    private heartbeat?: NodeJS.Timeout;
    private closed = false;
    private failures = 0;

    constructor(
        private readonly reader: MarketReader,
        private readonly config: MarketFanoutConfig
    ) {
        if (!Number.isSafeInteger(config.blockMs) || config.blockMs < 1
            || !Number.isSafeInteger(config.batchSize) || config.batchSize < 1
            || !Number.isSafeInteger(config.heartbeatMs) || config.heartbeatMs < 1_000) {
            throw new Error('Market fanout limits are invalid');
        }
    }

    subscribe(tokenMint: string, listener: Listener): () => void {
        if (this.closed) throw new Error('Market fanout is closed');
        const tokenListeners = this.listeners.get(tokenMint) ?? new Set<Listener>();
        tokenListeners.add(listener);
        this.listeners.set(tokenMint, tokenListeners);
        this.ensureRun();
        this.ensureHeartbeat();
        metrics.gauge('fervor_market_stream_subscribers', this.listenerCount());
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            tokenListeners.delete(listener);
            if (tokenListeners.size === 0) this.listeners.delete(tokenMint);
            if (this.listeners.size === 0 && this.heartbeat) {
                clearInterval(this.heartbeat);
                this.heartbeat = undefined;
            }
            metrics.gauge('fervor_market_stream_subscribers', this.listenerCount());
        };
    }

    async close(): Promise<void> {
        this.closed = true;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = undefined;
        this.broadcast({ type: 'draining' });
        this.listeners.clear();
    }

    private ensureRun(): void {
        if (this.running || this.closed) return;
        this.running = this.run().finally(() => {
            this.running = undefined;
            if (!this.closed && this.listeners.size > 0) this.ensureRun();
        });
    }

    private async run(): Promise<void> {
        const streams = [...marketStreams];
        const ids = streams.map(() => '$');
        let connected = false;
        while (!this.closed && this.listeners.size > 0) {
            try {
                if (!connected) {
                    await this.reader.connect();
                    connected = true;
                }
                const messages = await this.reader.read<unknown>(
                    streams,
                    ids,
                    this.config.blockMs,
                    this.config.batchSize
                );
                for (const message of messages) {
                    const index = streams.indexOf(message.stream);
                    if (index >= 0) ids[index] = message.id;
                }
                this.dispatch(messages);
                this.failures = 0;
                metrics.gauge('fervor_market_stream_up', 1);
            } catch {
                if (this.closed) break;
                connected = false;
                this.failures += 1;
                const retryMs = Math.min(1_000, 25 * 2 ** Math.min(this.failures, 6));
                metrics.gauge('fervor_market_stream_up', 0);
                metrics.increment('fervor_market_stream_errors');
                this.broadcast({ type: 'source_error', retryMs });
                await wait(retryMs);
            }
        }
    }

    private dispatch(messages: readonly MarketMessage[]): void {
        if (messages.length === 0) return;
        const byToken = new Map<string, MarketMessage[]>();
        for (const message of messages) {
            const token = tokenOf(message.payload);
            if (!token || !this.listeners.has(token)) continue;
            const tokenMessages = byToken.get(token) ?? [];
            tokenMessages.push(message);
            byToken.set(token, tokenMessages);
        }
        for (const [token, tokenMessages] of byToken) {
            const events = streamMessagesToSseEvents(tokenMessages, token);
            if (events.length === 0) continue;
            for (const listener of this.listeners.get(token) ?? []) {
                this.notify(listener, { type: 'events', events });
            }
        }
    }

    private broadcast(notice: MarketNotice): void {
        for (const listeners of this.listeners.values()) {
            for (const listener of listeners) this.notify(listener, notice);
        }
    }

    private notify(listener: Listener, notice: MarketNotice): void {
        try {
            listener(notice);
        } catch {
            metrics.increment('fervor_market_stream_listener_errors');
        }
    }

    private ensureHeartbeat(): void {
        if (this.heartbeat) return;
        this.heartbeat = setInterval(() => {
            this.broadcast({ type: 'heartbeat', at: Date.now() });
        }, this.config.heartbeatMs);
        this.heartbeat.unref();
    }

    private listenerCount(): number {
        let count = 0;
        for (const listeners of this.listeners.values()) count += listeners.size;
        return count;
    }
}

export const marketFanout = new MarketFanout(redisStreams, {
    blockMs: env.REDIS_STREAM_BLOCK_MS,
    batchSize: env.REDIS_STREAM_BATCH_SIZE,
    heartbeatMs: env.RT_HEARTBEAT_MS,
});
