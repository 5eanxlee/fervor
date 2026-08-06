import crypto from 'crypto';
import { DbQuery, query, transaction } from '../../config/database';
import {
    AssetAccount,
    AssetAccountInput,
    AssetClaimInput,
    AssetCircuitInput,
    AssetEvidenceInput,
    AssetJournalInput,
    AssetObligationInput,
    ObligationClear,
    assetAccountSchema,
    assetClaimSchema,
    assetCircuitSchema,
    assetEvidenceSchema,
    assetJournalSchema,
    assetObligationSchema,
    journalStateSchema,
    obligationClearSchema,
} from '../../types';
import { canonicalJson } from '../orders/canonicalJson';

type Row = Record<string, unknown>;
type TxFn = <T>(work: (db: DbQuery) => Promise<T>) => Promise<T>;
type PromoteState = 'confirmed' | 'finalized';

export class AssetError extends Error {
    constructor(readonly code: string, message: string, readonly status: number) {
        super(message);
        this.name = 'AssetError';
    }
}

const canonical = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
};

const hash = (value: unknown): string => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const textHash = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

const optional = (value: unknown): string | undefined =>
    value === null || value === undefined ? undefined : String(value);

const instant = (value: unknown): string | undefined => {
    const text = optional(value);
    if (!text) return undefined;
    const date = value instanceof Date ? value : new Date(text);
    return Number.isNaN(date.valueOf()) ? text : date.toISOString();
};

type Evidence = ReturnType<typeof assetEvidenceSchema.parse>;

const payload = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return value;
    }
};

const evidenceCanon = (value: unknown): string | undefined => (
    value === null || value === undefined ? undefined : canonicalJson(value)
);

const samePayload = (row: Row, parsed: Evidence): boolean => {
    try {
        const parsedCanon = evidenceCanon(parsed.payload);
        return evidenceCanon(payload(row.payload)) === parsedCanon
            && (optional(row.payload_canon) === undefined
                || optional(row.payload_canon) === parsedCanon);
    } catch {
        return false;
    }
};

const sameEvidence = (
    row: Row,
    parsed: Evidence,
    chainEventId: string | null,
    legacy = false
): boolean =>
    optional(row.journal_id) === parsed.journalId
    && row.effect_key === parsed.effectKey
    && optional(row.order_id) === parsed.orderId
    && optional(row.action_id) === parsed.actionId
    && row.source === parsed.source
    && row.source_key === parsed.sourceKey
    && row.cluster === parsed.cluster
    && row.wallet_address === parsed.walletAddress
    && (optional(row.vault_address) === parsed.vaultAddress
        || (legacy && parsed.vaultAddress === undefined))
    && optional(row.mint) === parsed.mint
    && optional(row.raw_state) === parsed.rawState
    && optional(row.commitment) === parsed.commitment
    && optional(row.signature) === parsed.signature
    && (row.slot === null || row.slot === undefined ? undefined : Number(row.slot)) === parsed.slot
    && (row.instruction_index === null || row.instruction_index === undefined
        ? undefined : Number(row.instruction_index)) === parsed.instructionIndex
    && (row.event_index === null || row.event_index === undefined
        ? undefined : Number(row.event_index)) === parsed.eventIndex
    && row.payload_hash === parsed.payloadHash
    && samePayload(row, parsed)
    && instant(row.source_at) === instant(parsed.sourceAt)
    && optional(row.chain_event_id) === (chainEventId ?? undefined);

const accountFromRow = (row: Row): AssetAccount => ({
    id: String(row.id),
    accountKey: String(row.account_key),
    cluster: row.cluster as AssetAccount['cluster'],
    walletAddress: String(row.wallet_address),
    vaultAddress: optional(row.vault_address),
    orderId: optional(row.order_id),
    mint: String(row.mint),
    scope: row.scope as AssetAccount['scope'],
    externalId: String(row.external_id),
});

const sameAccount = (left: AssetAccount, right: ReturnType<typeof assetAccountSchema.parse>): boolean =>
    left.cluster === right.cluster
    && left.walletAddress === right.walletAddress
    && left.vaultAddress === right.vaultAddress
    && left.orderId === right.orderId
    && left.mint === right.mint
    && left.scope === right.scope
    && left.externalId === right.externalId;

const pgCode = (error: unknown): string | undefined => {
    if (!error || typeof error !== 'object') return undefined;
    return optional((error as Row).code);
};

export class AssetLedger {
    constructor(
        private readonly db: DbQuery = query,
        private readonly tx: TxFn = transaction
    ) {}

