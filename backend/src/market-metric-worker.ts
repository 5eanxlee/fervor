import { env } from './config/env';
import { NormalizedTradeEvent } from './types';
import { MarketMetricService } from './services/marketData/marketMetricService';
import { MarketMetricBootstrap } from './services/marketData/marketMetricBootstrap';
import { redisStreams, STREAMS, StreamMessage } from './services/redisStreamService';
import { mapConcurrent, uniqueStreamMessages } from './services/streamWorker';
import { closeRuntime } from './runtime';

const group = 'market-metrics';
const consumer = `market-metric-${process.pid}`;
const projector = new MarketMetricService();
const bootstrap = new MarketMetricBootstrap(projector);
let running = true;
let lastPrune = 0;

const processMessage = async (message: StreamMessage<NormalizedTradeEvent>): Promise<void> => {
    try {
        await projector.project(message.payload);
        await redisStreams.clearRetry(`${STREAMS.marketTrades}:${message.id}`);
        await redisStreams.ack(STREAMS.marketTrades, group, message.id);
    } catch (error) {
        const count = await redisStreams.retryCount(`${STREAMS.marketTrades}:${message.id}`);
        if (count < env.MARKET_EVENT_MAX_ATTEMPTS) return;
        await redisStreams.deadLetter(STREAMS.marketTrades, message.id, message.payload, error);
        await redisStreams.ack(STREAMS.marketTrades, group, message.id);
    }
};

const loop = async (): Promise<void> => {
    await bootstrap.run();
    await redisStreams.connect();
    await redisStreams.ensureGroup(STREAMS.marketTrades, group);
    await projector.redrive();
    console.log(`[market-metric-worker] Started consumer ${consumer}`);
    while (running) {
        const fresh = await redisStreams.readGroup<NormalizedTradeEvent>(
            STREAMS.marketTrades,
            group,
            consumer,
            env.REDIS_STREAM_BATCH_SIZE
        );
        const stale = await redisStreams.claimStaleGroup<NormalizedTradeEvent>(
            STREAMS.marketTrades,
            group,
            consumer,
            env.REDIS_STREAM_STALE_MS,
            env.REDIS_STREAM_BATCH_SIZE
        ).catch(() => []);
        const messages = uniqueStreamMessages([...stale, ...fresh]);
        await mapConcurrent(
            messages,
            env.MARKET_WORKER_CONCURRENCY,
            processMessage
        );
        if (messages.length === 0) await projector.redrive();
        if (Date.now() - lastPrune >= 1_000) {
            lastPrune = Date.now();
            const cutoff = new Date(Date.now() - env.MARKET_METRIC_RETENTION_DAYS * 86_400_000);
            await projector.prune(cutoff).catch((error) => {
                console.error('[market-metric-worker] Retention batch failed:', error);
            });
        }
    }
};

const shutdown = (signal: string): void => {
    console.log(`[market-metric-worker] Received ${signal}`);
    running = false;
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

loop()
    .catch((error) => {
        console.error('[market-metric-worker] Fatal error:', error);
        process.exitCode = 1;
    })
    .finally(() => closeRuntime());
