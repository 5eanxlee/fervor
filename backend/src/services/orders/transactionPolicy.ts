import { env } from '../../config/env';
import { parseU64 } from '../../types';
import type { SolanaProgramAccount, SolanaTokenAccount } from '../solanaLookup';
import { verifySolanaSigner } from '../solanaTransaction';
import type { ResolvedSolana, SolanaAccount, SolanaIx, SolanaTransaction } from '../solanaTransaction';

export type OrderTxKind = 'deposit' | 'withdrawal';

export type OrderTxIntent =
    | {
        kind: 'deposit';
        wallet: string;
        mint: string;
        amount: string;
        receiver: string;
        account: string;
        output?: { mint: string; account: string };
    }
    | {
        kind: 'withdrawal';
        wallet: string;
        mint: string;
        amount: string;
        receiver: string;
        account: string;
    };

export interface OrderTxResolver {
    resolve(transaction: SolanaTransaction, signal?: AbortSignal): Promise<ResolvedSolana>;
    programAccounts(
        keys: string[],
        minimumSlot?: number,
        signal?: AbortSignal
    ): Promise<ReadonlyMap<string, SolanaProgramAccount>>;
    tokenAccounts(
        keys: string[],
        minimumSlot?: number,
        signal?: AbortSignal
    ): Promise<ReadonlyMap<string, SolanaTokenAccount | null>>;
}

const system = '11111111111111111111111111111111';
const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const associated = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const compute = 'ComputeBudget111111111111111111111111111111';
const nativeMint = 'So11111111111111111111111111111111111111112';
const nativeLoader = 'NativeLoader1111111111111111111111111111111';
const legacyLoader = 'BPFLoader2111111111111111111111111111111111';
const upgradeLoader = 'BPFLoaderUpgradeab1e11111111111111111111111';
const programPins = new Map<string, SolanaProgramAccount>([
    [system, {
        owner: nativeLoader,
        executable: true,
        dataHash: 'c94b792a6d8b25d3e53ea94d8b80111735ed80d6a7dc8deb937cd342707f5f03',
    }],
    [token, {
        owner: upgradeLoader,
        executable: true,
        dataHash: '5b31219b7bc4060b1638b933be5f50df3400109acfef12408a196d57ad119748',
        programData: {
            address: '3gvYRKWyXRR9xKWe1ZjPhLY5ZJRN7KDB4rFZFGoJfFk2',
            owner: upgradeLoader,
            executable: false,
            authority: null,
            dataHash: '573971c9baedda479bf4c38537787ae396358009b4920f8a270bd2b31dde5fe3',
        },
    }],
    [associated, {
        owner: legacyLoader,
        executable: true,
        dataHash: '6804554e69fd3a58caa191dc4a58f4c67223d30ca28ab8987f39fc18d2f7374d',
    }],
    [compute, {
        owner: nativeLoader,
        executable: true,
        dataHash: '005950c007e8e550a16beddf836f0082d26d197f5f645ff7c04a5c8d171cf8a1',
    }],
]);
const commonPrograms = new Set(programPins.keys());
const trustedResolvers = new WeakSet<OrderTxResolver>();
const pendingTrust = new WeakMap<OrderTxResolver, Promise<void>>();

const fail = (message: string): never => {
    throw new Error(message);
};

const sameProgram = (actual: SolanaProgramAccount, expected: SolanaProgramAccount): boolean => {
    if (actual.owner !== expected.owner || actual.executable !== expected.executable
        || actual.dataHash !== expected.dataHash) return false;
    if (!actual.programData || !expected.programData) {
        return actual.programData === undefined && expected.programData === undefined;
    }
    return actual.programData.address === expected.programData.address
        && actual.programData.owner === expected.programData.owner
        && actual.programData.executable === expected.programData.executable
        && actual.programData.authority === expected.programData.authority
        && actual.programData.dataHash === expected.programData.dataHash;
};

const validatePrograms = async (
    resolver: OrderTxResolver,
    minimumSlot?: number
): Promise<void> => {
    if (trustedResolvers.has(resolver)) return;
    let pending = pendingTrust.get(resolver);
    if (!pending) {
        pending = (async () => {
            const programs = await resolver.programAccounts([...programPins.keys()], minimumSlot);
            if (programs.size !== programPins.size) {
                fail('Order transaction program identity is invalid');
            }
            for (const [address, expected] of programPins) {
                const actual = programs.get(address);
                if (!actual || !sameProgram(actual, expected)) {
                    fail(`Order transaction program identity is invalid: ${address}`);
                }
            }
        })();
        pendingTrust.set(resolver, pending);
    }
    try {
        await pending;
        trustedResolvers.add(resolver);
    } finally {
        if (pendingTrust.get(resolver) === pending) pendingTrust.delete(resolver);
    }
};

