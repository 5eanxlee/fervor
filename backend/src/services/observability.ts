import { DbQuery, poolStats, query } from '../config/database';
import { env } from '../config/env';
import { redisStreams } from './redisStreamService';
import { metrics } from './metrics';

export interface ReadinessStatus {
    ready: boolean;
    degraded: boolean;
    checks: {
        database: boolean;
        redis: boolean;
        executionProvider: boolean;
        solanaRpc: boolean;
        orderProvider: boolean;
        walletProvider: boolean;
        telegramProvider: boolean;
        discordProvider: boolean;
        outboxBacklog: boolean;
        notificationBacklog: boolean;
        executionBacklog: boolean;
        orderBacklog: boolean;
        marketFresh: boolean;
    };
    backlog: OpsBacklog;
}

export interface OpsBacklog {
    outbox: number;
    outboxFailed: number;
    notifications: number;
    executions: number;
    executionRecoveries: number;
    executionAmbiguous: number;
    executionRepeated: number;
    executionRecoveryAgeMs: number | null;
    orders: number;
    marketAgeMs: number | null;
}

export interface OpsSample {
    backlog: OpsBacklog;
    ok: boolean;
    durationMs: number;
    lastSuccessMs: number;
}

const emptyBacklog = (): OpsBacklog => ({
    outbox: 0,
    outboxFailed: 0,
    notifications: 0,
    executions: 0,
    executionRecoveries: 0,
    executionAmbiguous: 0,
    executionRepeated: 0,
    executionRecoveryAgeMs: null,
    orders: 0,
    marketAgeMs: null,
});

let lastOpsSuccess = 0;

const writeOpsMetrics = (backlog: OpsBacklog): void => {
    metrics.gauge('fervor_outbox_backlog', backlog.outbox);
    metrics.gauge('fervor_outbox_failed', backlog.outboxFailed);
    metrics.gauge('fervor_notification_backlog', backlog.notifications);
    metrics.gauge('fervor_execution_stuck', backlog.executions);
    metrics.gauge('fervor_execution_recovery_pending', backlog.executionRecoveries);
    metrics.gauge('fervor_execution_ambiguous', backlog.executionAmbiguous);
    metrics.gauge('fervor_execution_repeated', backlog.executionRepeated);
    metrics.gauge('fervor_execution_recovery_age_ms', backlog.executionRecoveryAgeMs ?? 0);
    metrics.gauge('fervor_order_stuck', backlog.orders);
    metrics.gauge('fervor_market_age_ms', backlog.marketAgeMs ?? 0);
    metrics.gauge('fervor_market_sample_present', backlog.marketAgeMs === null ? 0 : 1);
    const pools = poolStats();
    for (const [plane, pool] of Object.entries(pools)) {
        metrics.gauge('fervor_db_pool_total', pool.total, { plane });
        metrics.gauge('fervor_db_pool_idle', pool.idle, { plane });
        metrics.gauge('fervor_db_pool_waiting', pool.waiting, { plane });
        metrics.gauge('fervor_db_pool_limit', pool.max, { plane });
    }
};

