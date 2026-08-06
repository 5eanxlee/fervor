import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { authenticateToken } from '../middleware/auth';
import { OrderError, OrderService } from '../services/orders/orderService';
import { OrderProviderError } from '../services/orders/provider';
import {
    AuthRequest,
    orderActivateSchema,
    orderAuthSchema,
    orderCancelSchema,
    orderChallengeSchema,
    orderRequestSchema,
    orderUpdateSchema,
} from '../types';
import { orderMutationLimiter } from '../middleware/rateLimits';

const router = Router();
const service = new OrderService();
const idSchema = z.string().uuid();

const providerToken = (req: Request): string | undefined => {
    const value = req.header('x-order-provider-token')?.trim();
    if (!value) return undefined;
    if (value.length > 4096) throw new OrderError('invalid_provider_token', 'Provider token is too large', 400);
    return value;
};

const sendError = (res: Response, error: unknown): Response => {
    const traceId = String(res.locals.traceId || 'unknown');
    if (error instanceof z.ZodError) {
        return res.status(400).json({ error: {
            code: 'invalid_request', message: error.issues[0]?.message || 'Request is invalid', retryable: false, traceId,
        } });
    }
    if (error instanceof OrderError) {
        return res.status(error.status).json({ error: {
            code: error.code, message: error.message, retryable: error.retryable, traceId,
        } });
    }
    if (error instanceof OrderProviderError) {
        console.error('[orders] Provider request failed', { traceId, code: error.code, message: error.message });
        if (error.retryAfterMs) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
        return res.status(error.status).json({ error: {
            code: error.code,
            message: error.status === 401 ? 'Order provider authorization expired' : 'Order provider is temporarily unavailable',
            retryable: error.retryable,
            retryAfterMs: error.retryAfterMs,
            traceId,
        } });
    }
    console.error('[orders] Unhandled error', { traceId, error });
    return res.status(500).json({ error: {
        code: 'internal_error', message: 'Internal server error', retryable: false, traceId,
    } });
};

router.get('/capabilities', (_req, res) => res.json({ data: service.capabilities() }));
router.use(authenticateToken);

router.post('/provider/challenge', orderMutationLimiter, async (req: AuthRequest, res) => {
    try {
        const input = orderChallengeSchema.parse(req.body);
        if (input.walletAddress !== req.user!.wallet_address) throw new OrderError('wallet_mismatch', 'Wallet does not match the session', 403);
        res.json({ data: await service.challenge(input.walletAddress, input.type) });
    } catch (error) {
        sendError(res, error);
    }
});

router.post('/provider/verify', orderMutationLimiter, async (req: AuthRequest, res) => {
    try {
        const input = orderAuthSchema.parse(req.body);
        if (input.walletAddress !== req.user!.wallet_address) throw new OrderError('wallet_mismatch', 'Wallet does not match the session', 403);
        const auth = input.type === 'message'
            ? { type: input.type, signature: input.signature }
            : { type: input.type, signedTransaction: input.signedTransaction };
        res.json({ data: { token: await service.verify(input.walletAddress, auth) } });
    } catch (error) {
        sendError(res, error);
    }
});

router.post('/prepare', orderMutationLimiter, async (req: AuthRequest, res) => {
    try {
        const input = orderRequestSchema.parse(req.body);
        if (input.walletAddress !== req.user!.wallet_address) throw new OrderError('wallet_mismatch', 'Wallet does not match the session', 403);
        res.status(201).json({ data: await service.prepare(req.user!.id, input, providerToken(req)) });
    } catch (error) {
        sendError(res, error);
    }
});

router.post('/:orderId/activate', orderMutationLimiter, async (req: AuthRequest, res) => {
    try {
        const orderId = idSchema.parse(req.params.orderId);
        const input = orderActivateSchema.parse(req.body);
        res.status(202).json({ data: await service.activate(
            req.user!.id, orderId, input.signedTransaction, providerToken(req)
        ) });
    } catch (error) {
        sendError(res, error);
    }
});

router.patch('/:orderId', orderMutationLimiter, async (req: AuthRequest, res) => {
    try {
        const orderId = idSchema.parse(req.params.orderId);
        const input = orderUpdateSchema.parse(req.body);
        res.json({ data: await service.update(req.user!.id, orderId, input, providerToken(req)) });
    } catch (error) {
        sendError(res, error);
    }
});

router.post('/:orderId/cancel', orderMutationLimiter, async (req: AuthRequest, res) => {
    try {
        const orderId = idSchema.parse(req.params.orderId);
        res.json({ data: await service.cancel(req.user!.id, orderId, providerToken(req)) });
    } catch (error) {
        sendError(res, error);
    }
});

router.post('/:orderId/confirm-cancel', orderMutationLimiter, async (req: AuthRequest, res) => {
    try {
        const orderId = idSchema.parse(req.params.orderId);
        const input = orderCancelSchema.parse(req.body);
        res.json({ data: await service.confirmCancel(
            req.user!.id, orderId, input.cancelRequestId, input.signedTransaction, providerToken(req)
        ) });
    } catch (error) {
        sendError(res, error);
    }
});

router.post('/sync', orderMutationLimiter, async (req: AuthRequest, res) => {
    try {
        res.json({ data: await service.sync(req.user!.id, providerToken(req)) });
    } catch (error) {
        sendError(res, error);
    }
});

router.get('/', async (req: AuthRequest, res) => {
    try {
        const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);
        res.json({ data: await service.list(req.user!.id, limit) });
    } catch (error) {
        sendError(res, error);
    }
});

router.get('/:orderId', async (req: AuthRequest, res) => {
    try {
        res.json({ data: await service.get(req.user!.id, idSchema.parse(req.params.orderId)) });
    } catch (error) {
        sendError(res, error);
    }
});

export default router;
