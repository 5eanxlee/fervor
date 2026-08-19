import crypto from 'crypto';

export const recipientHash = (recipient: string): string =>
    crypto.createHash('sha256').update(recipient.trim().toLowerCase()).digest('hex');

export const retryDelayMs = (
    attempts: number,
    retryAfterMs: number | undefined,
    baseMs: number,
    maxMs: number,
    random: () => number = Math.random
): number => {
    if (!Number.isSafeInteger(attempts)
        || attempts < 1
        || !Number.isFinite(baseMs)
        || !Number.isFinite(maxMs)
        || baseMs < 1
        || maxMs < baseMs
        || (retryAfterMs !== undefined
            && (!Number.isFinite(retryAfterMs) || retryAfterMs < 0))) {
        throw new Error('Notification retry policy is invalid');
    }
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
        throw new Error('Notification retry jitter is invalid');
    }
    const jitter = 0.75 + sample * 0.5;
    const exponentialDelay = Math.min(
        maxMs,
        baseMs * 2 ** Math.max(0, attempts - 1)
    );
    return Math.max(retryAfterMs ?? 0, Math.round(exponentialDelay * jitter));
};

export const calculateRetryAt = (
    attempts: number,
    retryAfterMs: number | undefined,
    baseMs: number,
    maxMs: number,
    nowMs = Date.now(),
    random: () => number = Math.random
): Date => {
    if (!Number.isFinite(nowMs) || nowMs < 0) {
        throw new Error('Notification retry clock is invalid');
    }
    const delayMs = retryDelayMs(attempts, retryAfterMs, baseMs, maxMs, random);
    return new Date(Math.min(8_640_000_000_000_000, nowMs + delayMs));
};
