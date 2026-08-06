import { createHash } from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import { SolanaLookupResolver, SolanaLookupUnavailable } from '../src/services/solanaLookup';
import {
    parseSolanaTransaction,
    resolveSolanaTransaction,
    transactionSignature,
    validatePreparedTransaction,
    validateSignedTransaction,
    verifySolanaSignature,
    verifySolanaSigner,
} from '../src/services/solanaTransaction';

const vec = (value: number): Buffer => {
    const bytes: number[] = [];
    let remaining = value;
    do {
        const byte = remaining & 0x7f;
        remaining >>= 7;
        bytes.push(remaining ? byte | 0x80 : byte);
    } while (remaining);
    return Buffer.from(bytes);
};

const wireTransaction = (message: Buffer, signature?: Uint8Array): string => Buffer.concat([
    vec(1),
    signature ? Buffer.from(signature) : Buffer.alloc(64),
    message,
]).toString('base64');

const multiSignerTransaction = (message: Buffer, signatures: Uint8Array[]): string => Buffer.concat([
    vec(signatures.length),
    ...signatures.map((signature) => Buffer.from(signature)),
    message,
]).toString('base64');

const legacyMessage = (signer: Uint8Array, blockhashByte = 7): Buffer => Buffer.concat([
    Buffer.from([1, 0, 1]),
    vec(2),
    Buffer.from(signer),
    Buffer.alloc(32),
    Buffer.alloc(32, blockhashByte),
    vec(0),
]);

const versionedMessage = (signer: Uint8Array): Buffer => Buffer.concat([
    Buffer.from([0x80, 1, 0, 1]),
    vec(2),
    Buffer.from(signer),
    Buffer.alloc(32),
    Buffer.alloc(32, 9),
    vec(0),
    vec(0),
]);

const twoSignerMessage = (feePayer: Uint8Array, walletSigner: Uint8Array): Buffer => Buffer.concat([
    Buffer.from([2, 0, 1]),
    vec(3),
    Buffer.from(feePayer),
    Buffer.from(walletSigner),
    Buffer.alloc(32),
    Buffer.alloc(32, 11),
    vec(0),
]);

const threeSignerMessage = (
    feePayer: Uint8Array,
    walletSigner: Uint8Array,
    providerSigner: Uint8Array
): Buffer => Buffer.concat([
    Buffer.from([3, 0, 1]),
    vec(4),
    Buffer.from(feePayer),
    Buffer.from(walletSigner),
    Buffer.from(providerSigner),
    Buffer.alloc(32),
    Buffer.alloc(32, 12),
    vec(0),
]);

const threeSignerV0Message = (
    feePayer: Uint8Array,
    walletSigner: Uint8Array,
    providerSigner: Uint8Array
): Buffer => Buffer.concat([
    Buffer.from([0x80, 3, 0, 1]),
    vec(4),
    Buffer.from(feePayer),
    Buffer.from(walletSigner),
    Buffer.from(providerSigner),
    Buffer.alloc(32),
    Buffer.alloc(32, 16),
    vec(0),
    vec(0),
]);

const duplicateSignerMessage = (signer: Uint8Array): Buffer => Buffer.concat([
    Buffer.from([2, 0, 1]),
    vec(3),
    Buffer.from(signer),
    Buffer.from(signer),
    Buffer.alloc(32),
    Buffer.alloc(32, 13),
    vec(0),
]);

const privilegeMessage = (payer: Uint8Array, signer: Uint8Array): Buffer => Buffer.concat([
    Buffer.from([2, 1, 1]),
    vec(4),
    Buffer.from(payer),
    Buffer.from(signer),
    Buffer.alloc(32, 2),
    Buffer.alloc(32, 3),
    Buffer.alloc(32, 18),
    vec(0),
]);

