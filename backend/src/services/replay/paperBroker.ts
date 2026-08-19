import { createHash } from 'node:crypto';
import { z } from 'zod';
import { addressSchema } from '../../types/execution';
import { amountSchema, u64Schema, u64Text } from '../../types/amount';
import type { ReplayEvent, ReplaySnapshot } from './coordinator';

export const paperModelContract = 'fervor-paper-fill-v1' as const;
export const paperFactContract = 'fervor-paper-fact-v1' as const;

const bpsBase = 10_000n;
const orderId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const rawPriceSchema = z.object({
    quoteRaw: amountSchema,
    tokenRaw: amountSchema,
}).strict();
const fixedFeeSchema = z.object({
    kind: z.enum(['network', 'priority', 'rent']),
    mint: addressSchema,
    amountRaw: u64Schema,
}).strict();

export const paperModelSchema = z.object({
    contract: z.literal(paperModelContract),
    latency: z.object({
        clientMs: z.number().int().min(0).max(60_000),
        buildMs: z.number().int().min(0).max(60_000),
        submitMs: z.number().int().min(0).max(60_000),
    }).strict(),
    participationBps: z.number().int().min(1).max(10_000),
    maxLookaheadMs: z.number().int().min(1).max(86_400_000),
    priceGuardBps: z.number().int().min(0).max(9_999),
    protocolFeeBps: z.number().int().min(0).max(9_999),
    fixedFees: z.array(fixedFeeSchema).max(3),
    partialFill: z.literal('allow'),
}).strict().refine((model) => new Set(model.fixedFees.map((fee) => fee.kind)).size
    === model.fixedFees.length, {
    message: 'Fixed fee kinds must be unique',
    path: ['fixedFees'],
});

const orderBase = z.object({
    id: orderId,
    side: z.enum(['buy', 'sell']),
    tokenMint: addressSchema,
    quoteMint: addressSchema,
    inputRaw: amountSchema,
}).strict();
const marketOrder = orderBase.extend({
    kind: z.literal('market'),
    reference: rawPriceSchema,
}).strict();
const limitOrder = orderBase.extend({
    kind: z.literal('limit'),
    limit: rawPriceSchema,
}).strict();

export const paperOrderSchema = z.discriminatedUnion('kind', [marketOrder, limitOrder]);

export type PaperSide = 'buy' | 'sell';
export type PaperStatus =
    | 'pending'
    | 'eligible'
    | 'partially_filled'
    | 'filled'
    | 'expired'
    | 'cancelled';
export type PaperFactKind = 'intent' | 'eligible' | 'fill' | 'filled' | 'expired' | 'cancelled';
export type PaperRequest = z.infer<typeof paperOrderSchema>;
export type PaperModelInput = z.infer<typeof paperModelSchema>;

export interface RawPrice {
    readonly quoteRaw: string;
    readonly tokenRaw: string;
}

export interface PaperFee {
    readonly kind: 'protocol' | 'network' | 'priority' | 'rent';
    readonly mint: string;
    readonly amountRaw: string;
}

export interface PaperFill {
    readonly tradeId: string;
    readonly cursor: number;
    readonly observedAt: string;
    readonly inputMint: string;
    readonly outputMint: string;
    readonly inputRaw: string;
    readonly grossOutputRaw: string;
    readonly netOutputRaw: string;
    readonly price: RawPrice;
    readonly fees: readonly PaperFee[];
}

export interface PaperOrder {
    readonly id: string;
    readonly kind: 'market' | 'limit';
    readonly side: PaperSide;
    readonly status: PaperStatus;
    readonly tokenMint: string;
    readonly quoteMint: string;
    readonly inputRaw: string;
    readonly remainingRaw: string;
    readonly filledInputRaw: string;
    readonly grossOutputRaw: string;
    readonly netOutputRaw: string;
    readonly placedCursor: number;
    readonly placedAt: string | null;
    readonly eligibleAt: string | null;
    readonly expiresAt: string | null;
    readonly price: RawPrice;
    readonly modelSha256: string;
    readonly fills: readonly PaperFill[];
}

