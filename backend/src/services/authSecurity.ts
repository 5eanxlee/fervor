import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { query } from '../config/database';
import { User } from '../types';

const NONCE_TTL_MINUTES = 10;
const LINK_TOKEN_TTL_MINUTES = 15;
const USER_TOKEN_TTL = '7d';

export const generateSecureToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('hex');

export const hashSecret = (value: string): string =>
    crypto.createHmac('sha256', env.JWT_SECRET).update(value).digest('hex');

export const generateAuthNonce = (): string => generateSecureToken(24);

export const createAuthNonce = async (walletAddress: string): Promise<string> => {
    const nonce = generateAuthNonce();
    const nonceHash = hashSecret(nonce);
    const expiresAt = new Date(Date.now() + NONCE_TTL_MINUTES * 60 * 1000).toISOString();

    await query(
        'UPDATE auth_nonces SET used = TRUE WHERE wallet_address = $1 AND used = FALSE',
        [walletAddress]
    );

    await query(
        `INSERT INTO auth_nonces (wallet_address, nonce_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [walletAddress, nonceHash, expiresAt]
    );

    return nonce;
};

export const extractAuthMessageFields = (message: string): { walletAddress: string; nonce: string } | null => {
    const walletMatch = message.match(/^Wallet:\s*([1-9A-HJ-NP-Za-km-z]{32,44})$/m);
    const nonceMatch = message.match(/^Nonce:\s*([a-f0-9]{48})$/m);

    if (!walletMatch || !nonceMatch) {
        return null;
    }

    return {
        walletAddress: walletMatch[1],
        nonce: nonceMatch[1],
    };
};

export const consumeAuthNonce = async (walletAddress: string, nonce: string): Promise<boolean> => {
    const nonceHash = hashSecret(nonce);
    const result = await query(
        `UPDATE auth_nonces
         SET used = TRUE, used_at = CURRENT_TIMESTAMP
         WHERE wallet_address = $1
           AND nonce_hash = $2
           AND used = FALSE
           AND expires_at > NOW()
         RETURNING id`,
        [walletAddress, nonceHash]
    );

    return result.rows.length > 0;
};

export const createLinkTokenRecord = async (
    deleteSql: string,
    deleteParams: unknown[],
    insertSql: string,
    insertParamsFactory: (tokenHash: string, expiresAt: string) => unknown[]
): Promise<string> => {
    const token = generateSecureToken(32);
    const tokenHash = hashSecret(token);
    const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MINUTES * 60 * 1000).toISOString();

    await query(deleteSql, deleteParams);
    await query(insertSql, insertParamsFactory(tokenHash, expiresAt));

    return token;
};

export const signUserJwt = (user: User): string =>
    jwt.sign(
        { userId: user.id, walletAddress: user.wallet_address, tokenType: 'user' },
        env.JWT_SECRET,
        {
            algorithm: 'HS256',
            audience: 'fervor-web',
            issuer: 'fervor-api',
            expiresIn: USER_TOKEN_TTL,
        }
    );
