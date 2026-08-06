import { link, readFile, readdir, unlink } from 'node:fs/promises';

const path = process.env.CUSTODY_PROOF_PATH;
const verifiedPath = process.env.CUSTODY_VERIFIED_PATH;
if (!path || !verifiedPath) {
    await Promise.allSettled([path, verifiedPath].filter(Boolean).map((file) => unlink(file)));
    throw new Error('CUSTODY_PROOF_PATH and CUSTODY_VERIFIED_PATH are required');
}

const versions = (await readdir(new URL('../db/core/migrations/', import.meta.url)))
    .map((name) => /^V([0-9]+(?:_[0-9]+)*)__/.exec(name)?.[1])
    .filter(Boolean)
    .sort((left, right) => {
        const leftParts = left.split('_').map(BigInt);
        const rightParts = right.split('_').map(BigInt);
        for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
            const delta = (leftParts[index] ?? 0n) - (rightParts[index] ?? 0n);
            if (delta !== 0n) return delta < 0n ? -1 : 1;
        }
        return 0;
    });
let promoted = false;
try {
    const proof = JSON.parse(await readFile(path, 'utf8'));
    const expected = {
        version: 1,
        baseVersion: '003',
        currentVersion: versions.at(-1)?.replaceAll('_', '.'),
        crossSlotReplay: true,
        corruptCases: 2,
    };
    if (JSON.stringify(proof) !== JSON.stringify(expected)) {
        throw new Error('Custody upgrade proof is incomplete');
    }
    await link(path, verifiedPath);
    await unlink(path);
    promoted = true;
} finally {
    if (!promoted) {
        await Promise.allSettled([unlink(path), unlink(verifiedPath)]);
    }
}

console.log('custody upgrade proof verified');
