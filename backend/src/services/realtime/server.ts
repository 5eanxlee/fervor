import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { type RawData, WebSocketServer } from 'ws';
import {
    AuthTokenError,
    authenticateUserToken,
} from '../../middleware/auth';
import type { User } from '../../types';
import { metrics } from '../metrics';
import { FrameQueue, type QueuedFrame } from './frameQueue';
import {
    encodeFrame,
    parseClientFrame,
    rtContract,
    rtPath,
    type RtClientFrame,
    type RtControl,
    type RtError,
    type RtFrame,
    type RtHello,
    type RtStream,
} from './protocol';
import type {
    ReplayFeed,
    ReplayResume,
    ReplaySeed,
} from './replayFeed';

interface RtFeed extends Pick<ReplayFeed,
    'enabled' | 'ownerId' | 'ready' | 'hello' | 'supports' | 'seed' | 'watch' | 'close'
> {}

export interface RtServerConfig {
    readonly authMs: number;
    readonly heartbeatMs: number;
    readonly maxPayloadBytes: number;
    readonly queueBytes: number;
    readonly queueFrames: number;
}

export interface RtServerOptions {
    readonly feed: RtFeed;
    readonly allowOrigin: (origin: string | undefined) => boolean;
    readonly authenticate?: (token: string) => Promise<User>;
    readonly config: RtServerConfig;
}

export interface RealtimeServer {
    readonly path: typeof rtPath;
    close(): Promise<void>;
}

const bytesOf = (data: RawData): Buffer => {
    if (Array.isArray(data)) return Buffer.concat(data);
    if (Buffer.isBuffer(data)) return data;
    return Buffer.from(data);
};

