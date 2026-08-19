import { z } from 'zod';

export const rtContract = 'fervor-realtime-v1' as const;
export const rtPath = '/api/realtime/v1' as const;

export const rtStreams = [
    'trade',
    'market',
    'candle',
    'order',
    'fill',
    'alert',
    'wallet',
    'replay',
] as const;

export type RtMode = 'live' | 'historical_replay';
export type RtStream = typeof rtStreams[number];
export type RtClass = 'exact' | 'ordered' | 'state';

export interface RtScope {
    readonly tokenMint?: string;
    readonly user?: true;
}

export interface RtBase {
    readonly contract: typeof rtContract;
    readonly mode: RtMode;
    readonly sessionId: string;
    readonly epoch: number;
    readonly sentAt: string;
}

export interface RtHello extends RtBase {
    readonly type: 'hello';
    readonly heartbeatMs: number;
    readonly maxSubs: number;
}

export interface RtSnapshot extends RtBase {
    readonly type: 'snapshot';
    readonly cut: Readonly<Partial<Record<RtStream, string>>>;
    readonly data: unknown;
}

export interface RtDelta extends RtBase {
    readonly type: 'delta';
    readonly stream: RtStream;
    readonly delivery: RtClass;
    readonly cursor: string;
    readonly prior: string | null;
    readonly scope: RtScope;
    readonly observedAt: string | null;
    readonly data: unknown;
}

export interface RtControl extends RtBase {
    readonly type: 'control';
    readonly code: 'heartbeat' | 'lag' | 'resync_required' | 'draining';
    readonly reason?: string;
    readonly cut?: Readonly<Partial<Record<RtStream, string>>>;
}

export interface RtError {
    readonly contract: typeof rtContract;
    readonly type: 'error';
    readonly code: 'auth_required' | 'auth_invalid' | 'invalid_frame' | 'forbidden' | 'unavailable';
    readonly message: string;
    readonly retryable: boolean;
}

export type RtFrame = RtHello | RtSnapshot | RtDelta | RtControl | RtError;

const token = z.string().min(32).max(4_096).regex(/^[A-Za-z0-9._~-]+$/);
const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const cursor = z.string().min(1).max(128);
const sessionId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const auth = z.object({
    contract: z.literal(rtContract),
    op: z.literal('auth'),
    token,
}).strict();
const subscribe = z.object({
    contract: z.literal(rtContract),
    op: z.literal('subscribe'),
    tokenMint: address,
    streams: z.array(z.enum(rtStreams)).min(1).max(rtStreams.length),
    resume: z.object({
        sessionId,
        epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        cursors: z.record(z.enum(rtStreams), cursor),
    }).strict().optional(),
}).strict();
const unsubscribe = z.object({
    contract: z.literal(rtContract),
    op: z.literal('unsubscribe'),
    tokenMint: address,
    streams: z.array(z.enum(rtStreams)).min(1).max(rtStreams.length),
}).strict();

export const rtClientSchema = z.discriminatedUnion('op', [auth, subscribe, unsubscribe]);
export type RtClientFrame = z.infer<typeof rtClientSchema>;

export const parseClientFrame = (value: unknown): RtClientFrame => rtClientSchema.parse(value);

export const encodeFrame = (frame: RtFrame): Buffer => Buffer.from(JSON.stringify(frame));
