import { describe, expect, it, vi } from 'vitest';
import { runBatchLoop } from '../src/services/batchLoop';

describe('batch loop', () => {
    it('fails after the health threshold is reached', async () => {
        const failure = new Error('database unavailable');
        const recovery = { runBatch: vi.fn().mockRejectedValue(failure) };
        const health = {
            success: vi.fn(),
            failure: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
        };
        const errors = vi.fn();

        await expect(runBatchLoop(
            'fixture', recovery, health, new AbortController().signal, 1, 100, errors
        )).rejects.toMatchObject({ cause: failure });
        expect(recovery.runBatch).toHaveBeenCalledTimes(2);
        expect(errors).toHaveBeenCalledTimes(2);
        expect(health.success).not.toHaveBeenCalled();
    });

    it('cancels an idle wait on shutdown', async () => {
        const recovery = { runBatch: vi.fn().mockResolvedValue(0) };
        const health = { success: vi.fn(), failure: vi.fn() };
        const control = new AbortController();
        const running = runBatchLoop(
            'fixture', recovery, health, control.signal, 60_000, 60_000
        );

        await vi.waitFor(() => expect(recovery.runBatch).toHaveBeenCalledOnce());
        control.abort();

        await expect(running).resolves.toBeUndefined();
        expect(recovery.runBatch).toHaveBeenCalledOnce();
    });

    it('fails a never-settling batch within its hard deadline', async () => {
        const recovery = { runBatch: vi.fn().mockReturnValue(new Promise(() => undefined)) };
        const health = { success: vi.fn(), failure: vi.fn().mockReturnValue(true) };

        await expect(runBatchLoop(
            'fixture', recovery, health, new AbortController().signal, 60_000, 5, vi.fn()
        )).rejects.toThrow(/failure limit/);
        expect(health.failure).toHaveBeenCalledOnce();
    });
});
