'use client';

import { useEffect, useRef, useState } from 'react';
import {
    rtUrl,
    type RtFrame,
    type RtState,
    type RtStream,
    type RtWorkerIn,
    type RtWorkerOut,
} from '../services/realtime';
import { apiBase } from '../services/api';

interface RtOptions {
    enabled: boolean;
    token: string | null;
    tokenMint: string;
    streams: RtStream[];
    onFrames(frames: RtFrame[]): void;
}

export const useRealtime = ({ enabled, token, tokenMint, streams, onFrames }: RtOptions) => {
    const handler = useRef(onFrames);
    const [state, setState] = useState<RtState>(enabled ? 'connecting' : 'offline');
    const [reason, setReason] = useState<string>();
    const streamKey = streams.join(',');

    useEffect(() => {
        handler.current = onFrames;
    }, [onFrames]);

    useEffect(() => {
        if (!enabled || !token) {
            setState('offline');
            return;
        }
        const worker = new Worker(new URL('../workers/realtime.worker.ts', import.meta.url), {
            type: 'module',
            name: 'fervor-realtime',
        });
        worker.onmessage = (event: MessageEvent<RtWorkerOut>) => {
            if (event.data.type === 'frames') {
                try {
                    handler.current(event.data.frames);
                } finally {
                    worker.postMessage({ op: 'ack', id: event.data.id } satisfies RtWorkerIn);
                }
            } else {
                setState(event.data.state);
                setReason(event.data.reason);
            }
        };
        const message: RtWorkerIn = {
            op: 'connect',
            url: rtUrl(apiBase, window.location.origin),
            token,
            tokenMint,
            streams: streamKey.split(',') as RtStream[],
        };
        worker.postMessage(message);
        return () => {
            worker.postMessage({ op: 'disconnect' } satisfies RtWorkerIn);
            worker.terminate();
        };
    }, [enabled, streamKey, token, tokenMint]);

    return { state, reason };
};
