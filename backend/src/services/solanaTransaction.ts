import crypto from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

export type SolanaMessageVer = 'legacy' | 0;

export interface SolanaAccount {
    index: number;
    address: string;
    signer: boolean;
    writable: boolean;
    lookup?: {
        table: string;
        index: number;
    };
}

export interface SolanaIx {
    programId: string;
    accounts: SolanaAccount[];
    data: Buffer;
}

export interface SolanaLookup {
    table: string;
    writable: number[];
    readonly: number[];
}

export interface ResolvedSolana {
    accounts: SolanaAccount[];
    instructions: SolanaIx[];
    contextSlot?: number;
}

export interface SolanaTransaction {
    bytes: Buffer;
    message: Buffer;
    version: SolanaMessageVer;
    rawDigest: string;
    messageDigest: string;
    feePayer: string;
    recentBlockhash: string;
    requiredSigners: string[];
    signatures: Buffer[];
}

interface ShortVec {
    value: number;
    next: number;
}

interface CompiledIx {
    programIndex: number;
    accountIndexes: number[];
    data: Buffer;
}

interface ParsedMessage {
    version: SolanaMessageVer;
    feePayer: string;
    recentBlockhash: string;
    requiredSigners: string[];
    staticAccounts: SolanaAccount[];
    lookups: SolanaLookup[];
    compiledIxs: CompiledIx[];
}

const digest = (value: Buffer): string => crypto.createHash('sha256').update(value).digest('hex');

const fail = (message: string): never => {
    throw new Error(message);
};

const shortVec = (bytes: Buffer, start: number): ShortVec => {
    let value = 0;
    for (let index = 0; index < 3; index += 1) {
        const cursor = start + index;
        if (cursor >= bytes.length) fail('Solana short vector is truncated');
        const byte = bytes[cursor];
        if (index === 2 && (byte & 0xfc) !== 0) {
            fail('Solana short vector exceeds u16');
        }
        value |= (byte & 0x7f) << (index * 7);
        if ((byte & 0x80) === 0) {
            if (index > 0 && byte === 0) fail('Solana short vector is not canonical');
            return { value, next: cursor + 1 };
        }
    }
    return fail('Solana short vector exceeds u16');
};

const take = (bytes: Buffer, start: number, size: number, label: string): Buffer => {
    if (!Number.isSafeInteger(size) || size < 0 || start < 0 || start + size > bytes.length) {
        fail(`Transaction ${label} is truncated`);
    }
    return bytes.subarray(start, start + size);
};

const vectorBytes = (
    bytes: Buffer,
    start: number,
    label: string
): { value: Buffer; next: number } => {
    const count = shortVec(bytes, start);
    return {
        value: take(bytes, count.next, count.value, label),
        next: count.next + count.value,
    };
};

const instructions = (
    message: Buffer,
    start: number
): { value: CompiledIx[]; next: number } => {
    const count = shortVec(message, start);
    const value: CompiledIx[] = [];
    let cursor = count.next;
    for (let index = 0; index < count.value; index += 1) {
        const program = take(message, cursor, 1, 'instruction program index')[0];
        cursor += 1;
        const accounts = vectorBytes(message, cursor, 'instruction account indexes');
        cursor = accounts.next;
        const data = vectorBytes(message, cursor, 'instruction data');
        cursor = data.next;
        value.push({
            programIndex: program,
            accountIndexes: [...accounts.value],
            data: Buffer.from(data.value),
        });
    }
    return { value, next: cursor };
};

