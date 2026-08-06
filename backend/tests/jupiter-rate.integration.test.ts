import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = process.env.RUN_INFRA_TESTS === 'true';
const suite = enabled ? describe : describe.skip;

suite('Jupiter distributed rate gate', () => {
    let rate: any;
    let redis: any;

    beforeAll(async () => {
        process.env.REDIS_URL = 'redis://localhost:6379';
        process.env.JUPITER_RATE_PER_MIN = '1';
        ({ jupiterRate: rate } = await import('../src/services/jupiterRateService'));
        ({ redisStreams: redis } = await import('../src/services/redisStreamService'));
        await redis.connect();
        await redis.command.del(
            'provider:sliding:jupiter:main',
            'provider:gate:jupiter:main',
            'provider:sliding:jupiter:execute',
            'provider:gate:jupiter:execute'
        );
    });

    afterAll(async () => {
        await redis.command.del(
            'provider:sliding:jupiter:main',
            'provider:gate:jupiter:main',
            'provider:sliding:jupiter:execute',
            'provider:gate:jupiter:execute'
        );
        await redis.close();
    });

    it('fences a reservation when a local gate arrives during a Redis wait', async () => {
        let readResolve!: (delay: number) => void;
        const readResult = new Promise<number>((resolve) => { readResolve = resolve; });
        const read = vi.spyOn(redis, 'rateDelay').mockReturnValueOnce(readResult);
        const sliding = vi.spyOn(redis, 'reserveSliding');
        const pending = rate.reserve('execute');
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());

        const response = new Response(null, {
            status: 429,
            headers: {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(Math.ceil((Date.now() + 2000) / 1000)),
            },
        });
        expect(rate.observeSoon('execute', response)).toBeGreaterThan(0);
        readResolve(0);

        await expect(pending).resolves.toBeGreaterThan(0);
        expect(sliding).not.toHaveBeenCalled();
    });

    it('shares quota and upstream reset gates across service instances', async () => {
        expect(await rate.reserve('main')).toBe(0);
        expect(await rate.reserve('main')).toBeGreaterThan(0);

        await redis.command.del('provider:sliding:jupiter:main');
        const delay = await rate.observeResult('main', {
            status: 429,
            header: (name: string) => name === 'x-ratelimit-reset'
                ? String(Math.ceil((Date.now() + 2000) / 1000))
                : name === 'x-ratelimit-remaining' ? '0' : undefined,
        });
        expect(delay).toBeGreaterThan(0);
        expect(await rate.reserve('main')).toBeGreaterThan(0);
    });

    it('applies an upstream gate locally before Redis persistence completes', async () => {
        let persistResolve!: () => void;
        const persistence = new Promise<void>((resolve) => { persistResolve = resolve; });
        const persist = vi.spyOn(redis, 'setRateGate').mockReturnValueOnce(persistence);
        const read = vi.spyOn(redis, 'rateDelay');
        const response = new Response(null, {
            status: 429,
            headers: {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(Math.ceil((Date.now() + 2000) / 1000)),
            },
        });

        expect(rate.observeSoon('execute', response)).toBeGreaterThan(0);
        expect(await rate.reserve('execute')).toBeGreaterThan(0);
        expect(read).not.toHaveBeenCalled();
        persistResolve();
        await persistence;
        expect(persist).toHaveBeenCalledOnce();
    });
});
