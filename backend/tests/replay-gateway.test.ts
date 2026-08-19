import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import {
    createReplayGateway,
    ReplayGatewayError,
} from '../src/services/replay/replayGateway';
import {
    replayApiAuthContract,
    replayApiContract,
    replayApiMode,
    replayApiSessionId,
} from '../src/services/replay/replayApi';

const token = 'replay-gateway-test-token-1234567890abcdef';
const sourceSha = 'a'.repeat(64);
const runId = 'gateway-run';
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) =>
        server.close(() => resolve()))));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const listen = (server: Server, socket: string): Promise<void> =>
    new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socket, () => resolve());
    });

const harness = async (
    handler: Parameters<typeof createServer>[0],
    suppliedToken = token,
    maxBytes = 2_097_152,
    timeoutMs = 1_000,
    userId: string | null = ownerId
) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fervor-replay-gateway-'));
    tempDirs.push(root);
    const socket = path.join(root, 'replay.sock');
    const authFile = path.join(root, 'auth.json');
    const tokenFile = path.join(root, 'token');
    await writeFile(authFile, JSON.stringify({
        contract: replayApiAuthContract,
        sourceReplaySha256: sourceSha,
        runId,
        tokenSha256: createHash('sha256').update(token).digest('hex'),
    }));
    await writeFile(tokenFile, `${suppliedToken}\n`);
    const server = createServer(handler);
    servers.push(server);
    await listen(server, socket);
    return createReplayGateway({
        REPLAY_API_SOCKET: socket,
        REPLAY_API_AUTH_FILE: authFile,
        REPLAY_API_TOKEN_FILE: tokenFile,
        REPLAY_API_USER_ID: userId ?? undefined,
        REPLAY_API_TIMEOUT_MS: timeoutMs,
        REPLAY_API_MAX_BYTES: maxBytes,
    });
};

const auth = {
    contract: replayApiAuthContract,
    sourceReplaySha256: sourceSha,
    runId,
    tokenSha256: createHash('sha256').update(token).digest('hex'),
} as const;

const envelope = (sourceReplaySha256 = sourceSha) => ({
    success: true,
    contract: replayApiContract,
    mode: replayApiMode,
    session: {
        id: replayApiSessionId(auth),
        sourceReplaySha256,
        runId,
        epoch: 1,
        cursor: 0,
        now: null,
    },
    data: { state: {} },
});

describe('replay host gateway', () => {
    it('maps one fixed run and injects only its file-backed credential', async () => {
        let observed: { path?: string; authorization?: string; mode?: string } = {};
        const gateway = await harness((req, res) => {
            observed = {
                path: req.url,
                authorization: req.headers.authorization,
                mode: req.headers['x-fervor-mode'] as string,
            };
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(envelope()));
        });

        await expect(gateway.call({
            method: 'GET',
            resource: 'deltas',
            query: '?epoch=1&after=0&limit=10',
        })).resolves.toMatchObject({ status: 200, body: { mode: replayApiMode } });
        expect(gateway.ownerId).toBe(ownerId);
        expect(observed).toEqual({
            path: `/api/replay/v1/runs/${runId}/deltas?epoch=1&after=0&limit=10`,
            authorization: `Bearer ${token}`,
            mode: replayApiMode,
        });
    });

    it('supports an authenticated shared lab without weakening upstream credentials', async () => {
        const gateway = await harness(
            (_req, res) => res.end(JSON.stringify(envelope())),
            token,
            2_097_152,
            1_000,
            null
        );

        expect(gateway.enabled).toBe(true);
        expect(gateway.ownerId).toBeUndefined();
        await expect(gateway.call({ method: 'GET', resource: 'snapshot' }))
            .resolves.toMatchObject({ status: 200, body: { mode: replayApiMode } });
    });

    it('rejects route escape, credential drift, and response identity drift', async () => {
        const good = await harness((_req, res) => res.end(JSON.stringify(envelope())));
        await expect(good.call({
            method: 'GET',
            resource: 'wallets/../controls',
        })).rejects.toMatchObject({ code: 'invalid_request', status: 400 });

        const badToken = await harness(
            (_req, res) => res.end(JSON.stringify(envelope())),
            'other-replay-token-1234567890abcdefgh'
        );
        await expect(badToken.call({ method: 'GET', resource: 'snapshot' }))
            .rejects.toMatchObject({ code: 'credential_invalid', status: 503 });

        const wrongRun = await harness((_req, res) =>
            res.end(JSON.stringify(envelope('c'.repeat(64)))));
        await expect(wrongRun.call({ method: 'GET', resource: 'snapshot' }))
            .rejects.toMatchObject({ code: 'invalid_response', status: 502 });
    });

    it('bounds upstream time and bytes without exposing transport errors', async () => {
        const tooLarge = await harness((_req, res) => {
            res.setHeader('Content-Length', '20000');
            res.end('{}');
        }, token, 16_384);
        await expect(tooLarge.call({ method: 'GET', resource: 'snapshot' }))
            .rejects.toMatchObject({ code: 'invalid_response', status: 502 });

        const stalled = await harness(() => undefined, token, 16_384, 100);
        await expect(stalled.call({ method: 'GET', resource: 'snapshot' }))
            .rejects.toMatchObject({ code: 'unavailable', status: 503, retryable: true });
    });

    it('fails closed on partial or relative host configuration', () => {
        const base = {
            NODE_ENV: 'test',
            DATABASE_URL: 'postgres://db/fervor',
            DB_COLOCATED: 'true',
            JWT_SECRET: 'a'.repeat(64),
        } as NodeJS.ProcessEnv;
        expect(() => parseEnv({ ...base, REPLAY_API_SOCKET: '/run/replay.sock' }))
            .toThrow(/configured together/);
        expect(() => parseEnv({ ...base, REPLAY_API_USER_ID: ownerId }))
            .toThrow(/configured together/);
        expect(parseEnv({
            ...base,
            REPLAY_API_SOCKET: '/run/replay.sock',
            REPLAY_API_AUTH_FILE: '/run/auth.json',
            REPLAY_API_TOKEN_FILE: '/run/token',
            REPLAY_API_USER_ID: '',
        }).REPLAY_API_USER_ID).toBeUndefined();
        expect(() => parseEnv({
            ...base,
            REPLAY_API_SOCKET: 'replay.sock',
            REPLAY_API_AUTH_FILE: '/run/auth.json',
            REPLAY_API_TOKEN_FILE: '/run/token',
            REPLAY_API_USER_ID: ownerId,
        })).toThrow(/Path must be absolute/);
    });

    it('returns a typed disabled capability without touching the filesystem', async () => {
        const gateway = createReplayGateway({
            REPLAY_API_TIMEOUT_MS: 1_000,
            REPLAY_API_MAX_BYTES: 16_384,
        });
        expect(gateway.enabled).toBe(false);
        await expect(gateway.call({ method: 'GET', resource: 'snapshot' }))
            .rejects.toEqual(expect.objectContaining<Partial<ReplayGatewayError>>({
                code: 'not_configured',
                status: 503,
            }));
    });
});
