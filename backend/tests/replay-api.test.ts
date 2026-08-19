import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MetricReplay } from '../src/services/marketData/metricReplay';
import {
    CheckpointStore,
    ReplaySessionStore,
} from '../src/services/replay/checkpointStore';
import {
    paperModelContract,
    type PaperModelInput,
} from '../src/services/replay/paperBroker';
import {
    normalizeReplayApiAuth,
    replayApiAuthContract,
    replayApiContract,
    replayApiMode,
    startReplayApi,
    type ReplayApi,
} from '../src/services/replay/replayApi';
import {
    replayDeltaContract,
    replayResyncContract,
} from '../src/services/replay/coordinator';
import { replayAlertModelContract } from '../src/services/replay/replayAlerts';
import { ReplayRuntime } from '../src/services/replay/runtime';
import { replayMint, replaySha, replayTape } from './helpers/replayTape';

const tempDirs: string[] = [];
const apis: ReplayApi[] = [];
const token = 'replay-api-test-token-1234567890abcdef';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const paperModel: PaperModelInput = {
    contract: paperModelContract,
    latency: { clientMs: 0, buildMs: 0, submitMs: 0 },
    participationBps: 10_000,
    maxLookaheadMs: 60_000,
    priceGuardBps: 0,
    protocolFeeBps: 0,
    fixedFees: [],
    partialFill: 'allow',
};

afterEach(async () => {
    await Promise.all(apis.splice(0).map((api) => api.close()));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const source = (): MetricReplay => {
    const replay = replayTape(3);
    const decorate = (trade: MetricReplay['sourceTrades'][number], index: number) => ({
        ...trade,
        maker: replayMint,
        protocol: 'pump_fun',
        signature: String(index + 5).repeat(88),
        commitment: 'finalized' as const,
    });
    return {
        ...replay,
        sourceTrades: replay.sourceTrades.map(decorate),
        trades: replay.trades.map((trade) => decorate(
            trade,
            replay.sourceTrades.findIndex((sourceTrade) =>
                sourceTrade.idempotencyKey === trade.idempotencyKey)
        )),
    };
};

const alertModel = {
    contract: replayAlertModelContract,
    sourceReplaySha256: replaySha,
    alerts: [{
        id: '11111111-1111-4111-8111-111111111111',
        userId,
        tokenMint: replayMint,
        thresholdType: 'price',
        thresholdValue: 100,
        condition: 'above',
        generation: 1,
        policy: 'one_shot',
    }],
} as const;

const auth = (runId = 'api-run', sourceSha = replaySha) => ({
    contract: replayApiAuthContract,
    sourceReplaySha256: sourceSha,
    runId,
    tokenSha256: createHash('sha256').update(token).digest('hex'),
});

const call = (
    socketPath: string,
    route: string,
    headers: Record<string, string> = {},
    method = 'GET'
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }> =>
    new Promise((resolve, reject) => {
        const req = request({
            socketPath,
            path: route,
            method,
            headers: { connection: 'close', ...headers },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve({
                    status: res.statusCode ?? 0,
                    headers: res.headers,
                    body: JSON.parse(body),
                });
            });
        });
        req.once('error', reject);
        req.end();
    });

const openApi = async (steps = 3): Promise<{
    api: ReplayApi;
    runtime: ReplayRuntime;
    root: string;
    socketPath: string;
}> => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'fervor-replay-api-'));
    tempDirs.push(temp);
    const root = path.join(temp, 'checkpoints');
    const runtime = await ReplayRuntime.open(
        source(),
        'api-run',
        new CheckpointStore(root),
        new ReplaySessionStore(root),
        paperModel,
        alertModel
    );
    for (let step = 0; step < steps; step += 1) runtime.step();
    const socketPath = path.join(root, 'replay-api.sock');
    const api = await startReplayApi(runtime, root, socketPath, auth());
    apis.push(api);
    return { api, runtime, root, socketPath };
};

const headers = {
    authorization: `Bearer ${token}`,
    'x-fervor-mode': replayApiMode,
};

