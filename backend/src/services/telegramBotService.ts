import { transaction } from '../config/database';
import { env } from '../config/env';
import { hashSecret } from './authSecurity';
import { notificationPreferenceService } from './notifications/NotificationPreferenceService';
import { TelegramClient, TelegramMessage } from './telegramClient';

const token = env.TELEGRAM_BOT_TOKEN || '';
const linkPattern = /^[a-f0-9]{64}$/;

export class TelegramBotService {
    private static instance: TelegramBotService | null = null;
    private readonly bot: TelegramClient;
    private running = false;
    private handlersReady = false;

    private constructor() {
        if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
        this.bot = new TelegramClient(token);
    }

    static getInstance(): TelegramBotService {
        if (!TelegramBotService.instance) TelegramBotService.instance = new TelegramBotService();
        return TelegramBotService.instance;
    }

    static isConfigured(): boolean {
        return env.ENABLE_TELEGRAM_NOTIFICATIONS && Boolean(token);
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.configureHandlers();
        await this.bot.setMyCommands([
            { command: 'start', description: 'Link Fervor to your wallet' },
            { command: 'help', description: 'Show linking help' },
        ]);
        this.bot.startPolling();
        this.running = true;
        console.log('[telegram-gateway] Started');
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.bot.stopPolling();
        this.running = false;
        console.log('[telegram-gateway] Stopped');
    }

    isRunningBot(): boolean {
        return this.running;
    }

    private configureHandlers(): void {
        if (this.handlersReady) return;
        this.handlersReady = true;
        this.bot.on('polling_error', (error) => {
            console.error('[telegram-gateway] Polling failed', error?.message || error);
        });
        this.bot.onText(/^\/start(?:\s+([^\s]+))?\s*$/i, async (message, match) => {
            const linkToken = match?.[1];
            if (!linkToken) return this.sendHelp(message);
            await this.linkWallet(message, linkToken);
        });
        this.bot.onText(/^\/help\s*$/i, (message) => this.sendHelp(message));
    }

    private async linkWallet(message: TelegramMessage, linkToken: string): Promise<void> {
        const chatId = String(message.chat.id);
        if (!linkPattern.test(linkToken)) {
            await this.bot.sendMessage(chatId, 'Invalid link. Generate a new Telegram link from Fervor Settings > Integrations.');
            return;
        }

        const tokenHash = hashSecret(linkToken);
        const outcome = await transaction(async (db) => {
            const tokenResult = await db(
                `SELECT link.user_id, user_account.wallet_address, user_account.telegram_chat_id
                 FROM telegram_link_tokens link
                 JOIN users user_account ON user_account.id = link.user_id
                 WHERE link.token_hash = $1 AND link.used = FALSE AND link.expires_at > NOW()
                 FOR UPDATE OF link`,
                [tokenHash]
            );
            const linkedUser = tokenResult.rows[0];
            if (!linkedUser) return { status: 'invalid' as const };
            if (linkedUser.telegram_chat_id && String(linkedUser.telegram_chat_id) !== chatId) {
                return { status: 'wallet_conflict' as const };
            }
            const conflict = await db(
                'SELECT 1 FROM users WHERE telegram_chat_id = $1 AND id <> $2',
                [chatId, linkedUser.user_id]
            );
            if (conflict.rows.length > 0) return { status: 'chat_conflict' as const };

            await db(
                'UPDATE users SET telegram_chat_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [chatId, linkedUser.user_id]
            );
            await db(
                `INSERT INTO user_notification_preferences (user_id, channel, enabled, alert_notifications_enabled)
                 VALUES ($1, 'telegram', TRUE, TRUE)
                 ON CONFLICT (user_id, channel) DO UPDATE SET
                    enabled = TRUE,
                    alert_notifications_enabled = TRUE,
                    updated_at = CURRENT_TIMESTAMP`,
                [linkedUser.user_id]
            );
            await db(
                `UPDATE telegram_link_tokens
                 SET used = TRUE, used_at = CURRENT_TIMESTAMP, chat_id = $1
                 WHERE token_hash = $2`,
                [chatId, tokenHash]
            );
            return {
                status: 'linked' as const,
                userId: linkedUser.user_id as string,
                wallet: linkedUser.wallet_address as string,
            };
        });
        if (outcome.status === 'invalid') {
            await this.bot.sendMessage(chatId, 'This link is invalid, expired, or already used. Generate a new one in Fervor.');
            return;
        }
        if (outcome.status === 'wallet_conflict') {
            await this.bot.sendMessage(chatId, 'This wallet is already linked to another Telegram account.');
            return;
        }
        if (outcome.status === 'chat_conflict') {
            await this.bot.sendMessage(chatId, 'This Telegram account is already linked to another wallet.');
            return;
        }
        await notificationPreferenceService.invalidate(outcome.userId);
        await this.bot.sendMessage(chatId, `Linked to ${outcome.wallet.slice(0, 6)}...${outcome.wallet.slice(-6)}. Alerts configured in Fervor will be delivered here.`);
    }

    private async sendHelp(message: TelegramMessage): Promise<void> {
        await this.bot.sendMessage(
            String(message.chat.id),
            'Use the Telegram link in Fervor Settings > Integrations. Trading alerts are created and managed in Fervor.'
        );
    }
}