const parseMessage = (message: Buffer): ParsedMessage => {
    if (!message.length) fail('Transaction message is missing');
    const version: SolanaMessageVer = (message[0] & 0x80) === 0 ? 'legacy' : 0;
    let cursor = 0;
    if (version === 0) {
        if (message[0] !== 0x80) fail('Transaction message version is unsupported');
        cursor = 1;
    }

    const header = take(message, cursor, 3, 'message header');
    const required = header[0];
    const readonlySigned = header[1];
    const readonlyUnsigned = header[2];
    cursor += header.length;

    const keyCount = shortVec(message, cursor);
    cursor = keyCount.next;
    if (keyCount.value === 0 || required === 0
        || required + readonlyUnsigned > keyCount.value
        || readonlySigned >= required) {
        fail('Transaction account header is invalid');
    }
    const keyBytes = take(message, cursor, keyCount.value * 32, 'static account keys');
    const keys: string[] = [];
    for (let index = 0; index < keyCount.value; index += 1) {
        keys.push(bs58.encode(keyBytes.subarray(index * 32, (index + 1) * 32)));
    }
    if (new Set(keys).size !== keys.length) {
        fail('Transaction static account keys contain duplicates');
    }
    cursor += keyBytes.length;

    const recentBlockhash = bs58.encode(take(message, cursor, 32, 'recent blockhash'));
    cursor += 32;
    const compiled = instructions(message, cursor);
    cursor = compiled.next;

    const lookups: SolanaLookup[] = [];
    let dynamicKeys = 0;
    if (version === 0) {
        const lookupCount = shortVec(message, cursor);
        cursor = lookupCount.next;
        for (let index = 0; index < lookupCount.value; index += 1) {
            const table = bs58.encode(take(message, cursor, 32, 'address lookup table key'));
            cursor += 32;
            const writable = vectorBytes(message, cursor, 'writable lookup indexes');
            cursor = writable.next;
            const readonly = vectorBytes(message, cursor, 'readonly lookup indexes');
            cursor = readonly.next;
            const loaded = writable.value.length + readonly.value.length;
            if (loaded === 0) fail('Transaction address lookup is empty');
            dynamicKeys += loaded;
            lookups.push({
                table,
                writable: [...writable.value],
                readonly: [...readonly.value],
            });
        }
    }
    if (cursor !== message.length) fail('Transaction message contains trailing bytes');

    const totalKeys = keyCount.value + dynamicKeys;
    if (totalKeys > 256) fail('Transaction account indexes exceed u8');
    for (const instruction of compiled.value) {
        if (instruction.programIndex === 0 || instruction.programIndex >= keyCount.value) {
            fail('Transaction instruction program index is invalid');
        }
        for (const account of instruction.accountIndexes) {
            if (account >= totalKeys) fail('Transaction instruction account index is invalid');
        }
    }

    const staticAccounts = keys.map((address, index): SolanaAccount => ({
        index,
        address,
        signer: index < required,
        writable: index < required
            ? index < required - readonlySigned
            : index < keyCount.value - readonlyUnsigned,
    }));

    return {
        version,
        feePayer: keys[0],
        recentBlockhash,
        requiredSigners: keys.slice(0, required),
        staticAccounts,
        lookups,
        compiledIxs: compiled.value,
    };
};

const decodeBase64 = (value: string, maxBytes: number): Buffer => {
    const normalized = value.replace(/\s/g, '');
    if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
        throw new Error('Transaction must be base64 encoded');
    }
    const bytes = Buffer.from(normalized, 'base64');
    if (!bytes.length || bytes.length > maxBytes
        || bytes.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
        bytes.fill(0);
        throw new Error('Transaction has invalid encoding or size');
    }
    return bytes;
};

const parsedMessages = new WeakMap<SolanaTransaction, ParsedMessage>();

const semanticState = (transaction: SolanaTransaction): ParsedMessage =>
    parsedMessages.get(transaction) ?? fail('Transaction semantic state is unavailable');

export const solanaLookupTables = (transaction: SolanaTransaction): string[] => [
    ...new Set(semanticState(transaction).lookups.map(({ table }) => table)),
];

const parseBytes = (bytes: Buffer, maxBytes: number): SolanaTransaction => {
    if (!bytes.length || bytes.length > maxBytes) {
        throw new Error('Transaction has invalid encoding or size');
    }
    const signatureCount = shortVec(bytes, 0);
    if (signatureCount.value === 0) fail('Transaction has no signatures');
    const signatureBytes = take(
        bytes,
        signatureCount.next,
        signatureCount.value * 64,
        'signatures'
    );
    const messageStart = signatureCount.next + signatureBytes.length;
    const message = take(bytes, messageStart, bytes.length - messageStart, 'message');
    if (!message.length) fail('Transaction message is missing');
    const parsed = parseMessage(message);
    if (parsed.requiredSigners.length !== signatureCount.value) {
        fail('Transaction signature count does not match its message');
    }
    const signatures: Buffer[] = [];
    for (let index = 0; index < signatureCount.value; index += 1) {
        signatures.push(signatureBytes.subarray(index * 64, (index + 1) * 64));
    }
    const transaction = {
        bytes,
        message,
        version: parsed.version,
        rawDigest: digest(bytes),
        messageDigest: digest(message),
        feePayer: parsed.feePayer,
        recentBlockhash: parsed.recentBlockhash,
        requiredSigners: parsed.requiredSigners,
        signatures,
    };
    parsedMessages.set(transaction, parsed);
    return transaction;
};

const validAddress = (value: string): boolean => {
    try {
        const bytes = bs58.decode(value);
        return bytes.length === 32 && bs58.encode(bytes) === value;
    } catch {
        return false;
    }
};

