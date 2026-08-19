import { createHash } from 'node:crypto';
import {
    type PaperFact,
    type PaperFee,
    type PaperOrder,
} from './paperTypes';

export const paperPortfolioContract = 'fervor-paper-portfolio-v1' as const;

export interface PortfolioBinding {
    readonly sourceReplaySha256: string;
    readonly runId: string;
    readonly modelSha256: string;
}

export interface PaperNetFlow {
    readonly mint: string;
    readonly netRaw: string;
}

export interface PaperFeeTotal {
    readonly kind: PaperFee['kind'];
    readonly mint: string;
    readonly amountRaw: string;
}

export interface PaperPosition {
    readonly tokenMint: string;
    readonly quoteMint: string;
    readonly openQuantityRaw: string;
    readonly openCostRaw: string;
    readonly realizedPnlRaw: string;
    readonly unmatchedSoldRaw: string;
    readonly basisComplete: boolean;
}

export interface PaperPortfolio {
    readonly contract: typeof paperPortfolioContract;
    readonly sourceReplaySha256: string;
    readonly runId: string;
    readonly modelSha256: string;
    readonly orderCount: number;
    readonly factCount: number;
    readonly fillCount: number;
    readonly basisComplete: boolean;
    readonly netFlows: readonly PaperNetFlow[];
    readonly feeTotals: readonly PaperFeeTotal[];
    readonly positions: readonly PaperPosition[];
    readonly portfolioSha256: string;
}

interface Lot {
    quantity: bigint;
    cost: bigint;
}

interface MutablePosition {
    readonly tokenMint: string;
    readonly quoteMint: string;
    readonly lots: Lot[];
    head: number;
    openQuantity: bigint;
    openCost: bigint;
    realized: bigint;
    unmatched: bigint;
}

type PortfolioPayload = Omit<PaperPortfolio, 'portfolioSha256'>;

const raw = (value: string): bigint => BigInt(value);

const add = (totals: Map<string, bigint>, key: string, value: bigint): void => {
    totals.set(key, (totals.get(key) ?? 0n) + value);
};

const consume = (position: MutablePosition, requested: bigint): {
    readonly quantity: bigint;
    readonly cost: bigint;
} => {
    let remaining = requested;
    let quantity = 0n;
    let cost = 0n;
    while (remaining > 0n && position.head < position.lots.length) {
        const lot = position.lots[position.head];
        const taken = remaining < lot.quantity ? remaining : lot.quantity;
        const takenCost = taken === lot.quantity ? lot.cost : lot.cost * taken / lot.quantity;
        remaining -= taken;
        quantity += taken;
        cost += takenCost;
        lot.quantity -= taken;
        lot.cost -= takenCost;
        if (lot.quantity === 0n) position.head += 1;
    }
    position.openQuantity -= quantity;
    position.openCost -= cost;
    return { quantity, cost };
};

const positionView = (position: MutablePosition): PaperPosition => Object.freeze({
    tokenMint: position.tokenMint,
    quoteMint: position.quoteMint,
    openQuantityRaw: position.openQuantity.toString(),
    openCostRaw: position.openCost.toString(),
    realizedPnlRaw: position.realized.toString(),
    unmatchedSoldRaw: position.unmatched.toString(),
    basisComplete: position.unmatched === 0n,
});

const digest = (payload: PortfolioPayload): string => createHash('sha256')
    .update(paperPortfolioContract)
    .update('\0')
    .update(JSON.stringify(payload))
    .digest('hex');

export const projectPaperPortfolio = (
    binding: PortfolioBinding,
    orders: readonly PaperOrder[],
    facts: readonly PaperFact[]
): PaperPortfolio => {
    const orderMap = new Map(orders.map((order) => [order.id, order]));
    const flows = new Map<string, bigint>();
    const fees = new Map<string, { kind: PaperFee['kind']; mint: string; amount: bigint }>();
    const positions = new Map<string, MutablePosition>();
    let fillCount = 0;

    for (const fact of facts) {
        if (fact.kind !== 'fill') continue;
        const order = orderMap.get(fact.orderId);
        const fill = fact.fill;
        if (order === undefined || fill === undefined) {
            throw new Error('Validated paper fill is missing its order');
        }
        fillCount += 1;

        const buy = order.side === 'buy';
        if (fill.inputMint !== (buy ? order.quoteMint : order.tokenMint)
            || fill.outputMint !== (buy ? order.tokenMint : order.quoteMint)) {
            throw new Error('Paper portfolio fill orientation is invalid');
        }
        const input = raw(fill.inputRaw);
        const output = raw(fill.netOutputRaw);
        add(flows, fill.inputMint, -input);
        add(flows, fill.outputMint, output);
        for (const fee of fill.fees) {
            const feeAmount = raw(fee.amountRaw);
            const feeKey = `${fee.kind}\0${fee.mint}`;
            const total = fees.get(feeKey) ?? { kind: fee.kind, mint: fee.mint, amount: 0n };
            total.amount += feeAmount;
            fees.set(feeKey, total);
            if (fee.kind !== 'protocol') add(flows, fee.mint, -feeAmount);
        }

        const positionKey = `${order.tokenMint}\0${order.quoteMint}`;
        const position = positions.get(positionKey) ?? {
            tokenMint: order.tokenMint,
            quoteMint: order.quoteMint,
            lots: [],
            head: 0,
            openQuantity: 0n,
            openCost: 0n,
            realized: 0n,
            unmatched: 0n,
        };
        positions.set(positionKey, position);
        if (buy) {
            position.lots.push({ quantity: output, cost: input });
            position.openQuantity += output;
            position.openCost += input;
            continue;
        }

        const consumed = consume(position, input);
        const proceeds = output * consumed.quantity / input;
        position.realized += proceeds - consumed.cost;
        position.unmatched += input - consumed.quantity;
    }

    const netFlows = Object.freeze([...flows.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([mint, net]) => Object.freeze({ mint, netRaw: net.toString() })));
    const feeTotals = Object.freeze([...fees.values()]
        .sort((left, right) => left.kind.localeCompare(right.kind)
            || left.mint.localeCompare(right.mint))
        .map((fee) => Object.freeze({
            kind: fee.kind,
            mint: fee.mint,
            amountRaw: fee.amount.toString(),
        })));
    const positionViews = Object.freeze([...positions.values()]
        .sort((left, right) => left.tokenMint.localeCompare(right.tokenMint)
            || left.quoteMint.localeCompare(right.quoteMint))
        .map(positionView));
    const payload: PortfolioPayload = {
        contract: paperPortfolioContract,
        ...binding,
        orderCount: orders.length,
        factCount: facts.length,
        fillCount,
        basisComplete: positionViews.every((position) => position.basisComplete),
        netFlows,
        feeTotals,
        positions: positionViews,
    };
    return Object.freeze({ ...payload, portfolioSha256: digest(payload) });
};
