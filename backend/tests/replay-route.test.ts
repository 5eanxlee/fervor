import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/database', () => ({
    query: vi.fn(),
    transaction: vi.fn(),
}));

import { query } from '../src/config/database';
import { createReplayRouter } from '../src/routes/replay';
import type { ReplayGateway } from '../src/services/replay/replayGateway';

const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
const mockedQuery = vi.mocked(query);

const token = (userId = ownerId) => jwt.sign({
    userId,
    walletAddress: wallet,
    tokenType: 'user',
}, process.env.JWT_SECRET!, {
    algorithm: 'HS256',
    audience: 'fervor-web',
    issuer: 'fervor-api',
    expiresIn: '1h',
});

const user = (id = ownerId) => ({
    id,
    wallet_address: wallet,
    email: null,
    telegram_chat_id: null,
    discord_user_id: null,
    created_at: new Date(),
    updated_at: new Date(),
});

const appWith = (gateway: ReplayGateway) => {
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.use('/api/replay/v1', createReplayRouter(gateway));
    return app;
};

describe('replay host route', () => {
    beforeEach(() => mockedQuery.mockReset());

    it('authenticates the owner and forwards only normalized request data', async () => {
        mockedQuery.mockResolvedValueOnce({ rows: [user()] } as any);
        const call = vi.fn().mockResolvedValue({
            status: 200,
            body: { success: true, mode: 'historical_replay' },
        });
        const app = appWith({ enabled: true, ownerId, call });

        await request(app)
            .get('/api/replay/v1/deltas?epoch=1&after=0')
            .set('Authorization', `Bearer ${token()}`)
            .expect(200)
            .expect('Cache-Control', 'no-store');

        expect(call).toHaveBeenCalledWith({
            method: 'GET',
            resource: 'deltas',
            query: '?epoch=1&after=0',
        });
        expect(call.mock.calls[0][0]).not.toHaveProperty('headers');
    });

    it('passes action JSON but never the browser credential', async () => {
        mockedQuery.mockResolvedValueOnce({ rows: [user()] } as any);
        const call = vi.fn().mockResolvedValue({ status: 201, body: { success: true } });
        const app = appWith({ enabled: true, ownerId, call });
        const body = { contract: 'fervor-replay-paper-command-v1', op: 'cancel' };
        const userToken = token();

        await request(app)
            .post('/api/replay/v1/paper/actions')
            .set('Authorization', `Bearer ${userToken}`)
            .send(body)
            .expect(201);

        expect(call).toHaveBeenCalledWith({
            method: 'POST',
            resource: 'paper/actions',
            query: '',
            body,
        });
        expect(JSON.stringify(call.mock.calls[0][0])).not.toContain(userToken);
    });

    it('hides the configured run from other authenticated users', async () => {
        mockedQuery.mockResolvedValueOnce({ rows: [user(otherId)] } as any);
        const call = vi.fn();
        const app = appWith({ enabled: true, ownerId, call });

        await request(app)
            .get('/api/replay/v1/snapshot')
            .set('Authorization', `Bearer ${token(otherId)}`)
            .expect(404);
        expect(call).not.toHaveBeenCalled();
    });

    it('requires a Fervor user even when replay hosting is disabled', async () => {
        const call = vi.fn();
        const app = appWith({ enabled: false, call });
        await request(app).get('/api/replay/v1/snapshot').expect(401);
        expect(mockedQuery).not.toHaveBeenCalled();
        expect(call).not.toHaveBeenCalled();
    });
});
