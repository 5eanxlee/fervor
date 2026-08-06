import crypto from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import type { DbQuery } from '../src/config/database';
import { SolanaLookupResolver, SolanaLookupUnavailable } from '../src/services/solanaLookup';
import type { SolanaProgramAccount } from '../src/services/solanaLookup';
import { parseSolanaTransaction } from '../src/services/solanaTransaction';
import type { ResolvedSolana, SolanaAccount } from '../src/services/solanaTransaction';
import { OrderService } from '../src/services/orders/orderService';
import { validateOrderTx } from '../src/services/orders/transactionPolicy';
import type { OrderProvider } from '../src/services/orders/provider';
import type { OrderTxIntent, OrderTxResolver } from '../src/services/orders/transactionPolicy';
import { orderRequestSchema } from '../src/types';

const systemProgram = '11111111111111111111111111111111';
const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const associatedProgram = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const computeProgram = 'ComputeBudget111111111111111111111111111111';
const nativeMint = 'So11111111111111111111111111111111111111112';
const defaultTarget = bs58.encode(Buffer.alloc(32, 8));

const vec = (value: number): Buffer => Buffer.from([value]);

const systemTransfer = (amount = 1n): Buffer => {
    const data = Buffer.alloc(12);
    data.writeUInt32LE(2, 0);
    data.writeBigUInt64LE(amount, 4);
    return data;
};

const tokenTransfer = (tag = 3, amount = 1n): Buffer => {
    const data = Buffer.alloc(9);
    data[0] = tag;
    data.writeBigUInt64LE(amount, 1);
    return data;
};

const computePrice = (price: bigint): Buffer => {
    const data = Buffer.alloc(9);
    data[0] = 3;
    data.writeBigUInt64LE(price, 1);
    return data;
};

const computeLimit = (limit: number): Buffer => {
    const data = Buffer.alloc(5);
    data[0] = 2;
    data.writeUInt32LE(limit, 1);
    return data;
};

interface MessageOptions {
    accounts?: number[];
    data?: Buffer;
    extraSigner?: Uint8Array;
    programWritable?: boolean;
    targets?: number;
}

const message = (
    signer: Uint8Array,
    program: string,
    options: MessageOptions = {}
): Buffer => {
    const targetCount = options.targets ?? 1;
    const firstTarget = options.extraSigner ? 2 : 1;
    const targets = Array.from({ length: targetCount }, (_, index) => Buffer.alloc(32, 8 + index));
    const programIndex = firstTarget + targetCount;
    const accounts = options.accounts ?? [0, firstTarget];
    const data = options.data ?? systemTransfer();
    return Buffer.concat([
        Buffer.from([options.extraSigner ? 2 : 1, 0, options.programWritable ? 0 : 1]),
        vec(programIndex + 1),
        Buffer.from(signer),
        ...(options.extraSigner ? [Buffer.from(options.extraSigner)] : []),
        ...targets,
        Buffer.from(bs58.decode(program)),
        Buffer.alloc(32, 7),
        vec(1),
        Buffer.from([programIndex]),
        vec(accounts.length),
        Buffer.from(accounts),
        vec(data.length),
        data,
    ]);
};

const transaction = (messageBytes: Buffer, signatures = 1, signed = false): string => Buffer.concat([
    vec(signatures),
    ...Array.from({ length: signatures }, () => signed ? Buffer.alloc(64, 1) : Buffer.alloc(64)),
    messageBytes,
]).toString('base64');

const partialTx = (messageBytes: Buffer, signatures: Uint8Array[]): string => Buffer.concat([
    vec(signatures.length),
    ...signatures.map((signature) => Buffer.from(signature)),
    messageBytes,
]).toString('base64');

