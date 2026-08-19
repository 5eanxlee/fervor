export interface Clock {
    nowMs(): number;
}

export const realClock: Clock = {
    nowMs: () => Date.now(),
};

const validTime = (value: number): boolean =>
    Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;

export class VirtualClock implements Clock {
    private valueMs: number;

    constructor(startMs: number) {
        if (!validTime(startMs)) throw new Error('Virtual clock start is invalid');
        this.valueMs = startMs;
    }

    nowMs(): number {
        return this.valueMs;
    }

    advanceTo(nextMs: number): void {
        if (!validTime(nextMs) || nextMs < this.valueMs) {
            throw new Error('Virtual clock cannot move backward or outside the Date range');
        }
        this.valueMs = nextMs;
    }
}
