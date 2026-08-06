import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, runProc } from '../../db/tools/flyway-runner.mjs';
import { assertPlaneSplit } from '../../db/tools/plane-split.mjs';
import { read } from './spec-utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'db/tools/compose-flyway.sh');
const bindScript = path.join(root, 'db/tools/compose-runtime-bind.mjs');
const localResult = await runProc('docker', [
    'compose',
    '-f',
    path.join(root, 'docker-compose.yml'),
    'config',
    '--format',
    'json',
], { cwd: root, env: cleanEnv(), capture: true, timeoutMs: 30_000 });
if (localResult.timedOut) throw new Error('Local Compose rendering exceeded 30 seconds');
if (localResult.code !== 0) {
    throw new Error(`Local Compose rendering failed: ${localResult.stderr.trim()}`);
}
const local = JSON.parse(localResult.stdout);
for (const [name, port, volume] of [
    ['core-postgres', '55432', 'fervor-postgres-data'],
    ['market-postgres', '55433', 'fervor-market-postgres-data'],
]) {
    const service = local.services?.[name];
    if (!service || service.image !== 'postgres:16-alpine') {
        throw new Error(`Local Compose is missing the pinned ${name} plane`);
    }
    const published = service.ports?.find((item) => item.target === 5432)?.published;
    const data = service.volumes?.find((item) => item.target === '/var/lib/postgresql/data');
    if (published !== port || data?.source !== volume) {
        throw new Error(`${name} changed its isolated port or data volume`);
    }
}
if (local.services['core-postgres'].volumes[0].source
    === local.services['market-postgres'].volumes[0].source) {
    throw new Error('Local database planes share a data volume');
}
const splitScript = read(path.join(root, 'db/tools/compose-plane-split.mjs'));
if (!splitScript.includes('-----BEGIN CERTIFICATE-----')
    || !splitScript.includes('rejectUnauthorized: true')
    || !splitScript.includes('tls.checkServerIdentity(host, cert)')
    || !splitScript.includes('MIGRATION_TIMEOUT_SEC')) {
    throw new Error('Split-plane verifier does not fail closed on CA or timeout configuration');
}
const env = cleanEnv({
    CORE_DB_HOST: 'core.example',
    CORE_DB_PORT: '5432',
    CORE_DB_NAME: 'fervor_core',
    CORE_DB_USER: 'core_migrator',
    MARKET_DB_HOST: 'market.example',
    MARKET_DB_PORT: '5433',
    MARKET_DB_NAME: 'fervor_market',
    MARKET_DB_USER: 'market_migrator',
    MAINT_DB_USER: 'core_maintenance',
    MIGRATION_TIMEOUT_SEC: '600',
    CORE_DB_PASSWORD_FILE: '/tmp/fervor-core-password',
    CORE_DB_CA_FILE: '/tmp/fervor-core-ca',
    MARKET_DB_PASSWORD_FILE: '/tmp/fervor-market-password',
    MARKET_DB_CA_FILE: '/tmp/fervor-market-ca',
    MAINT_DB_PASSWORD_FILE: '/tmp/fervor-maint-password',
    FERVOR_ENV_FILE: path.join(root, 'tests/fixtures/production-runtime.fixture'),
});
const result = await runProc('docker', [
    'compose',
    '--profile',
    '*',
    '-f',
    path.join(root, 'docker-compose.prod.yml'),
    'config',
    '--format',
    'json',
], { cwd: root, env, capture: true, timeoutMs: 30_000 });
if (result.timedOut) throw new Error('Compose rendering exceeded 30 seconds');
if (result.code !== 0) throw new Error(`Compose rendering failed: ${result.stderr.trim()}`);

