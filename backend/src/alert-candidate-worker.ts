import { env } from './config/env';
import { AlertCandidateConsumerService } from './services/alertCandidateConsumer';
import { redisStreams, STREAMS } from './services/redisStreamService';
import { AlertCandidate, alertCandidateSchema } from './types';
import { closeRuntime } from './runtime';
import { ZodError } from 'zod';

const consumer = new AlertCandidateConsumerService();
const consumerName = `alert-candidate-writer-${process.pid}`;
let running = true;

const loop = async () => {
    await consumer.start();
    console.log(`[alert-candidate-worker] Started consumer ${consumerName}`);

    while (running) {
        const messages = await redisStreams.readGroup<AlertCandidate>(
            STREAMS.alertCandidates,
            'alert-candidate-writers',
            consumerName,
            env.REDIS_STREAM_BATCH_SIZE
        );

        for (const message of messages) {
            try {
                const candidate = alertCandidateSchema.parse(message.payload) as AlertCandidate;
                await consumer.handleCandidate(candidate);
                await redisStreams.clearRetry(`${STREAMS.alertCandidates}:${message.id}`);
                await redisStreams.ack(STREAMS.alertCandidates, 'alert-candidate-writers', message.id);
            } catch (error) {
                if (error instanceof ZodError) {
                    await redisStreams.deadLetter(STREAMS.alertCandidates, message.id, message.payload, error);
                    await redisStreams.ack(STREAMS.alertCandidates, 'alert-candidate-writers', message.id);
                    continue;
                }
                const attempts = await redisStreams.retryCount(`${STREAMS.alertCandidates}:${message.id}`);
                if (attempts < env.MARKET_EVENT_MAX_ATTEMPTS) continue;
                await redisStreams.deadLetter(STREAMS.alertCandidates, message.id, message.payload, error);
                await redisStreams.ack(STREAMS.alertCandidates, 'alert-candidate-writers', message.id);
            }
        }
    }
};

const shutdown = (signal: string) => {
    console.log(`[alert-candidate-worker] Received ${signal}, shutting down...`);
    running = false;
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

loop()
    .catch((error) => {
        console.error('[alert-candidate-worker] Fatal error:', error);
        process.exitCode = 1;
    })
    .finally(() => closeRuntime());
