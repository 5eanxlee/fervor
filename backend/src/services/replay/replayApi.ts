import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import type { ReplaySnapshot } from './coordinator';
import type { ReplayNotificationPage } from './replayAlerts';
import type { ReplayRuntime, ReplayState } from './runtime';

export const replayApiAuthContract = 'fervor-replay-api-auth-v1' as const;
export const replayApiContract = 'fervor-replay-api-v1' as const;
export const replayApiMode = 'historical_replay' as const;

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const runId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const authSchema = z.object({
    contract: z.literal(replayApiAuthContract),
    sourceReplaySha256: hash,
    runId,
    tokenSha256: hash,
}).strict();

export interface ReplayApiAuth extends z.infer<typeof authSchema> {
    readonly sessionId: string;
}

export interface ReplayApi {
    readonly socketPath: string;
    readonly sessionId: string;
    close(): Promise<void>;
}

interface CutIdentity {
    readonly sourceReplaySha256: string;
    readonly runId: string;
    readonly epoch: number;
    readonly cursor: number;
    readonly now: string | null;
}

interface ApiEnvelope {
    readonly contract: typeof replayApiContract;
    readonly mode: typeof replayApiMode;
    readonly session: CutIdentity & { readonly id: string };
    readonly data: unknown;
}

const sessionId = (value: z.infer<typeof authSchema>): string => createHash('sha256')
    .update(replayApiAuthContract)
    .update('\0')
    .update(value.sourceReplaySha256)
    .update('\0')
    .update(value.runId)
    .update('\0')
    .update(value.tokenSha256)
    .digest('hex');

export const normalizeReplayApiAuth = (
    value: unknown,
    snapshot: ReplaySnapshot
): ReplayApiAuth => {
    const input = authSchema.parse(value);
    if (input.sourceReplaySha256 !== snapshot.sourceReplaySha256
        || input.runId !== snapshot.runId) {
        throw new Error('Replay API auth does not match its run');
    }
    return Object.freeze({ ...input, sessionId: sessionId(input) });
};

const identityOf = (snapshot: ReplaySnapshot): CutIdentity => ({
    sourceReplaySha256: snapshot.sourceReplaySha256,
    runId: snapshot.runId,
    epoch: snapshot.epoch,
    cursor: snapshot.cursor,
    now: snapshot.now,
});

const pageIdentity = (page: ReplayNotificationPage): CutIdentity => ({
    sourceReplaySha256: page.sourceReplaySha256,
    runId: page.runId,
    epoch: page.epoch,
    cursor: page.cutCursor,
    now: page.cutAt,
});

const responseBody = (auth: ReplayApiAuth, cut: CutIdentity, data: unknown): ApiEnvelope => {
    if (cut.sourceReplaySha256 !== auth.sourceReplaySha256 || cut.runId !== auth.runId) {
        throw new Error('Replay API cut escaped its authenticated run');
    }
    return {
        contract: replayApiContract,
        mode: replayApiMode,
        session: {
            id: auth.sessionId,
            sourceReplaySha256: cut.sourceReplaySha256,
            runId: cut.runId,
            epoch: cut.epoch,
            cursor: cut.cursor,
            now: cut.now,
        },
        data,
    };
};

const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
    const body = JSON.stringify(value);
    res.sendDate = false;
    res.statusCode = status;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(body);
};

const reject = (res: ServerResponse, status: number, error: string): void =>
    sendJson(res, status, { success: false, error });

const hasToken = (req: IncomingMessage, expected: string): boolean => {
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9._~-]{32,256})$/)?.[1];
    if (!token) return false;
    const actual = createHash('sha256').update(token).digest();
    return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
};

const intParam = (
    value: string | null,
    fallback: number,
    max: number
): number | undefined => {
    if (value === null) return fallback;
    if (!/^(0|[1-9]\d*)$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed <= max ? parsed : undefined;
};

const notificationQuery = (url: URL): { after: number; limit: number } | undefined => {
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => key !== 'after' && key !== 'limit')
        || new Set(keys).size !== keys.length) return undefined;
    const after = intParam(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(url.searchParams.get('limit'), 100, 500);
    if (after === undefined || limit === undefined || limit < 1) return undefined;
    return { after, limit };
};

