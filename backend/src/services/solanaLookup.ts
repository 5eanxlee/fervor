import { createHash } from 'crypto';
import bs58 from 'bs58';
import { abortable, boundedSignal } from './providerCall';
import {
    ResolvedSolana,
    SolanaTransaction,
    resolveSolanaTransaction,
    solanaLookupTables,
} from './solanaTransaction';

type Row = Record<string, unknown>;
type Fetcher = typeof fetch;

const maxTables = 100;
const maxTableBytes = 56 + 256 * 32;
const tableMetaBytes = 56;
const noDeactivation = BigInt('0xffffffffffffffff');
const tableOwner = 'AddressLookupTab1e1111111111111111111111111';
const tokenOwner = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const upgradeLoader = 'BPFLoaderUpgradeab1e11111111111111111111111';
const maxProgramBytes = 2 * 1024 * 1024;

export interface SolanaTokenAccount {
    mint: string;
    owner: string;
    amount: bigint;
    delegate?: string;
    delegatedAmount: bigint;
}

export interface SolanaProgramAccount {
    owner: string;
    executable: boolean;
    dataHash: string;
    programData?: {
        address: string;
        owner: string;
        executable: boolean;
        authority: string | null;
        dataHash: string;
    };
}

export class SolanaLookupUnavailable extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SolanaLookupUnavailable';
    }
}

const row = (value: unknown): Row | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Row : null;

const integer = (value: unknown): number | null =>
    Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

const accountData = (value: unknown, min: number, max: number): Buffer => {
    if (!Array.isArray(value) || value.length !== 2
        || typeof value[0] !== 'string' || value[1] !== 'base64'
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(value[0])) {
        throw new Error('Solana RPC returned invalid account data');
    }
    const bytes = Buffer.from(value[0], 'base64');
    if (bytes.length < min || bytes.length > max
        || bytes.toString('base64') !== value[0]) {
        throw new Error('Solana RPC returned invalid account data');
    }
    return bytes;
};

const tableState = (data: Buffer) => {
    if (data.readUInt32LE(0) !== 1 || ![0, 1].includes(data[21])
        || (data.length - tableMetaBytes) % 32 !== 0) {
        throw new Error('Solana RPC returned invalid lookup table data');
    }
    const lastSlot = data.readBigUInt64LE(12);
    if (lastSlot > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Solana RPC returned invalid lookup table data');
    }
    const addresses: string[] = [];
    for (let offset = tableMetaBytes; offset < data.length; offset += 32) {
        addresses.push(bs58.encode(data.subarray(offset, offset + 32)));
    }
    return {
        deactivationSlot: data.readBigUInt64LE(4),
        lastExtendedSlot: Number(lastSlot),
        lastExtendedSlotStartIndex: data[20],
        addresses,
    };
};

const tableAddresses = (value: unknown, table: string, slot: number): string[] => {
    const account = row(value);
    if (!account || account.owner !== tableOwner || account.executable !== false) {
        throw new Error(`Solana RPC returned invalid lookup table ${table}`);
    }
    let data: Buffer;
    try {
        data = accountData(account.data, tableMetaBytes, maxTableBytes);
    } catch {
        throw new Error(`Solana RPC returned invalid lookup table ${table}`);
    }
    if (integer(account.space) !== data.length) {
        throw new Error(`Solana RPC returned invalid lookup table ${table}`);
    }
    let state: ReturnType<typeof tableState>;
    try {
        state = tableState(data);
    } catch {
        throw new Error(`Solana RPC returned invalid lookup table ${table}`);
    }
    if (state.deactivationSlot !== noDeactivation
        || !Number.isSafeInteger(state.lastExtendedSlot)
        || state.lastExtendedSlot < 0
        || state.lastExtendedSlot > slot
        || !Number.isSafeInteger(state.lastExtendedSlotStartIndex)
        || state.lastExtendedSlotStartIndex < 0
        || state.lastExtendedSlotStartIndex > state.addresses.length
        || state.addresses.length > 256) {
        throw new Error(`Solana RPC returned inactive lookup table ${table}`);
    }
    const length = slot === state.lastExtendedSlot
        ? state.lastExtendedSlotStartIndex : state.addresses.length;
    return state.addresses.slice(0, length);
};

