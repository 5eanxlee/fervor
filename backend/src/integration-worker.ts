import { env } from './config/env';
import { DiscordBotService } from './services/discordBotService';
import { TelegramBotService } from './services/telegramBotService';
import { closeRuntime } from './runtime';

const telegram = env.BOT_GATEWAY_ENABLED && TelegramBotService.isConfigured()
    ? TelegramBotService.getInstance()
    : null;
const discord = env.BOT_GATEWAY_ENABLED && DiscordBotService.isConfigured()
    ? DiscordBotService.getInstance()
    : null;

const start = async () => {
    if (!env.BOT_GATEWAY_ENABLED) throw new Error('BOT_GATEWAY_ENABLED must be true for the integration worker');
    if (!telegram && !discord) throw new Error('No inbound bot integration is configured');
    await Promise.all([telegram?.start(), discord?.start()]);
    console.log('[integration-worker] Bot gateways started');
};

const shutdown = async (signal: string) => {
    console.log(`[integration-worker] Received ${signal}, shutting down...`);
    await Promise.all([telegram?.stop(), discord?.stop()]);
    await closeRuntime();
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

start().catch((error) => {
    console.error('[integration-worker] Fatal error:', error);
    process.exitCode = 1;
    return closeRuntime();
});
