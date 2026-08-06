import { describe, expect, it } from 'vitest';
import {
    WRAPPED_SOL_MINT,
    decodeSettlement,
    type SettlementInput,
} from '../src/services/execution/executionSettlement';

const signature = '5'.repeat(88);
const wallet = 'wallet';
const inputMint = 'input-mint';
const outputMint = 'output-mint';
const payloadHash = 'a'.repeat(64);

const input = (overrides: Partial<SettlementInput> = {}): SettlementInput => ({
    signature,
    wallet,
    feePayer: wallet,
    inputMint,
    outputMint,
    expectedInput: '1000',
    minOutput: '1000',
    providerInput: '1000',
    providerOutput: '1000',
    commitment: 'confirmed',
    ...overrides,
});

const balance = (mint: string, owner: string, amount: unknown, accountIndex: number) => ({
    accountIndex,
    mint,
    owner,
    uiTokenAmount: { amount },
});

const transaction = (overrides: Record<string, unknown> = {}) => ({
    slot: 42,
    transaction: { signatures: [signature] },
    meta: {
        err: null,
        fee: 5000,
        preTokenBalances: [
            balance(inputMint, wallet, '1000', 1),
            balance(inputMint, wallet, '500', 2),
            balance(outputMint, wallet, '100', 3),
            balance(inputMint, 'another-wallet', '999999', 4),
        ],
        postTokenBalances: [
            balance(inputMint, wallet, '200', 1),
            balance(inputMint, wallet, '300', 2),
            balance(outputMint, wallet, '400', 3),
            balance(outputMint, wallet, '700', 5),
            balance(outputMint, 'another-wallet', '999999', 6),
        ],
    },
    ...overrides,
});

