import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/database';
import { authenticateToken } from '../middleware/auth';
import { TokenService } from '../services/tokenService';
import { alertCreateSchema, alertUpdateSchema, AuthRequest, TokenAlert, ApiResponse } from '../types';
import { subscriptionRegistry } from '../services/subscriptionRegistry';
import { notificationPreferenceService } from '../services/notifications/NotificationPreferenceService';
import { userMutationLimiter } from '../middleware/rateLimits';

const router = Router();
const tokenService = new TokenService();
const idSchema = z.string().uuid();


// Apply authentication middleware to all routes
router.use(authenticateToken);

// GET /alerts - Get user's alerts
router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
        const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
        const result = await query(
            `SELECT DISTINCT ta.*, u.wallet_address as alert_user_wallet, u.discord_user_id as alert_user_discord 
             FROM token_alerts ta
             JOIN users u ON ta.user_id = u.id 
             WHERE ta.user_id = $1
               AND ($2::timestamp IS NULL OR ta.created_at < $2::timestamp)
             ORDER BY ta.created_at DESC
             LIMIT $3`,
            [req.user!.id, cursor, limit + 1]
        );

        const rows = result.rows as TokenAlert[];
        const alerts = rows.slice(0, limit);
        const nextCursor = rows.length > limit
            ? rows[limit - 1].created_at?.toISOString?.() || rows[limit - 1].created_at
            : undefined;

        // Add tracking status for each alert
        const alertsWithStatus = alerts.map(alert => ({
            ...alert,
            is_being_tracked: alert.is_active && !alert.is_triggered
        }));

        res.json({
            success: true,
            data: alertsWithStatus,
            message: nextCursor ? `nextCursor:${nextCursor}` : undefined
        } as ApiResponse<TokenAlert[]>);
    } catch (error) {
        console.error('Error fetching alerts:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch alerts'
        } as ApiResponse);
    }
});