    async account(input: AssetAccountInput): Promise<AssetAccount> {
        const parsed = assetAccountSchema.parse(input);
        const accountKey = hash(parsed);
        const id = crypto.randomUUID();
        try {
            const inserted = await this.db(
                `INSERT INTO asset_accounts
                 (id, account_key, cluster, wallet_address, vault_address, order_id, mint, scope, external_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (account_key) DO NOTHING
                 RETURNING *`,
                [id, accountKey, parsed.cluster, parsed.walletAddress, parsed.vaultAddress || null,
                    parsed.orderId || null, parsed.mint, parsed.scope, parsed.externalId]
            );
            const row = inserted.rows[0] ?? (await this.db(
                'SELECT * FROM asset_accounts WHERE account_key = $1',
                [accountKey]
            )).rows[0];
            if (!row) throw new AssetError('account_race', 'Asset account is being created concurrently', 409);
            const account = accountFromRow(row as Row);
            if (!sameAccount(account, parsed)) {
                throw new AssetError('account_conflict', 'Asset account key resolved to different immutable facts', 409);
            }
            return account;
        } catch (error) {
            throw this.mapError(error, 'account_failed');
        }
    }

    async post(input: AssetJournalInput): Promise<string> {
        try {
            const parsed = assetJournalSchema.parse(input);
            if (parsed.kind === 'reversal') {
                throw new AssetError('invalid_reversal', 'Reversals require the atomic reversal workflow', 400);
            }
            return await this.postWith(this.db, parsed);
        } catch (error) {
            throw this.mapError(error, 'journal_failed');
        }
    }

    async evidence(input: AssetEvidenceInput): Promise<string> {
        try {
            return await this.tx((db) => this.putEvidence(db, assetEvidenceSchema.parse(input)));
        } catch (error) {
            throw this.mapError(error, 'evidence_failed');
        }
    }

    async promote(journalId: string, state: PromoteState, evidence: AssetEvidenceInput): Promise<void> {
        try {
            await this.tx(async (db) => {
                const parsed = assetEvidenceSchema.parse({ ...evidence, journalId });
                await this.promoteWith(db, journalId, state, parsed, false);
            });
        } catch (error) {
            throw this.mapError(error, 'promotion_failed');
        }
    }

    async reverse(
        originalId: string,
        journal: AssetJournalInput,
        state: PromoteState,
        evidence: AssetEvidenceInput
    ): Promise<string> {
        try {
            return await this.tx(async (db) => {
                const parsed = assetJournalSchema.parse(journal);
                if (parsed.kind !== 'reversal' || parsed.reversalOf !== originalId) {
                    throw new AssetError('invalid_reversal', 'Reversal must identify the original journal', 400);
                }
                const reversalId = await this.postWith(db, parsed);
                const proof = assetEvidenceSchema.parse({
                    ...evidence,
                    journalId: reversalId,
                    effectKey: parsed.effectKey,
                    orderId: parsed.orderId,
                    actionId: parsed.actionId,
                });
                await this.promoteWith(db, reversalId, state, proof, true);
                const changed = await db(
                    `SELECT set_asset_journal_state($1, 'reversed') AS changed`,
                    [originalId]
                );
                if (!changed.rows[0]?.changed) {
                    const current = await db('SELECT state FROM asset_journals WHERE id = $1', [originalId]);
                    if (current.rows[0]?.state !== 'reversed') {
                        throw new AssetError('reversal_conflict', 'Original journal is not confirmed or was changed', 409);
                    }
                }
                return reversalId;
            });
        } catch (error) {
            throw this.mapError(error, 'reversal_failed');
        }
    }

    async open(input: AssetObligationInput): Promise<string> {
        try {
            return await this.openWith(this.db, assetObligationSchema.parse(input));
        } catch (error) {
            throw this.mapError(error, 'obligation_failed');
        }
    }

