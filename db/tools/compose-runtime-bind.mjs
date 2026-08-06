const need = (name) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
};

const target = (plane) => {
    const url = new URL(need(`${plane}_DATABASE_URL`));
    if (!['postgres:', 'postgresql:'].includes(url.protocol)
        || url.search || url.hash || !url.pathname || url.pathname === '/') {
        throw new Error(`${plane}_DATABASE_URL is not a fixed PostgreSQL database target`);
    }
    return {
        host: url.hostname.toLowerCase().replace(/\.$/, ''),
        port: url.port || '5432',
        name: decodeURIComponent(url.pathname.slice(1)),
    };
};

const expected = (plane) => ({
    host: need(`${plane}_DB_HOST`).toLowerCase().replace(/\.$/, ''),
    port: need(`${plane}_DB_PORT`),
    name: need(`${plane}_DB_NAME`),
});

for (const plane of ['CORE', 'MARKET']) {
    const runtime = target(plane);
    const migration = expected(plane);
    if (JSON.stringify(runtime) !== JSON.stringify(migration)) {
        throw new Error(`${plane}_DATABASE_URL does not match the migration target`);
    }
}

if (need('DB_SSL_MODE') !== 'verify-full') {
    throw new Error('Production runtime requires DB_SSL_MODE=verify-full');
}

console.log('runtime database targets match the physically verified migration targets');
