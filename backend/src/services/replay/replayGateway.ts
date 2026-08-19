import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { z } from 'zod';
import type { Env } from '../../config/env';
import {
    replayApiAuthContract,
    replayApiContract,
    replayApiMode,
    replayApiSessionId,
} from './replayApi';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const runId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const authSchema = z.object({
    contract: z.literal(replayApiAuthContract),
    sourceReplaySha256: hash,
    runId,
    tokenSha256: hash,
}).strict();
const sessionSchema = z.object({
    id: hash,
    sourceReplaySha256: hash,
    runId,
    epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    now: z.string().datetime({ offset: true }).nullable(),
}).passthrough();
const envelopeSchema = z.object({
    success: z.boolean(),
    contract: z.literal(replayApiContract),
    mode: z.literal(replayApiMode),
    session: sessionSchema,
}).passthrough();
const errorSchema = z.object({
    success: z.literal(false),
    error: z.string().min(1).max(256),
}).passthrough();

export type ReplayResource =
    | 'snapshot'
    | 'notifications'
    | 'deltas'
    | 'paper'
    | 'paper/actions'
    | 'controls'
    | `wallets/${string}`;

export interface ReplayCall {
    readonly method: 'GET' | 'POST';
    readonly resource: ReplayResource;
    readonly query?: string;
    readonly body?: unknown;
}

export interface ReplayReply {
    readonly status: number;
    readonly body: unknown;
}

export interface ReplayGateway {
    readonly enabled: boolean;
    readonly ownerId?: string;
    call(input: ReplayCall): Promise<ReplayReply>;
}

export type ReplayEnv = Pick<Env,
    | 'REPLAY_API_SOCKET'
    | 'REPLAY_API_AUTH_FILE'
    | 'REPLAY_API_TOKEN_FILE'
    | 'REPLAY_API_USER_ID'
    | 'REPLAY_API_TIMEOUT_MS'
    | 'REPLAY_API_MAX_BYTES'
>;

export type ReplayCode = 'not_configured' | 'invalid_request' | 'credential_invalid'
    | 'unavailable' | 'invalid_response';

type ReplayConfig = Required<Omit<ReplayEnv, 'REPLAY_API_USER_ID'>>
    & Pick<ReplayEnv, 'REPLAY_API_USER_ID'>;

export class ReplayGatewayError extends Error {
    constructor(
        readonly code: ReplayCode,
        message: string,
        readonly status: 400 | 502 | 503,
        readonly retryable: boolean
    ) {
        super(message);
        this.name = 'ReplayGatewayError';
    }
}

interface Credentials extends z.infer<typeof authSchema> {
    readonly token: string;
}

