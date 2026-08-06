import fs from 'node:fs';
import tls from 'node:tls';

export const flywayImage = 'flyway/flyway:13.0.0@sha256:db6195c21e90872063ff257ec38edcb8d3c77259b25a7a8fee67189511079511';

const urlParams = new Set([
    'applicationname',
    'connecttimeout',
    'hostrecheckseconds',
    'loadbalancehosts',
    'sockettimeout',
    'sslmode',
    'sslrootcert',
    'targetservertype',
    'tcpkeepalive',
]);
const sslModes = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']);

const rejectIpv6 = (url, name) => {
    if (url.hostname.includes('%')) {
        throw new Error(`${name} database URL host must not use percent-encoding`);
    }
    if (url.hostname.startsWith('[') || url.hostname.includes(':')) {
        throw new Error(`${name} database URL does not support IPv6 literals; use a DNS name or IPv4 address`);
    }
};

const normalizeParams = (url, name) => {
    if (url.hash) throw new Error(`${name} database URL must not contain a fragment`);
    const normalized = new Map();
    for (const [rawKey, value] of url.searchParams) {
        const key = rawKey.toLowerCase();
        if (['user', 'password', 'sslpassword'].includes(key)) {
            throw new Error(`${name} database URL must not use query-string credentials`);
        }
        if (!urlParams.has(key)) throw new Error(`${name} database URL parameter is not allowlisted: ${rawKey}`);
        if (normalized.has(key)) throw new Error(`${name} database URL repeats parameter: ${rawKey}`);
        normalized.set(key, value);
    }
    url.search = '';
    for (const [key, value] of [...normalized].sort(([left], [right]) => left.localeCompare(right))) {
        url.searchParams.set(key, value);
    }
};

const applyTls = (url, name, env, containerCa) => {
    const modeKey = `${name}_DB_SSL_MODE`;
    const caKey = `${name}_DB_SSL_CA`;
    const configuredMode = env[modeKey] ?? env.DB_SSL_MODE;
    if (!url.searchParams.has('sslmode') && configuredMode !== undefined) {
        if (!configuredMode) throw new Error(`${modeKey} must not be empty`);
        url.searchParams.set('sslmode', configuredMode);
    }

    const rawMode = url.searchParams.get('sslmode');
    if (rawMode === '') throw new Error(`${modeKey} must not be empty`);
    const mode = rawMode?.toLowerCase();
    if (mode && !sslModes.has(mode)) throw new Error(`${modeKey} is invalid: ${mode}`);
    if (mode) url.searchParams.set('sslmode', mode);

    const urlCa = url.searchParams.get('sslrootcert') ?? '';
    const caFile = env[caKey] ?? env.DB_SSL_CA ?? urlCa;
    if (caFile) {
        if (!fs.existsSync(caFile)) throw new Error(`${caKey} does not exist: ${caFile}`);
        if (containerCa) url.searchParams.set('sslrootcert', containerCa);
    }

    if (env.MIGRATION_ENV === 'production' || env.NODE_ENV === 'production') {
        if (mode !== 'verify-full') throw new Error(`${name} production migrations require sslmode=verify-full`);
        if (!caFile) throw new Error(`${name} production migrations require a CA root`);
    }
    return { caFile: caFile || null, mode: mode ?? 'disable' };
};

export const sourceFor = (plane, env = process.env, pgOnly = false) => {
    const name = plane.toUpperCase();
    if (env.MIGRATION_COLOCATED === 'true'
        && (env.MIGRATION_ENV === 'production' || env.NODE_ENV === 'production')) {
        throw new Error('Production migrations cannot use MIGRATION_COLOCATED=true');
    }
    const databaseUrl = env[`${name}_DATABASE_URL`];
    if (pgOnly && databaseUrl) return databaseUrl;
    if (!pgOnly && env[`${name}_FLYWAY_URL`]) return env[`${name}_FLYWAY_URL`];
    if (databaseUrl) return databaseUrl;
    if (env.MIGRATION_COLOCATED === 'true' && env.DATABASE_URL) return env.DATABASE_URL;
    const required = pgOnly ? `${name}_DATABASE_URL` : `${name}_FLYWAY_URL or ${name}_DATABASE_URL`;
    throw new Error(`${required} is required; DATABASE_URL fallback needs MIGRATION_COLOCATED=true`);
};

export const toJdbc = (value, name, env = process.env) => {
    const isJdbc = value.startsWith('jdbc:postgresql://');
    const parsed = new URL(isJdbc ? value.slice('jdbc:'.length) : value);
    if (!isJdbc && !['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        throw new Error(`${name} database URL must use postgres or postgresql`);
    }
    if (isJdbc && parsed.protocol !== 'postgresql:') throw new Error(`${name}_FLYWAY_URL must use PostgreSQL JDBC`);
    if (!parsed.pathname || parsed.pathname === '/') throw new Error(`${name} database URL must name a database`);
    rejectIpv6(parsed, name);
    normalizeParams(parsed, name);

    if (isJdbc && (parsed.username || parsed.password)) {
        throw new Error(`${name}_FLYWAY_URL must not contain credentials`);
    }
    const user = env[`${name}_DB_USER`] ?? (isJdbc ? '' : decodeURIComponent(parsed.username));
    const password = env[`${name}_DB_PASSWORD`] ?? (isJdbc ? '' : decodeURIComponent(parsed.password));
    if (!user) throw new Error(`${name}_DB_USER or a database URL user is required`);
    parsed.username = '';
    parsed.password = '';

    const local = ['localhost', '127.0.0.1'].includes(parsed.hostname);
    if (local) parsed.hostname = 'host.docker.internal';
    const { caFile } = applyTls(parsed, name, env, '/flyway/certs/db-ca.pem');
    return {
        url: `jdbc:${parsed.toString()}`,
        user,
        password,
        caFile,
    };
};

export const toPg = (value, name, env = process.env) => {
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        throw new Error(`${name}_DATABASE_URL must use postgres or postgresql`);
    }
    if (!parsed.pathname || parsed.pathname === '/') throw new Error(`${name}_DATABASE_URL must name a database`);
    rejectIpv6(parsed, name);
    normalizeParams(parsed, name);
    const user = env[`${name}_DB_USER`] ?? decodeURIComponent(parsed.username);
    const password = env[`${name}_DB_PASSWORD`] ?? decodeURIComponent(parsed.password);
    if (!user) throw new Error(`${name}_DB_USER or a database URL user is required`);
    parsed.username = user;
    parsed.password = password;

    const { caFile, mode } = applyTls(parsed, name, env, null);
    if (['allow', 'prefer'].includes(mode)) {
        throw new Error(`${name}_DATABASE_URL sslmode=${mode} is unsupported by the Node migration verifier`);
    }
    parsed.searchParams.delete('sslmode');
    parsed.searchParams.delete('sslrootcert');
    const verifyHost = parsed.hostname;
    const ssl = mode === 'disable' ? false : {
        rejectUnauthorized: ['verify-ca', 'verify-full'].includes(mode),
        ...(caFile ? { ca: fs.readFileSync(caFile, 'utf8') } : {}),
        ...(mode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),
        ...(mode === 'verify-full'
            ? { checkServerIdentity: (_name, cert) => tls.checkServerIdentity(verifyHost, cert) }
            : {}),
    };
    return { connectionString: parsed.toString(), ssl };
};
