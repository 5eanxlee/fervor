import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

if (process.env.NODE_ENV !== 'test') {
    dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
}

const PLACEHOLDER_PATTERN = /^(your_|placeholder|changeme|change_me|replace_me|replace-|example|test-secret|secret|password|xxx|null|undefined|none)/i;

const requiredSecret = (name: string, minLength = 32) =>
    z.string()
        .trim()
        .min(minLength, `${name} must be at least ${minLength} characters`)
        .refine((value) => !PLACEHOLDER_PATTERN.test(value), `${name} cannot be a placeholder value`);

const optionalSecret = z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') return value;

    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}, z.string()
    .min(1)
    .refine((value) => !PLACEHOLDER_PATTERN.test(value), 'Optional secrets cannot be placeholder values')
    .optional());

const booleanFromEnv = z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return value;
}, z.boolean());

export const EXECUTION_LEASE_MARGIN_MS = 5_000;

const optionalText = z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}, z.string().min(1).optional());

const optionalDatabaseUrl = z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}, z.string().url().superRefine((value, ctx) => {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Database URLs must use postgres or postgresql',
        });
    }
    if (!url.pathname || url.pathname === '/') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Database URLs must name a database',
        });
    }
    if (url.hash) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Database URLs must not contain fragments',
        });
    }
    for (const key of url.searchParams.keys()) {
        const tlsParam = ['sslcert', 'sslkey', 'sslrootcert', 'sslmode'].includes(key.toLowerCase());
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: tlsParam
                ? 'Database URL TLS parameters are not allowed; use DB_SSL_MODE and DB_SSL_CA'
                : 'Database URL query parameters are not allowed; use explicit runtime settings',
        });
    }
}).optional());

const databaseEndpoint = (value?: string): string | null => {
    if (!value) return null;
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return `${host}:${url.port || '5432'}`;
};

const optionalPoolSize = (min: number) => z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    return value;
}, z.coerce.number().int().min(min).max(500).optional());

const optionalProviderSecret = z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') return value;
    return value.trim();
}, optionalSecret);

const EnvSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(3010),
    DATABASE_URL: optionalDatabaseUrl,
    CORE_DATABASE_URL: optionalDatabaseUrl,
    MARKET_DATABASE_URL: optionalDatabaseUrl,
    DB_COLOCATED: booleanFromEnv.default(false),
    REDIS_URL: z.string().trim().optional(),
    DB_POOL_MAX: optionalPoolSize(1),
    DB_POOL_MIN: optionalPoolSize(0),
    CORE_DB_POOL_MAX: optionalPoolSize(1),
    CORE_DB_POOL_MIN: optionalPoolSize(0),
    MARKET_DB_POOL_MAX: optionalPoolSize(1),
    MARKET_DB_POOL_MIN: optionalPoolSize(0),
    EGRESS_DB_POOL_MAX: optionalPoolSize(1),
    EGRESS_DB_POOL_MIN: optionalPoolSize(0),
    EGRESS_ACQUIRE_MS: z.coerce.number().int().min(100).max(60000).default(1000),
    EGRESS_RECOVERY_MS: z.coerce.number().int().min(100).max(60000).default(1000),
    EGRESS_RECOVERY_BATCH: z.coerce.number().int().min(1).max(1000).default(256),
    EGRESS_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(9465),
    EGRESS_MAX_ERRORS: z.coerce.number().int().min(1).max(100).default(5),
    DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),
    DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(30000),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(15000),
    CORE_DB_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).optional(),
    MARKET_DB_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).optional(),
    DB_SSL_MODE: z.enum(['disable', 'require', 'verify-full']).default('disable'),
    DB_SSL_CA: optionalText,
    JWT_SECRET: requiredSecret('JWT_SECRET'),
    AUTH_USER_CACHE_TTL_SEC: z.coerce.number().int().min(5).max(3600).default(60),
    FRONTEND_URL: z.string().url().default('http://localhost:3002'),
    HELIUS_API_KEY: optionalProviderSecret,
    HELIUS_API_URL: z.string().url().default('https://mainnet.helius-rpc.com'),
    HELIUS_LASERSTREAM_ENDPOINT: z.string().url().default('https://laserstream-mainnet-ewr.helius-rpc.com'),
    HELIUS_LASERSTREAM_REGION: z.string().trim().min(1).default('ewr'),
    LASERSTREAM_REPLAY_ENABLED: booleanFromEnv.default(true),
    MARKET_DATA_PROVIDER: z.literal('helius_laserstream').default('helius_laserstream'),
    LATENCY_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
    MARKET_DATA_COMMITMENT: z.enum(['processed', 'confirmed', 'finalized']).default('confirmed'),
    MARKET_DATA_REPLAY_WINDOW_SLOTS: z.coerce.number().int().positive().default(216000),
    JUPITER_API_KEY: optionalProviderSecret,
    JUPITER_API_URL: z.string().url().default('https://api.jup.ag'),
    JUPITER_RATE_PER_MIN: z.coerce.number().int().min(1).max(1000000).default(60),
    JUPITER_EXEC_RATE_PER_SEC: z.coerce.number().int().min(1).max(100000).default(50),
    JUPITER_RETRY_MAX_MS: z.coerce.number().int().min(1000).max(3600000).default(300000),
    REF_PRICE_TTL_MS: z.coerce.number().int().min(250).max(60000).default(5000),
    REF_PRICE_MAX_STALE_MS: z.coerce.number().int().min(1000).max(600000).default(60000),
    SUPPLY_TTL_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
    SUPPLY_MAX_STALE_MS: z.coerce.number().int().min(1000).max(86400000).default(300000),
    LIQUIDITY_TTL_MS: z.coerce.number().int().min(50).max(60000).default(250),
    SOLANA_RPC_URL: z.string().url().optional(),
    TRADING_MODE: z.enum(['disabled', 'live']).default('disabled'),
    ORDER_MODE: z.enum(['disabled', 'live']).default('disabled'),
    ORDER_OP_LEASE_MS: z.coerce.number().int().min(1000).max(600000).default(30000),
    ORDER_SYNC_MAX_PAGES: z.coerce.number().int().min(1).max(100).default(20),
    TX_KEY_PROVIDER: z.enum(['disabled', 'aws_kms']).default('disabled'),
    TX_KMS_KEY_ID: optionalText,
    TX_KMS_KEY_ALLOWLIST: optionalText,
    TX_KMS_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
    TX_BLOB_TTL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(900_000),
    WALLET_TRACKING_MODE: z.enum(['disabled', 'live']).default('disabled'),
    WALLET_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(300000).default(15000),
    WALLET_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),
    WALLET_BACKFILL_LIMIT: z.coerce.number().int().min(1).max(1000).default(100),
    WALLET_LEASE_MS: z.coerce.number().int().min(5000).max(600000).default(60000),
    WALLET_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(16),
    WALLET_BACKOFF_MAX_MS: z.coerce.number().int().min(1000).max(3600000).default(300000),
    WALLET_SHARD_ID: z.coerce.number().int().min(0).default(0),
    WALLET_SHARD_COUNT: z.coerce.number().int().positive().default(1),
    ALLOW_LIVE_SUBMISSION: booleanFromEnv.default(false),
    QUOTE_TTL_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
    EXECUTION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),
    EXECUTION_OP_LEASE_MS: z.coerce.number().int().min(1000).max(600000).default(30000),
    EXECUTION_RECONCILE_MS: z.coerce.number().int().min(250).max(60000).default(2000),
    EXECUTION_RECONCILE_BATCH: z.coerce.number().int().min(1).max(256).default(256),
    EXECUTION_RECONCILE_LEASE_MS: z.coerce.number().int().min(1000).max(600000).default(25000),
    EXECUTION_SHARD_ID: z.coerce.number().int().min(0).default(0),
    EXECUTION_SHARD_COUNT: z.coerce.number().int().positive().default(1),
    EXECUTION_MAX_STUCK_MS: z.coerce.number().int().min(1000).max(86400000).default(300000),
    ORDER_MAX_STUCK_MS: z.coerce.number().int().min(1000).max(86400000).default(300000),
    MARKET_MAX_STALE_MS: z.coerce.number().int().min(1000).max(3600000).default(120000),
    OBS_COLLECT_MS: z.coerce.number().int().min(1000).max(300000).default(15000),
    MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(10000).default(5000),
    MAX_PRIORITY_FEE_LAMPORTS: z.coerce.number().int().min(1).max(100000000).default(10000000),
    MAX_JITO_TIP_LAMPORTS: z.coerce.number().int().min(1000).max(100000000).default(10000000),
    MAX_TRANSACTION_BYTES: z.coerce.number().int().min(512).max(10000).default(3000),
    TELEGRAM_BOT_TOKEN: optionalSecret,
    DISCORD_BOT_TOKEN: optionalSecret,
    DISCORD_CLIENT_ID: z.string().trim().min(1).optional(),
    DISCORD_SKIP_COMMAND_REGISTRATION: booleanFromEnv.default(false),
    BOT_GATEWAY_ENABLED: booleanFromEnv.default(false),
    METRICS_BEARER_TOKEN: optionalProviderSecret,
    DB_LOG_QUERIES: booleanFromEnv.default(false),
    ENABLE_NOTIFICATION_RETRY_WORKER: booleanFromEnv.default(true),
    NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
    NOTIFICATION_RETRY_BASE_MS: z.coerce.number().int().positive().default(30000),
    NOTIFICATION_RETRY_MAX_MS: z.coerce.number().int().positive().default(3600000),
    NOTIFICATION_MAX_PROVIDER_CONCURRENCY: z.coerce.number().int().positive().default(50),
    NOTIFICATION_SEND_LEASE_MS: z.coerce.number().int().min(1000).max(600000).default(60000),
    NOTIFICATION_RATE_WINDOW_MS: z.coerce.number().int().min(100).max(60000).default(1000),
    TELEGRAM_RATE_PER_SEC: z.coerce.number().int().min(1).max(1000).default(25),
    TELEGRAM_CHAT_RATE_PER_SEC: z.coerce.number().int().min(1).max(100).default(1),
    DISCORD_RATE_PER_SEC: z.coerce.number().int().min(1).max(1000).default(45),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(200),
    OUTBOX_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(32),
    OUTBOX_LEASE_MS: z.coerce.number().int().min(1000).max(600000).default(60000),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(20),
    OUTBOX_POLL_MS: z.coerce.number().int().min(10).max(60000).default(100),
    OUTBOX_DEDUP_TTL_SEC: z.coerce.number().int().min(3600).max(31536000).default(604800),
    NOTIFICATION_MAX_DB_LATENCY_MS: z.coerce.number().int().positive().default(500),
    NOTIFICATION_MAX_RETRY_BACKLOG: z.coerce.number().int().positive().default(100000),
    ENABLE_TELEGRAM_NOTIFICATIONS: booleanFromEnv.default(false),
    ENABLE_DISCORD_NOTIFICATIONS: booleanFromEnv.default(false),
    ENABLE_MARKET_FEED: booleanFromEnv.default(false),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    FEED_SHARD_ID: z.coerce.number().int().min(0).default(0),
    FEED_SHARD_COUNT: z.coerce.number().int().positive().default(1),
    FEED_MAX_TOKENS_PER_CONNECTION: z.coerce.number().int().positive().default(100),
    FEED_RECONNECT_BASE_MS: z.coerce.number().int().positive().default(1000),
    FEED_RECONNECT_MAX_MS: z.coerce.number().int().positive().default(30000),
    REDIS_STREAM_BLOCK_MS: z.coerce.number().int().positive().default(5000),
    REDIS_STREAM_BATCH_SIZE: z.coerce.number().int().positive().default(100),
    REDIS_STREAM_STALE_MS: z.coerce.number().int().positive().default(60000),
    MARKET_EVENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),
    MARKET_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(32),
    MARKET_METRIC_BOOTSTRAP_BATCH: z.coerce.number().int().min(1).max(5000).default(1000),
    MARKET_METRIC_BOOTSTRAP_LEASE_MS: z.coerce.number().int().min(5000).max(600000).default(60000),
    MARKET_METRIC_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
    REDIS_STREAM_MAXLEN_PROVIDER_RAW: z.coerce.number().int().positive().default(1000000),
    REDIS_STREAM_MAXLEN_MARKET_EVENTS: z.coerce.number().int().positive().default(1000000),
    REDIS_STREAM_MAXLEN_TICKS: z.coerce.number().int().positive().default(500000),
    REDIS_STREAM_MAXLEN_NOTIFICATIONS: z.coerce.number().int().positive().default(2000000),
    REDIS_STREAM_MAXLEN_DEAD_LETTERS: z.coerce.number().int().positive().default(500000),
    TICK_BATCH_SIZE: z.coerce.number().int().positive().default(250),
    TICK_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
    TICK_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
    MATCHER_SHARD_ID: z.coerce.number().int().min(0).default(0),
    MATCHER_SHARD_COUNT: z.coerce.number().int().positive().default(1),
    RUST_MATCHER_RESYNC_SECS: z.coerce.number().int().min(30).default(300),
    RUST_MATCHER_VERSION: z.string().trim().min(1).default('rust-alert-matcher-1.0.0'),
}).superRefine((value, ctx) => {
    const coreUrl = value.CORE_DATABASE_URL ?? (value.DB_COLOCATED ? value.DATABASE_URL : undefined);
    const marketUrl = value.MARKET_DATABASE_URL ?? (value.DB_COLOCATED ? coreUrl : undefined);
    const corePoolMax = value.CORE_DB_POOL_MAX ?? value.DB_POOL_MAX ?? 10;
    const corePoolMin = value.CORE_DB_POOL_MIN ?? value.DB_POOL_MIN ?? 0;
    const marketPoolMax = value.MARKET_DB_POOL_MAX ?? value.DB_POOL_MAX ?? 10;
    const marketPoolMin = value.MARKET_DB_POOL_MIN ?? value.DB_POOL_MIN ?? 0;
    const egressPoolMax = value.EGRESS_DB_POOL_MAX ?? 4;
    const egressPoolMin = value.EGRESS_DB_POOL_MIN ?? 0;

    if (!coreUrl) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['CORE_DATABASE_URL'],
            message: 'CORE_DATABASE_URL is required; legacy DATABASE_URL fallback needs DB_COLOCATED=true',
        });
    }

    if (!marketUrl) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['MARKET_DATABASE_URL'],
            message: 'MARKET_DATABASE_URL is required; legacy DATABASE_URL fallback needs DB_COLOCATED=true',
        });
    }

    if (value.NODE_ENV === 'production') {
        if (value.DB_COLOCATED) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['DB_COLOCATED'],
                message: 'Production runtime cannot use DB_COLOCATED=true',
            });
        }
        if (!value.CORE_DATABASE_URL || !value.MARKET_DATABASE_URL) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['CORE_DATABASE_URL'],
                message: 'Production runtime requires explicit CORE_DATABASE_URL and MARKET_DATABASE_URL',
            });
        }
        if (value.DB_SSL_MODE !== 'verify-full') {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['DB_SSL_MODE'],
                message: 'Production runtime requires DB_SSL_MODE=verify-full',
            });
        }
    }

    if (coreUrl && marketUrl
        && databaseEndpoint(coreUrl) === databaseEndpoint(marketUrl)
        && (value.NODE_ENV === 'production' || !value.DB_COLOCATED)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['MARKET_DATABASE_URL'],
            message: value.NODE_ENV === 'production'
                ? 'Production runtime requires distinct core and market database endpoints'
                : 'A shared database endpoint requires DB_COLOCATED=true',
        });
    }

    for (const [minKey, min, maxKey, max] of [
        ['CORE_DB_POOL_MIN', corePoolMin, 'CORE_DB_POOL_MAX', corePoolMax],
        ['MARKET_DB_POOL_MIN', marketPoolMin, 'MARKET_DB_POOL_MAX', marketPoolMax],
        ['EGRESS_DB_POOL_MIN', egressPoolMin, 'EGRESS_DB_POOL_MAX', egressPoolMax],
    ] as const) {
        if (min <= max) continue;
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [minKey],
            message: `${minKey} cannot exceed ${maxKey}`,
        });
    }

    if (value.TRADING_MODE === 'live' || value.ORDER_MODE === 'live' || value.ALLOW_LIVE_SUBMISSION) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['ALLOW_LIVE_SUBMISSION'],
            message: 'Live financial mutations require the isolated mutation gateway',
        });
    }

    if (value.TX_KEY_PROVIDER === 'aws_kms' && !value.TX_KMS_KEY_ID) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['TX_KMS_KEY_ID'],
            message: 'TX_KMS_KEY_ID is required when TX_KEY_PROVIDER=aws_kms',
        });
    }

    if (value.NODE_ENV === 'production' && !value.REDIS_URL) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['REDIS_URL'],
            message: 'REDIS_URL is required for production stream and outbox coordination',
        });
    }

    if (value.EXECUTION_OP_LEASE_MS < value.EXECUTION_TIMEOUT_MS + EXECUTION_LEASE_MARGIN_MS) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['EXECUTION_OP_LEASE_MS'],
            message: `EXECUTION_OP_LEASE_MS must exceed EXECUTION_TIMEOUT_MS by at least ${EXECUTION_LEASE_MARGIN_MS}ms`,
        });
    }

    if (value.EXECUTION_RECONCILE_LEASE_MS < 2 * value.EXECUTION_TIMEOUT_MS + EXECUTION_LEASE_MARGIN_MS) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['EXECUTION_RECONCILE_LEASE_MS'],
            message: `EXECUTION_RECONCILE_LEASE_MS must cover two RPC calls plus ${EXECUTION_LEASE_MARGIN_MS}ms`,
        });
    }

    if (value.WALLET_LEASE_MS < 2 * value.WALLET_TIMEOUT_MS + EXECUTION_LEASE_MARGIN_MS) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['WALLET_LEASE_MS'],
            message: `WALLET_LEASE_MS must cover two provider calls plus ${EXECUTION_LEASE_MARGIN_MS}ms`,
        });
    }

    if (value.WALLET_TRACKING_MODE === 'live' && !value.HELIUS_API_KEY) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['HELIUS_API_KEY'],
            message: 'HELIUS_API_KEY is required for live wallet tracking',
        });
    }

    if (value.BOT_GATEWAY_ENABLED
        && !(value.ENABLE_TELEGRAM_NOTIFICATIONS && value.TELEGRAM_BOT_TOKEN)
        && !(value.ENABLE_DISCORD_NOTIFICATIONS && value.DISCORD_BOT_TOKEN && value.DISCORD_CLIENT_ID)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['BOT_GATEWAY_ENABLED'],
            message: 'BOT_GATEWAY_ENABLED requires a configured Telegram or Discord integration',
        });
    }

    if (value.FEED_SHARD_COUNT !== value.MATCHER_SHARD_COUNT) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['MATCHER_SHARD_COUNT'],
            message: 'MATCHER_SHARD_COUNT must equal FEED_SHARD_COUNT for partition-aligned tick routing',
        });
    }

    for (const [idKey, countKey] of [
        ['FEED_SHARD_ID', 'FEED_SHARD_COUNT'],
        ['MATCHER_SHARD_ID', 'MATCHER_SHARD_COUNT'],
        ['WALLET_SHARD_ID', 'WALLET_SHARD_COUNT'],
        ['EXECUTION_SHARD_ID', 'EXECUTION_SHARD_COUNT'],
    ] as const) {
        if (value[idKey] < value[countKey]) continue;
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [idKey],
            message: `${idKey} must be smaller than ${countKey}`,
        });
    }
}).transform((value) => ({
    ...value,
    CORE_DATABASE_URL: value.CORE_DATABASE_URL ?? value.DATABASE_URL!,
    MARKET_DATABASE_URL: value.MARKET_DATABASE_URL
        ?? value.CORE_DATABASE_URL
        ?? value.DATABASE_URL!,
    CORE_DB_POOL_MAX: value.CORE_DB_POOL_MAX ?? value.DB_POOL_MAX ?? 10,
    CORE_DB_POOL_MIN: value.CORE_DB_POOL_MIN ?? value.DB_POOL_MIN ?? 0,
    MARKET_DB_POOL_MAX: value.MARKET_DB_POOL_MAX ?? value.DB_POOL_MAX ?? 10,
    MARKET_DB_POOL_MIN: value.MARKET_DB_POOL_MIN ?? value.DB_POOL_MIN ?? 0,
    EGRESS_DB_POOL_MAX: value.EGRESS_DB_POOL_MAX ?? 4,
    EGRESS_DB_POOL_MIN: value.EGRESS_DB_POOL_MIN ?? 0,
    CORE_DB_TIMEOUT_MS: value.CORE_DB_TIMEOUT_MS ?? value.DB_STATEMENT_TIMEOUT_MS,
    MARKET_DB_TIMEOUT_MS: value.MARKET_DB_TIMEOUT_MS ?? value.DB_STATEMENT_TIMEOUT_MS,
}));

export type Env = z.infer<typeof EnvSchema>;

export const parseEnv = (rawEnv: NodeJS.ProcessEnv): Env => EnvSchema.parse({
    ...rawEnv,
    DB_SSL_MODE: rawEnv.DB_SSL_MODE || (rawEnv.NODE_ENV === 'production' ? 'verify-full' : 'disable'),
});

export const env = parseEnv(process.env);


export const isProduction = env.NODE_ENV === 'production';

export const latencySampleRate = env.LATENCY_SAMPLE_RATE ?? (isProduction ? 0.01 : 1);

export const isMarketDataProviderConfigured = (provider: string = env.MARKET_DATA_PROVIDER): boolean => {
    if (provider === 'helius_laserstream') return !!env.HELIUS_API_KEY;
    return false;
};
