interface CachedTokenData {
    logo?: string;
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: string;
    totalSupplyFormatted: string;
    fullyDilutedValue?: string;
    links?: {
        website?: string;
        twitter?: string;
        telegram?: string;
        reddit?: string;
    };
    description?: string;
    isVerifiedContract?: boolean;
    possibleSpam?: boolean;
    cachedAt: number;
}

interface TokenCacheStorage {
    [tokenAddress: string]: CachedTokenData;
}

class TokenCacheService {
    private cache: TokenCacheStorage = {};
    private readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    private readonly STORAGE_KEY = 'token_metadata_cache';

    constructor() {
        this.loadFromStorage();
    }

    private loadFromStorage() {
        if (typeof window !== 'undefined') {
            try {
                const stored = localStorage.getItem(this.STORAGE_KEY);
                if (stored) {
                    this.cache = JSON.parse(stored);
                    // Clean expired entries
                    this.cleanExpiredEntries();
                }
            } catch {
                this.cache = {};
            }
        }
    }

    private saveToStorage() {
        if (typeof window !== 'undefined') {
            try {
                localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.cache));
            } catch {
                // Keep the in-memory cache when browser storage is unavailable.
            }
        }
    }

    private cleanExpiredEntries() {
        const now = Date.now();
        const expiredKeys = Object.keys(this.cache).filter(
            key => now - this.cache[key].cachedAt > this.CACHE_DURATION
        );

        expiredKeys.forEach(key => {
            delete this.cache[key];
        });

        if (expiredKeys.length > 0) {
            this.saveToStorage();
        }
    }

    private isExpired(tokenAddress: string): boolean {
        const cached = this.cache[tokenAddress];
        if (!cached) return true;

        return Date.now() - cached.cachedAt > this.CACHE_DURATION;
    }

    getCachedToken(tokenAddress: string): CachedTokenData | null {
        if (this.isExpired(tokenAddress)) {
            delete this.cache[tokenAddress];
            return null;
        }
        return this.cache[tokenAddress] || null;
    }

    cacheToken(tokenAddress: string, tokenData: Omit<CachedTokenData, 'cachedAt'>) {
        this.cache[tokenAddress] = {
            ...tokenData,
            cachedAt: Date.now()
        };
        this.saveToStorage();
    }

    getCachedLogo(tokenAddress: string): string | null {
        const cached = this.getCachedToken(tokenAddress);
        return cached?.logo || null;
    }

    clearCache() {
        this.cache = {};
        this.saveToStorage();
    }

    getCacheStats() {
        const now = Date.now();
        const totalEntries = Object.keys(this.cache).length;
        const expiredEntries = Object.keys(this.cache).filter(
            key => now - this.cache[key].cachedAt > this.CACHE_DURATION
        ).length;

        return {
            totalEntries,
            expiredEntries,
            validEntries: totalEntries - expiredEntries
        };
    }
}

export const tokenCacheService = new TokenCacheService();
export type { CachedTokenData };
