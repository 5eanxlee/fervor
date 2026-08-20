export const rtContract = 'fervor-realtime-v1' as const;
export const renderFps = 60;

export function frameDelay(lastAt: number, now: number): number {
    if (!Number.isFinite(lastAt) || lastAt <= 0) return 0;
    const elapsed = Math.max(0, now - lastAt);
    return Math.max(0, 1_000 / renderFps - elapsed);
}

export type RtStream = 'trade' | 'market' | 'candle' | 'order' | 'fill' | 'alert' | 'wallet' | 'replay';
export type RtMode = 'live' | 'historical_replay';
export type RtState = 'connecting' | 'live' | 'offline';

interface RtBase {
    contract: typeof rtContract;
    mode: RtMode;
    sessionId: string;
    epoch: number;
    sentAt: string;
}

export interface RtHello extends RtBase {
    type: 'hello';
    heartbeatMs: number;
    maxSubs: number;
}

export interface RtSnapshot extends RtBase {
    type: 'snapshot';
    cut: Partial<Record<RtStream, string>>;
    data: unknown;
}

export interface RtDelta extends RtBase {
    type: 'delta';
    stream: RtStream;
    delivery: 'exact' | 'ordered' | 'state';
    cursor: string;
    prior: string | null;
    scope: { tokenMint?: string; user?: true };
    observedAt: string | null;
    data: unknown;
}

export interface RtControl extends RtBase {
    type: 'control';
    code: 'heartbeat' | 'lag' | 'resync_required' | 'draining';
    reason?: string;
    cut?: Partial<Record<RtStream, string>>;
}

export interface RtError {
    contract: typeof rtContract;
    type: 'error';
    code: 'auth_required' | 'auth_invalid' | 'invalid_frame' | 'forbidden' | 'unavailable';
    message: string;
    retryable: boolean;
}

export type RtFrame = RtHello | RtSnapshot | RtDelta | RtControl | RtError;

export interface RtConnect {
    op: 'connect';
    url: string;
    token: string;
    tokenMint: string;
    streams: RtStream[];
}

export type RtWorkerIn = RtConnect | { op: 'ack'; id: number } | { op: 'disconnect' };
export type RtWorkerOut =
    | { type: 'frames'; id: number; frames: RtFrame[] }
    | { type: 'status'; state: RtState; reason?: string };

const streams = new Set<RtStream>([
    'trade', 'market', 'candle', 'order', 'fill', 'alert', 'wallet', 'replay',
]);
const modes = new Set<RtMode>(['live', 'historical_replay']);
const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const isRtFrame = (value: unknown): value is RtFrame => {
    if (!object(value) || value.contract !== rtContract || typeof value.type !== 'string') return false;
    if (value.type === 'error') {
        return ['auth_required', 'auth_invalid', 'invalid_frame', 'forbidden', 'unavailable']
            .includes(String(value.code))
            && typeof value.message === 'string'
            && typeof value.retryable === 'boolean';
    }
    if (!modes.has(value.mode as RtMode)
        || typeof value.sessionId !== 'string'
        || !Number.isSafeInteger(value.epoch)
        || Number(value.epoch) < 1
        || typeof value.sentAt !== 'string') return false;
    if (value.type === 'hello') {
        return Number.isSafeInteger(value.heartbeatMs) && Number(value.heartbeatMs) >= 1_000
            && Number.isSafeInteger(value.maxSubs) && Number(value.maxSubs) >= 1;
    }
    if (value.type === 'snapshot') return object(value.cut) && 'data' in value;
    if (value.type === 'control') {
        return ['heartbeat', 'lag', 'resync_required', 'draining'].includes(String(value.code));
    }
    return value.type === 'delta'
        && streams.has(value.stream as RtStream)
        && ['exact', 'ordered', 'state'].includes(String(value.delivery))
        && typeof value.cursor === 'string'
        && (value.prior === null || typeof value.prior === 'string')
        && object(value.scope)
        && (value.observedAt === null || typeof value.observedAt === 'string')
        && 'data' in value;
};

export const rtUrl = (base: string, origin = 'http://localhost'): string => {
    const url = new URL(base, origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/realtime/v1`;
    url.search = '';
    url.hash = '';
    return url.toString();
};