const privilege = (
    account: SolanaAccount | undefined,
    signer: boolean,
    writable: boolean,
    address?: string
): boolean => !!account && account.signer === signer && account.writable === writable
    && (address === undefined || account.address === address);

interface Transfer {
    type: 'system' | 'token';
    source: string;
    destination: string;
    amount: bigint;
    mint?: string;
    authority?: string;
}

interface Ata {
    address: string;
    owner: string;
    mint: string;
}

const systemIx = (instruction: SolanaIx, wallet: string, kind: OrderTxKind): Transfer => {
    if (kind !== 'deposit'
        || instruction.data.length !== 12 || instruction.data.readUInt32LE(0) !== 2
        || instruction.data.readBigUInt64LE(4) === 0n
        || instruction.accounts.length !== 2
        || !privilege(instruction.accounts[0], true, true, wallet)
        || !privilege(instruction.accounts[1], false, true)) {
        fail('Order transaction contains an unsafe system instruction');
    }
    return {
        type: 'system',
        source: instruction.accounts[0].address,
        destination: instruction.accounts[1].address,
        amount: instruction.data.readBigUInt64LE(4),
    };
};

const tokenIx = (
    instruction: SolanaIx,
    authorities: ReadonlySet<string>
): { transfer?: Transfer; sync?: string } => {
    const tag = instruction.data[0];
    if (tag === 3) {
        const authority = instruction.accounts[2];
        if (instruction.data.length !== 9 || instruction.data.readBigUInt64LE(1) === 0n
            || instruction.accounts.length !== 3
            || !privilege(instruction.accounts[0], false, true)
            || !privilege(instruction.accounts[1], false, true)
            || !authority?.signer || !authorities.has(authority.address)) {
            fail('Order transaction contains an invalid token transfer');
        }
        return { transfer: {
            type: 'token', source: instruction.accounts[0].address,
            destination: instruction.accounts[1].address,
            amount: instruction.data.readBigUInt64LE(1), authority: authority.address,
        } };
    }
    if (tag === 12) {
        const authority = instruction.accounts[3];
        if (instruction.data.length !== 10 || instruction.data.readBigUInt64LE(1) === 0n
            || instruction.accounts.length !== 4
            || !privilege(instruction.accounts[0], false, true)
            || !privilege(instruction.accounts[1], false, false)
            || !privilege(instruction.accounts[2], false, true)
            || !authority?.signer || !authorities.has(authority.address)) {
            fail('Order transaction contains an invalid checked token transfer');
        }
        return { transfer: {
            type: 'token', source: instruction.accounts[0].address,
            destination: instruction.accounts[2].address,
            amount: instruction.data.readBigUInt64LE(1),
            mint: instruction.accounts[1].address, authority: authority.address,
        } };
    }
    if (tag === 17 && instruction.data.length === 1
        && instruction.accounts.length === 1
        && privilege(instruction.accounts[0], false, true)) {
        return { sync: instruction.accounts[0].address };
    }
    return fail('Order transaction contains an unsafe token instruction');
};

const associatedIx = (instruction: SolanaIx, wallet: string): Ata => {
    const owner = instruction.accounts[2];
    if (instruction.data.length !== 1 || ![0, 1].includes(instruction.data[0])
        || instruction.accounts.length !== 6
        || !privilege(instruction.accounts[0], true, true, wallet)
        || !privilege(instruction.accounts[1], false, true)
        || !(privilege(owner, false, false) || privilege(owner, true, true, wallet))
        || !privilege(instruction.accounts[3], false, false)
        || !privilege(instruction.accounts[4], false, false, system)
        || !privilege(instruction.accounts[5], false, false, token)) {
        fail('Order transaction contains an unsafe associated-token instruction');
    }
    return {
        address: instruction.accounts[1].address,
        owner: owner.address,
        mint: instruction.accounts[3].address,
    };
};

interface ComputePolicy {
    limit?: number;
    price?: bigint;
}

const computeIx = (instruction: SolanaIx, policy: ComputePolicy): void => {
    if (instruction.accounts.length !== 0) {
        fail('Order transaction compute-budget instruction has accounts');
    }
    const tag = instruction.data[0];
    if (tag === 2 && instruction.data.length === 5 && policy.limit === undefined) {
        const limit = instruction.data.readUInt32LE(1);
        if (limit === 0 || limit > 1_400_000) fail('Order transaction compute-unit limit is invalid');
        policy.limit = limit;
        return;
    }
    if (tag === 3 && instruction.data.length === 9 && policy.price === undefined) {
        policy.price = instruction.data.readBigUInt64LE(1);
        return;
    }
    fail('Order transaction contains an unsafe compute-budget instruction');
};

