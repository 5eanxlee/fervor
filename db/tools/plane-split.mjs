const identitySql = `
    SELECT system_identifier::text AS system_identifier
      FROM pg_catalog.pg_control_system()
`;

export const clusterId = async (client) => {
    let result;
    try {
        result = await client.query(identitySql);
    } catch (cause) {
        throw new Error(
            'Cannot read PostgreSQL cluster identity; the migration role needs EXECUTE on pg_control_system()',
            { cause },
        );
    }
    const value = result.rows[0]?.system_identifier;
    if (result.rowCount !== 1 || !/^[0-9]+$/.test(value ?? '')) {
        throw new Error('PostgreSQL did not return one valid cluster system identifier');
    }
    return value;
};

export const assertPlaneSplit = async (core, market) => {
    const [coreId, marketId] = await Promise.all([clusterId(core), clusterId(market)]);
    if (coreId === marketId) {
        throw new Error('Core and market databases resolve to the same PostgreSQL cluster');
    }
};
