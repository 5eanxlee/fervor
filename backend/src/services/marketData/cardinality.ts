const precision = 7;
const registers = 1 << precision;
export const cardinalityExactLimit = 64;
const maxRank = 33 - precision;

export type StoredCardinality =
    | { mode: 'exact'; values: string[] }
    | { mode: 'hll'; data: string };

export interface CardinalityValue {
    value: number;
    exact: boolean;
    errorPct: number;
}

const hash32 = (value: string): number => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
};

const rank = (hash: number): number => {
    const remaining = hash >>> precision;
    return remaining === 0 ? 33 - precision : Math.clz32(remaining) - precision + 1;
};

export class Cardinality {
    private values: Set<string> | null;
    private sketch: Uint8Array | null;

    constructor(stored?: StoredCardinality) {
        if (stored === undefined) {
            this.values = new Set();
            this.sketch = null;
            return;
        }
        if (stored.mode === 'hll') {
            if (typeof stored.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(stored.data)) {
                throw new Error('Invalid cardinality sketch');
            }
            const decoded = Buffer.from(stored.data, 'base64');
            if (decoded.length !== registers
                || decoded.toString('base64') !== stored.data
                || decoded.some((value) => value > maxRank)) {
                throw new Error('Invalid cardinality sketch');
            }
            this.values = null;
            this.sketch = Uint8Array.from(decoded);
            return;
        }
        if (stored.mode !== 'exact'
            || !Array.isArray(stored.values)
            || stored.values.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 256)
            || new Set(stored.values).size !== stored.values.length) {
            throw new Error('Invalid exact cardinality set');
        }
        this.values = new Set(stored.values);
        this.sketch = null;
        if (this.values.size > cardinalityExactLimit) this.promote();
    }

    add(value: string): void {
        if (this.values) {
            this.values.add(value);
            if (this.values.size > cardinalityExactLimit) this.promote();
            return;
        }
        this.addHash(hash32(value));
    }

    merge(other: Cardinality): void {
        if (other.values) {
            for (const value of other.values) this.add(value);
            return;
        }
        if (this.values) this.promote();
        for (let index = 0; index < registers; index += 1) {
            this.sketch![index] = Math.max(this.sketch![index], other.sketch![index]);
        }
    }

    result(): CardinalityValue {
        if (this.values) return { value: this.values.size, exact: true, errorPct: 0 };
        const alpha = 0.7213 / (1 + 1.079 / registers);
        let inverse = 0;
        let empty = 0;
        for (const value of this.sketch!) {
            inverse += 2 ** -value;
            if (value === 0) empty += 1;
        }
        let estimate = alpha * registers * registers / inverse;
        if (estimate <= 2.5 * registers && empty > 0) {
            estimate = registers * Math.log(registers / empty);
        }
        return {
            value: Math.max(0, Math.round(estimate)),
            exact: false,
            errorPct: Number((104 / Math.sqrt(registers)).toFixed(2)),
        };
    }

    serialize(): StoredCardinality {
        if (this.values) return { mode: 'exact', values: Array.from(this.values).sort() };
        return { mode: 'hll', data: Buffer.from(this.sketch!).toString('base64') };
    }

    private promote(): void {
        const values = this.values || [];
        this.values = null;
        this.sketch = new Uint8Array(registers);
        for (const value of values) this.addHash(hash32(value));
    }

    private addHash(hash: number): void {
        const index = hash & (registers - 1);
        this.sketch![index] = Math.max(this.sketch![index], rank(hash));
    }
}
