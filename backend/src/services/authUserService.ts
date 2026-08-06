import { query } from '../config/database';
import { env } from '../config/env';
import { User } from '../types';
import { metrics } from './metrics';
import { redisStreams } from './redisStreamService';

const key = (userId: string): string => `auth:user:${userId}`;

const validUser = (value: unknown, userId: string): value is User => {
    if (!value || typeof value !== 'object') return false;
    const user = value as Record<string, unknown>;
    return user.id === userId && typeof user.wallet_address === 'string';
};

export class AuthUserService {
    private readonly inFlight = new Map<string, Promise<User | null>>();

    async get(userId: string): Promise<User | null> {
        try {
            if (env.NODE_ENV === 'test') return this.load(userId);
            const cached = await redisStreams.command.get(key(userId));
            if (cached) {
                const user = JSON.parse(cached);
                if (validUser(user, userId)) {
                    metrics.increment('fervor_auth_user_cache_hits');
                    return user;
                }
                await redisStreams.command.del(key(userId));
            }
        } catch {
            metrics.increment('fervor_auth_user_cache_errors');
        }
        metrics.increment('fervor_auth_user_cache_misses');
        const active = this.inFlight.get(userId);
        if (active) return active;
        const load = this.load(userId).finally(() => this.inFlight.delete(userId));
        this.inFlight.set(userId, load);
        return load;
    }

    async put(user: User): Promise<void> {
        if (env.NODE_ENV === 'test') return;
        try {
            await redisStreams.command.set(key(user.id), JSON.stringify(user), 'EX', env.AUTH_USER_CACHE_TTL_SEC);
        } catch {
            metrics.increment('fervor_auth_user_cache_errors');
        }
    }

    async invalidate(userId: string): Promise<void> {
        if (env.NODE_ENV === 'test') return;
        try {
            await redisStreams.command.del(key(userId));
        } catch {
            metrics.increment('fervor_auth_user_cache_errors');
        }
    }

    private async load(userId: string): Promise<User | null> {
        const result = await query('SELECT * FROM users WHERE id = $1', [userId]);
        const user = result.rows[0] as User | undefined;
        if (!user) return null;
        await this.put(user);
        return user;
    }
}

export const authUsers = new AuthUserService();
