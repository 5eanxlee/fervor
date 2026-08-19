import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    replayControlActionContract,
    replayControlCommandContract,
    replayPaperActionContract,
    replayPaperCommandContract,
    replayPaperContract,
    startReplayApi,
    type ReplayApi,
} from '../src/services/replay/replayApi';
import {
    replayDeltaContract,
    replayResyncContract,
} from '../src/services/replay/coordinator';
import { replayAlertModelContract } from '../src/services/replay/replayAlerts';
import { ReplayRuntime } from '../src/services/replay/runtime';
import { replayMint, replayQuoteMint, replaySha, replayTape } from './helpers/replayTape';

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
    method = 'GET',
    body?: unknown
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }> =>
    new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = request({
            socketPath,
            path: route,
            method,
            headers: {
                connection: 'close',
                ...(payload === undefined ? {} : {
                    'content-type': 'application/json',
                    ...(headers['transfer-encoding'] === 'chunked' ? {} : {
                        'content-length': String(Buffer.byteLength(payload)),
                    }),
                }),
                ...headers,
            },
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
        req.end(payload);
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

    it('binds paper, wallet, and inbox reads to their exact product cut', async () => {
        const { runtime, socketPath } = await openApi(1);
        runtime.place({
            id: 'api-order',
            kind: 'market',
            side: 'buy',
            tokenMint: replayMint,
            quoteMint: replayQuoteMint,
            inputRaw: '50',
            reference: { quoteRaw: '1', tokenRaw: '1' },
        });
        runtime.step();
        expect(runtime.state()).toMatchObject({
            snapshot: { epoch: 1, cursor: 2 },
            paper: { orderCount: 1, factCount: 4 },
        });

        const paperRoute = (fact: number, factAfter = 0, orderAfter = 0) =>
            `/api/replay/v1/runs/api-run/paper?epoch=1&cursor=2&fact=${fact}`
            + `&orderAfter=${orderAfter}&factAfter=${factAfter}&limit=2`;
        const paper = await call(socketPath, paperRoute(4), headers);
        expect(paper).toMatchObject({
            status: 200,
            body: {
                success: true,
                session: { epoch: 1, cursor: 2 },
                data: {
                    page: {
                        contract: replayPaperContract,
                        epoch: 1,
                        cutCursor: 2,
                        fact: 4,
                        orders: {
                            after: 0,
                            next: null,
                            total: 1,
                            items: [{ id: 'api-order', status: 'filled' }],
                        },
                        facts: {
                            after: 0,
                            next: 2,
                            total: 4,
                            items: [{ kind: 'intent' }, { kind: 'eligible' }],
                        },
                        portfolio: {
                            orderCount: 1,
                            factCount: 4,
                            fillCount: 1,
                            positions: [{ openQuantityRaw: '50', openCostRaw: '50' }],
                        },
                    },
                },
            },
        });
        await expect(call(socketPath, paperRoute(4, 2), headers)).resolves.toMatchObject({
            status: 200,
            body: {
                data: {
                    page: {
                        facts: {
                            after: 2,
                            next: null,
                            items: [{ kind: 'fill' }, { kind: 'filled' }],
                        },
                    },
                },
            },
        });

        const walletRoute = `/api/replay/v1/runs/api-run/wallets/${replayMint}`
            + '?epoch=1&cursor=2&after=0&limit=1';
        await expect(call(socketPath, walletRoute, headers)).resolves.toMatchObject({
            status: 200,
            body: {
                session: { epoch: 1, cursor: 2 },
                data: {
                    page: { wallet: replayMint, cutCursor: 2, nextCursor: 1, items: [{ cursor: 0 }] },
                    portfolio: { wallet: replayMint, cutCursor: 2, tradeCount: 2 },
                },
            },
        });
        await expect(call(
            socketPath,
            '/api/replay/v1/runs/api-run/notifications?epoch=1&cursor=2&after=0&limit=1',
            headers
        )).resolves.toMatchObject({
            status: 200,
            body: { session: { epoch: 1, cursor: 2 } },
        });

        runtime.place({
            id: 'same-cut-order',
            kind: 'limit',
            side: 'sell',
            tokenMint: replayMint,
            quoteMint: replayQuoteMint,
            inputRaw: '10',
            limit: { quoteRaw: '1', tokenRaw: '1' },
        });
        await expect(call(socketPath, paperRoute(4), headers)).resolves.toMatchObject({
            status: 409,
            body: {
                session: { epoch: 1, cursor: 2 },
                data: {
                    resync: {
                        contract: replayResyncContract,
                        reason: 'paper_changed',
                        requested: { epoch: 1, cursor: 2, fact: 4 },
                        cut: { epoch: 1, cursor: 2, fact: 5 },
                    },
                },
            },
        });

        runtime.step();
        await expect(call(socketPath, walletRoute, headers)).resolves.toMatchObject({
            status: 409,
            body: { data: { resync: { reason: 'cursor_changed' } } },
        });
        await expect(call(
            socketPath,
            '/api/replay/v1/runs/api-run/notifications?epoch=1&cursor=2',
            headers
        )).resolves.toMatchObject({
            status: 409,
            body: { data: { resync: { reason: 'cursor_changed' } } },
        });

        for (const route of [
            '/api/replay/v1/runs/api-run/paper?epoch=1&cursor=3',
            `/api/replay/v1/runs/api-run/wallets/${replayMint}?epoch=1&cursor=3&after=4`,
            '/api/replay/v1/runs/api-run/wallets/not-a-wallet?epoch=1&cursor=3',
            '/api/replay/v1/runs/api-run/notifications?epoch=1',
        ]) {
            await expect(call(socketPath, route, headers)).resolves.toMatchObject({ status: 400 });
        }
    });

    it('converges replay-only paper action retries without crossing a stale cut', async () => {
        const { runtime, socketPath } = await openApi(1);
        const route = '/api/replay/v1/runs/api-run/paper/actions';
        const place = {
            contract: replayPaperCommandContract,
            op: 'place',
            epoch: 1,
            cursor: 1,
            fact: 0,
            order: {
                id: 'http-order',
                kind: 'limit',
                side: 'buy',
                tokenMint: replayMint,
                quoteMint: replayQuoteMint,
                inputRaw: '10',
                limit: { quoteRaw: '2', tokenRaw: '2' },
            },
        } as const;

        await expect(call(socketPath, route, {}, 'POST', place))
            .resolves.toMatchObject({ status: 409 });
        await expect(call(socketPath, route, {
            'x-fervor-mode': replayApiMode,
        }, 'POST', place)).resolves.toMatchObject({ status: 401 });
        await expect(call(socketPath, route, headers)).resolves.toMatchObject({ status: 405 });

        const created = await call(socketPath, route, headers, 'POST', place);
        expect(created).toMatchObject({
            status: 201,
            body: {
                success: true,
                session: { epoch: 1, cursor: 1 },
                data: {
                    action: {
                        contract: replayPaperActionContract,
                        op: 'place',
                        applied: true,
                        revision: { epoch: 1, cursor: 1, fact: 1 },
                        order: {
                            id: 'http-order',
                            status: 'pending',
                            price: { quoteRaw: '1', tokenRaw: '1' },
                        },
                    },
                },
            },
        });
        await expect(call(socketPath, route, headers, 'POST', place)).resolves.toMatchObject({
            status: 200,
            body: {
                data: {
                    action: {
                        op: 'place',
                        applied: false,
                        revision: { epoch: 1, cursor: 1, fact: 1 },
                        order: { id: 'http-order' },
                    },
                },
            },
        });
        await expect(call(socketPath, route, headers, 'POST', {
            ...place,
            order: { ...place.order, inputRaw: '11' },
        })).resolves.toMatchObject({
            status: 409,
            body: { error: 'Paper order ID conflict' },
        });
        await expect(call(socketPath, route, headers, 'POST', {
            ...place,
            order: { ...place.order, id: 'stale-order' },
        })).resolves.toMatchObject({
            status: 409,
            body: {
                data: {
                    resync: {
                        reason: 'paper_changed',
                        requested: { epoch: 1, cursor: 1, fact: 0 },
                        cut: { epoch: 1, cursor: 1, fact: 1 },
                    },
                },
            },
        });

        const cancel = {
            contract: replayPaperCommandContract,
            op: 'cancel',
            epoch: 1,
            cursor: 1,
            fact: 1,
            orderId: 'http-order',
        } as const;
        await expect(call(socketPath, route, headers, 'POST', cancel)).resolves.toMatchObject({
            status: 200,
            body: {
                data: {
                    action: {
                        op: 'cancel',
                        applied: true,
                        revision: { epoch: 1, cursor: 1, fact: 2 },
                        order: { id: 'http-order', status: 'cancelled' },
                    },
                },
            },
        });
        await expect(call(socketPath, route, headers, 'POST', cancel)).resolves.toMatchObject({
            status: 200,
            body: {
                data: {
                    action: {
                        op: 'cancel',
                        applied: false,
                        revision: { epoch: 1, cursor: 1, fact: 2 },
                    },
                },
            },
        });
        expect(runtime.state().paper).toMatchObject({ orderCount: 1, factCount: 2 });

        await expect(call(socketPath, route, headers, 'POST', {
            ...cancel,
            fact: 2,
            orderId: 'missing-order',
        })).resolves.toMatchObject({ status: 404 });
        await expect(call(socketPath, route, {
            ...headers,
            'content-type': 'text/plain',
        }, 'POST', place)).resolves.toMatchObject({ status: 415 });
        await expect(call(socketPath, route, headers, 'POST', {
            ...place,
            padding: 'x'.repeat(17_000),
        })).resolves.toMatchObject({ status: 413 });
        await expect(call(socketPath, route, {
            ...headers,
            'transfer-encoding': 'chunked',
        }, 'POST', {
            ...place,
            padding: 'x'.repeat(17_000),
        })).resolves.toMatchObject({ status: 413 });
        await expect(call(socketPath, route, headers, 'POST', {
            ...place,
            extra: true,
        })).resolves.toMatchObject({ status: 400 });
        await expect(call(
            socketPath, `${route}?retry=1`, headers, 'POST', place
        )).resolves.toMatchObject({ status: 400 });
    });

    it('controls replay from explicit cuts while pause remains a safe idempotent brake', async () => {
        const { socketPath } = await openApi(1);
        const route = '/api/replay/v1/runs/api-run/controls';
        const cut = {
            contract: replayControlCommandContract,
            epoch: 1,
            cursor: 1,
            fact: 0,
        } as const;

        await expect(call(socketPath, route, headers)).resolves.toMatchObject({ status: 405 });
        await expect(call(socketPath, `${route}?extra=1`, headers, 'POST', {
            ...cut,
            op: 'pause',
        })).resolves.toMatchObject({ status: 400 });
        await expect(call(socketPath, route, headers, 'POST', {
            ...cut,
            op: 'play',
            speed: 10,
        })).resolves.toMatchObject({ status: 400 });

        const play = await call(socketPath, route, headers, 'POST', {
            ...cut,
            op: 'play',
            speed: 1,
        });
        expect(play).toMatchObject({
            status: 202,
            body: {
                success: true,
                session: { epoch: 1, cursor: 1 },
                data: {
                    control: {
                        contract: replayControlActionContract,
                        op: 'play',
                        applied: true,
                        speed: 1,
                        revision: { epoch: 1, cursor: 1, fact: 0 },
                    },
                    state: { busy: true, snapshot: { status: 'running' } },
                },
            },
        });
        await expect(call(socketPath, route, headers, 'POST', {
            ...cut,
            op: 'step',
        })).resolves.toMatchObject({
            status: 409,
            body: { error: 'Replay must be paused' },
        });

        const staleBrake = { ...cut, cursor: 0, fact: 99, op: 'pause' } as const;
        await expect(call(socketPath, route, headers, 'POST', staleBrake))
            .resolves.toMatchObject({
                status: 200,
                body: {
                    data: {
                        control: {
                            op: 'pause',
                            applied: true,
                            requested: { epoch: 1, cursor: 0, fact: 99 },
                            revision: { epoch: 1, cursor: 1, fact: 0 },
                        },
                        state: { busy: false, snapshot: { status: 'paused' } },
                    },
                },
            });
        await expect(call(socketPath, route, headers, 'POST', staleBrake))
            .resolves.toMatchObject({
                status: 200,
                body: { data: { control: { op: 'pause', applied: false } } },
            });

        const step = await call(socketPath, route, headers, 'POST', {
            ...cut,
            op: 'step',
        });
        expect(step).toMatchObject({
            status: 200,
            body: {
                session: { epoch: 1, cursor: 2 },
                data: {
                    control: {
                        op: 'step',
                        applied: true,
                        revision: { epoch: 1, cursor: 2, fact: 0 },
                    },
                },
            },
        });
        await expect(call(socketPath, route, headers, 'POST', {
            ...cut,
            op: 'step',
        })).resolves.toMatchObject({
            status: 409,
            body: { data: { resync: { reason: 'cursor_changed' } } },
        });

        const cutTwo = { ...cut, cursor: 2 } as const;
        await expect(call(socketPath, route, headers, 'POST', {
            ...cutTwo,
            op: 'seek',
            target: 2,
        })).resolves.toMatchObject({
            status: 200,
            body: { data: { control: { op: 'seek', applied: false, target: 2 } } },
        });
        await expect(call(socketPath, route, headers, 'POST', {
            ...cutTwo,
            op: 'seek',
            target: 4,
        })).resolves.toMatchObject({
            status: 400,
            body: { error: 'Replay seek cursor is outside the tape' },
        });
        await expect(call(socketPath, route, headers, 'POST', {
            ...cutTwo,
            op: 'seek',
            target: 1,
        })).resolves.toMatchObject({
            status: 200,
            body: {
                session: { epoch: 2, cursor: 1 },
                data: {
                    control: {
                        op: 'seek',
                        applied: true,
                        target: 1,
                        revision: { epoch: 2, cursor: 1, fact: 0 },
                    },
                },
            },
        });
        const staleEpoch = await call(socketPath, route, headers, 'POST', staleBrake);
        expect(staleEpoch).toMatchObject({
            status: 409,
            body: { data: { resync: { reason: 'epoch_changed' } } },
        });
        expect(staleEpoch.body.data.resync.requested).toEqual({
            epoch: 1,
            cursor: 0,
            fact: 99,
        });
    });

    it('hides intermediate seek state and rejects a second mutation', async () => {
        const { runtime, socketPath } = await openApi(2);
        const route = '/api/replay/v1/runs/api-run/controls';
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        const seek = runtime.seek.bind(runtime);
        const spy = vi.spyOn(runtime, 'seek').mockImplementation(async (cursor) => {
            entered();
            await blocked;
            return seek(cursor);
        });
        const request = call(socketPath, route, headers, 'POST', {
            contract: replayControlCommandContract,
            op: 'seek',
            epoch: 1,
            cursor: 2,
            fact: 0,
            target: 1,
        });
        await started;
        try {
            await expect(call(
                socketPath, '/api/replay/v1/runs/api-run/snapshot', headers
            )).resolves.toMatchObject({
                status: 409,
                body: { error: 'Replay mutation is active' },
            });
            await expect(call(socketPath, route, headers, 'POST', {
                contract: replayControlCommandContract,
                op: 'step',
                epoch: 1,
                cursor: 2,
                fact: 0,
            })).resolves.toMatchObject({
                status: 409,
                body: { error: 'Replay mutation is already active' },
            });
        } finally {
            release();
        }
        await expect(request).resolves.toMatchObject({
            status: 200,
            body: { session: { epoch: 2, cursor: 1 } },
        });
        spy.mockRestore();
    });
});