export interface PaperFact {
    readonly contract: typeof paperFactContract;
    readonly key: string;
    readonly runId: string;
    readonly epoch: number;
    readonly sourceReplaySha256: string;
    readonly modelSha256: string;
    readonly orderId: string;
    readonly seq: number;
    readonly kind: PaperFactKind;
    readonly status: PaperStatus;
    readonly cursor: number;
    readonly observedAt: string | null;
    readonly reason?: 'user' | 'lookahead_elapsed' | 'end_of_tape';
    readonly fill?: PaperFill;
}

interface PaperModel {
    readonly contract: typeof paperModelContract;
    readonly latency: Readonly<PaperModelInput['latency']>;
    readonly participationBps: number;
    readonly maxLookaheadMs: number;
    readonly priceGuardBps: number;
    readonly protocolFeeBps: number;
    readonly fixedFees: readonly Readonly<PaperModelInput['fixedFees'][number]>[];
    readonly partialFill: 'allow';
}

interface MutableOrder {
    readonly request: PaperRequest;
    readonly price: RawPrice;
    readonly placedCursor: number;
    readonly placedAt: string | null;
    eligibleMs: number | null;
    expiresMs: number | null;
    status: PaperStatus;
    remaining: bigint;
    filledInput: bigint;
    grossOutput: bigint;
    netOutput: bigint;
    fixedCharged: boolean;
    factSeq: number;
    readonly fills: PaperFill[];
}

type Binding = Pick<ReplaySnapshot, 'runId' | 'epoch' | 'sourceReplaySha256'>;

const gcd = (left: bigint, right: bigint): bigint => {
    let a = left;
    let b = right;
    while (b !== 0n) [a, b] = [b, a % b];
    return a;
};

const priceOf = (value: z.infer<typeof rawPriceSchema>): RawPrice => {
    const quote = BigInt(value.quoteRaw);
    const token = BigInt(value.tokenRaw);
    const divisor = gcd(quote, token);
    return Object.freeze({
        quoteRaw: (quote / divisor).toString(),
        tokenRaw: (token / divisor).toString(),
    });
};

const asU64 = (value: bigint, name: string): string => {
    const text = value.toString();
    if (u64Text(text) === undefined) throw new Error(`${name} exceeds an unsigned 64-bit amount`);
    return text;
};

const toIso = (value: number): string => new Date(value).toISOString();

const addMs = (base: number, delta: number): number => {
    const value = base + delta;
    if (!Number.isSafeInteger(value)) throw new Error('Paper order time is outside the safe range');
    return value;
};

const parseTime = (value: string): number => {
    const parsed = Date.parse(value);
    if (!Number.isSafeInteger(parsed) || toIso(parsed) !== value) {
        throw new Error('Paper broker requires canonical replay time');
    }
    return parsed;
};

const cloneFee = (fee: PaperFee): PaperFee => Object.freeze({ ...fee });
const cloneFill = (fill: PaperFill): PaperFill => Object.freeze({
    ...fill,
    price: Object.freeze({ ...fill.price }),
    fees: Object.freeze(fill.fees.map(cloneFee)),
});

const normalizeModel = (value: unknown): PaperModel => {
    const parsed = paperModelSchema.parse(value);
    const fixedFees = parsed.fixedFees
        .map((fee) => Object.freeze({ ...fee }))
        .sort((left, right) => left.kind.localeCompare(right.kind));
    return Object.freeze({
        contract: paperModelContract,
        latency: Object.freeze({ ...parsed.latency }),
        participationBps: parsed.participationBps,
        maxLookaheadMs: parsed.maxLookaheadMs,
        priceGuardBps: parsed.priceGuardBps,
        protocolFeeBps: parsed.protocolFeeBps,
        fixedFees: Object.freeze(fixedFees),
        partialFill: 'allow',
    });
};

const modelDigest = (model: PaperModel): string => createHash('sha256')
    .update(paperModelContract)
    .update('\0')
    .update(JSON.stringify(model))
    .digest('hex');

const terminal = (status: PaperStatus): boolean =>
    status === 'filled' || status === 'expired' || status === 'cancelled';

