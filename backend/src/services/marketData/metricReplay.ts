import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { z } from 'zod';
import type { FervorSupplyInput, NormalizedTradeEvent } from '../../types';
import { amountSchema, u64Schema } from '../../types/amount';
import { addressSchema, signatureSchema } from '../../types/execution';
import { aggregateCandles, CandleUpdate } from './candleEngine';
import { FxTapeSource, SOL_MINT, fxPointSchema } from './fxTape';
import {
    deriveFervorMetrics,
    fervorInputContract,
    fervorMetricSource,
    fervorMetricVersion,
    supplyAmount,
} from './metricEngine';
import { RollingMetricBook } from './rollingMetricBook';
import type { RollingWindowMetrics, RollingWindowName } from './rollingWindowAggregator';
import { decodedTradeSchema, supplySchema, TradeEnricher } from './tradeEnricher';
import { tradeOrder } from './tradeOrder';

export const metricReplaySchema = 'fervor-metric-replay-v1' as const;
export const pumpCurveContract = 'fervor-pump-curve-v1' as const;
export const pumpLiquidityPolicy = 'fervor-pump-real-reserve-mark-v1' as const;

const hashText = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveCount = count.refine((value) => value > 0);
const time = z.string().datetime({ offset: true });
const decimal18 = z.string().regex(/^(?:0|[1-9]\d*)\.\d{18}$/);
const SCALE = 10n ** 18n;
const LAMPORTS = 1_000_000_000n;

export const replayManifestSchema = z.object({
    schema: z.literal('fervor-replay-v8'),
    network: z.literal('mainnet-beta'),
    mint: addressSchema,
    startSlot: count,
    endSlot: count,
    firstSlot: count,
    lastSlot: count,
    sourceRawSha256: hashText,
    sourceIndexSha256: hashText,
    sourceBytes: positiveCount,
    presentSlots: positiveCount,
    skippedSlots: count,
    blocks: positiveCount,
    transactions: positiveCount,
    matchedTransactions: positiveCount,
    swaps: positiveCount,
    transactionFile: z.literal('transactions.ndjson'),
    transactionSha256: hashText,
    swapFile: z.literal('swaps.ndjson'),
    swapSha256: hashText,
    tradeContract: z.literal('fervor-trade-v2'),
    trades: positiveCount,
    tradeFile: z.literal('trades.ndjson'),
    tradeSha256: hashText,
    pumpLayout: z.literal('pump-event-2024-11-v1'),
    pumpEvents: positiveCount,
    pumpEventFile: z.literal('pump-events.ndjson'),
    pumpEventSha256: hashText,
    pumpStateFile: z.literal('pump-state.json'),
    pumpStateSha256: hashText,
    pumpCurveContract: z.literal(pumpCurveContract),
    pumpLiquidityPolicy: z.literal(pumpLiquidityPolicy),
    pumpCurvePoints: positiveCount,
    pumpCurveFile: z.literal('pump-curve.ndjson'),
    pumpCurveSha256: hashText,
    supplyContract: z.literal('fervor-supply-v1'),
    supplyFile: z.literal('supply.json'),
    supplySha256: hashText,
    fxContract: z.literal('fervor-fx-observation-v1'),
    fxPolicy: z.literal('fervor-sol-usd-v1'),
    fxObservations: positiveCount,
    fxFile: z.literal('fx-observations.ndjson'),
    fxSha256: hashText,
    fxTapeContract: z.literal('fervor-fx-tape-v1'),
    fxTapeBuckets: positiveCount,
    fxTapeFile: z.literal('fx-tape.ndjson'),
    fxTapeSha256: hashText,
    replaySha256: hashText,
}).strict().superRefine((value, context) => {
    if (value.startSlot >= value.endSlot
        || value.firstSlot < value.startSlot
        || value.lastSlot >= value.endSlot
        || value.firstSlot > value.lastSlot
        || value.blocks !== value.presentSlots
        || value.matchedTransactions > value.transactions
        || value.trades !== value.swaps) {
        context.addIssue({ code: 'custom', message: 'Replay manifest counts or bounds are inconsistent' });
    }
});

