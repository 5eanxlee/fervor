import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { User } from '../src/types';
import {
    rtContract,
    rtPath,
    type RtDelta,
    type RtFrame,
    type RtHello,
    type RtSnapshot,
} from '../src/services/realtime/protocol';
import { attachRealtime, type RealtimeServer } from '../src/services/realtime/server';

const mint = 'So11111111111111111111111111111111111111112';
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const token = 'a'.repeat(64);
const hello: RtHello = {
    contract: rtContract,
    type: 'hello',
    mode: 'historical_replay',
    sessionId: 'b'.repeat(64),
    epoch: 1,
    sentAt: '2026-08-19T00:00:00.000Z',
    heartbeatMs: 15_000,
    maxSubs: 8,
};
const snapshot: RtSnapshot = {
    contract: rtContract,
    type: 'snapshot',
    mode: 'historical_replay',
    sessionId: hello.sessionId,
    epoch: 1,
    sentAt: hello.sentAt,
    cut: { trade: '0' },
    data: { tokenMint: mint },
};
const user = (id = ownerId): User => ({
    id,
    wallet_address: mint,
    created_at: new Date(),
    updated_at: new Date(),
});

class FakeFeed {
    readonly enabled = true;
    readonly ownerId = ownerId;
    readonly ready = vi.fn(async () => undefined);
    readonly close = vi.fn(async () => undefined);
    readonly seed = vi.fn(() => ({ frames: [snapshot], resumed: false }));
    private readonly listeners = new Set<(frame: RtFrame) => void>();

    hello(): RtHello {
        return hello;
    }

    supports(tokenMint: string, streams: readonly string[]): boolean {
        return tokenMint === mint && streams.every((stream) => stream === 'trade');
    }

    watch(listener: (frame: RtFrame) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(frame: RtFrame): void {
        for (const listener of this.listeners) listener(frame);
    }
}

interface Harness {
    readonly http: Server;
    readonly realtime: RealtimeServer;
    readonly feed: FakeFeed;
    readonly url: string;
    close(): Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

const listen = (server: Server): Promise<number> => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('No test port'));
        resolve(address.port);
    });
});

const createHarness = async (authenticated = user()): Promise<Harness> => {
    const http = createServer((_req, res) => {
        res.statusCode = 404;
        res.end();
    });
    const feed = new FakeFeed();
    const realtime = attachRealtime(http, {
        feed,
        allowOrigin: (origin) => origin === 'http://localhost:3002',
        authenticate: vi.fn(async () => authenticated),
        config: {
            authMs: 1_000,
            heartbeatMs: 10_000,
            maxPayloadBytes: 16_384,
            queueBytes: 65_536,
            queueFrames: 32,
        },
    });
    const port = await listen(http);
    let closed = false;
    const harness: Harness = {
        http,
        realtime,
        feed,
        url: `ws://127.0.0.1:${port}${rtPath}`,
        close: async () => {
            if (closed) return;
            closed = true;
            await realtime.close();
            if (http.listening) {
                await new Promise<void>((resolve) => http.close(() => resolve()));
            }
        },
    };
    harnesses.push(harness);
    return harness;
};

const connect = (url: string): Promise<WebSocket> => new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin: 'http://localhost:3002' });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
});

const nextFrame = (socket: WebSocket): Promise<{ binary: boolean; frame: any }> =>
    new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.once('message', (data, binary) => {
            resolve({ binary, frame: JSON.parse(data.toString()) });
        });
    });

const send = (socket: WebSocket, frame: unknown): void => {
    socket.send(Buffer.from(JSON.stringify(frame)));
};

describe('realtime WebSocket server', () => {
    it('authenticates in the first binary frame and streams a subscribed token', async () => {
        const test = await createHarness();
        const socket = await connect(test.url);

        const helloReply = nextFrame(socket);
        send(socket, { contract: rtContract, op: 'auth', token });
        await expect(helloReply).resolves.toMatchObject({
            binary: true,
            frame: { type: 'hello', sessionId: hello.sessionId },
        });

        const snapshotReply = nextFrame(socket);
        send(socket, {
            contract: rtContract,
            op: 'subscribe',
            tokenMint: mint,
            streams: ['trade'],
        });
        await expect(snapshotReply).resolves.toMatchObject({
            binary: true,
            frame: { type: 'snapshot', cut: { trade: '0' } },
        });

        const delta: RtDelta = {
            contract: rtContract,
            type: 'delta',
            mode: 'historical_replay',
            sessionId: hello.sessionId,
            epoch: 1,
            sentAt: hello.sentAt,
            stream: 'trade',
            delivery: 'ordered',
            cursor: '1',
            prior: '0',
            scope: { tokenMint: mint },
            observedAt: hello.sentAt,
            data: { side: 'buy' },
        };
        const deltaReply = nextFrame(socket);
        test.feed.emit(delta);
        await expect(deltaReply).resolves.toMatchObject({
            binary: true,
            frame: { type: 'delta', stream: 'trade', cursor: '1' },
        });
        expect(test.feed.seed).toHaveBeenCalledTimes(1);
        socket.close();
    });

    it('rejects text frames and never accepts a credential in the URL', async () => {
        const test = await createHarness();
        const socket = await connect(test.url);
        const errorReply = nextFrame(socket);
        socket.send(JSON.stringify({ contract: rtContract, op: 'auth', token }));
        await expect(errorReply).resolves.toMatchObject({
            binary: true,
            frame: { type: 'error', code: 'invalid_frame' },
        });

        const rejected = new Promise<number>((resolve, reject) => {
            const querySocket = new WebSocket(`${test.url}?token=${token}`, {
                origin: 'http://localhost:3002',
            });
            querySocket.once('unexpected-response', (_request, response) => {
                resolve(response.statusCode);
                response.resume();
            });
            querySocket.once('error', reject);
        });
        await expect(rejected).resolves.toBe(403);
    });

    it('enforces the replay owner after authentication', async () => {
        const test = await createHarness(user('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
        const socket = await connect(test.url);
        const errorReply = nextFrame(socket);
        send(socket, { contract: rtContract, op: 'auth', token });
        await expect(errorReply).resolves.toMatchObject({
            binary: true,
            frame: { type: 'error', code: 'forbidden', retryable: false },
        });
        expect(test.feed.ready).not.toHaveBeenCalled();
    });

    it('encodes one immutable source frame once for every subscriber', async () => {
        const test = await createHarness();
        const sockets = await Promise.all([connect(test.url), connect(test.url)]);
        for (const socket of sockets) {
            const helloReply = nextFrame(socket);
            send(socket, { contract: rtContract, op: 'auth', token });
            await helloReply;
            const snapshotReply = nextFrame(socket);
            send(socket, {
                contract: rtContract,
                op: 'subscribe',
                tokenMint: mint,
                streams: ['trade'],
            });
            await snapshotReply;
        }

        let reads = 0;
        const delta: RtDelta = {
            contract: rtContract,
            type: 'delta',
            mode: 'historical_replay',
            sessionId: hello.sessionId,
            epoch: 1,
            sentAt: hello.sentAt,
            stream: 'trade',
            delivery: 'ordered',
            cursor: '1',
            prior: '0',
            scope: { tokenMint: mint },
            observedAt: hello.sentAt,
            data: Object.defineProperty({}, 'side', {
                enumerable: true,
                get: () => {
                    reads += 1;
                    return 'buy';
                },
            }),
        };
        const replies = sockets.map((socket) => nextFrame(socket));
        test.feed.emit(delta);
        await Promise.all(replies);

        expect(reads).toBe(1);
        for (const socket of sockets) socket.close();
    });
});