const marketPriceOk = (
    side: PaperSide,
    trade: RawPrice,
    reference: RawPrice,
    guardBps: number
): boolean => {
    const tradeQuote = BigInt(trade.quoteRaw);
    const tradeToken = BigInt(trade.tokenRaw);
    const refQuote = BigInt(reference.quoteRaw);
    const refToken = BigInt(reference.tokenRaw);
    const left = tradeQuote * refToken * bpsBase;
    const move = BigInt(guardBps);
    const right = refQuote * tradeToken * (side === 'buy' ? bpsBase + move : bpsBase - move);
    return side === 'buy' ? left <= right : left >= right;
};

const limitPriceOk = (side: PaperSide, trade: RawPrice, limit: RawPrice): boolean => {
    const left = BigInt(trade.quoteRaw) * BigInt(limit.tokenRaw);
    const right = BigInt(limit.quoteRaw) * BigInt(trade.tokenRaw);
    return side === 'buy' ? left <= right : left >= right;
};

export class ReplayPaperBroker {
    private readonly binding: Binding;
    private readonly model: PaperModel;
    private readonly modelSha: string;
    private readonly total: number;
    private readonly orderMap = new Map<string, MutableOrder>();
    private readonly factLog: PaperFact[] = [];
    private cursor: number;
    private now: string | null;

    constructor(snapshot: ReplaySnapshot, model: unknown) {
        if (snapshot.now !== null) parseTime(snapshot.now);
        if (!Number.isSafeInteger(snapshot.cursor)
            || !Number.isSafeInteger(snapshot.total)
            || !Number.isSafeInteger(snapshot.epoch)
            || snapshot.cursor < 0
            || snapshot.cursor > snapshot.total
            || snapshot.epoch < 1
            || snapshot.status !== 'paused'
            || (snapshot.cursor === 0) !== (snapshot.now === null)
            || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(snapshot.runId)
            || !/^[0-9a-f]{64}$/.test(snapshot.sourceReplaySha256)) {
            throw new Error('Paper broker binding is invalid');
        }
        this.binding = {
            runId: snapshot.runId,
            epoch: snapshot.epoch,
            sourceReplaySha256: snapshot.sourceReplaySha256,
        };
        this.cursor = snapshot.cursor;
        this.total = snapshot.total;
        this.now = snapshot.now;
        this.model = normalizeModel(model);
        this.modelSha = modelDigest(this.model);
    }

    modelSha256(): string {
        return this.modelSha;
    }

    place(value: unknown): PaperOrder {
        if (this.cursor >= this.total) throw new Error('Paper order requires remaining replay events');
        const request = paperOrderSchema.parse(value);
        if (request.tokenMint === request.quoteMint) {
            throw new Error('Paper order mints must differ');
        }
        if (this.orderMap.has(request.id)) throw new Error('Paper order ID already exists');
        const placedMs = this.now === null ? null : parseTime(this.now);
        const eligibleMs = placedMs === null ? null : addMs(placedMs, this.latencyMs());
        const price = priceOf(request.kind === 'market' ? request.reference : request.limit);
        const order: MutableOrder = {
            request,
            price,
            placedCursor: this.cursor,
            placedAt: this.now,
            eligibleMs,
            expiresMs: eligibleMs === null ? null : addMs(eligibleMs, this.model.maxLookaheadMs),
            status: 'pending',
            remaining: BigInt(request.inputRaw),
            filledInput: 0n,
            grossOutput: 0n,
            netOutput: 0n,
            fixedCharged: false,
            factSeq: 0,
            fills: [],
        };
        this.orderMap.set(request.id, order);
        this.emit(order, 'intent', this.cursor, this.now);
        return this.viewOf(order);
    }

    cancel(id: string): PaperOrder {
        const order = this.requireOrder(id);
        if (terminal(order.status)) throw new Error(`Paper order is already ${order.status}`);
        order.status = 'cancelled';
        this.emit(order, 'cancelled', this.cursor, this.now, 'user');
        return this.viewOf(order);
    }