export type ReplayManifest = z.infer<typeof replayManifestSchema>;

const ratio18 = (numerator: bigint, denominator: bigint): string => {
    if (denominator <= 0n) throw new Error('Curve ratio denominator must be positive');
    const scaled = numerator * SCALE / denominator;
    const whole = scaled / SCALE;
    const fraction = (scaled % SCALE).toString().padStart(18, '0');
    return `${whole}.${fraction}`;
};

export const pumpCurveSchema = z.object({
    contract: z.literal(pumpCurveContract),
    liquidityPolicy: z.literal(pumpLiquidityPolicy),
    sourceEventId: z.string().min(1).max(220),
    completionEventId: z.string().min(1).max(220).optional(),
    mint: addressSchema,
    bondingCurve: addressSchema,
    slot: u64Schema,
    txIndex: u64Schema,
    signature: signatureSchema,
    instructionIndex: count,
    eventIndex: count,
    observedAt: time,
    complete: z.boolean(),
    decimals: z.number().int().min(0).max(18),
    supplyRaw: amountSchema,
    virtualSolRaw: amountSchema,
    virtualTokenRaw: amountSchema,
    realSolRaw: u64Schema,
    realTokenRaw: u64Schema,
    priceSol: decimal18,
    fdvSol: decimal18,
    liquiditySol: decimal18,
    liquidityEstimated: z.literal(true),
}).strict().superRefine((value, context) => {
    const virtualSol = BigInt(value.virtualSolRaw);
    const virtualToken = BigInt(value.virtualTokenRaw);
    const realSol = BigInt(value.realSolRaw);
    const realToken = BigInt(value.realTokenRaw);
    const supply = BigInt(value.supplyRaw);
    const denominator = virtualToken * LAMPORTS;
    const price = ratio18(virtualSol * 10n ** BigInt(value.decimals), denominator);
    const fdv = ratio18(supply * virtualSol, denominator);
    const liquidity = ratio18(realSol * virtualToken + realToken * virtualSol, denominator);
    if (value.priceSol !== price || value.fdvSol !== fdv || value.liquiditySol !== liquidity) {
        context.addIssue({ code: 'custom', message: 'Pump curve derived values differ from exact reserves' });
    }
    if (value.complete !== Boolean(value.completionEventId)) {
        context.addIssue({ code: 'custom', message: 'Pump curve completion lineage is inconsistent' });
    }
    if (value.complete !== (realToken === 0n)
        || value.completionEventId === value.sourceEventId) {
        context.addIssue({ code: 'custom', message: 'Pump curve completion state is inconsistent' });
    }
});

export type PumpCurvePoint = z.infer<typeof pumpCurveSchema>;

const pumpStateSchema = z.object({
    mint: addressSchema,
    phase: z.enum(['curve', 'complete', 'migrated']),
}).passthrough();

export type PumpPhase = z.infer<typeof pumpStateSchema>['phase'];

export type CurveMetric = PumpCurvePoint & {
    metricSource: typeof fervorMetricSource;
    metricVersion: typeof fervorMetricVersion;
    solUsd?: number;
    priceUsd?: number;
    fdvUsd?: number;
    liquidityUsd?: number;
    usdSourceEventId?: string;
    usdObservedAt?: string;
    usdEstimated?: boolean;
};

export interface MetricState {
    contract: 'fervor-market-golden-v1';
    inputContract: typeof fervorInputContract;
    metricSource: typeof fervorMetricSource;
    metricVersion: typeof fervorMetricVersion;
    tokenMint: string;
    asOf: string;
    phase: PumpPhase;
    tradeCount: number;
    pricedTradeCount: number;
    unpricedTradeCount: number;
    priceCoverageBps: number;
    priceUsd: number | null;
    priceObservedAt: string | null;
    priceSourceEventId: string | null;
    priceSol: number | null;
    priceSolObservedAt: string | null;
    totalSupply: number;
    supplySourceEventId: string;
    marketCapUsd: null;
    fdvUsd: number | null;
    liquidityUsd: number | null;
    liquidityStatus: 'supported_curve_estimate' | 'terminal_curve_estimate' | 'unsupported_after_migration';
    lastCurve: {
        sourceEventId: string;
        observedAt: string;
        liquiditySol: string;
        liquidityUsd: number | null;
        estimated: true;
    };
    rolling: RollingWindowMetrics;
    usdPricedCount: RollingWindowMetrics['txCount'];
    usdCoverageBps: Record<RollingWindowName, number>;
    rollingEstimated: true;
}

