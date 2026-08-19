import { Request, Response, Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { userMutationLimiter } from '../middleware/rateLimits';
import { env } from '../config/env';
import type { AuthRequest } from '../types';
import {
    createReplayGateway,
    ReplayGatewayError,
    type ReplayCall,
    type ReplayGateway,
    type ReplayResource,
} from '../services/replay/replayGateway';

const queryOf = (req: Request): string => {
    if (req.originalUrl.includes('#')) {
        throw new ReplayGatewayError(
            'invalid_request', 'Replay request is invalid', 400, false
        );
    }
    return new URL(req.originalUrl, 'http://fervor.invalid').search;
};

const sendError = (res: Response, error: unknown): Response => {
    const traceId = String(res.locals.traceId || 'unknown');
    if (error instanceof ReplayGatewayError) {
        return res.status(error.status).json({ error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            traceId,
        } });
    }
    console.error('[replay] Host request failed', {
        traceId,
        error: error instanceof Error ? error.name : 'unknown',
    });
    return res.status(500).json({ error: {
        code: 'internal_error',
        message: 'Internal server error',
        retryable: false,
        traceId,
    } });
};

export const createReplayRouter = (gateway: ReplayGateway): Router => {
    const router = Router();
    router.use(authenticateToken);
    router.use((req: AuthRequest, res, next) => {
        if (!gateway.enabled) return next();
        if (req.user!.id !== gateway.ownerId) {
            return res.status(404).json({ success: false, error: 'Replay route not found' });
        }
        next();
    });

    const call = async (
        req: AuthRequest,
        res: Response,
        resource: ReplayResource,
        method: ReplayCall['method']
    ): Promise<void> => {
        try {
            const reply = await gateway.call({
                method,
                resource,
                query: queryOf(req),
                ...(method === 'POST' ? { body: req.body } : {}),
            });
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.status(reply.status).json(reply.body);
        } catch (error) {
            sendError(res, error);
        }
    };

    router.get('/snapshot', (req: AuthRequest, res) => void call(req, res, 'snapshot', 'GET'));
    router.get('/notifications', (req: AuthRequest, res) =>
        void call(req, res, 'notifications', 'GET'));
    router.get('/deltas', (req: AuthRequest, res) => void call(req, res, 'deltas', 'GET'));
    router.get('/paper', (req: AuthRequest, res) => void call(req, res, 'paper', 'GET'));
    router.get('/wallets/:wallet', (req: AuthRequest, res) =>
        void call(req, res, `wallets/${req.params.wallet}`, 'GET'));
    router.post('/paper/actions', userMutationLimiter, (req: AuthRequest, res) =>
        void call(req, res, 'paper/actions', 'POST'));
    router.post('/controls', userMutationLimiter, (req: AuthRequest, res) =>
        void call(req, res, 'controls', 'POST'));
    return router;
};

export default createReplayRouter(createReplayGateway(env));