    async claim(input: AssetClaimInput): Promise<string> {
        try {
            const parsed = assetClaimSchema.parse(input);
            return await this.tx(async (db) => {
                const parts = [...parsed.parts].sort((left, right) => (
                    left.role.localeCompare(right.role) || left.mint.localeCompare(right.mint)
                ));
                const stored: Array<{
                    role: typeof parts[number]['role'];
                    mint: string;
                    amount: string;
                    evidenceId: string;
                }> = [];
                for (const part of parts) {
                    stored.push({
                        role: part.role,
                        mint: part.mint,
                        amount: part.amount,
                        evidenceId: await this.putEvidence(db, part.evidence),
                    });
                }
                const primary = stored.find((part) => (
                    part.mint === parsed.obligation.mint && part.amount === parsed.obligation.amount
                ));
                if (!primary) throw new AssetError('claim_conflict', 'Claim has no primary asset leg', 409);
                const claimParts = stored.map((part, lineNo) => ({
                    ...part,
                    lineNo,
                    partHash: textHash(`${part.role}|${part.mint}|${part.amount}|${part.evidenceId}`),
                }));
                const claimHash = textHash(claimParts
                    .map((part) => `${part.lineNo}|${part.partHash}`)
                    .join('\n'));
                const obligationId = await this.openWith(db, assetObligationSchema.parse({
                    ...parsed.obligation,
                    openEvidenceId: primary.evidenceId,
                }), { ver: 2, count: claimParts.length, hash: claimHash });

                for (const part of claimParts) {
                    const inserted = await db(
                        `INSERT INTO asset_claim_parts
                         (obligation_id, line_no, role, mint, amount, evidence_id, part_hash)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)
                         ON CONFLICT DO NOTHING
                         RETURNING obligation_id`,
                        [obligationId, part.lineNo, part.role, part.mint, part.amount,
                            part.evidenceId, part.partHash]
                    );
                    if (inserted.rows[0]) continue;
                    const current = (await db(
                        `SELECT role, mint, amount, evidence_id, part_hash
                           FROM asset_claim_parts
                          WHERE obligation_id = $1 AND line_no = $2`,
                        [obligationId, part.lineNo]
                    )).rows[0];
                    if (!current || current.role !== part.role || current.mint !== part.mint
                        || String(current.amount) !== part.amount
                        || String(current.evidence_id) !== part.evidenceId
                        || current.part_hash !== part.partHash) {
                        throw new AssetError('claim_conflict', 'Claim identity was used for different asset legs', 409);
                    }
                }
                return obligationId;
            });
        } catch (error) {
            throw this.mapError(error, 'claim_failed');
        }
    }

    async review(obligationId: string): Promise<void> {
        try {
            const changed = await this.db(
                `UPDATE asset_obligations SET state = 'review', review_at = CURRENT_TIMESTAMP
                 WHERE id = $1 AND state = 'open' RETURNING id`,
                [obligationId]
            );
            if (changed.rows[0]) return;
            const current = await this.db('SELECT state FROM asset_obligations WHERE id = $1', [obligationId]);
            if (current.rows[0]?.state !== 'review') {
                throw new AssetError('obligation_conflict', 'Obligation cannot enter review', 409);
            }
        } catch (error) {
            throw this.mapError(error, 'review_failed');
        }
    }

    async clear(obligationId: string, input: ObligationClear): Promise<void> {
        const parsed = obligationClearSchema.parse(input);
        try {
            const changed = await this.db(
                `UPDATE asset_obligations
                 SET state = 'cleared', clear_evidence_id = $2, clear_journal_id = $3,
                     cleared_at = CURRENT_TIMESTAMP
                 WHERE id = $1 AND state IN ('open', 'review')
                 RETURNING id`,
                [obligationId, parsed.evidenceId || null, parsed.journalId || null]
            );
            if (changed.rows[0]) return;
            const current = await this.db(
                'SELECT state, clear_evidence_id, clear_journal_id FROM asset_obligations WHERE id = $1',
                [obligationId]
            );
            const row = current.rows[0];
            if (row?.state !== 'cleared') {
                throw new AssetError('obligation_conflict', 'Obligation cannot be cleared', 409);
            }
            if (optional(row.clear_evidence_id) !== parsed.evidenceId
                || optional(row.clear_journal_id) !== parsed.journalId) {
                throw new AssetError('obligation_conflict', 'Obligation was cleared by different evidence', 409);
            }
        } catch (error) {
            throw this.mapError(error, 'clear_failed');
        }
    }

    async blocked(input: AssetCircuitInput): Promise<boolean> {
        const parsed = assetCircuitSchema.parse(input);
        try {
            const result = await this.db(
                `SELECT 1 FROM asset_circuits
                 WHERE cluster = $1 AND wallet_address = $2 AND mint = $3
                   AND (vault_address IS NULL OR vault_address = $4)
                   AND (order_id IS NULL OR order_id = $5)
                 LIMIT 1`,
                [parsed.cluster, parsed.walletAddress, parsed.mint,
                    parsed.vaultAddress || null, parsed.orderId || null]
            );
            return Boolean(result.rows[0]);
        } catch (error) {
            throw this.mapError(error, 'circuit_failed');
        }
    }

