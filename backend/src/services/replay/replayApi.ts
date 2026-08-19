import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { addressSchema } from '../../types/execution';
import {
    replayResyncContract,
    type ReplayDeltaPage,
    type ReplayResync,
    type ReplaySnapshot,
} from './coordinator';
import {
    paperOrderSchema,
    type PaperOrder,
    type PaperRequest,
} from './paperBroker';
import { priceOf } from './paperTypes';
import type { ReplayRuntime, ReplayState } from './runtime';

export const replayApiAuthContract = 'fervor-replay-api-auth-v1' as const;
export const replayApiContract = 'fervor-replay-api-v1' as const;
export const replayApiMode = 'historical_replay' as const;
export const replayPaperContract = 'fervor-replay-paper-page-v1' as const;
export const replayPaperCommandContract = 'fervor-replay-paper-command-v1' as const;
export const replayPaperActionContract = 'fervor-replay-paper-action-v1' as const;
export const replayControlCommandContract = 'fervor-replay-control-command-v1' as const;
export const replayControlActionContract = 'fervor-replay-control-action-v1' as const;

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const runId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const authSchema = z.object({
    contract: z.literal(replayApiAuthContract),
    sourceReplaySha256: hash,
    runId,
    tokenSha256: hash,
}).strict();
const cutFields = {
    epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    fact: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
};
const actionCut = {
    contract: z.literal(replayPaperCommandContract),
    ...cutFields,
};
const paperActionSchema = z.discriminatedUnion('op', [
    z.object({
        ...actionCut,
        op: z.literal('place'),
        order: paperOrderSchema,
    }).strict(),
    z.object({
        ...actionCut,
        op: z.literal('cancel'),
        orderId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
    }).strict(),
]);
const controlCut = {
    contract: z.literal(replayControlCommandContract),
    ...cutFields,
};
const controlSchema = z.discriminatedUnion('op', [
    z.object({
        ...controlCut,
        op: z.literal('play'),
        speed: z.union([z.literal(1), z.literal(20), z.literal(100), z.literal('max')]),
    }).strict(),
    z.object({ ...controlCut, op: z.literal('pause') }).strict(),
    z.object({ ...controlCut, op: z.literal('step') }).strict(),
    z.object({
        ...controlCut,
        op: z.literal('seek'),
        target: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    }).strict(),
]);

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

const pageIdentity = (page: {
    sourceReplaySha256: string;
    runId: string;
    epoch: number;
    cutCursor: number;
    cutAt: string | null;
}): CutIdentity => ({
    sourceReplaySha256: page.sourceReplaySha256,
    runId: page.runId,
    epoch: page.epoch,
    cursor: page.cutCursor,
    now: page.cutAt,
});

const deltaIdentity = (page: ReplayDeltaPage): CutIdentity => ({
    sourceReplaySha256: page.sourceReplaySha256,
    runId: page.runId,
    epoch: page.epoch,
    cursor: page.cutCursor,
    now: page.cutAt,
});

const resyncIdentity = (resync: ReplayResync): CutIdentity => ({
    sourceReplaySha256: resync.sourceReplaySha256,
    runId: resync.runId,
    epoch: resync.cut.epoch,
    cursor: resync.cut.cursor,
    now: resync.cut.now,
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

const sendResync = (
    res: ServerResponse,
    auth: ReplayApiAuth,
    resync: ReplayResync
): void => sendJson(res, 409, {
    success: false,
    ...responseBody(auth, resyncIdentity(resync), { resync }),
});

const readJson = (
    req: IncomingMessage,
    res: ServerResponse,
    maxBytes = 16_384
): Promise<unknown | undefined> => {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
        reject(res, 415, 'JSON content type required');
        req.resume();
        return Promise.resolve(undefined);
    }
    const declared = req.headers['content-length'];
    if (declared !== undefined
        && (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > maxBytes)) {
        return new Promise((resolve) => {
            req.once('end', () => {
                reject(res, 413, 'Request body is too large');
                resolve(undefined);
            });
            req.once('aborted', () => resolve(undefined));
            req.once('error', () => resolve(undefined));
            req.resume();
        });
    }
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let tooLarge = false;
        let done = false;
        const finish = (value: unknown | undefined): void => {
            if (done) return;
            done = true;
            resolve(value);
        };
        req.on('data', (chunk: Buffer) => {
            if (done) return;
            bytes += chunk.length;
            if (bytes > maxBytes) {
                tooLarge = true;
                chunks.length = 0;
                return;
            }
            if (!tooLarge) chunks.push(Buffer.from(chunk));
        });
        req.once('end', () => {
            if (done) return;
            if (tooLarge) {
                reject(res, 413, 'Request body is too large');
                return finish(undefined);
            }
            if (bytes === 0) {
                reject(res, 400, 'JSON body required');
                return finish(undefined);
            }
            try {
                finish(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
            } catch {
                reject(res, 400, 'JSON body is invalid');
                finish(undefined);
            }
        });
        const failed = (): void => {
            if (!done) reject(res, 400, 'Request body was interrupted');
            finish(undefined);
        };
        req.once('aborted', failed);
        req.once('error', failed);
    });
};

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

