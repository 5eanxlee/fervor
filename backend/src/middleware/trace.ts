import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';

const TRACE_PATTERN = /^[a-zA-Z0-9._-]{8,64}$/;

export const traceMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header('x-trace-id');
    const traceId = incoming && TRACE_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
    res.locals.traceId = traceId;
    res.setHeader('X-Trace-Id', traceId);
    next();
};
