import crypto from 'crypto';
import { DbQuery } from '../../config/database';
import { addressSchema, signatureSchema, u64Text } from '../../types';
import { AssetLedger } from '../assets/assetLedger';
import { canonicalJson } from './canonicalJson';
import { OrderProviderError, ProviderMoneyEvent, ProviderOrderSnapshot } from './provider';

type Row = Record<string, unknown>;
type Part = {
    role: 'input' | 'output' | 'movement';
    mint: string;
    amount: string;
};

type PreparedEvent = {
    event: ProviderMoneyEvent;
    parts: Part[];
    eventIdentity: Record<string, string>;
    eventHash: string;
    eventDoc: Record<string, unknown>;
    payloadHash: string;
};

const digest = (value: unknown): string => crypto.createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex');

const fail = (message: string): never => {
    throw new OrderProviderError('provider_contract_error', message, false);
};

const text = (value: unknown): string | undefined => (
    value === null || value === undefined ? undefined : String(value)
);

const exactU64 = (value: unknown, field: string): string => {
    const amount = u64Text(value);
    if (amount === undefined) return fail(`Order provider returned an invalid ${field}`);
    return amount;
};

const exactAmount = (value: unknown, field: string): string => {
    const amount = exactU64(value, field);
    if (amount === '0') fail(`Order provider returned an invalid ${field}`);
    return amount;
};

const exactAddress = (value: unknown, field: string): string => {
    const parsed = addressSchema.safeParse(value);
    if (!parsed.success) return fail(`Order provider returned an invalid ${field}`);
    return parsed.data;
};

const exactTime = (value: unknown): string => {
    const time = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
    if (Number.isNaN(time.valueOf())) fail('Order provider returned an invalid asset event time');
    return time.toISOString();
};

const eventParts = (
    event: ProviderMoneyEvent,
    inputMint: string,
    outputMint: string,
    inputAmount: string
): Part[] => {
    const mint = exactAddress(event.mint, 'asset event mint');
    const amount = exactAmount(event.amount, 'asset event amount');
    if (!signatureSchema.safeParse(event.signature).success) fail('Order provider returned an invalid asset signature');
    exactTime(event.occurredAt);

    if (event.type === 'deposit') {
        if (mint !== inputMint || amount !== inputAmount) {
            fail('Order provider deposit does not match the immutable order input');
        }
        return [{ role: 'movement', mint, amount }];
    }
    if (event.type === 'withdrawal') {
        if (mint !== inputMint && mint !== outputMint) {
            fail('Order provider withdrawal uses a mint outside the order');
        }
        return [{ role: 'movement', mint, amount }];
    }
    if (event.type !== 'fill' || mint !== inputMint) {
        fail('Order provider fill does not match the immutable order input');
    }
    const fillMint = exactAddress(event.outputMint, 'fill output mint');
    const fillAmount = exactAmount(event.outputAmount, 'fill output amount');
    if (fillMint !== outputMint) fail('Order provider fill does not match the immutable order output');
    return [
        { role: 'input', mint, amount },
        { role: 'output', mint: fillMint, amount: fillAmount },
    ];
};

const sameIdentity = (order: Row, snapshot: ProviderOrderSnapshot): {
    cluster: 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';
    wallet: string;
    vault: string;
    inputMint: string;
    outputMint: string;
    inputAmount: string;
} => {
    if (text(order.provider) === undefined || snapshot.orderType !== text(order.order_type)
        || text(order.provider_order_id) !== undefined
        && text(order.provider_order_id) !== snapshot.providerOrderId) {
        fail('Order provider history crosses the local provider order identity');
    }
    const cluster = text(order.cluster);
    if (!['mainnet-beta', 'devnet', 'testnet', 'localnet'].includes(cluster || '')) {
        fail('Local order has no financial cluster identity');
    }
    const wallet = exactAddress(snapshot.walletAddress, 'history wallet');
    const vault = exactAddress(snapshot.vaultAddress, 'history vault');
    const inputMint = exactAddress(snapshot.inputMint, 'history input mint');
    const outputMint = exactAddress(snapshot.outputMint, 'history output mint');
    const inputAmount = exactAmount(snapshot.inputAmount, 'history input amount');
    if (wallet !== text(order.wallet_address) || vault !== text(order.receiver_address)
        || inputMint !== text(order.input_mint) || outputMint !== text(order.output_mint)
        || inputAmount !== text(order.input_amount)) {
        fail('Order provider history crosses the immutable local financial identity');
    }
    return {
        cluster: cluster as 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet',
        wallet,
        vault,
        inputMint,
        outputMint,
        inputAmount,
    };
};

