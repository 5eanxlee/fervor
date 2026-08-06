import { z } from 'zod';
import { amountSchema } from './amount';
import { addressSchema, signatureSchema } from './execution';

const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
]));

const metadataSchema = z.record(z.string(), jsonValue).refine(
    (value) => JSON.stringify(value).length <= 16_384,
    'Metadata cannot exceed 16 KiB'
);

export const assetScopeSchema = z.enum(['wallet', 'vault_attr', 'execution', 'fee', 'suspense']);
export const journalKindSchema = z.enum(['deposit', 'fill', 'withdrawal', 'fee', 'reversal']);
export const journalStateSchema = z.enum(['claimed', 'confirmed', 'finalized', 'reversed', 'disputed']);
export const obligationKindSchema = z.enum([
    'deposit_unknown',
    'provider_missing',
    'fill_unverified',
    'return_due',
    'withdraw_unknown',
    'evidence_conflict',
    'deficit',
]);

export const assetAccountSchema = z.object({
    cluster: z.enum(['mainnet-beta', 'devnet', 'testnet', 'localnet']),
    walletAddress: addressSchema,
    vaultAddress: addressSchema.optional(),
    orderId: z.string().uuid().optional(),
    mint: addressSchema,
    scope: assetScopeSchema,
    externalId: z.string().trim().min(1).max(180),
}).strict().superRefine((value, context) => {
    if (value.scope === 'vault_attr' && (!value.vaultAddress || !value.orderId)) {
        context.addIssue({ code: 'custom', message: 'Vault attribution requires a vault and order' });
    }
});

const journalEntrySchema = z.object({
    accountId: z.string().uuid(),
    side: z.enum(['debit', 'credit']),
    amount: amountSchema,
}).strict();

export const assetJournalSchema = z.object({
    effectKey: z.string().trim().min(1).max(180),
    cluster: z.enum(['mainnet-beta', 'devnet', 'testnet', 'localnet']),
    walletAddress: addressSchema,
    orderId: z.string().uuid().optional(),
    legId: z.string().uuid().optional(),
    actionId: z.string().uuid().optional(),
    kind: journalKindSchema,
    reversalOf: z.string().uuid().optional(),
    entries: z.array(journalEntrySchema).min(2).max(64),
    metadata: metadataSchema.default({}),
    occurredAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
    if ((value.kind === 'reversal') !== (value.reversalOf !== undefined)) {
        context.addIssue({ code: 'custom', message: 'Only reversal journals require reversalOf' });
    }
    const lines = new Set<string>();
    for (const entry of value.entries) {
        const key = entry.accountId;
        if (lines.has(key)) context.addIssue({ code: 'custom', message: 'Journal lines must use distinct accounts' });
        lines.add(key);
    }
});

export const assetEvidenceSchema = z.object({
    journalId: z.string().uuid().optional(),
    effectKey: z.string().trim().min(1).max(180),
    orderId: z.string().uuid().optional(),
    actionId: z.string().uuid().optional(),
    cluster: z.enum(['mainnet-beta', 'devnet', 'testnet', 'localnet']),
    walletAddress: addressSchema,
    vaultAddress: addressSchema.optional(),
    mint: addressSchema.optional(),
    source: z.enum(['provider', 'chain']),
    sourceKey: z.string().trim().min(1).max(220).optional(),
    rawState: z.string().trim().max(80).optional()
        .transform((value) => value === '' ? undefined : value),
    commitment: z.enum(['processed', 'confirmed', 'finalized']).optional(),
    signature: signatureSchema.optional(),
    slot: z.number().int().nonnegative().safe().optional(),
    instructionIndex: z.number().int().nonnegative().max(2_147_483_647).optional(),
    eventIndex: z.number().int().nonnegative().max(2_147_483_647).optional(),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    payload: metadataSchema.optional(),
    sourceAt: z.string().datetime().optional(),
}).strict().superRefine((value, context) => {
    if (value.source === 'provider' && !value.sourceKey) {
        context.addIssue({ code: 'custom', message: 'Provider evidence requires a source key' });
    }
    if (value.source === 'chain' && (!value.signature || !value.commitment || value.slot === undefined
        || value.instructionIndex === undefined || value.eventIndex === undefined || !value.mint)) {
        context.addIssue({
            code: 'custom',
            message: 'Chain evidence requires signature, slot, commitment, mint, instruction index, and event index',
        });
    }
}).transform((value) => ({
    ...value,
    sourceKey: value.source === 'chain'
        ? `${value.signature}:${value.instructionIndex}:${value.eventIndex}:${value.commitment}`
        : value.sourceKey as string,
    // A noncanonical pre-V4 key is a replay alias. AssetLedger never inserts it.
    legacyKey: value.source === 'chain' && value.sourceKey !== undefined
        && value.sourceKey !== `${value.signature}:${value.instructionIndex}:${value.eventIndex}:${value.commitment}`
        ? value.sourceKey
        : undefined,
}));

