import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
    parseReplayCheckpoint,
    replayCheckpointContract,
    type ReplayCheckpoint,
} from './projection';
import {
    parseReplaySession,
    replaySessionContract,
    type ReplaySessionCheckpoint,
} from './sessionCheckpoint';

const maxBytes = 32 * 1024 * 1024;
const hashPattern = /^[0-9a-f]{64}$/;
const runPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const filePattern = /^(\d{16})\.json$/;
const tempPattern = /^\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

export interface CheckpointKey {
    readonly sourceReplaySha256: string;
    readonly cursor: number;
    readonly checkpointSha256: string;
}

export interface SessionKey extends CheckpointKey {
    readonly runId: string;
    readonly seq: number;
}

const syncDir = async (dir: string): Promise<void> => {
    const handle = await open(dir, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
};

const requireDir = async (dir: string, label: string): Promise<void> => {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Replay checkpoint ${label} is not a regular directory`);
    }
};

const createDir = async (dir: string, parent: string, label: string): Promise<void> => {
    try {
        await mkdir(dir, { mode: 0o700 });
        await syncDir(parent);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await requireDir(dir, label);
};

const bytesOf = (checkpoint: unknown): string =>
    `${JSON.stringify(checkpoint, null, 2)}\n`;

const rootOf = (value: string, label: string): string => {
    const root = path.resolve(value);
    if (root === path.parse(root).root) throw new Error(`${label} root is invalid`);
    return root;
};

const fileName = (value: number): string =>
    `${value.toString().padStart(16, '0')}.json`;

const storedNumbers = async (dir: string, label: string): Promise<number[]> => {
    const values: number[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (tempPattern.test(entry.name)) {
            if (!entry.isFile()) throw new Error(`${label} directory entry is invalid`);
            continue;
        }
        const match = filePattern.exec(entry.name);
        const value = match === null ? NaN : Number(match[1]);
        if (!entry.isFile()
            || match === null
            || !Number.isSafeInteger(value)
            || fileName(value) !== entry.name) {
            throw new Error(`${label} directory entry is invalid`);
        }
        values.push(value);
    }
    return values;
};

const preparePath = async (root: string, segments: readonly string[]): Promise<string> => {
    await createDir(root, path.dirname(root), 'root');
    let current = root;
    for (const [index, segment] of segments.entries()) {
        const next = path.join(current, segment);
        await createDir(next, current, `path ${index + 1}`);
        current = next;
    }
    return current;
};

const existingPath = async (root: string, segments: readonly string[]): Promise<string> => {
    await requireDir(root, 'root');
    let current = root;
    for (const [index, segment] of segments.entries()) {
        current = path.join(current, segment);
        await requireDir(current, `path ${index + 1}`);
    }
    return current;
};

const readBytes = async (file: string): Promise<string> => {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size === 0 || info.size > maxBytes) {
            throw new Error('Stored replay checkpoint has an invalid file shape or size');
        }
        const bytes = await handle.readFile();
        if (bytes.length !== info.size || bytes.length > maxBytes) {
            throw new Error('Stored replay checkpoint changed while being read');
        }
        return bytes.toString('utf8');
    } finally {
        await handle.close();
    }
};

const writeOnce = async (dir: string, target: string, bytes: string): Promise<void> => {
    const temporary = path.join(dir, `.${process.pid}.${randomUUID()}.tmp`);
    let created = false;
    try {
        const handle = await open(temporary, 'wx', 0o600);
        created = true;
        try {
            await handle.writeFile(bytes);
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            await link(temporary, target);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (await readBytes(target) !== bytes) {
                throw new Error('Stored replay checkpoint collides with different bytes');
            }
        }
    } finally {
        if (created) {
            await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error;
            });
            await syncDir(dir);
        }
    }
};

const keyOf = (checkpoint: ReplayCheckpoint): CheckpointKey => ({
    sourceReplaySha256: checkpoint.cut.sourceReplaySha256,
    cursor: checkpoint.cut.cursor,
    checkpointSha256: checkpoint.checkpointSha256,
});

const sessionKeyOf = (checkpoint: ReplaySessionCheckpoint): SessionKey => ({
    sourceReplaySha256: checkpoint.replay.cut.sourceReplaySha256,
    cursor: checkpoint.replay.cut.cursor,
    checkpointSha256: checkpoint.checkpointSha256,
    runId: checkpoint.paper.runId,
    seq: checkpoint.seq,
});

const parseKey = (value: unknown): CheckpointKey => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Replay checkpoint key is invalid');
    }
    const key = value as Record<string, unknown>;
    const fields = ['sourceReplaySha256', 'cursor', 'checkpointSha256'];
    if (Object.keys(key).length !== fields.length
        || fields.some((field) => !Object.prototype.hasOwnProperty.call(key, field))
        || typeof key.sourceReplaySha256 !== 'string'
        || !hashPattern.test(key.sourceReplaySha256)
        || !Number.isSafeInteger(key.cursor)
        || (key.cursor as number) < 0
        || typeof key.checkpointSha256 !== 'string'
        || !hashPattern.test(key.checkpointSha256)) {
        throw new Error('Replay checkpoint key is invalid');
    }
    return {
        sourceReplaySha256: key.sourceReplaySha256,
        cursor: key.cursor as number,
        checkpointSha256: key.checkpointSha256,
    };
};

const parseSessionKey = (value: unknown): SessionKey => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Replay session key is invalid');
    }
    const key = value as Record<string, unknown>;
    const base = parseKey({
        sourceReplaySha256: key.sourceReplaySha256,
        cursor: key.cursor,
        checkpointSha256: key.checkpointSha256,
    });
    if (Object.keys(key).length !== 5
        || typeof key.runId !== 'string'
        || !runPattern.test(key.runId)
        || !Number.isSafeInteger(key.seq)
        || (key.seq as number) < 0) {
        throw new Error('Replay session key is invalid');
    }
    return { ...base, runId: key.runId, seq: key.seq as number };
};

export class CheckpointStore {
    readonly root: string;

    constructor(root: string) {
        this.root = rootOf(root, 'Replay checkpoint');
    }

    async write(value: unknown): Promise<CheckpointKey> {
        const checkpoint = parseReplayCheckpoint(value);
        const key = keyOf(checkpoint);
        const bytes = bytesOf(checkpoint);
        if (Buffer.byteLength(bytes) > maxBytes) {
            throw new Error('Replay checkpoint exceeds the durable size limit');
        }
        const dir = await this.prepare(key.sourceReplaySha256);
        const target = path.join(dir, fileName(key.cursor));
        await writeOnce(dir, target, bytes);
        return key;
    }

    async read(value: unknown): Promise<ReplayCheckpoint> {
        const key = parseKey(value);
        const dir = await this.existing(key.sourceReplaySha256);
        const file = path.join(dir, fileName(key.cursor));
        return this.readFile(file, key.sourceReplaySha256, key.cursor, key.checkpointSha256);
    }

    private async readFile(
        file: string,
        sourceSha: string,
        cursor: number,
        checkpointSha?: string
    ): Promise<ReplayCheckpoint> {
        const bytes = await readBytes(file);
        let checkpoint: ReplayCheckpoint;
        try {
            checkpoint = parseReplayCheckpoint(JSON.parse(bytes));
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Stored replay checkpoint is invalid: ${detail}`);
        }
        const storedKey = keyOf(checkpoint);
        if (storedKey.sourceReplaySha256 !== sourceSha
            || storedKey.cursor !== cursor
            || (checkpointSha !== undefined && storedKey.checkpointSha256 !== checkpointSha)
            || bytesOf(checkpoint) !== bytes) {
            throw new Error('Stored replay checkpoint differs from its key or canonical bytes');
        }
        return checkpoint;
    }

    async nearest(sourceValue: unknown, cursorValue: unknown): Promise<ReplayCheckpoint | null> {
        if (typeof sourceValue !== 'string'
            || !hashPattern.test(sourceValue)
            || !Number.isSafeInteger(cursorValue)
            || (cursorValue as number) < 0) {
            throw new Error('Replay checkpoint selection is invalid');
        }
        let dir: string;
        try {
            dir = await this.existing(sourceValue);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }

        let best = -1;
        for (const cursor of await storedNumbers(dir, 'Replay checkpoint')) {
            if (cursor > (cursorValue as number) || cursor < best) continue;
            best = cursor;
        }
        if (best === -1) return null;
        return this.readFile(path.join(dir, fileName(best)), sourceValue, best);
    }

    private async prepare(sourceSha: string): Promise<string> {
        return preparePath(this.root, [sourceSha, replayCheckpointContract]);
    }

    private async existing(sourceSha: string): Promise<string> {
        return existingPath(this.root, [sourceSha, replayCheckpointContract]);
    }
}

