import { Response, Router } from 'express';
import { z } from 'zod';
import { authenticateToken } from '../middleware/auth';
import { WalletError, WalletService } from '../services/wallets/walletService';
import { AuthRequest, trackWalletSchema, updateWalletSchema } from '../types';
import { userMutationLimiter } from '../middleware/rateLimits';

const router = Router();
const service = new WalletService();
const idSchema = z.string().uuid();

const sendError = (res: Response, error: unknown): Response => {
    const traceId = String(res.locals.traceId || 'unknown');
    if (error instanceof z.ZodError) return res.status(400).json({ error: {
        code: 'invalid_request', message: error.issues[0]?.message || 'Request is invalid', retryable: false, traceId,
    } });
    if (error instanceof WalletError) return res.status(error.status).json({ error: {
        code: error.code, message: error.message, retryable: false, traceId,
    } });
    console.error('[wallets] Unhandled error', { traceId, error });
    return res.status(500).json({ error: {
        code: 'internal_error', message: 'Internal server error', retryable: false, traceId,
    } });
};

router.use(authenticateToken);

router.post('/', userMutationLimiter, async (req: AuthRequest, res) => {
    try {
        res.status(201).json({ data: await service.create(req.user!.id, trackWalletSchema.parse(req.body)) });
    } catch (error) { sendError(res, error); }
});

router.get('/', async (req: AuthRequest, res) => {
    try { res.json({ data: await service.list(req.user!.id) }); } catch (error) { sendError(res, error); }
});

router.patch('/:trackedId', userMutationLimiter, async (req: AuthRequest, res) => {
    try {
        res.json({ data: await service.update(
            req.user!.id, idSchema.parse(req.params.trackedId), updateWalletSchema.parse(req.body)
        ) });
    } catch (error) { sendError(res, error); }
});

router.delete('/:trackedId', userMutationLimiter, async (req: AuthRequest, res) => {
    try {
        await service.remove(req.user!.id, idSchema.parse(req.params.trackedId));
        res.status(204).send();
    } catch (error) { sendError(res, error); }
});

router.get('/:trackedId/activity', async (req: AuthRequest, res) => {
    try {
        const limit = z.coerce.number().int().min(1).max(500).default(100).parse(req.query.limit);
        const before = z.string().max(512).optional().parse(req.query.before);
        const items = await service.activity(
            req.user!.id,
            idSchema.parse(req.params.trackedId),
            limit,
            before
        );
        const last = items.at(-1);
        res.json({ data: {
            items,
            nextCursor: items.length === limit && last
                ? Buffer.from(`${last.occurredAt}|${last.id}`).toString('base64url')
                : undefined,
        } });
    } catch (error) { sendError(res, error); }
});

router.get('/:trackedId/positions', async (req: AuthRequest, res) => {
    try {
        res.json({ data: await service.positions(req.user!.id, idSchema.parse(req.params.trackedId)) });
    } catch (error) { sendError(res, error); }
});

router.get('/:trackedId/portfolio', async (req: AuthRequest, res) => {
    try {
        res.json({ data: await service.portfolio(req.user!.id, idSchema.parse(req.params.trackedId)) });
    } catch (error) { sendError(res, error); }
});

router.get('/:trackedId/portfolio/history', async (req: AuthRequest, res) => {
    try {
        const limit = z.coerce.number().int().min(1).max(2000).default(500).parse(req.query.limit);
        const before = z.string().datetime().optional().parse(req.query.before);
        const items = await service.portfolioHistory(
            req.user!.id,
            idSchema.parse(req.params.trackedId),
            limit,
            before
        );
        res.json({ data: {
            items,
            nextCursor: items.length === limit ? items.at(-1)?.at : undefined,
        } });
    } catch (error) { sendError(res, error); }
});

export default router;
