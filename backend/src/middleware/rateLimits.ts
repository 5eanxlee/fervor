import { RequestHandler } from 'express';
import { env } from '../config/env';
import { redisStreams } from '../services/redisStreamService';
import { AuthRequest } from '../types';

type Identity = 'ip' | 'user';

const distributedLimiter = (
    scope: string,
    max: number,
    windowMs: number,
    identity: Identity = 'ip'
): RequestHandler => async (req: AuthRequest, res, next) => {
    if (env.NODE_ENV === 'test') return next();
    const subject = identity === 'user' ? req.user?.id : req.ip;
    if (!subject) {
        return res.status(503).json({ error: {
            code: 'rate_limit_identity_unavailable',
            message: 'Request identity is unavailable',
            retryable: true,
            traceId: String(res.locals.traceId || 'unknown'),
        } });
    }
    try {
        const state = await redisStreams.fixedWindow(`fervor:limit:${scope}:${subject}`, windowMs);
        res.setHeader('RateLimit-Limit', String(max));
        res.setHeader('RateLimit-Remaining', String(Math.max(0, max - state.count)));
        res.setHeader('RateLimit-Reset', String(Math.max(1, Math.ceil(state.ttlMs / 1000))));
        if (state.count <= max) return next();
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(state.ttlMs / 1000))));
        return res.status(429).json({ error: {
            code: 'rate_limited',
            message: 'Too many requests',
            retryable: true,
            traceId: String(res.locals.traceId || 'unknown'),
        } });
    } catch (error) {
        console.error('[rate-limit] Redis check failed', {
            scope,
            traceId: String(res.locals.traceId || 'unknown'),
            error: error instanceof Error ? error.name : 'unknown',
        });
        return res.status(503).json({ error: {
            code: 'rate_limit_unavailable',
            message: 'Request protection is temporarily unavailable',
            retryable: true,
            traceId: String(res.locals.traceId || 'unknown'),
        } });
    }
};

export const standardLimiter = distributedLimiter(
    'global', env.RATE_LIMIT_MAX_REQUESTS, env.RATE_LIMIT_WINDOW_MS
);
export const nonceLimiter = distributedLimiter('auth:nonce', 30, 10 * 60_000);
export const signInLimiter = distributedLimiter('auth:signin', 20, 10 * 60_000);
export const linkTokenLimiter = distributedLimiter('auth:link', 30, 15 * 60_000);
export const publicTokenLimiter = distributedLimiter('token:read', 60, 60_000);
export const emailVerificationLimiter = distributedLimiter('email:verify', 20, 60 * 60_000, 'user');
export const tradeMutationLimiter = distributedLimiter('trade', 120, 60_000, 'user');
export const orderMutationLimiter = distributedLimiter('order', 120, 60_000, 'user');
export const userMutationLimiter = distributedLimiter('user', 180, 60_000, 'user');
