import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { metrics } from './metrics';

export const STREAMS = {
    decodedTrades: 'market.trades.decoded',
    marketTrades: 'market.trades',
    marketPoolEvents: 'market.pool_events',
    marketStates: 'market.states',
    marketCandles: 'market.candles',
    ticksNormalized: 'ticks.normalized',
    alertCandidates: 'alerts.candidates',
    alertsTriggered: 'alerts.triggered',
    notificationsPending: 'notifications.pending',
    alertIndexUpdates: 'alerts.index_updates',
    executionRequests: 'execution.requests',
    executionLifecycle: 'execution.lifecycle',
    orderLifecycle: 'orders.lifecycle',
    walletEvents: 'wallet.events',
    deadLetters: 'pipeline.dead_letters',
} as const;

export type StreamName = typeof STREAMS[keyof typeof STREAMS] | `ticks.normalized.${number}`;

export const tickStream = (shardId: number, shardCount: number): StreamName =>
    shardCount === 1 ? STREAMS.ticksNormalized : `ticks.normalized.${shardId}`;

export interface StreamMessage<T = any> {
    id: string;
    payload: T;
}

export class RedisStreamService {
    private commandClient: Redis | null = null;
    private consumerClient: Redis | null = null;

    get command(): Redis {
        if (!this.commandClient) {
            this.commandClient = new Redis(env.REDIS_URL || 'redis://localhost:6379', {
                maxRetriesPerRequest: 3,
                enableReadyCheck: true,
                lazyConnect: true,
            });
        }
        return this.commandClient;
    }

    get consumer(): Redis {
        if (!this.consumerClient) {
            this.consumerClient = new Redis(env.REDIS_URL || 'redis://localhost:6379', {
                maxRetriesPerRequest: null,
                enableReadyCheck: true,
                lazyConnect: true,
            });
        }
        return this.consumerClient;
    }

    async connect(): Promise<void> {
        await Promise.all([
            this.command.connect().catch((error) => {
                if (error?.message?.includes('already connecting') || error?.message?.includes('already connected')) return;
                throw error;
            }),
            this.consumer.connect().catch((error) => {
                if (error?.message?.includes('already connecting') || error?.message?.includes('already connected')) return;
                throw error;
            }),
        ]);
    }

    async ping(): Promise<boolean> {
        try {
            await this.command.ping();
            metrics.gauge('fervor_redis_up', 1);
            return true;
        } catch (error) {
            metrics.gauge('fervor_redis_up', 0);
            return false;
        }
    }

    async fixedWindow(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
        const script = `
          local count = redis.call('INCR', KEYS[1])
          if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
          return {count, redis.call('PTTL', KEYS[1])}
        `;
        const result = await this.command.eval(script, 1, key, String(windowMs)) as [number, number];
        return { count: Number(result[0]), ttlMs: Math.max(0, Number(result[1])) };
    }

    async reserveWindows(windows: Array<{ key: string; limit: number; windowMs: number }>): Promise<number> {
        return this.reserveRate('notification', windows);
    }

    async reserveRate(
        namespace: string,
        windows: Array<{ key: string; limit: number; windowMs: number }>
    ): Promise<number> {
        if (windows.length === 0) return 0;
        const script = `
          local wait = 0
          for index = 1, #KEYS do
            local count = tonumber(redis.call('GET', KEYS[index]) or '0')
            if count >= tonumber(ARGV[index * 2 - 1]) then
              wait = math.max(wait, tonumber(redis.call('PTTL', KEYS[index]) or '0'))
            end
          end
          if wait > 0 then return wait end
          for index = 1, #KEYS do
            local count = redis.call('INCR', KEYS[index])
            if count == 1 then redis.call('PEXPIRE', KEYS[index], ARGV[index * 2]) end
          end
          return 0
        `;
        const args = windows.flatMap((window) => [String(window.limit), String(window.windowMs)]);
        return Math.max(0, Number(await this.command.eval(
            script,
            windows.length,
            ...windows.map((window) => `${namespace}:rate:${window.key}`),
            ...args
        )));
    }