const lookup = new SolanaLookupResolver('https://rpc.example.com', 1_000);
const programs = new Map<string, SolanaProgramAccount>([
    [systemProgram, {
        owner: 'NativeLoader1111111111111111111111111111111',
        executable: true,
        dataHash: 'c94b792a6d8b25d3e53ea94d8b80111735ed80d6a7dc8deb937cd342707f5f03',
    }],
    [tokenProgram, {
        owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
        executable: true,
        dataHash: '5b31219b7bc4060b1638b933be5f50df3400109acfef12408a196d57ad119748',
        programData: {
            address: '3gvYRKWyXRR9xKWe1ZjPhLY5ZJRN7KDB4rFZFGoJfFk2',
            owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
            executable: false,
            authority: null,
            dataHash: '573971c9baedda479bf4c38537787ae396358009b4920f8a270bd2b31dde5fe3',
        },
    }],
    [associatedProgram, {
        owner: 'BPFLoader2111111111111111111111111111111111',
        executable: true,
        dataHash: '6804554e69fd3a58caa191dc4a58f4c67223d30ca28ab8987f39fc18d2f7374d',
    }],
    [computeProgram, {
        owner: 'NativeLoader1111111111111111111111111111111',
        executable: true,
        dataHash: '005950c007e8e550a16beddf836f0082d26d197f5f645ff7c04a5c8d171cf8a1',
    }],
]);
const policyResolver = (overrides: Partial<OrderTxResolver> = {}): OrderTxResolver => ({
    resolve: (value) => lookup.resolve(value),
    programAccounts: async () => programs,
    tokenAccounts: (keys, slot, signal) => lookup.tokenAccounts(keys, slot, signal),
    ...overrides,
});
const resolver = policyResolver();
const deposit = (
    wallet: string,
    receiver = defaultTarget,
    account = receiver,
    mint = nativeMint,
    amount = '1'
): OrderTxIntent => ({ kind: 'deposit', wallet, receiver, account, mint, amount });
const withdrawal = (
    wallet: string,
    receiver = defaultTarget,
    account = receiver,
    mint = nativeMint,
    amount = '1'
): OrderTxIntent => ({ kind: 'withdrawal', wallet, receiver, account, mint, amount });

const tokenState = (
    mint: string,
    owner: string,
    amount = 1n,
    delegate?: string
) => ({ mint, owner, amount, delegate, delegatedAmount: delegate ? amount : 0n });