const tokenAccount = (value: unknown, address: string): SolanaTokenAccount | null => {
    if (value === null) return null;
    const account = row(value);
    if (!account || account.owner !== tokenOwner || account.executable !== false) {
        throw new Error(`Solana RPC returned invalid token account ${address}`);
    }
    let data: Buffer;
    try {
        data = accountData(account.data, 165, 165);
    } catch {
        throw new Error(`Solana RPC returned invalid token account ${address}`);
    }
    const delegateTag = data.readUInt32LE(72);
    const nativeTag = data.readUInt32LE(109);
    const closeTag = data.readUInt32LE(129);
    if (integer(account.space) !== data.length || data[108] !== 1
        || ![0, 1].includes(delegateTag)
        || ![0, 1].includes(nativeTag)
        || ![0, 1].includes(closeTag)) {
        throw new Error(`Solana RPC returned invalid token account ${address}`);
    }
    return {
        mint: bs58.encode(data.subarray(0, 32)),
        owner: bs58.encode(data.subarray(32, 64)),
        amount: data.readBigUInt64LE(64),
        delegate: delegateTag === 1 ? bs58.encode(data.subarray(76, 108)) : undefined,
        delegatedAmount: data.readBigUInt64LE(121),
    };
};

const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const executableAccount = (
    value: unknown,
    address: string
): { owner: string; data: Buffer; programData?: string } => {
    const account = row(value);
    if (!account || typeof account.owner !== 'string' || account.executable !== true) {
        throw new Error(`Solana RPC returned invalid program account ${address}`);
    }
    let data: Buffer;
    try {
        data = accountData(account.data, 0, maxProgramBytes);
    } catch {
        throw new Error(`Solana RPC returned invalid program account ${address}`);
    }
    if (integer(account.space) !== data.length) {
        throw new Error(`Solana RPC returned invalid program account ${address}`);
    }
    if (account.owner !== upgradeLoader) return { owner: account.owner, data };
    if (data.length !== 36 || data.readUInt32LE(0) !== 2) {
        throw new Error(`Solana RPC returned invalid program account ${address}`);
    }
    return {
        owner: account.owner,
        data,
        programData: bs58.encode(data.subarray(4)),
    };
};

const programData = (
    value: unknown,
    address: string
): NonNullable<SolanaProgramAccount['programData']> => {
    const account = row(value);
    if (!account || account.owner !== upgradeLoader || account.executable !== false) {
        throw new Error(`Solana RPC returned invalid program data ${address}`);
    }
    let data: Buffer;
    try {
        data = accountData(account.data, 14, maxProgramBytes);
    } catch {
        throw new Error(`Solana RPC returned invalid program data ${address}`);
    }
    const authorityTag = data[12];
    const metaBytes = authorityTag === 0 ? 13 : 45;
    if (integer(account.space) !== data.length || data.readUInt32LE(0) !== 3
        || ![0, 1].includes(authorityTag) || data.length <= metaBytes) {
        throw new Error(`Solana RPC returned invalid program data ${address}`);
    }
    return {
        address,
        owner: account.owner,
        executable: false,
        authority: authorityTag === 1
            ? bs58.encode(data.subarray(13, 45)) : null,
        dataHash: digest(data),
    };
};

