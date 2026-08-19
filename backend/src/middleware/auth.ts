import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { query } from '../config/database';
import { User, AuthRequest } from '../types';
import { env } from '../config/env';
import {
    consumeAuthNonce,
    createAuthNonce,
    extractAuthMessageFields,
    signUserJwt,
} from '../services/authSecurity';
import { authUsers } from '../services/authUserService';

declare module 'express-serve-static-core' {
    interface Request {
        get(name: string): string | undefined;
    }
}

export const verifySignature = (
    message: string,
    signature: string,
    publicKey: string
): boolean => {
    try {
        const messageBytes = new TextEncoder().encode(message);
        const signatureParts = signature.split(',').map((value) => Number(value));
        if (
            signatureParts.length !== 64 ||
            signatureParts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
        ) {
            return false;
        }

        const signatureBytes = new Uint8Array(signatureParts);
        const publicKeyBytes = bs58.decode(publicKey);

        if (publicKeyBytes.length !== 32) {
            return false;
        }

        return nacl.sign.detached.verify(
            messageBytes,
            signatureBytes,
            publicKeyBytes
        );
    } catch (error) {
        console.error('Signature verification error:', error);
        return false;
    }
};

export const generateAuthMessage = (walletAddress: string, nonce: string): string => {
    return `Sign this message to authenticate with Fervor.

Wallet: ${walletAddress}
Nonce: ${nonce}
Timestamp: ${new Date().toISOString()}

This request will not trigger a blockchain transaction or cost any gas fees.`;
};

export const signIn = async (req: Request, res: Response) => {
    try {
        const { walletAddress, signature, message } = req.body;

        if (!walletAddress || !signature || !message) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: walletAddress, signature, message'
            });
        }

        const messageFields = extractAuthMessageFields(message);
        if (!messageFields || messageFields.walletAddress !== walletAddress) {
            return res.status(401).json({
                success: false,
                error: 'Invalid authentication message'
            });
        }

        // Verify the signature
        const isValidSignature = verifySignature(message, signature, walletAddress);
        if (!isValidSignature) {
            return res.status(401).json({
                success: false,
                error: 'Invalid signature'
            });
        }

        const nonceAccepted = await consumeAuthNonce(walletAddress, messageFields.nonce);
        if (!nonceAccepted) {
            return res.status(401).json({
                success: false,
                error: 'Invalid or expired nonce'
            });
        }

        // Check if user exists, if not create one
        let result = await query(
            'SELECT * FROM users WHERE wallet_address = $1',
            [walletAddress]
        );

        let user: User;
        if (result.rows.length === 0) {
            // Create new user
            const insertResult = await query(
                'INSERT INTO users (wallet_address, telegram_chat_id) VALUES ($1, $2) RETURNING *',
                [walletAddress, null]
            );
            user = insertResult.rows[0];
        } else {
            user = result.rows[0];
        }
        await authUsers.put(user);

        // Generate JWT token
        const token = signUserJwt(user);

        res.json({
            success: true,
            data: {
                token,
                user: {
                    id: user.id,
                    walletAddress: user.wallet_address,
                    email: user.email,
                    telegramChatId: user.telegram_chat_id
                }
            }
        });
    } catch (error) {
        console.error('Sign in error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
};

export const requestToken = (
    authorization?: string,
    replaySession?: string,
    allowReplay = false
): string | undefined => {
    if (allowReplay && replaySession
        && /^[A-Za-z0-9._~-]{32,4096}$/.test(replaySession)) return replaySession;
    return authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
};

export const authenticateToken = async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
) => {
    const token = requestToken(
        req.get('authorization'),
        req.get('x-fervor-replay-session'),
        Boolean(env.REPLAY_API_SOCKET)
    );
    if (!token) {
        return res.status(401).json({ success: false, error: 'Access token required' });
    }

    try {
        req.user = await authenticateUserToken(token);
        next();
    } catch (error) {
        if (!(error instanceof AuthTokenError)) throw error;
        if (error.code === 'unavailable') {
            console.error('[auth] User lookup failed', {
                traceId: String(res.locals.traceId || 'unknown'),
                error: error.source instanceof Error ? error.source.name : 'unknown',
            });
        }
        return res.status(error.status).json({ success: false, error: error.message });
    }
};

export type AuthTokenCode = 'invalid' | 'type' | 'missing' | 'wallet' | 'unavailable';

export class AuthTokenError extends Error {
    constructor(
        readonly code: AuthTokenCode,
        message: string,
        readonly status: 401 | 403 | 503,
        readonly source?: unknown
    ) {
        super(message);
        this.name = 'AuthTokenError';
    }
}

export const authenticateUserToken = async (token: string): Promise<User> => {
    let decoded: jwt.JwtPayload;
    try {
        const payload = jwt.verify(token, env.JWT_SECRET, {
            algorithms: ['HS256'],
            audience: 'fervor-web',
            issuer: 'fervor-api',
        });
        if (typeof payload === 'string') throw new jwt.JsonWebTokenError('Invalid token payload');
        decoded = payload;
    } catch {
        throw new AuthTokenError('invalid', 'Invalid or expired token', 403);
    }
    if (decoded.tokenType !== 'user' || typeof decoded.userId !== 'string') {
        throw new AuthTokenError('type', 'Invalid token type', 403);
    }

    try {
        const user = await authUsers.get(decoded.userId);
        if (!user) {
            throw new AuthTokenError('missing', 'User not found', 401);
        }
        if (decoded.walletAddress !== user.wallet_address) {
            throw new AuthTokenError(
                'wallet', 'Token wallet no longer matches the user', 403
            );
        }
        return user;
    } catch (error) {
        if (error instanceof AuthTokenError) throw error;
        throw new AuthTokenError(
            'unavailable',
            'Authentication service unavailable',
            503,
            error
        );
    }
};

export const generateNonce = (): string => {
    return crypto.randomBytes(24).toString('hex');
};

export const getNonce = async (req: Request, res: Response) => {
    try {
        const { walletAddress } = req.query;

        if (!walletAddress) {
            return res.status(400).json({
                success: false,
                error: 'Wallet address required'
            });
        }

        const nonce = await createAuthNonce(walletAddress as string);
        const message = generateAuthMessage(walletAddress as string, nonce);

        res.json({
            success: true,
            data: {
                message,
                nonce
            }
        });
    } catch (error) {
        console.error('Nonce generation error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to generate nonce'
        });
    }
};
