import { describe, expect, it } from 'vitest';
import { FrameQueue } from '../src/services/realtime/frameQueue';
import {
    encodeFrame,
    parseClientFrame,
    rtContract,
    type RtDelta,
} from '../src/services/realtime/protocol';

const mint = 'So11111111111111111111111111111111111111112';

describe('realtime protocol', () => {
    it('accepts strict auth and subscription frames', () => {
        expect(parseClientFrame({
            contract: rtContract,
            op: 'auth',
            token: 'a'.repeat(64),
        })).toMatchObject({ op: 'auth' });
        expect(parseClientFrame({
            contract: rtContract,
            op: 'subscribe',
            tokenMint: mint,
            streams: ['trade', 'market'],
            resume: {
                sessionId: 'session-1',
                epoch: 1,
                cursors: { trade: '1740000000000-0' },
            },
        })).toMatchObject({ op: 'subscribe', tokenMint: mint });

        expect(() => parseClientFrame({
            contract: rtContract,
            op: 'subscribe',
            tokenMint: mint,
            streams: ['trade'],
            extra: true,
        })).toThrow();
        expect(() => parseClientFrame({
            contract: rtContract,
            op: 'subscribe',
            tokenMint: '../escape',
            streams: ['trade'],
        })).toThrow();
    });

    it('encodes an explicit ordered delta envelope', () => {
        const frame: RtDelta = {
            contract: rtContract,
            type: 'delta',
            mode: 'live',
            sessionId: 'session-1',
            epoch: 1,
            sentAt: '2026-08-19T00:00:00.000Z',
            stream: 'trade',
            delivery: 'ordered',
            cursor: '2-0',
            prior: '1-0',
            scope: { tokenMint: mint },
            observedAt: '2026-08-19T00:00:00.000Z',
            data: { side: 'buy' },
        };
        expect(JSON.parse(encodeFrame(frame).toString('utf8'))).toEqual(frame);
    });
});

describe('realtime frame queue', () => {
    const frame = (
        text: string,
        delivery: 'exact' | 'ordered' | 'state',
        key?: string
    ) => ({ data: Buffer.from(text), delivery, key });

    it('coalesces state at the newest causal position', () => {
        const queue = new FrameQueue(64, 4);
        expect(queue.push(frame('market-1', 'state', 'market:token'))).toBe('queued');
        expect(queue.push(frame('trade-1', 'ordered'))).toBe('queued');
        expect(queue.push(frame('market-2', 'state', 'market:token'))).toBe('replaced');

        expect(queue.shift()?.data.toString()).toBe('trade-1');
        expect(queue.shift()?.data.toString()).toBe('market-2');
        expect(queue.byteLength).toBe(0);
    });

    it('evicts replaceable state before exact or ordered frames', () => {
        const queue = new FrameQueue(16, 2);
        expect(queue.push(frame('state-one', 'state', 'one'))).toBe('queued');
        expect(queue.push(frame('state-two', 'state', 'two'))).toBe('queued');
        expect(queue.push(frame('fill', 'exact'))).toBe('queued');

        expect(queue.length).toBe(2);
        expect(queue.shift()?.data.toString()).toBe('state-two');
        expect(queue.shift()?.data.toString()).toBe('fill');
    });

    it('fails closed instead of dropping lossless frames', () => {
        const queue = new FrameQueue(10, 1);
        expect(queue.push(frame('trade-one', 'ordered'))).toBe('queued');
        expect(queue.push(frame('trade-two', 'ordered'))).toBe('overflow');
        expect(queue.push(frame('oversized-state', 'state', 'market'))).toBe('overflow');
        expect(queue.length).toBe(1);
        expect(queue.byteLength).toBe(9);
    });
});