export class ReplaySessionStore {
    readonly root: string;

    constructor(root: string) {
        this.root = rootOf(root, 'Replay session');
    }

    async write(value: unknown): Promise<SessionKey> {
        const checkpoint = parseReplaySession(value);
        const key = sessionKeyOf(checkpoint);
        const bytes = bytesOf(checkpoint);
        if (Buffer.byteLength(bytes) > maxBytes) {
            throw new Error('Replay session exceeds the durable size limit');
        }
        const dir = await this.prepare(key.sourceReplaySha256, key.runId);
        const latest = await this.latestSeq(dir);
        if (key.seq < latest) throw new Error('Replay session writer is stale');
        if (key.seq > latest + 1) throw new Error('Replay session sequence has a gap');
        if (key.seq === latest + 1 && latest >= 0) {
            const parent = await this.readFile(path.join(dir, fileName(latest)), {
                sourceReplaySha256: key.sourceReplaySha256,
                runId: key.runId,
                seq: latest,
            });
            if (checkpoint.parentSha256 !== parent.checkpointSha256) {
                throw new Error('Replay session parent is stale');
            }
            this.assertNext(checkpoint, parent);
        }
        await writeOnce(dir, path.join(dir, fileName(key.seq)), bytes);
        return key;
    }

    async read(value: unknown): Promise<ReplaySessionCheckpoint> {
        const key = parseSessionKey(value);
        const dir = await this.existing(key.sourceReplaySha256, key.runId);
        return this.readFile(path.join(dir, fileName(key.seq)), key);
    }