export interface MetricReplay {
    sourceManifestSha256: string;
    source: ReplayManifest;
    sourceTrades: NormalizedTradeEvent[];
    trades: NormalizedTradeEvent[];
    curve: CurveMetric[];
    candles: CandleUpdate[];
    state: MetricState;
}

export interface MetricInput {
    manifest: ReplayManifest;
    manifestSha256: string;
    trades: readonly unknown[];
    fxTape: readonly unknown[];
    curve: readonly unknown[];
    supply: unknown;
    phase: PumpPhase;
}

const coverage = (priced: number, total: number): number =>
    total === 0 ? 0 : Math.floor(priced * 10_000 / total);

const windowCoverage = (
    priced: RollingWindowMetrics['txCount'],
    total: RollingWindowMetrics['txCount']
): Record<RollingWindowName, number> => Object.fromEntries(
    (Object.keys(total) as RollingWindowName[]).map((name) => [name, coverage(priced[name], total[name])])
) as Record<RollingWindowName, number>;

const ensureCurve = (
    points: PumpCurvePoint[],
    manifest: ReplayManifest,
    supply: FervorSupplyInput
): void => {
    const ids = new Set<string>();
    let lastOrder: readonly [bigint, bigint, number] | undefined;
    let bondingCurve: string | undefined;
    let completed = false;
    for (const point of points) {
        const order = [BigInt(point.slot), BigInt(point.txIndex), point.eventIndex] as const;
        const outOfOrder = lastOrder !== undefined && (
            order[0] < lastOrder[0]
            || (order[0] === lastOrder[0] && order[1] < lastOrder[1])
            || (order[0] === lastOrder[0] && order[1] === lastOrder[1] && order[2] <= lastOrder[2])
        );
        if (point.mint !== manifest.mint
            || point.supplyRaw !== supply.rawAmount
            || point.decimals !== supply.decimals
            || (bondingCurve !== undefined && point.bondingCurve !== bondingCurve)
            || outOfOrder
            || !ids.add(point.sourceEventId)
            || completed) {
            throw new Error('Pump curve points are not a consistent ordered lifecycle');
        }
        lastOrder = order;
        bondingCurve = point.bondingCurve;
        completed = point.complete;
    }
};