// POST /alerts - Create new alert
router.post('/', userMutationLimiter, async (req: AuthRequest, res: Response) => {
    try {
        const {
            tokenAddress,
            thresholdType,
            thresholdValue,
            condition,
            notificationType
        } = alertCreateSchema.parse(req.body);

        const isValidToken = await tokenService.validateTokenAddress(tokenAddress);
        if (!isValidToken) {
            return res.status(400).json({
                success: false,
                error: 'Invalid token address or token not found'
            } as ApiResponse);
        }

        const channelResolution = await notificationPreferenceService.resolveChannel(req.user!.id, notificationType);

        // Check if user has required notification method configured.
        if (notificationType === 'telegram' && !channelResolution.recipient) {
            return res.status(400).json({
                success: false,
                error: 'Telegram not configured. Please update your profile first.'
            } as ApiResponse);
        }

        if (notificationType === 'discord' && !channelResolution.recipient) {
            return res.status(400).json({
                success: false,
                error: 'Discord not configured. Please link your Discord account first.'
            } as ApiResponse);
        }

        // Get token metadata
        const tokenData = await tokenService.getTokenData(tokenAddress);

        const result = await query(
            `INSERT INTO token_alerts 
       (user_id, token_address, token_name, token_symbol, threshold_type, threshold_value, condition, notification_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
            [
                req.user!.id,
                tokenAddress,
                tokenData?.name || null,
                tokenData?.symbol || null,
                thresholdType,
                thresholdValue,
                condition,
                notificationType
            ]
        );

        const newAlert = result.rows[0] as TokenAlert;

        try {
            await subscriptionRegistry.syncAndEmit(
                'alert_created',
                tokenAddress,
                newAlert.id,
                tokenData?.name || null,
                tokenData?.symbol || null
            );
        } catch (monitoringError) {
            console.error('Warning: Failed to publish alert registry update:', monitoringError);
        }

        res.status(201).json({
            success: true,
            data: newAlert,
            message: 'Alert created successfully'
        } as ApiResponse<TokenAlert>);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ success: false, error: error.issues[0]?.message || 'Invalid alert' } as ApiResponse);
        }
        console.error('Error creating alert:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create alert'
        } as ApiResponse);
    }
});

// PUT /alerts/:id - Update alert
router.put('/:id', userMutationLimiter, async (req: AuthRequest, res: Response) => {
    try {
        const id = idSchema.parse(req.params.id);
        const { thresholdValue, condition, isActive } = alertUpdateSchema.parse(req.body);

        // Check if alert exists and belongs to user
        const alertResult = await query(
            'SELECT * FROM token_alerts WHERE id = $1 AND user_id = $2',
            [id, req.user!.id]
        );

        if (alertResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Alert not found'
            } as ApiResponse);
        }

        // Build update query dynamically
        const updates: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        if (thresholdValue !== undefined) {
            updates.push(`threshold_value = $${paramIndex++}`);
            values.push(thresholdValue);
        }

        if (condition !== undefined) {
            updates.push(`condition = $${paramIndex++}`);
            values.push(condition);
        }

        if (isActive !== undefined) {
            updates.push(`is_active = $${paramIndex++}`);
            values.push(isActive);

            // Reset triggered status if reactivating
            if (isActive) {
                updates.push(`is_triggered = $${paramIndex++}`);
                values.push(false);
                updates.push(`triggered_at = $${paramIndex++}`);
                values.push(null);
                updates.push(`cleared_at = $${paramIndex++}`);
                values.push(null);
            }
        }

        if (thresholdValue !== undefined || condition !== undefined || isActive === true) {
            updates.push('generation = generation + 1');
        }

        values.push(id, req.user!.id);

        const updateResult = await query(
            `UPDATE token_alerts 
       SET ${updates.join(', ')} 
       WHERE id = $${paramIndex++} AND user_id = $${paramIndex++}
       RETURNING *`,
            values
        );

        const updatedAlert = updateResult.rows[0] as TokenAlert;

        try {
            await subscriptionRegistry.syncAndEmit(
                'alert_updated',
                updatedAlert.token_address,
                updatedAlert.id,
                updatedAlert.token_name || null,
                updatedAlert.token_symbol || null
            );
        } catch (cleanupError) {
            console.error('Error publishing alert registry update:', cleanupError);
        }

        res.json({
            success: true,
            data: updatedAlert,
            message: 'Alert updated successfully'
        } as ApiResponse<TokenAlert>);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ success: false, error: error.issues[0]?.message || 'Invalid alert update' } as ApiResponse);
        }
        console.error('Error updating alert:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update alert'
        } as ApiResponse);
    }
});

// DELETE /alerts/:id - Delete alert
router.delete('/:id', userMutationLimiter, async (req: AuthRequest, res: Response) => {
    try {
        const id = idSchema.parse(req.params.id);

        // First get the alert info before deleting
        const alertInfo = await query(
            'SELECT token_address FROM token_alerts WHERE id = $1 AND user_id = $2',
            [id, req.user!.id]
        );

        if (alertInfo.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Alert not found'
            } as ApiResponse);
        }

        const tokenAddress = alertInfo.rows[0].token_address;

        const result = await query(
            'DELETE FROM token_alerts WHERE id = $1 AND user_id = $2 RETURNING *',
            [id, req.user!.id]
        );

        try {
            await subscriptionRegistry.syncAndEmit('alert_deleted', tokenAddress, result.rows[0]?.id);
        } catch (cleanupError) {
            console.error('Error publishing alert registry cleanup:', cleanupError);
        }

        res.json({
            success: true,
            message: 'Alert deleted successfully'
        } as ApiResponse);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ success: false, error: 'Invalid alert ID' } as ApiResponse);
        }
        console.error('Error deleting alert:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete alert'
        } as ApiResponse);
    }
});

// GET /alerts/monitoring/status - Get monitoring system status
router.get('/monitoring/status', async (req: AuthRequest, res: Response) => {
    try {
        // Get active alerts count across all users
        const activeAlertsResult = await query(`
            SELECT COUNT(*) as count, 
                   COUNT(DISTINCT token_address) as unique_tokens
            FROM token_alerts 
            WHERE is_active = true AND is_triggered = false
        `);

        const totalActiveAlerts = parseInt(activeAlertsResult.rows[0].count);
        const uniqueTokens = parseInt(activeAlertsResult.rows[0].unique_tokens);

        // Get user's active alerts
        let userActiveAlerts;
        if (req.user!.telegram_chat_id) {
            userActiveAlerts = await query(`
                SELECT DISTINCT ta.token_address, ta.token_name, ta.token_symbol
                FROM token_alerts ta
                JOIN users u ON ta.user_id = u.id 
                WHERE ta.is_active = true AND ta.is_triggered = false 
                AND (ta.user_id = $1 OR u.telegram_chat_id = $2)
            `, [req.user!.id, req.user!.telegram_chat_id]);
        } else {
            userActiveAlerts = await query(`
                SELECT DISTINCT ta.token_address, ta.token_name, ta.token_symbol
                FROM token_alerts ta
                WHERE ta.is_active = true AND ta.is_triggered = false 
                AND ta.user_id = $1
            `, [req.user!.id]);
        }

        const status = {
            system: {
                totalActiveAlerts,
                uniqueTokens
            },
            user: {
                activeAlerts: userActiveAlerts.rows.length,
                tokens: userActiveAlerts.rows
            }
        };

        res.json({
            success: true,
            data: status
        } as ApiResponse);
    } catch (error) {
        console.error('Error getting monitoring status:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get monitoring status'
        } as ApiResponse);
    }
});

export default router; 