const compose = JSON.parse(result.stdout);
const runtimeServices = [
    'api', 'feed', 'candles', 'trade-enricher', 'market-metrics', 'matcher',
    'indexer', 'matcher-ts', 'alert-writer', 'notifications', 'outbox',
    'wallets', 'executions', 'egress-recovery', 'integrations',
];
for (const name of runtimeServices) {
    const runtime = compose.services[name];
    if (!runtime || runtime.environment?.NODE_ENV !== 'production'
        || runtime.environment?.DB_COLOCATED !== 'false') {
        throw new Error(`${name} does not enforce the production database-plane policy`);
    }
    const bind = runtime.depends_on?.['verify-runtime'];
    if (!bind || bind.condition !== 'service_completed_successfully' || bind.required !== true) {
        throw new Error(`${name} can start before runtime database targets are bound`);
    }
}
const recovery = compose.services['egress-recovery'];
if (recovery.environment?.EGRESS_HEALTH_PORT !== '9465'
    || JSON.stringify(recovery.healthcheck?.test) !== JSON.stringify([
        'CMD', 'wget', '-q', '--spider', 'http://127.0.0.1:9465/health',
    ])
    || recovery.healthcheck?.retries !== 3) {
    throw new Error('Egress recovery lacks a bounded worker-local health contract');
}
const retention = compose.services['blob-retention'];
const retentionEnv = {
    NODE_ENV: 'production',
    MAINT_DB_HOST: 'core.example',
    MAINT_DB_PORT: '5432',
    MAINT_DB_NAME: 'fervor_core',
    MAINT_DB_USER: 'core_maintenance',
    MAINT_DB_PASSWORD_FILE: '/run/secrets/maint_db_password',
    MAINT_DB_CA_FILE: '/run/secrets/maint_db_ca',
    MAINT_DB_SSL_MODE: 'verify-full',
    RETENTION_BATCH: '256',
    RETENTION_BATCH_MS: '15000',
    RETENTION_INTERVAL_MS: '30000',
    RETENTION_HEALTH_PORT: '9466',
    RETENTION_MAX_ERRORS: '5',
};
if (!retention
    || JSON.stringify(Object.entries(retention.environment ?? {}).sort())
        !== JSON.stringify(Object.entries(retentionEnv).sort())
    || JSON.stringify(retention.command) !== JSON.stringify(['node', 'dist/blob-retention.js'])
    || JSON.stringify(retention.healthcheck?.test) !== JSON.stringify([
        'CMD', 'wget', '-q', '--spider', 'http://127.0.0.1:9466/health',
    ])) {
    throw new Error('Blob retention lacks an isolated bounded worker contract');
}
const retentionSecrets = (retention.secrets ?? [])
    .map((item) => `${item.source}:${item.target}`)
    .sort();
