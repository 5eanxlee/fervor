import { AlertNotificationJob } from '../types';
import { metrics } from './metrics';
import { notificationDeliveryService } from './notifications/NotificationDeliveryService';
import { notificationPreferenceService } from './notifications/NotificationPreferenceService';
import { notificationProviderRegistry } from './notifications/NotificationProviderRegistry';
import { notificationRateService } from './notifications/NotificationRateService';
import { redisStreams, STREAMS } from './redisStreamService';

export type NotificationHandleResult = 'handled' | 'terminal' | 'retry';

export class NotificationWorker {
    constructor(private readonly leaseOwner = `notification-worker-${process.pid}`) {}

    async start(): Promise<void> {
        await redisStreams.connect();
        await redisStreams.ensureGroup(STREAMS.notificationsPending, 'notification-workers');
    }

    async handle(job: AlertNotificationJob): Promise<NotificationHandleResult> {
        const done = metrics.timer('fervor_notification_delivery_ms', { type: job.notificationType });
        try {
            const context = await notificationDeliveryService.loadContext(job);
            if (!context) {
                metrics.increment('fervor_notifications_failed', { type: job.notificationType, reason: 'alert_missing' });
                return 'terminal';
            }

            const resolution = await notificationPreferenceService.resolveChannel(context.userId, job.notificationType);
            const provider = notificationProviderRegistry.get(job.notificationType);
            const delivery = await notificationDeliveryService.begin(
                job,
                context,
                resolution,
                provider?.providerName || job.notificationType
            );
            if (!delivery) {
                metrics.increment('fervor_notification_duplicate_suppressed', { type: job.notificationType });
                return 'handled';
            }

            if (!notificationDeliveryService.resolutionMatches(delivery, resolution)) {
                await notificationDeliveryService.markPreferenceFailure(
                    delivery.id,
                    resolution.reason || 'Notification destination changed or is not deliverable',
                    resolution.suppressed ? 'suppressed' : 'failed'
                );
                metrics.increment('fervor_notifications_failed', { type: job.notificationType, reason: 'preference' });
                return 'handled';
            }

            if (!provider) {
                await notificationDeliveryService.markPreferenceFailure(delivery.id, 'No notification provider registered');
                metrics.increment('fervor_notifications_failed', { type: job.notificationType, reason: 'provider_missing' });
                return 'handled';
            }
            if (!provider.isConfigured()) {
                await notificationDeliveryService.markPreferenceFailure(
                    delivery.id,
                    `${provider.providerName} notification provider is not configured`
                );
                metrics.increment('fervor_notifications_failed', { type: job.notificationType, reason: 'provider_unconfigured' });
                return 'handled';
            }

            const claimed = await notificationDeliveryService.claim(delivery.id, this.leaseOwner);
            if (!claimed) return 'handled';
            let delay: number;
            try {
                delay = await notificationRateService.reserve(job.notificationType, claimed.recipientHash!);
            } catch (error) {
                await notificationDeliveryService.deferClaim(
                    claimed,
                    1_000,
                    `Rate limiter unavailable: ${error instanceof Error ? error.message : String(error)}`
                );
                return 'handled';
            }
            if (delay > 0) {
                await notificationDeliveryService.deferClaim(
                    claimed,
                    delay,
                    'Provider rate limit deferred delivery'
                );
                return 'handled';
            }
            const result = await provider.send({
                deliveryId: delivery.id,
                alertEventId: job.alertEventId,
                alertId: job.alertId,
                userId: context.userId,
                recipient: resolution.recipient!,
                recipientHash: claimed.recipientHash!,
                payload: claimed.payload,
                idempotencyKey: claimed.idempotencyKey,
                requestKey: claimed.requestKey,
                locale: claimed.locale,
                timezone: claimed.timezone,
            });

            const outcome = await notificationDeliveryService.applyProviderResult({
                claim: claimed,
                result,
            });
            await notificationRateService.observe(job.notificationType, claimed.recipientHash!, result).catch((error) => {
                console.error('[notification-worker] Rate observation failed:', error);
            });

            if (result.kind === 'retryable_failure' && result.effect === 'unknown') {
                metrics.increment('fervor_notification_ambiguous_attempts', { type: job.notificationType });
            }

            if (outcome !== 'stale') metrics.increment(
                outcome === 'delivered' ? 'fervor_notifications_sent' : 'fervor_notifications_failed',
                {
                    type: job.notificationType,
                    outcome,
                }
            );
            return outcome === 'terminal' ? 'terminal' : 'handled';
        } catch (error) {
            metrics.increment('fervor_notifications_failed', { type: job.notificationType, reason: 'worker_error' });
            console.error('[notification-worker] Delivery failed:', error);
            return 'retry';
        } finally {
            done();
        }
    }
}