    async latest(sourceValue: unknown, runValue: unknown): Promise<ReplaySessionCheckpoint | null> {
        if (typeof sourceValue !== 'string'
            || !hashPattern.test(sourceValue)
            || typeof runValue !== 'string'
            || !runPattern.test(runValue)) {
            throw new Error('Replay session selection is invalid');
        }
        let dir: string;
        try {
            dir = await this.existing(sourceValue, runValue);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
        const seq = await this.latestSeq(dir);
        if (seq === -1) return null;
        return this.readFile(path.join(dir, fileName(seq)), {
            sourceReplaySha256: sourceValue,
            runId: runValue,
            seq,
        });
    }

    private async readFile(
        file: string,
        expected: Pick<SessionKey, 'sourceReplaySha256' | 'runId' | 'seq'>
            & Partial<Pick<SessionKey, 'cursor' | 'checkpointSha256'>>
    ): Promise<ReplaySessionCheckpoint> {
        const bytes = await readBytes(file);
        let checkpoint: ReplaySessionCheckpoint;
        try {
            checkpoint = parseReplaySession(JSON.parse(bytes));
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Stored replay session is invalid: ${detail}`);
        }
        const key = sessionKeyOf(checkpoint);
        if (key.sourceReplaySha256 !== expected.sourceReplaySha256
            || key.runId !== expected.runId
            || key.seq !== expected.seq
            || (expected.cursor !== undefined && key.cursor !== expected.cursor)
            || (expected.checkpointSha256 !== undefined
                && key.checkpointSha256 !== expected.checkpointSha256)
            || bytesOf(checkpoint) !== bytes) {
            throw new Error('Stored replay session differs from its key or canonical bytes');
        }
        return checkpoint;
    }

    private async latestSeq(dir: string): Promise<number> {
        return (await storedNumbers(dir, 'Replay session'))
            .reduce((latest, seq) => Math.max(latest, seq), -1);
    }

    private assertNext(
        checkpoint: ReplaySessionCheckpoint,
        parent: ReplaySessionCheckpoint
    ): void {
        const sameEpoch = checkpoint.paper.epoch === parent.paper.epoch;
        const facts = checkpoint.paper.facts;
        if (checkpoint.paper.modelSha256 !== parent.paper.modelSha256
            || checkpoint.paper.epoch < parent.paper.epoch
            || (sameEpoch && checkpoint.paper.cursor < parent.paper.cursor)
            || (sameEpoch && parent.paper.facts.some((fact, index) =>
                JSON.stringify(facts[index]) !== JSON.stringify(fact)))) {
            throw new Error('Replay session does not extend its parent');
        }
    }

    private prepare(sourceSha: string, runId: string): Promise<string> {
        return preparePath(this.root, [sourceSha, replaySessionContract, runId]);
    }

    private existing(sourceSha: string, runId: string): Promise<string> {
        return existingPath(this.root, [sourceSha, replaySessionContract, runId]);
    }
}