    apply(event: ReplayEvent): readonly PaperFact[] {
        if (event.runId !== this.binding.runId
            || event.epoch !== this.binding.epoch
            || event.sourceReplaySha256 !== this.binding.sourceReplaySha256
            || event.cursor !== this.cursor) {
            throw new Error('Paper broker event is stale or out of sequence');
        }
        const eventMs = parseTime(event.trade.observedAt);
        if (this.now !== null && eventMs < parseTime(this.now)) {
            throw new Error('Paper broker event time moved backwards');
        }
        const factStart = this.factLog.length;
        const active: MutableOrder[] = [];
        for (const order of this.orderMap.values()) {
            if (terminal(order.status)) continue;
            if (order.eligibleMs === null) {
                order.eligibleMs = addMs(eventMs, this.latencyMs());
                order.expiresMs = addMs(order.eligibleMs, this.model.maxLookaheadMs);
            }
            if (eventMs >= order.expiresMs!) {
                order.status = 'expired';
                this.emit(order, 'expired', event.cursor, event.trade.observedAt, 'lookahead_elapsed');
                continue;
            }
            if (eventMs >= order.eligibleMs! && order.status === 'pending') {
                order.status = 'eligible';
                this.emit(order, 'eligible', event.cursor, event.trade.observedAt);
            }
            if (order.status === 'eligible' || order.status === 'partially_filled') active.push(order);
        }

        const matching = active.filter((order) => this.matches(order, event));
        if (matching.length > 0) this.fillEvent(matching, event);
        this.cursor += 1;
        this.now = event.trade.observedAt;
        return Object.freeze(this.factLog.slice(factStart));
    }

    finish(snapshot: ReplaySnapshot): readonly PaperFact[] {
        if (snapshot.runId !== this.binding.runId
            || snapshot.epoch !== this.binding.epoch
            || snapshot.sourceReplaySha256 !== this.binding.sourceReplaySha256
            || snapshot.cursor !== this.cursor
            || snapshot.cursor !== snapshot.total
            || snapshot.total !== this.total
            || snapshot.status !== 'complete'
            || snapshot.now !== this.now) {
            throw new Error('Paper broker completion does not match replay state');
        }
        const factStart = this.factLog.length;
        for (const order of this.orderMap.values()) {
            if (terminal(order.status)) continue;
            order.status = 'expired';
            this.emit(order, 'expired', this.cursor, this.now, 'end_of_tape');
        }
        return Object.freeze(this.factLog.slice(factStart));
    }

    order(id: string): PaperOrder {
        return this.viewOf(this.requireOrder(id));
    }

    orders(): readonly PaperOrder[] {
        return Object.freeze([...this.orderMap.values()].map((order) => this.viewOf(order)));
    }

    facts(): readonly PaperFact[] {
        return Object.freeze([...this.factLog]);
    }

    private fillEvent(orders: MutableOrder[], event: ReplayEvent): void {
        const tokenRaw = BigInt(amountSchema.parse(event.trade.tokenAmountRaw));
        const quoteRaw = BigInt(amountSchema.parse(event.trade.quoteAmountRaw));
        const tradePrice = priceOf({ quoteRaw: quoteRaw.toString(), tokenRaw: tokenRaw.toString() });
        const side = event.trade.side === 'sell' ? 'buy' : 'sell';
        const tradeInput = side === 'buy' ? quoteRaw : tokenRaw;
        let available = tradeInput * BigInt(this.model.participationBps) / bpsBase;

        for (const order of orders) {
            if (available === 0n) break;
            if (!this.priceOk(order, tradePrice)) continue;
            const input = order.remaining < available ? order.remaining : available;
            const tradeOutput = side === 'buy' ? tokenRaw : quoteRaw;
            const gross = input * tradeOutput / tradeInput;
            const fee = this.model.protocolFeeBps === 0 ? 0n
                : (gross * BigInt(this.model.protocolFeeBps) + bpsBase - 1n) / bpsBase;
            if (gross === 0n || fee >= gross) continue;
            const net = gross - fee;
            const fees: PaperFee[] = [];
            if (fee > 0n) {
                fees.push(Object.freeze({
                    kind: 'protocol',
                    mint: side === 'buy' ? order.request.tokenMint : order.request.quoteMint,
                    amountRaw: asU64(fee, 'Paper protocol fee'),
                }));
            }
            if (!order.fixedCharged) {
                fees.push(...this.model.fixedFees
                    .filter((item) => item.amountRaw !== '0')
                    .map((item) => Object.freeze({ ...item })));
                order.fixedCharged = true;
            }
            const fill: PaperFill = Object.freeze({
                tradeId: event.trade.idempotencyKey,
                cursor: event.cursor,
                observedAt: event.trade.observedAt,
                inputMint: side === 'buy' ? order.request.quoteMint : order.request.tokenMint,
                outputMint: side === 'buy' ? order.request.tokenMint : order.request.quoteMint,
                inputRaw: asU64(input, 'Paper fill input'),
                grossOutputRaw: asU64(gross, 'Paper fill output'),
                netOutputRaw: asU64(net, 'Paper net output'),
                price: tradePrice,
                fees: Object.freeze(fees),
            });
            order.remaining -= input;
            order.filledInput += input;
            order.grossOutput += gross;
            order.netOutput += net;
            order.fills.push(fill);
            available -= input;
            order.status = order.remaining === 0n ? 'filled' : 'partially_filled';
            this.emit(order, 'fill', event.cursor, event.trade.observedAt, undefined, fill);
            if (order.status === 'filled') {
                this.emit(order, 'filled', event.cursor, event.trade.observedAt);
            }
        }
    }