const rejectUpgrade = (socket: Duplex, status: 403 | 404): void => {
    const reason = status === 403 ? 'Forbidden' : 'Not Found';
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

const frameMeta = (frame: RtFrame): Omit<QueuedFrame, 'data'> => {
    if (frame.type === 'delta') {
        return {
            delivery: frame.delivery,
            ...(frame.delivery === 'state' ? {
                key: `${frame.stream}:${frame.scope.tokenMint ?? 'user'}`,
            } : {}),
        };
    }
    if (frame.type === 'snapshot') {
        return { delivery: 'state', key: 'snapshot' };
    }
    if (frame.type === 'control' && frame.code === 'heartbeat') {
        return { delivery: 'state', key: 'heartbeat' };
    }
    return { delivery: 'exact' };
};

class RtPeer {
    private readonly queue: FrameQueue;
    private readonly subs = new Map<string, Set<RtStream>>();
    private readonly authTimer: NodeJS.Timeout;
    private user?: User;
    private helloFrame?: RtHello;
    private unwatch?: () => void;
    private receiving = Promise.resolve();
    private sending = false;
    private alive = true;
    private closing = false;
    private closed = false;

    constructor(
        private readonly socket: WebSocket,
        private readonly options: RtServerOptions,
        private readonly onClose: () => void
    ) {
        this.queue = new FrameQueue(
            options.config.queueBytes,
            options.config.queueFrames
        );
        this.authTimer = setTimeout(() => {
            if (!this.user) this.fail('auth_required', 'Authentication timed out', true, 1008);
        }, options.config.authMs);
        this.authTimer.unref();
        socket.on('message', (data, binary) => {
            this.receiving = this.receiving
                .then(() => this.receive(data, binary))
                .catch(() => this.fail('invalid_frame', 'Realtime request failed', false, 1008));
        });
        socket.on('pong', () => {
            this.alive = true;
        });
        socket.once('error', () => this.finish());
        socket.once('close', () => this.finish());
    }

    heartbeat(): void {
        if (this.closed || this.closing) return;
        if (!this.alive) {
            this.socket.terminate();
            return;
        }
        this.alive = false;
        this.socket.ping();
        if (!this.helloFrame) return;
        this.enqueue({
            contract: rtContract,
            type: 'control',
            mode: this.helloFrame.mode,
            sessionId: this.helloFrame.sessionId,
            epoch: this.helloFrame.epoch,
            sentAt: new Date().toISOString(),
            code: 'heartbeat',
        });
    }

    drain(): void {
        if (this.closed || !this.helloFrame) {
            this.socket.close(1001, 'Server draining');
            return;
        }
        this.enqueue({
            contract: rtContract,
            type: 'control',
            mode: this.helloFrame.mode,
            sessionId: this.helloFrame.sessionId,
            epoch: this.helloFrame.epoch,
            sentAt: new Date().toISOString(),
            code: 'draining',
        });
        this.closing = true;
        this.socket.close(1001, 'Server draining');
    }

    terminate(): void {
        this.socket.terminate();
    }

    private async receive(data: RawData, binary: boolean): Promise<void> {
        if (this.closed || this.closing) return;
        if (!binary) {
            this.fail('invalid_frame', 'Binary frames are required', false, 1008);
            return;
        }
        const bytes = bytesOf(data);
        if (bytes.length === 0 || bytes.length > this.options.config.maxPayloadBytes) {
            this.fail('invalid_frame', 'Realtime frame size is invalid', false, 1009);
            return;
        }
        let value: unknown;
        try {
            value = JSON.parse(bytes.toString('utf8')) as unknown;
        } catch {
            this.fail('invalid_frame', 'Realtime frame is invalid', false, 1008);
            return;
        }
        let frame: RtClientFrame;
        try {
            frame = parseClientFrame(value);
        } catch {
            this.fail('invalid_frame', 'Realtime frame is invalid', false, 1008);
            return;
        }
        if (!this.user) {
            if (frame.op !== 'auth') {
                this.fail('auth_required', 'Authenticate before subscribing', false, 1008);
                return;
            }
            await this.authenticate(frame.token);
            return;
        }
        if (frame.op === 'auth') {
            this.fail('invalid_frame', 'Realtime connection is already authenticated', false, 1008);
            return;
        }
        if (frame.op === 'subscribe') this.subscribe(frame);
        else this.unsubscribe(frame.tokenMint, frame.streams);
    }

    private async authenticate(token: string): Promise<void> {
        try {
            const user = await (this.options.authenticate ?? authenticateUserToken)(token);
            if (!this.options.feed.enabled) {
                this.fail('unavailable', 'Historical replay is unavailable', false, 1013);
                return;
            }
            if (this.options.feed.ownerId && user.id !== this.options.feed.ownerId) {
                this.fail('forbidden', 'Realtime replay is not available for this user', false, 1008);
                return;
            }
            await this.options.feed.ready();
            if (this.closed || this.closing) return;
            this.user = user;
            clearTimeout(this.authTimer);
            this.unwatch = this.options.feed.watch((frame) => this.forward(frame));
            this.helloFrame = this.options.feed.hello();
            this.enqueue(this.helloFrame);
            metrics.increment('fervor_rt_auth_ok');
        } catch (error) {
            if (error instanceof AuthTokenError && error.code === 'unavailable') {
                this.fail('unavailable', 'Authentication is unavailable', true, 1013);
                return;
            }
            if (error instanceof AuthTokenError) {
                this.fail('auth_invalid', 'Authentication failed', false, 1008);
                return;
            }
            const retryable = !(error && typeof error === 'object'
                && 'retryable' in error && error.retryable === false);
            this.fail('unavailable', 'Realtime replay is unavailable', retryable, 1013);
        }
    }

    private subscribe(frame: Extract<RtClientFrame, { op: 'subscribe' }>): void {
        const streams = [...new Set(frame.streams)];
        if (streams.length !== frame.streams.length
            || !this.options.feed.supports(frame.tokenMint, streams)) {
            this.sendError('unavailable', 'Realtime subscription is unavailable', false);
            return;
        }
        const prior = this.subs.get(frame.tokenMint);
        const next = new Set(prior);
        for (const stream of streams) next.add(stream);
        let count = next.size;
        for (const [mint, subscribed] of this.subs) {
            if (mint !== frame.tokenMint) count += subscribed.size;
        }
        if (count > this.helloFrame!.maxSubs) {
            this.sendError('unavailable', 'Realtime subscription limit reached', false);
            return;
        }

        this.subs.set(frame.tokenMint, next);
        let seed: ReplaySeed;
        try {
            seed = this.options.feed.seed(streams, frame.resume as ReplayResume | undefined);
        } catch {
            if (prior) this.subs.set(frame.tokenMint, prior);
            else this.subs.delete(frame.tokenMint);
            this.sendError('unavailable', 'Realtime replay snapshot is unavailable', true);
            return;
        }
        for (const initial of seed.frames) this.enqueue(initial);
        metrics.increment('fervor_rt_subscriptions', { resumed: seed.resumed });
    }

    private unsubscribe(tokenMint: string, streams: readonly RtStream[]): void {
        const current = this.subs.get(tokenMint);
        if (!current) return;
        for (const stream of streams) current.delete(stream);
        if (current.size === 0) this.subs.delete(tokenMint);
    }

    private forward(frame: RtFrame): void {
        if (frame.type === 'delta') {
            const mint = frame.scope.tokenMint;
            if (!mint || !this.subs.get(mint)?.has(frame.stream)) return;
        } else if (frame.type === 'snapshot' || frame.type === 'control') {
            if (this.subs.size === 0) return;
        } else {
            return;
        }
        this.enqueue(frame);
    }

    private enqueue(frame: RtFrame): void {
        if (this.closed || this.closing) return;
        const data = encodeFrame(frame);
        const result = this.queue.push({ data, ...frameMeta(frame) });
        if (result === 'overflow') {
            this.lag();
            return;
        }
        metrics.gauge('fervor_rt_queue_bytes', this.queue.byteLength);
        this.flush();
    }

    private flush(): void {
        if (this.sending || this.closed || this.socket.readyState !== WebSocket.OPEN) return;
        const frame = this.queue.shift();
        if (!frame) return;
        this.sending = true;
        this.socket.send(frame.data, { binary: true, compress: false }, (error) => {
            this.sending = false;
            if (error) {
                this.socket.terminate();
                return;
            }
            metrics.increment('fervor_rt_frames_sent', { delivery: frame.delivery });
            metrics.increment('fervor_rt_bytes_sent', undefined, frame.data.length);
            this.flush();
        });
    }

    private lag(): void {
        metrics.increment('fervor_rt_client_lag');
        this.queue.clear();
        if (!this.helloFrame) {
            this.socket.close(1013, 'Resync required');
            return;
        }
        const frame: RtControl = {
            contract: rtContract,
            type: 'control',
            mode: this.helloFrame.mode,
            sessionId: this.helloFrame.sessionId,
            epoch: this.helloFrame.epoch,
            sentAt: new Date().toISOString(),
            code: 'resync_required',
            reason: 'client_lag',
        };
        this.sendAndClose(encodeFrame(frame), 1013, 'Resync required');
    }

    private sendError(code: RtError['code'], message: string, retryable: boolean): void {
        this.enqueue({ contract: rtContract, type: 'error', code, message, retryable });
    }

    private fail(
        code: RtError['code'],
        message: string,
        retryable: boolean,
        closeCode: number
    ): void {
        if (this.closed || this.closing || this.socket.readyState !== WebSocket.OPEN) return;
        metrics.increment('fervor_rt_protocol_errors', { code });
        const frame: RtError = { contract: rtContract, type: 'error', code, message, retryable };
        this.queue.clear();
        this.sendAndClose(encodeFrame(frame), closeCode, message);
    }

    private sendAndClose(data: Buffer, code: number, reason: string): void {
        if (this.closing || this.closed) return;
        this.closing = true;
        const timeout = setTimeout(() => this.socket.terminate(), 1_000);
        timeout.unref();
        this.socket.send(data, { binary: true, compress: false }, () => {
            clearTimeout(timeout);
            this.socket.close(code, reason.slice(0, 123));
        });
    }

    private finish(): void {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.authTimer);
        this.queue.clear();
        this.unwatch?.();
        this.onClose();
    }
}