const tokenPattern = /^[A-Za-z0-9._~-]{32,256}$/;
const walletRoute = /^wallets\/[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const reads = new Set<ReplayResource>(['snapshot', 'notifications', 'deltas', 'paper']);
const writes = new Set<ReplayResource>(['paper/actions', 'controls']);

const validRoute = (method: ReplayCall['method'], resource: ReplayResource): boolean => {
    if (method === 'GET') return reads.has(resource) || walletRoute.test(resource);
    return writes.has(resource);
};

const validQuery = (query: string): boolean => query === ''
    || (query.startsWith('?')
        && query.length <= 2_049
        && !/[#\r\n]/.test(query));

const sameHash = (left: string, right: string): boolean => {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
};

const loadCredentials = async (authFile: string, tokenFile: string): Promise<Credentials> => {
    const [authBytes, tokenBytes] = await Promise.all([
        readFile(authFile),
        readFile(tokenFile),
    ]);
    if (authBytes.length > 4_096 || tokenBytes.length > 1_024) {
        throw new Error('Replay credential file is too large');
    }
    const auth = authSchema.parse(JSON.parse(authBytes.toString('utf8')) as unknown);
    const token = tokenBytes.toString('utf8').trim();
    if (!tokenPattern.test(token)
        || !sameHash(createHash('sha256').update(token).digest('hex'), auth.tokenSha256)) {
        throw new Error('Replay credential binding is invalid');
    }
    return Object.freeze({ ...auth, token });
};

const parseReply = (
    status: number,
    bytes: Buffer,
    auth: Credentials
): ReplayReply => {
    let body: unknown;
    try {
        body = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
        throw new ReplayGatewayError(
            'invalid_response', 'Replay returned an invalid response', 502, true
        );
    }
    const envelope = envelopeSchema.safeParse(body);
    if (envelope.success) {
        if (envelope.data.session.runId !== auth.runId
            || envelope.data.session.sourceReplaySha256 !== auth.sourceReplaySha256
            || envelope.data.session.id !== replayApiSessionId(auth)
            || envelope.data.success !== (status < 400)) {
            throw new ReplayGatewayError(
                'invalid_response', 'Replay response identity changed', 502, false
            );
        }
        return { status, body };
    }
    if (status >= 400 && errorSchema.safeParse(body).success) return { status, body };
    throw new ReplayGatewayError(
        'invalid_response', 'Replay returned an invalid response', 502, true
    );
};

class UnixReplayGateway implements ReplayGateway {
    readonly enabled = true;
    readonly ownerId?: string;
    private credentials?: Promise<Credentials>;

    constructor(private readonly config: ReplayConfig) {
        this.ownerId = config.REPLAY_API_USER_ID;
    }

    private auth(): Promise<Credentials> {
        this.credentials ??= loadCredentials(
            this.config.REPLAY_API_AUTH_FILE,
            this.config.REPLAY_API_TOKEN_FILE
        ).catch(() => {
            throw new ReplayGatewayError(
                'credential_invalid', 'Replay credentials are invalid', 503, false
            );
        });
        return this.credentials;
    }

    async call(input: ReplayCall): Promise<ReplayReply> {
        const query = input.query ?? '';
        if (!validRoute(input.method, input.resource)
            || !validQuery(query)
            || (input.method === 'GET' && input.body !== undefined)) {
            throw new ReplayGatewayError(
                'invalid_request', 'Replay request is invalid', 400, false
            );
        }
        const auth = await this.auth();
        const payload = input.body === undefined
            ? undefined
            : Buffer.from(JSON.stringify(input.body));
        if (payload && payload.length > 16_384) {
            throw new ReplayGatewayError(
                'invalid_request', 'Replay request is too large', 400, false
            );
        }
        const route = `/api/replay/v1/runs/${auth.runId}/${input.resource}${query}`;
        return new Promise<ReplayReply>((resolve, reject) => {
            let settled = false;
            const finish = (error?: Error, reply?: ReplayReply): void => {
                if (settled) return;
                settled = true;
                if (error) reject(error);
                else resolve(reply!);
            };
            const req = request({
                socketPath: this.config.REPLAY_API_SOCKET,
                path: route,
                method: input.method,
                headers: {
                    accept: 'application/json',
                    authorization: `Bearer ${auth.token}`,
                    connection: 'close',
                    'x-fervor-mode': replayApiMode,
                    ...(payload === undefined ? {} : {
                        'content-type': 'application/json',
                        'content-length': String(payload.length),
                    }),
                },
            }, (res) => {
                const status = res.statusCode ?? 0;
                const declared = Number(res.headers['content-length'] ?? 0);
                if (!Number.isSafeInteger(declared)
                    || declared > this.config.REPLAY_API_MAX_BYTES) {
                    res.destroy();
                    return finish(new ReplayGatewayError(
                        'invalid_response', 'Replay response is too large', 502, true
                    ));
                }
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (chunk: Buffer) => {
                    if (settled) return;
                    size += chunk.length;
                    if (size > this.config.REPLAY_API_MAX_BYTES) {
                        res.destroy();
                        finish(new ReplayGatewayError(
                            'invalid_response', 'Replay response is too large', 502, true
                        ));
                        return;
                    }
                    chunks.push(Buffer.from(chunk));
                });
                res.once('end', () => {
                    if (settled) return;
                    if (status === 401 || status === 403) {
                        return finish(new ReplayGatewayError(
                            'credential_invalid', 'Replay credentials were rejected', 503, false
                        ));
                    }
                    if (status < 200 || status > 599 || (status >= 300 && status < 400)) {
                        return finish(new ReplayGatewayError(
                            'invalid_response', 'Replay returned an invalid status', 502, true
                        ));
                    }
                    try {
                        finish(undefined, parseReply(status, Buffer.concat(chunks), auth));
                    } catch (error) {
                        finish(error as Error);
                    }
                });
                res.once('aborted', () => finish(new ReplayGatewayError(
                    'unavailable', 'Replay response was interrupted', 503, true
                )));
                res.once('error', () => finish(new ReplayGatewayError(
                    'unavailable', 'Replay response failed', 503, true
                )));
            });
            req.setTimeout(this.config.REPLAY_API_TIMEOUT_MS, () => {
                req.destroy();
                finish(new ReplayGatewayError(
                    'unavailable', 'Replay request timed out', 503, true
                ));
            });
            req.once('error', () => finish(new ReplayGatewayError(
                'unavailable', 'Replay is unavailable', 503, true
            )));
            req.end(payload);
        });
    }
}

const disabledGateway = (): ReplayGateway => Object.freeze({
    enabled: false,
    call: async () => {
        throw new ReplayGatewayError(
            'not_configured', 'Historical replay is not configured', 503, false
        );
    },
});

export const createReplayGateway = (config: ReplayEnv): ReplayGateway => {
    if (!config.REPLAY_API_SOCKET
        || !config.REPLAY_API_AUTH_FILE
        || !config.REPLAY_API_TOKEN_FILE) return disabledGateway();
    return new UnixReplayGateway(config as ReplayConfig);
};
