import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import crypto from 'crypto';
import { createServer, Server } from 'http';

import authRoutes from './routes/auth';
import alertRoutes from './routes/alerts';
import tokenRoutes from './routes/tokens';
import profileRoutes from './routes/profile';
import streamRoutes from './routes/streams';
import notificationPreferenceRoutes from './routes/notificationPreferences';
import notificationDeliveryRoutes from './routes/notificationDeliveries';
import executionRoutes from './routes/execution';
import orderRoutes from './routes/orders';
import walletRoutes from './routes/wallets';
import { createReplayRouter } from './routes/replay';
import { env, isProduction } from './config/env';
import { standardLimiter } from './middleware/rateLimits';
import { metrics } from './services/metrics';
import { getReadiness, opsCollector } from './services/observability';
import { traceMiddleware } from './middleware/trace';
import { closeDatabase } from './config/database';
import { redisStreams } from './services/redisStreamService';
import { createReplayGateway } from './services/replay/replayGateway';
import { ReplayFeed } from './services/realtime/replayFeed';
import { attachRealtime, type RealtimeServer } from './services/realtime/server';

const app = express();
const PORT = env.API_PORT;
if (env.TRUST_PROXY_HOPS > 0) app.set('trust proxy', env.TRUST_PROXY_HOPS);
const DEV_FRONTEND_PORTS = new Set(['3000', '3001', '3002', '3003', '3004', '3005']);

const allowedOrigins = new Set([env.FRONTEND_URL]);
const replayGateway = createReplayGateway(env);
const replayFeed = new ReplayFeed(replayGateway, {
    pollMs: env.RT_POLL_MS,
    resumeEvents: env.RT_RESUME_EVENTS,
    heartbeatMs: env.RT_HEARTBEAT_MS,
    maxSubs: env.RT_MAX_SUBS,
});

const isAllowedDevOrigin = (origin: string): boolean => {
    if (isProduction) return false;
    try {
        const url = new URL(origin);
        const isLoopbackHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
        return isLoopbackHost && DEV_FRONTEND_PORTS.has(url.port);
    } catch {
        return false;
    }
};

export const isAllowedOrigin = (origin: string | undefined): boolean =>
    origin === undefined || allowedOrigins.has(origin) || isAllowedDevOrigin(origin);

// Security middleware
app.use(helmet());
app.use(cors({
    origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) {
            callback(null, true);
            return;
        }

        callback(null, false);
    },
    credentials: true
}));

// Request logging
if (env.NODE_ENV !== 'test') {
    app.use(morgan('combined'));
}

// Body parsing middleware
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(traceMiddleware);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        service: 'api'
    });
});

app.get('/ready', async (req, res) => {
    const readiness = await getReadiness();
    res.status(readiness.ready ? 200 : 503).json({
        success: readiness.ready,
        data: readiness
    });
});

app.get('/metrics', (req, res) => {
    if (isProduction) {
        const expected = env.METRICS_BEARER_TOKEN;
        const provided = req.header('authorization')?.replace(/^Bearer\s+/i, '');
        if (!expected || !provided) return res.status(404).send('Not found');
        const left = Buffer.from(expected);
        const right = Buffer.from(provided);
        if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
            return res.status(404).send('Not found');
        }
    }
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(metrics.toPrometheus());
});

if (isProduction) app.use(standardLimiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/tokens', tokenRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/notification-preferences', notificationPreferenceRoutes);
app.use('/api/notification-deliveries', notificationDeliveryRoutes);
app.use('/api/stream', streamRoutes);
app.use('/api/execution', executionRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/wallets', walletRoutes);
app.use('/api/replay/v1', createReplayRouter(replayGateway));

// Global error handler
app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Unhandled error:', error);

    res.status(500).json({
        success: false,
        error: isProduction
            ? 'Internal server error'
            : error.message
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: `Route ${req.originalUrl} not found`
    });
});

// Graceful shutdown
let server: Server | undefined;
let realtime: RealtimeServer | undefined;
let stopping = false;

const gracefulShutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`[api] Received ${signal}, draining`);

    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    try {
        await realtime?.close();
        if (server) {
            await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
        }
        await Promise.all([
            opsCollector.stop(),
            redisStreams.close(),
        ]);
        await closeDatabase();
        clearTimeout(timeout);
        process.exit(0);
    } catch (error) {
        console.error('[api] Shutdown failed', error);
        process.exit(1);
    }
};

export const startServer = () => {
    process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

    server = createServer(app);
    realtime = attachRealtime(server, {
        feed: replayFeed,
        allowOrigin: isAllowedOrigin,
        config: {
            authMs: env.RT_AUTH_MS,
            heartbeatMs: env.RT_HEARTBEAT_MS,
            maxPayloadBytes: env.RT_MAX_PAYLOAD_BYTES,
            queueBytes: env.RT_QUEUE_BYTES,
            queueFrames: env.RT_QUEUE_FRAMES,
        },
    });
    server.listen(PORT, () => {
        console.log(`[FERVOR] Server running on port ${PORT}`);
        console.log(`[FERVOR] Health check: http://localhost:${PORT}/health`);
        console.log(`[FERVOR] API base URL: http://localhost:${PORT}/api`);

        opsCollector.start();
    });
    return server;
};

if (require.main === module) {
    startServer();
}

export default app; 