export const projectMetricData = async (input: MetricInput): Promise<MetricReplay> => {
    hashText.parse(input.manifestSha256);
    const supply = supplySchema.parse(input.supply);
    if (supply.tokenMint !== input.manifest.mint || supply.stale || !supply.fixed) {
        throw new Error('Replay supply does not qualify the manifest mint');
    }
    const sourceTrades = z.array(decodedTradeSchema).parse(input.trades);
    if (sourceTrades.length !== input.manifest.trades) {
        throw new Error('Replay trade count differs from the manifest');
    }
    const ids = new Set<string>();
    for (const trade of sourceTrades) {
        if (trade.tokenMint !== input.manifest.mint || !ids.add(trade.idempotencyKey)) {
            throw new Error('Replay trades are not unique events for the manifest mint');
        }
    }
    const rawTrades = [...sourceTrades].sort(tradeOrder);
    for (let index = 1; index < rawTrades.length; index += 1) {
        if (Date.parse(rawTrades[index].observedAt) < Date.parse(rawTrades[index - 1].observedAt)) {
            throw new Error('Replay event time regresses in canonical chain order');
        }
    }
    const points = z.array(pumpCurveSchema).parse(input.curve);
    if (points.length !== input.manifest.pumpCurvePoints) {
        throw new Error('Pump curve count differs from the manifest');
    }
    ensureCurve(points, input.manifest, supply);
    if (input.fxTape.length !== input.manifest.fxTapeBuckets) {
        throw new Error('FX tape count differs from the manifest');
    }
    const curveComplete = points.at(-1)!.complete;
    if ((input.phase === 'curve' && curveComplete)
        || (input.phase !== 'curve' && !curveComplete)) {
        throw new Error('Pump phase differs from the final curve point');
    }
    const prices = new FxTapeSource(input.fxTape);
    const enricher = new TradeEnricher(prices);
    const trades: NormalizedTradeEvent[] = [];
    for (const raw of rawTrades) {
        const enriched = await enricher.enrich(raw);
        if (enriched) trades.push(enriched);
    }

    const curve: CurveMetric[] = [];
    for (const point of points) {
        const sol = await prices.getUsd(SOL_MINT, point.observedAt);
        if (!sol) {
            curve.push({ ...point, metricSource: fervorMetricSource, metricVersion: fervorMetricVersion });
            continue;
        }
        const priceUsd = Number(point.priceSol) * sol.usdPrice;
        const liquidityUsd = Number(point.liquiditySol) * sol.usdPrice;
        const derived = deriveFervorMetrics({
            tokenMint: point.mint,
            priceUsd,
            supply,
            liquidityUsd,
        });
        curve.push({
            ...point,
            metricSource: derived.metricSource,
            metricVersion: derived.metricVersion,
            solUsd: sol.usdPrice,
            priceUsd,
            fdvUsd: derived.fdvUsd,
            liquidityUsd: derived.liquidityUsd,
            usdSourceEventId: sol.sourceEventId,
            usdObservedAt: sol.fetchedAt,
            usdEstimated: sol.estimated ?? true,
        });
    }

    const finalMs = Date.parse(rawTrades.at(-1)!.observedAt);
    const enrichedById = new Map(trades.map((trade) => [trade.idempotencyKey, trade]));
    const book = new RollingMetricBook(input.manifest.mint);
    const pricedBook = new RollingMetricBook(input.manifest.mint);
    for (const raw of rawTrades) {
        const trade = enrichedById.get(raw.idempotencyKey);
        const event = trade ?? raw;
        const observedMs = Date.parse(event.observedAt);
        if (observedMs <= finalMs - 86_400_000) continue;
        if (!book.add(event, finalMs)) {
            throw new Error(`Rolling metric engine rejected ${event.idempotencyKey}`);
        }
        if (trade && !pricedBook.add(trade, finalMs)) {
            throw new Error(`Priced rolling metric engine rejected ${event.idempotencyKey}`);
        }
    }
    const rolling = book.metrics(finalMs);
    const pricedRolling = pricedBook.metrics(finalMs);
    const latest = trades.at(-1);
    const latestSol = [...rawTrades].reverse().find((trade) => trade.priceSol !== undefined);
    const lastCurve = curve.at(-1)!;
    const totalSupply = supplyAmount(supply, input.manifest.mint);
    if (totalSupply === undefined) throw new Error('Replay supply cannot produce total supply');
    const currentLiquidity = input.phase === 'migrated' ? undefined : lastCurve.liquidityUsd;
    const derived = deriveFervorMetrics({
        tokenMint: input.manifest.mint,
        priceUsd: latest?.priceUsd,
        supply,
        liquidityUsd: currentLiquidity,
    });
    const state: MetricState = {
        contract: 'fervor-market-golden-v1',
        inputContract: fervorInputContract,
        metricSource: derived.metricSource,
        metricVersion: derived.metricVersion,
        tokenMint: input.manifest.mint,
        asOf: new Date(finalMs).toISOString(),
        phase: input.phase,
        tradeCount: rawTrades.length,
        pricedTradeCount: trades.length,
        unpricedTradeCount: rawTrades.length - trades.length,
        priceCoverageBps: coverage(trades.length, rawTrades.length),
        priceUsd: latest?.priceUsd ?? null,
        priceObservedAt: latest?.observedAt ?? null,
        priceSourceEventId: latest?.usdSourceEventId ?? null,
        priceSol: latestSol?.priceSol ?? null,
        priceSolObservedAt: latestSol?.observedAt ?? null,
        totalSupply,
        supplySourceEventId: supply.sourceEventId,
        marketCapUsd: null,
        fdvUsd: derived.fdvUsd ?? null,
        liquidityUsd: derived.liquidityUsd ?? null,
        liquidityStatus: input.phase === 'curve'
            ? 'supported_curve_estimate'
            : input.phase === 'complete'
                ? 'terminal_curve_estimate'
                : 'unsupported_after_migration',
        lastCurve: {
            sourceEventId: lastCurve.sourceEventId,
            observedAt: lastCurve.observedAt,
            liquiditySol: lastCurve.liquiditySol,
            liquidityUsd: lastCurve.liquidityUsd ?? null,
            estimated: true,
        },
        rolling,
        usdPricedCount: pricedRolling.txCount,
        usdCoverageBps: windowCoverage(pricedRolling.txCount, rolling.txCount),
        rollingEstimated: true,
    };
    return {
        sourceManifestSha256: input.manifestSha256,
        source: input.manifest,
        sourceTrades: rawTrades,
        trades,
        curve,
        candles: aggregateCandles(trades),
        state,
    };
};

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

