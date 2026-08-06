import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticateToken } from '../middleware/auth';
import { ApiResponse, AuthRequest } from '../types';

const router = Router();

router.use(authenticateToken);

router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
        const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
        const result = await query(
            `SELECT id, alert_event_id, alert_id, channel, provider, provider_status, status,
                    attempts, error_message, sent_at, created_at, updated_at
             FROM notification_deliveries
             WHERE user_id = $1
               AND ($2::timestamp IS NULL OR created_at < $2::timestamp)
             ORDER BY created_at DESC
             LIMIT $3`,
            [req.user!.id, cursor, limit + 1]
        );
        const rows = result.rows.slice(0, limit);
        const nextCursor = result.rows.length > limit
            ? result.rows[limit - 1].created_at?.toISOString?.() || result.rows[limit - 1].created_at
            : undefined;
        res.json({
            success: true,
            data: {
                items: rows,
                nextCursor,
            },
        } as ApiResponse);
    } catch (error) {
        console.error('Error fetching notification deliveries:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch notification deliveries' } as ApiResponse);
    }
});

export default router;
