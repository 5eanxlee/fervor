import { env } from './config/env';
import { NotificationWorker } from './services/notificationWorker';
import { notificationRetryService } from './services/notifications/NotificationRetryService';
import { redisStreams, STREAMS, StreamMessage } from './services/redisStreamService';
import { mapConcurrent, uniqueStreamMessages } from './services/streamWorker';
import { AlertNotificationJob, alertNotificationJobSchema } from './types';
import { closeRuntime } from './runtime';
import { ZodError } from 'zod';

const worker = new NotificationWorker();
const group = 'notification-workers';
const consumer = `notification-worker-${process.pid}`;
let running = true;

const processMessage = async (message: StreamMessage<AlertNotificationJob>): Promise<void> => {
    let job: AlertNotificationJob;
    try {
        job = alertNotificationJobSchema.parse(message.payload) as AlertNotificationJob;
    } catch (error) {
        if (!(error instanceof ZodError)) throw error;
        await redisStreams.deadLetter(STREAMS.notificationsPending, message.id, message.payload, error);
        await redisStreams.ack(STREAMS.notificationsPending, group, message.id);
        return;
    }
    const result = await worker.handle(job);
    if (result === 'retry') {
        const count = await redisStreams.retryCount(`${STREAMS.notificationsPending}:${message.id}`);
        if (count < env.NOTIFICATION_MAX_ATTEMPTS) return;
        await redisStreams.deadLetter(STREAMS.notificationsPending, message.id, message.payload, 'Notification worker exhausted retries');
    } else if (result === 'terminal') {
        await redisStreams.deadLetter(STREAMS.notificationsPending, message.id, message.payload, 'Notification delivery is terminal');
    }
    await redisStreams.clearRetry(`${STREAMS.notificationsPending}:${message.id}`);
    await redisStreams.ack(STREAMS.notificationsPending, group, message.id);
};

const loop = async (): Promise<void> => {
    await worker.start();
    console.log(`[notification-worker] Started consumer ${consumer}`);
    while (running) {
        await redisStreams.groupStats(STREAMS.notificationsPending, group).catch(() => undefined);
        await notificationRetryService.republishDue().catch((error) => {
            console.error('[notification-worker] Retry scan failed:', error);
        });
        const fresh = await redisStreams.readGroup<AlertNotificationJob>(
            STREAMS.notificationsPending,
            group,
            consumer,
            env.REDIS_STREAM_BATCH_SIZE
        );
        const stale = await redisStreams.claimStaleGroup<AlertNotificationJob>(
            STREAMS.notificationsPending,
            group,
            consumer,
            env.REDIS_STREAM_STALE_MS,
            env.REDIS_STREAM_BATCH_SIZE
        ).catch(() => []);
        await mapConcurrent(
            uniqueStreamMessages([...stale, ...fresh]),
            env.NOTIFICATION_MAX_PROVIDER_CONCURRENCY,
            processMessage
        );
    }
};

const shutdown = (signal: string): void => {
    console.log(`[notification-worker] Received ${signal}`);
    running = false;
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

loop()
    .catch((error) => {
        console.error('[notification-worker] Fatal error:', error);
        process.exitCode = 1;
    })
    .finally(() => closeRuntime());