const staticMessage = (signer: Uint8Array, count: number, versioned: boolean): Buffer => {
    const keys = [Buffer.from(signer)];
    for (let index = 1; index < count; index += 1) {
        const key = Buffer.alloc(32);
        key.writeUInt32LE(index);
        keys.push(key);
    }
    return Buffer.concat([
        ...(versioned ? [Buffer.from([0x80])] : []),
        Buffer.from([1, 0, Math.min(count - 1, 255)]),
        vec(count),
        ...keys,
        Buffer.alloc(32, 19),
        vec(0),
        ...(versioned ? [vec(0)] : []),
    ]);
};

const instructionMessage = (
    signer: Uint8Array,
    program = 1,
    account = 0
): Buffer => Buffer.concat([
    Buffer.from([1, 0, 1]),
    vec(2),
    Buffer.from(signer),
    Buffer.alloc(32, 3),
    Buffer.alloc(32, 14),
    vec(1),
    Buffer.from([program]),
    vec(1),
    Buffer.from([account]),
    vec(0),
]);

const lookupMessage = (
    signer: Uint8Array,
    program = 1,
    account = 2,
    lookupIndexes = Buffer.from([0])
): Buffer => Buffer.concat([
    Buffer.from([0x80, 1, 0, 1]),
    vec(2),
    Buffer.from(signer),
    Buffer.alloc(32, 3),
    Buffer.alloc(32, 15),
    vec(1),
    Buffer.from([program]),
    vec(1),
    Buffer.from([account]),
    vec(0),
    vec(1),
    Buffer.alloc(32, 4),
    vec(lookupIndexes.length),
    lookupIndexes,
    vec(0),
]);

const resolvedLookupMessage = (signer: Uint8Array): Buffer => Buffer.concat([
    Buffer.from([0x80, 1, 0, 1]),
    vec(2),
    Buffer.from(signer),
    Buffer.alloc(32, 3),
    Buffer.alloc(32, 17),
    vec(1),
    Buffer.from([1]),
    vec(3),
    Buffer.from([0, 2, 3]),
    vec(2),
    Buffer.from([7, 8]),
    vec(1),
    Buffer.alloc(32, 4),
    vec(1),
    Buffer.from([1]),
    vec(1),
    Buffer.from([0]),
]);

const lookupData = (
    addresses: Buffer[],
    lastExtendedSlot: bigint,
    startIndex: number,
    deactivationSlot = BigInt('0xffffffffffffffff')
): Buffer => {
    const data = Buffer.alloc(56 + addresses.length * 32);
    data.writeUInt32LE(1, 0);
    data.writeBigUInt64LE(deactivationSlot, 4);
    data.writeBigUInt64LE(lastExtendedSlot, 12);
    data[20] = startIndex;
    addresses.forEach((address, index) => address.copy(data, 56 + index * 32));
    return data;
};

const rpcTable = (data: Buffer, owner = 'AddressLookupTab1e1111111111111111111111111') => ({
    data: [data.toString('base64'), 'base64'],
    executable: false,
    lamports: 1,
    owner,
    rentEpoch: 0,
    space: data.length,
});

const rpcProgram = (data: Buffer, owner: string, executable: boolean) => ({
    ...rpcTable(data, owner),
    executable,
});

const tokenData = (
    mint: Buffer,
    owner: Buffer,
    amount = 0n,
    delegate?: Buffer,
    delegatedAmount = 0n
): Buffer => {
    const data = Buffer.alloc(165);
    mint.copy(data, 0);
    owner.copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    if (delegate) {
        data.writeUInt32LE(1, 72);
        delegate.copy(data, 76);
    }
    data[108] = 1;
    data.writeBigUInt64LE(delegatedAmount, 121);
    return data;
};

