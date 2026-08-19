/// <reference lib="webworker" />

import {
    isRtFrame,
    rtContract,
    type RtConnect,
    type RtFrame,
    type RtStream,
    type RtWorkerIn,
    type RtWorkerOut,
} from '../services/realtime';

const scope = self as DedicatedWorkerGlobalScope;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const maxPending = 4_096;

interface Resume {
    sessionId: string;
    epoch: number;
    cursors: Partial<Record<RtStream, string>>;
}

let config: RtConnect | undefined;
let socket: WebSocket | undefined;
let resume: Resume | undefined;
let retry = 0;
let retryTimer: number | undefined;
let flushTimer: number | undefined;
let pending: RtFrame[] = [];
let batchId = 0;
let inFlight: number | undefined;
let stopped = true;
let terminal = false;

const post = (message: RtWorkerOut): void => scope.postMessage(message);

const status = (state: 'connecting' | 'live' | 'offline', reason?: string): void =>
    post({ type: 'status', state, ...(reason ? { reason } : {}) });

const flush = (): void => {
    flushTimer = undefined;
    if (!pending.length || inFlight !== undefined) return;
    const frames = pending;
    pending = [];
    batchId += 1;
    inFlight = batchId;
    post({ type: 'frames', id: batchId, frames });
};

const stateKey = (frame: RtFrame): string | undefined => {
    if (frame.type === 'snapshot') return 'snapshot';
    if (frame.type === 'control' && frame.code === 'heartbeat') return 'heartbeat';
    if (frame.type === 'delta' && frame.delivery === 'state') {
        return `${frame.stream}:${frame.scope.tokenMint ?? 'user'}`;
    }
    return undefined;
};

const enqueue = (frame: RtFrame): void => {
    if (pending.length >= maxPending) {
        const key = stateKey(frame);
        if (key) {
            for (let index = pending.length - 1; index >= 0; index -= 1) {
                if (stateKey(pending[index]) !== key) continue;
                pending[index] = frame;
                return;
            }
        }
        resume = undefined;
        pending = [];
        status('connecting', 'Client fell behind; resynchronizing');
        socket?.close(1012, 'Client resync required');
        return;
    }
    pending.push(frame);
    flushTimer ??= scope.setTimeout(flush, 16);
};

const send = (frame: unknown): void => {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(encoder.encode(JSON.stringify(frame)));
    }
};

const remember = (frame: RtFrame): void => {
    if (frame.type === 'error') return;
    if (frame.type === 'control' && frame.code === 'resync_required') {
        resume = undefined;
        status('connecting', frame.reason || 'Server resynchronization required');
        return;
    }
    if (frame.type === 'snapshot') {
        resume = { sessionId: frame.sessionId, epoch: frame.epoch, cursors: { ...frame.cut } };
        return;
    }
    if (frame.type !== 'delta') return;
    if (!resume || resume.sessionId !== frame.sessionId || resume.epoch !== frame.epoch) {
        resume = { sessionId: frame.sessionId, epoch: frame.epoch, cursors: {} };
    }
    resume.cursors[frame.stream] = frame.cursor;
};

const subscribe = (hello: Extract<RtFrame, { type: 'hello' }>): void => {
    if (!config) return;
    const canResume = resume?.sessionId === hello.sessionId && resume.epoch === hello.epoch;
    send({
        contract: rtContract,
        op: 'subscribe',
        tokenMint: config.tokenMint,
        streams: config.streams,
        ...(canResume ? { resume } : {}),
    });
};

const fail = (reason: string, permanent = false): void => {
    terminal = permanent;
    status('offline', reason);
    socket?.close(1008, 'Invalid realtime frame');
};

const receive = async (data: unknown): Promise<void> => {
    let bytes: ArrayBuffer;
    if (data instanceof ArrayBuffer) bytes = data;
    else if (data instanceof Blob) bytes = await data.arrayBuffer();
    else return fail('Realtime server sent a non-binary frame', true);
    let value: unknown;
    try {
        value = JSON.parse(decoder.decode(bytes)) as unknown;
    } catch {
        return fail('Realtime server sent invalid data', true);
    }
    if (!isRtFrame(value)) return fail('Realtime server sent an invalid frame', true);
    if (value.type === 'error') {
        enqueue(value);
        return fail(value.message, !value.retryable);
    }
    if (value.type === 'hello') subscribe(value);
    remember(value);
    enqueue(value);
    if (value.type === 'snapshot' || value.type === 'delta') {
        retry = 0;
        status('live');
    }
};

const reconnect = (): void => {
    if (stopped || terminal || !config || retryTimer !== undefined) return;
    const cap = Math.min(10_000, 250 * 2 ** Math.min(retry, 6));
    const delay = Math.round(cap * (0.75 + Math.random() * 0.5));
    retry += 1;
    status('connecting');
    retryTimer = scope.setTimeout(() => {
        retryTimer = undefined;
        open();
    }, delay);
};

const open = (): void => {
    if (stopped || terminal || !config) return;
    try {
        socket = new WebSocket(config.url);
    } catch {
        status('offline', 'Realtime endpoint is invalid');
        terminal = true;
        return;
    }
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
        send({ contract: rtContract, op: 'auth', token: config!.token });
    };
    socket.onmessage = (event) => void receive(event.data);
    socket.onerror = () => socket?.close();
    socket.onclose = () => {
        socket = undefined;
        if (!stopped && !terminal) reconnect();
    };
};

const disconnect = (): void => {
    stopped = true;
    terminal = false;
    config = undefined;
    resume = undefined;
    pending = [];
    inFlight = undefined;
    if (retryTimer !== undefined) scope.clearTimeout(retryTimer);
    if (flushTimer !== undefined) scope.clearTimeout(flushTimer);
    retryTimer = undefined;
    flushTimer = undefined;
    socket?.close(1000, 'Client closed');
    socket = undefined;
};

scope.onmessage = (event: MessageEvent<RtWorkerIn>) => {
    if (event.data.op === 'disconnect') return disconnect();
    if (event.data.op === 'ack') {
        if (event.data.id !== inFlight) return;
        inFlight = undefined;
        if (pending.length) flushTimer ??= scope.setTimeout(flush, 0);
        return;
    }
    disconnect();
    config = event.data;
    stopped = false;
    terminal = false;
    retry = 0;
    status('connecting');
    open();
};
