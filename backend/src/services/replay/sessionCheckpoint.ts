import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
    parsePaperCheckpoint,
    type PaperCheckpoint,
} from './paperCheckpoint';
import {
    parseReplayCheckpoint,
    type ReplayCheckpoint,
} from './projection';

export const replaySessionContract = 'fervor-replay-session-v1' as const;

export interface ReplaySessionCheckpoint {
    readonly contract: typeof replaySessionContract;
    readonly seq: number;
    readonly parentSha256: string | null;
    readonly replay: ReplayCheckpoint;
    readonly paper: PaperCheckpoint;
    readonly checkpointSha256: string;
}

type SessionPayload = Omit<ReplaySessionCheckpoint, 'checkpointSha256'>;

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const sessionSchema = z.object({
    contract: z.literal(replaySessionContract),
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    parentSha256: hash.nullable(),
    replay: z.unknown(),
    paper: z.unknown(),
    checkpointSha256: hash,
}).strict();

const digest = (payload: SessionPayload): string => createHash('sha256')
    .update(replaySessionContract)
    .update('\0')
    .update(JSON.stringify(payload))
    .digest('hex');

const payloadOf = (
    seq: number,
    parentSha256: string | null,
    replay: ReplayCheckpoint,
    paper: PaperCheckpoint
): SessionPayload => ({
    contract: replaySessionContract,
    seq,
    parentSha256,
    replay,
    paper,
});

const assertBound = (replay: ReplayCheckpoint, paper: PaperCheckpoint): void => {
    if (replay.cut.sourceReplaySha256 !== paper.sourceReplaySha256
        || replay.cut.cursor !== paper.cursor
        || replay.cut.now !== paper.now) {
        throw new Error('Replay session components do not share one cut');
    }
};

export const createReplaySession = (
    seq: number,
    parentSha256: string | null,
    replayValue: unknown,
    paperValue: unknown
): ReplaySessionCheckpoint => {
    if (!Number.isSafeInteger(seq)
        || seq < 0
        || (seq === 0) !== (parentSha256 === null)
        || (parentSha256 !== null && !/^[0-9a-f]{64}$/.test(parentSha256))) {
        throw new Error('Replay session sequence is invalid');
    }
    const replay = parseReplayCheckpoint(replayValue);
    const paper = parsePaperCheckpoint(paperValue);
    assertBound(replay, paper);
    const payload = payloadOf(seq, parentSha256, replay, paper);
    return Object.freeze({ ...payload, checkpointSha256: digest(payload) });
};

export const parseReplaySession = (value: unknown): ReplaySessionCheckpoint => {
    const envelope = sessionSchema.parse(value);
    if ((envelope.seq === 0) !== (envelope.parentSha256 === null)) {
        throw new Error('Replay session sequence is invalid');
    }
    const replay = parseReplayCheckpoint(envelope.replay);
    const paper = parsePaperCheckpoint(envelope.paper);
    assertBound(replay, paper);
    const payload = payloadOf(envelope.seq, envelope.parentSha256, replay, paper);
    if (digest(payload) !== envelope.checkpointSha256) {
        throw new Error('Replay session checksum differs');
    }
    return Object.freeze({ ...payload, checkpointSha256: envelope.checkpointSha256 });
};
