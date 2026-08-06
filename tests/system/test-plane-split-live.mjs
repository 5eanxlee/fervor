import pg from 'pg';
import { sourceFor, toPg } from '../../db/tools/migration-config.mjs';
import { assertPlaneSplit } from '../../db/tools/plane-split.mjs';

const timeoutMs = 10_000;
const clients = ['core', 'market'].map((plane) => {
    const name = plane.toUpperCase();
    return new pg.Client({
        ...toPg(sourceFor(plane, process.env, true), name),
        application_name: `fervor-colocation-test-${plane}`,
        connectionTimeoutMillis: timeoutMs,
        query_timeout: timeoutMs,
    });
});
const connected = [];
const failures = [];
let rejected = false;

try {
    for (const client of clients) {
        await client.connect();
        connected.push(client);
    }
    try {
        await assertPlaneSplit(clients[0], clients[1]);
    } catch (error) {
        if (!error.message.includes('same PostgreSQL cluster')) throw error;
        rejected = true;
    }
    if (!rejected) throw new Error('Colocated PostgreSQL planes were accepted');
} catch (error) {
    failures.push(error);
} finally {
    const cleanup = await Promise.allSettled(connected.map((client) => client.end()));
    failures.push(...cleanup.filter((item) => item.status === 'rejected').map((item) => item.reason));
}

if (failures.length > 0) throw new AggregateError(failures, 'Live colocated-plane test failed');
console.log('migration split: host aliases resolving to one PostgreSQL cluster were rejected');
