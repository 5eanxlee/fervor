import { env } from './config/env';
import { NormalizedTradeEvent } from './types';
import { CandleProjector, isCandleTrade } from './services/marketData/candleProjector';
import { redisStreams, STREAMS, StreamMessage } from './services/redisStreamService';
import { closeRuntime } from './runtime';

const group = 'candle-projectors';
const consumerName = `candle-projector-${process.pid}`;
const projector = new CandleProjector();
let running = true;

const uniqueMessages = (messages: StreamMessage<NormalizedTradeEvent>[]): StreamMessage<NormalizedTradeEvent>[] =>
    Array.from(new Map(messages.map((message) => [message.id, message])).values());

const loop = async () => {
    await redisStreams.connect();
    await redisStreams.ensureGroup(STREAMS.marketTrades, group);
    console.log(`[candle-worker] Started consumer ${consumerName}`);

    while (running) {
        await redisStreams.groupStats(STREAMS.marketTrades, group).catch(() => undefined);
        const fresh = await redisStreams.readGroup<NormalizedTradeEvent>(
            STREAMS.marketTrades, group, consumerName, env.REDIS_STREAM_BATCH_SIZE
        );
        const stale = await redisStreams.claimStaleGroup<NormalizedTradeEvent>(
            STREAMS.marketTrades, group, consumerName, env.REDIS_STREAM_STALE_MS, env.REDIS_STREAM_BATCH_SIZE
        ).catch(() => []);
        const messages = uniqueMessages([...stale, ...fresh]);
        const valid = messages.filter((message) => isCandleTrade(message.payload));
        const invalid = messages.filter((message) => !isCandleTrade(message.payload));

        for (const message of invalid) {
            await redisStreams.deadLetter(STREAMS.marketTrades, message.id, message.payload, 'Trade cannot be projected');
            await redisStreams.ack(STREAMS.marketTrades, group, message.id);
        }
        if (!valid.length) continue;

        try {
            const candles = await projector.project(valid.map((message) => message.payload));
            for (const candle of candles) await redisStreams.publish(STREAMS.marketCandles, candle);
            for (const message of valid) await redisStreams.ack(STREAMS.marketTrades, group, message.id);
        } catch (error) {
            for (const message of valid) {
                await redisStreams.deadLetter(STREAMS.marketTrades, message.id, message.payload, error);
            }
        }
    }
};

const shutdown = (signal: string) => {
    console.log(`[candle-worker] Received ${signal}, shutting down...`);
    running = false;
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

loop()
    .catch((error) => {
        console.error('[candle-worker] Fatal error:', error);
        process.exitCode = 1;
    })
    .finally(() => closeRuntime());