export const OPS_QUERY = `WITH outbox_pending AS (
                SELECT COUNT(*)::int AS outbox
                  FROM event_outbox
                 WHERE status IN ('pending', 'publishing')
             ), outbox_failed AS (
                SELECT COUNT(*)::int AS outbox_failed
                  FROM event_outbox
                 WHERE status = 'failed'
             ), execution_signed AS (
                SELECT COUNT(*)::int AS executions_signed
                  FROM trade_executions
                 WHERE state = 'signed'
                   AND COALESCE(broadcast_started_at, created_at)
                       < NOW() - ($1::text || ' milliseconds')::interval
             ), execution_chain AS (
                SELECT COUNT(*)::int AS executions_chain
                  FROM trade_executions
                 WHERE state IN ('submitted', 'processed', 'confirmed')
                   AND COALESCE(submitted_at, created_at)
                       < NOW() - ($1::text || ' milliseconds')::interval
             ), execution_recovery AS (
                SELECT COUNT(*)::int AS execution_recoveries,
                       COUNT(*) FILTER (
                           WHERE provider_status LIKE 'ambiguous%'
                       )::int AS execution_ambiguous,
                       COUNT(*) FILTER (
                           WHERE broadcast_count > 1
                       )::int AS execution_repeated,
                       CASE WHEN COUNT(*) = 0 THEN NULL
                            ELSE GREATEST(
                                0,
                                EXTRACT(EPOCH FROM (
                                    NOW() - MIN(COALESCE(broadcast_started_at, submitted_at, created_at))
                                )) * 1000
                            )
                       END AS execution_recovery_age_ms
                  FROM trade_executions
                 WHERE signature IS NOT NULL
                   AND (state IN ('submitted', 'processed', 'confirmed')
                        OR (state = 'signed' AND broadcast_started_at IS NOT NULL))
             ), notification_stats AS (
                SELECT COUNT(*)::int AS notifications
                  FROM notification_deliveries
                 WHERE status IN ('pending', 'sending', 'retry_scheduled')
             ), order_stats AS (
                SELECT COUNT(*)::int AS orders
                  FROM order_intents
                 WHERE state IN ('preparing', 'activating', 'cancel_pending')
                   AND updated_at < NOW() - ($2::text || ' milliseconds')::interval
             ), market_stats AS (
                SELECT (
                    SELECT EXTRACT(EPOCH FROM (NOW() - observed_at)) * 1000
                      FROM tokens
                     WHERE observed_at IS NOT NULL
                     ORDER BY observed_at DESC
                     LIMIT 1
                ) AS market_age_ms
             )
             SELECT *
               FROM outbox_pending
               CROSS JOIN outbox_failed
               CROSS JOIN execution_signed
               CROSS JOIN execution_chain
               CROSS JOIN execution_recovery
               CROSS JOIN notification_stats
               CROSS JOIN order_stats
               CROSS JOIN market_stats`;

export const collectOpsMetrics = async (
    db: DbQuery = query,
    now: () => number = Date.now
): Promise<OpsBacklog> => {
    try {
        const result = await db(
            OPS_QUERY,
            [env.EXECUTION_MAX_STUCK_MS, env.ORDER_MAX_STUCK_MS]
        );
        const row = result.rows[0] || {};
        const backlog: OpsBacklog = {
            outbox: Number(row.outbox || 0),
            outboxFailed: Number(row.outbox_failed || 0),
            notifications: Number(row.notifications || 0),
            executions: Number(row.executions_signed || 0) + Number(row.executions_chain || 0),
            executionRecoveries: Number(row.execution_recoveries || 0),
            executionAmbiguous: Number(row.execution_ambiguous || 0),
            executionRepeated: Number(row.execution_repeated || 0),
            executionRecoveryAgeMs: row.execution_recovery_age_ms === null
                || row.execution_recovery_age_ms === undefined
                ? null
                : Number(row.execution_recovery_age_ms),
            orders: Number(row.orders || 0),
            marketAgeMs: row.market_age_ms === null || row.market_age_ms === undefined
                ? null
                : Number(row.market_age_ms),
        };
        writeOpsMetrics(backlog);
        lastOpsSuccess = now() / 1000;
        metrics.gauge('fervor_ops_collect_ok', 1);
        metrics.gauge('fervor_ops_collect_last_success_unixtime', lastOpsSuccess);
        return backlog;
    } catch (error) {
        metrics.gauge('fervor_ops_collect_ok', 0);
        metrics.gauge('fervor_ops_collect_last_success_unixtime', lastOpsSuccess);
        metrics.increment('fervor_ops_collect_errors');
        throw error;
    }
};

export class OpsCollector {
    private timer?: NodeJS.Timeout;
    private pending?: Promise<boolean>;
    private backlog = emptyBacklog();
    private lastSuccessMs = 0;
    private durationMs = Number.POSITIVE_INFINITY;
    private ok = false;

    constructor(
        private readonly db: DbQuery = query,
        private readonly intervalMs = env.OBS_COLLECT_MS,
        private readonly onError: (error: unknown) => void = (error) => {
            console.error('[observability] Collection failed', {
                message: error instanceof Error ? error.message : String(error),
            });
        }
    ) {}

