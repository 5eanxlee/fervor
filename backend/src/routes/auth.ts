import { Router, Response } from 'express';
import { getNonce, signIn, authenticateToken } from '../middleware/auth';
import { linkTokenLimiter, nonceLimiter, signInLimiter } from '../middleware/rateLimits';
import { query } from '../config/database';
import { AuthRequest, ApiResponse } from '../types';
import { createLinkTokenRecord, hashSecret } from '../services/authSecurity';
import { authUsers } from '../services/authUserService';
import { notificationPreferenceService } from '../services/notifications/NotificationPreferenceService';

const router = Router();

// GET /auth/nonce - Get nonce for wallet authentication
router.get('/nonce', nonceLimiter, getNonce);

// POST /auth/signin - Sign in with wallet signature
router.post('/signin', signInLimiter, signIn);

// GET /auth/me - Get current user info
router.get('/me', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        res.json({
            success: true,
            data: {
                id: req.user!.id,
                walletAddress: req.user!.wallet_address,
                email: req.user!.email,
                telegramChatId: req.user!.telegram_chat_id,
                discordUserId: req.user!.discord_user_id
            }
        } as ApiResponse);
    } catch (error) {
        console.error('Error getting current user:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get user info'
        } as ApiResponse);
    }
});

router.post('/telegram/link-token', linkTokenLimiter, authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const token = await createLinkTokenRecord(
            'DELETE FROM telegram_link_tokens WHERE user_id = $1',
            [req.user!.id],
            `INSERT INTO telegram_link_tokens (token_hash, user_id, expires_at)
             VALUES ($1, $2, $3)`,
            (tokenHash, expiresAt) => [tokenHash, req.user!.id, expiresAt]
        );
        res.json({ success: true, data: { token } } as ApiResponse);
    } catch (error) {
        console.error('Error generating Telegram link token:', error);
        res.status(500).json({ success: false, error: 'Failed to generate linking token' } as ApiResponse);
    }
});

// POST /auth/discord/link-with-token - Link with token (called by frontend)
router.post('/discord/link-with-token', linkTokenLimiter, authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { linkingToken } = req.body;

        if (!linkingToken || typeof linkingToken !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Linking token is required'
            } as ApiResponse);
        }

        const linkingTokenHash = hashSecret(linkingToken);

        // Validate token
        const tokenResult = await query(`
            SELECT * FROM discord_linking_tokens 
            WHERE token_hash = $1 AND NOT used AND expires_at > NOW()
        `, [linkingTokenHash]);

        if (tokenResult.rows.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Invalid or expired linking token'
            } as ApiResponse);
        }

        const tokenData = tokenResult.rows[0];

        // Check if this Discord user is already linked to another wallet
        const existingDiscordUser = await query(
            'SELECT id, wallet_address FROM users WHERE discord_user_id = $1',
            [tokenData.discord_user_id]
        );

        if (existingDiscordUser.rows.length > 0) {
            const existingUser = existingDiscordUser.rows[0];

            console.log('[DISCORD LINK] Existing Discord account found during linking');

            // If it's linked to this same user, that's fine
            if (existingUser.id === req.user!.id) {
                // Mark token as used
                await query(
                    'UPDATE discord_linking_tokens SET used = TRUE, wallet_address = $1 WHERE token_hash = $2',
                    [req.user!.wallet_address, linkingTokenHash]
                );

                console.log(`[DISCORD LINK] Discord account was already linked to this wallet`);

                return res.json({
                    success: true,
                    message: 'Discord account was already linked to this wallet',
                    data: { discordUsername: tokenData.discord_username }
                } as ApiResponse);
            }

            // If it's a placeholder account or has null wallet (orphaned), merge it
            if (!existingUser.wallet_address ||
                (existingUser.wallet_address.startsWith('discord_') && existingUser.wallet_address.includes('_placeholder'))) {

                console.log('[DISCORD LINK] Merging orphaned Discord account into authenticated wallet account');

                // Merge alerts from placeholder/orphaned account to real account
                await query(
                    'UPDATE token_alerts SET user_id = $1 WHERE user_id = $2',
                    [req.user!.id, existingUser.id]
                );

                // Delete the placeholder/orphaned account
                await query(
                    'DELETE FROM users WHERE id = $1',
                    [existingUser.id]
                );
                await authUsers.invalidate(existingUser.id);

                console.log('[DISCORD LINK] Successfully merged orphaned Discord account');

                // Now proceed to link the Discord to current user (old account was deleted)
            } else {
                // Real wallet already linked to different account
                console.log('[DISCORD LINK] Discord account is already linked to a different wallet');

                return res.status(400).json({
                    success: false,
                    error: 'This Discord account is already linked to another wallet'
                } as ApiResponse);
            }
        }

        // Link Discord to current user (only executes if no existing user or placeholder was merged)
        await query(
            'UPDATE users SET discord_user_id = $1 WHERE id = $2',
            [tokenData.discord_user_id, req.user!.id]
        );
        await query(
            `INSERT INTO user_notification_preferences (user_id, channel, enabled, alert_notifications_enabled)
             VALUES ($1, 'discord', TRUE, TRUE)
             ON CONFLICT (user_id, channel) DO UPDATE SET
                 enabled = TRUE,
                 updated_at = CURRENT_TIMESTAMP`,
            [req.user!.id]
        );
        await notificationPreferenceService.invalidate(req.user!.id);
        await authUsers.invalidate(req.user!.id);

        // Mark token as used
        await query(
            'UPDATE discord_linking_tokens SET used = TRUE, wallet_address = $1 WHERE token_hash = $2',
            [req.user!.wallet_address, linkingTokenHash]
        );

        console.log('[DISCORD LINK] Successfully linked Discord account to wallet');

        res.json({
            success: true,
            message: 'Discord account linked successfully',
            data: { discordUsername: tokenData.discord_username }
        } as ApiResponse);

    } catch (error) {
        console.error('Error linking Discord with token:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to link Discord account'
        } as ApiResponse);
    }
});

// GET /auth/discord/token-info/:token - Check if token exists and get Discord info
router.get('/discord/token-info/:token', linkTokenLimiter, async (req, res: Response) => {
    try {
        const { token } = req.params;
        const tokenHash = hashSecret(token);

        const result = await query(`
            SELECT discord_username, discord_user_id, expires_at, used 
            FROM discord_linking_tokens 
            WHERE token_hash = $1
        `, [tokenHash]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Token not found'
            } as ApiResponse);
        }

        const tokenData = result.rows[0];
        const isExpired = new Date() > new Date(tokenData.expires_at);

        res.json({
            success: true,
            data: {
                discordUsername: tokenData.discord_username,
                discordUserId: tokenData.discord_user_id,
                isExpired,
                isUsed: tokenData.used
            }
        } as ApiResponse);

    } catch (error) {
        console.error('Error getting token info:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get token info'
        } as ApiResponse);
    }
});

// GET /auth/discord-status - Check Discord linking status
router.get('/discord-status', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const userResult = await query(
            'SELECT discord_user_id FROM users WHERE id = $1',
            [req.user!.id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            } as ApiResponse);
        }

        const user = userResult.rows[0];
        const isLinked = !!user.discord_user_id;

        res.json({
            success: true,
            data: {
                isLinked,
                discordUserId: user.discord_user_id || undefined
            }
        } as ApiResponse);

    } catch (error) {
        console.error('Error checking Discord status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to check Discord status'
        } as ApiResponse);
    }
});

export default router; 
