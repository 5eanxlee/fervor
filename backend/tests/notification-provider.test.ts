import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NotificationProviderRegistry as Registry } from '../src/services/notifications/NotificationProviderRegistry';
import type { NotificationSendInput } from '../src/services/notifications/types';

const input: NotificationSendInput = {
    deliveryId: 'delivery-1',
    alertEventId: 'event-1',
    alertId: 'alert-1',
    userId: 'user-1',
    recipient: 'recipient-1',
    recipientHash: 'hash-1',
    payload: {
        alert: {
            id: 'alert-1',
            user_id: 'user-1',
            token_address: 'So11111111111111111111111111111111111111112',
            token_symbol: 'SOL',
            threshold_type: 'price',
            threshold_value: 100,
            condition: 'above',
            notification_type: 'telegram',
            is_active: false,
            is_triggered: true,
            generation: 1,
            created_at: new Date(),
            updated_at: new Date(),
        },
        currentValue: 101,
        triggeredAt: '2026-08-03T00:00:00.000Z',
    },
    idempotencyKey: 'event-1:telegram',
    requestKey: 'a'.repeat(64),
    locale: 'en',
    timezone: 'UTC',
};

describe('direct notification providers', () => {
    let registry: Registry;

    beforeAll(async () => {
        process.env.ENABLE_TELEGRAM_NOTIFICATIONS = 'true';
        process.env.TELEGRAM_BOT_TOKEN = 'valid-telegram-token';
        process.env.ENABLE_DISCORD_NOTIFICATIONS = 'true';
        process.env.DISCORD_BOT_TOKEN = 'valid-discord-token';
        const module = await import('../src/services/notifications/NotificationProviderRegistry');
        registry = new module.NotificationProviderRegistry();
    });

    afterAll(() => {
        vi.unstubAllGlobals();
    });

    it('honors Telegram retry_after response parameters', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 2 },
        }), { status: 429, headers: { 'Content-Type': 'application/json' } })));

        const result = await registry.get('telegram')!.send(input);
        expect(result).toMatchObject({
            kind: 'retryable_failure',
            errorCode: '429',
            retryAfterMs: 2_000,
            rateScope: 'recipient',
        });
    });

    it('treats Discord authorization and permission errors as terminal', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            message: 'Cannot send messages to this user',
            code: 50007,
        }), { status: 403, headers: { 'Content-Type': 'application/json' } })));

        const result = await registry.get('discord')!.send({
            ...input,
            payload: {
                ...input.payload,
                alert: { ...input.payload.alert, notification_type: 'discord' },
            },
        });
        expect(result).toMatchObject({
            kind: 'permanent_failure',
            errorCode: '50007',
        });
    });

    it('deduplicates ambiguous Discord retries with an enforced logical-delivery nonce', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'dm-channel-1' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'message-1' }), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'X-RateLimit-Bucket': 'bucket-1',
                    'X-RateLimit-Remaining': '0',
                    'X-RateLimit-Reset-After': '1.5',
                },
            }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await registry.get('discord')!.send({
            ...input,
            payload: {
                ...input.payload,
                alert: { ...input.payload.alert, notification_type: 'discord' },
            },
        });
        const body = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(body).toMatchObject({
            nonce: input.requestKey.slice(0, 25),
            enforce_nonce: true,
            allowed_mentions: { parse: [] },
        });
        expect(result).toMatchObject({
            kind: 'accepted',
            providerMessageId: 'message-1',
            rateDelayMs: 1_500,
            rateBucket: 'bucket-1',
            rateRoute: 'send_dm',
        });
    });

    it('records network failures as ambiguous provider effects', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('socket closed')));
        const result = await registry.get('telegram')!.send(input);
        expect(result).toMatchObject({
            kind: 'retryable_failure',
            effect: 'unknown',
            rateRoute: 'send_message',
        });
    });

    it('marks Discord network failures retry-safe because the request nonce is enforced', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('socket closed')));
        const result = await registry.get('discord')!.send({
            ...input,
            payload: {
                ...input.payload,
                alert: { ...input.payload.alert, notification_type: 'discord' },
            },
        });
        expect(result).toMatchObject({
            kind: 'retryable_failure',
            effect: 'none',
            rateRoute: 'create_dm',
        });
    });
});