if (JSON.stringify(retentionSecrets) !== JSON.stringify([
    'core_db_ca:maint_db_ca',
    'maint_db_password:maint_db_password',
])) {
    throw new Error('Blob retention does not mount only its maintenance database credentials');
}
if (Object.keys(retention.depends_on ?? {}).join(',') !== 'verify-runtime'
    || retention.depends_on['verify-runtime']?.condition !== 'service_completed_successfully'
    || retention.depends_on['verify-runtime']?.required !== true) {
    throw new Error('Blob retention can start before production database targets are bound');
}
const matcher = compose.services.matcher;
if (matcher.environment?.CORE_DATABASE_URL !== 'postgresql://core_runtime@core.example/fervor_core'
    || matcher.environment?.DB_SSL_MODE !== 'verify-full'
    || matcher.environment?.DATABASE_URL) {
    throw new Error('Rust matcher does not render with the explicit verified core database contract');
}
const matcherSource = read(path.join(root, 'fervor-feed-rs/src/bin/alert_matcher.rs'));
if (!matcherSource.includes('env = "CORE_DATABASE_URL"')
    || matcherSource.includes('env = "DATABASE_URL"')
    || !matcherSource.includes('production matcher requires DB_SSL_MODE=verify-full')) {
    throw new Error('Rust matcher source bypasses explicit core routing or verified TLS');
}
const services = ['validate-core', 'validate-market', 'migrate-core', 'migrate-market'];
const dependencies = {
    'validate-core': [],
    'validate-market': [],
    'migrate-core': ['verify-split'],
    'migrate-market': ['migrate-core', 'verify-split'],
};
for (const name of services) {
    const service = compose.services[name];
    if (!service) throw new Error(`Rendered Compose is missing ${name}`);
    const plane = name.endsWith('core') ? 'core' : 'market';
    const prefix = plane.toUpperCase();
    const expectedEnv = [
        `${prefix}_DB_HOST`, `${prefix}_DB_NAME`, `${prefix}_DB_PORT`,
        `${prefix}_DB_USER`, 'MIGRATION_TIMEOUT_SEC',
    ].sort();
    const keys = Object.keys(service.environment ?? {}).sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedEnv)) {
        throw new Error(`${name} exposes unexpected environment keys: ${keys.join(', ')}`);
    }
    const expectedValues = plane === 'core'
        ? { CORE_DB_HOST: 'core.example', CORE_DB_PORT: '5432', CORE_DB_NAME: 'fervor_core', CORE_DB_USER: 'core_migrator', MIGRATION_TIMEOUT_SEC: '600' }
        : { MARKET_DB_HOST: 'market.example', MARKET_DB_PORT: '5433', MARKET_DB_NAME: 'fervor_market', MARKET_DB_USER: 'market_migrator', MIGRATION_TIMEOUT_SEC: '600' };
    const actualValues = Object.entries(service.environment).sort(([left], [right]) => left.localeCompare(right));
    const sortedValues = Object.entries(expectedValues).sort(([left], [right]) => left.localeCompare(right));
    if (JSON.stringify(actualValues) !== JSON.stringify(sortedValues)) {
        throw new Error(`${name} changed a migration connection value`);
    }
    const mounts = (service.secrets ?? [])
        .map((secret) => `${secret.source}:${secret.target}`)
        .sort();
    const expectedSecrets = [
        `${plane}_db_ca:/run/secrets/${plane}_db_ca`,
        `${plane}_db_password:/run/secrets/${plane}_db_password`,
    ];
    if (JSON.stringify(mounts) !== JSON.stringify(expectedSecrets)) {
        throw new Error(`${name} does not mount only its plane credentials`);
    }
    const expectedCommand = [plane, name.startsWith('validate') ? 'validate' : 'migrate'];
    if (JSON.stringify(service.entrypoint) !== JSON.stringify(['/bin/sh', '/flyway/bin/compose-flyway.sh'])
        || JSON.stringify(service.command) !== JSON.stringify(expectedCommand)) {
        throw new Error(`${name} changed its fixed migration entrypoint or command`);
    }
    const runnerMount = (service.volumes ?? []).find((volume) => volume.target === '/flyway/bin/compose-flyway.sh');
    if (!runnerMount || runnerMount.source !== script || runnerMount.read_only !== true) {
        throw new Error(`${name} does not read-only mount the reviewed Compose runner`);
    }
    const actualDeps = Object.keys(service.depends_on ?? {}).sort();
    if (JSON.stringify(actualDeps) !== JSON.stringify(dependencies[name])) {
        throw new Error(`${name} has an unsafe migration dependency graph`);
    }
    for (const dependency of actualDeps) {
        if (service.depends_on[dependency].condition !== 'service_completed_successfully'
            || service.depends_on[dependency].required !== true) {
            throw new Error(`${name} does not require successful completion of ${dependency}`);
        }
    }
    if (JSON.stringify(service).includes('FLYWAY_URL')) {
        throw new Error(`${name} accepts an arbitrary JDBC URL`);
    }
}