export class SolanaLookupResolver {
    constructor(
        private readonly rpcUrl: string,
        private readonly timeoutMs: number,
        private readonly fetcher: Fetcher = fetch
    ) {
        const url = new URL(rpcUrl);
        if (!['http:', 'https:'].includes(url.protocol)) {
            throw new Error('Solana RPC URL must use HTTP or HTTPS');
        }
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
            throw new Error('Solana RPC timeout must be 1 to 30000 milliseconds');
        }
    }

    async resolve(
        transaction: SolanaTransaction,
        external?: AbortSignal
    ): Promise<ResolvedSolana> {
        const keys = solanaLookupTables(transaction);
        if (!keys.length) return resolveSolanaTransaction(transaction, new Map());
        if (keys.length > maxTables) {
            throw new Error('Solana transaction uses too many lookup tables');
        }

        const { slot, values } = await this.accounts(keys, undefined, external);
        const tables = new Map<string, string[]>();
        keys.forEach((key, index) => {
            tables.set(key, tableAddresses(values[index], key, slot));
        });
        return { ...resolveSolanaTransaction(transaction, tables), contextSlot: slot };
    }

    async tokenAccounts(
        keys: string[],
        minimumSlot?: number,
        external?: AbortSignal
    ): Promise<ReadonlyMap<string, SolanaTokenAccount | null>> {
        const unique = [...new Set(keys)];
        if (!unique.length) return new Map();
        const { values } = await this.accounts(unique, minimumSlot, external);
        return new Map(unique.map((key, index) => [key, tokenAccount(values[index], key)]));
    }

    async programAccounts(
        keys: string[],
        minimumSlot?: number,
        external?: AbortSignal
    ): Promise<ReadonlyMap<string, SolanaProgramAccount>> {
        const unique = [...new Set(keys)];
        if (!unique.length) return new Map();
        const bound = boundedSignal(this.timeoutMs, external);
        try {
            const { slot, values } = await this.accounts(unique, minimumSlot, bound.signal);
            const programs = unique.map((key, index) => executableAccount(values[index], key));
            const links = [...new Set(programs.flatMap((program) =>
                program.programData ? [program.programData] : []))];
            const linked = links.length
                ? await this.accounts(links, slot, bound.signal) : { values: [] };
            const states = new Map(links.map((key, index) =>
                [key, programData(linked.values[index], key)]));
            return new Map(unique.map((key, index) => {
                const program = programs[index];
                return [key, {
                    owner: program.owner,
                    executable: true,
                    dataHash: digest(program.data),
                    ...(program.programData
                        ? { programData: states.get(program.programData) } : {}),
                }];
            }));
        } finally {
            bound.close();
        }
    }

    private async accounts(
        keys: string[],
        minimumSlot?: number,
        external?: AbortSignal
    ): Promise<{ slot: number; values: unknown[] }> {
        if (!keys.length || keys.length > 100 || new Set(keys).size !== keys.length) {
            throw new Error('Solana RPC account request is invalid');
        }
        if (minimumSlot !== undefined
            && (!Number.isSafeInteger(minimumSlot) || minimumSlot < 0)) {
            throw new Error('Solana RPC minimum context slot is invalid');
        }

        const bound = boundedSignal(this.timeoutMs, external);
        const aborted = (): Error => bound.signal.reason instanceof Error
            ? bound.signal.reason : new Error('Solana RPC lookup was cancelled');
        try {
            let response: Response;
            try {
                response = await abortable(this.fetcher(this.rpcUrl, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'getMultipleAccounts',
                        params: [keys, {
                            encoding: 'base64',
                            commitment: 'finalized',
                            ...(minimumSlot === undefined ? {} : { minContextSlot: minimumSlot }),
                        }],
                    }),
                    signal: bound.signal,
                }), bound.signal, aborted);
            } catch (error) {
                throw new SolanaLookupUnavailable(
                    error instanceof Error ? error.message : 'Solana RPC lookup failed'
                );
            }
            if (!response.ok) {
                throw new SolanaLookupUnavailable(`Solana RPC returned HTTP ${response.status}`);
            }
            let body: Row | null;
            try {
                body = row(await abortable(response.json(), bound.signal, aborted));
            } catch (error) {
                throw new SolanaLookupUnavailable(
                    error instanceof Error ? error.message : 'Solana RPC response could not be read'
                );
            }
            const result = row(body?.result);
            const context = row(result?.context);
            const slot = integer(context?.slot);
            const values = result?.value;
            if (body?.jsonrpc !== '2.0' || body.id !== 1 || body.error !== undefined
                || slot === null || (minimumSlot !== undefined && slot < minimumSlot)
                || !Array.isArray(values) || values.length !== keys.length) {
                throw new SolanaLookupUnavailable('Solana RPC returned an invalid account response');
            }
            return { slot, values };
        } finally {
            bound.close();
        }
    }
}
