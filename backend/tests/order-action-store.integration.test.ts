import { createHash, randomBytes, randomUUID } from 'crypto';
import bs58 from 'bs58';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/services/orders/canonicalJson';

const suite = process.env.RUN_INFRA_TESTS === 'true' ? describe : describe.skip;

suite('order action store infrastructure', () => {
    let closeDatabase: typeof import('../src/config/database').closeDatabase;
    let query: typeof import('../src/config/database').query;
    let transaction: typeof import('../src/config/database').transaction;
    let store: import('../src/services/orders/orderActionStore').OrderActionStore;
    let observations: import('../src/services/orders/actionObservationStore').ActionObservationStore;
    let gate: import('../src/services/orders/mutationGate').MutationGate<string>;
    let forwarder: import('../src/services/orders/mutationGate').MutationForward<string>;
    let forwardCalls = 0;

    beforeAll(async () => {
        process.env.CORE_DATABASE_URL ??= 'postgresql://fervor@localhost:55432/fervor';
        process.env.MARKET_DATABASE_URL ??= process.env.CORE_DATABASE_URL;
        ({ query, transaction, closeDatabase } = await import('../src/config/database'));
        const { OrderActionStore } = await import('../src/services/orders/orderActionStore');
        const { ActionObservationStore } = await import(
            '../src/services/orders/actionObservationStore'
        );
        const { MutationGate } = await import('../src/services/orders/mutationGate');
        store = new OrderActionStore();
        observations = new ActionObservationStore();
        forwarder = async ({ attempt, signal }) => {
            forwardCalls += 1;
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, 25);
                signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(new Error('fixture transport deadline'));
                }, { once: true });
            });
            return attempt.id;
        };
        gate = new MutationGate((context) => forwarder(context));
    });

    afterAll(async () => {
        await closeDatabase?.();
    });

    it('admits, fences, dispatches, records, and reconciles one durable effect', async () => {
        const marker = randomBytes(8).toString('hex');
        const userId = randomUUID();
        const orderId = randomUUID();
        const actionId = randomUUID();
        const wallet = `ActionWallet${marker}`;
        const inputMint = 'So11111111111111111111111111111111111111112';
        const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const clientKey = `activate:${marker}`;
        const reqHash = 'a'.repeat(64);
        const desiredHash = 'b'.repeat(64);
        const traceId = `trace-${marker}`;
        const provider = `fixture_${marker}`;
        await query('INSERT INTO users (id, wallet_address) VALUES ($1, $2)', [userId, wallet]);
        await query(`
            INSERT INTO order_intents (
                id, user_id, provider, client_order_id, request_digest, wallet_address,
                order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                params, expires_at, cluster, family, strategy_kind, trigger_state,
                fill_state, funds_state, remaining_in, filled_in, filled_out, req_ver
            ) VALUES (
                $1, $2, $7, $3, repeat('c', 64), $4, 'single', 'prepared',
                $5, $6, 1000, $6, '{}'::jsonb, CURRENT_TIMESTAMP + INTERVAL '1 day',
                'mainnet-beta', 'price', 'single', 'pending', 'none', 'wallet',
                1000, 0, 0, 1
            )
        `, [orderId, userId, `order-${marker}`, wallet, inputMint, outputMint, provider]);
        await query(`
            INSERT INTO order_epochs (scope, epoch, region, mode, authority, proof_hash, source_key)
            VALUES ($1, 1, 'ci', 'live', 'integration', repeat('d', 64), $2)
        `, [`provider:${provider}`, `fixture:epoch:${marker}:1`]);

        const admission = {
            id: actionId,
            orderId,
            userId,
            kind: 'provider_sync' as const,
            ruleVer: 1 as const,
            clientKey,
            reqHash,
            desiredHash,
            expectedVer: '0',
            provider,
            dueAt: new Date(Date.now() - 1_000).toISOString(),
            traceId,
            actor: 'user' as const,
        };
        const admitted = await store.admit(admission);
        expect(admitted).toMatchObject({ replayed: false, action: { id: actionId, version: '0' } });
        await expect(store.admit(admission)).resolves.toMatchObject({
            replayed: true, action: { id: actionId, version: '0' },
        });
        await expect(store.admit({
            ...admission, id: randomUUID(), desiredHash: 'e'.repeat(64),
        })).rejects.toMatchObject({ code: 'idempotency_conflict' });

        const admittedVer = await query(
            'SELECT order_ver FROM order_intents WHERE id = $1', [orderId]
        );
        expect(admittedVer.rows[0].order_ver).toBe('1');
        await expect(store.admit({
            ...admission,
            id: randomUUID(),
            clientKey: `blocked-successor:${marker}`,
            reqHash: '1'.repeat(64),
            desiredHash: '3'.repeat(64),
            expectedVer: '1',
            dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        })).rejects.toMatchObject({ code: 'state_conflict' });
        await expect(store.admit(admission)).resolves.toMatchObject({
            replayed: true, action: { id: actionId },
        });

        let locked!: () => void;
        let releaseLock!: () => void;
        const lockReady = new Promise<void>((resolve) => { locked = resolve; });
        const lockRelease = new Promise<void>((resolve) => { releaseLock = resolve; });
        const lockHolder = transaction(async (db) => {
            await db('SELECT id FROM order_intents WHERE id = $1 FOR UPDATE', [orderId]);
            locked();
            await lockRelease;
        });
        await lockReady;
        let anomalySettled = false;
        const anomalyId = randomUUID();
        const anomalyInsert = query(`
            INSERT INTO order_anomalies (
                id, anomaly_key, order_id, action_id, scope, kind, severity,
                blocks_actions, detail_hash, detail
            ) VALUES (
                $1, $2, $3, $4, 'action', 'stale_epoch', 'critical',
                true, repeat('9', 64), '{}'::jsonb
            )
        `, [anomalyId, `lock-race:${marker}`, orderId, actionId]).then((result) => {
            anomalySettled = true;
            return result;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(anomalySettled).toBe(false);
        releaseLock();
        await Promise.all([lockHolder, anomalyInsert]);
        expect(anomalySettled).toBe(true);
        await query(`
            UPDATE order_anomalies
               SET state = 'resolved', resolution_hash = repeat('8', 64),
                   resolved_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE id = $1
        `, [anomalyId]);

        const expiryProvider = `expiry_${marker}`;
        const expiryOrder = randomUUID();
        const expiryAction = randomUUID();
        const expiryReq = '6'.repeat(64);
        const expiryDesired = '7'.repeat(64);
        await query(`
            INSERT INTO order_epochs (scope, epoch, region, mode, authority, proof_hash, source_key)
            VALUES ($1, 1, 'ci', 'live', 'integration', repeat('8', 64), $2)
        `, [`provider:${expiryProvider}`, `fixture:expiry:${marker}:1`]);
        await query(`
            INSERT INTO order_intents (
                id, user_id, provider, client_order_id, request_digest, wallet_address,
                order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                params, expires_at, cluster, family, strategy_kind, trigger_state,
                fill_state, funds_state, remaining_in, filled_in, filled_out, req_ver
            ) VALUES (
                $1, $2, $7, $3, repeat('5', 64), $4, 'single', 'prepared',
                $5, $6, 1000, $6, '{}'::jsonb, CURRENT_TIMESTAMP + INTERVAL '1 day',
                'mainnet-beta', 'price', 'single', 'pending', 'none', 'wallet',
                1000, 0, 0, 1
            )
        `, [expiryOrder, userId, `expiry-order-${marker}`, wallet, inputMint, outputMint, expiryProvider]);
        await store.admit({
            ...admission,
            id: expiryAction,
            orderId: expiryOrder,
            kind: 'provider_sync',
            clientKey: `expiry:${marker}`,
            reqHash: expiryReq,
            desiredHash: expiryDesired,
            expectedVer: '0',
            provider: expiryProvider,
        });
        const expiryClaim = await store.claim({
            provider: expiryProvider,
            owner: `expiry-worker-${marker}`,
            epoch: '1',
            leaseMs: 30_000,
            limit: 1,
        });
        const expiryFence = {
            owner: expiryClaim[0].lease!.owner,
            gen: expiryClaim[0].lease!.gen,
            scope: expiryClaim[0].lease!.scope,
            epoch: expiryClaim[0].lease!.epoch,
        };
        const expiryReady = await store.ready({
            actionId: expiryAction,
            expectedVer: '1',
            fence: expiryFence,
            dueAt: new Date(Date.now() - 100).toISOString(),
            traceId,
            actor: 'system',
        });
        const expiryStarted = await store.start({
            id: randomUUID(),
            actionId: expiryAction,
            expectedVer: expiryReady.version,
            fence: expiryFence,
            endpoint: '/expiry-fixture',
            method: 'GET',
            reqHash: expiryReq,
            deadlineAt: new Date(Date.now() + 10_000).toISOString(),
            traceId,
            actor: 'system',
        });
        const expiryCalls = forwardCalls;
        const ordinaryForward = forwarder;
        let freezeSettled = false;
        let freezeTask: Promise<unknown> | undefined;
        forwarder = async ({ attempt }) => {
            forwardCalls += 1;
            freezeTask = query(`
                INSERT INTO order_epochs (scope, epoch, mode, authority, proof_hash, source_key)
                VALUES ($1, 2, 'frozen', 'integration', repeat('4', 64), $2)
            `, [`provider:${expiryProvider}`, `fixture:expiry:${marker}:2`]).then((result) => {
                freezeSettled = true;
                return result;
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(freezeSettled).toBe(false);
            return attempt.id;
        };
        await expect(gate.run({
            actionId: expiryAction,
            attemptId: expiryStarted.attempt.id,
            fence: expiryFence,
        })).resolves.toBe(expiryStarted.attempt.id);
        await freezeTask;
        forwarder = ordinaryForward;
        expect(freezeSettled).toBe(true);
        expect(forwardCalls).toBe(expiryCalls + 1);
        const expiredEgress = await query(
            'SELECT count(*)::int AS count FROM action_egress WHERE attempt_id = $1',
            [expiryStarted.attempt.id]
        );
        expect(expiredEgress.rows[0].count).toBe(1);
        await expect(gate.run({
            actionId: expiryAction,
            attemptId: expiryStarted.attempt.id,
            fence: expiryFence,
        })).rejects.toMatchObject({ code: 'already_forwarded', uncertain: true });
        const safeReconcile = await store.reconcile({
            actionId: expiryAction,
            expectedVer: expiryStarted.action.version,
            fence: expiryFence,
            dueAt: new Date().toISOString(),
            errorCode: 'closed_epoch_fixture',
            traceId,
            actor: 'system',
        });
        expect(safeReconcile).toMatchObject({
            version: '4', workState: 'reconciling', lease: undefined,
        });
        await expect(store.respond({
            attemptId: expiryStarted.attempt.id,
            completedAt: new Date().toISOString(),
            httpClass: 'timeout',
            errorCode: 'provider_timeout',
            traceId,
            actor: 'provider',
        })).resolves.toMatchObject({ replayed: false, attempt: { sendState: 'response_recorded' } });

        const faultProvider = `fault_${marker}`;
        const faultOrder = randomUUID();
        const faultAction = randomUUID();
        const faultReq = '2'.repeat(64);
        const faultDesired = '3'.repeat(64);
        await query(`
            INSERT INTO order_epochs (scope, epoch, region, mode, authority, proof_hash, source_key)
            VALUES ($1, 1, 'ci', 'live', 'integration', repeat('2', 64), $2)
        `, [`provider:${faultProvider}`, `fixture:fault:${marker}:1`]);
        await query(`
            INSERT INTO order_intents (
                id, user_id, provider, client_order_id, request_digest, wallet_address,
                order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                params, expires_at, cluster, family, strategy_kind, trigger_state,
                fill_state, funds_state, remaining_in, filled_in, filled_out, req_ver
            ) VALUES (
                $1, $2, $7, $3, repeat('2', 64), $4, 'single', 'prepared',
                $5, $6, 1000, $6, '{}'::jsonb, CURRENT_TIMESTAMP + INTERVAL '1 day',
                'mainnet-beta', 'price', 'single', 'pending', 'none', 'wallet',
                1000, 0, 0, 1
            )
        `, [faultOrder, userId, `fault-order-${marker}`, wallet,
            inputMint, outputMint, faultProvider]);
        await store.admit({
            ...admission,
            id: faultAction,
            orderId: faultOrder,
            clientKey: `fault:${marker}`,
            reqHash: faultReq,
            desiredHash: faultDesired,
            provider: faultProvider,
        });
        const faultClaim = (await store.claim({
            provider: faultProvider,
            owner: `fault-worker-${marker}`,
            epoch: '1',
            leaseMs: 30_000,
            limit: 1,
        }))[0];
        const faultFence = {
            owner: faultClaim.lease!.owner,
            gen: faultClaim.lease!.gen,
            scope: faultClaim.lease!.scope,
            epoch: faultClaim.lease!.epoch,
        };
        const faultReady = await store.ready({
            actionId: faultAction,
            expectedVer: faultClaim.version,
            fence: faultFence,
            dueAt: new Date(Date.now() - 100).toISOString(),
            traceId,
            actor: 'system',
        });
        const faultDeadline = new Date(Date.now() + 1_500).toISOString();
        const faultStarted = await store.start({
            id: randomUUID(),
            actionId: faultAction,
            expectedVer: faultReady.version,
            fence: faultFence,
            endpoint: '/fault-fixture',
            method: 'GET',
            reqHash: faultReq,
            deadlineAt: faultDeadline,
            traceId,
            actor: 'system',
        });
        let transportEntered!: () => void;
        const transportReady = new Promise<void>((resolve) => { transportEntered = resolve; });
        let networkEntered = false;
        forwarder = async ({ signal }) => {
            forwardCalls += 1;
            transportEntered();
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    networkEntered = true;
                    resolve();
                }, 10_000);
                signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(signal.reason);
                }, { once: true });
            });
            return faultStarted.attempt.id;
        };
        const faultRun = gate.run({
            actionId: faultAction,
            attemptId: faultStarted.attempt.id,
            fence: faultFence,
        });
        await transportReady;
        const egressPid = await query(`
            SELECT pid
              FROM pg_stat_activity
             WHERE datname = current_database()
               AND application_name = $1
        `, [`fervor-egress-${process.pid}`]);
        expect(egressPid.rowCount).toBe(1);
        await query('SELECT pg_terminate_backend($1)', [egressPid.rows[0].pid]);
        await expect(faultRun).rejects.toMatchObject({
            code: 'audit_failed', uncertain: true,
        });
        expect(networkEntered).toBe(false);
        const faultScope = `provider:${faultProvider}`;
        const faultEpochKey = `fixture:fault:${marker}:2`;
        await expect(query(`
            INSERT INTO order_epochs (scope, epoch, mode, authority, proof_hash, source_key)
            VALUES ($1, 2, 'frozen', 'integration', repeat('4', 64), $2)
        `, [faultScope, faultEpochKey])).rejects.toMatchObject({
            code: '55P03', message: 'write epoch has an unexpired durable egress authorization',
        });
        await new Promise((resolve) => setTimeout(
            resolve,
            Math.max(0, Date.parse(faultDeadline) - Date.now()) + 50
        ));
        await expect(query(`
            INSERT INTO order_epochs (scope, epoch, mode, authority, proof_hash, source_key)
            VALUES ($1, 2, 'frozen', 'integration', repeat('4', 64), $2)
        `, [faultScope, faultEpochKey])).resolves.toMatchObject({ rowCount: 1 });
        forwarder = ordinaryForward;

        const claim = {
            provider, owner: `worker-${marker}`, epoch: '1', leaseMs: 30_000, limit: 10,
        };
        const contenders = await Promise.all([store.claim(claim), store.claim(claim)]);
        const claimed = contenders.flat().filter((action) => action.id === actionId);
        expect(claimed).toHaveLength(1);
        expect(claimed[0]).toMatchObject({ version: '1', lease: { gen: '1', epoch: '1' } });
        const fence = {
            owner: claimed[0].lease!.owner,
            gen: claimed[0].lease!.gen,
            scope: claimed[0].lease!.scope,
            epoch: claimed[0].lease!.epoch,
        };
        const ready = await store.ready({
            actionId, expectedVer: '1', fence,
            dueAt: new Date(Date.now() - 500).toISOString(), traceId, actor: 'system',
        });
        expect(ready).toMatchObject({ version: '2', workState: 'ready', effectState: 'not_possible' });

        await expect(store.start({
            id: randomUUID(), actionId, expectedVer: '2', fence,
            endpoint: '/trigger/v2/orders', method: 'POST', reqHash,
            bodyHash: 'f'.repeat(64),
            deadlineAt: new Date(Date.now() + 10_000).toISOString(), traceId, actor: 'system',
        })).rejects.toMatchObject({ code: 'invalid_input' });

        const started = await store.start({
            id: randomUUID(), actionId, expectedVer: '2', fence,
            endpoint: '/trigger/v2/orders', method: 'GET', reqHash,
            providerReqId: `provider-${marker}`,
            deadlineAt: new Date(Date.now() + 10_000).toISOString(), traceId, actor: 'system',
        });
        expect(started.action).toMatchObject({
            version: '3', workState: 'dispatching', effectState: 'possible', attemptCount: 1,
        });
        expect(started.attempt).toMatchObject({ seq: 1, sendState: 'started', leaseGen: '1' });

        const callsBefore = forwardCalls;
        await expect(query(`
            INSERT INTO action_egress (
                attempt_id, action_id, lease_owner, lease_gen, write_scope, write_epoch,
                provider, endpoint, method, req_hash, body_hash, desired_hash, blob_action_id
            )
            SELECT attempt.id, action.id, $3, attempt.lease_gen, attempt.write_scope,
                   attempt.write_epoch, attempt.provider, attempt.endpoint, attempt.method,
                   attempt.req_hash, attempt.body_hash, attempt.desired_hash, attempt.blob_action_id
              FROM order_actions action
              JOIN action_attempts attempt ON attempt.action_id = action.id
             WHERE action.id = $1 AND attempt.id = $2
        `, [actionId, started.attempt.id, `${fence.owner}-wrong`])).rejects.toMatchObject({
            code: '40001', message: 'egress does not match one active fenced attempt',
        });
        await expect(gate.run({
            actionId,
            attemptId: started.attempt.id,
            fence: { ...fence, owner: `${fence.owner}-wrong` },
        })).rejects.toMatchObject({ code: 'fence_closed', retryable: true, uncertain: false });
        expect(forwardCalls).toBe(callsBefore);
        const deniedEgress = await query(
            'SELECT count(*)::int AS count FROM action_egress WHERE attempt_id = $1',
            [started.attempt.id]
        );
        expect(deniedEgress.rows[0].count).toBe(0);
        const gateRace = await Promise.allSettled([
            gate.run({ actionId, attemptId: started.attempt.id, fence }),
            gate.run({ actionId, attemptId: started.attempt.id, fence }),
        ]);
        expect(gateRace.filter((result) => result.status === 'fulfilled')).toEqual([
            expect.objectContaining({ status: 'fulfilled', value: started.attempt.id }),
        ]);
        expect(gateRace.filter((result) => result.status === 'rejected')).toEqual([
            expect.objectContaining({
                status: 'rejected',
                reason: expect.objectContaining({
                    code: 'already_forwarded', retryable: false, uncertain: true,
                }),
            }),
        ]);
        expect(forwardCalls).toBe(callsBefore + 1);
        const egress = await query(`
            SELECT action_id, lease_owner, lease_gen, write_scope, write_epoch,
                   provider, endpoint, method, req_hash, body_hash, desired_hash,
                   blob_action_id, forwarded_at, completed_at
              FROM action_egress
             WHERE attempt_id = $1
        `, [started.attempt.id]);
        expect(egress.rows).toEqual([expect.objectContaining({
            action_id: actionId,
            lease_owner: fence.owner,
            lease_gen: fence.gen,
            write_scope: fence.scope,
            write_epoch: fence.epoch,
            provider,
            endpoint: started.attempt.endpoint,
            method: started.attempt.method,
            req_hash: reqHash,
            body_hash: null,
            desired_hash: desiredHash,
            blob_action_id: null,
            forwarded_at: expect.any(Date),
            completed_at: expect.any(Date),
        })]);
        await expect(gate.run({ actionId, attemptId: started.attempt.id, fence }))
            .rejects.toMatchObject({ code: 'already_forwarded', uncertain: true });
        expect(forwardCalls).toBe(callsBefore + 1);
        await expect(query(`
            UPDATE action_egress SET endpoint = '/tampered' WHERE attempt_id = $1
        `, [started.attempt.id])).rejects.toMatchObject({
            code: '55000', message: 'invalid action egress fact transition',
        });
        await expect(query(`
            UPDATE action_egress SET completed_at = clock_timestamp() WHERE attempt_id = $1
        `, [started.attempt.id])).rejects.toMatchObject({
            code: '55000', message: 'invalid action egress fact transition',
        });
        await expect(query(
            'DELETE FROM action_egress WHERE attempt_id = $1', [started.attempt.id]
        )).rejects.toMatchObject({ code: '55000', message: 'action egress is append-once' });

        const response = {
            attemptId: started.attempt.id,
            completedAt: new Date(Date.now() + 20).toISOString(),
            httpClass: 'success' as const,
            httpStatus: 202,
            responseHash: '1'.repeat(64),
            providerEffectId: `effect-${marker}`,
            traceId,
            actor: 'provider' as const,
        };
        const responseRace = await Promise.all([store.respond(response), store.respond(response)]);
        expect(responseRace.map((result) => result.replayed).sort()).toEqual([false, true]);
        expect(responseRace[0].attempt).toMatchObject({
            sendState: 'response_recorded', httpStatus: 202,
        });
        await expect(store.respond({ ...response, responseHash: '2'.repeat(64) }))
            .rejects.toMatchObject({ code: 'attempt_conflict' });

        const reconciled = await store.reconcile({
            actionId, expectedVer: '3', fence,
            dueAt: new Date(Date.now() - 100).toISOString(),
            errorCode: 'provider_pending', errorClass: 'ambiguous', httpClass: 'success',
            traceId, actor: 'system',
        });
        expect(reconciled).toMatchObject({
            version: '4', workState: 'reconciling', effectState: 'possible', lease: undefined,
        });
        const reclaimed = (await store.claim(claim)).find((action) => action.id === actionId);
        expect(reclaimed).toMatchObject({ version: '5', lease: { gen: '2', epoch: '1' } });
        const reclaimedFence = {
            owner: reclaimed!.lease!.owner,
            gen: reclaimed!.lease!.gen,
            scope: reclaimed!.lease!.scope,
            epoch: reclaimed!.lease!.epoch,
        };
        const deferred = await store.defer({
            actionId,
            expectedVer: reclaimed!.version,
            fence: reclaimedFence,
            dueAt: new Date(Date.now() - 100).toISOString(),
            errorCode: 'provider_read_timeout',
            errorClass: 'transient',
            traceId,
            actor: 'system',
        });
        expect(deferred).toMatchObject({
            version: '6', workState: 'reconciling', effectState: 'possible', lease: undefined,
        });
        const evidenceClaim = (await store.claim(claim)).find((action) => action.id === actionId);
        expect(evidenceClaim).toMatchObject({ version: '7', lease: { gen: '3', epoch: '1' } });

        const disallowedPayload = { signature: '5'.repeat(88), state: 'observed' };
        await expect(observations.observe({
            id: randomUUID(),
            actionId,
            attemptId: started.attempt.id,
            source: 'chain',
            cluster: 'mainnet-beta',
            sourceKey: `chain:${marker}:disallowed`,
            factKey: `chain:${marker}:disallowed-state`,
            factRev: 1,
            queryKind: 'found',
            verdict: 'context',
            predicate: 'provider_sync.chain.effect.v1',
            ruleVer: 1,
            desiredHash,
            signature: '5'.repeat(88),
            slot: '1',
            instructionIndex: 0,
            eventIndex: 0,
            commitment: 'confirmed',
            payloadHash: createHash('sha256')
                .update(canonicalJson(disallowedPayload)).digest('hex'),
            payloadVer: 1,
            payload: disallowedPayload,
            traceId,
            actor: 'chain',
        })).rejects.toMatchObject({
            code: 'state_conflict',
            message: 'Observation source is not authorized for this action rule',
        });
        const disallowedFacts = await query(`
            SELECT count(*)::int AS count FROM action_obs WHERE source_key = $1
        `, [`chain:${marker}:disallowed`]);
        expect(disallowedFacts.rows[0].count).toBe(0);

        const observationId = randomUUID();
        const evidencePayload = { orderId: `effect-${marker}`, state: 'open' };
        const evidenceHash = createHash('sha256')
            .update(canonicalJson(evidencePayload)).digest('hex');
        const providerObservation = {
            id: observationId,
            actionId,
            attemptId: started.attempt.id,
            source: 'provider' as const,
            cluster: 'mainnet-beta' as const,
            sourceKey: `provider:${marker}:presence:1`,
            factKey: `provider:${marker}:order-state`,
            factRev: 1,
            queryKind: 'found' as const,
            verdict: 'presence' as const,
            predicate: 'provider_sync.provider.effect.v1',
            ruleVer: 1 as const,
            provider,
            rawState: 'open',
            normState: 'present',
            desiredHash,
            effectHash: desiredHash,
            providerReqId: `provider-${marker}`,
            providerOrderId: `effect-${marker}`,
            payloadHash: evidenceHash,
            payloadVer: 1,
            payload: evidencePayload,
            sourceAt: response.completedAt,
            traceId,
            actor: 'provider' as const,
        };
        const observed = await observations.observe(providerObservation);
        expect(observed).toMatchObject({
            replayed: false,
            action: {
                version: '8', workState: 'done', effectState: 'present', outcome: 'succeeded',
                lease: undefined,
            },
            observation: { id: observationId, factRev: 1, verdict: 'presence' },
        });
        await expect(observations.observe(providerObservation)).resolves.toMatchObject({
            replayed: true,
            action: { version: '8', workState: 'done', effectState: 'present' },
        });
        const changedPayload = { ...evidencePayload, state: 'closed' };
        await expect(observations.observe({
            ...providerObservation,
            payload: changedPayload,
            payloadHash: createHash('sha256').update(canonicalJson(changedPayload)).digest('hex'),
        })).rejects.toMatchObject({ code: 'observation_conflict' });

        const deniedPayload = { checked: true, state: 'missing' };
        await expect(observations.observe({
            ...providerObservation,
            id: randomUUID(),
            sourceKey: `provider:${marker}:absence:2`,
            factRev: 2,
            supersedes: observationId,
            queryKind: 'found',
            verdict: 'absence',
            effectHash: undefined,
            payload: deniedPayload,
            payloadHash: createHash('sha256').update(canonicalJson(deniedPayload)).digest('hex'),
        })).rejects.toMatchObject({ code: 'state_conflict' });

        const conflictPayload = { orderId: `effect-${marker}`, state: 'mismatched' };
        const conflictId = randomUUID();
        const conflict = await observations.observe({
            ...providerObservation,
            id: conflictId,
            sourceKey: `provider:${marker}:conflict:2`,
            factRev: 2,
            supersedes: observationId,
            verdict: 'conflict',
            effectHash: 'c'.repeat(64),
            payload: conflictPayload,
            payloadHash: createHash('sha256').update(canonicalJson(conflictPayload)).digest('hex'),
        });
        expect(conflict).toMatchObject({
            replayed: false,
            action: { version: '8', workState: 'done', effectState: 'present' },
            observation: { id: conflictId, factRev: 2, verdict: 'conflict' },
        });
        const anomaly = await query(`
            SELECT id, state, severity, blocks_actions, detail
              FROM order_anomalies
             WHERE action_id = $1 AND kind = 'policy_violation'
        `, [actionId]);
        expect(anomaly.rows).toEqual([expect.objectContaining({
            state: 'open', severity: 'critical', blocks_actions: true,
            detail: expect.objectContaining({
                observationId: conflictId,
                storedEffect: 'present',
                derivedEffect: 'conflict',
            }),
        })]);
        await expect(query(`
            UPDATE order_anomalies
               SET state = 'resolved', resolution_hash = repeat('5', 64),
                   resolved_at = clock_timestamp()
             WHERE id = $1
        `, [anomaly.rows[0].id])).rejects.toMatchObject({
            code: '23514',
            message: 'terminal evidence anomaly cannot resolve while current proof still diverges',
        });

        const blockedAction = randomUUID();
        const blockedReq = '2'.repeat(64);
        await store.admit({
            ...admission,
            id: blockedAction,
            kind: 'edit',
            clientKey: `blocked-anomaly:${marker}`,
            reqHash: blockedReq,
            desiredHash: '3'.repeat(64),
            expectedVer: '1',
        });
        const blockedClaim = (await store.claim(claim)).find((action) => action.id === blockedAction);
        const blockedFence = {
            owner: blockedClaim!.lease!.owner,
            gen: blockedClaim!.lease!.gen,
            scope: blockedClaim!.lease!.scope,
            epoch: blockedClaim!.lease!.epoch,
        };
        const blockedReady = await store.ready({
            actionId: blockedAction,
            expectedVer: blockedClaim!.version,
            fence: blockedFence,
            dueAt: new Date(Date.now() - 100).toISOString(),
            traceId,
            actor: 'system',
        });
        await expect(store.start({
            id: randomUUID(),
            actionId: blockedAction,
            expectedVer: blockedReady.version,
            fence: blockedFence,
            endpoint: '/trigger/v2/orders',
            method: 'PATCH',
            reqHash: blockedReq,
            bodyHash: '4'.repeat(64),
            deadlineAt: new Date(Date.now() + 10_000).toISOString(),
            traceId,
            actor: 'system',
        })).rejects.toMatchObject({ code: 'state_conflict' });
        const blockedState = await query(
            'SELECT action_ver, work_state, attempt_count FROM order_actions WHERE id = $1',
            [blockedAction]
        );
        expect(blockedState.rows[0]).toEqual({
            action_ver: '2', work_state: 'ready', attempt_count: 0,
        });
        await expect(query(`
            INSERT INTO action_obs (
                id, action_id, source, cluster, source_key, fact_key, fact_rev,
                query_kind, verdict, predicate, rule_ver, provider, desired_hash,
                effect_hash, provider_order_id, payload_hash, payload_ver, payload
            ) VALUES (
                $1, $2, 'provider', 'mainnet-beta', $3, $4, 1,
                'found', 'presence', 'edit.provider.effect.v1', 1, $5, $6,
                $6, $7, repeat('4', 64), 1, '{}'::jsonb
            )
        `, [randomUUID(), blockedAction, `raw:${marker}:source`, `raw:${marker}:fact`,
            provider, '3'.repeat(64), `raw-effect-${marker}`])).rejects.toMatchObject({ code: '23514' });
        const rawEvidence = await query(
            'SELECT count(*)::int AS count FROM action_obs WHERE action_id = $1', [blockedAction]
        );
        expect(rawEvidence.rows[0].count).toBe(0);
        await query(`
            UPDATE order_actions
               SET action_ver = 3, work_state = 'parked', effect_state = 'possible',
                   outcome = 'manual_review', block_reason = 'operator_hold',
                   ambiguity_at = clock_timestamp(), lease_owner = NULL, lease_until = NULL,
                   write_scope = NULL, write_epoch = NULL
             WHERE id = $1
        `, [blockedAction]);
        const parkedPayload = { orderId: `blocked-effect-${marker}`, state: 'present' };
        const parked = await observations.observe({
            id: randomUUID(),
            actionId: blockedAction,
            source: 'provider',
            cluster: 'mainnet-beta',
            sourceKey: `provider:${marker}:parked:presence`,
            factKey: `provider:${marker}:parked-state`,
            factRev: 1,
            queryKind: 'found',
            verdict: 'presence',
            predicate: 'edit.provider.effect.v1',
            ruleVer: 1,
            provider,
            desiredHash: '3'.repeat(64),
            effectHash: '3'.repeat(64),
            providerOrderId: `blocked-effect-${marker}`,
            payloadHash: createHash('sha256')
                .update(canonicalJson(parkedPayload)).digest('hex'),
            payloadVer: 1,
            payload: parkedPayload,
            traceId,
            actor: 'provider',
        });
        expect(parked.action).toMatchObject({
            version: '4', workState: 'done', effectState: 'present', outcome: 'succeeded',
            blockReason: undefined, lease: undefined,
        });

        const staleOrder = randomUUID();
        const staleAction = randomUUID();
        const staleReq = '9'.repeat(64);
        await query(`
            INSERT INTO order_intents (
                id, user_id, provider, client_order_id, request_digest, wallet_address,
                order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                params, expires_at, cluster, family, strategy_kind, trigger_state,
                fill_state, funds_state, remaining_in, filled_in, filled_out, req_ver
            ) VALUES (
                $1, $2, $7, $3, repeat('8', 64), $4, 'single', 'prepared',
                $5, $6, 1000, $6, '{}'::jsonb, CURRENT_TIMESTAMP + INTERVAL '1 day',
                'mainnet-beta', 'price', 'single', 'pending', 'none', 'wallet',
                1000, 0, 0, 1
            )
        `, [staleOrder, userId, `stale-order-${marker}`, wallet, inputMint, outputMint, provider]);
        await store.admit({
            ...admission,
            id: staleAction,
            orderId: staleOrder,
            clientKey: `stale:${marker}`,
            reqHash: staleReq,
            desiredHash: '0'.repeat(64),
        });
        const staleClaim = (await store.claim(claim)).find((action) => action.id === staleAction);
        expect(staleClaim).toMatchObject({ version: '1', lease: { epoch: '1' } });
        const staleFence = {
            owner: staleClaim!.lease!.owner,
            gen: staleClaim!.lease!.gen,
            scope: staleClaim!.lease!.scope,
            epoch: staleClaim!.lease!.epoch,
        };

        await query(`
            INSERT INTO order_epochs (scope, epoch, mode, authority, proof_hash, source_key)
            VALUES ($1, 2, 'frozen', 'integration', repeat('3', 64), $2)
        `, [`provider:${provider}`, `fixture:epoch:${marker}:2`]);
        await expect(store.ready({
            actionId: staleAction,
            expectedVer: staleClaim!.version,
            fence: staleFence,
            dueAt: new Date().toISOString(),
            traceId,
            actor: 'system',
        })).rejects.toMatchObject({ code: 'lease_conflict', retryable: true });
        await expect(store.claim(claim)).rejects.toMatchObject({ code: 'epoch_closed' });

        const facts = await query(`
            SELECT
                (SELECT count(*)::int FROM order_event_keys WHERE action_id = $1) AS events,
                (SELECT count(*)::int FROM event_outbox
                  WHERE stream = 'orders.lifecycle' AND event_key LIKE $2) AS outbox
        `, [actionId, `%${actionId}%`]);
        expect(facts.rows[0]).toEqual({ events: 8, outbox: 5 });
        const lifecycle = await query(`
            SELECT event.event_type, event.event_hash, event.metadata
              FROM order_events event
             WHERE event.action_id = $1 AND event.event_key IS NOT NULL
        `, [actionId]);
        const byType = new Map(lifecycle.rows.map((row) => [row.event_type, row]));
        expect(byType.get('attempt.started')?.metadata).toMatchObject({
            action: { id: actionId, dueAt: ready.dueAt, lease: fence },
            attempt: {
                id: started.attempt.id,
                method: 'GET',
                reqHash,
                desiredHash,
                bodyHash: null,
                blobActionId: null,
                leaseGen: fence.gen,
                writeEpoch: fence.epoch,
                deadlineAt: started.attempt.deadlineAt,
            },
        });
        expect(byType.get('attempt.response')?.metadata).toMatchObject({
            attempt: {
                id: started.attempt.id,
                completedAt: response.completedAt,
                httpStatus: 202,
                httpClass: 'success',
                responseHash: response.responseHash,
                providerEffectId: response.providerEffectId,
                errorCode: null,
            },
        });
        expect(byType.get('action.reconciling')?.metadata).toMatchObject({
            action: {
                id: actionId,
                dueAt: reconciled.dueAt,
                errorCode: 'provider_pending',
                errorClass: 'ambiguous',
                httpClass: 'success',
                lease: null,
            },
        });
        const responseOutbox = await query(
            `SELECT payload FROM event_outbox WHERE event_key = $1`,
            [`attempt:${started.attempt.id}:response`]
        );
        expect(responseOutbox.rowCount).toBe(1);
        expect(responseOutbox.rows[0].payload).toMatchObject({
            eventHash: byType.get('attempt.response')?.event_hash,
            payload: { attempt: { id: started.attempt.id, responseHash: response.responseHash } },
        });
    });

    it('serializes same-key replay and conflicting-fact admission races', async () => {
        const marker = randomBytes(8).toString('hex');
        const userId = randomUUID();
        const replayOrder = randomUUID();
        const conflictOrder = randomUUID();
        const wallet = `RaceWallet${marker}`;
        const inputMint = 'So11111111111111111111111111111111111111112';
        const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        await query('INSERT INTO users (id, wallet_address) VALUES ($1, $2)', [userId, wallet]);
        await query(`
            INSERT INTO order_intents (
                id, user_id, provider, client_order_id, request_digest, wallet_address,
                order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                params, expires_at, cluster, family, strategy_kind, trigger_state,
                fill_state, funds_state, remaining_in, filled_in, filled_out, req_ver
            ) VALUES
                ($1, $3, 'fixture', $4, repeat('1', 64), $5, 'single', 'prepared',
                 $6, $7, 1000, $7, '{}'::jsonb, clock_timestamp() + INTERVAL '1 day',
                 'mainnet-beta', 'price', 'single', 'pending', 'none', 'wallet', 1000, 0, 0, 1),
                ($2, $3, 'fixture', $8, repeat('2', 64), $5, 'single', 'prepared',
                 $6, $7, 1000, $7, '{}'::jsonb, clock_timestamp() + INTERVAL '1 day',
                 'mainnet-beta', 'price', 'single', 'pending', 'none', 'wallet', 1000, 0, 0, 1)
        `, [
            replayOrder, conflictOrder, userId, `race-replay-${marker}`, wallet,
            inputMint, outputMint, `race-conflict-${marker}`,
        ]);
        const common = {
            id: randomUUID(),
            orderId: replayOrder,
            userId,
            kind: 'provider_sync' as const,
            ruleVer: 1 as const,
            clientKey: `race-replay:${marker}`,
            reqHash: '3'.repeat(64),
            desiredHash: '4'.repeat(64),
            expectedVer: '0',
            provider: 'fixture',
            dueAt: new Date().toISOString(),
            traceId: `trace-${marker}`,
            actor: 'system' as const,
        };
        const replayRace = await Promise.all([store.admit(common), store.admit(common)]);
        expect(replayRace.map((result) => result.replayed).sort()).toEqual([false, true]);
        expect(new Set(replayRace.map((result) => result.action.id))).toEqual(new Set([common.id]));

        const conflict = {
            ...common,
            id: randomUUID(),
            orderId: conflictOrder,
            clientKey: `race-conflict:${marker}`,
            reqHash: '5'.repeat(64),
            desiredHash: '6'.repeat(64),
        };
        const conflictRace = await Promise.allSettled([
            store.admit(conflict),
            store.admit({
                ...conflict,
                id: randomUUID(),
                reqHash: '7'.repeat(64),
                desiredHash: '8'.repeat(64),
            }),
        ]);
        expect(conflictRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = conflictRace.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected'
        );
        expect(rejected?.reason).toMatchObject({ code: 'idempotency_conflict' });
        const facts = await query(`
            SELECT order_ver,
                   (SELECT count(*)::int FROM order_actions WHERE order_id = $1) AS actions
              FROM order_intents WHERE id = $1
        `, [conflictOrder]);
        expect(facts.rows[0]).toEqual({ order_ver: '1', actions: 1 });
    });

    it('fails financial actions closed while circuits leave reconciliation available', async () => {
        const marker = randomBytes(8).toString('hex');
        const inputMint = 'So11111111111111111111111111111111111111112';
        const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const traceId = `circuit-${marker}`;
        const makeOrder = async (label: string) => {
            const userId = randomUUID();
            const orderId = randomUUID();
            const provider = `circuit_${label}_${marker}`;
            const wallet = bs58.encode(randomBytes(32));
            await query('INSERT INTO users (id, wallet_address) VALUES ($1, $2)', [userId, wallet]);
            await query(`
                INSERT INTO order_intents (
                    id, user_id, provider, client_order_id, request_digest, wallet_address,
                    order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                    params, expires_at, cluster, family, strategy_kind, trigger_state,
                    fill_state, funds_state, remaining_in, filled_in, filled_out, req_ver
                ) VALUES (
                    $1, $2, $3, $4, repeat('a', 64), $5, 'single', 'prepared',
                    $6, $7, 1000, $7, '{}'::jsonb, clock_timestamp() + INTERVAL '1 day',
                    'mainnet-beta', 'price', 'single', 'pending', 'none', 'wallet',
                    1000, 0, 0, 1
                )
            `, [orderId, userId, provider, `circuit-${label}-${marker}`, wallet,
                inputMint, outputMint]);
            await query(`
                INSERT INTO order_epochs (
                    scope, epoch, region, mode, authority, proof_hash, source_key
                ) VALUES (
                    $1, 1, 'ci', 'live', 'integration', repeat('b', 64), $2
                )
            `, [`provider:${provider}`, `circuit:${label}:${marker}`]);
            return { userId, orderId, provider, wallet };
        };
        const openCircuit = async (order: Awaited<ReturnType<typeof makeOrder>>, label: string) => {
            await query(`
                INSERT INTO asset_obligations (
                    id, obligation_key, req_hash, order_id, cluster, wallet_address,
                    mint, kind, amount, reason
                ) VALUES (
                    gen_random_uuid(), $1, repeat('c', 64), $2, 'mainnet-beta', $3,
                    $4, 'deficit', 1, 'Circuit integration fixture'
                )
            `, [`circuit:${label}:${marker}`, order.orderId, order.wallet, inputMint]);
        };
        const admit = async (
            order: Awaited<ReturnType<typeof makeOrder>>,
            actionId: string,
            kind: 'edit' | 'provider_sync',
            label: string
        ) => store.admit({
            id: actionId,
            orderId: order.orderId,
            userId: order.userId,
            kind,
            ruleVer: 1,
            clientKey: `circuit:${label}:${marker}`,
            reqHash: 'd'.repeat(64),
            desiredHash: 'e'.repeat(64),
            expectedVer: '0',
            provider: order.provider,
            dueAt: new Date(Date.now() - 1_000).toISOString(),
            traceId,
            actor: 'system',
        });

        const admissionOrder = await makeOrder('admit');
        await openCircuit(admissionOrder, 'admit');
        await expect(admit(admissionOrder, randomUUID(), 'edit', 'blocked-admit'))
            .rejects.toMatchObject({
                code: 'state_conflict',
                message: 'An unresolved asset obligation prohibits financial mutation',
            });
        const rolledBack = await query(`
            SELECT order_ver,
                   (SELECT count(*)::int FROM order_actions WHERE order_id = $1) AS actions
              FROM order_intents WHERE id = $1
        `, [admissionOrder.orderId]);
        expect(rolledBack.rows[0]).toEqual({ order_ver: '0', actions: 0 });

        const syncId = randomUUID();
        await expect(admit(admissionOrder, syncId, 'provider_sync', 'allowed-sync'))
            .resolves.toMatchObject({ replayed: false, action: { id: syncId } });
        const syncClaim = (await store.claim({
            provider: admissionOrder.provider,
            owner: `sync-${marker}`,
            epoch: '1',
            leaseMs: 30_000,
            limit: 1,
        }))[0];
        const syncFence = syncClaim.lease!;
        const syncReady = await store.ready({
            actionId: syncId,
            expectedVer: syncClaim.version,
            fence: syncFence,
            dueAt: new Date(Date.now() - 100).toISOString(),
            traceId,
            actor: 'system',
        });
        await expect(store.start({
            id: randomUUID(),
            actionId: syncId,
            expectedVer: syncReady.version,
            fence: syncFence,
            endpoint: '/provider/orders/circuit',
            method: 'GET',
            reqHash: 'd'.repeat(64),
            deadlineAt: new Date(Date.now() + 10_000).toISOString(),
            traceId,
            actor: 'system',
        })).resolves.toMatchObject({ action: { workState: 'dispatching' } });

        const claimOrder = await makeOrder('claim');
        const claimId = randomUUID();
        await admit(claimOrder, claimId, 'edit', 'blocked-claim');
        await openCircuit(claimOrder, 'claim');
        const skipped = await store.claim({
            provider: claimOrder.provider,
            owner: `claim-${marker}`,
            epoch: '1',
            leaseMs: 30_000,
            limit: 1,
        });
        expect(skipped.find((action) => action.id === claimId)).toBeUndefined();
        const unleased = await query(`
            SELECT action_ver, lease_owner FROM order_actions WHERE id = $1
        `, [claimId]);
        expect(unleased.rows[0]).toEqual({ action_ver: '0', lease_owner: null });

        const startOrder = await makeOrder('start');
        const startId = randomUUID();
        await admit(startOrder, startId, 'edit', 'blocked-start');
        const startClaim = (await store.claim({
            provider: startOrder.provider,
            owner: `start-${marker}`,
            epoch: '1',
            leaseMs: 30_000,
            limit: 1,
        }))[0];
        const startFence = startClaim.lease!;
        const startReady = await store.ready({
            actionId: startId,
            expectedVer: startClaim.version,
            fence: startFence,
            dueAt: new Date(Date.now() - 100).toISOString(),
            traceId,
            actor: 'system',
        });

        let locked!: () => void;
        let release!: () => void;
        const lockReady = new Promise<void>((resolve) => { locked = resolve; });
        const lockRelease = new Promise<void>((resolve) => { release = resolve; });
        const lock = transaction(async (db) => {
            await db('SELECT id FROM order_intents WHERE id = $1 FOR UPDATE', [startOrder.orderId]);
            locked();
            await lockRelease;
        });
        await lockReady;
        let settled = false;
        const opening = openCircuit(startOrder, 'start').then(() => { settled = true; });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(settled).toBe(false);
        release();
        await Promise.all([lock, opening]);
        await expect(store.start({
            id: randomUUID(),
            actionId: startId,
            expectedVer: startReady.version,
            fence: startFence,
            endpoint: '/provider/orders/circuit',
            method: 'PATCH',
            reqHash: 'd'.repeat(64),
            bodyHash: 'f'.repeat(64),
            deadlineAt: new Date(Date.now() + 10_000).toISOString(),
            traceId,
            actor: 'system',
        })).rejects.toMatchObject({ code: 'state_conflict' });
        const notStarted = await query(`
            SELECT action_ver, work_state, attempt_count FROM order_actions WHERE id = $1
        `, [startId]);
        expect(notStarted.rows[0]).toEqual({
            action_ver: '2', work_state: 'ready', attempt_count: 0,
        });
    });

    it('linearizes a fill claim across its secondary mint before dispatch', async () => {
        const marker = randomBytes(8).toString('hex');
        const userId = randomUUID();
        const claimOrder = randomUUID();
        const actionOrder = randomUUID();
        const actionId = randomUUID();
        const wallet = bs58.encode(randomBytes(32));
        const vault = bs58.encode(randomBytes(32));
        const inputMint = bs58.encode(randomBytes(32));
        const sharedMint = bs58.encode(randomBytes(32));
        const otherMint = bs58.encode(randomBytes(32));
        const provider = `claim_lock_${marker}`;
        const traceId = `claim-lock-${marker}`;
        await query('INSERT INTO users (id, wallet_address) VALUES ($1, $2)', [userId, wallet]);
        await query(`
            INSERT INTO order_intents (
                id, user_id, provider, client_order_id, request_digest, wallet_address,
                order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                params, expires_at, cluster, family, strategy_kind, trigger_state,
                fill_state, funds_state, remaining_in, filled_in, filled_out, req_ver
            ) VALUES
                ($1, $3, $4, $5, repeat('1', 64), $6, 'single', 'prepared',
                 $7, $8, 1000, $8, '{}'::jsonb, clock_timestamp() + INTERVAL '1 day',
                 'mainnet-beta', 'price', 'single', 'pending', 'none', 'wallet',
                 1000, 0, 0, 1),
                ($2, $3, $4, $9, repeat('2', 64), $6, 'single', 'prepared',
                 $10, $8, 1000, $8, '{}'::jsonb, clock_timestamp() + INTERVAL '1 day',
                 'mainnet-beta', 'price', 'single', 'pending', 'none', 'wallet',
                 1000, 0, 0, 1)
        `, [claimOrder, actionOrder, userId, provider, `claim-lock-a-${marker}`, wallet,
            inputMint, sharedMint, `claim-lock-b-${marker}`, otherMint]);
        await query(`
            INSERT INTO order_epochs (
                scope, epoch, region, mode, authority, proof_hash, source_key
            ) VALUES (
                $1, 1, 'ci', 'live', 'integration', repeat('3', 64), $2
            )
        `, [`provider:${provider}`, `claim-lock:${marker}`]);

        await store.admit({
            id: actionId,
            orderId: actionOrder,
            userId,
            kind: 'edit',
            ruleVer: 1,
            clientKey: `claim-lock:${marker}`,
            reqHash: '4'.repeat(64),
            desiredHash: '5'.repeat(64),
            expectedVer: '0',
            provider,
            dueAt: new Date(Date.now() - 1_000).toISOString(),
            traceId,
            actor: 'system',
        });
        const leased = (await store.claim({
            provider,
            owner: `claim-lock-${marker}`,
            epoch: '1',
            leaseMs: 30_000,
            limit: 1,
        }))[0];
        const fence = leased.lease!;
        const ready = await store.ready({
            actionId,
            expectedVer: leased.version,
            fence,
            dueAt: new Date(Date.now() - 100).toISOString(),
            traceId,
            actor: 'system',
        });

        const signature = bs58.encode(randomBytes(64));
        const effectKey = `provider:${provider}:fill:${marker}`;
        const document = { provider, marker, signature, type: 'fill' };
        const payloadHash = createHash('sha256')
            .update(canonicalJson(document))
            .digest('hex');
        const evidence = (role: 'input' | 'output', mint: string) => ({
            effectKey,
            orderId: claimOrder,
            cluster: 'mainnet-beta' as const,
            walletAddress: wallet,
            vaultAddress: vault,
            mint,
            source: 'provider' as const,
            sourceKey: `provider:${provider}:${role}:${marker}`,
            rawState: 'success',
            signature,
            payloadHash,
            payload: document,
            sourceAt: new Date().toISOString(),
        });

        let scopeLocked!: () => void;
        let releaseClaim!: () => void;
        const locked = new Promise<void>((resolve) => { scopeLocked = resolve; });
        const release = new Promise<void>((resolve) => { releaseClaim = resolve; });
        const claim = transaction(async (db) => {
            const { AssetLedger } = await import('../src/services/assets/assetLedger');
            const ledger = new AssetLedger(db, async (work) => work(db));
            await ledger.claim({
                obligation: {
                    obligationKey: `claim-lock:${marker}`,
                    orderId: claimOrder,
                    cluster: 'mainnet-beta',
                    walletAddress: wallet,
                    vaultAddress: vault,
                    mint: inputMint,
                    kind: 'fill_unverified',
                    amount: '50',
                    reason: 'Concurrent secondary-mint claim fixture',
                },
                parts: [
                    { role: 'input', mint: inputMint, amount: '50', evidence: evidence('input', inputMint) },
                    { role: 'output', mint: sharedMint, amount: '75', evidence: evidence('output', sharedMint) },
                ],
            });
            await db('SET CONSTRAINTS asset_claim_complete, asset_claim_parts_complete IMMEDIATE');
            scopeLocked();
            await release;
        });
        await locked;

        const phantomOrder = randomUUID();
        let phantomSettled = false;
        const phantom = query(`
            INSERT INTO order_intents (
                id, user_id, provider, client_order_id, request_digest, wallet_address,
                order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                params, expires_at, cluster, family, strategy_kind, trigger_state,
                fill_state, funds_state, remaining_in, filled_in, filled_out, req_ver
            ) VALUES (
                $1, $2, $3, $4, repeat('7', 64), $5, 'single', 'prepared',
                $6, $7, 1000, $7, '{}'::jsonb, clock_timestamp() + INTERVAL '1 day',
                'mainnet-beta', 'price', 'single', 'pending', 'none', 'wallet',
                1000, 0, 0, 1
            )
        `, [phantomOrder, userId, provider, `claim-lock-phantom-${marker}`,
            wallet, otherMint, sharedMint]).finally(() => { phantomSettled = true; });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(phantomSettled).toBe(false);

        let startError: unknown;
        let startSettled = false;
        const start = store.start({
            id: randomUUID(),
            actionId,
            expectedVer: ready.version,
            fence,
            endpoint: '/provider/orders/claim-lock',
            method: 'PATCH',
            reqHash: '4'.repeat(64),
            bodyHash: '6'.repeat(64),
            deadlineAt: new Date(Date.now() + 10_000).toISOString(),
            traceId,
            actor: 'system',
        }).catch((error: unknown) => {
            startError = error;
        }).finally(() => {
            startSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(startSettled).toBe(false);
        releaseClaim();
        await Promise.all([claim, start, phantom]);
        expect(startError).toMatchObject({
            code: 'state_conflict',
            message: 'An unresolved asset obligation prohibits financial mutation',
        });
        const action = await query(`
            SELECT work_state, effect_state, outcome, attempt_count
              FROM order_actions WHERE id = $1
        `, [actionId]);
        expect(action.rows[0]).toEqual({
            work_state: 'ready', effect_state: 'not_possible', outcome: 'pending', attempt_count: 0,
        });
        await expect(store.admit({
            id: randomUUID(), orderId: phantomOrder, userId, kind: 'edit', ruleVer: 1,
            clientKey: `claim-lock-phantom:${marker}`, reqHash: '8'.repeat(64),
            desiredHash: '9'.repeat(64), expectedVer: '0', provider,
            dueAt: new Date().toISOString(), traceId, actor: 'system',
        })).rejects.toMatchObject({
            code: 'state_conflict',
            message: 'An unresolved asset obligation prohibits financial mutation',
        });
    });

    it('rolls aggregate admission back when an outbox identity has another payload', async () => {
        const marker = randomBytes(8).toString('hex');
        const userId = randomUUID();
        const orderId = randomUUID();
        const actionId = randomUUID();
        const wallet = `RollbackWallet${marker}`;
        const inputMint = 'So11111111111111111111111111111111111111112';
        const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        await query('INSERT INTO users (id, wallet_address) VALUES ($1, $2)', [userId, wallet]);
        await query(`
            INSERT INTO order_intents (
                id, user_id, provider, client_order_id, request_digest, wallet_address,
                order_type, state, input_mint, output_mint, input_amount, trigger_mint,
                params, expires_at, cluster, family, strategy_kind, trigger_state,
                fill_state, funds_state, remaining_in, filled_in, filled_out, req_ver
            ) VALUES (
                $1, $2, 'fixture', $3, repeat('9', 64), $4, 'single', 'prepared',
                $5, $6, 1000, $6, '{}'::jsonb, clock_timestamp() + INTERVAL '1 day',
                'mainnet-beta', 'price', 'single', 'pending', 'none', 'wallet',
                1000, 0, 0, 1
            )
        `, [orderId, userId, `rollback-${marker}`, wallet, inputMint, outputMint]);
        await query(`
            INSERT INTO event_outbox (stream, event_key, payload)
            VALUES ('orders.lifecycle', $1, '{"wrong":true}'::jsonb)
        `, [`action:${actionId}:v0:admitted`]);
        await expect(store.admit({
            id: actionId,
            orderId,
            userId,
            kind: 'activate',
            ruleVer: 1,
            clientKey: `rollback:${marker}`,
            reqHash: 'a'.repeat(64),
            desiredHash: 'b'.repeat(64),
            expectedVer: '0',
            provider: 'fixture',
            dueAt: new Date().toISOString(),
            traceId: `trace-${marker}`,
            actor: 'user',
        })).rejects.toThrow('Outbox event key was reused with a different payload');
        const facts = await query(`
            SELECT order_ver,
                   (SELECT count(*)::int FROM order_actions WHERE id = $2) AS actions,
                   (SELECT count(*)::int FROM order_event_keys WHERE action_id = $2) AS events,
                   (SELECT count(*)::int FROM event_outbox
                     WHERE event_key = 'action:' || $2::text || ':v0:admitted') AS outbox
              FROM order_intents WHERE id = $1
        `, [orderId, actionId]);
        expect(facts.rows[0]).toEqual({ order_ver: '0', actions: 0, events: 0, outbox: 1 });
    });

    it('accepts only exact outbox payload replays', async () => {
        const key = `outbox-replay:${randomUUID()}`;
        const payload = { action: { id: randomUUID(), version: '1' }, type: 'fixture' };
        const { EventOutbox } = await import('../src/services/eventOutbox');
        const outbox = new EventOutbox();
        await transaction((db) => outbox.enqueue(db, 'orders.lifecycle', key, payload));
        await expect(transaction((db) => outbox.enqueue(
            db, 'orders.lifecycle', key, payload
        ))).resolves.toBeUndefined();
        await expect(transaction((db) => outbox.enqueue(
            db, 'orders.lifecycle', key, { ...payload, type: 'different' }
        ))).rejects.toThrow('Outbox event key was reused with a different payload');
        const stored = await query(
            'SELECT payload FROM event_outbox WHERE stream = $1 AND event_key = $2',
            ['orders.lifecycle', key]
        );
        expect(stored.rows).toEqual([{ payload }]);
    });
});
