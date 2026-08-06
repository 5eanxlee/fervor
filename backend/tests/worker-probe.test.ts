import { afterEach, describe, expect, it } from 'vitest';
import { WorkerProbe } from '../src/services/workerProbe';

describe('worker probe', () => {
    let probe: WorkerProbe | undefined;

    afterEach(async () => {
        await probe?.stop();
        probe = undefined;
    });

    it('exports worker-local health and metrics', async () => {
        probe = new WorkerProbe('fixture_worker', 0, 2, 1_000);
        const port = await probe.start();
        const url = `http://127.0.0.1:${port}`;

        expect((await fetch(`${url}/health`)).status).toBe(503);
        probe.success();
        expect((await fetch(`${url}/health`)).status).toBe(200);
        expect(await (await fetch(`${url}/metrics`)).text()).toContain(
            'fervor_fixture_worker_healthy 1'
        );

        expect(probe.failure()).toBe(false);
        expect((await fetch(`${url}/health`)).status).toBe(503);
        expect(probe.failure()).toBe(true);
    });

    it('expires health when completed batches stop arriving', async () => {
        probe = new WorkerProbe('fixture_expiry', 0, 2, 5);
        const port = await probe.start();
        probe.success();
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(503);
        expect(await (await fetch(`http://127.0.0.1:${port}/metrics`)).text()).toContain(
            'fervor_fixture_expiry_healthy 0'
        );
    });
});
