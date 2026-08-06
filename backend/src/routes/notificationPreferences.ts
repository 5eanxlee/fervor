import { Router, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { ApiResponse, AuthRequest } from '../types';
import { notificationPreferenceService } from '../services/notifications/NotificationPreferenceService';

const router = Router();

router.use(authenticateToken);

router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const data = await notificationPreferenceService.getPreferences(req.user!.id);
        res.json({ success: true, data } as ApiResponse);
    } catch (error) {
        console.error('Error fetching notification preferences:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch notification preferences' } as ApiResponse);
    }
});

export default router;
