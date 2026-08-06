import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedSignal } from '../src/services/providerCall';

describe('provider call signals', () => {
    afterEach(() => vi.useRealTimers());

    it('propagates an external abort reason', () => {
        const external = new AbortController();
        const bound = boundedSignal(1_000, external.signal);
        const reason = new Error('gateway deadline');

        external.abort(reason);

        expect(bound.signal.aborted).toBe(true);
        expect(bound.signal.reason).toBe(reason);
        bound.close();
    });

    it('enforces and releases its local timeout', async () => {
        vi.useFakeTimers();
        const expired = boundedSignal(5);
        await vi.advanceTimersByTimeAsync(5);
        expect(expired.signal).toMatchObject({ aborted: true });
        expect(expired.signal.reason).toMatchObject({ name: 'TimeoutError' });
        expired.close();

        const closed = boundedSignal(5);
        closed.close();
        await vi.advanceTimersByTimeAsync(5);
        expect(closed.signal.aborted).toBe(false);
    });
});