const hashFile = async (file: string): Promise<string> => {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) {
        throw new Error(`Replay artifact is not a non-empty regular file: ${path.basename(file)}`);
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex');
};

export const replayDigest = (schema: string, hashes: readonly string[]): string => {
    const hash = createHash('sha256');
    hash.update(schema);
    for (const value of hashes) {
        hash.update(Buffer.from([0]));
        hash.update(value);
    }
    return hash.digest('hex');
};

const readJson = async <T>(file: string, schema: z.ZodType<T>, maxBytes = 1_048_576): Promise<T> => {
    const bytes = await readFile(file);
    if (bytes.length === 0 || bytes.length > maxBytes) {
        throw new Error(`${path.basename(file)} has an invalid size`);
    }
    try {
        return schema.parse(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${path.basename(file)} violates its contract: ${detail}`);
    }
};

const readNdjson = async <T>(
    file: string,
    schema: z.ZodType<T>,
    expected: number
): Promise<T[]> => {
    const values: T[] = [];
    const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    let lineNumber = 0;
    try {
        for await (const line of lines) {
            lineNumber += 1;
            if (!line || Buffer.byteLength(line, 'utf8') > 2_097_152) {
                throw new Error('line is empty or exceeds 2 MiB');
            }
            values.push(schema.parse(JSON.parse(line)));
            if (values.length > expected) throw new Error('line count exceeds the manifest');
        }
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${path.basename(file)} line ${lineNumber} violates its contract: ${detail}`);
    }
    if (values.length !== expected) {
        throw new Error(`${path.basename(file)} count differs from the manifest`);
    }
    return values;
};

export const buildMetricReplay = async (replayDir: string): Promise<MetricReplay> => {
    const dir = path.resolve(replayDir);
    const manifestFile = path.join(dir, 'manifest.json');
    const manifestBytes = await readFile(manifestFile);
    if (manifestBytes.length === 0 || manifestBytes.length > 1_048_576) {
        throw new Error('Replay manifest has an invalid size');
    }
    const manifest = replayManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
    const artifacts = [
        [manifest.transactionFile, manifest.transactionSha256],
        [manifest.swapFile, manifest.swapSha256],
        [manifest.tradeFile, manifest.tradeSha256],
        [manifest.pumpEventFile, manifest.pumpEventSha256],
        [manifest.pumpStateFile, manifest.pumpStateSha256],
        [manifest.pumpCurveFile, manifest.pumpCurveSha256],
        [manifest.supplyFile, manifest.supplySha256],
        [manifest.fxFile, manifest.fxSha256],
        [manifest.fxTapeFile, manifest.fxTapeSha256],
    ] as const;
    for (const [name, expected] of artifacts) {
        if (await hashFile(path.join(dir, name)) !== expected) {
            throw new Error(`Replay artifact hash differs from the manifest: ${name}`);
        }
    }
    const hashes = artifacts.map(([, hash]) => hash);
    if (replayDigest(manifest.schema, hashes) !== manifest.replaySha256) {
        throw new Error('Replay digest differs from its component hashes');
    }
    const [trades, fxTape, curve, supply, pumpState] = await Promise.all([
        readNdjson(path.join(dir, manifest.tradeFile), decodedTradeSchema, manifest.trades),
        readNdjson(path.join(dir, manifest.fxTapeFile), fxPointSchema, manifest.fxTapeBuckets),
        readNdjson(path.join(dir, manifest.pumpCurveFile), pumpCurveSchema, manifest.pumpCurvePoints),
        readJson(path.join(dir, manifest.supplyFile), supplySchema),
        readJson(path.join(dir, manifest.pumpStateFile), pumpStateSchema),
    ]);
    if (pumpState.mint !== manifest.mint) throw new Error('Pump state differs from the replay mint');
    return projectMetricData({
        manifest,
        manifestSha256: sha256(manifestBytes),
        trades,
        fxTape,
        curve,
        supply,
        phase: pumpState.phase,
    });
};