    start(): void {
        if (this.timer) return;
        metrics.gauge('fervor_ops_collect_ok', 0);
        metrics.gauge('fervor_ops_collect_last_success_unixtime', lastOpsSuccess);
        void this.run();
        this.timer = setInterval(() => void this.run(), this.intervalMs);
        this.timer.unref();
    }

    async run(): Promise<boolean> {
        if (this.pending) {
            metrics.increment('fervor_ops_collect_skipped');
            return this.pending;
        }
        const started = Date.now();
        const pending = collectOpsMetrics(this.db)
            .then((backlog) => {
                this.backlog = backlog;
                this.lastSuccessMs = Date.now();
                this.durationMs = this.lastSuccessMs - started;
                this.ok = true;
                return true;
            })
            .catch((error) => {
                this.durationMs = Date.now() - started;
                this.ok = false;
                this.onError(error);
                return false;
            })
            .finally(() => {
                if (this.pending === pending) this.pending = undefined;
            });
        this.pending = pending;
        return pending;
    }

    snapshot(nowMs = Date.now()): OpsSample {
        const fresh = this.lastSuccessMs > 0
            && nowMs - this.lastSuccessMs <= this.intervalMs + env.CORE_DB_TIMEOUT_MS;
        return {
            backlog: { ...this.backlog },
            ok: this.ok && fresh,
            durationMs: this.durationMs,
            lastSuccessMs: this.lastSuccessMs,
        };
    }

    async stop(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        await this.pending;
    }
}

export const opsCollector = new OpsCollector();

export const getReadiness = async (
    ping: () => Promise<boolean> = () => redisStreams.ping(),
    collector: OpsCollector = opsCollector
): Promise<ReadinessStatus> => {
    const checks = {
        database: false,
        redis: false,
        executionProvider: true,
        solanaRpc: true,
        orderProvider: true,
        walletProvider: true,
        telegramProvider: true,
        discordProvider: true,
        outboxBacklog: false,
        notificationBacklog: false,
        executionBacklog: false,
        orderBacklog: false,
        marketFresh: !env.MARKET_DATA_REQUIRED,
    };
    const sample = collector.snapshot();
    const backlog = sample.backlog;
    if (sample.ok) {
        checks.database = sample.durationMs <= env.NOTIFICATION_MAX_DB_LATENCY_MS;
        checks.outboxBacklog = backlog.outbox <= env.NOTIFICATION_MAX_RETRY_BACKLOG
            && backlog.outboxFailed === 0;
        checks.notificationBacklog = backlog.notifications <= env.NOTIFICATION_MAX_RETRY_BACKLOG;
        checks.executionBacklog = backlog.executions === 0;
        checks.orderBacklog = backlog.orders === 0;
        checks.marketFresh = !env.MARKET_DATA_REQUIRED
            || (backlog.marketAgeMs !== null && backlog.marketAgeMs <= env.MARKET_MAX_STALE_MS);
    }

    checks.redis = await ping();
    checks.executionProvider = env.TRADING_MODE === 'disabled';
    checks.orderProvider = env.ORDER_MODE === 'disabled';
    checks.walletProvider = env.WALLET_TRACKING_MODE !== 'live' || !!env.HELIUS_API_KEY;
    checks.telegramProvider = !env.ENABLE_TELEGRAM_NOTIFICATIONS || !!env.TELEGRAM_BOT_TOKEN;
    checks.discordProvider = !env.ENABLE_DISCORD_NOTIFICATIONS || !!env.DISCORD_BOT_TOKEN;

    const ready = checks.database
        && checks.redis
        && checks.executionProvider
        && checks.solanaRpc
        && checks.orderProvider
        && checks.walletProvider
        && checks.telegramProvider
        && checks.discordProvider;
    const degraded = !checks.outboxBacklog
        || !checks.notificationBacklog
        || !checks.executionBacklog
        || !checks.orderBacklog
        || !checks.marketFresh;

    return {
        ready,
        degraded,
        checks,
        backlog,
    };
};
