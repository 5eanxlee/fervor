import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
    parseReplayCheckpoint,
    type ReplayCheckpoint,
} from './projection';

const maxBytes = 32 * 1024 * 1024;
const hashPattern = /^[0-9a-f]{64}$/;

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
        const target = path.join(dir, this.fileName(key));
        const temporary = path.join(dir, `.${process.pid}.${randomUUID()}.tmp`);
        try {
            const handle = await open(temporary, 'wx', 0o600);
            try {
                await handle.writeFile(bytes);
                await handle.sync();
            } finally {
                await handle.close();
            }
            await link(temporary, target);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (await this.readBytes(target) !== bytes) {
                throw new Error('Stored replay checkpoint collides with different bytes');
            }
        } finally {
            await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error;
            });
        }
        await syncDir(dir);
        return key;
    }

    async read(value: unknown): Promise<ReplayCheckpoint> {
        const key = parseKey(value);
        const file = path.join(this.root, key.sourceReplaySha256, this.fileName(key));
        const bytes = await this.readBytes(file);
        let checkpoint: ReplayCheckpoint;
        try {
            checkpoint = parseReplayCheckpoint(JSON.parse(bytes));
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Stored replay checkpoint is invalid: ${detail}`);
        }
        const storedKey = keyOf(checkpoint);
        if (storedKey.sourceReplaySha256 !== key.sourceReplaySha256
            || storedKey.cursor !== key.cursor
            || storedKey.checkpointSha256 !== key.checkpointSha256
            || bytesOf(checkpoint) !== bytes) {
            throw new Error('Stored replay checkpoint differs from its key or canonical bytes');
        }
        return checkpoint;
    }

    private async prepare(sourceSha: string): Promise<string> {
        try {
            await mkdir(this.root, { mode: 0o700 });
            await syncDir(path.dirname(this.root));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const rootInfo = await lstat(this.root);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
            throw new Error('Replay checkpoint root is not a regular directory');
        }
        const dir = path.join(this.root, sourceSha);
        try {
            await mkdir(dir, { mode: 0o700 });
            await syncDir(this.root);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const info = await lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error('Replay checkpoint source path is not a regular directory');
        }
        return dir;
    }

    private fileName(key: CheckpointKey): string {
        return `${key.cursor.toString().padStart(16, '0')}-${key.checkpointSha256}.json`;
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
