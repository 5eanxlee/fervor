import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pullFlyway, runProc } from '../../db/tools/flyway-runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const timeoutMs = Number(process.env.MIGRATION_TIMEOUT_MS ?? 600_000) + 60_000;

await pullFlyway();

const start = async () => {
    const result = await runProc(process.execPath, ['db/tools/run-migrations.mjs', '--plane=core'], {
        cwd: root,
        env: process.env,
        timeoutMs,
        graceMs: 10_000,
    });
    if (result.timedOut) throw new Error(`Concurrent migrator exceeded ${timeoutMs} ms`);
    if (result.code !== 0) throw new Error(`Concurrent migrator exited with ${result.signal ?? result.code}`);
};

await Promise.all([start(), start()]);
console.log('migration race: both contenders converged');