const validateConfig = (config: RtServerConfig): void => {
    if (!Number.isSafeInteger(config.authMs) || config.authMs < 100
        || !Number.isSafeInteger(config.heartbeatMs) || config.heartbeatMs < 1_000
        || !Number.isSafeInteger(config.maxPayloadBytes) || config.maxPayloadBytes < 1_024
        || !Number.isSafeInteger(config.queueBytes) || config.queueBytes < 16_384
        || !Number.isSafeInteger(config.queueFrames) || config.queueFrames < 16) {
        throw new Error('Realtime server limits are invalid');
    }
};

export const attachRealtime = (
    server: Server,
    options: RtServerOptions
): RealtimeServer => {
    validateConfig(options.config);
    const webSockets = new WebSocketServer({
        noServer: true,
        perMessageDeflate: false,
        maxPayload: options.config.maxPayloadBytes,
        clientTracking: false,
    });
    const peers = new Set<RtPeer>();
    let closed = false;

    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
        let url: URL;
        try {
            url = new URL(request.url ?? '/', 'http://realtime.invalid');
        } catch {
            rejectUpgrade(socket, 404);
            return;
        }
        if (closed || url.pathname !== rtPath || url.search || !options.allowOrigin(request.headers.origin)) {
            rejectUpgrade(socket, url.pathname === rtPath ? 403 : 404);
            return;
        }
        webSockets.handleUpgrade(request, socket, head, (webSocket) => {
            let peer: RtPeer;
            peer = new RtPeer(webSocket, options, () => {
                peers.delete(peer);
                metrics.gauge('fervor_rt_connections', peers.size);
            });
            peers.add(peer);
            metrics.gauge('fervor_rt_connections', peers.size);
        });
    };
    server.on('upgrade', upgrade);
    const heartbeat = setInterval(() => {
        for (const peer of peers) peer.heartbeat();
    }, options.config.heartbeatMs);
    heartbeat.unref();

    return Object.freeze({
        path: rtPath,
        close: async (): Promise<void> => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            server.off('upgrade', upgrade);
            for (const peer of peers) peer.drain();
            const timeout = setTimeout(() => {
                for (const peer of peers) peer.terminate();
            }, 1_000);
            timeout.unref();
            await new Promise<void>((resolve) => webSockets.close(() => resolve()));
            clearTimeout(timeout);
            await options.feed.close();
        },
    });
};
