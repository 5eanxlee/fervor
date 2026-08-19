import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReplaySessionStore } from '../src/services/replay/checkpointStore';
import { ReplayCoordinator } from '../src/services/replay/coordinator';
import {
    paperModelContract,
    ReplayPaperBroker,
    type PaperModelInput,
} from '../src/services/replay/paperBroker';
import { ReplayProjection } from '../src/services/replay/projection';
import {
    createReplaySession,
    parseReplaySession,
    replaySessionContract,
} from '../src/services/replay/sessionCheckpoint';
import { replayTape } from './helpers/replayTape';

const tempDirs: string[] = [];
const quoteMint = 'So11111111111111111111111111111111111111112';

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const model: PaperModelInput = {
    contract: paperModelContract,
    latency: { clientMs: 0, buildMs: 0, submitMs: 0 },
    participationBps: 1_000,
    maxLookaheadMs: 60_000,
    priceGuardBps: 500,
    protocolFeeBps: 0,
    fixedFees: [],
    partialFill: 'allow',
};

const stateAt = (cursor: number) => {
    const coordinator = new ReplayCoordinator(replayTape(), 'session-a');
    const projection = ReplayProjection.start(coordinator);
    const paper = new ReplayPaperBroker(coordinator.snapshot(), model);
    for (let index = 0; index < cursor; index += 1) {
        const event = coordinator.step()!;
        projection.apply(event);
        paper.apply(event);
    }
    return {
        coordinator,
        paper,
        replay: projection.checkpoint(coordinator),
        paperState: paper.checkpoint(coordinator.snapshot()),
    };
};

describe('replay session checkpoints', () => {
    it('binds market and paper state to one canonical cut', () => {
        const atOne = stateAt(1);
        const session = createReplaySession(0, null, atOne.replay, atOne.paperState);
        const portable = JSON.parse(JSON.stringify(session));

        expect(parseReplaySession(portable)).toEqual(session);
        expect(session).toMatchObject({
            contract: replaySessionContract,
            seq: 0,
            parentSha256: null,
            replay: { cut: { cursor: 1 } },
            paper: { cursor: 1, runId: 'session-a' },
        });

        const atZero = stateAt(0);
        expect(() => createReplaySession(0, null, atOne.replay, atZero.paperState))
            .toThrow('one cut');
        expect(() => createReplaySession(
            Number.MAX_SAFE_INTEGER + 1, null, atOne.replay, atOne.paperState
        ))
            .toThrow('sequence is invalid');
    });

    it('stores one ordered, immutable session history per run', async () => {
        const temp = await mkdtemp(path.join(os.tmpdir(), 'fervor-session-'));
        tempDirs.push(temp);
        const store = new ReplaySessionStore(path.join(temp, 'store'));
        const firstState = stateAt(1);
        const first = createReplaySession(0, null, firstState.replay, firstState.paperState);

        const keys = await Promise.all(Array.from({ length: 4 }, () => store.write(first)));
        expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(1);
        await expect(store.read(keys[0])).resolves.toEqual(first);
        await expect(store.latest(first.paper.sourceReplaySha256, first.paper.runId))
            .resolves.toEqual(first);

        firstState.paper.place({
            id: 'same-cut',
            kind: 'market',
            side: 'buy',
            tokenMint: firstState.replay.tokenMint,
            quoteMint,
            inputRaw: '1',
            reference: { quoteRaw: '1', tokenRaw: '1' },
        });
        const nextPaper = firstState.paper.checkpoint(firstState.coordinator.snapshot());
        await expect(store.write(createReplaySession(
            0, null, firstState.replay, nextPaper
        ))).rejects.toThrow('collides');
        const second = createReplaySession(
            1, first.checkpointSha256, firstState.replay, nextPaper
        );
        await store.write(second);
        await expect(store.latest(second.paper.sourceReplaySha256, second.paper.runId))
            .resolves.toEqual(second);
        await expect(store.write(first)).rejects.toThrow('writer is stale');
        await expect(store.write(createReplaySession(
            3, second.checkpointSha256, firstState.replay, nextPaper
        ))).rejects.toThrow('sequence has a gap');
        await expect(store.write(createReplaySession(
            2, '0'.repeat(64), firstState.replay, nextPaper
        ))).rejects.toThrow('parent is stale');
        const reset = stateAt(2);
        await expect(store.write(createReplaySession(
            2, second.checkpointSha256, reset.replay, reset.paperState
        ))).rejects.toThrow('does not extend');

        const dir = path.join(
            store.root,
            second.paper.sourceReplaySha256,
            replaySessionContract,
            second.paper.runId
        );
        expect((await readdir(dir)).sort()).toEqual([
            '0000000000000000.json',
            '0000000000000001.json',
        ]);
    });
});
