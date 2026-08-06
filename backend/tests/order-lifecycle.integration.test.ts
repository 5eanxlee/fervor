import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_INFRA_TESTS === 'true';
const suite = enabled ? describe : describe.skip;

suite('order lifecycle infrastructure', () => {
    let query: any;
    let service: any;
    let userId = '';
    let orderId = '';
    const marker = crypto.randomBytes(8).toString('hex');
    const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
    const sol = 'So11111111111111111111111111111111111111112';
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    beforeAll(async () => {
        const databaseUrl = process.env.INFRA_DATABASE_URL
            ?? 'postgresql://fervor@localhost:55432/fervor';
        process.env.DATABASE_URL = databaseUrl;
        process.env.CORE_DATABASE_URL = databaseUrl;
        process.env.MARKET_DATABASE_URL = databaseUrl;
        process.env.DB_COLOCATED = 'true';
        process.env.ORDER_MODE = 'fixture';
        ({ query } = await import('../src/config/database'));
        const { OrderService } = await import('../src/services/orders/orderService');
        const { FixtureOrderProvider } = await import('../src/services/orders/fixtureOrderProvider');
        service = new OrderService(new FixtureOrderProvider(), query);
        const user = await query(
            'INSERT INTO users (wallet_address) VALUES ($1) RETURNING id',
            [`OrderWallet${marker}`]
        );
        userId = user.rows[0].id;
    });

    afterAll(async () => {
        if (orderId) await query('DELETE FROM event_outbox WHERE event_key LIKE $1', [`order:${orderId}:%`]);
        if (userId) await query('DELETE FROM users WHERE id = $1', [userId]);
    });

    it('persists an idempotent prepare, activation, edit, and two-step cancellation', async () => {
        const request = {
            orderType: 'single' as const,
            walletAddress: wallet,
            inputMint: sol,
            outputMint: usdc,
            inputAmount: '1000000000',
            triggerMint: sol,
            triggerCondition: 'above' as const,
            triggerPriceUsd: 250,
            slippageBps: 100,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            clientOrderId: `infra-${marker}-order`,
        };

        const prepared = await service.prepare(userId, request);
        orderId = prepared.orderId;
        const replayed = await service.prepare(userId, request);
        expect(replayed).toEqual(prepared);

        const open = await service.activate(userId, prepared.orderId, prepared.transaction);
        expect(open.state).toBe('open');
        await expect(service.activate(userId, prepared.orderId, prepared.transaction)).resolves.toMatchObject({
            id: prepared.orderId,
            state: 'open',
        });

        const updated = await service.update(userId, prepared.orderId, {
            orderType: 'single', triggerPriceUsd: 275,
        });
        expect(updated.params).toMatchObject({ triggerPriceUsd: 275 });

        const cancellation = await service.cancel(userId, prepared.orderId);
        await expect(service.cancel(userId, prepared.orderId)).resolves.toEqual(cancellation);
        const cancelled = await service.confirmCancel(
            userId,
            prepared.orderId,
            cancellation.requestId,
            cancellation.transaction
        );
        expect(cancelled.state).toBe('cancelled');

        const durable = await query(
            `SELECT state, op_token, op_lease_until, op_kind, op_state, op_req_hash,
                    op_want_hash, op_detail, op_started_at, unknown_at, unknown_detail,
                    op_writer, op_ver,
                    (SELECT COUNT(*)::int FROM order_events WHERE order_id = order_intents.id) AS event_count
             FROM order_intents WHERE id = $1`,
            [prepared.orderId]
        );
        expect(durable.rows[0]).toMatchObject({
            state: 'cancelled',
            op_token: null,
            op_lease_until: null,
            op_kind: null,
            op_state: null,
            op_req_hash: null,
            op_want_hash: null,
            op_detail: null,
            op_started_at: null,
            unknown_at: null,
            unknown_detail: null,
            op_writer: null,
            op_ver: '5',
            event_count: 5,
        });
        const outbox = await query(
            'SELECT COUNT(*)::int AS count FROM event_outbox WHERE event_key LIKE $1',
            [`order:${prepared.orderId}:%`]
        );
        expect(outbox.rows[0].count).toBe(5);
    });
});
