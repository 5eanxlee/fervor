import { performance } from 'perf_hooks';
import { env, isMarketDataProviderConfigured } from '../config/env';
import {
    FeedTick,
    NormalizedMarketEvent,
    NormalizedMarketState,
    ProviderRawEvent,
} from '../types';
import { metrics } from './metrics';
import { DEFAULT_PROGRAM_IDS } from './marketData/programs';
import { createMarketDataProvider } from './marketData/providerFactory';
import { MarketDataProvider } from './marketData/provider';
import { marketStateToFeedTick, normalizeProviderRawEvent } from './marketData/normalization';
import { MarketEventStorageService } from './marketData/marketEventStorageService';
import { ProviderCheckpointService } from './marketData/providerCheckpointService';
import { RedisStreamService, redisStreams, STREAMS, tickStream } from './redisStreamService';
import { subscriptionRegistry } from './subscriptionRegistry';
import type { AlertIndexUpdate } from './subscriptionRegistry';
import { TickStorageService } from './tickStorageService';

export interface FeedEngineStageObserver {
    onStage?: (stage: 'redis_publish' | 'normalize' | 'db_persist' | 'alert_tick', durationMs: number) => void;
    onRedisMessage?: (stream: string, id: string) => void;
}

const sameTokenSet = (left: Set<string>, right: string[]): boolean => {
    if (left.size !== right.length) return false;
    return right.every((token) => left.has(token));
};

export class FeedEngineService {
    private readonly tickStorage = new TickStorageService();
    private readonly marketStorage = new MarketEventStorageService();
    private readonly checkpoints = new ProviderCheckpointService();
    private readonly provider: MarketDataProvider;
    private readonly subscriptionUpdateStreams = new RedisStreamService();
    private subscribedTokens = new Set<string>();
    private running = false;

    constructor(provider = createMarketDataProvider()) {
        this.provider = provider;
    }

    async start(): Promise<void> {
        if (!env.ENABLE_MARKET_FEED) {
            throw new Error('Feed engine is disabled. Set ENABLE_MARKET_FEED=true to start it.');
        }
        if (!isMarketDataProviderConfigured(this.provider.name)) {
            throw new Error(`Market data provider ${this.provider.name} is selected but not configured`);
        }

        await redisStreams.connect();
        this.tickStorage.start();
        this.running = true;

        const tokens = await subscriptionRegistry.getTokensForShard();
        metrics.gauge('fervor_feed_assigned_tokens', tokens.length, {
            shard: env.FEED_SHARD_ID,
            shardCount: env.FEED_SHARD_COUNT,
        });

        await this.provider.connect({
            onEvent: (event) => this.handleRawEvent(event),
            onError: (error, context) => this.handleProviderError(error, context),
        });

        const checkpoint = await this.checkpoints.get(this.provider.name, this.subscriptionId());
        await this.provider.resumeFromCheckpoint(checkpoint);
        await this.provider.subscribePrograms(DEFAULT_PROGRAM_IDS);
        await this.setSubscribedTokens(tokens, true);
        void this.watchAlertIndexUpdates();

        metrics.gauge('fervor_market_provider_configured', this.provider.configured ? 1 : 0, {
            provider: this.provider.name,
        });
    }

    async handleRawEvent(raw: ProviderRawEvent, observer?: FeedEngineStageObserver): Promise<void> {
        try {
            const rawPublishStarted = performance.now();
            const rawEventId = await redisStreams.publish(STREAMS.providerRawEvents, raw);
            const rawTickId = await redisStreams.publish(STREAMS.ticksRaw, raw);
            observer?.onRedisMessage?.(STREAMS.providerRawEvents, rawEventId);
            observer?.onRedisMessage?.(STREAMS.ticksRaw, rawTickId);
            observer?.onStage?.('redis_publish', performance.now() - rawPublishStarted);
            metrics.increment('fervor_provider_raw_events', { provider: raw.provider, type: raw.type });

            const normalizeStarted = performance.now();
            const events = normalizeProviderRawEvent(raw);
            observer?.onStage?.('normalize', performance.now() - normalizeStarted);

            const normalizedPublishStarted = performance.now();
            await this.publishNormalized(events, observer);
            observer?.onStage?.('redis_publish', performance.now() - normalizedPublishStarted);

            const persistStarted = performance.now();
            await this.marketStorage.persist(events);
            observer?.onStage?.('db_persist', performance.now() - persistStarted);

            for (const state of events.filter((event): event is NormalizedMarketState => event.kind === 'market_state')) {
                const tick = marketStateToFeedTick(state);
                if (!tick) continue;
                const alertTickStarted = performance.now();
                await this.publishAlertTick(tick, observer);
                observer?.onStage?.('alert_tick', performance.now() - alertTickStarted);
            }

            if (raw.slot) {
                await this.checkpoints.mark(raw.provider, this.subscriptionId(raw.subscriptionId), raw.slot);
            }
        } catch (error) {
            await redisStreams.deadLetter(STREAMS.providerRawEvents, raw.sourceEventId, raw, error);
            await this.checkpoints.recordError(raw.provider, {
                sourceEventId: raw.sourceEventId,
                eventType: raw.type,
                slot: raw.slot,
                signature: raw.signature,
                errorClass: error instanceof Error ? error.name : 'UnknownError',
                errorMessage: error instanceof Error ? error.message : String(error),
                payloadSummary: {
                    tokenMint: raw.tokenMint,
                    poolAddress: raw.poolAddress,
                    provider: raw.provider,
                },
            });
            metrics.increment('fervor_market_normalization_errors', { provider: raw.provider, type: raw.type });
        }
    }

