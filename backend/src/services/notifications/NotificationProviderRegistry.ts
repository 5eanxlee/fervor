import { env } from '../../config/env';
import { thresholdIsUsd, thresholdLabel } from '../../types';
import { AlertNotificationPayload, NotificationChannel, NotificationProvider, ProviderSendResult } from './types';

interface ProviderResponse {
    body: Record<string, any>;
    headers: Headers;
}

class ProviderHttpError extends Error {
    constructor(
        readonly status: number,
        readonly body: Record<string, any>,
        readonly headers: Headers
    ) {
        super(typeof body.description === 'string'
            ? body.description
            : typeof body.message === 'string'
                ? body.message
                : `Provider returned HTTP ${status}`);
    }
}

const alertText = (payload: AlertNotificationPayload): string => {
    const alert = payload.alert;
    const label = thresholdLabel(alert.threshold_type);
    const format = (value: number): string => thresholdIsUsd(alert.threshold_type)
        ? `$${value.toLocaleString()}`
        : value.toLocaleString();
    return [
        `${alert.token_symbol || 'Token'} alert`,
        `${label}: ${format(payload.currentValue)}`,
        `Target: ${alert.condition} ${format(Number(alert.threshold_value))}`,
        alert.token_address,
        new Date(payload.triggeredAt).toISOString(),
    ].join('\n');
};

const requestJson = async (url: string, init: RequestInit): Promise<ProviderResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    timer.unref?.();
    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const body = await response.json().catch(() => ({})) as Record<string, any>;
        if (!response.ok) throw new ProviderHttpError(response.status, body, response.headers);
        return { body, headers: response.headers };
    } finally {
        clearTimeout(timer);
    }
};

const secondsMs = (value: unknown): number | undefined => {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
};

const retryHeaderMs = (headers: Headers): number | undefined => {
    const raw = headers.get('retry-after');
    if (raw) {
        const seconds = secondsMs(raw);
        if (seconds) return seconds;
        const date = Date.parse(raw);
        if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    }
    return secondsMs(headers.get('x-ratelimit-reset-after'));
};

const nextRateMs = (headers: Headers): number | undefined =>
    headers.get('x-ratelimit-remaining') === '0'
        ? retryHeaderMs(headers)
        : undefined;

const errorResult = (
    error: unknown,
    provider: 'telegram' | 'discord',
    rateRoute?: string
): ProviderSendResult => {
    if (!(error instanceof ProviderHttpError)) {
        return {
            kind: 'retryable_failure',
            errorCode: error instanceof Error ? error.name : 'network_error',
            errorMessage: error instanceof Error ? error.message : String(error),
            effect: provider === 'discord' ? 'none' : 'unknown',
            rateRoute,
        };
    }

    const bodyDelay = provider === 'telegram'
        ? secondsMs(error.body.parameters?.retry_after)
        : secondsMs(error.body.retry_after);
    const retryAfterMs = bodyDelay || retryHeaderMs(error.headers);
    const retryable = error.status === 408
        || error.status === 425
        || error.status === 429
        || error.status >= 500;
    const metadata = {
        status: error.status,
        code: error.body.error_code || error.body.code,
        rateBucket: error.headers.get('x-ratelimit-bucket') || undefined,
        rateScope: error.headers.get('x-ratelimit-scope') || undefined,
        rateRoute,
    };
    if (retryable) {
        return {
            kind: 'retryable_failure',
            errorCode: String(error.body.error_code || error.body.code || error.status),
            errorMessage: error.message,
            retryAfterMs,
            rateScope: error.body.global === true || error.headers.get('x-ratelimit-scope') === 'global'
                ? 'global'
                : 'recipient',
            rateBucket: error.headers.get('x-ratelimit-bucket') || undefined,
            rateRoute,
            effect: provider === 'discord' || error.status === 425 || error.status === 429 ? 'none' : 'unknown',
            metadata,
        };
    }
    return {
        kind: 'permanent_failure',
        errorCode: String(error.body.error_code || error.body.code || error.status),
        errorMessage: error.message,
        metadata,
    };
};

class TelegramNotificationProvider implements NotificationProvider {
    channel = 'telegram' as const;
    providerName = 'telegram';

    isConfigured(): boolean {
        return env.ENABLE_TELEGRAM_NOTIFICATIONS && !!env.TELEGRAM_BOT_TOKEN;
    }

    async send(input: Parameters<NotificationProvider['send']>[0]): Promise<ProviderSendResult> {
        if (!this.isConfigured()) {
            return { kind: 'permanent_failure', errorCode: 'telegram_not_configured', errorMessage: 'Telegram bot is not configured' };
        }
        try {
            const response = await requestJson(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: input.recipient, text: alertText(input.payload).slice(0, 4_096) }),
            });
            const messageId = response.body.result?.message_id;
            return {
                kind: 'accepted',
                providerStatus: 'sent',
                providerMessageId: messageId === undefined ? undefined : String(messageId),
            };
        } catch (error) {
            return errorResult(error, 'telegram', 'send_message');
        }
    }
}

class DiscordNotificationProvider implements NotificationProvider {
    channel = 'discord' as const;
    providerName = 'discord';

    isConfigured(): boolean {
        return env.ENABLE_DISCORD_NOTIFICATIONS && !!env.DISCORD_BOT_TOKEN;
    }

    async send(input: Parameters<NotificationProvider['send']>[0]): Promise<ProviderSendResult> {
        if (!this.isConfigured()) {
            return { kind: 'permanent_failure', errorCode: 'discord_not_configured', errorMessage: 'Discord bot is not configured' };
        }
        let rateRoute = 'create_dm';
        try {
            const headers = {
                Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
                'Content-Type': 'application/json',
                'User-Agent': 'DiscordBot (https://fervor.xyz, 1.0.0)',
            };
            const channel = await requestJson('https://discord.com/api/v10/users/@me/channels', {
                method: 'POST', headers, body: JSON.stringify({ recipient_id: input.recipient }),
            });
            if (typeof channel.body.id !== 'string') throw new Error('Discord did not return a DM channel');
            rateRoute = 'send_dm';
            const message = await requestJson(`https://discord.com/api/v10/channels/${channel.body.id}/messages`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    content: alertText(input.payload).slice(0, 1_900),
                    nonce: input.requestKey.slice(0, 25),
                    enforce_nonce: true,
                    allowed_mentions: { parse: [] },
                }),
            });
            const rateBucket = message.headers.get('x-ratelimit-bucket') || undefined;
            return {
                kind: 'accepted',
                providerStatus: 'sent',
                providerMessageId: typeof message.body.id === 'string' ? message.body.id : undefined,
                rateDelayMs: nextRateMs(message.headers),
                rateScope: 'recipient',
                rateBucket,
                rateRoute,
                metadata: { rateBucket, rateRoute, channelId: channel.body.id },
            };
        } catch (error) {
            return errorResult(error, 'discord', rateRoute);
        }
    }
}

export class NotificationProviderRegistry {
    private readonly providers = new Map<NotificationChannel, NotificationProvider>([
        ['telegram', new TelegramNotificationProvider()],
        ['discord', new DiscordNotificationProvider()],
    ]);

    get(channel: NotificationChannel): NotificationProvider | null {
        return this.providers.get(channel) || null;
    }
}

export const notificationProviderRegistry = new NotificationProviderRegistry();
