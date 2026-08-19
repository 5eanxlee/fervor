import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NormalizedTradeEvent } from '../src/types';
import {
    buildMetricReplay,
    projectMetricData,
    pumpCurveSchema,
    replayDigest,
    replayManifestSchema,
    writeMetricReplay,
} from '../src/services/marketData/metricReplay';
import { SOL_MINT, USDC_MINT } from '../src/services/marketData/fxTape';
import type { FxPoint } from '../src/services/marketData/fxTape';
import { ReplayCoordinator } from '../src/services/replay/coordinator';

const mint = 'YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf';
const curveAddress = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
const signature = 'BUguQsv2ZuHus54HAFzjdJHzZBkygAjKhEeYwSG19tUfUyvvz3worsdQCdAXDNjakJHioSiyxhFiDJrm8XpSXRA';
const pool = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

const baseTrade = (): NormalizedTradeEvent => ({
    source: 'old_faithful',
    sourceEventId: `old_faithful:mainnet-beta:42:${signature}:0:0`,
    kind: 'trade',
    idempotencyKey: 'a'.repeat(64),
    tokenMint: mint,
    quoteMint: SOL_MINT,
    poolAddress: curveAddress,
    protocol: 'pump_fun',
    programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    maker: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
    side: 'buy',
    tokenAmount: 2,
    quoteAmount: 4,
    tokenAmountRaw: '2000000',
    quoteAmountRaw: '4000000000',
    tokenDecimals: 6,
    quoteDecimals: 9,
    priceQuote: 2,
    solAmount: 4,
    priceSol: 2,
    quoteKind: 'wsol',
    route: ['pump_fun'],
    instructionIndex: 0,
    eventIndex: 0,
    slot: 42,
    signature,
    receivedAt: '2024-11-19T00:00:00Z',
    observedAt: '2024-11-19T00:00:00Z',
    confidence: 0.94,
    stale: false,
    commitment: 'finalized',
    decodeVersion: 'balance-delta-v1',
    computeUnits: 88_000,
});

const trades = (): NormalizedTradeEvent[] => {
    const first = baseTrade();
    const second: NormalizedTradeEvent = {
        ...first,
        idempotencyKey: 'b'.repeat(64),
        sourceEventId: `old_faithful:mainnet-beta:43:${signature}:0:0`,
        slot: 43,
        receivedAt: '2024-11-19T00:00:02Z',
        observedAt: '2024-11-19T00:00:02Z',
    };
    return [first, second];
};

const supply = {
    contract: 'fervor-supply-v1' as const,
    tokenMint: mint,
    rawAmount: '1000000000000000',
    decimals: 6,
    fixed: true as const,
    layout: 'pump-event-2024-11-v1',
    source: 'old_faithful',
    sourceEventId: `old_faithful:supply:42:${signature}:0:0`,
    slot: 42,
    signature,
    instructionIndex: 0,
    eventIndex: 0,
    observedAt: '2024-11-19T00:00:00Z',
    confidence: 1,
    stale: false,
    commitment: 'finalized' as const,
};

const fxPoint = (): FxPoint => ({
    contract: 'fervor-fx-tape-v1',
    policy: 'fervor-sol-usd-v1',
    sourceEventId: 'fervor-sol-usd-v1:1731974400000',
    bucketStart: '2024-11-19T00:00:00.000Z',
    bucketMs: 30_000,
    observedAt: '2024-11-19T00:00:01.000Z',
    validUntil: '2024-11-19T00:01:31.000Z',
    maxAgeMs: 90_000,
    priceMicroUsd: '200000000',
    poolSpreadBps: 0,
    quality: 'single_pool',
    estimated: true,
    confidence: 0.9,
    inputCount: 1,
    observationCount: 1,
    poolCount: 1,
    pools: [{
        poolAddress: pool,
        protocol: 'raydium_amm_v4',
        stableMint: USDC_MINT,
        solRaw: '1000000000',
        stableRaw: '200000000',
        priceMicroUsd: '200000000',
        observationCount: 1,
        firstObservedAt: '2024-11-19T00:00:01.000Z',
        lastObservedAt: '2024-11-19T00:00:01.000Z',
        sourceEventIds: ['old_faithful:fx:1'],
    }],
    commitment: 'finalized',
});