    async reserveSliding(
        namespace: string,
        windows: Array<{ key: string; limit: number; windowMs: number }>
    ): Promise<number> {
        if (windows.length === 0) return 0;
        const script = `
          local now = tonumber(ARGV[1])
          local wait = 0
          for index = 1, #KEYS do
            local limit = tonumber(ARGV[index * 2])
            local window = tonumber(ARGV[index * 2 + 1])
            redis.call('ZREMRANGEBYSCORE', KEYS[index], '-inf', now - window)
            if redis.call('ZCARD', KEYS[index]) >= limit then
              local oldest = redis.call('ZRANGE', KEYS[index], 0, 0, 'WITHSCORES')
              if #oldest > 0 then wait = math.max(wait, tonumber(oldest[2]) + window - now) end
            end
          end
          if wait > 0 then return wait end
          local member = ARGV[#ARGV]
          for index = 1, #KEYS do
            local window = tonumber(ARGV[index * 2 + 1])
            redis.call('ZADD', KEYS[index], now, member .. ':' .. index)
            redis.call('PEXPIRE', KEYS[index], window + 1000)
          end
          return 0
        `;
        const now = Date.now();
        const args = windows.flatMap((window) => [String(window.limit), String(window.windowMs)]);
        return Math.max(0, Number(await this.command.eval(
            script,
            windows.length,
            ...windows.map((window) => `${namespace}:sliding:${window.key}`),
            String(now),
            ...args,
            `${process.pid}:${randomUUID()}`
        )));
    }

    async gateDelay(keys: string[]): Promise<number> {
        return this.rateDelay('notification', keys);
    }

    async rateDelay(namespace: string, keys: string[]): Promise<number> {
        if (keys.length === 0) return 0;
        const script = `
          local wait = 0
          for index = 1, #KEYS do
            wait = math.max(wait, tonumber(redis.call('PTTL', KEYS[index]) or '0'))
          end
          return wait
        `;
        return Math.max(0, Number(await this.command.eval(
            script,
            keys.length,
            ...keys.map((key) => `${namespace}:gate:${key}`)
        )));
    }

    async setGate(key: string, delayMs: number): Promise<void> {
        return this.setRateGate('notification', key, delayMs);
    }

    async setRateGate(namespace: string, key: string, delayMs: number): Promise<void> {
        const script = `
          local ttl = tonumber(redis.call('PTTL', KEYS[1]) or '0')
          if ttl < tonumber(ARGV[1]) then
            redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
          end
        `;
        await this.command.eval(
            script,
            1,
            `${namespace}:gate:${key}`,
            String(Math.max(1, Math.ceil(delayMs)))
        );
    }

    async recordCircuit(input: {
        provider: string;
        success: boolean;
        minRequests: number;
        errorRate: number;
        windowMs: number;
        openMs: number;
    }): Promise<boolean> {
        const script = `
          local total = redis.call('INCR', KEYS[1])
          if total == 1 then
            redis.call('PEXPIRE', KEYS[1], ARGV[1])
            redis.call('PEXPIRE', KEYS[2], ARGV[1])
          end
          local errors = tonumber(redis.call('GET', KEYS[2]) or '0')
          if ARGV[2] == '0' then
            errors = redis.call('INCR', KEYS[2])
            if redis.call('PTTL', KEYS[2]) < 0 then redis.call('PEXPIRE', KEYS[2], ARGV[1]) end
          end
          if total >= tonumber(ARGV[3]) and (errors / total) >= tonumber(ARGV[4]) then
            local ttl = tonumber(redis.call('PTTL', KEYS[3]) or '0')
            if ttl < tonumber(ARGV[5]) then redis.call('SET', KEYS[3], '1', 'PX', ARGV[5]) end
            return 1
          end
          return 0
        `;
        const prefix = `notification:circuit:${input.provider}`;
        const result = await this.command.eval(
            script,
            3,
            `${prefix}:total`,
            `${prefix}:errors`,
            `notification:gate:${input.provider}:global`,
            String(input.windowMs),
            input.success ? '1' : '0',
            String(input.minRequests),
            String(input.errorRate),
            String(input.openMs)
        );
        return Number(result) === 1;
    }

    async retryCount(key: string, ttlSeconds = 90000): Promise<number> {
        const script = `
          local count = redis.call('INCR', KEYS[1])
          if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
          return count
        `;
        return Number(await this.command.eval(script, 1, `stream:retry:${key}`, String(ttlSeconds)));
    }

    async clearRetry(key: string): Promise<void> {
        await this.command.del(`stream:retry:${key}`);
    }

    async ensureGroup(stream: StreamName, group: string): Promise<void> {
        try {
            await this.command.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
        } catch (error: any) {
            if (!String(error?.message || '').includes('BUSYGROUP')) {
                throw error;
            }
        }
    }