    private matches(order: MutableOrder, event: ReplayEvent): boolean {
        return event.trade.tokenMint === order.request.tokenMint
            && event.trade.quoteMint === order.request.quoteMint
            && (event.trade.side === 'buy' || event.trade.side === 'sell')
            && event.trade.side !== order.request.side;
    }

    private priceOk(order: MutableOrder, trade: RawPrice): boolean {
        return order.request.kind === 'market'
            ? marketPriceOk(order.request.side, trade, order.price, this.model.priceGuardBps)
            : limitPriceOk(order.request.side, trade, order.price);
    }

    private emit(
        order: MutableOrder,
        kind: PaperFactKind,
        cursor: number,
        observedAt: string | null,
        reason?: PaperFact['reason'],
        fill?: PaperFill
    ): void {
        const seq = order.factSeq;
        order.factSeq += 1;
        this.factLog.push(Object.freeze({
            contract: paperFactContract,
            key: `${this.binding.runId}:${this.binding.epoch}:${order.request.id}:${seq}`,
            ...this.binding,
            modelSha256: this.modelSha,
            orderId: order.request.id,
            seq,
            kind,
            status: order.status,
            cursor,
            observedAt,
            ...(reason === undefined ? {} : { reason }),
            ...(fill === undefined ? {} : { fill }),
        }));
    }

    private latencyMs(): number {
        return this.model.latency.clientMs
            + this.model.latency.buildMs
            + this.model.latency.submitMs;
    }

    private requireOrder(id: string): MutableOrder {
        const order = this.orderMap.get(id);
        if (order === undefined) throw new Error('Paper order does not exist');
        return order;
    }

    private viewOf(order: MutableOrder): PaperOrder {
        return Object.freeze({
            id: order.request.id,
            kind: order.request.kind,
            side: order.request.side,
            status: order.status,
            tokenMint: order.request.tokenMint,
            quoteMint: order.request.quoteMint,
            inputRaw: order.request.inputRaw,
            remainingRaw: asU64(order.remaining, 'Paper remaining input'),
            filledInputRaw: asU64(order.filledInput, 'Paper filled input'),
            grossOutputRaw: asU64(order.grossOutput, 'Paper gross output'),
            netOutputRaw: asU64(order.netOutput, 'Paper net output'),
            placedCursor: order.placedCursor,
            placedAt: order.placedAt,
            eligibleAt: order.eligibleMs === null ? null : toIso(order.eligibleMs),
            expiresAt: order.expiresMs === null ? null : toIso(order.expiresMs),
            price: Object.freeze({ ...order.price }),
            modelSha256: this.modelSha,
            fills: Object.freeze(order.fills.map(cloneFill)),
        });
    }
}