describe('order transaction policy', () => {
    it('accepts canonical deposits and an exact vault withdrawal', async () => {
        const signer = nacl.sign.keyPair();
        const vault = nacl.sign.keyPair();
        const wallet = bs58.encode(signer.publicKey);
        const parsed = parseSolanaTransaction(transaction(message(signer.publicKey, systemProgram)), 3_000);
        const tokenParsed = parseSolanaTransaction(transaction(message(signer.publicKey, tokenProgram, {
            accounts: [1, 2, 0],
            data: tokenTransfer(),
            targets: 2,
        })), 3_000);
        const source = defaultTarget;
        const destination = bs58.encode(Buffer.alloc(32, 9));
        const mint = bs58.encode(Buffer.alloc(32, 20));
        const receiver = bs58.encode(Buffer.alloc(32, 21));
        const tokenResolver: OrderTxResolver = {
            resolve: (value) => lookup.resolve(value),
            programAccounts: resolver.programAccounts,
            tokenAccounts: async () => new Map([
                [source, tokenState(mint, wallet)],
                [destination, tokenState(mint, receiver)],
            ]),
        };

        await expect(validateOrderTx(parsed, deposit(wallet), resolver)).resolves.toBeUndefined();
        await expect(validateOrderTx(
            tokenParsed,
            deposit(wallet, receiver, destination, mint),
            tokenResolver
        )).resolves.toBeUndefined();
        const vaultAddress = bs58.encode(vault.publicKey);
        const withdrawMessage = message(signer.publicKey, tokenProgram, {
            extraSigner: vault.publicKey,
            accounts: [2, 3, 1],
            data: tokenTransfer(),
            targets: 2,
        });
        const withdrawalTx = parseSolanaTransaction(partialTx(withdrawMessage, [
            Buffer.alloc(64),
            nacl.sign.detached(withdrawMessage, vault.secretKey),
        ]), 3_000);
        const withdrawalResolver: OrderTxResolver = {
            resolve: (value) => lookup.resolve(value),
            programAccounts: resolver.programAccounts,
            tokenAccounts: async () => new Map([
                [source, tokenState(mint, vaultAddress)],
                [destination, tokenState(mint, wallet)],
            ]),
        };
        await expect(validateOrderTx(
            withdrawalTx,
            withdrawal(wallet, vaultAddress, source, mint),
            withdrawalResolver
        )).resolves.toBeUndefined();
        const delegatedResolver: OrderTxResolver = {
            resolve: (value) => lookup.resolve(value),
            programAccounts: resolver.programAccounts,
            tokenAccounts: async () => new Map([
                [source, tokenState(mint, vaultAddress, 1n, wallet)],
                [destination, tokenState(mint, wallet)],
            ]),
        };
        await expect(validateOrderTx(
            tokenParsed,
            withdrawal(wallet, vaultAddress, source, mint),
            delegatedResolver
        )).resolves.toBeUndefined();
        await expect(validateOrderTx(parsed, withdrawal(wallet), resolver))
            .rejects.toThrow(/unsafe system instruction/);
    });

    it('rejects unsafe canonical instruction variants and excessive priority fees', async () => {
        const signer = nacl.sign.keyPair();
        const wallet = bs58.encode(signer.publicKey);
        const systemAssign = Buffer.alloc(4);
        systemAssign.writeUInt32LE(1);
        const trailingTransfer = Buffer.concat([systemTransfer(), Buffer.from([0])]);
        const unsafe = [
            message(signer.publicKey, systemProgram, { data: systemAssign }),
            message(signer.publicKey, systemProgram, { data: trailingTransfer }),
            message(signer.publicKey, tokenProgram, { data: tokenTransfer(4) }),
            message(signer.publicKey, tokenProgram, {
                accounts: [1, 2, 0], data: Buffer.from([9]), targets: 2,
            }),
            message(signer.publicKey, associatedProgram, { data: Buffer.from([2]) }),
            message(signer.publicKey, computeProgram, {
                accounts: [],
                data: computePrice(100_000_000n),
            }),
        ];

        for (const value of unsafe) {
            const parsed = parseSolanaTransaction(transaction(value), 3_000);
            await expect(validateOrderTx(parsed, deposit(wallet), resolver)).rejects.toThrow();
        }
    });

    it('accepts bounded compute, ATA creation, sync-native, and token transfer shapes', async () => {
        const signer = nacl.sign.keyPair();
        const wallet = bs58.encode(signer.publicKey);
        const parsed = parseSolanaTransaction(transaction(message(signer.publicKey, systemProgram)), 3_000);
        const account = (
            address: string,
            signerFlag: boolean,
            writable: boolean,
            index: number
        ): SolanaAccount => ({ address, signer: signerFlag, writable, index });
        const mint = nativeMint;
        const source = account(bs58.encode(Buffer.alloc(32, 22)), false, true, 1);
        const destination = account(bs58.encode(Buffer.alloc(32, 23)), false, true, 2);
        const receiver = bs58.encode(Buffer.alloc(32, 24));
        const payer = account(wallet, true, true, 0);
        const system = account(systemProgram, false, false, 3);
        const token = account(tokenProgram, false, false, 4);
        const associated = account(associatedProgram, false, false, 5);
        const compute = account(computeProgram, false, false, 6);
        const mintAccount = account(mint, false, false, 7);
        const resolved: ResolvedSolana = {
            contextSlot: 37,
            accounts: [payer, source, destination, system, token, associated, compute, mintAccount],
            instructions: [
                { programId: computeProgram, accounts: [], data: computeLimit(300_000) },
                { programId: computeProgram, accounts: [], data: computePrice(1_000n) },
                {
                    programId: associatedProgram,
                    accounts: [payer, source, payer, mintAccount, system, token],
                    data: Buffer.from([1]),
                },
                {
                    programId: systemProgram,
                    accounts: [payer, source],
                    data: systemTransfer(),
                },
                { programId: tokenProgram, accounts: [source], data: Buffer.from([17]) },
                {
                    programId: tokenProgram,
                    accounts: [source, destination, payer],
                    data: tokenTransfer(),
                },
            ],
        };
        const tokenAccounts = vi.fn(async () => new Map([
            [destination.address, tokenState(mint, receiver)],
        ]));
        const resolvedTx: OrderTxResolver = {
            resolve: async () => resolved,
            programAccounts: resolver.programAccounts,
            tokenAccounts,
        };

        await expect(validateOrderTx(
            parsed,
            deposit(wallet, receiver, destination.address),
            resolvedTx
        )).resolves.toBeUndefined();
        expect(tokenAccounts).toHaveBeenCalledWith([destination.address], 37);
    });

    it('allows only the declared OTOCO output account and mint', async () => {
        const signer = nacl.sign.keyPair();
        const wallet = bs58.encode(signer.publicKey);
        const parsed = parseSolanaTransaction(transaction(message(signer.publicKey, systemProgram)), 3_000);
        const account = (
            address: string,
            signer: boolean,
            writable: boolean,
            index: number
        ): SolanaAccount => ({ address, signer, writable, index });
        const inputMint = bs58.encode(Buffer.alloc(32, 42));
        const outputMint = bs58.encode(Buffer.alloc(32, 43));
        const receiver = bs58.encode(Buffer.alloc(32, 44));
        const source = account(bs58.encode(Buffer.alloc(32, 45)), false, true, 1);
        const input = account(bs58.encode(Buffer.alloc(32, 46)), false, true, 2);
        const output = account(bs58.encode(Buffer.alloc(32, 47)), false, true, 3);
        const payer = account(wallet, true, true, 0);
        const system = account(systemProgram, false, false, 4);
        const token = account(tokenProgram, false, false, 5);
        const associated = account(associatedProgram, false, false, 6);
        const inputMintAccount = account(inputMint, false, false, 7);
        const outputMintAccount = account(outputMint, false, false, 8);
        const vault = account(receiver, false, false, 9);
        const resolved: ResolvedSolana = {
            contextSlot: 41,
            accounts: [payer, source, input, output, system, token, associated,
                inputMintAccount, outputMintAccount, vault],
            instructions: [
                {
                    programId: associatedProgram,
                    accounts: [payer, output, vault, outputMintAccount, system, token],
                    data: Buffer.from([1]),
                },
                {
                    programId: tokenProgram,
                    accounts: [source, input, payer],
                    data: tokenTransfer(),
                },
            ],
        };
        const state = policyResolver({
            resolve: async () => resolved,
            tokenAccounts: async () => new Map([
                [source.address, tokenState(inputMint, wallet)],
                [input.address, tokenState(inputMint, receiver)],
            ]),
        });
        const intent: OrderTxIntent = {
            ...deposit(wallet, receiver, input.address, inputMint),
            output: { mint: outputMint, account: output.address },
        };

        await expect(validateOrderTx(parsed, intent, state)).resolves.toBeUndefined();
        await expect(validateOrderTx(
            parsed,
            deposit(wallet, receiver, input.address, inputMint),
            state
        )).rejects.toThrow(/unrelated token account/);
        await expect(validateOrderTx(parsed, {
            ...intent,
            output: { mint: inputMint, account: output.address },
        }, state)).rejects.toThrow(/unrelated token account/);
    });

    it('binds deposit amount, destination, mint, and token-account owners', async () => {
        const signer = nacl.sign.keyPair();
        const wallet = bs58.encode(signer.publicKey);
        const source = defaultTarget;
        const destination = bs58.encode(Buffer.alloc(32, 9));
        const receiver = bs58.encode(Buffer.alloc(32, 30));
        const mint = bs58.encode(Buffer.alloc(32, 31));
        const parsed = parseSolanaTransaction(transaction(message(signer.publicKey, tokenProgram, {
            accounts: [1, 2, 0],
            data: tokenTransfer(),
            targets: 2,
        })), 3_000);
        const state = (sourceOwner: string): OrderTxResolver => ({
            resolve: (value) => lookup.resolve(value),
            programAccounts: resolver.programAccounts,
            tokenAccounts: async () => new Map([
                [source, tokenState(mint, sourceOwner)],
                [destination, tokenState(mint, receiver)],
            ]),
        });

        await expect(validateOrderTx(
            parsed,
            deposit(wallet, receiver, destination, mint, '2'),
            state(wallet)
        )).rejects.toThrow(/does not match the request/);
        await expect(validateOrderTx(
            parsed,
            deposit(wallet, receiver, defaultTarget, mint),
            state(wallet)
        )).rejects.toThrow(/does not match the request/);
        await expect(validateOrderTx(
            parsed,
            deposit(wallet, receiver, destination, mint),
            state(receiver)
        )).rejects.toThrow(/token account does not match/);
    });

    it('rejects unused provider accounts on direct SOL deposits', async () => {
        const signer = nacl.sign.keyPair();
        const wallet = bs58.encode(signer.publicKey);
        const account = bs58.encode(Buffer.alloc(32, 32));
        const parsed = parseSolanaTransaction(
            transaction(message(signer.publicKey, systemProgram)), 3_000
        );

        await expect(validateOrderTx(
            parsed,
            deposit(wallet, defaultTarget, account),
            resolver
        )).rejects.toThrow(/does not match the provider account/);
    });

    it('fails closed on custom programs, elevated program privileges, or signer drift', async () => {
        const signer = nacl.sign.keyPair();
        const other = nacl.sign.keyPair();
        const wallet = bs58.encode(signer.publicKey);
        const unknown = bs58.encode(Buffer.alloc(32, 9));
        const parse = (wire: string) => parseSolanaTransaction(wire, 3_000);

        await expect(validateOrderTx(
            parse(transaction(message(signer.publicKey, unknown))),
            deposit(wallet),
            resolver
        )).rejects.toThrow(/unapproved program/);
        await expect(validateOrderTx(
            parse(transaction(message(signer.publicKey, systemProgram, { programWritable: true }))),
            deposit(wallet),
            resolver
        )).rejects.toThrow(/program privileges/);
        await expect(validateOrderTx(
            parse(transaction(message(signer.publicKey, systemProgram, {
                extraSigner: other.publicKey,
            }), 2)),
            withdrawal(wallet),
            resolver
        )).rejects.toThrow(/unauthorized signer/);
        await expect(validateOrderTx(
            parse(transaction(message(signer.publicKey, systemProgram), 1, true)),
            withdrawal(wallet),
            resolver
        )).rejects.toThrow(/unsigned by the wallet/);
    });

    it('pins immutable program code and upgrade authority once per resolver', async () => {
        const signer = nacl.sign.keyPair();
        const wallet = bs58.encode(signer.publicKey);
        const parsed = parseSolanaTransaction(
            transaction(message(signer.publicKey, systemProgram)), 3_000
        );
        const readPrograms = vi.fn(async () => programs);
        const trusted = policyResolver({ programAccounts: readPrograms });

        await validateOrderTx(parsed, deposit(wallet), trusted);
        await validateOrderTx(parsed, deposit(wallet), trusted);
        expect(readPrograms).toHaveBeenCalledOnce();

        const changedCode = new Map(programs);
        changedCode.set(systemProgram, { ...programs.get(systemProgram)!, dataHash: '0'.repeat(64) });
        await expect(validateOrderTx(parsed, deposit(wallet), policyResolver({
            programAccounts: async () => changedCode,
        }))).rejects.toThrow(/program identity is invalid/);

        const changedAuthority = new Map(programs);
        const tokenState = programs.get(tokenProgram)!;
        changedAuthority.set(tokenProgram, {
            ...tokenState,
            programData: { ...tokenState.programData!, authority: wallet },
        });
        await expect(validateOrderTx(parsed, deposit(wallet), policyResolver({
            programAccounts: async () => changedAuthority,
        }))).rejects.toThrow(/program identity is invalid/);
    });

    it('rejects cross-order, insolvent, redirected, and unsigned-vault withdrawals', async () => {
        const signer = nacl.sign.keyPair();
        const vault = nacl.sign.keyPair();
        const wallet = bs58.encode(signer.publicKey);
        const receiver = bs58.encode(vault.publicKey);
        const mint = bs58.encode(Buffer.alloc(32, 20));
        const source = defaultTarget;
        const destination = bs58.encode(Buffer.alloc(32, 9));
        const messageBytes = message(signer.publicKey, tokenProgram, {
            extraSigner: vault.publicKey,
            accounts: [2, 3, 1],
            data: tokenTransfer(),
            targets: 2,
        });
        const parsed = parseSolanaTransaction(partialTx(messageBytes, [
            Buffer.alloc(64), nacl.sign.detached(messageBytes, vault.secretKey),
        ]), 3_000);
        const state = (sourceAmount = 1n, destinationOwner = wallet): OrderTxResolver => ({
            resolve: (value) => lookup.resolve(value),
            programAccounts: resolver.programAccounts,
            tokenAccounts: async () => new Map([
                [source, tokenState(mint, receiver, sourceAmount)],
                [destination, tokenState(mint, destinationOwner)],
            ]),
        });

        await expect(validateOrderTx(
            parsed,
            withdrawal(wallet, receiver, bs58.encode(Buffer.alloc(32, 40)), mint),
            state()
        )).rejects.toThrow(/does not match the order/);
        await expect(validateOrderTx(
            parsed, withdrawal(wallet, receiver, source, mint), state(0n)
        )).rejects.toThrow(/source does not match/);
        await expect(validateOrderTx(
            parsed, withdrawal(wallet, receiver, source, mint), state(2n)
        )).resolves.toBeUndefined();
        await expect(validateOrderTx(
            parsed,
            withdrawal(wallet, receiver, source, mint),
            state(1n, bs58.encode(Buffer.alloc(32, 41)))
        )).rejects.toThrow(/destination does not belong/);

        const unsigned = parseSolanaTransaction(partialTx(messageBytes, [
            Buffer.alloc(64), Buffer.alloc(64),
        ]), 3_000);
        await expect(validateOrderTx(
            unsigned, withdrawal(wallet, receiver, source, mint), state()
        )).rejects.toThrow(/vault signature is invalid/);
    });

    it('rejects a transaction when lookup resolution cannot complete', async () => {
        const signer = nacl.sign.keyPair();
        const wallet = bs58.encode(signer.publicKey);
        const parsed = parseSolanaTransaction(transaction(message(signer.publicKey, systemProgram)), 3_000);
        const unavailable: OrderTxResolver = {
            resolve: async () => { throw new SolanaLookupUnavailable('RPC unavailable'); },
            programAccounts: resolver.programAccounts,
            tokenAccounts: async () => new Map(),
        };

        await expect(validateOrderTx(parsed, deposit(wallet), unavailable))
            .rejects.toThrow(/RPC unavailable/);
    });

    it('reports lookup dependency failures as retryable on safe replay', async () => {
        const signer = nacl.sign.keyPair();
        const wallet = bs58.encode(signer.publicKey);
        const request = orderRequestSchema.parse({
            orderType: 'single',
            walletAddress: wallet,
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            inputAmount: '1000000000',
            triggerMint: 'So11111111111111111111111111111111111111112',
            triggerCondition: 'above',
            triggerPriceUsd: 250,
            slippageBps: 100,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            clientOrderId: 'policy-outage-00000001',
        });
        const prepared = transaction(message(signer.publicKey, systemProgram));
        const db = vi.fn().mockResolvedValue({ rows: [{
            id: 'order-1',
            request_digest: crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex'),
            state: 'prepared',
            prepared_tx: prepared,
            deposit_request_id: 'deposit-1',
            wallet_address: wallet,
            receiver_address: defaultTarget,
            params: { ...request, depositAccount: defaultTarget },
            expires_at: request.expiresAt,
        }] }) as unknown as DbQuery;
        const provider = {
            name: 'jupiter_trigger_v2',
            requiresAuth: true,
            custody: 'third_party_vault',
        } as unknown as OrderProvider;
        const unavailable: OrderTxResolver = {
            resolve: async () => { throw new SolanaLookupUnavailable('RPC unavailable'); },
            programAccounts: resolver.programAccounts,
            tokenAccounts: async () => new Map(),
        };
        const service = new OrderService(provider, db, undefined, unavailable);

        await expect(service.prepare('user-1', request, 'token')).rejects.toMatchObject({
            code: 'transaction_validation_unavailable',
            status: 503,
            retryable: true,
        });
        expect(db).toHaveBeenCalledOnce();
    });

    it('revalidates idempotently replayed provider transactions before returning them', async () => {
        const signer = nacl.sign.keyPair();
        const wallet = bs58.encode(signer.publicKey);
        const request = orderRequestSchema.parse({
            orderType: 'single',
            walletAddress: wallet,
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            inputAmount: '1000000000',
            triggerMint: 'So11111111111111111111111111111111111111112',
            triggerCondition: 'above',
            triggerPriceUsd: 250,
            slippageBps: 100,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            clientOrderId: 'policy-replay-00000001',
        });
        const prepared = transaction(message(signer.publicKey, bs58.encode(Buffer.alloc(32, 9))));
        const db = vi.fn().mockResolvedValue({ rows: [{
            id: 'order-1',
            request_digest: crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex'),
            state: 'prepared',
            prepared_tx: prepared,
            deposit_request_id: 'deposit-1',
            wallet_address: wallet,
            receiver_address: defaultTarget,
            params: { ...request, depositAccount: defaultTarget },
            expires_at: request.expiresAt,
        }] }) as unknown as DbQuery;
        const provider = {
            name: 'jupiter_trigger_v2',
            requiresAuth: true,
            custody: 'third_party_vault',
        } as unknown as OrderProvider;
        const service = new OrderService(provider, db, undefined, resolver);

        await expect(service.prepare('user-1', request, 'token'))
            .rejects.toMatchObject({ code: 'provider_contract_error' });
        expect(db).toHaveBeenCalledOnce();

        const cancelDb = vi.fn().mockResolvedValue({ rows: [{
            id: 'order-1',
            state: 'cancel_pending',
            cancel_request_id: 'cancel-1',
            cancel_tx: prepared,
            wallet_address: wallet,
            input_mint: request.inputMint,
            input_amount: request.inputAmount,
            receiver_address: defaultTarget,
            params: { depositAccount: defaultTarget },
        }] }) as unknown as DbQuery;
        const cancelService = new OrderService(provider, cancelDb, undefined, resolver);

        await expect(cancelService.cancel('user-1', 'order-1', 'token'))
            .rejects.toMatchObject({ code: 'provider_contract_error' });
        expect(cancelDb).toHaveBeenCalledOnce();

        const activateDb = vi.fn().mockResolvedValue({ rows: [{
            id: 'order-1',
            state: 'prepared',
            provider_order_id: null,
            deposit_request_id: 'deposit-1',
            prepared_tx: prepared,
            wallet_address: wallet,
            receiver_address: defaultTarget,
            params: { ...request, depositAccount: defaultTarget },
        }] }) as unknown as DbQuery;
        const activateService = new OrderService(provider, activateDb, undefined, resolver);

        await expect(activateService.activate('user-1', 'order-1', prepared, 'token'))
            .rejects.toMatchObject({ code: 'provider_contract_error' });
        expect(activateDb).toHaveBeenCalledOnce();

        const confirmDb = vi.fn().mockResolvedValue({ rows: [{
            id: 'order-1',
            state: 'cancel_pending',
            provider_order_id: 'provider-1',
            cancel_request_id: 'cancel-1',
            cancel_tx: prepared,
            wallet_address: wallet,
            input_mint: request.inputMint,
            input_amount: request.inputAmount,
            receiver_address: defaultTarget,
            params: { depositAccount: defaultTarget },
        }] }) as unknown as DbQuery;
        const confirmService = new OrderService(provider, confirmDb, undefined, resolver);

        await expect(confirmService.confirmCancel(
            'user-1',
            'order-1',
            'cancel-1',
            prepared,
            'token'
        )).rejects.toMatchObject({ code: 'provider_contract_error' });
        expect(confirmDb).toHaveBeenCalledOnce();
    });
});
