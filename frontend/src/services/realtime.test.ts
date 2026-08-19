import { describe, expect, it } from 'vitest';
import { isRtFrame, rtContract, rtUrl } from './realtime';

describe('realtime client contract', () => {
    it('maps absolute and same-origin API URLs to the websocket endpoint', () => {
        expect(rtUrl('https://api.example.com/api/')).toBe('wss://api.example.com/api/realtime/v1');
        expect(rtUrl('/api', 'https://terminal.example.com')).toBe('wss://terminal.example.com/api/realtime/v1');
        expect(rtUrl('http://localhost:3010/api')).toBe('ws://localhost:3010/api/realtime/v1');
    });

    it('accepts protocol frames and rejects malformed lookalikes', () => {
        expect(isRtFrame({
            contract: rtContract,
            type: 'delta',
            mode: 'historical_replay',
            sessionId: 'session',
            epoch: 1,
            sentAt: '2024-11-19T00:00:00.000Z',
            stream: 'trade',
            delivery: 'ordered',
            cursor: '2',
            prior: '1',
            scope: { tokenMint: '3an8rhdepsLCya22af7qDBKPbdomw8K4iCHXaA2Gpump' },
            observedAt: '2024-11-19T00:00:00.000Z',
            data: {},
        })).toBe(true);
        expect(isRtFrame({ contract: rtContract, type: 'delta', epoch: 1 })).toBe(false);
        expect(isRtFrame({ contract: 'other', type: 'error', message: 'no', retryable: false })).toBe(false);
    });
});