const assetObligationBase = z.object({
    obligationKey: z.string().trim().min(1).max(180),
    orderId: z.string().uuid().optional(),
    actionId: z.string().uuid().optional(),
    cluster: z.enum(['mainnet-beta', 'devnet', 'testnet', 'localnet']),
    walletAddress: addressSchema,
    vaultAddress: addressSchema.optional(),
    mint: addressSchema,
    kind: obligationKindSchema,
    amount: amountSchema.optional(),
    blocksActions: z.boolean().default(true),
    openEvidenceId: z.string().uuid().optional(),
    reason: z.string().trim().min(1).max(500),
}).strict();

export const assetObligationSchema = assetObligationBase.superRefine((value, context) => {
    if (!value.orderId && !value.actionId && !value.openEvidenceId) {
        context.addIssue({ code: 'custom', message: 'Obligation requires an order, action, or opening evidence' });
    }
});

const claimPartSchema = z.object({
    role: z.enum(['input', 'output', 'fee', 'movement']),
    mint: addressSchema,
    amount: amountSchema,
    evidence: assetEvidenceSchema,
}).strict();

export const assetClaimSchema = z.object({
    obligation: assetObligationBase.omit({ openEvidenceId: true }),
    parts: z.array(claimPartSchema).min(1).max(8),
}).strict().superRefine((value, context) => {
    const primary = value.parts.filter((part) => (
        part.mint === value.obligation.mint && part.amount === value.obligation.amount
    ));
    if (primary.length !== 1) {
        context.addIssue({
            code: 'custom',
            message: 'Claim requires exactly one part matching its primary mint and amount',
        });
    }
    if (!value.obligation.orderId && !value.obligation.actionId) {
        context.addIssue({ code: 'custom', message: 'Claim obligation requires an order or action' });
    }

    const identities = new Set<string>();
    const sourceKeys = new Set<string>();
    const effectKey = value.parts[0]?.evidence.effectKey;
    const signature = value.parts[0]?.evidence.signature;
    const payloadHash = value.parts[0]?.evidence.payloadHash;
    const sourceAt = value.parts[0]?.evidence.sourceAt;
    for (const part of value.parts) {
        const identity = `${part.role}:${part.mint}`;
        if (identities.has(identity)) {
            context.addIssue({ code: 'custom', message: 'Claim part roles and mints must be unique' });
        }
        identities.add(identity);
        if (sourceKeys.has(part.evidence.sourceKey)) {
            context.addIssue({ code: 'custom', message: 'Claim parts require distinct evidence identities' });
        }
        sourceKeys.add(part.evidence.sourceKey);
        if (part.evidence.source !== 'provider' || part.evidence.journalId !== undefined
            || part.evidence.signature === undefined || part.evidence.payload === undefined
            || part.evidence.effectKey !== effectKey
            || part.evidence.signature !== signature
            || part.evidence.payloadHash !== payloadHash
            || part.evidence.sourceAt !== sourceAt
            || part.evidence.cluster !== value.obligation.cluster
            || part.evidence.walletAddress !== value.obligation.walletAddress
            || part.evidence.vaultAddress !== value.obligation.vaultAddress
            || part.evidence.orderId !== value.obligation.orderId
            || part.evidence.actionId !== value.obligation.actionId
            || part.evidence.mint !== part.mint) {
            context.addIssue({
                code: 'custom',
                message: 'Claim evidence must share one provider document and match its unresolved asset leg',
            });
        }
    }

    const roles = value.parts.map((part) => part.role).sort().join(',');
    if (value.obligation.kind === 'fill_unverified') {
        if (roles !== 'input,output' || value.parts[0]?.mint === value.parts[1]?.mint) {
            context.addIssue({
                code: 'custom',
                message: 'Fill claims require one input and one output in distinct mints',
            });
        }
    } else if (['deposit_unknown', 'withdraw_unknown'].includes(value.obligation.kind)) {
        if (roles !== 'movement') {
            context.addIssue({
                code: 'custom',
                message: 'Deposit and withdrawal claims require one movement part',
            });
        }
    } else {
        context.addIssue({ code: 'custom', message: 'Claim obligation kind is unsupported' });
    }
});

export const obligationClearSchema = z.object({
    evidenceId: z.string().uuid().optional(),
    journalId: z.string().uuid().optional(),
}).strict().refine((value) => Number(value.evidenceId !== undefined) + Number(value.journalId !== undefined) === 1, {
    message: 'Clearing requires exactly one evidence or journal reference',
});

export const assetCircuitSchema = z.object({
    cluster: z.enum(['mainnet-beta', 'devnet', 'testnet', 'localnet']),
    walletAddress: addressSchema,
    mint: addressSchema,
    vaultAddress: addressSchema.optional(),
    orderId: z.string().uuid().optional(),
}).strict();

export type AssetScope = z.infer<typeof assetScopeSchema>;
export type AssetAccountInput = z.input<typeof assetAccountSchema>;
export type AssetJournalInput = z.input<typeof assetJournalSchema>;
export type AssetEvidenceInput = z.input<typeof assetEvidenceSchema>;
export type AssetObligationInput = z.input<typeof assetObligationSchema>;
export type AssetClaimInput = z.input<typeof assetClaimSchema>;
export type ObligationClear = z.infer<typeof obligationClearSchema>;
export type AssetCircuitInput = z.infer<typeof assetCircuitSchema>;

export interface AssetAccount extends z.output<typeof assetAccountSchema> {
    id: string;
    accountKey: string;
}