    private async postWith(db: DbQuery, input: AssetJournalInput): Promise<string> {
        const parsed = assetJournalSchema.parse(input);
        const entries = [...parsed.entries]
            .sort((left, right) => left.accountId.localeCompare(right.accountId) || left.side.localeCompare(right.side))
            .map((entry, lineNo) => ({ lineNo, ...entry }));
        const request = { ...parsed, entries };
        const document = {
            ...request,
            id: crypto.randomUUID(),
            reqHash: hash(request),
        };
        const result = await db('SELECT post_asset_journal($1::jsonb) AS id', [JSON.stringify(document)]);
        if (!result.rows[0]?.id) throw new AssetError('journal_failed', 'Journal was not posted', 500);
        return String(result.rows[0].id);
    }

    private async openWith(
        db: DbQuery,
        parsed: ReturnType<typeof assetObligationSchema.parse>,
        claim?: { ver: 2; count: number; hash: string }
    ): Promise<string> {
        const reqHash = hash(parsed);
        const id = crypto.randomUUID();
        const inserted = await db(
            `INSERT INTO asset_obligations
             (id, obligation_key, req_hash, order_id, action_id, cluster, wallet_address,
              vault_address, mint, kind, amount, blocks_actions, open_evidence_id, reason,
              claim_ver, claim_count, claim_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                     $15, $16, $17)
             ON CONFLICT (obligation_key) DO NOTHING
             RETURNING id, req_hash, claim_ver, claim_count, claim_hash`,
            [id, parsed.obligationKey, reqHash, parsed.orderId || null, parsed.actionId || null,
                parsed.cluster, parsed.walletAddress, parsed.vaultAddress || null, parsed.mint,
                parsed.kind, parsed.amount || null, parsed.blocksActions,
                parsed.openEvidenceId || null, parsed.reason, claim?.ver ?? null,
                claim?.count ?? null, claim?.hash ?? null]
        );
        const row = inserted.rows[0] ?? (await db(
            `SELECT id, req_hash, claim_ver, claim_count, claim_hash
               FROM asset_obligations WHERE obligation_key = $1`,
            [parsed.obligationKey]
        )).rows[0];
        if (!row || row.req_hash !== reqHash
            || (row.claim_ver === null || row.claim_ver === undefined ? undefined : Number(row.claim_ver)) !== claim?.ver
            || (row.claim_count === null || row.claim_count === undefined
                ? undefined : Number(row.claim_count)) !== claim?.count
            || optional(row.claim_hash) !== claim?.hash) {
            throw new AssetError('obligation_conflict', 'Obligation key was used for different facts', 409);
        }
        return String(row.id);
    }