const hasOnly = (url: URL, allowed: readonly string[]): boolean => {
    const keys = [...url.searchParams.keys()];
    return !keys.some((key) => !allowed.includes(key))
        && new Set(keys).size === keys.length;
};

interface NotificationQuery {
    readonly after: number;
    readonly limit: number;
    readonly epoch?: number;
    readonly cursor?: number;
}

const notificationQuery = (url: URL): NotificationQuery | undefined => {
    if (!hasOnly(url, ['after', 'limit', 'epoch', 'cursor'])) return undefined;
    const after = intParam(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(url.searchParams.get('limit'), 100, 500);
    if (after === undefined || limit === undefined || limit < 1) return undefined;
    const hasCut = url.searchParams.has('epoch') || url.searchParams.has('cursor');
    if (!hasCut) return { after, limit };
    if (!url.searchParams.has('epoch') || !url.searchParams.has('cursor')) return undefined;
    const epoch = intParam(url.searchParams.get('epoch'), 0, Number.MAX_SAFE_INTEGER);
    const cursor = intParam(url.searchParams.get('cursor'), 0, Number.MAX_SAFE_INTEGER);
    if (epoch === undefined || epoch < 1 || cursor === undefined) return undefined;
    return { after, limit, epoch, cursor };
};

const deltaQuery = (
    url: URL
): { epoch: number; after: number; limit: number } | undefined => {
    if (!hasOnly(url, ['epoch', 'after', 'limit'])
        || !url.searchParams.has('epoch')
        || !url.searchParams.has('after')) return undefined;
    const epoch = intParam(url.searchParams.get('epoch'), 0, Number.MAX_SAFE_INTEGER);
    const after = intParam(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(url.searchParams.get('limit'), 100, 500);
    if (epoch === undefined || epoch < 1
        || after === undefined
        || limit === undefined || limit < 1) return undefined;
    return { epoch, after, limit };
};

interface PaperQuery {
    readonly epoch: number;
    readonly cursor: number;
    readonly fact: number;
    readonly orderAfter: number;
    readonly factAfter: number;
    readonly limit: number;
}

const paperQuery = (url: URL): PaperQuery | undefined => {
    if (!hasOnly(url, ['epoch', 'cursor', 'fact', 'orderAfter', 'factAfter', 'limit'])
        || !url.searchParams.has('epoch')
        || !url.searchParams.has('cursor')
        || !url.searchParams.has('fact')) return undefined;
    const epoch = intParam(url.searchParams.get('epoch'), 0, Number.MAX_SAFE_INTEGER);
    const cursor = intParam(url.searchParams.get('cursor'), 0, Number.MAX_SAFE_INTEGER);
    const fact = intParam(url.searchParams.get('fact'), 0, Number.MAX_SAFE_INTEGER);
    const orderAfter = intParam(
        url.searchParams.get('orderAfter'), 0, Number.MAX_SAFE_INTEGER
    );
    const factAfter = intParam(
        url.searchParams.get('factAfter'), 0, Number.MAX_SAFE_INTEGER
    );
    const limit = intParam(url.searchParams.get('limit'), 100, 100);
    if (epoch === undefined || epoch < 1
        || cursor === undefined || fact === undefined
        || orderAfter === undefined || factAfter === undefined
        || limit === undefined || limit < 1) return undefined;
    return { epoch, cursor, fact, orderAfter, factAfter, limit };
};

interface WalletQuery {
    readonly epoch: number;
    readonly cursor: number;
    readonly after: number;
    readonly limit: number;
}

const walletQuery = (url: URL): WalletQuery | undefined => {
    if (!hasOnly(url, ['epoch', 'cursor', 'after', 'limit'])
        || !url.searchParams.has('epoch')
        || !url.searchParams.has('cursor')) return undefined;
    const epoch = intParam(url.searchParams.get('epoch'), 0, Number.MAX_SAFE_INTEGER);
    const cursor = intParam(url.searchParams.get('cursor'), 0, Number.MAX_SAFE_INTEGER);
    const after = intParam(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(url.searchParams.get('limit'), 100, 500);
    if (epoch === undefined || epoch < 1
        || cursor === undefined || after === undefined
        || limit === undefined || limit < 1) return undefined;
    return { epoch, cursor, after, limit };
};

const exactResync = (
    state: ReplayState,
    requested: Readonly<{ epoch: number; cursor: number; fact?: number }>
): ReplayResync | undefined => {
    const snapshot = state.snapshot;
    const reason = requested.epoch !== snapshot.epoch
        ? 'epoch_changed'
        : requested.cursor !== snapshot.cursor
            ? 'cursor_changed'
            : requested.fact !== undefined && requested.fact !== state.paper.factCount
                ? 'paper_changed'
                : undefined;
    if (reason === undefined) return undefined;
    return Object.freeze({
        contract: replayResyncContract,
        reason,
        sourceReplaySha256: snapshot.sourceReplaySha256,
        runId: snapshot.runId,
        requested: Object.freeze({ ...requested }),
        cut: Object.freeze({
            epoch: snapshot.epoch,
            cursor: snapshot.cursor,
            now: snapshot.now,
            ...(requested.fact === undefined ? {} : { fact: state.paper.factCount }),
        }),
    });
};

const offsetPage = <T>(after: number, total: number, items: readonly T[]) => ({
    after,
    next: after + items.length < total ? after + items.length : null,
    total,
    items,
});

const sameOrder = (order: PaperOrder, request: PaperRequest): boolean => {
    const requestedPrice = priceOf(request.kind === 'market' ? request.reference : request.limit);
    return order.id === request.id
        && order.kind === request.kind
        && order.side === request.side
        && order.tokenMint === request.tokenMint
        && order.quoteMint === request.quoteMint
        && order.inputRaw === request.inputRaw
        && order.price.quoteRaw === requestedPrice.quoteRaw
        && order.price.tokenRaw === requestedPrice.tokenRaw;
};

const actionResponse = (
    res: ServerResponse,
    status: number,
    auth: ReplayApiAuth,
    state: ReplayState,
    op: 'place' | 'cancel',
    applied: boolean,
    order: PaperOrder
): void => sendJson(res, status, {
    success: true,
    ...responseBody(auth, identityOf(state.snapshot), {
        action: {
            contract: replayPaperActionContract,
            op,
            applied,
            revision: {
                epoch: state.snapshot.epoch,
                cursor: state.snapshot.cursor,
                fact: state.paper.factCount,
            },
            order,
        },
    }),
});

type ControlCommand = z.infer<typeof controlSchema>;
type MutationGate = (
    res: ServerResponse,
    task: () => void | Promise<void>
) => Promise<void>;

const controlResponse = (
    res: ServerResponse,
    status: number,
    auth: ReplayApiAuth,
    command: ControlCommand,
    applied: boolean,
    state: ReplayState
): void => sendJson(res, status, {
    success: true,
    ...responseBody(auth, identityOf(state.snapshot), {
        control: {
            contract: replayControlActionContract,
            op: command.op,
            applied,
            requested: {
                epoch: command.epoch,
                cursor: command.cursor,
                fact: command.fact,
            },
            revision: {
                epoch: state.snapshot.epoch,
                cursor: state.snapshot.cursor,
                fact: state.paper.factCount,
            },
            ...(command.op === 'play' ? { speed: command.speed } : {}),
            ...(command.op === 'seek' ? { target: command.target } : {}),
        },
        state,
    }),
});

const handlePaperAction = async (
    runtime: ReplayRuntime,
    auth: ReplayApiAuth,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    mutate: MutationGate
): Promise<void> => {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return reject(res, 405, 'Method not allowed');
    }
    if (url.search) return reject(res, 400, 'Paper action query is invalid');
    const body = await readJson(req, res);
    if (body === undefined) return;
    const parsed = paperActionSchema.safeParse(body);
    if (!parsed.success) return reject(res, 400, 'Paper action is invalid');
    const command = parsed.data;
    await mutate(res, () => {
        if (runtime.state().mutating) {
            return reject(res, 409, 'Replay mutation is already active');
        }
        const orderId = command.op === 'place' ? command.order.id : command.orderId;
        const existing = runtime.findOrder(orderId);
        if (command.op === 'place' && existing !== undefined) {
            if (!sameOrder(existing, command.order)) {
                return reject(res, 409, 'Paper order ID conflict');
            }
            return actionResponse(res, 200, auth, runtime.state(), 'place', false, existing);
        }
        if (command.op === 'cancel' && existing === undefined) {
            return reject(res, 404, 'Paper order not found');
        }
        if (command.op === 'cancel' && existing!.status === 'cancelled') {
            return actionResponse(res, 200, auth, runtime.state(), 'cancel', false, existing!);
        }
        if (command.op === 'cancel'
            && (existing!.status === 'filled' || existing!.status === 'expired')) {
            return reject(res, 409, 'Paper order is terminal');
        }
        const state = runtime.state();
        const resync = exactResync(state, {
            epoch: command.epoch,
            cursor: command.cursor,
            fact: command.fact,
        });
        if (resync) return sendResync(res, auth, resync);
        if (state.busy || state.mutating || state.snapshot.status !== 'paused') {
            return reject(res, 409, 'Replay must be paused');
        }
        const order = command.op === 'place'
            ? runtime.place(command.order)
            : runtime.cancel(command.orderId);
        actionResponse(
            res,
            command.op === 'place' ? 201 : 200,
            auth,
            runtime.state(),
            command.op,
            true,
            order
        );
    });
};

const handleControl = async (
    runtime: ReplayRuntime,
    auth: ReplayApiAuth,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    mutate: MutationGate
): Promise<void> => {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return reject(res, 405, 'Method not allowed');
    }
    if (url.search) return reject(res, 400, 'Replay control query is invalid');
    const body = await readJson(req, res);
    if (body === undefined) return;
    const parsed = controlSchema.safeParse(body);
    if (!parsed.success) return reject(res, 400, 'Replay control is invalid');
    const command: ControlCommand = parsed.data;
    await mutate(res, async () => {
        const before = runtime.state();
        const requested = {
            epoch: command.epoch,
            cursor: command.cursor,
            fact: command.fact,
        };
        if (command.op === 'pause') {
            if (command.epoch !== before.snapshot.epoch) {
                const resync = exactResync(before, requested);
                if (resync) return sendResync(res, auth, resync);
            }
            if (before.mutating) {
                return reject(res, 409, 'Replay mutation is already active');
            }
            const applied = before.busy || before.snapshot.status === 'running';
            return controlResponse(
                res, 200, auth, command, applied, await runtime.pause()
            );
        }

        const resync = exactResync(before, requested);
        if (resync) return sendResync(res, auth, resync);
        if (before.busy || before.mutating) {
            return reject(res, 409, 'Replay must be paused');
        }

        if (command.op === 'play') {
            if (before.snapshot.status !== 'paused') {
                return reject(res, 409, 'Replay must be paused');
            }
            void runtime.play(command.speed);
            return controlResponse(res, 202, auth, command, true, runtime.state());
        }
        if (command.op === 'step') {
            if (before.snapshot.status !== 'paused'
                && before.snapshot.status !== 'complete') {
                return reject(res, 409, 'Replay cannot step');
            }
            const state = runtime.step();
            const applied = state.snapshot.cursor !== before.snapshot.cursor
                || state.paper.factCount !== before.paper.factCount;
            return controlResponse(res, 200, auth, command, applied, state);
        }
        if (command.target > before.snapshot.total) {
            return reject(res, 400, 'Replay seek cursor is outside the tape');
        }
        if (before.snapshot.status !== 'paused'
            && before.snapshot.status !== 'complete') {
            return reject(res, 409, 'Replay cannot seek');
        }
        if (command.target === before.snapshot.cursor) {
            return controlResponse(res, 200, auth, command, false, before);
        }
        controlResponse(
            res, 200, auth, command, true, await runtime.seek(command.target)
        );
    });
};

const handler = (
    runtime: ReplayRuntime,
    auth: ReplayApiAuth
): ((req: IncomingMessage, res: ServerResponse) => void) => {
    const base = `/api/replay/v1/runs/${auth.runId}`;
    let mutating = false;
    const mutate: MutationGate = async (res, task) => {
        if (mutating) return reject(res, 409, 'Replay mutation is already active');
        mutating = true;
        try {
            await task();
        } finally {
            mutating = false;
        }
    };
    return async (req, res) => {
        if (req.headers['x-fervor-mode'] !== replayApiMode) {
            return reject(res, 409, 'Historical replay mode required');
        }
        if (!hasToken(req, auth.tokenSha256)) {
            res.setHeader('WWW-Authenticate', 'Bearer realm="fervor-replay"');
            return reject(res, 401, 'Replay access token required');
        }
        let url: URL;
        try {
            url = new URL(req.url ?? '/', 'http://replay.invalid');
        } catch {
            return reject(res, 400, 'Invalid request URL');
        }
        try {
            if (url.pathname === `${base}/paper/actions`) {
                return handlePaperAction(runtime, auth, req, res, url, mutate);
            }
            if (url.pathname === `${base}/controls`) {
                return handleControl(runtime, auth, req, res, url, mutate);
            }
            if (req.method !== 'GET') {
                res.setHeader('Allow', 'GET');
                return reject(res, 405, 'Method not allowed');
            }
            if (mutating || runtime.state().mutating) {
                return reject(res, 409, 'Replay mutation is active');
            }
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
                if (query.epoch !== undefined && query.cursor !== undefined) {
                    const resync = exactResync(runtime.state(), {
                        epoch: query.epoch,
                        cursor: query.cursor,
                    });
                    if (resync) return sendResync(res, auth, resync);
                }
                const page = runtime.notifications(query.after, query.limit);
                return sendJson(res, 200, {
                    success: true,
                    ...responseBody(auth, pageIdentity(page), { page }),
                });
            }
            if (url.pathname === `${base}/deltas`) {
                const query = deltaQuery(url);
                if (!query) return reject(res, 400, 'Delta query is invalid');
                const result = runtime.deltas(query.epoch, query.after, query.limit);
                if (result.resync) return sendResync(res, auth, result.resync);
                return sendJson(res, 200, {
                    success: true,
                    ...responseBody(auth, deltaIdentity(result.page), { page: result.page }),
                });
            }
            if (url.pathname === `${base}/paper`) {
                const query = paperQuery(url);
                if (!query) return reject(res, 400, 'Paper query is invalid');
                const state = runtime.state();
                const resync = exactResync(state, {
                    epoch: query.epoch,
                    cursor: query.cursor,
                    fact: query.fact,
                });
                if (resync) return sendResync(res, auth, resync);
                const portfolio = runtime.portfolio();
                const orders = runtime.orders(query.orderAfter, query.limit);
                const facts = runtime.facts(query.factAfter, query.limit);
                const page = {
                    contract: replayPaperContract,
                    sourceReplaySha256: state.snapshot.sourceReplaySha256,
                    runId: state.snapshot.runId,
                    epoch: state.snapshot.epoch,
                    cutCursor: state.snapshot.cursor,
                    cutAt: state.snapshot.now,
                    fact: state.paper.factCount,
                    orders: offsetPage(query.orderAfter, portfolio.orderCount, orders),
                    facts: offsetPage(query.factAfter, portfolio.factCount, facts),
                    portfolio,
                };
                return sendJson(res, 200, {
                    success: true,
                    ...responseBody(auth, identityOf(state.snapshot), { page }),
                });
            }
            const walletPrefix = `${base}/wallets/`;
            if (url.pathname.startsWith(walletPrefix)) {
                const wallet = addressSchema.safeParse(url.pathname.slice(walletPrefix.length));
                const query = walletQuery(url);
                if (!wallet.success || !query || query.after > query.cursor) {
                    return reject(res, 400, 'Wallet query is invalid');
                }
                const state = runtime.state();
                const resync = exactResync(state, {
                    epoch: query.epoch,
                    cursor: query.cursor,
                });
                if (resync) return sendResync(res, auth, resync);
                const page = runtime.walletTrades(wallet.data, query.after, query.limit);
                const portfolio = runtime.walletPortfolio(wallet.data);
                return sendJson(res, 200, {
                    success: true,
                    ...responseBody(auth, pageIdentity(page), { page, portfolio }),
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
        await chmod(socketPath, 0o660);
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
