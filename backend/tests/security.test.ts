import request from 'supertest';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/database', () => {
    const query = vi.fn();
    return {
        query,
        transaction: vi.fn(async (work) => work(query)),
    };
});

import app from '../src/index';
import { query } from '../src/config/database';
import { consumeAuthNonce, extractAuthMessageFields, hashSecret } from '../src/services/authSecurity';
import { parseEnv } from '../src/config/env';

const mockedQuery = vi.mocked(query);

const authToken = (payload: Record<string, unknown>) =>
    jwt.sign(payload, process.env.JWT_SECRET!, {
        algorithm: 'HS256', audience: 'fervor-web', issuer: 'fervor-api', expiresIn: '7d',
    });

const testUser = {
    id: 'user-1',
    wallet_address: '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE',
    email: null,
    telegram_chat_id: null,
    discord_user_id: null,
    created_at: new Date(),
    updated_at: new Date(),
};

describe('security hardening', () => {
    beforeEach(() => {
        mockedQuery.mockReset();
    });

    it('rejects missing or placeholder secrets during config parsing', () => {
        expect(() => parseEnv({
            NODE_ENV: 'production',
            CORE_DATABASE_URL: 'postgres://core/fervor',
            MARKET_DATABASE_URL: 'postgres://market/fervor',
            JWT_SECRET: 'your-secret-key',
        } as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET/);

        expect(() => parseEnv({
            NODE_ENV: 'production',
            CORE_DATABASE_URL: 'postgres://core/fervor',
            MARKET_DATABASE_URL: 'postgres://market/fervor',
        } as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET/);
    });

    it('returns 404 for removed Discord debug endpoints', async () => {
        await request(app).get('/api/auth/fix-orphaned-discord').expect(404);
        await request(app).get('/api/auth/debug-discord-alerts').expect(404);
    });

    it('only queries alerts owned by the authenticated user', async () => {
        mockedQuery
            .mockResolvedValueOnce({ rows: [testUser] } as any)
            .mockResolvedValueOnce({ rows: [] } as any);

        const token = authToken({
            userId: testUser.id,
            walletAddress: testUser.wallet_address,
            tokenType: 'user',
        });

        await request(app)
            .get('/api/alerts')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        const [sql, params] = mockedQuery.mock.calls[1];
        expect(sql).toContain('WHERE ta.user_id = $1');
        expect(sql).not.toContain("ta.notification_type = 'discord'");
        expect(params).toEqual([testUser.id, null, 51]);
    });

    it('requires one-time nonces to be unused and unexpired for the requested wallet', async () => {
        mockedQuery.mockResolvedValueOnce({ rows: [] } as any);
        await expect(consumeAuthNonce(testUser.wallet_address, 'a'.repeat(48))).resolves.toBe(false);

        const [sql, params] = mockedQuery.mock.calls[0];
        expect(sql).toContain('wallet_address = $1');
        expect(sql).toContain('used = FALSE');
        expect(sql).toContain('expires_at > NOW()');
        expect(params?.[0]).toBe(testUser.wallet_address);
        expect(params?.[1]).toBe(hashSecret('a'.repeat(48)));
    });

    it('extracts wallet and nonce from auth messages and rejects malformed messages', () => {
        const message = `Sign this message to authenticate with Fervor.

Wallet: ${testUser.wallet_address}
Nonce: ${'b'.repeat(48)}
Timestamp: 2026-04-27T00:00:00.000Z

This request will not trigger a blockchain transaction or cost any gas fees.`;

        expect(extractAuthMessageFields(message)).toEqual({
            walletAddress: testUser.wallet_address,
            nonce: 'b'.repeat(48),
        });
        expect(extractAuthMessageFields('Nonce: nope')).toBeNull();
    });

    it('removes stale extension linking endpoints', async () => {
        await request(app).post('/api/auth/extension/generate-link-token').expect(404);
        await request(app).get('/api/auth/extension/token-info/example').expect(404);
        await request(app).post('/api/auth/extension/link-with-token').expect(404);
    });

    it('does not expose an HTTP endpoint for bot-originated linking', async () => {
        await request(app)
            .post('/api/auth/discord/generate-link-token')
            .send({ discordUserId: '123456789' })
            .expect(404);

        await request(app)
            .post('/api/auth/telegram/link-token')
            .expect(401);

        expect(() => parseEnv({
            NODE_ENV: 'production',
            CORE_DATABASE_URL: 'postgres://core/fervor',
            MARKET_DATABASE_URL: 'postgres://market/fervor',
            JWT_SECRET: 'a'.repeat(64),
            BOT_GATEWAY_ENABLED: 'true',
        } as NodeJS.ProcessEnv)).toThrow(/configured Telegram or Discord integration/);
    });

    it('rejects non-user JWT types before database access', async () => {
        const token = authToken({
            userId: testUser.id,
            walletAddress: testUser.wallet_address,
            tokenType: 'extension',
            sessionId: 'session-1',
        });

        await request(app)
            .get('/api/auth/me')
            .set('Authorization', `Bearer ${token}`)
            .expect(403);
        expect(mockedQuery).not.toHaveBeenCalled();
    });

    it('rejects tokens outside the Fervor issuer and audience contract', async () => {
        const token = jwt.sign({
            userId: testUser.id,
            walletAddress: testUser.wallet_address,
            tokenType: 'user',
        }, process.env.JWT_SECRET!, {
            algorithm: 'HS256',
            expiresIn: '7d',
        });

        await request(app)
            .get('/api/auth/me')
            .set('Authorization', `Bearer ${token}`)
            .expect(403);
        expect(mockedQuery).not.toHaveBeenCalled();
    });
});