const split = compose.services['verify-split'];
if (!split) throw new Error('Rendered Compose is missing verify-split');
const splitEnv = {
    CORE_DB_HOST: 'core.example',
    CORE_DB_PORT: '5432',
    CORE_DB_NAME: 'fervor_core',
    CORE_DB_USER: 'core_migrator',
    MARKET_DB_HOST: 'market.example',
    MARKET_DB_PORT: '5433',
    MARKET_DB_NAME: 'fervor_market',
    MARKET_DB_USER: 'market_migrator',
    MIGRATION_TIMEOUT_SEC: '600',
};
const actualSplitEnv = Object.entries(split.environment ?? {}).sort(([left], [right]) => left.localeCompare(right));
const expectedSplitEnv = Object.entries(splitEnv).sort(([left], [right]) => left.localeCompare(right));
if (JSON.stringify(actualSplitEnv) !== JSON.stringify(expectedSplitEnv)) {
    throw new Error('verify-split changed its discrete connection fields');
}
const splitSecrets = (split.secrets ?? []).map((item) => `${item.source}:${item.target}`).sort();
if (JSON.stringify(splitSecrets) !== JSON.stringify([
    'core_db_ca:/run/secrets/core_db_ca',
    'core_db_password:/run/secrets/core_db_password',
    'market_db_ca:/run/secrets/market_db_ca',
    'market_db_password:/run/secrets/market_db_password',
])) {
    throw new Error('verify-split does not mount both isolated plane credentials');
}
if (split.image !== 'fervor-backend:local'
    || JSON.stringify(split.entrypoint) !== JSON.stringify(['node', '/app/db/tools/compose-plane-split.mjs'])) {
    throw new Error('verify-split changed its reviewed image or entrypoint');
}
const splitDeps = Object.keys(split.depends_on ?? {}).sort();
if (JSON.stringify(splitDeps) !== JSON.stringify(['validate-core', 'validate-market', 'verify-runtime'])) {
    throw new Error('verify-split must follow runtime binding and both non-mutating validators');
}
for (const dependency of splitDeps) {
    if (split.depends_on[dependency].condition !== 'service_completed_successfully'
        || split.depends_on[dependency].required !== true) {
        throw new Error(`verify-split does not require successful completion of ${dependency}`);
    }
}
if (JSON.stringify(split).includes('DATABASE_URL') || JSON.stringify(split).includes('FLYWAY_URL')) {
    throw new Error('verify-split accepts an arbitrary database URL');
}

const runtimeBind = compose.services['verify-runtime'];
if (!runtimeBind
    || JSON.stringify(runtimeBind.entrypoint) !== JSON.stringify(['node', '/app/db/tools/compose-runtime-bind.mjs'])
    || runtimeBind.environment?.CORE_DATABASE_URL !== 'postgresql://core_runtime@core.example/fervor_core'
    || runtimeBind.environment?.MARKET_DATABASE_URL !== 'postgresql://market_runtime@market.example:5433/fervor_market'
    || runtimeBind.environment?.DB_SSL_MODE !== 'verify-full') {
    throw new Error('verify-runtime does not bind the rendered runtime URLs to migration targets');
}

const secretFiles = {
    core_db_password: '/tmp/fervor-core-password',
    core_db_ca: '/tmp/fervor-core-ca',
    market_db_password: '/tmp/fervor-market-password',
    market_db_ca: '/tmp/fervor-market-ca',
    maint_db_password: '/tmp/fervor-maint-password',
};
for (const [name, file] of Object.entries(secretFiles)) {
    const secret = compose.secrets?.[name];
    if (!secret || secret.file !== file || secret.external || secret.environment) {
        throw new Error(`${name} is not an isolated file-backed Compose secret`);
    }
}

const checkEnv = (extra = {}) => cleanEnv({
    CORE_DB_HOST: 'core.example',
    CORE_DB_PORT: '5432',
    CORE_DB_NAME: 'fervor_core',
    CORE_DB_USER: 'core_migrator',
    MARKET_DB_HOST: 'market.example',
    MARKET_DB_PORT: '5433',
    MARKET_DB_NAME: 'fervor_market',
    MARKET_DB_USER: 'market_migrator',
    MIGRATION_TIMEOUT_SEC: '600',
    COMPOSE_FLYWAY_CHECK: 'true',
    ...extra,
});
const check = (plane, extra = {}, action = 'validate') => runProc('/bin/sh', [script, plane, action], {
    cwd: root,
    env: checkEnv(extra),
    capture: true,
    timeoutMs: 2_000,
});

const bindEnv = (extra = {}) => cleanEnv({
    CORE_DATABASE_URL: 'postgresql://core_runtime@core.example/fervor_core',
    MARKET_DATABASE_URL: 'postgresql://market_runtime@market.example:5433/fervor_market',
    CORE_DB_HOST: 'core.example',
    CORE_DB_PORT: '5432',
    CORE_DB_NAME: 'fervor_core',
    MARKET_DB_HOST: 'market.example',
    MARKET_DB_PORT: '5433',
    MARKET_DB_NAME: 'fervor_market',
    DB_SSL_MODE: 'verify-full',
    ...extra,
});
const bound = await runProc(process.execPath, [bindScript], {
    cwd: root,
    env: bindEnv(),
    capture: true,
    timeoutMs: 2_000,
});
if (bound.code !== 0 || !bound.stdout.includes('physically verified migration targets')) {
    throw new Error(`Runtime target binding failed: ${bound.stderr.trim()}`);
}
for (const [label, extra] of [
    ['runtime host drift', { CORE_DATABASE_URL: 'postgresql://core_runtime@other.example/fervor_core' }],
    ['runtime port drift', { MARKET_DATABASE_URL: 'postgresql://market_runtime@market.example:5432/fervor_market' }],
    ['runtime database drift', { CORE_DATABASE_URL: 'postgresql://core_runtime@core.example/other' }],
    ['runtime TLS downgrade', { DB_SSL_MODE: 'require' }],
]) {
    const rejected = await runProc(process.execPath, [bindScript], {
        cwd: root,
        env: bindEnv(extra),
        capture: true,
        timeoutMs: 2_000,
    });
    if (rejected.code === 0) throw new Error(`${label} was accepted`);
}