const curvePoint = () => ({
    contract: 'fervor-pump-curve-v1' as const,
    liquidityPolicy: 'fervor-pump-real-reserve-mark-v1' as const,
    sourceEventId: `pump-event-2024-11-v1:43:${signature}:0:0`,
    completionEventId: `pump-event-2024-11-v1:43:${signature}:0:1`,
    mint,
    bondingCurve: curveAddress,
    slot: '43',
    txIndex: '1',
    signature,
    instructionIndex: 0,
    eventIndex: 0,
    observedAt: '2024-11-19T00:00:02Z',
    complete: true,
    decimals: 6,
    supplyRaw: '1000000000000000',
    virtualSolRaw: '31000000000',
    virtualTokenRaw: '1000000000000000',
    realSolRaw: '1000000000',
    realTokenRaw: '0',
    priceSol: '0.000000031000000000',
    fdvSol: '31.000000000000000000',
    liquiditySol: '1.000000000000000000',
    liquidityEstimated: true,
});

const manifest = () => replayManifestSchema.parse({
    schema: 'fervor-replay-v7',
    network: 'mainnet-beta',
    mint,
    startSlot: 41,
    endSlot: 44,
    firstSlot: 42,
    lastSlot: 43,
    sourceRawSha256: '1'.repeat(64),
    sourceIndexSha256: '2'.repeat(64),
    sourceBytes: 1,
    presentSlots: 2,
    skippedSlots: 1,
    blocks: 2,
    transactions: 2,
    matchedTransactions: 2,
    swaps: 2,
    transactionFile: 'transactions.ndjson',
    transactionSha256: '0'.repeat(64),
    swapFile: 'swaps.ndjson',
    swapSha256: '0'.repeat(64),
    tradeContract: 'fervor-trade-v1',
    trades: 2,
    tradeFile: 'trades.ndjson',
    tradeSha256: '0'.repeat(64),
    pumpLayout: 'pump-event-2024-11-v1',
    pumpEvents: 2,
    pumpEventFile: 'pump-events.ndjson',
    pumpEventSha256: '0'.repeat(64),
    pumpStateFile: 'pump-state.json',
    pumpStateSha256: '0'.repeat(64),
    pumpCurveContract: 'fervor-pump-curve-v1',
    pumpLiquidityPolicy: 'fervor-pump-real-reserve-mark-v1',
    pumpCurvePoints: 1,
    pumpCurveFile: 'pump-curve.ndjson',
    pumpCurveSha256: '0'.repeat(64),
    supplyContract: 'fervor-supply-v1',
    supplyFile: 'supply.json',
    supplySha256: '0'.repeat(64),
    fxContract: 'fervor-fx-observation-v1',
    fxPolicy: 'fervor-sol-usd-v1',
    fxObservations: 1,
    fxFile: 'fx-observations.ndjson',
    fxSha256: '0'.repeat(64),
    fxTapeContract: 'fervor-fx-tape-v1',
    fxTapeBuckets: 1,
    fxTapeFile: 'fx-tape.ndjson',
    fxTapeSha256: '0'.repeat(64),
    replaySha256: '0'.repeat(64),
});