    private async putEvidence(
        db: DbQuery,
        parsed: ReturnType<typeof assetEvidenceSchema.parse>
    ): Promise<string> {
        if (parsed.legacyKey) {
            const row = (await db(
                `SELECT * FROM asset_evidence
                 WHERE source = 'chain' AND cluster = $1 AND legacy_source_key = $2`,
                [parsed.cluster, parsed.legacyKey]
            )).rows[0];
            const chainEventId = optional(row?.chain_event_id) ?? null;
            if (!row || optional(row.legacy_source_key) !== parsed.legacyKey
                || !sameEvidence(row as Row, parsed, chainEventId, true)) {
                throw new AssetError('evidence_conflict', 'Legacy evidence identity does not match stored facts', 409);
            }
            return String(row.id);
        }

        let payloadCanon: string | undefined;
        try {
            payloadCanon = evidenceCanon(parsed.payload);
        } catch {
            throw new AssetError(
                'invalid_evidence', 'Evidence payload is not canonical JSON', 400
            );
        }
        if (payloadCanon !== undefined && textHash(payloadCanon) !== parsed.payloadHash) {
            throw new AssetError(
                'invalid_evidence', 'Evidence payload hash does not match its canonical document', 400
            );
        }

        let chainEventId: string | null = null;
        if (parsed.source === 'chain') {
            const candidate = crypto.randomUUID();
            const insertedEvent = await db(
                `INSERT INTO asset_chain_events
                 (id, cluster, signature, instruction_index, event_index, slot, journal_id,
                  effect_key, order_id, action_id, wallet_address, vault_address, mint)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                 ON CONFLICT (cluster, signature, instruction_index, event_index) DO NOTHING
                 RETURNING id`,
                [candidate, parsed.cluster, parsed.signature, parsed.instructionIndex, parsed.eventIndex,
                    parsed.slot, parsed.journalId || null, parsed.effectKey, parsed.orderId || null,
                    parsed.actionId || null, parsed.walletAddress, parsed.vaultAddress || null, parsed.mint]
            );
            if (insertedEvent.rows[0]) {
                chainEventId = String(insertedEvent.rows[0].id);
            } else {
                const binding = (await db(
                    `SELECT id, journal_id, effect_key, order_id, action_id,
                            wallet_address, vault_address, mint
                       FROM asset_chain_events
                      WHERE cluster = $1 AND signature = $2
                        AND instruction_index = $3 AND event_index = $4`,
                    [parsed.cluster, parsed.signature, parsed.instructionIndex, parsed.eventIndex]
                )).rows[0];
                if (!binding
                    || optional(binding.journal_id) !== parsed.journalId
                    || binding.effect_key !== parsed.effectKey
                    || optional(binding.order_id) !== parsed.orderId
                    || optional(binding.action_id) !== parsed.actionId
                    || binding.wallet_address !== parsed.walletAddress
                    || optional(binding.vault_address) !== parsed.vaultAddress
                    || binding.mint !== parsed.mint) {
                    throw new AssetError('evidence_conflict', 'Chain event is bound to another semantic movement', 409);
                }
                chainEventId = String(binding.id);
            }
        }
        const evidenceHash = hash(parsed);
        const id = crypto.randomUUID();
        const inserted = await db(
            `INSERT INTO asset_evidence
             (id, journal_id, effect_key, evidence_hash, order_id, action_id, source, source_key,
              cluster, wallet_address, vault_address, mint, raw_state, commitment, signature, slot,
              instruction_index, event_index, payload_hash, payload, payload_canon,
              source_at, chain_event_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                     $15, $16, $17, $18, $19, $20::jsonb, $21, $22, $23)
             ON CONFLICT (source, cluster, source_key) DO NOTHING
             RETURNING *`,
            [id, parsed.journalId || null, parsed.effectKey, evidenceHash, parsed.orderId || null,
                parsed.actionId || null, parsed.source, parsed.sourceKey, parsed.cluster,
                parsed.walletAddress, parsed.vaultAddress || null, parsed.mint || null,
                parsed.rawState ?? null, parsed.commitment || null, parsed.signature || null,
                parsed.slot ?? null, parsed.instructionIndex ?? null, parsed.eventIndex ?? null,
                parsed.payloadHash, payloadCanon ?? null,
                payloadCanon || null, parsed.sourceAt || null, chainEventId]
        );
        const row = inserted.rows[0] ?? (await db(
            `SELECT * FROM asset_evidence
             WHERE source = $1 AND cluster = $2 AND source_key = $3`,
            [parsed.source, parsed.cluster, parsed.sourceKey]
        )).rows[0];
        if (!row || !sameEvidence(row as Row, parsed, chainEventId)) {
            throw new AssetError('evidence_conflict', 'Evidence identity was used for different facts', 409);
        }
        return String(row.id);
    }

    private async promoteWith(
        db: DbQuery,
        journalId: string,
        state: PromoteState,
        evidence: ReturnType<typeof assetEvidenceSchema.parse>,
        allowReversal: boolean
    ): Promise<void> {
        journalStateSchema.parse(state);
        if (evidence.source !== 'chain'
            || (state === 'confirmed' && !['confirmed', 'finalized'].includes(evidence.commitment || ''))
            || (state === 'finalized' && evidence.commitment !== 'finalized')) {
            throw new AssetError('invalid_evidence', `Journal ${state} requires matching chain commitment`, 400);
        }
        const journal = await db('SELECT kind FROM asset_journals WHERE id = $1 FOR UPDATE', [journalId]);
        if (!journal.rows[0]) throw new AssetError('journal_conflict', 'Journal does not exist', 409);
        if (journal.rows[0].kind === 'reversal' && !allowReversal) {
            throw new AssetError('invalid_reversal', 'Reversals require the atomic reversal workflow', 400);
        }
        await this.putEvidence(db, evidence);
        const changed = await db(
            'SELECT set_asset_journal_state($1, $2) AS changed',
            [journalId, state]
        );
        if (changed.rows[0]?.changed) return;
        const current = await db('SELECT state FROM asset_journals WHERE id = $1', [journalId]);
        if (current.rows[0]?.state !== state) {
            throw new AssetError('journal_conflict', `Journal cannot advance to ${state}`, 409);
        }
    }

    private mapError(error: unknown, fallback: string): Error {
        if (error instanceof AssetError || (error instanceof Error && error.name === 'ZodError')) return error;
        const code = pgCode(error);
        if (code === '23505') return new AssetError('asset_conflict', 'Asset identity already has different facts', 409);
        if (code === '23503') return new AssetError('asset_reference', 'Asset operation references missing facts', 409);
        if (code === '23514' || code === '55000') {
            return new AssetError('asset_invariant', error instanceof Error ? error.message : 'Asset invariant failed', 409);
        }
        return new AssetError(fallback, 'Asset ledger operation failed', 500);
    }
}
