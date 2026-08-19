import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import {
    ReplayCoordinator,
    type ReplayEvent,
    type ReplaySnapshot,
} from './coordinator';

export type ReplaySpeed = 1 | 20 | 100 | 'max';
export type ReplayWait = (delayMs: number, signal: AbortSignal) => Promise<void>;
export type ReplaySink = (event: ReplayEvent) => void;

export interface ReplayTimer {
    nowMs(): number;
    wait: ReplayWait;
}

export interface ReplayRun {
    readonly emitted: number;
    readonly snapshot: ReplaySnapshot;
}

const maxBurst = 512;
const maxDelayMs = 2_147_483_647;

export const parseReplaySpeed = (value: unknown): ReplaySpeed => {
    if (value === 1 || value === 20 || value === 100 || value === 'max') return value;
    throw new Error('Replay speed is invalid');
};

const timerWait: ReplayWait = async (delayMs, signal) => {
    let remaining = delayMs;
    while (remaining > 0 && !signal.aborted) {
        const part = Math.min(remaining, maxDelayMs);
        try {
            await delay(part, undefined, { signal });
        } catch (error) {
            if (!signal.aborted) throw error;
        }
        remaining -= part;
    }
    if (delayMs === 0 && !signal.aborted) await delay(0);
};

const systemTimer: ReplayTimer = {
    nowMs: () => performance.now(),
    wait: timerWait,
};

export class ReplayScheduler {
    private active = false;

    constructor(
        private readonly coordinator: ReplayCoordinator,
        private readonly sink: ReplaySink,
        private readonly timer: ReplayTimer = systemTimer
    ) {}

    async run(
        value: unknown,
        signal: AbortSignal = new AbortController().signal
    ): Promise<ReplayRun> {
        const speed = parseReplaySpeed(value);
        if (this.active) throw new Error('Replay scheduler is already active');
        const before = this.coordinator.snapshot();
        if (before.status === 'complete') return { emitted: 0, snapshot: before };
        if (before.status !== 'paused') {
            throw new Error(`Replay scheduler cannot run a ${before.status} replay`);
        }
        if (signal.aborted) return { emitted: 0, snapshot: before };
        const wallStart = this.timer.nowMs();
        if (!Number.isFinite(wallStart) || wallStart < 0) {
            throw new Error('Replay scheduler timer is invalid');
        }

        this.active = true;
        let emitted = 0;
        let burst = 0;
        let sourceMs = 0;
        this.coordinator.resume();
        try {
            while (this.coordinator.currentStatus() === 'running') {
                const gapMs = this.coordinator.nextDelayMs();
                if (gapMs === null) break;
                sourceMs += gapMs;
                let waitMs = 0;
                if (speed !== 'max') {
                    const wallMs = this.timer.nowMs() - wallStart;
                    if (!Number.isFinite(wallMs) || wallMs < 0) {
                        this.coordinator.pause();
                        throw new Error('Replay scheduler timer is not monotonic');
                    }
                    waitMs = Math.max(0, Math.ceil(sourceMs / speed - wallMs));
                }
                if (waitMs > 0 || burst >= maxBurst) {
                    try {
                        await this.timer.wait(waitMs, signal);
                    } catch (error) {
                        if (this.coordinator.currentStatus() === 'running') {
                            this.coordinator.pause();
                        }
                        throw error;
                    }
                    burst = 0;
                    if (signal.aborted && this.coordinator.currentStatus() === 'running') {
                        this.coordinator.pause();
                    }
                    if (this.coordinator.currentStatus() !== 'running') break;
                }

                try {
                    const event = this.coordinator.next();
                    if (event === undefined) break;
                    this.sink(event);
                } catch (error) {
                    this.coordinator.stop();
                    throw error;
                }
                emitted += 1;
                burst += 1;
            }
            return { emitted, snapshot: this.coordinator.snapshot() };
        } finally {
            this.active = false;
        }
    }
}
