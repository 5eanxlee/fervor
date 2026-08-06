import { egressDb, type Database } from '../../config/database';
import { env } from '../../config/env';
import { withDbClient } from '../dbWork';
import { metrics } from '../metrics';

type RecoveryDb = Pick<Database, 'getClient' | 'plane'>;

interface RecoveryRow {
    attempt_id: string;
}

export class EgressRecovery {
    constructor(
        private readonly db: RecoveryDb = egressDb,
        private readonly timeoutMs = env.EGRESS_ACQUIRE_MS
    ) {}

    get plane(): Database['plane'] {
        return this.db.plane;
    }

    async runBatch(
        batch = env.EGRESS_RECOVERY_BATCH,
        signal?: AbortSignal
    ): Promise<number> {
        try {
            const count = await withDbClient(
                this.db, this.timeoutMs, signal, 'Egress recovery',
                async (client) => {
                    const recovered = await client.query<RecoveryRow>(
                        'SELECT attempt_id FROM recover_action_egress($1)',
                        [batch]
                    );
                    return recovered.rows.length;
                }
            );
            metrics.increment('fervor_egress_recovery_runs', { outcome: 'ok' });
            if (count > 0) metrics.increment('fervor_egress_recovered', undefined, count);
            return count;
        } catch (error) {
            metrics.increment('fervor_egress_recovery_runs', { outcome: 'error' });
            throw error;
        }
    }
}
