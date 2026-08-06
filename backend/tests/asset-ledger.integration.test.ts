import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/services/orders/canonicalJson';

const enabled = process.env.RUN_INFRA_TESTS === 'true';
const suite = enabled ? describe : describe.skip;

suite('asset ledger infrastructure', () => {
    let query: typeof import('../src/config/database').query;
    let getClient: typeof import('../src/config/database').getClient;
    let closeDatabase: typeof import('../src/config/database').closeDatabase;
    let ledger: import('../src/services/assets/assetLedger').AssetLedger;
    let userId = '';
    let orderId = '';
    let walletAccount = '';
    let vaultAccount = '';
    let secondVaultAccount = '';
    let quoteWalletAccount = '';
    let quoteVaultAccount = '';
    let depositId = '';
    const marker = crypto.randomBytes(8).toString('hex');
    const wallet = '7Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
    const vault = '8Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
    const secondVault = '9Zb1d7t2S9Bkv8G6gPKZQdgs7Qk1HSA1xY5g7uEczwzE';
    const mint = 'So11111111111111111111111111111111111111112';
    const quoteMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const signature = '5'.repeat(88);

    const evidence = (effectKey: string, discriminator: string, overrides: Record<string, unknown> = {}) => {
        const payloadHash = crypto.createHash('sha256').update(discriminator).digest('hex');
        return {
            effectKey,
            orderId,
            cluster: 'mainnet-beta' as const,
            walletAddress: wallet,
            vaultAddress: vault,
            mint,
            source: 'chain' as const,
            commitment: 'confirmed' as const,
            signature,
            slot: 42,
            instructionIndex: 0,
            eventIndex: Number.parseInt(payloadHash.slice(0, 7), 16),
            payloadHash,
            ...overrides,
        };
    };

    beforeAll(async () => {
        process.env.CORE_DATABASE_URL ??= 'postgresql://fervor@localhost:55432/fervor';
        process.env.MARKET_DATABASE_URL ??= process.env.CORE_DATABASE_URL;
        process.env.DB_COLOCATED ??= 'true';
        ({ query, getClient, closeDatabase } = await import('../src/config/database'));
        const { AssetLedger } = await import('../src/services/assets/assetLedger');
        ledger = new AssetLedger(query);

        const user = await query(
            'INSERT INTO users (wallet_address) VALUES ($1) RETURNING id',
            [`AssetLedger${marker}`]
        );
        userId = user.rows[0].id;
        orderId = crypto.randomUUID();
        await query(
            `INSERT INTO order_intents
             (id, user_id, provider, client_order_id, request_digest, wallet_address,
              order_type, state, input_mint, output_mint, input_amount, trigger_mint,
              params, cluster, expires_at)
             VALUES ($1, $2, 'fixture', $3, $4, $5, 'single', 'open', $6, $7, '10', $7,
                     '{}'::jsonb, 'mainnet-beta', CURRENT_TIMESTAMP + INTERVAL '1 day')`,
            [orderId, userId, `asset-${marker}`, 'a'.repeat(64), wallet, mint, quoteMint]
        );
        walletAccount = (await ledger.account({
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            mint,
            scope: 'wallet',
            externalId: `wallet:${marker}`,
        })).id;
        vaultAccount = (await ledger.account({
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            vaultAddress: vault,
            orderId,
            mint,
            scope: 'vault_attr',
            externalId: `vault:${marker}`,
        })).id;
        secondVaultAccount = (await ledger.account({
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            vaultAddress: secondVault,
            orderId,
            mint,
            scope: 'vault_attr',
            externalId: `vault:${marker}:second`,
        })).id;
        quoteWalletAccount = (await ledger.account({
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            mint: quoteMint,
            scope: 'wallet',
            externalId: `quote-wallet:${marker}`,
        })).id;
        quoteVaultAccount = (await ledger.account({
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            vaultAddress: vault,
            orderId,
            mint: quoteMint,
            scope: 'vault_attr',
            externalId: `quote-vault:${marker}`,
        })).id;
    });

    afterAll(async () => {
        await closeDatabase?.();
    });

    it('posts exact balanced effects idempotently and separates claimed from confirmed balances', async () => {
        const input = {
            effectKey: `deposit:${marker}`,
            cluster: 'mainnet-beta' as const,
            walletAddress: wallet,
            orderId,
            kind: 'deposit' as const,
            entries: [
                { accountId: vaultAccount, side: 'debit' as const, amount: '10' },
                { accountId: walletAccount, side: 'credit' as const, amount: '10' },
            ],
            occurredAt: new Date().toISOString(),
        };
        depositId = await ledger.post(input);
        await expect(ledger.post({ ...input, entries: [...input.entries].reverse() }))
            .resolves.toBe(depositId);

        const claimed = await query(
            'SELECT confirmed_amount, claimed_delta FROM asset_balances WHERE account_id = $1',
            [vaultAccount]
        );
        expect(claimed.rows[0]).toEqual({ confirmed_amount: '0', claimed_delta: '10' });

        await ledger.promote(depositId, 'confirmed', evidence(input.effectKey, `${signature}:deposit:${marker}`));
        await ledger.promote(depositId, 'finalized', evidence(
            input.effectKey,
            `${signature}:deposit:${marker}`,
            { commitment: 'finalized' }
        ));
        const confirmed = await query(
            'SELECT confirmed_amount, claimed_delta FROM asset_balances WHERE account_id = $1',
            [vaultAccount]
        );
        expect(confirmed.rows[0]).toEqual({ confirmed_amount: '10', claimed_delta: '0' });
    });

    it('rejects unbalanced effects and confirmed negative order attribution', async () => {
        await expect(ledger.post({
            effectKey: `unbalanced:${marker}`,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            orderId,
            kind: 'fill',
            entries: [
                { accountId: vaultAccount, side: 'credit', amount: '2' },
                { accountId: walletAccount, side: 'debit', amount: '1' },
            ],
            occurredAt: new Date().toISOString(),
        })).rejects.toMatchObject({ code: 'asset_invariant' });

        const effectKey = `overdraw:${marker}`;
        const withdrawalId = await ledger.post({
            effectKey,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            orderId,
            kind: 'withdrawal',
            entries: [
                { accountId: vaultAccount, side: 'credit', amount: '11' },
                { accountId: walletAccount, side: 'debit', amount: '11' },
            ],
            occurredAt: new Date().toISOString(),
        });
        await expect(ledger.promote(
            withdrawalId,
            'confirmed',
            evidence(effectKey, `${signature}:overdraw:${marker}`)
        )).rejects.toMatchObject({ code: 'asset_invariant' });
        const state = await query('SELECT state FROM asset_journals WHERE id = $1', [withdrawalId]);
        expect(state.rows[0].state).toBe('claimed');
    });

    it('requires an exact confirmed reversal and keeps authoritative rows immutable', async () => {
        const effectKey = `reversal:${marker}`;
        const reversalId = await ledger.reverse(depositId, {
            effectKey,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            orderId,
            kind: 'reversal',
            reversalOf: depositId,
            entries: [
                { accountId: vaultAccount, side: 'credit', amount: '10' },
                { accountId: walletAccount, side: 'debit', amount: '10' },
            ],
            occurredAt: new Date().toISOString(),
        }, 'confirmed', evidence(effectKey, `${signature}:reversal:${marker}`));

        const journals = await query(
            'SELECT id, state FROM asset_journals WHERE id = ANY($1::uuid[]) ORDER BY id',
            [[depositId, reversalId]]
        );
        expect(journals.rows.map((row) => row.state).sort()).toEqual(['confirmed', 'reversed']);
        const balance = await query(
            'SELECT confirmed_amount FROM asset_balances WHERE account_id = $1',
            [vaultAccount]
        );
        expect(balance.rows[0].confirmed_amount).toBe('0');
        await expect(query(
            'UPDATE asset_entries SET amount = 9 WHERE journal_id = $1',
            [reversalId]
        )).rejects.toBeTruthy();
        await expect(query(
            'DELETE FROM asset_evidence WHERE journal_id = $1',
            [reversalId]
        )).rejects.toBeTruthy();
    });

    it('blocks actions until independently confirmed, identity-matched evidence clears the obligation', async () => {
        const obligationId = await ledger.open({
            obligationKey: `deficit:${marker}`,
            orderId,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            vaultAddress: vault,
            mint,
            kind: 'deficit',
            amount: '1',
            reason: 'Observed vault balance is below attributed balance',
        });
        await expect(ledger.blocked({
            cluster: 'mainnet-beta', walletAddress: wallet, vaultAddress: vault, mint, orderId,
        })).resolves.toBe(true);

        const providerId = await ledger.evidence({
            effectKey: `deficit:${marker}`,
            orderId,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            vaultAddress: vault,
            mint,
            source: 'provider',
            sourceKey: `provider:deficit:${marker}`,
            payloadHash: 'b'.repeat(64),
        });
        await expect(ledger.clear(obligationId, { evidenceId: providerId }))
            .rejects.toMatchObject({ code: 'asset_invariant' });

        const proofId = await ledger.evidence(evidence(
            `deficit:${marker}`,
            `${signature}:deficit:${marker}`
        ));
        await ledger.clear(obligationId, { evidenceId: proofId });
        await expect(ledger.clear(obligationId, { evidenceId: providerId }))
            .rejects.toMatchObject({ code: 'obligation_conflict' });
        await expect(ledger.blocked({
            cluster: 'mainnet-beta', walletAddress: wallet, vaultAddress: vault, mint, orderId,
        })).resolves.toBe(false);
    });

    it('requires action and vault identity on every clearing fact', async () => {
        const expectedAction = crypto.randomUUID();
        const otherAction = crypto.randomUUID();
        await query(`
            INSERT INTO order_actions (
                id, order_id, user_id, kind, client_key, req_hash, desired_hash,
                expected_ver, work_state, effect_state, outcome, provider, due_at
            ) VALUES
                ($1, $3, $4, 'provider_sync', $5, repeat('1', 64), repeat('2', 64),
                 0, 'queued', 'not_possible', 'pending', 'fixture', clock_timestamp()),
                ($2, $3, $4, 'provider_sync', $6, repeat('3', 64), repeat('4', 64),
                 0, 'queued', 'not_possible', 'pending', 'fixture', clock_timestamp())
        `, [expectedAction, otherAction, orderId, userId,
            `asset-expected-${marker}`, `asset-other-${marker}`]);
        const obligationId = await ledger.open({
            obligationKey: `identity:${marker}`,
            orderId,
            actionId: expectedAction,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            vaultAddress: vault,
            mint,
            kind: 'evidence_conflict',
            reason: 'Clearing proof must match every scoped identity',
        });

        const wrongAction = await ledger.evidence(evidence(
            `identity:${marker}:action`,
            `${signature}:identity-action:${marker}`,
            { actionId: otherAction }
        ));
        await expect(ledger.clear(obligationId, { evidenceId: wrongAction }))
            .rejects.toMatchObject({ code: 'asset_invariant' });

        const wrongVault = await ledger.evidence(evidence(
            `identity:${marker}:vault`,
            `${signature}:identity-vault:${marker}`,
            { actionId: expectedAction, vaultAddress: secondVault }
        ));
        await expect(ledger.clear(obligationId, { evidenceId: wrongVault }))
            .rejects.toMatchObject({ code: 'asset_invariant' });

        const actionJournalKey = `identity-journal-action:${marker}`;
        const actionJournal = await ledger.post({
            effectKey: actionJournalKey,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            orderId,
            actionId: otherAction,
            kind: 'deposit',
            entries: [
                { accountId: vaultAccount, side: 'debit', amount: '1' },
                { accountId: walletAccount, side: 'credit', amount: '1' },
            ],
            occurredAt: new Date().toISOString(),
        });
        await ledger.promote(actionJournal, 'confirmed', evidence(
            actionJournalKey,
            `${signature}:identity-journal-action:${marker}`,
            { actionId: otherAction }
        ));
        await expect(ledger.clear(obligationId, { journalId: actionJournal }))
            .rejects.toMatchObject({ code: 'asset_invariant' });

        const vaultJournalKey = `identity-journal-vault:${marker}`;
        const vaultJournal = await ledger.post({
            effectKey: vaultJournalKey,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            orderId,
            actionId: expectedAction,
            kind: 'deposit',
            entries: [
                { accountId: secondVaultAccount, side: 'debit', amount: '1' },
                { accountId: walletAccount, side: 'credit', amount: '1' },
            ],
            occurredAt: new Date().toISOString(),
        });
        await ledger.promote(vaultJournal, 'confirmed', evidence(
            vaultJournalKey,
            `${signature}:identity-journal-vault:${marker}`,
            { actionId: expectedAction, vaultAddress: secondVault }
        ));
        await expect(ledger.clear(obligationId, { journalId: vaultJournal }))
            .rejects.toMatchObject({ code: 'asset_invariant' });

        const correct = await ledger.evidence(evidence(
            `identity:${marker}:correct`,
            `${signature}:identity-correct:${marker}`,
            { actionId: expectedAction }
        ));
        await ledger.clear(obligationId, { evidenceId: correct });
    });

    it('binds one chain movement to one semantic effect across commitment observations', async () => {
        const source = `chain-binding:${marker}`;
        const event = `${signature}:chain-binding:${marker}`;
        const journalId = await ledger.post({
            effectKey: source,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            orderId,
            kind: 'deposit',
            entries: [
                { accountId: vaultAccount, side: 'debit', amount: '1' },
                { accountId: walletAccount, side: 'credit', amount: '1' },
            ],
            occurredAt: new Date().toISOString(),
        });
        await ledger.promote(journalId, 'confirmed', evidence(source, event));
        await ledger.promote(journalId, 'finalized', evidence(
            source,
            event,
            { commitment: 'finalized', slot: 43 }
        ));

        await query('ALTER TABLE asset_evidence DISABLE TRIGGER asset_evidence_immutable');
        await query(
            `UPDATE asset_evidence SET evidence_hash = $2
              WHERE journal_id = $1 AND commitment = 'finalized'`,
            [journalId, 'f'.repeat(64)]
        );
        await query('ALTER TABLE asset_evidence ENABLE TRIGGER asset_evidence_immutable');
        await expect(ledger.evidence({
            ...evidence(source, event, { commitment: 'finalized', slot: 43 }),
            journalId,
        })).resolves.toBeTypeOf('string');

        await expect(ledger.evidence(evidence(
            `other-effect:${marker}`,
            event,
            { journalId: undefined }
        ))).rejects.toMatchObject({ code: 'evidence_conflict' });

        const rows = await query(
            `SELECT count(*)::int AS observations, count(DISTINCT chain_event_id)::int AS events,
                    min(slot)::int AS first_slot, max(slot)::int AS final_slot
               FROM asset_evidence
              WHERE chain_event_id = (
                  SELECT chain_event_id FROM asset_evidence
                   WHERE journal_id = $1 LIMIT 1
              )`,
            [journalId]
        );
        expect(rows.rows[0]).toEqual({ observations: 2, events: 1, first_slot: 42, final_slot: 43 });
    });

    it('requires reversal promotion and source transition in one transaction', async () => {
        const sourceKey = `atomic-reversal-source:${marker}`;
        const sourceId = await ledger.post({
            effectKey: sourceKey,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            orderId,
            kind: 'deposit',
            entries: [
                { accountId: vaultAccount, side: 'debit', amount: '1' },
                { accountId: walletAccount, side: 'credit', amount: '1' },
            ],
            occurredAt: new Date().toISOString(),
        });
        await ledger.promote(sourceId, 'confirmed', evidence(
            sourceKey,
            `${signature}:atomic-reversal-source:${marker}`
        ));

        const reversalId = crypto.randomUUID();
        const reversalKey = `atomic-reversal:${marker}`;
        const document = {
            id: reversalId,
            effectKey: reversalKey,
            reqHash: 'c'.repeat(64),
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            orderId,
            kind: 'reversal',
            reversalOf: sourceId,
            entries: [
                { lineNo: 0, accountId: vaultAccount, side: 'credit', amount: '1' },
                { lineNo: 1, accountId: walletAccount, side: 'debit', amount: '1' },
            ],
            metadata: {},
            occurredAt: new Date().toISOString(),
        };
        await query('SELECT post_asset_journal($1::jsonb)', [JSON.stringify(document)]);
        await expect(ledger.promote(
            reversalId,
            'confirmed',
            evidence(reversalKey, `${signature}:atomic-reversal:${marker}`)
        )).rejects.toMatchObject({ code: 'invalid_reversal' });

        await ledger.evidence({
            ...evidence(reversalKey, `${signature}:atomic-reversal:${marker}`),
            journalId: reversalId,
        });
        await expect(query(
            "SELECT set_asset_journal_state($1, 'confirmed')",
            [reversalId]
        )).rejects.toBeTruthy();
        const current = await query('SELECT state FROM asset_journals WHERE id = $1', [reversalId]);
        expect(current.rows[0].state).toBe('claimed');
    });

    it('serializes concurrent confirmations and protects clearing journals from reversal', async () => {
        const opening = await query(
            'SELECT confirmed_amount FROM asset_balances WHERE account_id = $1',
            [vaultAccount]
        );
        const openingAmount = BigInt(opening.rows[0].confirmed_amount);
        const depositKey = `concurrent-deposit:${marker}`;
        const fundingId = await ledger.post({
            effectKey: depositKey,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            orderId,
            kind: 'deposit',
            entries: [
                { accountId: vaultAccount, side: 'debit', amount: '10' },
                { accountId: walletAccount, side: 'credit', amount: '10' },
            ],
            occurredAt: new Date().toISOString(),
        });
        await ledger.promote(
            fundingId,
            'confirmed',
            evidence(depositKey, `${signature}:concurrent-deposit:${marker}`)
        );

        const withdrawals = await Promise.all([0, 1].map(async (index) => {
            const effectKey = `concurrent-withdrawal:${marker}:${index}`;
            const id = await ledger.post({
                effectKey,
                cluster: 'mainnet-beta',
                walletAddress: wallet,
                orderId,
                kind: 'withdrawal',
                entries: [
                    { accountId: vaultAccount, side: 'credit', amount: '7' },
                    { accountId: walletAccount, side: 'debit', amount: '7' },
                ],
                occurredAt: new Date().toISOString(),
            });
            return { id, effectKey, index };
        }));
        const promotions = await Promise.allSettled(withdrawals.map((item) => ledger.promote(
            item.id,
            'confirmed',
            evidence(item.effectKey, `${signature}:concurrent-withdrawal:${marker}:${item.index}`)
        )));
        expect(promotions.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
        expect(promotions.filter((item) => item.status === 'rejected')).toHaveLength(1);
        const balance = await query(
            'SELECT confirmed_amount FROM asset_balances WHERE account_id = $1',
            [vaultAccount]
        );
        expect(balance.rows[0].confirmed_amount).toBe((openingAmount + 3n).toString());

        const states = await query(
            'SELECT id, state FROM asset_journals WHERE id = ANY($1::uuid[])',
            [withdrawals.map((item) => item.id)]
        );
        const winnerId = states.rows.find((row) => row.state === 'confirmed').id as string;
        const obligationId = await ledger.open({
            obligationKey: `clearing-journal:${marker}`,
            orderId,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            vaultAddress: vault,
            mint,
            kind: 'provider_missing',
            reason: 'Provider receipt was recovered from a confirmed journal',
        });
        await ledger.clear(obligationId, { journalId: winnerId });

        const reversalKey = `protected-reversal:${marker}`;
        await expect(ledger.reverse(winnerId, {
            effectKey: reversalKey,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            orderId,
            kind: 'reversal',
            reversalOf: winnerId,
            entries: [
                { accountId: vaultAccount, side: 'debit', amount: '7' },
                { accountId: walletAccount, side: 'credit', amount: '7' },
            ],
            occurredAt: new Date().toISOString(),
        }, 'confirmed', evidence(reversalKey, `${signature}:protected-reversal:${marker}`)))
            .rejects.toMatchObject({ code: 'asset_invariant' });
        const rolledBack = await query('SELECT id FROM asset_journals WHERE effect_key = $1', [reversalKey]);
        expect(rolledBack.rows).toHaveLength(0);
    });

    it.each(['journal', 'evidence'] as const)(
        'prevents clear-first %s write skew against a concurrent reversal', async (mode) => {
            const sourceKey = `clear-first-source:${mode}:${marker}`;
            const sourceId = await ledger.post({
                effectKey: sourceKey,
                cluster: 'mainnet-beta',
                walletAddress: wallet,
                orderId,
                kind: 'deposit',
                entries: [
                    { accountId: vaultAccount, side: 'debit', amount: '2' },
                    { accountId: walletAccount, side: 'credit', amount: '2' },
                ],
                occurredAt: new Date().toISOString(),
            });
            await ledger.promote(sourceId, 'confirmed', evidence(
                sourceKey,
                `${signature}:clear-first-source:${mode}:${marker}`
            ));
            const proof = await query(
                `SELECT id FROM asset_evidence
                  WHERE journal_id = $1 AND commitment = 'confirmed'`,
                [sourceId]
            );
            const clearId = mode === 'journal' ? sourceId : String(proof.rows[0].id);
            const obligationId = await ledger.open({
                obligationKey: `clear-first-obligation:${mode}:${marker}`,
                orderId,
                cluster: 'mainnet-beta',
                walletAddress: wallet,
                vaultAddress: vault,
                mint,
                kind: 'provider_missing',
                reason: 'Exercise the clear-first journal coordination lock',
            });

            const clearer = await getClient();
            let rollback = true;
            try {
                await clearer.query('BEGIN');
                const clearSql = mode === 'journal'
                    ? `UPDATE asset_obligations
                          SET state = 'cleared', clear_journal_id = $2, cleared_at = CURRENT_TIMESTAMP
                        WHERE id = $1`
                    : `UPDATE asset_obligations
                          SET state = 'cleared', clear_evidence_id = $2, cleared_at = CURRENT_TIMESTAMP
                        WHERE id = $1`;
                await clearer.query(clearSql, [obligationId, clearId]);

                let startedResolve!: () => void;
                let racingPid = 0;
                const started = new Promise<void>((resolve) => { startedResolve = resolve; });
                const controlledTx = async <T>(work: (db: typeof query) => Promise<T>): Promise<T> => {
                    const client = await getClient();
                    try {
                        await client.query('BEGIN');
                        const db = (async (sql: string, params?: unknown[]) => {
                            if (sql.includes('post_asset_journal') && String(params?.[0]).includes(sourceId)) {
                                // The reversal FK's key-share acquisition blocks on the clearer's
                                // journal FOR UPDATE before the later state transition is reached.
                                racingPid = client.processID;
                                startedResolve();
                            }
                            return client.query(sql, params);
                        }) as typeof query;
                        const result = await work(db);
                        await client.query('COMMIT');
                        return result;
                    } catch (error) {
                        await client.query('ROLLBACK');
                        throw error;
                    } finally {
                        client.release();
                    }
                };
                const { AssetLedger } = await import('../src/services/assets/assetLedger');
                const racing = new AssetLedger(query, controlledTx);
                const reversalKey = `clear-first-reversal:${mode}:${marker}`;
                const reversal = racing.reverse(sourceId, {
                    effectKey: reversalKey,
                    cluster: 'mainnet-beta',
                    walletAddress: wallet,
                    orderId,
                    kind: 'reversal',
                    reversalOf: sourceId,
                    entries: [
                        { accountId: vaultAccount, side: 'credit', amount: '2' },
                        { accountId: walletAccount, side: 'debit', amount: '2' },
                    ],
                    occurredAt: new Date().toISOString(),
                }, 'confirmed', evidence(reversalKey, `${signature}:clear-first-reversal:${mode}:${marker}`));
                let reversalDone = false;
                const reversalResult = reversal.then(
                    (value) => ({ value, error: undefined }),
                    (error: unknown) => ({ value: undefined, error })
                ).finally(() => { reversalDone = true; });

                await started;
                await expect.poll(async () => {
                    const blockers = await query(
                        'SELECT cardinality(pg_blocking_pids($1)) AS count',
                        [racingPid]
                    );
                    return Number(blockers.rows[0].count);
                }).toBeGreaterThan(0);
                expect(reversalDone).toBe(false);
                await clearer.query('COMMIT');
                rollback = false;
                const outcome = await reversalResult;
                expect(outcome.error).toMatchObject({ code: 'asset_invariant' });
                const absent = await query('SELECT 1 FROM asset_journals WHERE effect_key = $1', [reversalKey]);
                expect(absent.rows).toHaveLength(0);
            } finally {
                if (rollback) await clearer.query('ROLLBACK');
                clearer.release();
            }
        }, 15_000);

    it.each(['journal', 'evidence'] as const)(
        'prevents reversal-first write skew against concurrent %s clearing', async (mode) => {
            const sourceKey = `reverse-first-source:${mode}:${marker}`;
            const sourceId = await ledger.post({
                effectKey: sourceKey,
                cluster: 'mainnet-beta',
                walletAddress: wallet,
                orderId,
                kind: 'deposit',
                entries: [
                    { accountId: vaultAccount, side: 'debit', amount: '2' },
                    { accountId: walletAccount, side: 'credit', amount: '2' },
                ],
                occurredAt: new Date().toISOString(),
            });
            await ledger.promote(sourceId, 'confirmed', evidence(
                sourceKey,
                `${signature}:reverse-first-source:${mode}:${marker}`
            ));
            const proof = await query(
                `SELECT id FROM asset_evidence
                  WHERE journal_id = $1 AND commitment = 'confirmed'`,
                [sourceId]
            );
            const clearId = String(proof.rows[0].id);
            const obligationId = await ledger.open({
                obligationKey: `reverse-first-obligation:${mode}:${marker}`,
                orderId,
                cluster: 'mainnet-beta',
                walletAddress: wallet,
                vaultAddress: vault,
                mint,
                kind: 'provider_missing',
                reason: 'Exercise the reversal-first journal coordination lock',
            });

            let readyResolve!: () => void;
            let releaseCommit!: () => void;
            const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
            const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
            const controlledTx = async <T>(work: (db: typeof query) => Promise<T>): Promise<T> => {
                const client = await getClient();
                try {
                    await client.query('BEGIN');
                    const db = ((sql: string, params?: unknown[]) => client.query(sql, params)) as typeof query;
                    const result = await work(db);
                    readyResolve();
                    await commitGate;
                    await client.query('COMMIT');
                    return result;
                } catch (error) {
                    await client.query('ROLLBACK');
                    throw error;
                } finally {
                    client.release();
                }
            };
            const { AssetLedger } = await import('../src/services/assets/assetLedger');
            const racing = new AssetLedger(query, controlledTx);
            const reversalKey = `reverse-first-reversal:${mode}:${marker}`;
            const reversal = racing.reverse(sourceId, {
                effectKey: reversalKey,
                cluster: 'mainnet-beta',
                walletAddress: wallet,
                orderId,
                kind: 'reversal',
                reversalOf: sourceId,
                entries: [
                    { accountId: vaultAccount, side: 'credit', amount: '2' },
                    { accountId: walletAccount, side: 'debit', amount: '2' },
                ],
                occurredAt: new Date().toISOString(),
            }, 'confirmed', evidence(reversalKey, `${signature}:reverse-first-reversal:${mode}:${marker}`));

            await ready;
            let clearDone = false;
            const clearing = ledger.clear(
                obligationId,
                mode === 'journal' ? { journalId: sourceId } : { evidenceId: clearId }
            )
                .then(() => ({ error: undefined }), (error: unknown) => ({ error }))
                .finally(() => { clearDone = true; });
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(clearDone).toBe(false);
            releaseCommit();
            await expect(reversal).resolves.toBeTypeOf('string');
            const result = await clearing;
            expect(result.error).toMatchObject({ code: 'asset_invariant' });
            const obligation = await query('SELECT state FROM asset_obligations WHERE id = $1', [obligationId]);
            expect(obligation.rows[0].state).toBe('open');
        }, 15_000);

    it('stores and exactly settles one multi-mint provider fill claim', async () => {
        const effectKey = `provider-fill:${marker}`;
        const providerDoc = { effectKey, provider: 'jupiter_trigger_v2', type: 'fill', ver: 1 };
        const providerHash = crypto.createHash('sha256')
            .update(canonicalJson(providerDoc)).digest('hex');
        const sourceAt = new Date().toISOString();
        const providerProof = (partMint: string, sourceKey: string) => ({
            effectKey,
            orderId,
            cluster: 'mainnet-beta' as const,
            walletAddress: wallet,
            vaultAddress: vault,
            mint: partMint,
            source: 'provider' as const,
            sourceKey,
            signature,
            payloadHash: providerHash,
            payload: providerDoc,
            sourceAt,
        });
        const incompleteProof = await ledger.evidence(providerProof(
            mint,
            `provider-fill:${marker}:incomplete`
        ));
        await expect(ledger.open({
            obligationKey: `provider-fill-incomplete:${marker}`,
            orderId,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            vaultAddress: vault,
            mint,
            kind: 'fill_unverified',
            amount: '3',
            openEvidenceId: incompleteProof,
            reason: 'Incomplete provider claim must fail closed',
        })).rejects.toMatchObject({ code: 'asset_invariant' });
        const missingObligation = crypto.randomUUID();
        const missingHash = crypto.createHash('sha256')
            .update(`input|${mint}|3|${incompleteProof}`)
            .digest('hex');
        const incomplete = await getClient();
        try {
            await incomplete.query('BEGIN');
            await incomplete.query(`
                INSERT INTO asset_obligations (
                    id, obligation_key, req_hash, order_id, cluster, wallet_address,
                    vault_address, mint, kind, amount, open_evidence_id, reason,
                    claim_ver, claim_count, claim_hash
                ) VALUES (
                    $1, $2, repeat('e', 64), $3, 'mainnet-beta', $4,
                    $5, $6, 'fill_unverified', 3, $7, 'Missing output must fail closed',
                    2, 2, repeat('f', 64)
                )
            `, [missingObligation, `provider-fill-missing:${marker}`, orderId,
                wallet, vault, mint, incompleteProof]);
            await incomplete.query(`
                INSERT INTO asset_claim_parts (
                    obligation_id, line_no, role, mint, amount, evidence_id, part_hash
                ) VALUES ($1, 0, 'input', $2, 3, $3, $4)
            `, [missingObligation, mint, incompleteProof, missingHash]);
            await expect(incomplete.query('COMMIT')).rejects.toBeTruthy();
            await incomplete.query('ROLLBACK');
        } finally {
            incomplete.release();
        }
        const crossedDoc = { ...providerDoc, type: 'crossed-fill' };
        const crossedProof = await ledger.evidence({
            ...providerProof(quoteMint, `provider-fill:${marker}:crossed`),
            signature: '6'.repeat(88),
            payloadHash: crypto.createHash('sha256')
                .update(canonicalJson(crossedDoc)).digest('hex'),
            payload: crossedDoc,
        });
        const crossedId = crypto.randomUUID();
        const inputHash = crypto.createHash('sha256')
            .update(`input|${mint}|3|${incompleteProof}`).digest('hex');
        const outputHash = crypto.createHash('sha256')
            .update(`output|${quoteMint}|7|${crossedProof}`).digest('hex');
        const crossedHash = crypto.createHash('sha256')
            .update(`0|${inputHash}\n1|${outputHash}`).digest('hex');
        const crossed = await getClient();
        try {
            await crossed.query('BEGIN');
            await crossed.query(`
                INSERT INTO asset_obligations (
                    id, obligation_key, req_hash, order_id, cluster, wallet_address,
                    vault_address, mint, kind, amount, open_evidence_id, reason,
                    claim_ver, claim_count, claim_hash
                ) VALUES (
                    $1, $2, repeat('d', 64), $3, 'mainnet-beta', $4,
                    $5, $6, 'fill_unverified', 3, $7, 'Crossed documents must fail closed',
                    2, 2, $8
                )
            `, [crossedId, `provider-fill-crossed:${marker}`, orderId, wallet,
                vault, mint, incompleteProof, crossedHash]);
            await crossed.query(`
                INSERT INTO asset_claim_parts (
                    obligation_id, line_no, role, mint, amount, evidence_id, part_hash
                ) VALUES
                    ($1, 0, 'input', $2, 3, $3, $4),
                    ($1, 1, 'output', $5, 7, $6, $7)
            `, [crossedId, mint, incompleteProof, inputHash, quoteMint, crossedProof, outputHash]);
            await expect(crossed.query('COMMIT')).rejects.toBeTruthy();
            await crossed.query('ROLLBACK');
        } finally {
            crossed.release();
        }
        const claim = {
            obligation: {
                obligationKey: `provider-fill-claim:${marker}`,
                orderId,
                cluster: 'mainnet-beta' as const,
                walletAddress: wallet,
                vaultAddress: vault,
                mint,
                kind: 'fill_unverified' as const,
                amount: '3',
                reason: 'Provider fill awaits independent chain settlement',
            },
            parts: [
                {
                    role: 'input' as const, mint, amount: '3',
                    evidence: providerProof(mint, `provider-fill:${marker}:input`),
                },
                {
                    role: 'output' as const, mint: quoteMint, amount: '7',
                    evidence: providerProof(quoteMint, `provider-fill:${marker}:output`),
                },
            ],
        };

        const obligationId = await ledger.claim(claim);
        await expect(ledger.claim(claim)).resolves.toBe(obligationId);
        const stored = await query(
            `SELECT role, mint, amount
               FROM asset_claim_parts
              WHERE obligation_id = $1
              ORDER BY line_no`,
            [obligationId]
        );
        expect(stored.rows).toEqual([
            { role: 'input', mint, amount: '3' },
            { role: 'output', mint: quoteMint, amount: '7' },
        ]);
        await expect(ledger.blocked({
            cluster: 'mainnet-beta', walletAddress: wallet, vaultAddress: vault,
            mint: quoteMint, orderId,
        })).resolves.toBe(true);

        const chainProof = await ledger.evidence(evidence(
            effectKey,
            `${signature}:provider-fill-proof:${marker}`
        ));
        await expect(ledger.clear(obligationId, { evidenceId: chainProof }))
            .rejects.toMatchObject({ code: 'asset_invariant' });

        const wrongKey = `provider-fill-wrong:${marker}`;
        const wrongJournal = await ledger.post({
            effectKey: wrongKey,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            orderId,
            kind: 'deposit',
            entries: [
                { accountId: vaultAccount, side: 'debit', amount: '10' },
                { accountId: walletAccount, side: 'credit', amount: '10' },
            ],
            occurredAt: new Date().toISOString(),
        });
        await ledger.promote(wrongJournal, 'confirmed', evidence(
            wrongKey,
            `${signature}:provider-fill-wrong:${marker}`
        ));
        await expect(ledger.clear(obligationId, { journalId: wrongJournal }))
            .rejects.toMatchObject({ code: 'asset_invariant' });

        const partialKey = `provider-fill-partial:${marker}`;
        const partialJournal = await ledger.post({
            effectKey: partialKey,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            orderId,
            kind: 'fill',
            entries: [
                { accountId: vaultAccount, side: 'credit', amount: '3' },
                { accountId: walletAccount, side: 'debit', amount: '3' },
            ],
            occurredAt: new Date().toISOString(),
        });
        await ledger.promote(partialJournal, 'confirmed', evidence(
            partialKey,
            `${signature}:provider-fill-partial:${marker}`
        ));
        await expect(ledger.clear(obligationId, { journalId: partialJournal }))
            .rejects.toMatchObject({ code: 'asset_invariant' });

        const settlement = await ledger.post({
            effectKey,
            cluster: 'mainnet-beta',
            walletAddress: wallet,
            orderId,
            kind: 'fill',
            entries: [
                { accountId: vaultAccount, side: 'credit', amount: '3' },
                { accountId: walletAccount, side: 'debit', amount: '3' },
                { accountId: quoteVaultAccount, side: 'debit', amount: '7' },
                { accountId: quoteWalletAccount, side: 'credit', amount: '7' },
            ],
            occurredAt: new Date().toISOString(),
        });
        await ledger.promote(settlement, 'confirmed', evidence(
            effectKey,
            `${signature}:provider-fill-wrong-signature:${marker}`,
            { signature: '6'.repeat(88) }
        ));
        await expect(ledger.clear(obligationId, { journalId: settlement }))
            .rejects.toMatchObject({ code: 'asset_invariant' });
        await ledger.promote(settlement, 'confirmed', evidence(
            effectKey,
            `${signature}:provider-fill-settlement:${marker}`
        ));
        await ledger.clear(obligationId, { journalId: settlement });
        await expect(ledger.blocked({
            cluster: 'mainnet-beta', walletAddress: wallet, vaultAddress: vault,
            mint: quoteMint, orderId,
        })).resolves.toBe(false);
    });

    it('locks only the actionable multi-mint claim scope once', async () => {
        const activeOrder = crypto.randomUUID();
        const terminalOrder = crypto.randomUUID();
        const terminalActionOrder = crypto.randomUUID();
        const terminalAction = crypto.randomUUID();
        await query(`
            INSERT INTO order_intents (
                id, user_id, provider, client_order_id, request_digest, wallet_address,
                order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                params, cluster, expires_at
            ) VALUES
                ($1, $2, 'fixture', $3, repeat('1', 64), $4, 'single', 'open',
                 $5, $6, 1, $6, '{}'::jsonb, 'mainnet-beta', clock_timestamp() + INTERVAL '1 day'),
                ($7, $2, 'fixture', $8, repeat('2', 64), $4, 'single', 'filled',
                 $5, $6, 1, $6, '{}'::jsonb, 'mainnet-beta', clock_timestamp() + INTERVAL '1 day'),
                ($9, $2, 'fixture', $10, repeat('3', 64), $4, 'single', 'filled',
                 $5, $6, 1, $6, '{}'::jsonb, 'mainnet-beta', clock_timestamp() + INTERVAL '1 day')
        `, [activeOrder, userId, `claim-active-${marker}`, wallet, mint, quoteMint,
            terminalOrder, `claim-terminal-${marker}`, terminalActionOrder,
            `claim-terminal-action-${marker}`]);
        await query(`
            INSERT INTO order_actions (
                id, order_id, user_id, kind, client_key, req_hash, desired_hash,
                expected_ver, work_state, effect_state, outcome, provider, due_at
            ) VALUES (
                $1, $2, $3, 'compensate', $4, repeat('4', 64), repeat('5', 64),
                0, 'queued', 'not_possible', 'pending', 'fixture', clock_timestamp()
            )
        `, [terminalAction, terminalActionOrder, userId, `claim-terminal-action-${marker}`]);
        const client = await getClient();
        try {
            await client.query('BEGIN');
            await client.query('CREATE TEMP SEQUENCE claim_lock_calls');
            await client.query(`
                ALTER FUNCTION asset_lock_claim_scope(UUID)
                    RENAME TO asset_lock_claim_scope_real;
                CREATE FUNCTION asset_lock_claim_scope(target UUID) RETURNS VOID
                LANGUAGE plpgsql
                SET search_path = pg_catalog, public, pg_temp AS $$
                BEGIN
                    PERFORM nextval('pg_temp.claim_lock_calls');
                    PERFORM public.asset_lock_claim_scope_real(target);
                END;
                $$;
            `);
            const db = ((sql: string, params?: unknown[]) => client.query(sql, params)) as typeof query;
            const { AssetLedger } = await import('../src/services/assets/assetLedger');
            const localLedger = new AssetLedger(db, async (work) => work(db));
            const effectKey = `claim-lock-count:${marker}`;
            const document = { effectKey, provider: 'fixture', type: 'fill', ver: 1 };
            const payloadHash = crypto.createHash('sha256')
                .update(canonicalJson(document)).digest('hex');
            const sourceAt = new Date().toISOString();
            const proof = (role: 'input' | 'output', partMint: string) => ({
                effectKey,
                orderId,
                cluster: 'mainnet-beta' as const,
                walletAddress: wallet,
                vaultAddress: vault,
                mint: partMint,
                source: 'provider' as const,
                sourceKey: `${effectKey}:${role}`,
                signature,
                payloadHash,
                payload: document,
                sourceAt,
            });

            await localLedger.claim({
                obligation: {
                    obligationKey: `${effectKey}:claim`,
                    orderId,
                    cluster: 'mainnet-beta',
                    walletAddress: wallet,
                    vaultAddress: vault,
                    mint,
                    kind: 'fill_unverified',
                    amount: '1',
                    reason: 'Count complete-claim scope acquisition',
                },
                parts: [
                    { role: 'input', mint, amount: '1', evidence: proof('input', mint) },
                    { role: 'output', mint: quoteMint, amount: '2', evidence: proof('output', quoteMint) },
                ],
            });
            await client.query('SET CONSTRAINTS ALL IMMEDIATE');
            const probe = async (target: string): Promise<void> => {
                const lock = await getClient();
                try {
                    await lock.query('BEGIN');
                    await lock.query("SET LOCAL lock_timeout = '250ms'");
                    await lock.query(
                        'SELECT id FROM order_intents WHERE id = $1 FOR UPDATE', [target]
                    );
                } finally {
                    await lock.query('ROLLBACK');
                    lock.release();
                }
            };
            await expect(probe(terminalOrder)).resolves.toBeUndefined();
            await expect(probe(activeOrder)).rejects.toMatchObject({ code: '55P03' });
            await expect(probe(terminalActionOrder)).rejects.toMatchObject({ code: '55P03' });
            const calls = await client.query(
                'SELECT last_value::int AS count, is_called FROM claim_lock_calls'
            );
            expect(calls.rows[0]).toEqual({ count: 1, is_called: true });
        } finally {
            await client.query('ROLLBACK');
            client.release();
        }
    });

});
