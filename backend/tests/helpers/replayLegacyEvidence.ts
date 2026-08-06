import { closeDatabase } from '../src/config/database';
import { AssetLedger } from '../src/services/assets/assetLedger';

const main = async (): Promise<void> => {
    const input = process.env.LEGACY_EVIDENCE_JSON;
    const expected = process.env.LEGACY_EVIDENCE_ID;
    if (!input || !expected) throw new Error('Legacy replay fixture is incomplete');

    const replayed = await new AssetLedger().evidence(JSON.parse(input));
    if (replayed !== expected) {
        throw new Error(`Legacy replay returned ${replayed} instead of ${expected}`);
    }
};

main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await closeDatabase();
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });
