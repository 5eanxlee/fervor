import { AlertMatcherService } from './services/alertMatcher';
import { FeedTick } from './types';
import { env } from './config/env';
import { RedisStreamService, redisStreams, STREAMS, tickStream } from './services/redisStreamService';
import type { AlertIndexUpdate } from './services/subscriptionRegistry';
import { closeRuntime } from './runtime';

const matcher = new AlertMatcherService();
const consumerName = `alert-matcher-${process.pid}`;
const indexUpdateStreams = new RedisStreamService();
const stream = tickStream(env.MATCHER_SHARD_ID, env.MATCHER_SHARD_COUNT);
const group = 'alert-matchers-v2';
let running = true;

const tickLoop = async () => {
    while (running) {
        const messages = await redisStreams.readGroup<FeedTick>(
            stream,
            group,
            consumerName,
            env.REDIS_STREAM_BATCH_SIZE
        );

        for (const message of messages) {
            try {
                await matcher.handleTick(message.payload);
                await redisStreams.clearRetry(`${stream}:${message.id}`);
                await redisStreams.ack(stream, group, message.id);
            } catch (error) {
                const attempts = await redisStreams.retryCount(`${stream}:${message.id}`);
                if (attempts < env.MARKET_EVENT_MAX_ATTEMPTS) continue;
                await redisStreams.deadLetter(stream, message.id, message.payload, error);
                await redisStreams.ack(stream, group, message.id);
            }
        }
    }
};

const indexUpdateLoop = async () => {
    await indexUpdateStreams.connect();
    const ids = ['0'];

    while (running) {
        const messages = await indexUpdateStreams.read<AlertIndexUpdate>(
            [STREAMS.alertIndexUpdates],
            ids,
            env.REDIS_STREAM_BLOCK_MS,
            env.REDIS_STREAM_BATCH_SIZE
        );

        for (const message of messages) {
            try {
                await matcher.handleIndexUpdate(message.payload);
            } catch (error) {
                await indexUpdateStreams.deadLetter(STREAMS.alertIndexUpdates, message.id, message.payload, error);
            } finally {
                ids[0] = message.id;
            }
        }
    }
};

const loop = async () => {
    await matcher.start();
    console.log(`[alert-matcher] Started consumer ${consumerName}`);
    await Promise.all([tickLoop(), indexUpdateLoop()]);
};

const shutdown = (signal: string) => {
    console.log(`[alert-matcher] Received ${signal}, shutting down...`);
    running = false;
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

loop()
    .catch((error) => {
        console.error('[alert-matcher] Fatal error:', error);
        process.exitCode = 1;
    })
    .finally(() => closeRuntime([() => indexUpdateStreams.close()]));
