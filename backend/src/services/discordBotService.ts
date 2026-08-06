import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChatInputCommandInteraction,
    Client,
    Events,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
} from 'discord.js';
import { query } from '../config/database';
import { env } from '../config/env';
import { createLinkTokenRecord } from './authSecurity';

const token = env.DISCORD_BOT_TOKEN || '';
const clientId = env.DISCORD_CLIENT_ID || '';

export class DiscordBotService {
    private static instance: DiscordBotService | null = null;
    private readonly client: Client;
    private running = false;
    private handlersReady = false;

    private constructor() {
        if (!token) throw new Error('DISCORD_BOT_TOKEN is required');
        if (!clientId) throw new Error('DISCORD_CLIENT_ID is required');
        this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
    }

    static getInstance(): DiscordBotService {
        if (!DiscordBotService.instance) DiscordBotService.instance = new DiscordBotService();
        return DiscordBotService.instance;
    }

    static isConfigured(): boolean {
        return env.ENABLE_DISCORD_NOTIFICATIONS && Boolean(token) && Boolean(clientId);
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.configureHandlers();
        if (!env.DISCORD_SKIP_COMMAND_REGISTRATION) await this.registerCommands();
        await this.client.login(token);
        this.running = true;
        console.log('[discord-gateway] Started');
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.client.destroy();
        this.running = false;
        console.log('[discord-gateway] Stopped');
    }

    isRunningBot(): boolean {
        return this.running;
    }

    private configureHandlers(): void {
        if (this.handlersReady) return;
        this.handlersReady = true;
        this.client.once(Events.ClientReady, (readyClient) => {
            console.log(`[discord-gateway] Ready as ${readyClient.user.tag}`);
        });
        this.client.on(Events.InteractionCreate, async (interaction) => {
            if (!interaction.isChatInputCommand()) return;
            try {
                if (interaction.commandName === 'link') await this.link(interaction);
                if (interaction.commandName === 'help') {
                    await interaction.reply({
                        content: 'Use `/link` to connect Discord. Create and manage trading alerts in Fervor.',
                        ephemeral: true,
                    });
                }
            } catch (error) {
                console.error('[discord-gateway] Command failed', error);
                const content = 'The command could not be completed. Please try again.';
                if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
                else await interaction.reply({ content, ephemeral: true });
            }
        });
    }

    private async registerCommands(): Promise<void> {
        const commands = [
            new SlashCommandBuilder().setName('link').setDescription('Link Discord to your Fervor wallet'),
            new SlashCommandBuilder().setName('help').setDescription('Show Fervor integration help'),
        ].map((command) => command.toJSON());
        const rest = new REST({ version: '10' }).setToken(token);
        await rest.put(Routes.applicationCommands(clientId), { body: commands });
    }

    private async link(interaction: ChatInputCommandInteraction): Promise<void> {
        await interaction.deferReply({ ephemeral: true });
        const discordId = interaction.user.id;
        const existing = await query(
            'SELECT wallet_address FROM users WHERE discord_user_id = $1',
            [discordId]
        );
        if (existing.rows[0]?.wallet_address) {
            const wallet = String(existing.rows[0].wallet_address);
            await interaction.editReply(`Already linked to ${wallet.slice(0, 6)}...${wallet.slice(-6)}.`);
            return;
        }

        const linkToken = await createLinkTokenRecord(
            'DELETE FROM discord_linking_tokens WHERE discord_user_id = $1',
            [discordId],
            `INSERT INTO discord_linking_tokens (token_hash, discord_user_id, discord_username, expires_at)
             VALUES ($1, $2, $3, $4)`,
            (tokenHash, expiresAt) => [tokenHash, discordId, interaction.user.username, expiresAt]
        );
        const url = `${env.FRONTEND_URL}/link-discord?token=${linkToken}`;
        const button = new ButtonBuilder()
            .setLabel('Link wallet')
            .setStyle(ButtonStyle.Link)
            .setURL(url);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);
        await interaction.editReply({
            content: 'Link your wallet within 15 minutes. Alerts configured in Fervor will be delivered here.',
            components: [row],
        });
    }
}