    async handleTick(tick: FeedTick, raw: unknown): Promise<void> {
        await redisStreams.publish(STREAMS.ticksRaw, raw);
        await this.publishAlertTick(tick);
    }

    async stop(): Promise<void> {
        this.running = false;
        await this.provider.disconnect();
        await this.tickStorage.flush();
        this.tickStorage.stop();
        await this.subscriptionUpdateStreams.close();
    }

    private async publishNormalized(events: NormalizedMarketEvent[], observer?: FeedEngineStageObserver): Promise<void> {
        for (const event of events) {
            if (event.kind === 'trade') {
                const id = await redisStreams.publish(STREAMS.marketTrades, event);
                observer?.onRedisMessage?.(STREAMS.marketTrades, id);
            }
            if (event.kind === 'market_state') {
                const id = await redisStreams.publish(STREAMS.marketStates, event);
                observer?.onRedisMessage?.(STREAMS.marketStates, id);
            }
            if (event.kind === 'pool' || event.kind === 'liquidity') {
                const id = await redisStreams.publish(STREAMS.marketPoolEvents, event);
                observer?.onRedisMessage?.(STREAMS.marketPoolEvents, id);
            }
        }
        metrics.increment('fervor_market_events_normalized', undefined, events.length);
    }

    private async publishAlertTick(tick: FeedTick, observer?: FeedEngineStageObserver): Promise<void> {
        const stream = tickStream(env.FEED_SHARD_ID, env.FEED_SHARD_COUNT);
        const id = await redisStreams.publish(stream, tick);
        observer?.onRedisMessage?.(stream, id);
        await this.tickStorage.append(tick);
        await subscriptionRegistry.markTick(tick.tokenAddress);
        metrics.increment('fervor_ticks_received', { shard: env.FEED_SHARD_ID });
    }

    private async handleProviderError(error: Error, context?: Record<string, unknown>): Promise<void> {
        metrics.increment('fervor_market_provider_errors', { provider: this.provider.name });
        await this.checkpoints.recordError(this.provider.name, {
            eventType: 'provider_error',
            errorClass: error.name,
            errorMessage: error.message,
            payloadSummary: context || {},
        });
    }

    private subscriptionId(override?: string): string {
        return override || `${this.provider.name}:${env.MARKET_DATA_COMMITMENT}:${env.FEED_SHARD_ID}`;
    }

    private async setSubscribedTokens(tokens: string[], force = false): Promise<void> {
        const uniqueTokens = Array.from(new Set(tokens));
        if (!force && sameTokenSet(this.subscribedTokens, uniqueTokens)) return;

        await this.provider.subscribeTokens(uniqueTokens);
        this.subscribedTokens = new Set(uniqueTokens);
        metrics.gauge('fervor_feed_assigned_tokens', uniqueTokens.length, {
            shard: env.FEED_SHARD_ID,
            shardCount: env.FEED_SHARD_COUNT,
        });
        metrics.increment('fervor_feed_token_subscription_refreshes', { provider: this.provider.name });
    }

    private async refreshSubscribedTokens(): Promise<void> {
        const tokens = await subscriptionRegistry.getTokensForShard();
        await this.setSubscribedTokens(tokens);
    }

    private async watchAlertIndexUpdates(): Promise<void> {
        const ids = ['0'];

        try {
            await this.subscriptionUpdateStreams.connect();

            while (this.running) {
                const messages = await this.subscriptionUpdateStreams.read<AlertIndexUpdate>(
                    [STREAMS.alertIndexUpdates],
                    ids,
                    env.REDIS_STREAM_BLOCK_MS,
                    env.REDIS_STREAM_BATCH_SIZE
                );

                for (const message of messages) {
                    try {
                        if (message.payload?.shardId === env.FEED_SHARD_ID) {
                            await this.refreshSubscribedTokens();
                        }
                    } catch (error) {
                        await this.subscriptionUpdateStreams.deadLetter(STREAMS.alertIndexUpdates, message.id, message.payload, error);
                    } finally {
                        ids[0] = message.id;
                    }
                }
            }
        } catch (error) {
            if (this.running) {
                console.error('[feed-engine] Alert index update watcher failed:', error);
            }
        }
    }
}
