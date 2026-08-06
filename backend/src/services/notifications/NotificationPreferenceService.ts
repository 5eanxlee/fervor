import { query } from '../../config/database';
import { redisStreams } from '../redisStreamService';
import { ChannelPreferenceResolution, NotificationChannel } from './types';
import { recipientHash } from './utils';

const cacheTtlSec = 300;

export interface NotificationPreferencesView {
    channels: {
        telegram: { enabled: boolean; linked: boolean };
        discord: { enabled: boolean; linked: boolean };
    };
}

export class NotificationPreferenceService {
    private cacheKey(userId: string): string {
        return `notification_pref:${userId}`;
    }

    async invalidate(userId: string): Promise<void> {
        try {
            await redisStreams.command.del(this.cacheKey(userId));
        } catch {
            // Cache is best-effort; Postgres remains authoritative.
        }
    }

    async ensureDefaults(userId: string): Promise<void> {
        await query(
            `INSERT INTO user_notification_preferences (user_id, channel, enabled, alert_notifications_enabled)
             VALUES
               ($1, 'telegram', TRUE, TRUE),
               ($1, 'discord', TRUE, TRUE)
             ON CONFLICT (user_id, channel) DO NOTHING`,
            [userId]
        );
    }

    async getPreferences(userId: string): Promise<NotificationPreferencesView> {
        await this.ensureDefaults(userId);
        const cached = await this.getCached(userId);
        if (cached) return cached;

        const [prefResult, userResult] = await Promise.all([
            query(
                `SELECT channel, enabled
                 FROM user_notification_preferences
                 WHERE user_id = $1 AND channel IN ('telegram', 'discord')`,
                [userId]
            ),
            query('SELECT telegram_chat_id, discord_user_id FROM users WHERE id = $1', [userId]),
        ]);
        const prefs = new Map(prefResult.rows.map((row) => [row.channel, row]));
        const user = userResult.rows[0] || {};
        const view: NotificationPreferencesView = {
            channels: {
                telegram: {
                    enabled: Boolean(prefs.get('telegram')?.enabled && user.telegram_chat_id),
                    linked: Boolean(user.telegram_chat_id),
                },
                discord: {
                    enabled: Boolean(prefs.get('discord')?.enabled && user.discord_user_id),
                    linked: Boolean(user.discord_user_id),
                },
            },
        };
        await this.setCached(userId, view);
        return view;
    }

    async resolveChannel(userId: string, channel: NotificationChannel): Promise<ChannelPreferenceResolution> {
        await this.ensureDefaults(userId);
        const column = channel === 'telegram' ? 'telegram_chat_id' : 'discord_user_id';
        const result = await query(
            `SELECT u.${column} AS recipient, pref.enabled, pref.locale, pref.timezone
             FROM users u
             LEFT JOIN user_notification_preferences pref
               ON pref.user_id = u.id AND pref.channel = $2
             WHERE u.id = $1`,
            [userId, channel]
        );
        const row = result.rows[0];
        const recipient = row?.recipient || undefined;
        return {
            channel,
            enabled: Boolean(row?.enabled && recipient),
            verified: Boolean(recipient),
            suppressed: false,
            recipient,
            recipientHash: recipient ? recipientHash(recipient) : undefined,
            locale: row?.locale || 'en',
            timezone: row?.timezone || 'UTC',
            reason: recipient ? undefined : `${channel === 'telegram' ? 'Telegram' : 'Discord'} not linked`,
        };
    }

    private async getCached(userId: string): Promise<NotificationPreferencesView | null> {
        try {
            const raw = await redisStreams.command.get(this.cacheKey(userId));
            return raw ? JSON.parse(raw) as NotificationPreferencesView : null;
        } catch {
            return null;
        }
    }

    private async setCached(userId: string, value: NotificationPreferencesView): Promise<void> {
        try {
            await redisStreams.command.set(this.cacheKey(userId), JSON.stringify(value), 'EX', cacheTtlSec);
        } catch {
            // Cache is best-effort only.
        }
    }
}

export const notificationPreferenceService = new NotificationPreferenceService();
