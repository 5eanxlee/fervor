import { amountSchema } from '../../types/amount';
import type { ReplayEvent, ReplaySnapshot } from './coordinator';
import {
    createPaperCheckpoint,
    parsePaperCheckpoint,
    type PaperCheckpoint,
    type PaperPayload,
} from './paperCheckpoint';
import {
    addMs,
    asU64,
    bpsBase,
    cloneFact,
    cloneFill,
    grossOf,
    limitPriceOk,
    marketPriceOk,
    modelDigest,
    normalizeModel,
    paperCheckpointContract,
    paperFactContract,
    paperModelContract,
    paperModelSchema,
    paperOrderSchema,
    parseCanonicalTime,
    parseTime,
    priceOf,
    protocolFee,
    terminal,
    toIso,
    type PaperFact,
    type PaperFactKind,
    type PaperFee,
    type PaperFill,
    type PaperModel,
    type PaperModelInput,
    type PaperOrder,
    type PaperRequest,
    type PaperSide,
    type PaperStatus,
    type RawPrice,
} from './paperTypes';

export {
    paperCheckpointContract,
    paperFactContract,
    paperModelContract,
    paperModelSchema,
    paperOrderSchema,
    parsePaperCheckpoint,
};
export type {
    PaperCheckpoint,
    PaperFact,
    PaperFactKind,
    PaperFee,
    PaperFill,
    PaperModel,
    PaperModelInput,
    PaperOrder,
    PaperRequest,
    PaperSide,
    PaperStatus,
    RawPrice,
};

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
        if (snapshot.now !== null) parseCanonicalTime(snapshot.now);
        if (!Number.isSafeInteger(snapshot.cursor)
            || !Number.isSafeInteger(snapshot.total)
            || !Number.isSafeInteger(snapshot.epoch)
            || snapshot.cursor < 0
            || snapshot.cursor > snapshot.total
            || snapshot.epoch < 1
            || (snapshot.status !== 'paused'
                && !(snapshot.status === 'complete' && snapshot.cursor === snapshot.total))
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

    static restore(snapshot: ReplaySnapshot, value: unknown, model: unknown): ReplayPaperBroker {
        const checkpoint = parsePaperCheckpoint(value);
        const broker = new ReplayPaperBroker(snapshot, model);
        if (checkpoint.runId !== snapshot.runId
            || checkpoint.sourceReplaySha256 !== snapshot.sourceReplaySha256
            || checkpoint.cursor !== snapshot.cursor
            || checkpoint.total !== snapshot.total
            || checkpoint.now !== snapshot.now
            || checkpoint.epoch > snapshot.epoch
            || checkpoint.modelSha256 !== broker.modelSha) {
            throw new Error('Paper checkpoint does not match replay state');
        }
        broker.hydrate(checkpoint);
        return broker;
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
        const placedMs = this.now === null ? null : parseCanonicalTime(this.now);
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
        const observedAt = toIso(eventMs);
        if (this.now !== null && eventMs < parseCanonicalTime(this.now)) {
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
                this.emit(order, 'expired', event.cursor, observedAt, 'lookahead_elapsed');
                continue;
            }
            if (eventMs >= order.eligibleMs! && order.status === 'pending') {
                order.status = 'eligible';
                this.emit(order, 'eligible', event.cursor, observedAt);
            }
            if (order.status === 'eligible' || order.status === 'partially_filled') active.push(order);
        }

        const matching = active.filter((order) => this.matches(order, event));
        if (matching.length > 0) this.fillEvent(matching, event, observedAt);
        this.cursor += 1;
        this.now = observedAt;
        return Object.freeze(this.factLog.slice(factStart));
    }

    checkpoint(snapshot: ReplaySnapshot): PaperCheckpoint {
        this.assertBound(snapshot);
        if (snapshot.status !== 'paused' && snapshot.status !== 'complete') {
            throw new Error(`${snapshot.status} replay cannot checkpoint paper state`);
        }
        const payload: PaperPayload = {
            contract: paperCheckpointContract,
            ...this.binding,
            cursor: this.cursor,
            total: this.total,
            now: this.now,
            model: this.model,
            modelSha256: this.modelSha,
            orders: this.orders(),
            facts: this.facts(),
        };
        return createPaperCheckpoint(payload);
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

    findOrder(id: string): PaperOrder | undefined {
        const order = this.orderMap.get(id);
        return order === undefined ? undefined : this.viewOf(order);
    }

    orderCount(): number {
        return this.orderMap.size;
    }

    orders(after = 0, limit = this.orderMap.size): readonly PaperOrder[] {
        if (!Number.isSafeInteger(after)
            || !Number.isSafeInteger(limit)
            || after < 0
            || limit < 0) {
            throw new Error('Paper order page is invalid');
        }
        const orders: PaperOrder[] = [];
        let index = 0;
        for (const order of this.orderMap.values()) {
            if (index >= after && orders.length < limit) orders.push(this.viewOf(order));
            index += 1;
            if (orders.length === limit) break;
        }
        return Object.freeze(orders);
    }

    factCount(): number {
        return this.factLog.length;
    }

    facts(after = 0, limit = this.factLog.length): readonly PaperFact[] {
        if (!Number.isSafeInteger(after)
            || !Number.isSafeInteger(limit)
            || after < 0
            || limit < 0) {
            throw new Error('Paper fact page is invalid');
        }
        return Object.freeze(this.factLog.slice(after, after + limit));
    }

    private fillEvent(orders: MutableOrder[], event: ReplayEvent, observedAt: string): void {
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
            const gross = grossOf(side, input, tradePrice);
            const fee = protocolFee(gross, this.model.protocolFeeBps);
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
                observedAt,
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
            this.emit(order, 'fill', event.cursor, observedAt, undefined, fill);
            if (order.status === 'filled') {
                this.emit(order, 'filled', event.cursor, observedAt);
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
            key: `${this.binding.sourceReplaySha256}:${this.binding.runId}:${order.request.id}:${seq}`,
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

    private assertBound(snapshot: ReplaySnapshot): void {
        if (snapshot.runId !== this.binding.runId
            || snapshot.epoch !== this.binding.epoch
            || snapshot.sourceReplaySha256 !== this.binding.sourceReplaySha256
            || snapshot.cursor !== this.cursor
            || snapshot.total !== this.total
            || snapshot.now !== this.now) {
            throw new Error('Paper broker is not bound to replay state');
        }
    }

    private hydrate(checkpoint: PaperCheckpoint): void {
        const factCounts = new Map<string, number>();
        for (const fact of checkpoint.facts) {
            factCounts.set(fact.orderId, (factCounts.get(fact.orderId) ?? 0) + 1);
        }
        for (const order of checkpoint.orders) {
            const request = paperOrderSchema.parse(order.kind === 'market' ? {
                id: order.id,
                kind: order.kind,
                side: order.side,
                tokenMint: order.tokenMint,
                quoteMint: order.quoteMint,
                inputRaw: order.inputRaw,
                reference: order.price,
            } : {
                id: order.id,
                kind: order.kind,
                side: order.side,
                tokenMint: order.tokenMint,
                quoteMint: order.quoteMint,
                inputRaw: order.inputRaw,
                limit: order.price,
            });
            this.orderMap.set(order.id, {
                request,
                price: order.price,
                placedCursor: order.placedCursor,
                placedAt: order.placedAt,
                eligibleMs: order.eligibleAt === null ? null : parseCanonicalTime(order.eligibleAt),
                expiresMs: order.expiresAt === null ? null : parseCanonicalTime(order.expiresAt),
                status: order.status,
                remaining: BigInt(order.remainingRaw),
                filledInput: BigInt(order.filledInputRaw),
                grossOutput: BigInt(order.grossOutputRaw),
                netOutput: BigInt(order.netOutputRaw),
                fixedCharged: order.fills.length > 0,
                factSeq: factCounts.get(order.id) ?? 0,
                fills: order.fills.map(cloneFill),
            });
        }
        this.factLog.push(...checkpoint.facts.map(cloneFact));
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
