import { FeedTick } from '../types';

interface SwapNotificationLike {
    slot?: number;
    signature?: string;
    blockTime?: number;
    swap?: {
        baseTokenMint?: string;
        quotePrice?: string | number;
        usdValue?: number;
        baseAmount?: string;
        swapType?: 'buy' | 'sell';
        sourceExchange?: string;
    };
}

const toNumber = (value: unknown, fallback = 0): number => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
};

export const normalizeSwapNotification = (message: SwapNotificationLike, receivedAt = new Date()): FeedTick | null => {
    const swap = message.swap;
    if (!swap?.baseTokenMint || !message.signature) {
        return null;
    }

    const price = toNumber(swap.quotePrice);
    const usdValue = toNumber(swap.usdValue);

    return {
        tokenAddress: swap.baseTokenMint,
        signature: message.signature,
        slot: toNumber(message.slot),
        blockTime: toNumber(message.blockTime),
        price,
        usdValue,
        baseAmount: swap.baseAmount,
        swapType: swap.swapType,
        sourceExchange: swap.sourceExchange,
        receivedAt: receivedAt.toISOString(),
    };
};