const validateInstructions = (
    instructions: SolanaIx[],
    intent: OrderTxIntent
): { transfers: Transfer[]; atas: Ata[]; sync: string[] } => {
    const { wallet, kind } = intent;
    const authorities = new Set([wallet]);
    if (kind === 'withdrawal') authorities.add(intent.receiver);
    const budget: ComputePolicy = {};
    const transfers: Transfer[] = [];
    const atas: Ata[] = [];
    const sync: string[] = [];
    let seenWork = false;
    for (const instruction of instructions) {
        if (instruction.programId === compute) {
            if (seenWork) fail('Order transaction compute budget must precede other instructions');
            computeIx(instruction, budget);
            continue;
        }
        seenWork = true;
        if (instruction.programId === system) {
            transfers.push(systemIx(instruction, wallet, kind));
        } else if (instruction.programId === token) {
            const action = tokenIx(instruction, authorities);
            if (action.transfer) transfers.push(action.transfer);
            if (action.sync) sync.push(action.sync);
        } else if (instruction.programId === associated) {
            atas.push(associatedIx(instruction, wallet));
        }
    }
    const units = BigInt(budget.limit ?? 1_400_000);
    const fee = ((budget.price ?? 0n) * units + 999_999n) / 1_000_000n;
    if (fee > BigInt(env.MAX_PRIORITY_FEE_LAMPORTS)) {
        fail('Order transaction priority fee exceeds the configured limit');
    }
    if (!transfers.length) fail('Order transaction contains no value transfer');
    return { transfers, atas, sync };
};

const addRole = (
    roles: Map<string, { owner: string; mint: string }>,
    address: string,
    owner: string,
    mint: string
): void => {
    const current = roles.get(address);
    if (current !== undefined && (current.owner !== owner || current.mint !== mint)) {
        fail('Order deposit token account roles conflict');
    }
    roles.set(address, { owner, mint });
};

const validateDeposit = async (
    flow: ReturnType<typeof validateInstructions>,
    intent: Extract<OrderTxIntent, { kind: 'deposit' }>,
    resolver: OrderTxResolver,
    minimumSlot?: number
): Promise<void> => {
    const amount = parseU64(intent.amount);
    if (amount === undefined || amount === 0n) fail('Order deposit amount is invalid');

    const systems = flow.transfers.filter((item) => item.type === 'system');
    const tokens = flow.transfers.filter((item) => item.type === 'token');
    if (systems.length > 1 || tokens.length > 1) {
        fail('Order deposit contains multiple value transfers');
    }

    const roles = new Map<string, { owner: string; mint: string }>();
    const tokenTransfer = tokens[0];
    if (tokenTransfer) {
        if (tokenTransfer.amount !== amount
            || tokenTransfer.destination !== intent.account
            || (tokenTransfer.mint !== undefined && tokenTransfer.mint !== intent.mint)
            || tokenTransfer.source === tokenTransfer.destination) {
            fail('Order deposit token transfer does not match the request');
        }
        addRole(roles, tokenTransfer.source, intent.wallet, intent.mint);
        addRole(roles, tokenTransfer.destination, intent.receiver, intent.mint);
    }

    const systemTransfer = systems[0];
    if (intent.mint !== nativeMint) {
        if (systemTransfer || flow.sync.length) {
            fail('Order token deposit contains an unexpected SOL transfer');
        }
        if (!tokenTransfer) fail('Order token deposit is missing its transfer');
    } else if (tokenTransfer) {
        if (systemTransfer && (systemTransfer.amount !== amount
            || systemTransfer.destination !== tokenTransfer.source)) {
            fail('Order SOL wrapping transfer does not match the request');
        }
        if (flow.sync.length > 1
            || (flow.sync.length === 1 && flow.sync[0] !== tokenTransfer.source)
            || (systemTransfer && flow.sync[0] !== tokenTransfer.source)) {
            fail('Order SOL deposit has an invalid sync-native instruction');
        }
    } else {
        if (!systemTransfer || systemTransfer.amount !== amount) {
            fail('Order SOL deposit transfer does not match the request');
        }
        if (systemTransfer.destination === intent.receiver) {
            if (intent.account !== intent.receiver || flow.sync.length) {
                fail('Order direct SOL deposit does not match the provider account');
            }
        } else if (systemTransfer.destination === intent.account) {
            if (flow.sync.length !== 1 || flow.sync[0] !== intent.account) {
                fail('Order SOL deposit has an invalid sync-native instruction');
            }
            addRole(roles, intent.account, intent.receiver, intent.mint);
        } else {
            fail('Order SOL deposit destination does not match the provider vault');
        }
    }

    if (intent.output) {
        addRole(roles, intent.output.account, intent.receiver, intent.output.mint);
    }

    const created = new Set<string>();
    for (const ata of flow.atas) {
        const role = roles.get(ata.address);
        if (created.has(ata.address) || role === undefined
            || ata.owner !== role.owner || ata.mint !== role.mint) {
            fail('Order deposit creates an unrelated token account');
        }
        created.add(ata.address);
    }

    const keys = [...roles.keys()].filter((address) => !created.has(address));
    const accounts = await resolver.tokenAccounts(keys, minimumSlot);
    for (const [address, role] of roles) {
        if (created.has(address)) continue;
        const account = accounts.get(address);
        if (!account || account.owner !== role.owner || account.mint !== role.mint) {
            fail('Order deposit token account does not match the request');
        }
    }
};

