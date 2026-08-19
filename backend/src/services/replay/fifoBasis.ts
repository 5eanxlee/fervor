export interface FifoBasisState {
    readonly acquired: bigint;
    readonly sold: bigint;
    readonly coveredSold: bigint;
    readonly openQuantity: bigint;
    readonly openCost: bigint;
    readonly realized: bigint;
    readonly unmatchedSold: bigint;
}

interface Lot {
    quantity: bigint;
    cost: bigint;
}

export class FifoBasis {
    private readonly lots: Lot[] = [];
    private head = 0;
    private acquired = 0n;
    private sold = 0n;
    private coveredSold = 0n;
    private openQuantity = 0n;
    private openCost = 0n;
    private realized = 0n;
    private unmatchedSold = 0n;

    buy(quantity: bigint, cost: bigint): void {
        if (quantity <= 0n || cost <= 0n) throw new Error('FIFO buy is invalid');
        this.lots.push({ quantity, cost });
        this.acquired += quantity;
        this.openQuantity += quantity;
        this.openCost += cost;
    }

    sell(quantity: bigint, proceeds: bigint): void {
        if (quantity <= 0n || proceeds <= 0n) throw new Error('FIFO sell is invalid');
        this.sold += quantity;
        let remaining = quantity;
        let covered = 0n;
        let cost = 0n;
        while (remaining > 0n && this.head < this.lots.length) {
            const lot = this.lots[this.head];
            const taken = remaining < lot.quantity ? remaining : lot.quantity;
            const takenCost = taken === lot.quantity ? lot.cost : lot.cost * taken / lot.quantity;
            remaining -= taken;
            covered += taken;
            cost += takenCost;
            lot.quantity -= taken;
            lot.cost -= takenCost;
            if (lot.quantity === 0n) this.head += 1;
        }
        this.coveredSold += covered;
        this.openQuantity -= covered;
        this.openCost -= cost;
        this.realized += proceeds * covered / quantity - cost;
        this.unmatchedSold += remaining;
    }

    state(): FifoBasisState {
        return Object.freeze({
            acquired: this.acquired,
            sold: this.sold,
            coveredSold: this.coveredSold,
            openQuantity: this.openQuantity,
            openCost: this.openCost,
            realized: this.realized,
            unmatchedSold: this.unmatchedSold,
        });
    }
}
