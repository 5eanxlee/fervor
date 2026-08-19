import { VirtualClock } from '../clock';
import type { NormalizedTradeEvent } from '../../types';
import type { MetricReplay } from '../marketData/metricReplay';

export type ReplayStatus = 'paused' | 'running' | 'complete' | 'stopped';

export interface ReplayEvent {
    cursor: number;
    usdPriced: boolean;
    trade: Readonly<NormalizedTradeEvent>;
}

export interface ReplaySnapshot {
    sourceReplaySha256: string;
    cursor: number;
    total: number;
    status: ReplayStatus;
    now: string | null;
}

export class ReplayCoordinator {
    private readonly clock = new VirtualClock(0);
    private readonly events: NormalizedTradeEvent[];
    private readonly sourceSha: string;
    private cursor = 0;
    private status: ReplayStatus = 'paused';

    constructor(replay: MetricReplay) {
        this.sourceSha = replay.source.replaySha256;
        const enriched = new Map(replay.trades.map((trade) => [trade.idempotencyKey, trade]));
        if (enriched.size !== replay.trades.length) {
            throw new Error('Replay projection contains duplicate trade identities');
        }
        let priorMs = -1;
        this.events = replay.sourceTrades.map((source) => {
            const observedMs = Date.parse(source.observedAt);
            if (!Number.isSafeInteger(observedMs) || observedMs < priorMs) {
                throw new Error('Replay trade tape is not ordered by event time');
            }
            priorMs = observedMs;
            const trade = enriched.get(source.idempotencyKey) ?? source;
            enriched.delete(source.idempotencyKey);
            return trade;
        });
        if (this.events.length !== replay.source.trades || enriched.size > 0) {
            throw new Error('Replay trade tape differs from its verified projection');
        }
    }

    snapshot(): ReplaySnapshot {
        return {
            sourceReplaySha256: this.sourceSha,
            cursor: this.cursor,
            total: this.events.length,
            status: this.status,
            now: this.cursor === 0 ? null : new Date(this.clock.nowMs()).toISOString(),
        };
    }

    pause(): void {
        if (this.status === 'stopped') throw new Error('Stopped replay cannot be paused');
        if (this.status === 'running') this.status = 'paused';
    }

    resume(): void {
        if (this.status === 'complete' || this.status === 'stopped') {
            throw new Error(`${this.status} replay cannot be resumed`);
        }
        this.status = 'running';
    }

    step(): ReplayEvent | undefined {
        if (this.status === 'complete') return undefined;
        if (this.status !== 'paused') throw new Error('Replay step requires a paused run');
        return this.take();
    }

    next(): ReplayEvent | undefined {
        if (this.status === 'complete') return undefined;
        if (this.status !== 'running') throw new Error('Replay next requires a running run');
        return this.take();
    }

    stop(): void {
        this.status = 'stopped';
    }

    private take(): ReplayEvent {
        const trade = this.events[this.cursor];
        this.clock.advanceTo(Date.parse(trade.observedAt));
        const event = {
            cursor: this.cursor,
            usdPriced: trade.priceUsd !== undefined && trade.usdAmount !== undefined,
            trade,
        };
        this.cursor += 1;
        if (this.cursor === this.events.length) this.status = 'complete';
        return event;
    }
}
