import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticateToken } from '../middleware/auth';
import { ApiResponse, AuthRequest } from '../types';
import { notificationPreferenceService } from '../services/notifications/NotificationPreferenceService';
import { authUsers } from '../services/authUserService';

const router = Router();
router.use(authenticateToken);

router.get('/', (req: AuthRequest, res: Response) => {
    const user = req.user!;
    res.json({
        success: true,
        data: {
            id: user.id,
            walletAddress: user.wallet_address,
            email: user.email,
            telegramChatId: user.telegram_chat_id,
            discordUserId: user.discord_user_id,
        },
    } as ApiResponse);
});

router.put('/', async (req: AuthRequest, res: Response) => {
    try {
        const { telegramChatId } = req.body;
        if (telegramChatId !== null && telegramChatId !== undefined && typeof telegramChatId !== 'string') {
            return res.status(400).json({ success: false, error: 'Invalid Telegram chat id' } as ApiResponse);
        }
        if (telegramChatId === undefined) {
            return res.status(400).json({ success: false, error: 'No profile fields to update' } as ApiResponse);
        }

        const result = await query(
            `UPDATE users
             SET telegram_chat_id = $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING *`,
            [telegramChatId || null, req.user!.id]
        );
        const user = result.rows[0];
        await query(
            `INSERT INTO user_notification_preferences (user_id, channel, enabled, alert_notifications_enabled)
             VALUES ($1, 'telegram', $2, TRUE)
             ON CONFLICT (user_id, channel) DO UPDATE SET
                 enabled = EXCLUDED.enabled,
                 updated_at = CURRENT_TIMESTAMP`,
            [req.user!.id, Boolean(telegramChatId)]
        );
        await notificationPreferenceService.invalidate(req.user!.id);
        await authUsers.put(user);
        res.json({
            success: true,
            data: {
                id: user.id,
                walletAddress: user.wallet_address,
                email: user.email,
                telegramChatId: user.telegram_chat_id,
                discordUserId: user.discord_user_id,
            },
        } as ApiResponse);
    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({ success: false, error: 'Failed to update profile' } as ApiResponse);
    }
});

export default router;