const validatesAuthority = (
    account: SolanaTokenAccount,
    authority: string,
    amount: bigint
): boolean => account.owner === authority
    || (account.delegate === authority && account.delegatedAmount >= amount);

const validateWithdrawal = async (
    flow: ReturnType<typeof validateInstructions>,
    intent: Extract<OrderTxIntent, { kind: 'withdrawal' }>,
    resolver: OrderTxResolver,
    minimumSlot?: number
): Promise<void> => {
    const limit = parseU64(intent.amount) ?? fail('Order withdrawal amount is invalid');
    const tokens = flow.transfers.filter((item) => item.type === 'token');
    if (limit === 0n) fail('Order withdrawal amount is invalid');
    if (flow.transfers.length !== 1 || tokens.length !== 1
        || flow.sync.length || flow.atas.length > 1) {
        fail('Order withdrawal has an invalid asset flow');
    }

    const transfer = tokens[0];
    const authority = transfer.authority ?? fail('Order withdrawal authority is missing');
    if (transfer.source !== intent.account || transfer.source === transfer.destination
        || transfer.amount > limit
        || (transfer.mint !== undefined && transfer.mint !== intent.mint)) {
        fail('Order withdrawal transfer does not match the order');
    }

    const created = flow.atas[0];
    if (created && (created.address !== transfer.destination
        || created.owner !== intent.wallet || created.mint !== intent.mint)) {
        fail('Order withdrawal creates an unrelated token account');
    }

    const keys = created
        ? [transfer.source]
        : [transfer.source, transfer.destination];
    const accounts = await resolver.tokenAccounts(keys, minimumSlot);
    const source = accounts.get(transfer.source)
        ?? fail('Order withdrawal source does not match the order');
    const destination = created ? undefined : accounts.get(transfer.destination);
    if (source.mint !== intent.mint || source.owner !== intent.receiver
        || source.amount < transfer.amount
        || !validatesAuthority(source, authority, transfer.amount)) {
        fail('Order withdrawal source does not match the order');
    }
    if (!created && (!destination || destination.mint !== intent.mint
        || destination.owner !== intent.wallet)) {
        fail('Order withdrawal destination does not belong to the wallet');
    }

};

export const validateOrderTx = async (
    transaction: SolanaTransaction,
    intent: OrderTxIntent,
    resolver: OrderTxResolver
): Promise<void> => {
    const { wallet, kind } = intent;
    const allowedSigners = new Set([wallet]);
    if (kind === 'withdrawal') allowedSigners.add(intent.receiver);
    if (transaction.feePayer !== wallet || transaction.requiredSigners[0] !== wallet
        || transaction.requiredSigners.some((signer) => !allowedSigners.has(signer))
        || (kind === 'deposit' && transaction.requiredSigners.length !== 1)
        || (kind === 'withdrawal' && transaction.requiredSigners.length > 2)) {
        fail(`Order ${kind} has an unauthorized signer`);
    }
    if (transaction.signatures[0]?.some((byte) => byte !== 0)) {
        fail(`Order ${kind} must be unsigned by the wallet`);
    }
    for (let index = 1; index < transaction.requiredSigners.length; index += 1) {
        if (!verifySolanaSigner(transaction, transaction.requiredSigners[index])) {
            fail('Order withdrawal vault signature is invalid');
        }
    }

    const resolved = await resolver.resolve(transaction);
    const payer = resolved.accounts[0];
    if (!payer || payer.address !== wallet || !payer.signer || !payer.writable) {
        fail(`Order ${kind} wallet privileges are invalid`);
    }
    if (!resolved.instructions.length) {
        fail(`Order ${kind} contains no instructions`);
    }

    for (const instruction of resolved.instructions) {
        if (!commonPrograms.has(instruction.programId)) {
            fail(`Order ${kind} invokes an unapproved program`);
        }
        const program = resolved.accounts.find(({ address }) => address === instruction.programId);
        if (!program || program.signer || program.writable) {
            fail(`Order ${kind} program privileges are invalid`);
        }
    }
    await validatePrograms(resolver, resolved.contextSlot);
    const flow = validateInstructions(resolved.instructions, intent);
    if (intent.kind === 'deposit') {
        await validateDeposit(flow, intent, resolver, resolved.contextSlot);
    } else {
        await validateWithdrawal(flow, intent, resolver, resolved.contextSlot);
    }
};