const core = await check('core');
const coreUrl = 'jdbc:postgresql://core.example:5432/fervor_core?sslmode=verify-full&sslrootcert=/run/secrets/core_db_ca';
const coreArgs = [
    coreUrl,
    '-configFiles=/flyway/db/flyway/core.conf,/flyway/db/flyway/core-production.conf',
    '-ignoreMigrationPatterns=*:pending',
    'validate',
];
if (core.code !== 0 || JSON.stringify(core.stdout.trim().split('\n')) !== JSON.stringify(coreArgs)) {
    throw new Error(`Core URL construction failed: ${core.stderr.trim()}`);
}
const market = await check('market');
const marketUrl = 'jdbc:postgresql://market.example:5433/fervor_market?sslmode=verify-full&sslrootcert=/run/secrets/market_db_ca';
const marketArgs = [
    marketUrl,
    '-configFiles=/flyway/db/flyway/market.conf',
    '-ignoreMigrationPatterns=*:pending',
    'validate',
];
if (market.code !== 0 || JSON.stringify(market.stdout.trim().split('\n')) !== JSON.stringify(marketArgs)) {
    throw new Error(`Market URL construction failed: ${market.stderr.trim()}`);
}

for (const [label, extra] of [
    ['URL query injection', { CORE_DB_HOST: 'core.example?sslmode=disable' }],
    ['URL fragment injection', { CORE_DB_HOST: 'core.example#fragment' }],
    ['URL authority injection', { CORE_DB_HOST: 'user@core.example' }],
    ['URL port injection', { CORE_DB_HOST: 'core.example:6543' }],
    ['newline injection', { CORE_DB_HOST: 'core.example\nmarket.example' }],
    ['URL path injection', { CORE_DB_NAME: 'fervor/other' }],
    ['port injection', { CORE_DB_PORT: '5432?user=admin' }],
    ['port overflow', { CORE_DB_PORT: '999999999999999999999999999999999999999' }],
    ['zero timeout', { MIGRATION_TIMEOUT_SEC: '0' }],
    ['nonnumeric timeout', { MIGRATION_TIMEOUT_SEC: 'ten' }],
    ['oversized timeout', { MIGRATION_TIMEOUT_SEC: '3601' }],
    ['timeout overflow', { MIGRATION_TIMEOUT_SEC: '999999999999999999999999999999999999999' }],
]) {
    const unsafe = await check('core', extra);
    if (unsafe.timedOut || unsafe.code !== 64) {
        throw new Error(`${label} did not fail closed with usage status 64`);
    }
}

for (const [plane, action] of [['unknown', 'validate'], ['core', 'repair']]) {
    const unsafe = await check(plane, {}, action);
    if (unsafe.timedOut || unsafe.code !== 64) {
        throw new Error(`Unknown migration command was not rejected: ${plane} ${action}`);
    }
}

const cluster = (system_identifier) => ({
    query: async () => ({ rowCount: 1, rows: [{ system_identifier }] }),
});
await assertPlaneSplit(cluster('100'), cluster('200'));
let sameCluster = false;
try {
    await assertPlaneSplit(cluster('100'), cluster('100'));
} catch (error) {
    sameCluster = error.message.includes('same PostgreSQL cluster');
}
if (!sameCluster) throw new Error('Same-cluster split-plane configuration was accepted');

console.log('compose spec: bounded fields build verified TLS URLs and file-backed secrets stay out of Config.Env');