    private maxLenFor(stream: StreamName): number {
        if (stream === STREAMS.decodedTrades || stream === STREAMS.marketTrades || stream === STREAMS.marketStates || stream === STREAMS.marketPoolEvents || stream === STREAMS.marketCandles) {
            return env.REDIS_STREAM_MAXLEN_MARKET_EVENTS;
        }
        if (stream.startsWith(STREAMS.ticksNormalized)) {
            return env.REDIS_STREAM_MAXLEN_TICKS;
        }
        if (stream === STREAMS.notificationsPending) return env.REDIS_STREAM_MAXLEN_NOTIFICATIONS;
        if (stream === STREAMS.deadLetters) return env.REDIS_STREAM_MAXLEN_DEAD_LETTERS;
        return 100000;
    }

    async publish(stream: StreamName, payload: unknown, maxLen = this.maxLenFor(stream)): Promise<string> {
        const done = metrics.timer('fervor_redis_stream_publish_ms', { stream });
        try {
            const id = await this.command.xadd(
                stream,
                'MAXLEN',
                '~',
                maxLen,
                '*',
                'payload',
                JSON.stringify(payload)
            );
            if (!id) {
                throw new Error(`Redis did not return an id for stream ${stream}`);
            }
            metrics.increment('fervor_redis_stream_published', { stream });
            return id;
        } finally {
            done();
        }
    }

    async publishOnce(stream: StreamName, key: string, payload: unknown, ttlSeconds = 90000): Promise<boolean> {
        const script = `
          if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
          redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
          redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], '*', 'payload', ARGV[3])
          return 1
        `;
        const result = await this.command.eval(
            script,
            2,
            `stream:seen:${stream}:${key}`,
            stream,
            String(ttlSeconds),
            String(this.maxLenFor(stream)),
            JSON.stringify(payload)
        );
        return Number(result) === 1;
    }

    async loadRollup<T>(tokenMint: string): Promise<T | null> {
        const value = await this.command.get(`metrics:rollup:${tokenMint}`);
        return value ? JSON.parse(value) as T : null;
    }

    async loadMetricState<T>(eventKey: string): Promise<T | null> {
        const value = await this.command.get(`metrics:event:${eventKey}`);
        return value ? JSON.parse(value) as T : null;
    }

    async commitMetric(input: {
        eventKey: string;
        tokenMint: string;
        snapshot: unknown;
        expectedRev: number;
        nextRev: number;
        state: unknown;
        tick: unknown;
        tickStream: StreamName;
    }): Promise<'committed' | 'duplicate' | 'conflict'> {
        const script = `
          if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
          local revision = tonumber(redis.call('GET', KEYS[3]) or '0')
          if revision ~= tonumber(ARGV[2]) then return -1 end
          redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
          redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[1])
          redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[1])
          redis.call('SET', KEYS[4], ARGV[6], 'EX', ARGV[1])
          redis.call('XADD', KEYS[5], 'MAXLEN', '~', ARGV[5], '*', 'payload', ARGV[6])
          redis.call('XADD', KEYS[6], 'MAXLEN', '~', ARGV[7], '*', 'payload', ARGV[8])
          return 1
        `;
        const ttlSeconds = 90000;
        const result = await this.command.eval(
            script,
            6,
            `metrics:seen:${input.eventKey}`,
            `metrics:rollup:${input.tokenMint}`,
            `metrics:revision:${input.tokenMint}`,
            `metrics:event:${input.eventKey}`,
            STREAMS.marketStates,
            input.tickStream,
            String(ttlSeconds),
            String(input.expectedRev),
            String(input.nextRev),
            JSON.stringify(input.snapshot),
            String(this.maxLenFor(STREAMS.marketStates)),
            JSON.stringify(input.state),
            String(this.maxLenFor(input.tickStream)),
            JSON.stringify(input.tick)
        );
        if (Number(result) === 1) return 'committed';
        if (Number(result) === -1) return 'conflict';
        return 'duplicate';
    }