describe('Solana transaction verification', () => {
    it('parses legacy and v0 messages and identifies the required signer', () => {
        const keypair = nacl.sign.keyPair();
        const signer = bs58.encode(keypair.publicKey);
        for (const [message, blockhashByte] of [
            [legacyMessage(keypair.publicKey), 7],
            [versionedMessage(keypair.publicKey), 9],
        ] as const) {
            const parsed = parseSolanaTransaction(wireTransaction(message), 2048);
            expect(parsed.version).toBe(message[0] === 0x80 ? 0 : 'legacy');
            expect(parsed.feePayer).toBe(signer);
            expect(parsed.recentBlockhash).toBe(bs58.encode(Buffer.alloc(32, blockhashByte)));
            expect(parsed.requiredSigners).toEqual([signer]);
            validatePreparedTransaction(parsed, signer, signer);
        }
    });

    it('accepts only a valid signature over the exact prepared message', () => {
        const keypair = nacl.sign.keyPair();
        const signer = bs58.encode(keypair.publicKey);
        const message = legacyMessage(keypair.publicKey);
        const prepared = parseSolanaTransaction(wireTransaction(message), 2048);
        const signed = parseSolanaTransaction(
            wireTransaction(message, nacl.sign.detached(message, keypair.secretKey)),
            2048
        );

        expect(verifySolanaSigner(signed, signer)).toBe(true);
        expect(transactionSignature(signed)).toBe(bs58.encode(signed.signatures[0]));
        expect(transactionSignature(prepared)).toBeUndefined();
        expect(() => validateSignedTransaction(prepared, signed, signer)).not.toThrow();

        const changedMessage = legacyMessage(keypair.publicKey, 8);
        const changed = parseSolanaTransaction(
            wireTransaction(changedMessage, nacl.sign.detached(changedMessage, keypair.secretKey)),
            2048
        );
        expect(() => validateSignedTransaction(prepared, changed, signer)).toThrow(/differs/);
    });

    it('rejects missing, malformed, and forged signatures', () => {
        const keypair = nacl.sign.keyPair();
        const attacker = nacl.sign.keyPair();
        const signer = bs58.encode(keypair.publicKey);
        const message = legacyMessage(keypair.publicKey);
        const prepared = parseSolanaTransaction(wireTransaction(message), 2048);
        const forged = parseSolanaTransaction(
            wireTransaction(message, nacl.sign.detached(message, attacker.secretKey)),
            2048
        );

        expect(verifySolanaSigner(prepared, signer)).toBe(false);
        expect(() => validateSignedTransaction(prepared, forged, signer)).toThrow(/valid wallet signature/);
        expect(() => parseSolanaTransaction('not-canonical!', 2048)).toThrow(/base64/);
        expect(() => parseSolanaTransaction(wireTransaction(message), 32)).toThrow(/size/);
    });

    it('never derives a transaction ID from an unverified fee-payer slot', () => {
        const feePayer = nacl.sign.keyPair();
        const walletSigner = nacl.sign.keyPair();
        const attacker = nacl.sign.keyPair();
        const message = twoSignerMessage(feePayer.publicKey, walletSigner.publicKey);
        const forged = parseSolanaTransaction(multiSignerTransaction(message, [
            nacl.sign.detached(message, attacker.secretKey),
            nacl.sign.detached(message, walletSigner.secretKey),
        ]), 2048);

        expect(verifySolanaSigner(forged, bs58.encode(walletSigner.publicKey))).toBe(true);
        expect(verifySolanaSigner(forged, bs58.encode(feePayer.publicKey))).toBe(false);
        expect(transactionSignature(forged)).toBeUndefined();
        const prepared = parseSolanaTransaction(multiSignerTransaction(message, [
            Buffer.alloc(64),
            Buffer.alloc(64),
        ]), 2048);
        expect(() => validateSignedTransaction(
            prepared,
            forged,
            bs58.encode(walletSigner.publicKey)
        )).toThrow(/valid fee payer signature/);

        const partial = parseSolanaTransaction(multiSignerTransaction(message, [
            Buffer.alloc(64),
            nacl.sign.detached(message, walletSigner.secretKey),
        ]), 2048);
        expect(transactionSignature(partial)).toBeUndefined();
        const providerSignature = bs58.encode(nacl.sign.detached(message, feePayer.secretKey));
        expect(verifySolanaSignature(
            partial,
            bs58.encode(feePayer.publicKey),
            providerSignature
        )).toBe(true);
        expect(verifySolanaSignature(
            partial,
            bs58.encode(feePayer.publicKey),
            bs58.encode(nacl.sign.detached(message, attacker.secretKey))
        )).toBe(false);
        expect(verifySolanaSignature(
            partial,
            bs58.encode(feePayer.publicKey),
            'not-a-signature'
        )).toBe(false);
        expect(() => validateSignedTransaction(
            prepared,
            partial,
            bs58.encode(walletSigner.publicKey),
            new Set([bs58.encode(feePayer.publicKey)])
        )).not.toThrow();
        expect(() => validateSignedTransaction(
            prepared,
            forged,
            bs58.encode(walletSigner.publicKey),
            new Set([bs58.encode(feePayer.publicKey)])
        )).toThrow(/valid fee payer signature/);

        const authentic = parseSolanaTransaction(multiSignerTransaction(message, [
            nacl.sign.detached(message, feePayer.secretKey),
            nacl.sign.detached(message, walletSigner.secretKey),
        ]), 2048);
        expect(transactionSignature(authentic)).toBe(bs58.encode(authentic.signatures[0]));
        expect(() => validateSignedTransaction(
            prepared,
            authentic,
            bs58.encode(walletSigner.publicKey)
        )).not.toThrow();
    });

    it('requires every provider and wallet signature in a multi-signer transaction', () => {
        const feePayer = nacl.sign.keyPair();
        const walletSigner = nacl.sign.keyPair();
        const providerSigner = nacl.sign.keyPair();
        const attacker = nacl.sign.keyPair();
        const message = threeSignerMessage(
            feePayer.publicKey,
            walletSigner.publicKey,
            providerSigner.publicKey
        );
        const prepared = parseSolanaTransaction(multiSignerTransaction(message, [
            Buffer.alloc(64),
            Buffer.alloc(64),
            Buffer.alloc(64),
        ]), 2048);
        const valid = [
            nacl.sign.detached(message, feePayer.secretKey),
            nacl.sign.detached(message, walletSigner.secretKey),
            nacl.sign.detached(message, providerSigner.secretKey),
        ];

        for (const third of [Buffer.alloc(64), nacl.sign.detached(message, attacker.secretKey)]) {
            const incomplete = parseSolanaTransaction(multiSignerTransaction(message, [
                valid[0],
                valid[1],
                third,
            ]), 2048);
            expect(() => validateSignedTransaction(
                prepared,
                incomplete,
                bs58.encode(walletSigner.publicKey)
            )).toThrow(/every required signer/);
        }

        const signed = parseSolanaTransaction(multiSignerTransaction(message, valid), 2048);
        expect(() => validateSignedTransaction(
            prepared,
            signed,
            bs58.encode(walletSigner.publicKey)
        )).not.toThrow();

        const v0Message = threeSignerV0Message(
            feePayer.publicKey,
            walletSigner.publicKey,
            providerSigner.publicKey
        );
        const v0Prepared = parseSolanaTransaction(multiSignerTransaction(v0Message, [
            Buffer.alloc(64), Buffer.alloc(64), Buffer.alloc(64),
        ]), 2048);
        const v0Incomplete = parseSolanaTransaction(multiSignerTransaction(v0Message, [
            nacl.sign.detached(v0Message, feePayer.secretKey),
            nacl.sign.detached(v0Message, walletSigner.secretKey),
            Buffer.alloc(64),
        ]), 2048);
        expect(() => validateSignedTransaction(
            v0Prepared,
            v0Incomplete,
            bs58.encode(walletSigner.publicKey)
        )).toThrow(/every required signer/);
        const v0Signed = parseSolanaTransaction(multiSignerTransaction(v0Message, [
            nacl.sign.detached(v0Message, feePayer.secretKey),
            nacl.sign.detached(v0Message, walletSigner.secretKey),
            nacl.sign.detached(v0Message, providerSigner.secretKey),
        ]), 2048);
        expect(() => validateSignedTransaction(
            v0Prepared,
            v0Signed,
            bs58.encode(walletSigner.publicKey)
        )).not.toThrow();
    });

    it('rejects duplicate static account keys before signer verification', () => {
        const signer = nacl.sign.keyPair();
        const message = duplicateSignerMessage(signer.publicKey);
        const signed = multiSignerTransaction(message, [
            nacl.sign.detached(message, signer.secretKey),
            Buffer.alloc(64),
        ]);

        expect(() => parseSolanaTransaction(signed, 2048)).toThrow(/duplicates/);
    });

    it('derives the four static signer and writable privilege classes', () => {
        const payer = nacl.sign.keyPair();
        const signer = nacl.sign.keyPair();
        const transaction = parseSolanaTransaction(
            multiSignerTransaction(privilegeMessage(payer.publicKey, signer.publicKey), [
                Buffer.alloc(64), Buffer.alloc(64),
            ]), 2048
        );

        expect(resolveSolanaTransaction(transaction, new Map()).accounts
            .map(({ signer: required, writable }) => ({
            signer: required, writable,
        }))).toEqual([
            { signer: true, writable: true },
            { signer: true, writable: false },
            { signer: false, writable: true },
            { signer: false, writable: false },
        ]);
    });

    it('sanitizes compiled instruction indexes for legacy and v0 messages', () => {
        const signer = nacl.sign.keyPair();
        expect(() => parseSolanaTransaction(
            wireTransaction(instructionMessage(signer.publicKey)), 2048
        )).not.toThrow();
        expect(() => parseSolanaTransaction(
            wireTransaction(lookupMessage(signer.publicKey)), 2048
        )).not.toThrow();
        expect(() => parseSolanaTransaction(
            wireTransaction(instructionMessage(signer.publicKey, 0)), 2048
        )).toThrow(/program index/);
        expect(() => parseSolanaTransaction(
            wireTransaction(instructionMessage(signer.publicKey, 1, 2)), 2048
        )).toThrow(/account index/);
        expect(() => parseSolanaTransaction(
            wireTransaction(lookupMessage(signer.publicKey, 2)), 2048
        )).toThrow(/program index/);
        expect(() => parseSolanaTransaction(
            wireTransaction(lookupMessage(signer.publicKey, 1, 3)), 2048
        )).toThrow(/account index/);
    });

    it('resolves lookup accounts in runtime order and fails closed on invalid tables', () => {
        const signer = nacl.sign.keyPair();
        const transaction = parseSolanaTransaction(
            wireTransaction(resolvedLookupMessage(signer.publicKey)), 2048
        );
        const table = bs58.encode(Buffer.alloc(32, 4));
        const first = bs58.encode(Buffer.alloc(32, 5));
        const second = bs58.encode(Buffer.alloc(32, 6));
        const resolved = resolveSolanaTransaction(transaction, new Map([
            [table, [first, second]],
        ]));

        expect(resolved.accounts.map(({ address, signer: required, writable }) => ({
            address, signer: required, writable,
        }))).toEqual([
            { address: bs58.encode(signer.publicKey), signer: true, writable: true },
            { address: bs58.encode(Buffer.alloc(32, 3)), signer: false, writable: false },
            { address: second, signer: false, writable: true },
            { address: first, signer: false, writable: false },
        ]);
        expect(resolved.instructions).toMatchObject([{
            programId: bs58.encode(Buffer.alloc(32, 3)),
            accounts: [
                { index: 0, address: bs58.encode(signer.publicKey), signer: true, writable: true },
                { index: 2, address: second, signer: false, writable: true,
                    lookup: { table, index: 1 } },
                { index: 3, address: first, signer: false, writable: false,
                    lookup: { table, index: 0 } },
            ],
            data: Buffer.from([7, 8]),
        }]);
        expect(() => resolveSolanaTransaction(transaction, new Map()))
            .toThrow(/is unresolved/);
        expect(() => resolveSolanaTransaction(transaction, new Map([[table, [first]]])))
            .toThrow(/\[1\] is invalid/);
        expect(() => resolveSolanaTransaction(transaction, new Map([
            [table, [first, bs58.encode(signer.publicKey)]],
        ]))).toThrow(/contain duplicates/);

        const message = Buffer.from(transaction.message);
        (transaction as any).compiledIxs = [{ programIndex: 0, accountIndexes: [], data: Buffer.alloc(0) }];
        resolved.instructions[0].data[0] = 99;
        expect(transaction.message).toEqual(message);
        expect(resolveSolanaTransaction(transaction, new Map([
            [table, [first, second]],
        ])).instructions[0]).toMatchObject({
            programId: bs58.encode(Buffer.alloc(32, 3)),
            data: Buffer.from([7, 8]),
        });
    });

    it('rejects unsupported versions, malformed lookups, and ambiguous encodings', () => {
        const signer = nacl.sign.keyPair();
        const unsupported = versionedMessage(signer.publicKey);
        unsupported[0] = 0x81;
        expect(() => parseSolanaTransaction(wireTransaction(unsupported), 2048))
            .toThrow(/version is unsupported/);

        const emptyLookup = lookupMessage(signer.publicKey, 1, 0, Buffer.alloc(0));
        expect(() => parseSolanaTransaction(wireTransaction(emptyLookup), 2048))
            .toThrow(/lookup is empty/);

        const trailing = Buffer.concat([legacyMessage(signer.publicKey), Buffer.from([0])]);
        expect(() => parseSolanaTransaction(wireTransaction(trailing), 2048))
            .toThrow(/trailing bytes/);

        const readonlyPayer = legacyMessage(signer.publicKey);
        readonlyPayer[1] = 1;
        expect(() => parseSolanaTransaction(wireTransaction(readonlyPayer), 2048))
            .toThrow(/header is invalid/);

        const canonical = Buffer.from(wireTransaction(legacyMessage(signer.publicKey)), 'base64');
        const noncanonical = Buffer.concat([Buffer.from([0x81, 0]), canonical.subarray(1)]);
        expect(() => parseSolanaTransaction(noncanonical.toString('base64'), 2048))
            .toThrow(/not canonical/);
    });

    it('accepts at most 256 total account keys for legacy and v0 messages', () => {
        const signer = nacl.sign.keyPair();
        for (const versioned of [false, true]) {
            expect(() => parseSolanaTransaction(
                wireTransaction(staticMessage(signer.publicKey, 256, versioned)), 10000
            )).not.toThrow();
            expect(() => parseSolanaTransaction(
                wireTransaction(staticMessage(signer.publicKey, 257, versioned)), 10000
            )).toThrow(/account indexes exceed u8/);
        }
    });

    it('loads and validates every address lookup table through one bounded RPC read', async () => {
        const signer = nacl.sign.keyPair();
        const transaction = parseSolanaTransaction(
            wireTransaction(resolvedLookupMessage(signer.publicKey)), 2048
        );
        const table = bs58.encode(Buffer.alloc(32, 4));
        const first = Buffer.alloc(32, 5);
        const second = Buffer.alloc(32, 6);
        const data = lookupData([first, second], 9n, 0);
        const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
            const request = JSON.parse(String(init?.body));
            expect(request).toMatchObject({
                method: 'getMultipleAccounts',
                params: [[table], { encoding: 'base64', commitment: 'finalized' }],
            });
            return new Response(JSON.stringify({
                jsonrpc: '2.0', id: 1,
                result: { context: { slot: 10 }, value: [rpcTable(data)] },
            }));
        });
        const resolver = new SolanaLookupResolver('https://rpc.example', 100, fetcher as typeof fetch);
        const resolved = await resolver.resolve(transaction);

        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(resolved.contextSlot).toBe(10);
        expect(resolved.instructions[0]).toMatchObject({
            programId: bs58.encode(Buffer.alloc(32, 3)),
            accounts: [
                { address: bs58.encode(signer.publicKey), signer: true, writable: true },
                { address: bs58.encode(second), signer: false, writable: true },
                { address: bs58.encode(first), signer: false, writable: false },
            ],
        });

        const offline = vi.fn(async () => { throw new Error('unexpected lookup read'); });
        const legacy = parseSolanaTransaction(wireTransaction(legacyMessage(signer.publicKey)), 2048);
        await expect(new SolanaLookupResolver(
            'https://rpc.example', 100, offline as typeof fetch
        ).resolve(legacy)).resolves.toMatchObject({ instructions: [] });
        expect(offline).not.toHaveBeenCalled();
    });

    it('loads initialized legacy token-account identity at finalized commitment', async () => {
        const address = bs58.encode(Buffer.alloc(32, 31));
        const mint = Buffer.alloc(32, 29);
        const owner = Buffer.alloc(32, 30);
        const delegate = Buffer.alloc(32, 28);
        const data = tokenData(mint, owner, 42n, delegate, 40n);
        const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
            expect(JSON.parse(String(init?.body))).toMatchObject({
                method: 'getMultipleAccounts',
                params: [[address], {
                    encoding: 'base64', commitment: 'finalized', minContextSlot: 19,
                }],
            });
            return Response.json({
                jsonrpc: '2.0', id: 1,
                result: {
                    context: { slot: 20 },
                    value: [rpcTable(data, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')],
                },
            });
        });
        const resolver = new SolanaLookupResolver(
            'https://rpc.example', 100, fetcher as typeof fetch
        );

        await expect(resolver.tokenAccounts([address], 19)).resolves.toEqual(new Map([[
            address,
            {
                mint: bs58.encode(mint),
                owner: bs58.encode(owner),
                amount: 42n,
                delegate: bs58.encode(delegate),
                delegatedAmount: 40n,
            },
        ]]));
        expect(fetcher).toHaveBeenCalledOnce();

        const stale = new SolanaLookupResolver('https://rpc.example', 100, vi.fn(async () =>
            Response.json({
                jsonrpc: '2.0', id: 1,
                result: {
                    context: { slot: 18 },
                    value: [rpcTable(data, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')],
                },
            })) as typeof fetch);
        await expect(stale.tokenAccounts([address], 19))
            .rejects.toBeInstanceOf(SolanaLookupUnavailable);

        const invalid = new SolanaLookupResolver('https://rpc.example', 100, vi.fn(async () =>
            Response.json({
                jsonrpc: '2.0', id: 1,
                result: { context: { slot: 20 }, value: [rpcTable(data)] },
            })) as typeof fetch);
        const error = await invalid.tokenAccounts([address]).catch((value: unknown) => value);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(SolanaLookupUnavailable);
    });

    it('loads executable code identity and immutable upgrade metadata in one deadline', async () => {
        const native = bs58.encode(Buffer.alloc(32, 41));
        const upgradeable = bs58.encode(Buffer.alloc(32, 42));
        const dataAddress = bs58.encode(Buffer.alloc(32, 43));
        const nativeData = Buffer.from('native-program');
        const programData = Buffer.alloc(36);
        programData.writeUInt32LE(2);
        Buffer.alloc(32, 43).copy(programData, 4);
        const deployedData = Buffer.alloc(14);
        deployedData.writeUInt32LE(3);
        deployedData.writeBigUInt64LE(18n, 4);
        deployedData[12] = 0;
        deployedData[13] = 7;
        const upgradeLoader = 'BPFLoaderUpgradeab1e11111111111111111111111';
        const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
            const request = JSON.parse(String(init?.body));
            if (fetcher.mock.calls.length === 1) {
                expect(request.params).toEqual([[native, upgradeable], {
                    encoding: 'base64', commitment: 'finalized', minContextSlot: 19,
                }]);
                return Response.json({
                    jsonrpc: '2.0', id: 1,
                    result: { context: { slot: 20 }, value: [
                        rpcProgram(nativeData, 'NativeLoader1111111111111111111111111111111', true),
                        rpcProgram(programData, upgradeLoader, true),
                    ] },
                });
            }
            expect(request.params).toEqual([[dataAddress], {
                encoding: 'base64', commitment: 'finalized', minContextSlot: 20,
            }]);
            return Response.json({
                jsonrpc: '2.0', id: 1,
                result: { context: { slot: 21 }, value: [
                    rpcProgram(deployedData, upgradeLoader, false),
                ] },
            });
        });
        const resolver = new SolanaLookupResolver(
            'https://rpc.example', 100, fetcher as typeof fetch
        );

        await expect(resolver.programAccounts([native, upgradeable], 19)).resolves.toEqual(new Map([
            [native, {
                owner: 'NativeLoader1111111111111111111111111111111',
                executable: true,
                dataHash: createHash('sha256').update(nativeData).digest('hex'),
            }],
            [upgradeable, {
                owner: upgradeLoader,
                executable: true,
                dataHash: createHash('sha256').update(programData).digest('hex'),
                programData: {
                    address: dataAddress,
                    owner: upgradeLoader,
                    executable: false,
                    authority: null,
                    dataHash: createHash('sha256').update(deployedData).digest('hex'),
                },
            }],
        ]));
        expect(fetcher).toHaveBeenCalledTimes(2);

        const inactive = new SolanaLookupResolver('https://rpc.example', 100, vi.fn(async () =>
            Response.json({
                jsonrpc: '2.0', id: 1,
                result: { context: { slot: 20 }, value: [
                    rpcProgram(nativeData, 'NativeLoader1111111111111111111111111111111', false),
                ] },
            })) as typeof fetch);
        await expect(inactive.programAccounts([native])).rejects.toThrow(/invalid program account/);
    });

    it('rejects stale, inactive, wrongly owned, and timed-out lookup reads', async () => {
        const signer = nacl.sign.keyPair();
        const transaction = parseSolanaTransaction(
            wireTransaction(resolvedLookupMessage(signer.publicKey)), 2048
        );
        const first = Buffer.alloc(32, 5);
        const second = Buffer.alloc(32, 6);
        const response = (account: unknown, slot = 10): typeof fetch => vi.fn(async () =>
            new Response(JSON.stringify({
                jsonrpc: '2.0', id: 1,
                result: { context: { slot }, value: [account] },
            }))) as typeof fetch;

        await expect(new SolanaLookupResolver('https://rpc.example', 100, response(
            rpcTable(lookupData([first, second], 10n, 1))
        )).resolve(transaction)).rejects.toThrow(/\[1\] is invalid/);
        const wrongOwner = await new SolanaLookupResolver('https://rpc.example', 100, response(
            rpcTable(lookupData([first, second], 9n, 0), bs58.encode(Buffer.alloc(32, 7)))
        )).resolve(transaction).catch((error: unknown) => error);
        expect(wrongOwner).toBeInstanceOf(Error);
        expect(wrongOwner).not.toBeInstanceOf(SolanaLookupUnavailable);
        expect((wrongOwner as Error).message).toMatch(/invalid lookup table/);
        await expect(new SolanaLookupResolver('https://rpc.example', 100, response(
            rpcTable(lookupData([first, second], 9n, 0, 10n))
        )).resolve(transaction)).rejects.toThrow(/inactive lookup table/);
        const malformed = lookupData([first, second], 9n, 0);
        malformed.writeUInt32LE(0, 0);
        await expect(new SolanaLookupResolver(
            'https://rpc.example', 100, response(rpcTable(malformed))
        ).resolve(transaction)).rejects.toThrow(/invalid lookup table/);

        const stalled: typeof fetch = () => new Promise(() => undefined);
        const timedOut = await new SolanaLookupResolver(
            'https://rpc.example', 5, stalled
        ).resolve(transaction).catch((error: unknown) => error);
        expect(timedOut).toBeInstanceOf(SolanaLookupUnavailable);
        expect((timedOut as Error).message).toMatch(/timed out/);
    });
});
