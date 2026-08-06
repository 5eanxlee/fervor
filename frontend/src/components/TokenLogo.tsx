'use client';

import { useState, useEffect } from 'react';
import { apiService } from '../services/api';
import { tokenCacheService } from '../services/tokenCache';

interface TokenLogoProps {
    tokenAddress: string;
    tokenSymbol?: string;
    size?: 'sm' | 'md' | 'lg';
    className?: string;
}

const TokenLogo: React.FC<TokenLogoProps> = ({
    tokenAddress,
    tokenSymbol,
    size = 'md',
    className = ''
}) => {
    const [tokenMetadata, setTokenMetadata] = useState<any>(null);
    const [logoLoading, setLogoLoading] = useState(false);

    const sizeClasses = {
        sm: 'w-6 h-6',
        md: 'w-10 h-10',
        lg: 'w-12 h-12'
    };

    const textSizeClasses = {
        sm: 'text-xs',
        md: 'text-sm',
        lg: 'text-lg'
    };

    const spinnerSizeClasses = {
        sm: 'w-3 h-3',
        md: 'w-5 h-5',
        lg: 'w-6 h-6'
    };

    useEffect(() => {
        const fetchTokenMetadata = async () => {
            try {
                // Check cache first
                const cachedToken = tokenCacheService.getCachedToken(tokenAddress);
                if (cachedToken) {
                    setTokenMetadata(cachedToken);
                    return;
                }

                setLogoLoading(true);
                const response = await apiService.getTokenMetadata(tokenAddress);
                if (response.success && response.data) {
                    setTokenMetadata(response.data);
                    // Cache the token metadata
                    tokenCacheService.cacheToken(tokenAddress, response.data);
                }
            } catch {
                // The fallback token mark remains visible while metadata is unavailable.
            } finally {
                setLogoLoading(false);
            }
        };

        if (tokenAddress) {
            fetchTokenMetadata();
        }
    }, [tokenAddress]);

    if (logoLoading) {
        return (
            <div className={`${sizeClasses[size]} bg-slate-700 rounded-full flex items-center justify-center flex-shrink-0 ${className}`}>
                <div className={`animate-spin rounded-full ${spinnerSizeClasses[size]} border-b-2 border-cyan-400`}></div>
            </div>
        );
    }

    if (tokenMetadata?.logo) {
        return (
            <div className={`relative ${className}`}>
                {/* Token metadata may reference arbitrary decentralized image gateways. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    src={tokenMetadata.logo}
                    alt={tokenSymbol || tokenMetadata.symbol || 'Token'}
                    className={`${sizeClasses[size]} rounded-full object-cover bg-slate-700 border border-slate-600 flex-shrink-0`}
                    onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                        const fallback = (e.target as HTMLImageElement).parentElement?.querySelector('.logo-fallback') as HTMLElement;
                        if (fallback) fallback.classList.remove('hidden');
                    }}
                />
                <div className={`logo-fallback hidden ${sizeClasses[size]} bg-slate-700 rounded-full flex items-center justify-center flex-shrink-0 border border-slate-600 absolute top-0 left-0`}>
                    <span className={`text-white ${textSizeClasses[size]} font-normal`}>
                        {(tokenSymbol || tokenMetadata.symbol || '?').charAt(0).toUpperCase()}
                    </span>
                </div>
            </div>
        );
    }

    return (
        <div className={`${sizeClasses[size]} bg-slate-700 rounded-full flex items-center justify-center flex-shrink-0 border border-slate-600 ${className}`}>
            <span className={`text-white ${textSizeClasses[size]} font-normal`}>
                {(tokenSymbol || '?').charAt(0).toUpperCase()}
            </span>
        </div>
    );
};

export default TokenLogo;