const handler = (
    runtime: ReplayRuntime,
    auth: ReplayApiAuth
): ((req: IncomingMessage, res: ServerResponse) => void) => {
    const base = `/api/replay/v1/runs/${auth.runId}`;
    return (req, res) => {
        if (req.headers['x-fervor-mode'] !== replayApiMode) {
            return reject(res, 409, 'Historical replay mode required');
        }
        if (!hasToken(req, auth.tokenSha256)) {
            res.setHeader('WWW-Authenticate', 'Bearer realm="fervor-replay"');
            return reject(res, 401, 'Replay access token required');
        }
        if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET');
            return reject(res, 405, 'Method not allowed');
        }
        let url: URL;
        try {
            url = new URL(req.url ?? '/', 'http://replay.invalid');
        } catch {
            return reject(res, 400, 'Invalid request URL');
        }
        try {
            if (url.pathname === `${base}/snapshot`) {
                if (url.search) return reject(res, 400, 'Snapshot query is invalid');
                const state: ReplayState = runtime.state();
                return sendJson(res, 200, {
                    success: true,
                    ...responseBody(auth, identityOf(state.snapshot), { state }),
                });
            }
            if (url.pathname === `${base}/notifications`) {
                const query = notificationQuery(url);
                if (!query) return reject(res, 400, 'Notification query is invalid');
                const page = runtime.notifications(query.after, query.limit);
                return sendJson(res, 200, {
                    success: true,
                    ...responseBody(auth, pageIdentity(page), { page }),
                });
            }
            return reject(res, 404, 'Replay route not found');
        } catch {
            return reject(res, 500, 'Replay API failure');
        }
    };
};

interface SocketId {
    readonly dev: number;
    readonly ino: number;
}

const socketId = async (socketPath: string): Promise<SocketId> => {
    const info = await lstat(socketPath);
    if (!info.isSocket() || info.isSymbolicLink()) {
        throw new Error('Replay API socket path is not a socket');
    }
    return { dev: info.dev, ino: info.ino };
};

const socketIsLive = (socketPath: string): Promise<boolean> => new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    let settled = false;
    const finish = (value: boolean, error?: Error): void => {
        if (settled) return;
        settled = true;
        client.destroy();
        if (error) reject(error);
        else resolve(value);
    };
    client.once('connect', () => finish(true));
    client.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') finish(false);
        else finish(false, error);
    });
    client.setTimeout(500, () => finish(true));
});

const prepareSocket = async (socketPath: string): Promise<void> => {
    try {
        await socketId(socketPath);
        if (await socketIsLive(socketPath)) throw new Error('Replay API socket is already in use');
        await unlink(socketPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
};

const removeSocket = async (socketPath: string, owned: SocketId): Promise<void> => {
    try {
        const current = await socketId(socketPath);
        if (current.dev === owned.dev && current.ino === owned.ino) await unlink(socketPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
};

const listen = (server: Server, socketPath: string): Promise<void> => new Promise((resolve, reject) => {
    const failed = (error: Error): void => reject(error);
    server.once('error', failed);
    server.listen(socketPath, 32, () => {
        server.off('error', failed);
        resolve();
    });
});

export const startReplayApi = async (
    runtime: ReplayRuntime,
    rootValue: string,
    socketValue: string,
    authValue: unknown
): Promise<ReplayApi> => {
    const root = path.resolve(rootValue);
    const socketPath = path.resolve(socketValue);
    if (path.dirname(socketPath) !== root
        || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}\.sock$/.test(path.basename(socketPath))) {
        throw new Error('Replay API socket path is invalid');
    }
    await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
    });
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new Error('Replay API socket path is invalid');
    }
    const auth = normalizeReplayApiAuth(authValue, runtime.state().snapshot);
    await prepareSocket(socketPath);
    const server = createServer(handler(runtime, auth));
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 1_000;
    server.maxRequestsPerSocket = 100;
    server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
    let owned: SocketId | undefined;
    try {
        await listen(server, socketPath);
        owned = await socketId(socketPath);
        await chmod(socketPath, 0o600);
    } catch (error) {
        if (server.listening) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        if (owned) await removeSocket(socketPath, owned);
        throw error;
    }
    let closed = false;
    return Object.freeze({
        socketPath,
        sessionId: auth.sessionId,
        close: async (): Promise<void> => {
            if (closed) return;
            closed = true;
            await new Promise<void>((resolve, reject) => server.close((error) =>
                error ? reject(error) : resolve()));
            await removeSocket(socketPath, owned!);
        },
    });
};
