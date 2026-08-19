import path from 'node:path';
import { buildMetricReplay, writeMetricReplay } from './services/marketData/metricReplay';

const parseArgs = (): { replay: string; out: string } => {
    const values = new Map<string, string>();
    for (let index = 2; index < process.argv.length; index += 2) {
        const name = process.argv[index];
        const value = process.argv[index + 1];
        if (!['--replay', '--out'].includes(name) || !value || values.has(name)) {
            throw new Error('Usage: metric-replay --replay <replay-dir> --out <output-dir>');
        }
        values.set(name, value);
    }
    const replay = values.get('--replay');
    const out = values.get('--out');
    if (!replay || !out || values.size !== 2) {
        throw new Error('Usage: metric-replay --replay <replay-dir> --out <output-dir>');
    }
    const replayPath = path.resolve(replay);
    const outPath = path.resolve(out);
    if (outPath === replayPath || outPath.startsWith(`${replayPath}${path.sep}`)) {
        throw new Error('Metric output must be outside the source replay directory');
    }
    return { replay: replayPath, out: outPath };
};

const main = async (): Promise<void> => {
    const args = parseArgs();
    const replay = await buildMetricReplay(args.replay);
    const manifest = await writeMetricReplay(args.out, replay);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
};

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
