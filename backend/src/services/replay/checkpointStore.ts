import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
    parseReplayCheckpoint,
    replayCheckpointContract,
    type ReplayCheckpoint,
} from './projection';

const maxBytes = 32 * 1024 * 1024;
const hashPattern = /^[0-9a-f]{64}$/;
const filePattern = /^(\d{16})\.json$/;
const tempPattern = /^\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

export interface CheckpointKey {
    readonly sourceReplaySha256: string;
    readonly cursor: number;
    readonly checkpointSha256: string;
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

const bytesOf = (checkpoint: ReplayCheckpoint): string =>
    `${JSON.stringify(checkpoint, null, 2)}\n`;

const keyOf = (checkpoint: ReplayCheckpoint): CheckpointKey => ({
    sourceReplaySha256: checkpoint.cut.sourceReplaySha256,
    cursor: checkpoint.cut.cursor,
    checkpointSha256: checkpoint.checkpointSha256,
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

export class CheckpointStore {
    readonly root: string;

    constructor(root: string) {
        this.root = path.resolve(root);
        if (this.root === path.parse(this.root).root) {
            throw new Error('Replay checkpoint root is invalid');
        }
    }

    async write(value: unknown): Promise<CheckpointKey> {
        const checkpoint = parseReplayCheckpoint(value);
        const key = keyOf(checkpoint);
        const bytes = bytesOf(checkpoint);
        if (Buffer.byteLength(bytes) > maxBytes) {
            throw new Error('Replay checkpoint exceeds the durable size limit');
        }
        const dir = await this.prepare(key.sourceReplaySha256);
        const target = path.join(dir, this.fileName(key.cursor));
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
                if (await this.readBytes(target) !== bytes) {
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
        return key;
    }

    async read(value: unknown): Promise<ReplayCheckpoint> {
        const key = parseKey(value);
        const dir = await this.existing(key.sourceReplaySha256);
        const file = path.join(dir, this.fileName(key.cursor));
        return this.readFile(file, key.sourceReplaySha256, key.cursor, key.checkpointSha256);
    }

    private async readFile(
        file: string,
        sourceSha: string,
        cursor: number,
        checkpointSha?: string
    ): Promise<ReplayCheckpoint> {
        const bytes = await this.readBytes(file);
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
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (tempPattern.test(entry.name)) {
                if (!entry.isFile()) throw new Error('Replay checkpoint directory entry is invalid');
                continue;
            }
            const match = filePattern.exec(entry.name);
            const cursor = match === null ? NaN : Number(match[1]);
            if (!entry.isFile()
                || match === null
                || !Number.isSafeInteger(cursor)
                || cursor.toString().padStart(16, '0') !== match[1]) {
                throw new Error('Replay checkpoint directory entry is invalid');
            }
            if (cursor > (cursorValue as number) || cursor < best) continue;
            best = cursor;
        }
        if (best === -1) return null;
        return this.readFile(path.join(dir, this.fileName(best)), sourceValue, best);
    }

    private async prepare(sourceSha: string): Promise<string> {
        await createDir(this.root, path.dirname(this.root), 'root');
        const source = path.join(this.root, sourceSha);
        await createDir(source, this.root, 'source path');
        const dir = path.join(source, replayCheckpointContract);
        await createDir(dir, source, 'contract path');
        return dir;
    }

    private async existing(sourceSha: string): Promise<string> {
        await requireDir(this.root, 'root');
        const source = path.join(this.root, sourceSha);
        await requireDir(source, 'source path');
        const dir = path.join(source, replayCheckpointContract);
        await requireDir(dir, 'contract path');
        return dir;
    }

    private fileName(cursor: number): string {
        return `${cursor.toString().padStart(16, '0')}.json`;
    }

    private async readBytes(file: string): Promise<string> {
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
    }
}
