import { AlertCandidate } from '../types';
import { AlertEventWriter } from './alertEventWriter';
import { metrics } from './metrics';
import { redisStreams, STREAMS } from './redisStreamService';

export class AlertCandidateConsumerService {
    constructor(private readonly writer = new AlertEventWriter()) {}

    async start(): Promise<void> {
        await redisStreams.connect();
        await redisStreams.ensureGroup(STREAMS.alertCandidates, 'alert-candidate-writers');
    }

    async handleCandidate(candidate: AlertCandidate): Promise<boolean> {
        const done = metrics.timer('fervor_alert_candidate_write_ms', { engine: candidate.engineVersion });
        try {
            const result = await this.writer.writeCandidate(candidate);
            metrics.increment('fervor_alert_candidates_total', { engine: candidate.engineVersion });
            metrics.observe(
                'fervor_alert_candidate_latency_ms',
                Math.max(0, Date.now() - new Date(candidate.receivedAt).getTime()),
                { engine: candidate.engineVersion }
            );
            return result.created;
        } finally {
            done();
        }
    }
}
