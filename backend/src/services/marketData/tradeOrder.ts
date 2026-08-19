import type { NormalizedTradeEvent } from '../../types';

const chainOrder = (trade: NormalizedTradeEvent): number[] | undefined => {
    const values = [trade.slot, trade.txIndex, trade.instructionIndex, trade.eventIndex];
    return values.every((value) => Number.isSafeInteger(value)) ? values as number[] : undefined;
};

export const hasTradeOrder = (trade: NormalizedTradeEvent): boolean => chainOrder(trade) !== undefined;

export const tradeOrder = (left: NormalizedTradeEvent, right: NormalizedTradeEvent): number => {
    const leftChain = chainOrder(left);
    const rightChain = chainOrder(right);
    if (leftChain && rightChain) {
        for (let index = 0; index < leftChain.length; index += 1) {
            if (leftChain[index] !== rightChain[index]) {
                return leftChain[index] < rightChain[index] ? -1 : 1;
            }
        }
    } else {
        const leftMs = Date.parse(left.observedAt);
        const rightMs = Date.parse(right.observedAt);
        if (leftMs !== rightMs) return leftMs < rightMs ? -1 : 1;
    }
    return left.idempotencyKey.localeCompare(right.idempotencyKey);
};
