import { Router, type Request, type Response } from 'express';
import { env } from '../config/env';
import { addressSchema } from '../types/execution';
import { FrameQueue } from '../services/realtime/frameQueue';
import {
    marketFanout,
    streamMessagesToSseEvents,
    type MarketFanout,
    type MarketNotice,
    type MarketSseEvent,
} from '../services/realtime/marketFanout';

export { streamMessagesToSseEvents };

const sse = (event: string, data: unknown, id?: string): Buffer => {
    const cursor = id && /^\d+-\d+$/.test(id) ? `id: ${id}\n` : '';
    return Buffer.from(`${cursor}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

const batchDelivery = (
    events: readonly MarketSseEvent[]
): 'exact' | 'ordered' | 'state' => {
    if (events.some((event) => event.delivery === 'exact')) return 'exact';
    if (events.some((event) => event.delivery === 'ordered')) return 'ordered';
    return 'state';
};

class SseSink {
    private readonly queue = new FrameQueue(env.RT_QUEUE_BYTES, env.RT_QUEUE_FRAMES);
    private blocked = false;
    private closed = false;
    private readonly drain = (): void => {
        this.blocked = false;
        this.flush();
    };

    constructor(
        private readonly res: Response,
        private readonly tokenMint: string,
        private readonly batch: boolean
    ) {}

    send(event: string, data: unknown, delivery: 'exact' | 'ordered' | 'state'): boolean {
        return this.push(sse(event, data), delivery, delivery === 'state' ? event : undefined);
    }

    notice(notice: MarketNotice): boolean {
        if (notice.type === 'draining') {
            this.send('decode_status', {
                tokenAddress: this.tokenMint,
                status: 'draining',
                createdAt: new Date().toISOString(),
            }, 'exact');
            this.res.end();
            this.close();
            return false;
        }
        if (notice.type === 'heartbeat') {
            return this.send('heartbeat', { tokenAddress: this.tokenMint, ts: notice.at }, 'state');
        }
        if (notice.type === 'source_error') {
            return this.send('decode_status', {
                tokenAddress: this.tokenMint,
                status: 'retrying',
                retryMs: notice.retryMs,
                createdAt: new Date().toISOString(),
            }, 'state');
        }
        if (this.batch) {
            const last = notice.events[notice.events.length - 1];
            const delivery = batchDelivery(notice.events);
            return this.push(sse('batch', {
                tokenAddress: this.tokenMint,
                events: notice.events.map(({ event, data, id }) => ({ event, data, id })),
                createdAt: new Date().toISOString(),
            }, last?.id), delivery, delivery === 'state' ? 'market_batch' : undefined);
        }
        for (const event of notice.events) {
            const key = event.delivery === 'state' ? event.event : undefined;
            if (!this.push(sse(event.event, event.data, event.id), event.delivery, key)) return false;
        }
        return true;
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.queue.clear();
        this.res.off('drain', this.drain);
    }

    private push(
        data: Buffer,
        delivery: 'exact' | 'ordered' | 'state',
        key?: string
    ): boolean {
        if (this.closed) return false;
        const result = this.queue.push({ data, delivery, key });
        if (result === 'overflow') {
            this.queue.clear();
            this.res.write(sse('decode_status', {
                tokenAddress: this.tokenMint,
                status: 'resync_required',
                createdAt: new Date().toISOString(),
            }));
            this.res.end();
            this.close();
            return false;
        }
        this.flush();
        return true;
    }

    private flush(): void {
        if (this.blocked || this.closed) return;
        let frame = this.queue.shift();
        while (frame) {
            if (!this.res.write(frame.data)) {
                this.blocked = true;
                this.res.once('drain', this.drain);
                return;
            }
            frame = this.queue.shift();
        }
    }
}

export const createStreamRouter = (fanout: Pick<MarketFanout, 'subscribe'>): Router => {
    const router = Router();
    router.get('/tokens/:tokenAddress', (req: Request, res: Response) => {
        const token = addressSchema.safeParse(req.params.tokenAddress);
        if (!token.success) {
            res.status(400).json({ success: false, error: 'Invalid token address' });
            return;
        }
        const tokenMint = token.data;
        const batch = req.query.batch === '1' || req.query.batch === 'true';
        const sink = new SseSink(res, tokenMint, batch);

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        sink.send('decode_status', {
            tokenAddress: tokenMint,
            status: 'connected',
            source: 'redis_streams_shared',
            createdAt: new Date().toISOString(),
        }, 'state');

        let unsubscribe = (): void => undefined;
        try {
            unsubscribe = fanout.subscribe(tokenMint, (notice) => {
                if (!sink.notice(notice)) unsubscribe();
            });
        } catch {
            sink.send('decode_status', {
                tokenAddress: tokenMint,
                status: 'error',
                createdAt: new Date().toISOString(),
            }, 'state');
            res.end();
            sink.close();
            return;
        }

        req.once('close', () => {
            unsubscribe();
            sink.close();
        });
    });
    return router;
};

export default createStreamRouter(marketFanout);
