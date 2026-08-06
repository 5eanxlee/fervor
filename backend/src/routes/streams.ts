import { Router, Request, Response } from 'express';
import { redisStreams, STREAMS, StreamName } from '../services/redisStreamService';

const router = Router();

const tokenFromPayload = (payload: any): string | undefined =>
    payload?.tokenMint || payload?.tokenAddress || payload?.token_mint || payload?.token_address;

const sanitizeUserEvent = (event: string, payload: any) => {
    if (event !== 'alert_candidate' && event !== 'alert_triggered') return payload;
    return {
        tokenAddress: payload.tokenAddress,
        thresholdType: payload.thresholdType,
        condition: payload.condition,
        currentValue: payload.currentValue,
        matchedAt: payload.matchedAt || payload.triggeredAt,
        engineVersion: payload.engineVersion,
    };
};

const eventNameForStream = (stream: StreamName): string => {
    if (stream === STREAMS.marketTrades) return 'trade';
    if (stream === STREAMS.marketStates) return 'market_state';
    if (stream === STREAMS.marketCandles) return 'candle';
    if (stream === STREAMS.alertCandidates) return 'alert_candidate';
    if (stream === STREAMS.alertsTriggered) return 'alert_triggered';
    return 'message';
};

const sendSse = (res: Response, event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
};

export const streamMessagesToSseEvents = (
    messages: Array<{ stream: StreamName; id: string; payload: any }>,
    tokenAddress: string
): Array<{ event: string; data: unknown; id: string }> => messages
    .filter((message) => tokenFromPayload(message.payload) === tokenAddress)
    .map((message) => {
        const event = eventNameForStream(message.stream);
        return {
            event,
            data: sanitizeUserEvent(event, message.payload),
            id: message.id,
        };
    });

router.get('/tokens/:tokenAddress', async (req: Request, res: Response) => {
    const tokenAddress = req.params.tokenAddress;
    const batch = req.query.batch === '1' || req.query.batch === 'true';
    const streams: StreamName[] = [
        STREAMS.marketTrades,
        STREAMS.marketStates,
        STREAMS.marketCandles,
        STREAMS.alertCandidates,
        STREAMS.alertsTriggered,
    ];
    const ids = streams.map(() => '$');
    let closed = false;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    sendSse(res, 'decode_status', {
        tokenAddress,
        status: 'connected',
        source: 'redis_streams',
        createdAt: new Date().toISOString(),
    });

    const heartbeat = setInterval(() => {
        if (!closed) sendSse(res, 'heartbeat', { tokenAddress, ts: Date.now() });
    }, 15_000);
    heartbeat.unref?.();

    req.on('close', () => {
        closed = true;
        clearInterval(heartbeat);
    });

    try {
        await redisStreams.connect();
        while (!closed) {
            const messages = await redisStreams.read<any>(streams, ids, 5_000, 100);
            for (const message of messages) {
                const streamIndex = streams.indexOf(message.stream);
                if (streamIndex >= 0) ids[streamIndex] = message.id;
            }
            const events = streamMessagesToSseEvents(messages, tokenAddress);
            if (batch && events.length > 0) {
                sendSse(res, 'batch', {
                    tokenAddress,
                    events: events.map(({ event, data, id }) => ({ event, data, id })),
                    createdAt: new Date().toISOString(),
                });
            } else {
                for (const event of events) {
                    sendSse(res, event.event, event.data);
                }
            }
        }
    } catch (error) {
        if (!closed) {
            sendSse(res, 'decode_status', {
                tokenAddress,
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
                createdAt: new Date().toISOString(),
            });
            res.end();
        }
    }
});

export default router;
