import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decodedTradeSchema, isDecodedTrade } from '../src/services/marketData/tradeEnricher';

const network = z.enum(['mainnet-beta', 'devnet', 'testnet', 'localnet']);
const address = z.string().refine((value) => {
    try {
        return bs58.decode(value).length === 32;
    } catch {
        return false;
    }
});
const signature = z.string().refine((value) => {
    try {
        return bs58.decode(value).length === 64;
    } catch {
        return false;
    }
});
const u64 = z.string().regex(/^(0|[1-9]\d*)$/).refine((value) => BigInt(value) <= 0xffff_ffff_ffff_ffffn);
const i64 = z.string().regex(/^-?(0|[1-9]\d*)$/).refine((value) => {
    const parsed = BigInt(value);
    return parsed >= -0x8000_0000_0000_0000n && parsed <= 0x7fff_ffff_ffff_ffffn;
});
const u32 = z.number().int().min(0).max(0xffff_ffff);
const balance = z.object({
    accountIndex: u32,
    mint: address,
    owner: address.nullable(),
    programId: address.nullable(),
    rawAmount: u64,
    decimals: z.number().int().min(0).max(0xff),
}).strict();
const bytes = z.array(z.number().int().min(0).max(255));
const schema = z.object({
    version: z.literal(1),
    signedId: z.object({ network, signature }).strict(),
    occurrence: z.object({
        network,
        slot: u64,
        blockId: address.nullable(),
        parentSlot: u64.nullable(),
        txIndex: u64.nullable(),
    }).strict(),
    observation: z.object({
        provider: z.string().regex(/^[a-z0-9_-]{1,32}$/),
        sourceEventId: z.string().trim().min(1).max(180),
        wireFormat: z.string().trim().min(1).max(40),
        wireVersion: z.number().int().min(1).max(0xffff),
        rawHash: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
    commitment: z.enum(['processed', 'confirmed', 'finalized']),
    observedAt: z.string().datetime({ offset: true }),
    error: bytes.min(1).nullable(),
    staticKeys: z.array(address).min(1),
    loadedWritable: z.array(address),
    loadedReadonly: z.array(address),
    instructions: z.array(z.object({
        outerIndex: u32,
        innerIndex: u32.nullable(),
        stackHeight: u32.nullable(),
        programIndex: u32,
        accounts: z.array(u32),
        data: bytes,
    }).strict()),
    preBalances: z.array(u64),
    postBalances: z.array(u64),
    preTokens: z.array(balance),
    postTokens: z.array(balance),
    fee: u64,
    computeUnits: u64.nullable(),
    blockTime: i64.nullable(),
    signedTx: bytes.min(1).nullable(),
}).strict().superRefine((value, context) => {
    if (value.signedId.network !== value.occurrence.network) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'identity networks differ' });
    }
    const keys = [...value.staticKeys, ...value.loadedWritable, ...value.loadedReadonly];
    if (keys.length > 256 || new Set(keys).size !== keys.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'account keys are invalid' });
    }
    if (value.preBalances.length !== keys.length || value.postBalances.length !== keys.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'balance vectors differ from account keys' });
    }
    if (value.instructions.some((ix) =>
        ix.programIndex >= keys.length
        || ix.accounts.some((index) => index >= keys.length)
        || (ix.innerIndex === null && ix.stackHeight !== null))) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'instruction account index is invalid' });
    }
    let nextOuter = 0;
    let activeOuter: number | null = null;
    let nextInner = 0;
    for (const ix of value.instructions) {
        if (ix.innerIndex === null && ix.outerIndex === nextOuter) {
            activeOuter = ix.outerIndex;
            nextOuter += 1;
            nextInner = 0;
        } else if (ix.innerIndex !== null && ix.outerIndex === activeOuter && ix.innerIndex === nextInner) {
            nextInner += 1;
        } else {
            context.addIssue({ code: z.ZodIssueCode.custom, message: 'instruction order is not canonical' });
            break;
        }
    }
    if ([...value.preTokens, ...value.postTokens].some((item) => item.accountIndex >= keys.length)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'token account index is invalid' });
    }
    for (const balances of [value.preTokens, value.postTokens]) {
        if (balances.some((item, index) => index > 0 && balances[index - 1].accountIndex >= item.accountIndex)) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: 'token balances are not canonically ordered' });
        }
    }
});

describe('FervorTx v1 contract', () => {
    it('reads the shared Rust/TypeScript fixture without widening the contract', () => {
        const fixture = JSON.parse(fs.readFileSync(
            path.resolve(__dirname, '../../tests/contracts/fervor-tx-v1.json'),
            'utf8'
        ));
        expect(schema.parse(fixture)).toEqual(fixture);
    });

    it('matches the decoded trade accepted by the TypeScript enricher', () => {
        const fixture = JSON.parse(fs.readFileSync(
            path.resolve(__dirname, '../../tests/contracts/decoded-trade-v2.json'),
            'utf8'
        ));
        expect(decodedTradeSchema.parse(fixture)).toEqual(fixture);
        expect(isDecodedTrade(fixture)).toBe(true);
    });

    it('rejects supply evidence from another transaction', () => {
        const fixture = JSON.parse(fs.readFileSync(
            path.resolve(__dirname, '../../tests/contracts/decoded-trade-v2.json'),
            'utf8'
        ));
        fixture.supply.signature = bs58.encode(Buffer.alloc(64, 8));
        expect(decodedTradeSchema.safeParse(fixture).success).toBe(false);
    });
});
