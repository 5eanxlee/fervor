import { env } from '../../config/env';
import { metrics } from '../metrics';
import { redisStreams } from '../redisStreamService';
import { NotificationChannel, ProviderSendResult } from './types';

const DAY_MS = 86_400_000;

export class NotificationRateService {
    async reserve(channel: NotificationChannel, recipientHash: string): Promise<number> {
        const provider = channel;
        const gateKeys = [
            `${provider}:global`,
            `${provider}:recipient:${recipientHash}`,
        ];
        if (provider === 'discord') {
            const buckets = await Promise.all(['create_dm', 'send_dm'].map((route) =>
                redisStreams.command.get(`notification:bucket:discord:${route}`)
            ));
            for (const bucket of buckets) {
                if (bucket) gateKeys.push(`discord:bucket:${bucket}:recipient:${recipientHash}`);
            }
        }
        const gateDelay = await redisStreams.gateDelay(gateKeys);
        if (gateDelay > 0) return gateDelay;

        const windowMs = env.NOTIFICATION_RATE_WINDOW_MS;
        const windows = channel === 'telegram'
            ? [
                { key: 'telegram:global', limit: env.TELEGRAM_RATE_PER_SEC, windowMs },
                { key: `telegram:recipient:${recipientHash}`, limit: env.TELEGRAM_CHAT_RATE_PER_SEC, windowMs },
            ]
            : [{ key: 'discord:global', limit: env.DISCORD_RATE_PER_SEC, windowMs }];

        const delay = await redisStreams.reserveWindows(windows);
        if (delay > 0) metrics.increment('fervor_notification_rate_deferred', { provider });
        return delay;
    }

    async observe(
        channel: NotificationChannel,
        recipientHash: string,
        result: ProviderSendResult
    ): Promise<void> {
        const provider = channel;
        const delay = result.kind === 'accepted'
            ? result.rateDelayMs
            : result.kind === 'retryable_failure'
                ? result.retryAfterMs
                : undefined;
        if (delay && delay > 0) {
            const rateScope = result.kind === 'permanent_failure' ? undefined : result.rateScope;
            const bucket = result.kind === 'permanent_failure' ? undefined : result.rateBucket;
            const route = result.kind === 'permanent_failure' ? undefined : result.rateRoute;
            if (provider === 'discord' && bucket && route) {
                await redisStreams.command.set(
                    `notification:bucket:discord:${route}`,
                    bucket,
                    'EX',
                    DAY_MS / 1000
                );
            }
            const scope = rateScope === 'global'
                ? `${provider}:global`
                : provider === 'discord' && bucket
                    ? `discord:bucket:${bucket}:recipient:${recipientHash}`
                : `${provider}:recipient:${recipientHash}`;
            await redisStreams.setGate(scope, delay);
        }
    }
}

export const notificationRateService = new NotificationRateService();