describe('replay API', () => {
    it('binds authenticated snapshot and inbox reads to one historical replay session', async () => {
        const { api, runtime, root, socketPath } = await openApi();
        await expect(call(socketPath, '/api/replay/v1/runs/api-run/snapshot'))
            .resolves.toMatchObject({ status: 409 });
        await expect(call(socketPath, '/api/replay/v1/runs/api-run/snapshot', {
            'x-fervor-mode': replayApiMode,
        })).resolves.toMatchObject({ status: 401 });
        await expect(call(socketPath, '/api/replay/v1/runs/api-run/snapshot', {
            ...headers,
            authorization: `Bearer ${'x'.repeat(40)}`,
        })).resolves.toMatchObject({ status: 401 });
        await expect(call(socketPath, '/api/replay/v1/runs/other/snapshot', headers))
            .resolves.toMatchObject({ status: 404 });
        await expect(call(socketPath, '/api/replay/v1/runs/api-run/snapshot', headers, 'POST'))
            .resolves.toMatchObject({ status: 405 });

        const snapshot = await call(
            socketPath, '/api/replay/v1/runs/api-run/snapshot', headers
        );
        expect(snapshot).toMatchObject({
            status: 200,
            headers: { 'cache-control': 'no-store' },
            body: {
                success: true,
                contract: replayApiContract,
                mode: replayApiMode,
                session: {
                    id: api.sessionId,
                    sourceReplaySha256: replaySha,
                    runId: 'api-run',
                    epoch: 1,
                    cursor: 3,
                    now: '2024-11-19T00:00:20.000Z',
                },
                data: { state: runtime.state() },
            },
        });
        expect(snapshot.headers.date).toBeUndefined();

        const inbox = await call(
            socketPath,
            '/api/replay/v1/runs/api-run/notifications?after=0&limit=1',
            headers
        );
        expect(inbox).toMatchObject({
            status: 200,
            body: {
                success: true,
                contract: replayApiContract,
                mode: replayApiMode,
                session: { id: api.sessionId, epoch: 1, cursor: 3 },
                data: {
                    page: {
                        cutCursor: 3,
                        triggeredCount: 1,
                        after: 0,
                        next: null,
                        items: [{ thresholdType: 'price', metricCursor: 0 }],
                    },
                },
            },
        });
        expect(inbox.body.session.cursor).toBe(inbox.body.data.page.cutCursor);
        await expect(call(
            socketPath,
            '/api/replay/v1/runs/api-run/notifications?after=999&limit=1',
            headers
        )).resolves.toMatchObject({
            status: 200,
            body: { data: { page: { after: 999, next: null, items: [] } } },
        });
        await expect(call(
            socketPath,
            '/api/replay/v1/runs/api-run/notifications?limit=1&limit=2',
            headers
        )).resolves.toMatchObject({ status: 400 });

        expect((await lstat(socketPath)).mode & 0o777).toBe(0o660);
        await expect(startReplayApi(runtime, root, socketPath, auth()))
            .rejects.toThrow('already in use');
        await expect(call(socketPath, '/api/replay/v1/runs/api-run/snapshot', headers))
            .resolves.toMatchObject({ status: 200 });
        await api.close();
        await api.close();
        await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects mismatched auth and never replaces a non-socket path', async () => {
        const temp = await mkdtemp(path.join(os.tmpdir(), 'fervor-replay-api-'));
        tempDirs.push(temp);
        const root = path.join(temp, 'checkpoints');
        const runtime = await ReplayRuntime.open(
            source(),
            'api-run',
            new CheckpointStore(root),
            new ReplaySessionStore(root),
            paperModel,
            alertModel
        );
        expect(() => normalizeReplayApiAuth(auth('other'), runtime.state().snapshot))
            .toThrow('does not match');
        await expect(startReplayApi(
            runtime, root, path.join(root, 'replay-api.sock'), auth('other')
        )).rejects.toThrow('does not match');

        const socketPath = path.join(root, 'replay-api.sock');
        await writeFile(socketPath, 'preserve-me', { mode: 0o600 });
        await expect(startReplayApi(runtime, root, socketPath, auth()))
            .rejects.toThrow('not a socket');
        await expect(readFile(socketPath, 'utf8')).resolves.toBe('preserve-me');
    });

    it('continues from an exact cut and fences stale or impossible cursors', async () => {
        const { runtime, socketPath } = await openApi(1);
        const route = (epoch: number, after: number, limit = 1) =>
            `/api/replay/v1/runs/api-run/deltas?epoch=${epoch}&after=${after}&limit=${limit}`;

        const caughtUp = await call(socketPath, route(1, 1), headers);
        expect(caughtUp).toMatchObject({
            status: 200,
            body: {
                success: true,
                session: { epoch: 1, cursor: 1 },
                data: {
                    page: {
                        contract: replayDeltaContract,
                        epoch: 1,
                        after: 1,
                        cutCursor: 1,
                        next: null,
                        items: [],
                    },
                },
            },
        });

        runtime.step();
        runtime.step();
        const first = await call(socketPath, route(1, 1), headers);
        expect(first).toMatchObject({
            status: 200,
            body: {
                session: { epoch: 1, cursor: 3 },
                data: {
                    page: {
                        after: 1,
                        cutCursor: 3,
                        next: 2,
                        items: [{
                            runId: 'api-run',
                            epoch: 1,
                            sourceReplaySha256: replaySha,
                            cursor: 1,
                        }],
                    },
                },
            },
        });
        const tail = await call(socketPath, route(1, first.body.data.page.next, 1), headers);
        expect(tail).toMatchObject({
            status: 200,
            body: {
                data: { page: { after: 2, cutCursor: 3, next: null, items: [{ cursor: 2 }] } },
            },
        });

        await runtime.seek(1);
        const stale = await call(socketPath, route(1, 3), headers);
        expect(stale).toMatchObject({
            status: 409,
            body: {
                success: false,
                session: { epoch: 2, cursor: 1 },
                data: {
                    resync: {
                        contract: replayResyncContract,
                        reason: 'epoch_changed',
                        requested: { epoch: 1, after: 3 },
                        cut: { epoch: 2, cursor: 1 },
                    },
                },
            },
        });
        const ahead = await call(socketPath, route(2, 2), headers);
        expect(ahead).toMatchObject({
            status: 409,
            body: {
                session: { epoch: 2, cursor: 1 },
                data: { resync: { reason: 'cursor_ahead' } },
            },
        });

        for (const query of [
            'after=1',
            'epoch=2',
            'epoch=2&after=01',
            'epoch=2&after=1&limit=0',
            'epoch=2&after=1&limit=501',
            'epoch=2&after=1&after=2',
            'epoch=2&after=1&other=1',
        ]) {
            await expect(call(
                socketPath,
                `/api/replay/v1/runs/api-run/deltas?${query}`,
                headers
            )).resolves.toMatchObject({ status: 400 });
        }
    });
});
