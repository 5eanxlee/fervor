import { describe, expect, it, vi } from 'vitest';
import { BlobRetention } from '../src/services/orders/blobRetention';

describe('blob retention', () => {
    it('runs one bounded maintenance-only purge call', async () => {
        const query = vi.fn().mockResolvedValue({ rows: [{ purged: 7 }] });
        const release = vi.fn();
        const retention = new BlobRetention({
            getClient: vi.fn().mockResolvedValue({ query, release }),
            close: vi.fn(),
        } as never, 64, 1_000);

        await expect(retention.runBatch()).resolves.toBe(7);
        expect(query).toHaveBeenCalledOnce();
        expect(query.mock.calls[0][0]).toBe(
            'SELECT purge_expired_blobs($1, $2) AS purged'
        );
        expect(query.mock.calls[0][1]).toEqual([
            64, expect.stringMatching(/^retention:[0-9a-f-]{36}$/),
        ]);
        expect(release).toHaveBeenCalledWith(false);
    });

    it('rejects a malformed database result', async () => {
        const release = vi.fn();
        const retention = new BlobRetention({
            getClient: vi.fn().mockResolvedValue({
                query: vi.fn().mockResolvedValue({ rows: [{ purged: 65 }] }),
                release,
            }),
            close: vi.fn(),
        } as never, 64, 1_000);

        await expect(retention.runBatch()).rejects.toThrow(/invalid purge count/);
        expect(release).toHaveBeenCalledWith(false);
    });
});
