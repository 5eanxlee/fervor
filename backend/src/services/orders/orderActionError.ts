export class ActionStoreError extends Error {
    constructor(
        readonly code: 'not_found' | 'idempotency_conflict' | 'version_conflict'
            | 'lease_conflict' | 'epoch_closed' | 'state_conflict' | 'attempt_conflict'
            | 'observation_conflict' | 'invalid_input' | 'db_invariant',
        message: string,
        readonly retryable = false
    ) {
        super(message);
        this.name = 'ActionStoreError';
    }
}
