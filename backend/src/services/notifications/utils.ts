import crypto from 'crypto';
import { env } from '../../config/env';

export const recipientHash = (recipient: string): string =>
    crypto.createHash('sha256').update(recipient.trim().toLowerCase()).digest('hex');

export const calculateRetryAt = (attempts: number, retryAfterMs?: number): Date => {
    const jitter = 0.75 + Math.random() * 0.5;
    const exponentialDelay = Math.min(
        env.NOTIFICATION_RETRY_MAX_MS,
        env.NOTIFICATION_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1)
    );
    const delayMs = Math.max(retryAfterMs || 0, Math.round(exponentialDelay * jitter));
    return new Date(Date.now() + Math.min(delayMs, env.NOTIFICATION_RETRY_MAX_MS));
};