const verifyTotals = (
    snapshot: ProviderOrderSnapshot,
    events: ProviderMoneyEvent[],
    inputMint: string,
    outputMint: string,
    inputAmount: string
): void => {
    const deposits = events.filter((event) => event.type === 'deposit');
    if (deposits.length !== 1) {
        fail('Order provider history must contain exactly one successful deposit');
    }
    const fills = events.filter((event) => event.type === 'fill' && event.state === 'success');
    const used = fills.reduce((sum, event) => sum + BigInt(exactAmount(event.amount, 'fill input amount')), 0n);
    const output = fills.reduce((sum, event) => sum + BigInt(exactAmount(event.outputAmount, 'fill output amount')), 0n);
    const withdrawals = events.filter((event) => event.type === 'withdrawal');
    const inputWithdrawn = withdrawals
        .filter((event) => event.mint === inputMint)
        .reduce((sum, event) => sum + BigInt(exactAmount(event.amount, 'input withdrawal amount')), 0n);
    const outputWithdrawn = withdrawals
        .filter((event) => event.mint === outputMint)
        .reduce((sum, event) => sum + BigInt(exactAmount(event.amount, 'output withdrawal amount')), 0n);
    const reportedUsed = snapshot.inputUsed === undefined
        ? undefined : BigInt(exactU64(snapshot.inputUsed, 'aggregate input used'));
    const reportedOutput = snapshot.outputAmount === undefined
        ? undefined : BigInt(exactU64(snapshot.outputAmount, 'aggregate output amount'));
    if (reportedUsed !== undefined && reportedUsed !== used) {
        fail('Order provider aggregate input disagrees with its fill events');
    }
    if (reportedOutput !== undefined && reportedOutput !== output) {
        fail('Order provider aggregate output disagrees with its fill events');
    }
    if ((reportedUsed !== undefined && reportedUsed > 0n || reportedOutput !== undefined && reportedOutput > 0n)
        && fills.length === 0) {
        fail('Order provider aggregate fill has no movement event');
    }
    const remaining = BigInt(exactU64(snapshot.remainingInput, 'remaining input amount'));
    if (remaining + used !== BigInt(inputAmount)) {
        fail('Order provider remaining and filled input do not conserve the immutable deposit');
    }
    if (inputWithdrawn > remaining) {
        fail('Order provider withdrew more input than remains unfilled');
    }
    if (outputWithdrawn > output) {
        fail('Order provider withdrew more output than its successful fills produced');
    }

    if (snapshot.rawState === 'oco_cancelled') {
        fail('OCO cancellation requires grouped provider conservation evidence');
    }
    if (snapshot.state === 'filled') {
        if (remaining !== 0n || inputWithdrawn !== 0n || outputWithdrawn !== output) {
            fail('Filled provider order does not exactly conserve its terminal withdrawals');
        }
    } else if (['cancelled', 'expired', 'failed'].includes(snapshot.state)
        && (inputWithdrawn !== remaining || outputWithdrawn !== output)) {
        fail('Closed provider order does not exactly return every remaining asset');
    }
};

export class ProviderMoneySync {
    constructor(private readonly db: DbQuery) {}

    async ingest(order: Row, provider: string, snapshot: ProviderOrderSnapshot): Promise<number> {
        if (text(order.provider) !== provider) fail('Order provider history crosses the local adapter identity');
        const events = snapshot.moneyEvents;
        if (events === undefined) {
            if (snapshot.inputUsed !== undefined || snapshot.outputAmount !== undefined) {
                fail('Order provider aggregate fill omitted movement events');
            }
            return 0;
        }
        const identity = sameIdentity(order, snapshot);
        const seen = new Map<string, string>();
        const prepared: PreparedEvent[] = [];
        for (const event of events) {
            if (event.state !== 'success') continue;
            const parts = eventParts(event, identity.inputMint, identity.outputMint, identity.inputAmount);
            const eventIdentity = {
                provider,
                providerOrderId: snapshot.providerOrderId,
                type: event.type,
                signature: event.signature,
            };
            const eventHash = digest(eventIdentity);
            const eventDoc = {
                ver: 1,
                provider,
                providerOrderId: snapshot.providerOrderId,
                walletAddress: identity.wallet,
                vaultAddress: identity.vault,
                inputMint: identity.inputMint,
                outputMint: identity.outputMint,
                inputAmount: identity.inputAmount,
                event,
            };
            const payloadHash = digest(eventDoc);
            const existing = seen.get(eventHash);
            if (existing !== undefined) {
                if (existing !== payloadHash) fail('Order provider reused an asset event identity for different facts');
                continue;
            }
            seen.set(eventHash, payloadHash);
            prepared.push({ event, parts, eventIdentity, eventHash, eventDoc, payloadHash });
        }
        verifyTotals(
            snapshot,
            prepared.map((item) => item.event),
            identity.inputMint,
            identity.outputMint,
            identity.inputAmount
        );
        const ledger = new AssetLedger(this.db, async (work) => work(this.db));
        let claimed = 0;

        for (const { event, parts, eventIdentity, eventHash, eventDoc, payloadHash } of prepared) {
            const effectKey = `provider:${provider}:effect:${eventHash}`;
            const primary = parts[0];
            await ledger.claim({
                obligation: {
                    obligationKey: `provider:${provider}:claim:${eventHash}`,
                    orderId: String(order.id),
                    cluster: identity.cluster,
                    walletAddress: identity.wallet,
                    vaultAddress: identity.vault,
                    mint: primary.mint,
                    kind: event.type === 'deposit' ? 'deposit_unknown'
                        : event.type === 'fill' ? 'fill_unverified' : 'withdraw_unknown',
                    amount: primary.amount,
                    reason: `Provider reported ${event.type}; independent chain settlement is pending`,
                },
                parts: parts.map((part) => ({
                    ...part,
                    evidence: {
                        effectKey,
                        orderId: String(order.id),
                        cluster: identity.cluster,
                        walletAddress: identity.wallet,
                        vaultAddress: identity.vault,
                        mint: part.mint,
                        source: 'provider',
                        sourceKey: `provider:${provider}:part:${digest({
                            ...eventIdentity, role: part.role, mint: part.mint,
                        })}`,
                        rawState: event.state,
                        signature: event.signature,
                        payloadHash,
                        payload: eventDoc,
                        sourceAt: exactTime(event.occurredAt),
                    },
                })),
            });
            claimed += 1;
        }
        return claimed;
    }
}
