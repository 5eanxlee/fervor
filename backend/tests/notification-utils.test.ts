import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    calculateRetryAt,
    recipientHash,
    retryDelayMs,
} from '../src/services/notifications/utils';

describe('notification utilities', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('uses a stable recipient hash without retaining the destination', () => {
        expect(recipientHash('DiscordUser')).toBe(recipientHash(' discorduser '));
        expect(recipientHash('DiscordUser')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('honors retry-after as a minimum and caps exponential backoff', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-04-29T00:00:00.000Z'));

        const retryAt = calculateRetryAt(3, 10_000, 1_000, 3_600_000).getTime();
        expect(retryAt).toBeGreaterThanOrEqual(Date.now() + 10_000);
        expect(retryAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    });

    it('never retries before an explicit provider deadline', () => {
        expect(retryDelayMs(2, 10_000, 100, 1_000, () => 0)).toBe(10_000);
    });
});
