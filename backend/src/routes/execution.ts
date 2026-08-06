import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { authenticateToken } from '../middleware/auth';
import { ExecutionService, ExecutionError } from '../services/execution/executionService';
import { ExecutionProviderError } from '../services/execution/provider';
import { quoteRequestSchema, submitRequestSchema, AuthRequest } from '../types';
import { tradeMutationLimiter } from '../middleware/rateLimits';

const router = Router();
const service = new ExecutionService();
const idSchema = z.string().uuid();

const sendError = (res: Response, error: unknown): Response => {
    const traceId = String(res.locals.traceId || 'unknown');
    if (error instanceof z.ZodError) {
        return res.status(400).json({
            error: {
                code: 'invalid_request',
                message: error.issues[0]?.message || 'Request is invalid',
                retryable: false,
                traceId,
            },
        });
    }
    if (error instanceof ExecutionError) {
        return res.status(error.status).json({
            error: {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
                traceId,
            },
        });
    }
    if (error instanceof ExecutionProviderError) {
        console.error('[execution] Provider request failed', { traceId, code: error.code, message: error.message });
        if (error.retryAfterMs) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
        return res.status(error.status).json({
            error: {
                code: error.code,
                message: 'Execution provider is temporarily unavailable',
                retryable: error.retryable,
                retryAfterMs: error.retryAfterMs,
                traceId,
            },
        });
    }
    console.error('[execution] Unhandled error', { traceId, error });
    return res.status(500).json({
        error: {
            code: 'internal_error',
            message: 'Internal server error',
            retryable: false,
            traceId,
        },
    });
};

router.get('/capabilities', (_req: Request, res: Response) => {
    res.json({ data: service.capabilities() });
});

router.use(authenticateToken);

router.post('/quotes', tradeMutationLimiter, async (req: AuthRequest, res: Response) => {
    try {
        const input = quoteRequestSchema.parse(req.body);
        if (input.taker !== req.user!.wallet_address) {
            throw new ExecutionError('wallet_mismatch', 'Taker must match the authenticated wallet', 403);
        }
        const quote = await service.createQuote(req.user!.id, input);
        res.status(201).json({ data: quote });
    } catch (error) {
        sendError(res, error);
    }
});

router.post('/quotes/:quoteId/submit', tradeMutationLimiter, async (req: AuthRequest, res: Response) => {
    try {
        const quoteId = idSchema.parse(req.params.quoteId);
        const input = submitRequestSchema.parse(req.body);
        const execution = await service.submit(
            req.user!.id,
            quoteId,
            input,
            String(res.locals.traceId)
        );
        res.status(202).json({ data: execution });
    } catch (error) {
        sendError(res, error);
    }
});

router.get('/executions', async (req: AuthRequest, res: Response) => {
    try {
        const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);
        res.json({ data: await service.listExecutions(req.user!.id, limit) });
    } catch (error) {
        sendError(res, error);
    }
});

router.get('/executions/:executionId', async (req: AuthRequest, res: Response) => {
    try {
        const executionId = idSchema.parse(req.params.executionId);
        res.json({ data: await service.getExecution(req.user!.id, executionId) });
    } catch (error) {
        sendError(res, error);
    }
});

export default router;