const writeReplay = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fervor-metric-replay-'));
    tempDirs.push(dir);
    const files = new Map<string, string>([
        ['transactions.ndjson', '{}\n'],
        ['swaps.ndjson', '{}\n'],
        ['trades.ndjson', `${trades().map((trade) => JSON.stringify(trade)).join('\n')}\n`],
        ['pump-events.ndjson', '{}\n'],
        ['pump-state.json', `${JSON.stringify({ mint, phase: 'migrated' })}\n`],
        ['pump-curve.ndjson', `${JSON.stringify(curvePoint())}\n`],
        ['supply.json', `${JSON.stringify(supply)}\n`],
        ['fx-observations.ndjson', '{}\n'],
        ['fx-tape.ndjson', `${JSON.stringify(fxPoint())}\n`],
    ]);
    await Promise.all(Array.from(files, ([name, value]) => writeFile(path.join(dir, name), value)));
    const base = manifest();
    const artifactHashes = Array.from(files.values(), hash);
    const completed = {
        ...base,
        transactionSha256: artifactHashes[0],
        swapSha256: artifactHashes[1],
        tradeSha256: artifactHashes[2],
        pumpEventSha256: artifactHashes[3],
        pumpStateSha256: artifactHashes[4],
        pumpCurveSha256: artifactHashes[5],
        supplySha256: artifactHashes[6],
        fxSha256: artifactHashes[7],
        fxTapeSha256: artifactHashes[8],
        replaySha256: replayDigest('fervor-replay-v7', artifactHashes),
    };
    await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(completed, null, 2)}\n`);
    return dir;
};

describe('metric replay', () => {
    it('validates exact curve arithmetic and rejects relabeled liquidity', () => {
        expect(pumpCurveSchema.parse(curvePoint())).toMatchObject({
            priceSol: '0.000000031000000000',
            liquiditySol: '1.000000000000000000',
        });
        expect(() => pumpCurveSchema.parse({
            ...curvePoint(),
            liquiditySol: '31.000000000000000000',
        })).toThrow('exact reserves');
        expect(() => pumpCurveSchema.parse({
            ...curvePoint(),
            completionEventId: undefined,
        })).toThrow('completion lineage');
    });

    it('projects all counts while making missing USD coverage explicit', async () => {
        const source = manifest();
        const input = {
            manifest: source,
            manifestSha256: '3'.repeat(64),
            trades: trades().reverse(),
            fxTape: [fxPoint()],
            curve: [curvePoint()],
            supply,
            phase: 'migrated' as const,
        };
        const replay = await projectMetricData(input);

        expect(replay.sourceTrades).toHaveLength(2);
        expect(replay.trades).toHaveLength(1);
        expect(replay.candles).toHaveLength(11);
        expect(replay.curve[0]).toMatchObject({
            solUsd: 200,
            priceUsd: 0.0000062,
            fdvUsd: 6200,
            liquidityUsd: 200,
        });
        expect(replay.state).toMatchObject({
            tradeCount: 2,
            pricedTradeCount: 1,
            unpricedTradeCount: 1,
            priceCoverageBps: 5000,
            priceUsd: 400,
            fdvUsd: 400_000_000_000,
            marketCapUsd: null,
            liquidityUsd: null,
            liquidityStatus: 'unsupported_after_migration',
        });
        expect(replay.state.rolling.txCount['1m']).toBe(2);
        expect(replay.state.rolling.volumeUsd['1m']).toBe(800);
        expect(replay.state.usdPricedCount['1m']).toBe(1);
        expect(replay.state.usdCoverageBps['1m']).toBe(5000);
    });

    it('keeps native price current and exposes terminal curve liquidity without future FX', async () => {
        const raw = trades();
        raw[0] = {
            ...raw[0],
            receivedAt: '2024-11-19T00:00:02Z',
            observedAt: '2024-11-19T00:00:02Z',
        };
        raw[1] = {
            ...raw[1],
            receivedAt: '2024-11-19T00:01:32Z',
            observedAt: '2024-11-19T00:01:32Z',
            priceSol: 3,
        };
        const replay = await projectMetricData({
            manifest: manifest(),
            manifestSha256: '3'.repeat(64),
            trades: raw,
            fxTape: [fxPoint()],
            curve: [curvePoint()],
            supply,
            phase: 'complete',
        });

        expect(replay.state).toMatchObject({
            pricedTradeCount: 1,
            priceObservedAt: '2024-11-19T00:00:02Z',
            priceSol: 3,
            priceSolObservedAt: '2024-11-19T00:01:32Z',
            liquidityUsd: 200,
            liquidityStatus: 'terminal_curve_estimate',
        });
    });

    it('verifies every source hash and atomically reproduces identical output', async () => {
        const source = await writeReplay();
        const replay = await buildMetricReplay(source);
        const first = path.join(path.dirname(source), `${path.basename(source)}-out-a`);
        const second = path.join(path.dirname(source), `${path.basename(source)}-out-b`);
        tempDirs.push(first, second);

        const firstManifest = await writeMetricReplay(first, replay);
        const secondManifest = await writeMetricReplay(second, replay);
        expect(firstManifest).toEqual(secondManifest);
        await expect(readFile(path.join(first, 'market-state.json'), 'utf8')).resolves.toBe(
            await readFile(path.join(second, 'market-state.json'), 'utf8')
        );
        await expect(writeMetricReplay(first, replay)).rejects.toThrow('already exists');

        const coordinator = new ReplayCoordinator(replay, 'test-run');
        expect(() => new ReplayCoordinator(
            { ...replay, trades: [...replay.trades, replay.trades[0]] },
            'duplicate-run'
        ))
            .toThrow('duplicate trade identities');
        expect(coordinator.snapshot()).toMatchObject({
            runId: 'test-run', epoch: 1, cursor: 0, total: 2, status: 'paused', now: null,
        });
        const firstEvent = coordinator.step();
        expect(firstEvent).toMatchObject({ runId: 'test-run', epoch: 1, cursor: 0, usdPriced: false });
        expect(coordinator.snapshot()).toMatchObject({
            cursor: 1,
            status: 'paused',
            now: '2024-11-19T00:00:00.000Z',
        });
        coordinator.resume();
        coordinator.pause();
        expect(() => coordinator.next()).toThrow('requires a running run');
        coordinator.resume();
        expect(coordinator.next()).toMatchObject({ cursor: 1, usdPriced: true });
        expect(coordinator.snapshot()).toMatchObject({ cursor: 2, status: 'complete' });

        expect(coordinator.seek(0)).toMatchObject({ epoch: 2, cursor: 0, status: 'paused', now: null });
        expect(coordinator.accepts(firstEvent!)).toBe(false);
        const replayed = coordinator.step();
        expect(replayed).toMatchObject({ epoch: 2, cursor: 0 });
        expect(coordinator.accepts(replayed!)).toBe(true);
        expect(coordinator.accepts({ ...replayed!, sourceReplaySha256: '0'.repeat(64) })).toBe(false);
        const cut = coordinator.cut();
        expect(cut).toMatchObject({
            contract: 'fervor-replay-cut-v1',
            cursor: 1,
            now: '2024-11-19T00:00:00.000Z',
        });
        expect(cut.prefixSha256).toMatch(/^[0-9a-f]{64}$/);
        const beforeRestore = coordinator.snapshot();
        expect(() => coordinator.restore({ ...cut, prefixSha256: '0'.repeat(64) }))
            .toThrow('does not match the verified tape');
        expect(coordinator.snapshot()).toEqual(beforeRestore);
        expect(() => coordinator.seek(3)).toThrow('outside the tape');
        expect(coordinator.snapshot().epoch).toBe(2);
        expect(coordinator.seek(1)).toMatchObject({
            epoch: 3, cursor: 1, status: 'paused', now: '2024-11-19T00:00:00.000Z',
        });
        const tail = coordinator.step();
        expect(tail).toMatchObject({ epoch: 3, cursor: 1 });

        const restarted = new ReplayCoordinator(replay, 'restart-run');
        restarted.resume();
        expect([restarted.next(), restarted.next()].map((event) => event?.trade.idempotencyKey))
            .toEqual(replay.sourceTrades.map((trade) => trade.idempotencyKey));
        const restored = new ReplayCoordinator(replay, 'restore-run');
        expect(restored.restore(cut)).toMatchObject({ epoch: 2, cursor: 1, status: 'paused' });
        expect(restored.step()?.trade.idempotencyKey).toBe(replay.sourceTrades[1].idempotencyKey);
        expect(coordinator.accepts({ ...tail!, runId: 'restart-run' })).toBe(false);
        coordinator.stop();
        expect(coordinator.accepts(tail!)).toBe(false);

        await writeFile(path.join(source, 'trades.ndjson'), '{}\n');
        await expect(buildMetricReplay(source)).rejects.toThrow('hash differs');
    });
});
