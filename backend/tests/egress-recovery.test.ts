import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EgressRecovery } from '../src/services/orders/egressRecovery';

describe('egress recovery', () => {
    it('runs the bounded database recovery contract', async () => {
        const query = vi.fn().mockResolvedValue({
            rows: [{ attempt_id: randomUUID() }, { attempt_id: randomUUID() }],
        });
        const release = vi.fn();
        const recovery = new EgressRecovery({
            plane: 'egress',
            getClient: vi.fn().mockResolvedValue({ query, release }),
        });

        await expect(recovery.runBatch(17)).resolves.toBe(2);
        expect(query).toHaveBeenCalledWith(
            'SELECT attempt_id FROM recover_action_egress($1)',
            [17]
        );
        expect(release).toHaveBeenCalledWith(false);
    });

    it('propagates database failures to the worker loop', async () => {
        const failure = new Error('database unavailable');
        const query = vi.fn().mockRejectedValue(failure);
        const release = vi.fn();
        const recovery = new EgressRecovery({
            plane: 'egress',
            getClient: vi.fn().mockResolvedValue({ query, release }),
        });

        await expect(recovery.runBatch(1)).rejects.toBe(failure);
        expect(release).toHaveBeenCalledWith(false);
    });

    it('destroys a stalled egress connection on cancellation', async () => {
        const release = vi.fn();
        const recovery = new EgressRecovery({
            plane: 'egress',
            getClient: vi.fn().mockResolvedValue({
                query: vi.fn().mockReturnValue(new Promise(() => undefined)),
                release,
            }),
        }, 60_000);
        const control = new AbortController();
        const pending = recovery.runBatch(1, control.signal);
        control.abort();

        await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(release).toHaveBeenCalledWith(true);
    });

    it('uses the dedicated egress database by default', () => {
        expect(new EgressRecovery().plane).toBe('egress');
    });
});
