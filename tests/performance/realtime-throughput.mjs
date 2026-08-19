import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://fervor:fervor@localhost:5432/fervor_bench';
process.env.DB_COLOCATED = 'true';
process.env.JWT_SECRET = 'realtime-benchmark-secret-0123456789abcdef0123456789abcdef';

const requireBackend = createRequire(new URL('../../backend/package.json', import.meta.url));
const WebSocket = requireBackend('ws');
const { FrameQueue } = requireBackend('./dist/services/realtime/frameQueue.js');
const {
    encodeFrame,
    rtContract,
    rtPath,
} = requireBackend('./dist/services/realtime/protocol.js');
const { attachRealtime } = requireBackend('./dist/services/realtime/server.js');

const mint = '3an8rhdepsLCya22af7qDBKPbdomw8K4iCHXaA2Gpump';
const sessionId = 'b'.repeat(64);
const eventCount = 1_000;
const clientCount = 32;
const fixture = JSON.parse(await readFile(
    new URL('../contracts/decoded-trade-v2.json', import.meta.url),
    'utf8'
));

const at = (index) => new Date(Date.parse('2024-11-20T03:48:28Z') + index * 100).toISOString();
const frames = Array.from({ length: eventCount }, (_, index) => Object.freeze({
    contract: rtContract,
    type: 'delta',
    mode: 'historical_replay',
    sessionId,
    epoch: 1,
    sentAt: at(index),
    stream: 'trade',
    delivery: 'ordered',
    cursor: String(index + 1),
    prior: String(index),
    scope: { tokenMint: mint },
    observedAt: at(index),
    data: {
        ...fixture,
        tokenMint: mint,
        idempotencyKey: index.toString(16).padStart(64, '0'),
        sourceEventId: `old_faithful:transport-bench:${index}`,
        slot: 302459600 + Math.floor(index / 4),
        txIndex: index % 4,
        receivedAt: at(index),
        observedAt: at(index),
        ...(fixture.supply ? { supply: { ...fixture.supply, tokenMint: mint } } : {}),
    },
}));

for (const frame of frames.slice(0, 100)) encodeFrame(frame);
const encodeStart = performance.now();
const buffers = frames.map(encodeFrame);
const encodeMs = performance.now() - encodeStart;
const payloadBytes = buffers.reduce((total, buffer) => total + buffer.length, 0);

const queueClients = 256;
const queues = Array.from({ length: queueClients }, () => new FrameQueue(8_388_608, 2_048));
const queueStart = performance.now();
let queueOps = 0;
for (const buffer of buffers) {
    for (const queue of queues) {
        if (queue.push({ data: buffer, delivery: 'ordered' }) !== 'queued') {
            throw new Error('Bounded queue rejected a drained benchmark frame');
        }
        if (queue.shift()?.data !== buffer) throw new Error('Queue changed shared frame identity');
        queueOps += 2;
    }
}
const queueMs = performance.now() - queueStart;

class Feed {
    enabled = true;
    ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    listeners = new Set();
    helloFrame = Object.freeze({
        contract: rtContract,
        type: 'hello',
        mode: 'historical_replay',
        sessionId,
        epoch: 1,
        sentAt: at(0),
        heartbeatMs: 15_000,
        maxSubs: 8,
    });
    snapshot = Object.freeze({
        contract: rtContract,
        type: 'snapshot',
        mode: 'historical_replay',
        sessionId,
        epoch: 1,
        sentAt: at(0),
        cut: { trade: '0' },
        data: { tokenMint: mint, trade: { cursor: 0, total: 5_516 } },
    });

    async ready() {}
    hello() { return this.helloFrame; }
    supports(tokenMint, streams) {
        return tokenMint === mint && streams.length === 1 && streams[0] === 'trade';
    }
    seed() { return { frames: [this.snapshot], resumed: false }; }
    watch(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit(frame) {
        for (const listener of this.listeners) listener(frame);
    }
    async close() { this.listeners.clear(); }
}

const feed = new Feed();
const http = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
});
const realtime = attachRealtime(http, {
    feed,
    allowOrigin: (origin) => origin === 'http://localhost:3002',
    authenticate: async () => ({
        id: feed.ownerId,
        wallet_address: mint,
        created_at: new Date(0),
        updated_at: new Date(0),
    }),
    config: {
        authMs: 5_000,
        heartbeatMs: 15_000,
        maxPayloadBytes: 16_384,
        queueBytes: 8_388_608,
        queueFrames: 2_048,
    },
});

const port = await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => resolve(http.address().port));
});

