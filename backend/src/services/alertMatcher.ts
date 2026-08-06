import { query } from '../config/database';
import { env } from '../config/env';
import { AlertThresholdType, FeedTick, TokenAlert } from '../types';
import { AlertEventWriter, alertEventKey, candidateFromAlertTick } from './alertEventWriter';
import { metrics } from './metrics';
import { redisStreams, STREAMS, tickStream } from './redisStreamService';
import { shardForToken, type AlertIndexUpdate } from './subscriptionRegistry';
import { qualityForThreshold, valueForThreshold } from './alertValue';

interface Thresholds {
    above: TokenAlert[];
    below: TokenAlert[];
}

interface TokenIndex {
    metrics: Map<AlertThresholdType, Thresholds>;
}

const numeric = (value: unknown): number => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Number(value);
    return 0;
};

export class AlertIndex {
    private tokens = new Map<string, TokenIndex>();

    ownsToken(tokenAddress: string): boolean {
        return shardForToken(tokenAddress, env.MATCHER_SHARD_COUNT) === env.MATCHER_SHARD_ID;
    }

    async hydrate(): Promise<void> {
        const result = await query(
            `SELECT *
             FROM token_alerts
             WHERE is_active = true AND is_triggered = false`
        );
        const grouped = new Map<string, TokenAlert[]>();
        for (const alert of result.rows as TokenAlert[]) {
            if (!this.ownsToken(alert.token_address)) continue;
            const alerts = grouped.get(alert.token_address) || [];
            alerts.push(alert);
            grouped.set(alert.token_address, alerts);
        }
        this.tokens = new Map(Array.from(grouped, ([token, alerts]) => [token, this.build(alerts)]));
        metrics.gauge('fervor_alert_index_tokens', this.tokens.size);
        metrics.gauge('fervor_alert_index_alerts', Array.from(grouped.values()).reduce((sum, alerts) => sum + alerts.length, 0));
    }

    async refreshToken(tokenAddress: string): Promise<void> {
        if (!this.ownsToken(tokenAddress)) {
            this.tokens.delete(tokenAddress);
            return;
        }
        const result = await query(
            `SELECT *
             FROM token_alerts
             WHERE token_address = $1
               AND is_active = true
               AND is_triggered = false`,
            [tokenAddress]
        );
        if (result.rows.length === 0) {
            this.tokens.delete(tokenAddress);
        } else {
            this.tokens.set(tokenAddress, this.build(result.rows as TokenAlert[]));
        }
    }

    match(tick: FeedTick): TokenAlert[] {
        if (!this.ownsToken(tick.tokenAddress)) return [];
        const token = this.tokens.get(tick.tokenAddress);
        if (!token) return [];
        const matches: TokenAlert[] = [];
        for (const [type, thresholds] of token.metrics) {
            const value = valueForThreshold(type, tick);
            const quality = qualityForThreshold(type, tick);
            if (value === undefined || !Number.isFinite(value) || !quality
                || quality.stale || !Number.isFinite(quality.confidence)
                || quality.confidence < 0 || quality.confidence > 1) continue;
            const above = this.partition(thresholds.above, (alert) => numeric(alert.threshold_value) <= value);
            const below = this.partition(thresholds.below, (alert) => numeric(alert.threshold_value) >= value);
            matches.push(
                ...thresholds.above.slice(0, above),
                ...thresholds.below.slice(0, below)
            );
        }
        return matches;
    }

    private build(alerts: TokenAlert[]): TokenIndex {
        const metrics = new Map<AlertThresholdType, Thresholds>();
        for (const alert of alerts) {
            const group = metrics.get(alert.threshold_type) || { above: [], below: [] };
            group[alert.condition].push(alert);
            metrics.set(alert.threshold_type, group);
        }
        for (const group of metrics.values()) {
            group.above.sort((left, right) => numeric(left.threshold_value) - numeric(right.threshold_value));
            group.below.sort((left, right) => numeric(right.threshold_value) - numeric(left.threshold_value));
        }
        return { metrics };
    }

    private partition(alerts: TokenAlert[], matches: (alert: TokenAlert) => boolean): number {
        let low = 0;
        let high = alerts.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (matches(alerts[middle])) low = middle + 1;
            else high = middle;
        }
        return low;
    }
}

export { alertEventKey };

export class AlertMatcherService {
    constructor(
        private readonly index = new AlertIndex(),
        private readonly writer = new AlertEventWriter()
    ) {}

    async start(): Promise<void> {
        await redisStreams.connect();
        await redisStreams.ensureGroup(
            tickStream(env.MATCHER_SHARD_ID, env.MATCHER_SHARD_COUNT),
            'alert-matchers-v2'
        );
        await this.index.hydrate();
    }

    async handleTick(tick: FeedTick): Promise<number> {
        const done = metrics.timer('fervor_alert_match_ms');
        try {
            const matches = this.index.match(tick);
            let created = 0;
            for (const alert of matches) {
                if (await this.triggerAlert(alert, tick)) created += 1;
            }
            metrics.increment('fervor_alert_matches_checked');
            metrics.increment('fervor_alert_matches_triggered', undefined, created);
            return created;
        } finally {
            done();
        }
    }

    async refreshToken(tokenAddress: string): Promise<void> {
        await this.index.refreshToken(tokenAddress);
    }

    async handleIndexUpdate(update: AlertIndexUpdate): Promise<void> {
        if (!update?.tokenAddress) return;
        await this.refreshToken(update.tokenAddress);
        metrics.increment('fervor_alert_index_updates_processed', { type: update.type });
    }

    private async triggerAlert(alert: TokenAlert, tick: FeedTick): Promise<boolean> {
        return (await this.writer.writeCandidate(candidateFromAlertTick(alert, tick))).created;
    }
}