export interface OutputManifest {
    schema: typeof metricReplaySchema;
    tokenMint: string;
    sourceReplaySchema: ReplayManifest['schema'];
    sourceReplaySha256: string;
    sourceManifestSha256: string;
    tradeFile: 'trades.ndjson';
    trades: number;
    tradeSha256: string;
    curveFile: 'curve-metrics.ndjson';
    curvePoints: number;
    curveSha256: string;
    candleFile: 'candles.ndjson';
    candles: number;
    candleSha256: string;
    stateFile: 'market-state.json';
    stateSha256: string;
    projectionSha256: string;
}

const writeJson = async (file: string, value: unknown): Promise<string> => {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    const handle = await open(file, 'wx');
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    } finally {
        await handle.close();
    }
    return sha256(bytes);
};

const writeLines = async (file: string, values: readonly unknown[]): Promise<string> => {
    const handle = await open(file, 'wx');
    const hash = createHash('sha256');
    try {
        for (const value of values) {
            const line = `${JSON.stringify(value)}\n`;
            await handle.writeFile(line);
            hash.update(line);
        }
        await handle.sync();
    } finally {
        await handle.close();
    }
    return hash.digest('hex');
};

const syncDir = async (dir: string): Promise<void> => {
    const handle = await open(dir, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
};

export const writeMetricReplay = async (outDir: string, replay: MetricReplay): Promise<OutputManifest> => {
    const out = path.resolve(outDir);
    const parent = path.dirname(out);
    const name = path.basename(out);
    if (!name || name === '.' || name === '..') throw new Error('Metric replay output path is invalid');
    try {
        await lstat(out);
        throw new Error(`Metric replay output already exists: ${out}`);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const stage = path.join(parent, `.${name}.${process.pid}.stage`);
    await mkdir(stage);
    try {
        const tradeSha256 = await writeLines(path.join(stage, 'trades.ndjson'), replay.trades);
        const curveSha256 = await writeLines(path.join(stage, 'curve-metrics.ndjson'), replay.curve);
        const candleSha256 = await writeLines(path.join(stage, 'candles.ndjson'), replay.candles);
        const stateSha256 = await writeJson(path.join(stage, 'market-state.json'), replay.state);
        const manifest: OutputManifest = {
            schema: metricReplaySchema,
            tokenMint: replay.source.mint,
            sourceReplaySchema: replay.source.schema,
            sourceReplaySha256: replay.source.replaySha256,
            sourceManifestSha256: replay.sourceManifestSha256,
            tradeFile: 'trades.ndjson',
            trades: replay.trades.length,
            tradeSha256,
            curveFile: 'curve-metrics.ndjson',
            curvePoints: replay.curve.length,
            curveSha256,
            candleFile: 'candles.ndjson',
            candles: replay.candles.length,
            candleSha256,
            stateFile: 'market-state.json',
            stateSha256,
            projectionSha256: replayDigest(metricReplaySchema, [
                replay.source.replaySha256,
                tradeSha256,
                curveSha256,
                candleSha256,
                stateSha256,
            ]),
        };
        await writeJson(path.join(stage, 'manifest.json'), manifest);
        await syncDir(stage);
        await rename(stage, out);
        await syncDir(parent);
        return manifest;
    } catch (error) {
        await rm(stage, { recursive: true, force: true });
        throw error;
    }
};