const clients = Array.from({ length: clientCount }, () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${rtPath}`, {
        origin: 'http://localhost:3002',
    });
    let received = 0;
    let readyResolve;
    let readyReject;
    let doneResolve;
    let doneReject;
    const ready = new Promise((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
    });
    const done = new Promise((resolve, reject) => {
        doneResolve = resolve;
        doneReject = reject;
    });
    const fail = (error) => {
        readyReject(error);
        doneReject(error);
    };
    socket.on('open', () => socket.send(Buffer.from(JSON.stringify({
        contract: rtContract,
        op: 'auth',
        token: 'a'.repeat(64),
    }))));
    socket.on('message', (data, binary) => {
        if (!binary) return fail(new Error('Server emitted a text frame'));
        const frame = JSON.parse(data.toString());
        if (frame.type === 'hello') {
            socket.send(Buffer.from(JSON.stringify({
                contract: rtContract,
                op: 'subscribe',
                tokenMint: mint,
                streams: ['trade'],
            })));
        } else if (frame.type === 'snapshot') {
            readyResolve();
        } else if (frame.type === 'delta') {
            received += 1;
            if (received === eventCount) doneResolve();
        } else if (frame.type === 'error') {
            fail(new Error(`${frame.code}: ${frame.message}`));
        }
    });
    socket.once('error', fail);
    socket.once('close', (code) => {
        if (received !== eventCount) fail(new Error(`Client closed early with ${code}`));
    });
    return { socket, ready, done, received: () => received };
});

await Promise.all(clients.map((client) => client.ready));
const rssBefore = process.memoryUsage().rss;
const cpuBefore = process.cpuUsage();
const deliveryStart = performance.now();
for (const frame of frames) feed.emit(frame);
let deliveryTimeout;
await Promise.race([
    Promise.all(clients.map((client) => client.done)),
    new Promise((_, reject) => {
        deliveryTimeout = setTimeout(
            () => reject(new Error('Realtime delivery benchmark timed out')),
            20_000
        );
    }),
]);
clearTimeout(deliveryTimeout);
const deliveryMs = performance.now() - deliveryStart;
const cpu = process.cpuUsage(cpuBefore);
const rssAfter = process.memoryUsage().rss;
const delivered = clients.reduce((total, client) => total + client.received(), 0);

for (const client of clients) client.socket.close();
await realtime.close();
await new Promise((resolve) => http.close(() => resolve()));

const result = {
    contract: 'fervor-realtime-benchmark-v1',
    recordedAt: new Date().toISOString(),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    host: {
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        logicalCpus: os.cpus().length,
        node: process.version,
    },
    workload: {
        historicalReferenceEvents: 5_516,
        transportEvents: eventCount,
        clients: clientCount,
        deliveredMessages: delivered,
        payloadFixture: 'tests/contracts/decoded-trade-v2.json',
        payloadBytes,
        averageFrameBytes: payloadBytes / eventCount,
        marketCorrectnessReplay: false,
    },
    encode: {
        elapsedMs: encodeMs,
        eventsPerSec: eventCount / (encodeMs / 1_000),
        mebibytesPerSec: payloadBytes / 1_048_576 / (encodeMs / 1_000),
    },
    queue: {
        clients: queueClients,
        operations: queueOps,
        elapsedMs: queueMs,
        operationsPerSec: queueOps / (queueMs / 1_000),
        sharedBufferIdentity: true,
    },
    loopback: {
        elapsedMs: deliveryMs,
        messagesPerSec: delivered / (deliveryMs / 1_000),
        cpuUserMs: cpu.user / 1_000,
        cpuSystemMs: cpu.system / 1_000,
        rssDeltaBytes: rssAfter - rssBefore,
        allDeliveredExactlyOnce: delivered === eventCount * clientCount,
    },
    gates: {
        encodeEventsPerSec: 20_000,
        queueOperationsPerSec: 100_000,
        loopbackMessagesPerSec: 10_000,
        maxLoopbackMs: 5_000,
    },
};

const failures = [];
if (result.encode.eventsPerSec < result.gates.encodeEventsPerSec) failures.push('encode throughput');
if (result.queue.operationsPerSec < result.gates.queueOperationsPerSec) failures.push('queue throughput');
if (result.loopback.messagesPerSec < result.gates.loopbackMessagesPerSec) failures.push('loopback throughput');
if (result.loopback.elapsedMs > result.gates.maxLoopbackMs) failures.push('loopback elapsed time');
if (!result.loopback.allDeliveredExactlyOnce) failures.push('delivery correctness');
result.passed = failures.length === 0;
result.failures = failures;

console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
