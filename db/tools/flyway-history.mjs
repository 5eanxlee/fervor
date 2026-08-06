const planes = {
    core: {
        schema: 'fervor_core_meta',
        table: 'fervor_core_history',
        primary: 'fervor_core_history_pk',
        success: 'fervor_core_history_s_idx',
    },
    market: {
        schema: 'fervor_market_meta',
        table: 'fervor_market_history',
        primary: 'fervor_market_history_pk',
        success: 'fervor_market_history_s_idx',
    },
};

const namesFor = (plane) => {
    const names = planes[plane];
    if (!names) throw new Error(`Unknown migration plane: ${plane}`);
    return names;
};

export const recordBaseline = async (client, plane, digest) => {
    const names = namesFor(plane);
    const description = `verified_legacy_${digest.slice(0, 12)}`;
    const schema = `"${names.schema}"`;
    const table = `"${names.table}"`;

    // This is Flyway's PostgreSQL schema-history DDL and baseline-row shape. It
    // intentionally lives in the proof transaction so adoption cannot commit a
    // history row without the catalog and data proof, or vice versa.
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`
        CREATE TABLE ${schema}.${table} (
            "installed_rank" INT NOT NULL,
            "version" VARCHAR(50),
            "description" VARCHAR(200) NOT NULL,
            "type" VARCHAR(20) NOT NULL,
            "script" VARCHAR(1000) NOT NULL,
            "checksum" INTEGER,
            "installed_by" VARCHAR(100) NOT NULL,
            "installed_on" TIMESTAMP NOT NULL DEFAULT now(),
            "execution_time" INTEGER NOT NULL,
            "success" BOOLEAN NOT NULL
        )
    `);
    await client.query(`
        INSERT INTO ${schema}.${table} (
            "installed_rank", "version", "description", "type", "script",
            "checksum", "installed_by", "execution_time", "success"
        )
        VALUES (1, '001', $1, 'BASELINE', $1, NULL, current_user, 0, true)
    `, [description]);
    await client.query(`
        ALTER TABLE ${schema}.${table}
        ADD CONSTRAINT "${names.primary}" PRIMARY KEY ("installed_rank")
    `);
    await client.query(`
        CREATE INDEX "${names.success}"
        ON ${schema}.${table} ("success")
    `);
    await client.query(`
        INSERT INTO ${schema}.${table} (
            "installed_rank", "version", "description", "type", "script",
            "checksum", "installed_by", "execution_time", "success"
        )
        VALUES (
            2, NULL, '<< Flyway Schema Creation >>', 'SCHEMA', $1,
            NULL, current_user, 0, true
        )
    `, [`"${names.schema}"`]);
};

export const historyName = (plane) => {
    const names = namesFor(plane);
    return `${names.schema}.${names.table}`;
};
