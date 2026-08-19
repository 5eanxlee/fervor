import type { RtClass } from './protocol';

export interface QueuedFrame {
    readonly data: Buffer;
    readonly delivery: RtClass;
    readonly key?: string;
}

export type QueueResult = 'queued' | 'replaced' | 'overflow';

export class FrameQueue {
    private readonly frames: QueuedFrame[] = [];
    private bytes = 0;

    constructor(
        readonly maxBytes: number,
        readonly maxFrames: number
    ) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1
            || !Number.isSafeInteger(maxFrames) || maxFrames < 1) {
            throw new Error('Realtime queue limits are invalid');
        }
    }

    get byteLength(): number {
        return this.bytes;
    }

    get length(): number {
        return this.frames.length;
    }

    push(frame: QueuedFrame): QueueResult {
        if (frame.data.length > this.maxBytes
            || (frame.delivery === 'state' && !frame.key)
            || (frame.delivery !== 'state' && frame.key !== undefined)) {
            return 'overflow';
        }

        let replaced = false;
        if (frame.delivery === 'state') {
            const prior = this.frames.findIndex((queued) => queued.key === frame.key);
            if (prior >= 0) {
                this.remove(prior);
                replaced = true;
            }
        }

        while (this.wouldOverflow(frame)) {
            const replaceable = this.frames.findIndex((queued) => queued.delivery === 'state');
            if (replaceable < 0) return 'overflow';
            this.remove(replaceable);
        }

        this.frames.push(frame);
        this.bytes += frame.data.length;
        return replaced ? 'replaced' : 'queued';
    }

    shift(): QueuedFrame | undefined {
        const frame = this.frames.shift();
        if (frame) this.bytes -= frame.data.length;
        return frame;
    }

    clear(): void {
        this.frames.length = 0;
        this.bytes = 0;
    }

    private wouldOverflow(frame: QueuedFrame): boolean {
        return this.frames.length + 1 > this.maxFrames
            || this.bytes + frame.data.length > this.maxBytes;
    }

    private remove(index: number): void {
        const [removed] = this.frames.splice(index, 1);
        if (removed) this.bytes -= removed.data.length;
    }
}