export const resolveSolanaTransaction = (
    transaction: SolanaTransaction,
    tables: ReadonlyMap<string, readonly string[]>
): ResolvedSolana => {
    const parsed = semanticState(transaction);
    const loaded = (writable: boolean): SolanaAccount[] => parsed.lookups.flatMap((lookup) => {
        const table = tables.get(lookup.table)
            ?? fail(`Transaction address lookup table ${lookup.table} is unresolved`);
        const indexes = writable ? lookup.writable : lookup.readonly;
        return indexes.map((index) => {
            const address = table[index];
            if (!address || !validAddress(address)) {
                fail(`Transaction address lookup ${lookup.table}[${index}] is invalid`);
            }
            return {
                index: 0,
                address,
                signer: false,
                writable,
                lookup: { table: lookup.table, index },
            };
        });
    });
    const accounts = [
        ...parsed.staticAccounts,
        ...loaded(true),
        ...loaded(false),
    ].map((account, index) => ({ ...account, index }));
    if (new Set(accounts.map(({ address }) => address)).size !== accounts.length) {
        fail('Transaction resolved account keys contain duplicates');
    }
    const instructions = parsed.compiledIxs.map((instruction): SolanaIx => ({
        programId: accounts[instruction.programIndex].address,
        accounts: instruction.accountIndexes.map((index) => accounts[index]),
        data: Buffer.from(instruction.data),
    }));
    return { accounts, instructions };
};

export const parseSolanaTransaction = (value: string, maxBytes: number): SolanaTransaction => {
    const bytes = decodeBase64(value, maxBytes);
    try {
        return parseBytes(bytes, maxBytes);
    } catch (error) {
        bytes.fill(0);
        throw error;
    }
};

export const parseSolanaTransactionBytes = (
    bytes: Buffer,
    maxBytes: number
): SolanaTransaction => parseBytes(bytes, maxBytes);

export const verifySolanaSignerAt = (
    transaction: SolanaTransaction,
    index: number
): boolean => {
    const signer = transaction.requiredSigners[index];
    if (signer === undefined) return false;
    const signature = transaction.signatures[index];
    if (!signature || signature.every((byte) => byte === 0)) return false;
    try {
        return nacl.sign.detached.verify(transaction.message, signature, bs58.decode(signer));
    } catch {
        return false;
    }
};

export const verifySolanaSigner = (transaction: SolanaTransaction, signer: string): boolean => {
    const index = transaction.requiredSigners.indexOf(signer);
    if (index < 0 || transaction.requiredSigners.lastIndexOf(signer) !== index) return false;
    return verifySolanaSignerAt(transaction, index);
};

export const verifySolanaSignature = (
    transaction: SolanaTransaction,
    signer: string,
    signature: string
): boolean => {
    const index = transaction.requiredSigners.indexOf(signer);
    if (index < 0 || transaction.requiredSigners.lastIndexOf(signer) !== index) return false;
    try {
        const bytes = bs58.decode(signature);
        return bytes.length === 64 && bs58.encode(bytes) === signature
            && nacl.sign.detached.verify(transaction.message, bytes, bs58.decode(signer));
    } catch {
        return false;
    }
};

export const transactionSignature = (transaction: SolanaTransaction): string | undefined => {
    if (!verifySolanaSigner(transaction, transaction.feePayer)) return undefined;
    const signature = transaction.signatures[0];
    if (!signature) return undefined;
    return bs58.encode(signature);
};

export const validatePreparedTransaction = (
    transaction: SolanaTransaction,
    expectedSigner: string,
    expectedFeePayer?: string
): void => {
    if (!transaction.requiredSigners.includes(expectedSigner)) {
        throw new Error('Transaction does not require the expected wallet signature');
    }
    if (expectedFeePayer && transaction.feePayer !== expectedFeePayer) {
        throw new Error('Transaction fee payer does not match the provider contract');
    }
};

export const validateSignedTransaction = (
    prepared: SolanaTransaction,
    signed: SolanaTransaction,
    expectedSigner: string,
    allowUnsigned?: ReadonlySet<string>
): void => {
    if (prepared.messageDigest !== signed.messageDigest) {
        throw new Error('Signed transaction message differs from the prepared transaction');
    }
    validatePreparedTransaction(signed, expectedSigner, prepared.feePayer);
    if (!verifySolanaSigner(signed, expectedSigner)) {
        throw new Error('Transaction does not contain a valid wallet signature');
    }
    const unsigned = (index: number): boolean => {
        const signer = signed.requiredSigners[index];
        const signature = signed.signatures[index];
        return !!signer && allowUnsigned?.has(signer) === true
            && !!signature && signature.every((byte) => byte === 0);
    };
    if (!verifySolanaSigner(signed, signed.feePayer) && !unsigned(0)) {
        throw new Error('Transaction does not contain a valid fee payer signature');
    }
    if (signed.requiredSigners.some((_, index) =>
        !verifySolanaSignerAt(signed, index) && !unsigned(index))) {
        throw new Error('Transaction does not contain valid signatures for every required signer');
    }
};