    async readGroup<T>(
        stream: StreamName,
        group: string,
        consumer: string,
        count = env.REDIS_STREAM_BATCH_SIZE
    ): Promise<StreamMessage<T>[]> {
        const response = await this.consumer.xreadgroup(
            'GROUP',
            group,
            consumer,
            'COUNT',
            count,
            'BLOCK',
            env.REDIS_STREAM_BLOCK_MS,
            'STREAMS',
            stream,
            '>'
        );

        if (!response) return [];

        const messages: StreamMessage<T>[] = [];
        for (const [, entries] of response as any[]) {
            for (const [id, values] of entries) {
                const payloadIndex = values.indexOf('payload');
                if (payloadIndex === -1) continue;
                messages.push({
                    id,
                    payload: JSON.parse(values[payloadIndex + 1]) as T,
                });
            }
        }

        metrics.increment('fervor_redis_stream_read', { stream }, messages.length);
        return messages;
    }

    async claimStaleGroup<T>(
        stream: StreamName,
        group: string,
        consumer: string,
        minIdleMs = env.REDIS_STREAM_STALE_MS,
        count = env.REDIS_STREAM_BATCH_SIZE
    ): Promise<StreamMessage<T>[]> {
        const response = await (this.command as any).xautoclaim(
            stream,
            group,
            consumer,
            minIdleMs,
            '0-0',
            'COUNT',
            count
        ) as any[];

        const entries = response?.[1] || [];
        const messages: StreamMessage<T>[] = [];
        for (const [id, values] of entries) {
            const payloadIndex = values.indexOf('payload');
            if (payloadIndex === -1) continue;
            messages.push({
                id,
                payload: JSON.parse(values[payloadIndex + 1]) as T,
            });
        }

        if (messages.length > 0) {
            metrics.increment('fervor_redis_stream_stale_claimed', { stream }, messages.length);
        }
        return messages;
    }

    async groupStats(stream: StreamName, group: string): Promise<{ pending: number; lag?: number; length: number }> {
        const [length, groups] = await Promise.all([
            this.command.xlen(stream).catch(() => 0),
            this.command.xinfo('GROUPS', stream).catch(() => [] as any[]),
        ]);
        const groupInfo = (groups as any[]).find((entry) => Array.isArray(entry) && entry[entry.indexOf('name') + 1] === group);
        const pending = groupInfo ? Number(groupInfo[groupInfo.indexOf('pending') + 1] || 0) : 0;
        const lagIndex = groupInfo ? groupInfo.indexOf('lag') : -1;
        const lag = groupInfo && lagIndex >= 0 ? Number(groupInfo[lagIndex + 1] || 0) : undefined;
        metrics.gauge('fervor_redis_stream_length', Number(length), { stream });
        metrics.gauge('fervor_redis_stream_pending', pending, { stream, group });
        if (lag !== undefined) metrics.gauge('fervor_redis_stream_lag', lag, { stream, group });
        return { pending, lag, length: Number(length) };
    }

    async read<T>(
        streams: StreamName[],
        ids: string[],
        blockMs = env.REDIS_STREAM_BLOCK_MS,
        count = env.REDIS_STREAM_BATCH_SIZE
    ): Promise<Array<StreamMessage<T> & { stream: StreamName }>> {
        if (streams.length === 0 || streams.length !== ids.length) return [];

        const response = await this.consumer.xread(
            'COUNT',
            count,
            'BLOCK',
            blockMs,
            'STREAMS',
            ...streams,
            ...ids
        );

        if (!response) return [];

        const messages: Array<StreamMessage<T> & { stream: StreamName }> = [];
        for (const [stream, entries] of response as any[]) {
            for (const [id, values] of entries) {
                const payloadIndex = values.indexOf('payload');
                if (payloadIndex === -1) continue;
                messages.push({
                    stream,
                    id,
                    payload: JSON.parse(values[payloadIndex + 1]) as T,
                });
            }
        }

        return messages;
    }

    async ack(stream: StreamName, group: string, id: string): Promise<void> {
        await this.command.xack(stream, group, id);
    }

    async deadLetter(sourceStream: StreamName, id: string, payload: unknown, error: unknown): Promise<void> {
        await this.publish(STREAMS.deadLetters, {
            sourceStream,
            sourceId: id,
            payload,
            error: error instanceof Error ? error.message : String(error),
            createdAt: new Date().toISOString(),
        });
        metrics.increment('fervor_redis_stream_dead_letters', { stream: sourceStream });
    }

    async close(): Promise<void> {
        const command = this.commandClient;
        const consumer = this.consumerClient;
        this.commandClient = null;
        this.consumerClient = null;
        await Promise.all([
            command?.quit(),
            consumer?.quit(),
        ]);
    }
}

export const redisStreams = new RedisStreamService();
