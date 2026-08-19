import { env } from './config/env';
import { NormalizedTradeEvent } from './types';
import { MarketEventStorageService } from './services/marketData/marketEventStorageService';
import { isDecodedTrade, TradeEnricher } from './services/marketData/tradeEnricher';
import { referencePrices } from './services/referencePriceService';
import { redisStreams, STREAMS, StreamMessage } from './services/redisStreamService';
import { mapConcurrent, uniqueStreamMessages } from './services/streamWorker';
import { closeRuntime } from './runtime';

const group = 'trade-enrichers';
const consumer = `trade-enricher-${process.pid}`;
const enricher = new TradeEnricher(referencePrices);
const storage = new MarketEventStorageService();
let running = true;

const fail = async (message: StreamMessage<NormalizedTradeEvent>, error: unknown): Promise<void> => {
    const count = await redisStreams.retryCount(`${STREAMS.decodedTrades}:${message.id}`);
    if (count < env.MARKET_EVENT_MAX_ATTEMPTS) return;
    await redisStreams.deadLetter(STREAMS.decodedTrades, message.id, message.payload, error);
    await redisStreams.ack(STREAMS.decodedTrades, group, message.id);
};

const processMessage = async (message: StreamMessage<NormalizedTradeEvent>): Promise<void> => {
    if (!isDecodedTrade(message.payload)) {
        await redisStreams.deadLetter(STREAMS.decodedTrades, message.id, message.payload, 'Invalid decoded trade');
        await redisStreams.ack(STREAMS.decodedTrades, group, message.id);
        return;
    }
    try {
        const trade = await enricher.enrich(message.payload);
        if (!trade) throw new Error('Fresh quote USD reference is unavailable');
        await storage.persist([trade]);
        await redisStreams.publishOnce(STREAMS.marketTrades, trade.idempotencyKey, trade);
        await redisStreams.clearRetry(`${STREAMS.decodedTrades}:${message.id}`);
        await redisStreams.ack(STREAMS.decodedTrades, group, message.id);
    } catch (error) {
        await fail(message, error);
    }
};

const loop = async (): Promise<void> => {
    await redisStreams.connect();
    await redisStreams.ensureGroup(STREAMS.decodedTrades, group);
    console.log(`[market-trade-worker] Started consumer ${consumer}`);
    while (running) {
        const fresh = await redisStreams.readGroup<NormalizedTradeEvent>(
            STREAMS.decodedTrades,
            group,
            consumer,
            env.REDIS_STREAM_BATCH_SIZE
        );
        const stale = await redisStreams.claimStaleGroup<NormalizedTradeEvent>(
            STREAMS.decodedTrades,
            group,
            consumer,
            env.REDIS_STREAM_STALE_MS,
            env.REDIS_STREAM_BATCH_SIZE
        ).catch(() => []);
        await mapConcurrent(
            uniqueStreamMessages([...stale, ...fresh]),
            env.MARKET_WORKER_CONCURRENCY,
            processMessage
        );
    }
};

const shutdown = (signal: string): void => {
    console.log(`[market-trade-worker] Received ${signal}`);
    running = false;
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

loop()
    .catch((error) => {
        console.error('[market-trade-worker] Fatal error:', error);
        process.exitCode = 1;
    })
    .finally(() => closeRuntime());
