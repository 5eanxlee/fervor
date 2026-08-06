import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { jupiterDelay } from '../src/services/jupiterRateService';

const result = (status: number, headers: Record<string, string>) => ({
    status,
    header: (name: string): string | undefined => headers[name],
});

describe('Jupiter rate headers', () => {
    afterEach(() => vi.useRealTimers());

    it('honors the longest upstream retry boundary', () => {
        expect(jupiterDelay(result(429, {
            'retry-after': '3',
            'x-ratelimit-remaining': '0',
        }))).toBe(3000);
    });

    it('honors Retry-After on transient non-429 responses', () => {
        expect(jupiterDelay(result(503, { 'retry-after': '2' }))).toBe(2000);
        expect(jupiterDelay(result(200, {}))).toBeUndefined();
    });

    it('bounds hostile or malformed provider delays', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        expect(jupiterDelay(result(503, {
            'retry-after': 'Fri, 01 Jan 2038 00:00:00 GMT',
        }))).toBe(env.JUPITER_RETRY_MAX_MS);
        expect(jupiterDelay(result(429, {
            'retry-after': '1e308',
        }))).toBe(1000);
        expect(jupiterDelay(result(429, {
            'x-ratelimit-reset': '1e308',
        }))).toBe(1000);
    });
});