describe('execution settlement evidence', () => {
    it('aggregates exact wallet token deltas across token accounts', () => {
        expect(decodeSettlement(input(), transaction(), payloadHash)).toEqual({
            commitment: 'confirmed',
            slot: 42,
            status: 'verified',
            inputAmount: '1000',
            outputAmount: '1000',
            feeLamports: '5000',
            payloadHash,
        });
    });

    it('persists exact chain facts while identifying every intent and provider mismatch', () => {
        expect(decodeSettlement(input({
            expectedInput: '900',
            minOutput: '1100',
            providerInput: '950',
            providerOutput: '1050',
        }), transaction(), payloadHash)).toMatchObject({
            status: 'mismatch',
            inputAmount: '1000',
            outputAmount: '1000',
            reason: 'input_expected_mismatch,output_below_minimum,provider_input_mismatch,provider_output_mismatch',
        });
    });

    it('rejects malformed amounts, signatures, unsafe slots, and unproven balance directions', () => {
        const base = transaction();
        const meta = base.meta;
        expect(() => decodeSettlement(input(), {
            ...base,
            meta: { ...meta, preTokenBalances: [balance(inputMint, wallet, '01', 1)] },
        }, payloadHash)).toThrow(/invalid token amount/);
        expect(() => decodeSettlement(input(), {
            ...base,
            meta: { ...meta, preTokenBalances: [
                balance(inputMint, wallet, '500', 1),
                balance(inputMint, wallet, '1000', 1),
            ] },
        }, payloadHash)).toThrow(/account index/);
        expect(() => decodeSettlement(input(), {
            ...base,
            transaction: { signatures: ['6'.repeat(88)] },
        }, payloadHash)).toThrow(/does not match/);
        expect(() => decodeSettlement(input(), {
            ...base,
            slot: Number.MAX_SAFE_INTEGER + 1,
        }, payloadHash)).toThrow(/does not match/);
        expect(() => decodeSettlement(input(), {
            ...base,
            meta: {
                ...meta,
                postTokenBalances: [
                    balance(inputMint, wallet, '1600', 1),
                    balance(outputMint, wallet, '1100', 2),
                ],
            },
        }, payloadHash)).toThrow(/directions/);
    });

    it('verifies SOL input while excluding wallet-paid fees and token-account rent', () => {
        expect(decodeSettlement(input({
            inputMint: WRAPPED_SOL_MINT,
            expectedInput: '1000000',
            providerInput: '1000000',
        }), {
            slot: 42,
            transaction: {
                signatures: [signature],
                message: { accountKeys: [
                    { pubkey: wallet },
                    { pubkey: 'output-account' },
                    { pubkey: 'program' },
                ] },
            },
            meta: {
                err: null,
                fee: 5000,
                preBalances: [10_000_000, 0, 1],
                postBalances: [6_955_720, 2_039_280, 1],
                preTokenBalances: [],
                postTokenBalances: [balance(outputMint, wallet, '1000', 1)],
                rewards: [],
            },
        }, payloadHash)).toEqual({
            commitment: 'confirmed',
            slot: 42,
            status: 'verified',
            inputAmount: '1000000',
            outputAmount: '1000',
            feeLamports: '5000',
            payloadHash,
        });
    });

    it('verifies SOL output while excluding a wallet-paid transaction fee', () => {
        expect(decodeSettlement(input({
            outputMint: WRAPPED_SOL_MINT,
            expectedInput: '1000',
            minOutput: '1000000',
            providerOutput: '1000000',
        }), {
            slot: 42,
            transaction: {
                signatures: [signature],
                message: { accountKeys: [wallet, 'input-account', 'program'] },
            },
            meta: {
                err: null,
                fee: 5000,
                preBalances: [10_000_000, 2_039_280, 1],
                postBalances: [10_995_000, 2_039_280, 1],
                preTokenBalances: [balance(inputMint, wallet, '1000', 1)],
                postTokenBalances: [balance(inputMint, wallet, '0', 1)],
            },
        }, payloadHash)).toMatchObject({
            status: 'verified',
            inputAmount: '1000',
            outputAmount: '1000000',
        });
    });

    it('does not attribute sponsored fees or ATA rent to the taker SOL amount', () => {
        const sponsor = 'sponsor';
        expect(decodeSettlement(input({
            feePayer: sponsor,
            inputMint: WRAPPED_SOL_MINT,
            expectedInput: '1000000',
            providerInput: '1000000',
        }), {
            slot: 42,
            transaction: {
                signatures: [signature],
                message: { accountKeys: [sponsor, wallet, 'output-account', 'program'] },
            },
            meta: {
                err: null,
                fee: 5000,
                preBalances: [5_000_000, 10_000_000, 0, 1],
                postBalances: [2_955_720, 9_000_000, 2_039_280, 1],
                preTokenBalances: [],
                postTokenBalances: [balance(outputMint, wallet, '1000', 2)],
            },
        }, payloadHash)).toMatchObject({
            status: 'verified',
            inputAmount: '1000000',
            outputAmount: '1000',
        });
    });

    it('rejects misaligned, unsafe, payer-mismatched, and reward-contaminated SOL evidence', () => {
        const nativeTx = {
            slot: 42,
            transaction: {
                signatures: [signature],
                message: { accountKeys: [wallet, 'output-account'] },
            },
            meta: {
                err: null,
                fee: 5000,
                preBalances: [10_000_000, 0],
                postBalances: [8_995_000, 0],
                preTokenBalances: [],
                postTokenBalances: [balance(outputMint, wallet, '1000', 1)],
            },
        };
        const nativeInput = input({
            inputMint: WRAPPED_SOL_MINT,
            expectedInput: '1000000',
            providerInput: '1000000',
        });
        expect(() => decodeSettlement(nativeInput, {
            ...nativeTx,
            meta: { ...nativeTx.meta, postBalances: [8_995_000] },
        }, payloadHash)).toThrow(/aligned/);
        expect(() => decodeSettlement(nativeInput, {
            ...nativeTx,
            meta: { ...nativeTx.meta, preBalances: [Number.MAX_SAFE_INTEGER + 1, 0] },
        }, payloadHash)).toThrow(/unsafe/);
        expect(() => decodeSettlement({ ...nativeInput, feePayer: 'sponsor' }, nativeTx, payloadHash))
            .toThrow(/account key/);
        expect(() => decodeSettlement(nativeInput, {
            ...nativeTx,
            meta: { ...nativeTx.meta, rewards: [{ pubkey: wallet, lamports: 1 }] },
        }, payloadHash)).toThrow(/reward/);
    });
});
