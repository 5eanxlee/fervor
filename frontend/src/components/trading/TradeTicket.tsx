'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import bs58 from 'bs58';
import { VersionedTransaction } from '@solana/web3.js';
import toast from 'react-hot-toast';
import {
    ChevronDownIcon,
    CurrencyDollarIcon,
    FireIcon,
    PencilSquareIcon,
    ShieldCheckIcon,
    UserGroupIcon,
    WalletIcon,
} from '@heroicons/react/24/outline';
import { useWallet } from '../../contexts/WalletContext';
import {
    apiService,
    ExecutionCapabilities,
    OrderCapabilities,
    OrderInput,
    OrderRecord,
    SwapQuote,
} from '../../services/api';
import type { ReplayParticipant, ReplayParticipants } from '../../services/replay';
import { SolanaMark } from './BrandMarks';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const toBytes = (base64: string): Uint8Array => {
    const binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const toBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
        const end = Math.min(index + 0x8000, bytes.length);
        for (let cursor = index; cursor < end; cursor += 1) {
            binary += String.fromCharCode(bytes[cursor]);
        }
    }
    return btoa(binary);
};

export const parseUnits = (value: string, decimals: number): string => {
    const normalized = value.trim();
    if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error('Enter a valid amount');
    const [whole, fraction = ''] = normalized.split('.');
    if (fraction.length > decimals) throw new Error(`Amount supports up to ${decimals} decimals`);
    const base = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
    if (BigInt(base) <= BigInt(0)) throw new Error('Amount must be greater than zero');
    return base;
};

export const parseFee = (value: string, maxLamports: number, label: string): number | undefined => {
    if (!value.trim()) return undefined;
    const lamports = Number(parseUnits(value, 9));
    if (!Number.isSafeInteger(lamports) || lamports > maxLamports) {
        throw new Error(`${label} exceeds the configured maximum`);
    }
    return lamports;
};

export const getLimitTrigger = (targetCap: number, currentCap: number, totalSupply: number) => {
    if (!Number.isFinite(targetCap) || targetCap <= 0) throw new Error('Enter a valid market cap target');
    if (!Number.isFinite(currentCap) || currentCap <= 0) throw new Error('Current market cap is unavailable');
    if (!Number.isFinite(totalSupply) || totalSupply <= 0) throw new Error('Token supply is unavailable');
    return {
        condition: targetCap >= currentCap ? 'above' as const : 'below' as const,
        price: targetCap / totalSupply,
    };
};

const signatureBytes = (value: Uint8Array | { signature: Uint8Array }): Uint8Array =>
    value instanceof Uint8Array ? value : value.signature;

const BUY_COLOR = 'var(--term-buy, #32dfb4)';
const SELL_COLOR = 'var(--term-sell, #ff2e78)';

const formatCap = (value: number): string => {
    if (!Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    const format = (scaled: number, suffix: string) => {
        const digits = scaled < 10 && Math.abs(scaled - Math.round(scaled)) >= 0.05 ? 1 : 0;
        return `${sign}${scaled.toFixed(digits)}${suffix}`;
    };
    if (abs >= 1_000_000_000) return format(abs / 1_000_000_000, 'B');
    if (abs >= 1_000_000) return format(abs / 1_000_000, 'M');
    if (abs >= 1_000) return format(abs / 1_000, 'K');
    return `${sign}${Math.round(abs)}`;
};

type StatTone = 'buy' | 'sell' | 'neutral';

export interface TicketFlow {
    volumeUsd?: number;
    buys?: number;
    sells?: number;
}

export interface TicketStat {
    label: string;
    value: string;
    tone: StatTone;
}

interface TokenStat extends TicketStat {
    icon: string;
}

interface WalletStat extends TicketStat {
    unit: 'sol' | 'token' | 'none';
}

const metric = (value?: number): number | undefined =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;

const formatMetric = (value?: number): string => value === undefined
    ? '—'
    : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value);

const formatUsd = (value?: number): string => value === undefined ? '—' : `$${formatMetric(value)}`;

const signedTone = (value?: number): StatTone => {
    if (value === undefined || value === 0) return 'neutral';
    return value > 0 ? 'buy' : 'sell';
};

const holderTone = (value?: number): StatTone => {
    if (value === undefined) return 'neutral';
    return value > 15 ? 'sell' : 'buy';
};

export const ticketFlowStats = (flow: TicketFlow = {}): TicketStat[] => {
    const volume = metric(flow.volumeUsd);
    const buys = metric(flow.buys);
    const sells = metric(flow.sells);
    const net = buys === undefined || sells === undefined ? undefined : buys - sells;
    return [
        { label: '5m Volume', value: formatUsd(volume), tone: 'neutral' },
        { label: 'Buys', value: formatMetric(buys), tone: 'buy' },
        { label: 'Sells', value: formatMetric(sells), tone: 'sell' },
        {
            label: 'Net trades',
            value: net === undefined ? '—' : `${net > 0 ? '+' : ''}${formatMetric(net)}`,
            tone: signedTone(net),
        },
    ];
};

const rawAmount = (value: string, decimals: number): number => Number(value) / 10 ** decimals;

interface TradeTicketProps {
    tokenMint: string;
    tokenSymbol: string;
    tokenDecimals?: number;
    defaultAmount?: string;
    defaultSlippage?: number;
    clearOnSuccess?: boolean;
    currentMarketCap?: number;
    currentPrice?: number;
    totalSupply?: number;
    flow?: TicketFlow;
    participants?: ReplayParticipants;
    replayMode?: boolean;
    onLimitChange?: (state: { active: boolean; marketCap?: number }) => void;
}

type Tab = 'market' | 'limit';
type OrderKind = 'limit' | 'trailing' | 'oco' | 'otoco';

export default function TradeTicket({
    tokenMint,
    tokenSymbol,
    tokenDecimals = 9,
    defaultAmount = '0.1',
    defaultSlippage = 100,
    clearOnSuccess = true,
    currentMarketCap,
    currentPrice,
    totalSupply = 1_000_000_000,
    flow,
    participants,
    replayMode = false,
    onLimitChange,
}: TradeTicketProps) {
    const wallet = useWallet();
    const [tab, setTab] = useState<Tab>('market');
    const [side, setSide] = useState<'buy' | 'sell'>('buy');
    const [amount, setAmount] = useState(defaultAmount);
    const [slippageBps, setSlippageBps] = useState(defaultSlippage);
    const [quote, setQuote] = useState<SwapQuote | null>(null);
    const [submitKey, setSubmitKey] = useState<string>();
    const [signedSwap, setSignedSwap] = useState<string>();
    const [executionMode, setExecutionMode] = useState<ExecutionCapabilities | null>(null);
    const [orderMode, setOrderMode] = useState<OrderCapabilities | null>(null);
    const [orders, setOrders] = useState<OrderRecord[]>([]);
    const [providerToken, setProviderToken] = useState<string>();
    const [triggerPrice, setTriggerPrice] = useState('');
    const [triggerCondition, setTriggerCondition] = useState<'above' | 'below'>('above');
    const [orderKind, setOrderKind] = useState<OrderKind>('limit');
    const [takeProfitPrice, setTakeProfitPrice] = useState('');
    const [stopLossPrice, setStopLossPrice] = useState('');
    const [trailingPercent, setTrailingPercent] = useState('5');
    const [landingMode, setLandingMode] = useState<'managed' | 'custom'>('managed');
    const [priorityFeeSol, setPriorityFeeSol] = useState('');
    const [jitoTipSol, setJitoTipSol] = useState('');
    const [busy, setBusy] = useState(false);
    const [editingOrder, setEditingOrder] = useState<string>();
    const [editPrimary, setEditPrimary] = useState('');
    const [editSecondary, setEditSecondary] = useState('');
    const [editTertiary, setEditTertiary] = useState('');
    const fallbackCap = Number.isFinite(currentPrice) && Number.isFinite(totalSupply)
        ? Number(currentPrice) * totalSupply
        : 0;
    const marketCap = Number.isFinite(currentMarketCap) && Number(currentMarketCap) > 0
        ? Number(currentMarketCap)
        : fallbackCap;
    const [limitCap, setLimitCap] = useState(() => marketCap > 0 ? String(Math.round(marketCap)) : '');
    const [executionOpen, setExecutionOpen] = useState(true);
    const [tokenInfoOpen, setTokenInfoOpen] = useState(true);
    const limitTouched = useRef(false);
    const limitMint = useRef(tokenMint);

    const inputMint = side === 'buy' ? SOL_MINT : tokenMint;
    const outputMint = side === 'buy' ? tokenMint : SOL_MINT;
    const inputDecimals = side === 'buy' ? 9 : tokenDecimals;
    const modeLabel = executionMode?.mode === 'live' ? 'Live' : 'Off';
    const flowStats = ticketFlowStats(flow);
    const buyCount = metric(flow?.buys);
    const sellCount = metric(flow?.sells);
    const flowCount = (buyCount ?? 0) + (sellCount ?? 0);
    const top10 = replayMode ? metric(participants?.top10Percent) : undefined;
    const tokenStats: TokenStat[] = [
        {
            icon: '♙',
            value: top10 === undefined ? '—' : `${top10.toFixed(2)}%`,
            label: replayMode ? 'Top 10 obs.' : 'Top 10 H.',
            tone: holderTone(top10),
        },
        { icon: '♔', value: '—', label: 'Dev H.', tone: 'neutral' },
        { icon: '⌖', value: '—', label: 'Snipers H.', tone: 'neutral' },
        { icon: '♙', value: '—', label: 'Insiders', tone: 'neutral' },
        { icon: '◫', value: '—', label: 'Bundlers', tone: 'neutral' },
        { icon: '♨', value: '—', label: 'LP Burned', tone: 'neutral' },
    ];
    const replayWallet: ReplayParticipant | undefined = replayMode && wallet.publicKey
        ? participants?.items.find((row) => row.wallet === wallet.publicKey)
        : undefined;
    const hasWalletStats = replayMode && wallet.connected && participants !== undefined;
    const walletStats: WalletStat[] = [
        {
            label: 'Bought',
            value: hasWalletStats ? formatMetric(replayWallet?.boughtSol ?? 0) : '—',
            tone: 'buy',
            unit: 'sol',
        },
        {
            label: 'Sold',
            value: hasWalletStats ? formatMetric(replayWallet?.soldSol ?? 0) : '—',
            tone: 'sell',
            unit: 'sol',
        },
        {
            label: replayMode ? 'Obs. balance' : 'Holding',
            value: hasWalletStats
                ? formatMetric(replayWallet
                    ? rawAmount(replayWallet.balanceRaw, participants?.tokenDecimals ?? tokenDecimals)
                    : 0)
                : '—',
            tone: 'neutral',
            unit: 'token',
        },
        { label: 'PnL', value: '—', tone: 'neutral', unit: 'none' },
    ];

    const refreshOrders = async () => {
        try {
            const response = await apiService.listOrders();
            if (response.data) setOrders(response.data);
        } catch {
            // The terminal remains usable when order history is unavailable.
        }
    };

    useEffect(() => {
        Promise.all([apiService.getExecutionCapabilities(), apiService.getOrderCapabilities()])
            .then(([execution, order]) => {
                setExecutionMode(execution.data || null);
                setOrderMode(order.data || null);
            })
            .catch(() => undefined);
        void refreshOrders();
    }, []);

    useEffect(() => {
        setQuote(null);
        setSubmitKey(undefined);
        setSignedSwap(undefined);
    }, [amount, inputMint, outputMint, slippageBps, landingMode, priorityFeeSol, jitoTipSol]);

    useEffect(() => setProviderToken(undefined), [wallet.publicKey]);

    useEffect(() => {
        setAmount(defaultAmount);
        setSlippageBps(defaultSlippage);
    }, [defaultAmount, defaultSlippage, tokenMint]);

    useEffect(() => {
        if (limitMint.current !== tokenMint) {
            limitMint.current = tokenMint;
            limitTouched.current = false;
            setLimitCap(marketCap > 0 ? String(Math.round(marketCap)) : '');
            return;
        }
        if (!limitTouched.current && !limitCap && marketCap > 0) {
            setLimitCap(String(Math.round(marketCap)));
        }
    }, [limitCap, marketCap, tokenMint]);

    const limitMarketCap = Number(limitCap);
    const validLimitCap = Number.isFinite(limitMarketCap) && limitMarketCap > 0;
    const limitPercent = marketCap > 0 && validLimitCap
        ? (limitMarketCap / marketCap - 1) * 100
        : 0;
    const automaticCondition: 'above' | 'below' = validLimitCap && limitMarketCap >= marketCap ? 'above' : 'below';

    useEffect(() => {
        setTriggerCondition(automaticCondition);
        onLimitChange?.({
            active: tab === 'limit' && validLimitCap,
            marketCap: validLimitCap ? limitMarketCap : undefined,
        });
    }, [automaticCondition, limitMarketCap, onLimitChange, tab, validLimitCap]);

    useEffect(() => () => onLimitChange?.({ active: false }), [onLimitChange]);

    const updateLimitCap = (value: string) => {
        limitTouched.current = true;
        setLimitCap(value);
    };

    const updateLimitPercent = (value: number) => {
        if (!Number.isFinite(value) || marketCap <= 0) return;
        const next = Math.max(1, marketCap * (1 + value / 100));
        updateLimitCap(String(Math.round(next)));
    };

    useEffect(() => {
        if (orderKind === 'trailing' || orderKind === 'oco') setSide('sell');
        if (orderKind === 'otoco') setSide('buy');
    }, [orderKind]);

    const ensureWallet = async () => {
        if (wallet.publicKey) return {
            publicKey: wallet.publicKey,
            signTransaction: wallet.signTransaction,
            signMessage: wallet.signMessage,
        };
        return wallet.connect();
    };

    const signTransaction = async (
        transaction: string,
        required: boolean,
        expectedSigner?: string,
        expectedFeePayer?: string
    ): Promise<string> => {
        if (!required) return transaction;
        const connection = await ensureWallet();
        if (!connection.signTransaction) throw new Error('Connected wallet does not support transaction signing');
        const decoded = VersionedTransaction.deserialize(toBytes(transaction));
        const signerKeys = decoded.message.staticAccountKeys
            .slice(0, decoded.message.header.numRequiredSignatures)
            .map((key) => key.toBase58());
        if (expectedSigner && !signerKeys.includes(expectedSigner)) {
            throw new Error('Provider transaction does not require the connected wallet signature');
        }
        if (expectedFeePayer && decoded.message.staticAccountKeys[0]?.toBase58() !== expectedFeePayer) {
            throw new Error('Provider transaction fee payer does not match the quote');
        }
        const signed = await connection.signTransaction(decoded);
        return toBase64((signed as VersionedTransaction).serialize());
    };

    const ensureProviderToken = async (): Promise<string | undefined> => {
        if (!orderMode?.requiresProviderAuth) return undefined;
        if (providerToken) return providerToken;
        const connection = await ensureWallet();
        const type = connection.signMessage ? 'message' : 'transaction';
        const challenge = await apiService.getOrderChallenge(connection.publicKey, type);
        if (!challenge.data || challenge.data.type !== type) {
            throw new Error(challenge.error || 'Order authorization failed');
        }
        const auth = challenge.data.type === 'message'
            ? {
                type: challenge.data.type,
                signature: bs58.encode(signatureBytes(await connection.signMessage!(
                    new TextEncoder().encode(challenge.data.challenge),
                    'utf8'
                ))),
            }
            : {
                type: challenge.data.type,
                signedTransaction: await signTransaction(
                    challenge.data.transaction,
                    true,
                    connection.publicKey
                ),
            };
        const verified = await apiService.verifyOrderProvider(connection.publicKey, auth);
        if (!verified.data?.token) throw new Error(verified.error || 'Order authorization failed');
        setProviderToken(verified.data.token);
        return verified.data.token;
    };

    const previewSwap = async () => {
        setBusy(true);
        try {
            const connection = await ensureWallet();
            const customFees = landingMode === 'custom' ? {
                priorityFeeLamports: parseFee(
                    priorityFeeSol,
                    executionMode?.maxPriorityFeeLamports ?? 0,
                    'Priority fee'
                ),
                jitoTipLamports: parseFee(
                    jitoTipSol,
                    executionMode?.maxJitoTipLamports ?? 0,
                    'Jito tip'
                ),
                broadcastFeeType: 'maxCap' as const,
            } : {};
            if (landingMode === 'custom' && !customFees.priorityFeeLamports && !customFees.jitoTipLamports) {
                throw new Error('Set a priority fee or Jito tip');
            }
            const response = await apiService.createSwapQuote({
                inputMint,
                outputMint,
                inputAmount: parseUnits(amount, inputDecimals),
                taker: connection.publicKey,
                slippageBps,
                ...customFees,
            });
            if (!response.data) throw new Error(response.error || 'No route is available');
            if (response.data.inputMint !== inputMint || response.data.outputMint !== outputMint
                || response.data.inputAmount !== parseUnits(amount, inputDecimals)
                || response.data.taker !== connection.publicKey) {
                throw new Error('Quote does not match the requested trade');
            }
            setQuote(response.data);
            setSubmitKey(crypto.randomUUID());
            setSignedSwap(undefined);
        } catch (error: any) {
            toast.error(error.error || error.message || 'Quote failed');
        } finally {
            setBusy(false);
        }
    };

    const submitSwap = async () => {
        if (!quote || !submitKey) return;
        setBusy(true);
        try {
            if (!signedSwap && new Date(quote.expiresAt).getTime() <= Date.now()) {
                throw new Error('Quote expired. Preview again.');
            }
            const signed = signedSwap || await signTransaction(
                quote.transaction,
                quote.requiresSignature,
                quote.taker,
                quote.feePayer
            );
            setSignedSwap(signed);
            const response = await apiService.submitSwap(quote.id, signed, submitKey);
            if (!response.data) throw new Error(response.error || 'Submission failed');
            if (response.data.state === 'failed') throw new Error(response.data.errorMessage || 'Transaction failed');
            toast.success(response.data.state === 'confirmed' ? 'Trade confirmed' : 'Trade submitted');
            if (clearOnSuccess && response.data.state === 'confirmed') setAmount('');
            setQuote(null);
            setSubmitKey(undefined);
            setSignedSwap(undefined);
        } catch (error: any) {
            toast.error(error.error || error.message || 'Trade failed');
        } finally {
            setBusy(false);
        }
    };

    const createOrder = async () => {
        setBusy(true);
        try {
            const connection = await ensureWallet();
            const token = await ensureProviderToken();
            const common = {
                walletAddress: connection.publicKey,
                inputMint,
                outputMint,
                inputAmount: parseUnits(amount, inputDecimals),
                expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
                clientOrderId: crypto.randomUUID(),
            };
            let input: OrderInput;
            if (orderKind === 'limit') {
                const trigger = getLimitTrigger(limitMarketCap, marketCap, Number(totalSupply));
                input = {
                    ...common,
                    orderType: 'single',
                    triggerMint: side === 'buy' ? outputMint : inputMint,
                    triggerCondition: trigger.condition,
                    triggerPriceUsd: trigger.price,
                    slippageBps,
                };
            } else if (orderKind === 'trailing') {
                const percent = Number(trailingPercent);
                if (!Number.isFinite(percent) || percent < 0.5 || percent > 90) {
                    throw new Error('Trailing distance must be between 0.5% and 90%');
                }
                input = {
                    ...common,
                    orderType: 'single',
                    triggerMint: inputMint,
                    triggerCondition: 'below',
                    trailingBps: Math.round(percent * 100),
                    slippageBps,
                };
            } else if (orderKind === 'oco') {
                const takeProfit = Number(takeProfitPrice);
                const stopLoss = Number(stopLossPrice);
                if (!Number.isFinite(takeProfit) || !Number.isFinite(stopLoss)
                    || takeProfit <= 0 || stopLoss <= 0 || takeProfit <= stopLoss) {
                    throw new Error('Take profit must be above stop loss');
                }
                input = {
                    ...common,
                    orderType: 'oco',
                    triggerMint: inputMint,
                    takeProfitPriceUsd: takeProfit,
                    stopLossPriceUsd: stopLoss,
                    takeProfitSlippageBps: slippageBps,
                    stopLossSlippageBps: slippageBps,
                };
            } else {
                const trigger = Number(triggerPrice);
                const takeProfit = Number(takeProfitPrice);
                const stopLoss = Number(stopLossPrice);
                if (!Number.isFinite(trigger) || trigger <= 0) {
                    throw new Error('Enter a valid trigger price');
                }
                if (!Number.isFinite(takeProfit) || !Number.isFinite(stopLoss)
                    || takeProfit <= 0 || stopLoss <= 0 || takeProfit <= stopLoss) {
                    throw new Error('Take profit must be above stop loss');
                }
                input = {
                    ...common,
                    orderType: 'otoco',
                    triggerMint: outputMint,
                    triggerCondition,
                    triggerPriceUsd: trigger,
                    takeProfitPriceUsd: takeProfit,
                    stopLossPriceUsd: stopLoss,
                    slippageBps,
                    takeProfitSlippageBps: slippageBps,
                    stopLossSlippageBps: slippageBps,
                };
            }
            const prepared = await apiService.prepareOrder(input, token);
            if (!prepared.data) throw new Error(prepared.error || 'Order preparation failed');
            const signed = await signTransaction(
                prepared.data.transaction,
                prepared.data.custody !== 'none',
                connection.publicKey
            );
            const active = await apiService.activateOrder(prepared.data.orderId, signed, token);
            if (!active.data) throw new Error(active.error || 'Order activation failed');
            toast.success('Order active');
            await refreshOrders();
        } catch (error: any) {
            if (error.code === 'provider_auth_expired') setProviderToken(undefined);
            toast.error(error.error || error.message || 'Order failed');
        } finally {
            setBusy(false);
        }
    };

    const cancelOrder = async (order: OrderRecord) => {
        setBusy(true);
        try {
            const connection = await ensureWallet();
            const token = await ensureProviderToken();
            const prepared = await apiService.prepareCancelOrder(order.id, token);
            if (!prepared.data) throw new Error(prepared.error || 'Cancellation failed');
            const signed = await signTransaction(
                prepared.data.transaction,
                orderMode?.custody !== 'none',
                connection.publicKey
            );
            const cancelled = await apiService.confirmCancelOrder(
                order.id, prepared.data.requestId, signed, token
            );
            if (!cancelled.data) throw new Error(cancelled.error || 'Cancellation failed');
            toast.success('Order cancelled');
            await refreshOrders();
        } catch (error: any) {
            toast.error(error.error || error.message || 'Cancellation failed');
        } finally {
            setBusy(false);
        }
    };

    const syncOrders = async () => {
        setBusy(true);
        try {
            const token = await ensureProviderToken();
            const response = await apiService.syncOrders(token);
            if (!response.data) throw new Error(response.error || 'Order sync failed');
            setOrders(response.data);
            toast.success('Orders synced');
        } catch (error: any) {
            if (error.code === 'provider_auth_expired') setProviderToken(undefined);
            toast.error(error.error || error.message || 'Order sync failed');
        } finally {
            setBusy(false);
        }
    };

    const beginOrderEdit = (order: OrderRecord) => {
        setEditingOrder(order.id);
        if (order.orderType === 'otoco') {
            setEditPrimary(String(order.params.triggerPriceUsd || ''));
            setEditSecondary(String(order.params.takeProfitPriceUsd || ''));
            setEditTertiary(String(order.params.stopLossPriceUsd || ''));
        } else if (order.orderType === 'oco') {
            setEditPrimary(String(order.params.takeProfitPriceUsd || ''));
            setEditSecondary(String(order.params.stopLossPriceUsd || ''));
            setEditTertiary('');
        } else if (order.params.trailingBps) {
            setEditPrimary(String(Number(order.params.trailingBps) / 100));
            setEditSecondary('');
            setEditTertiary('');
        } else {
            setEditPrimary(String(order.params.triggerPriceUsd || ''));
            setEditSecondary('');
            setEditTertiary('');
        }
    };

    const updateOrder = async (order: OrderRecord) => {
        setBusy(true);
        try {
            const token = await ensureProviderToken();
            const primary = Number(editPrimary);
            if (!Number.isFinite(primary) || primary <= 0) throw new Error('Enter a valid value');
            const input = order.orderType === 'otoco'
                ? {
                    orderType: 'otoco' as const,
                    triggerPriceUsd: primary,
                    takeProfitPriceUsd: Number(editSecondary),
                    stopLossPriceUsd: Number(editTertiary),
                }
                : order.orderType === 'oco'
                ? {
                    orderType: 'oco' as const,
                    takeProfitPriceUsd: primary,
                    stopLossPriceUsd: Number(editSecondary),
                }
                : order.params.trailingBps
                    ? { orderType: 'single' as const, trailingBps: Math.round(primary * 100) }
                    : { orderType: 'single' as const, triggerPriceUsd: primary };
            if ((input.orderType === 'oco' || input.orderType === 'otoco')
                && (!Number.isFinite(input.takeProfitPriceUsd)
                    || !Number.isFinite(input.stopLossPriceUsd)
                    || input.takeProfitPriceUsd <= input.stopLossPriceUsd)) {
                throw new Error('Take profit must be above stop loss');
            }
            const response = await apiService.updateOrder(order.id, input, token);
            if (!response.data) throw new Error(response.error || 'Order update failed');
            setEditingOrder(undefined);
            await refreshOrders();
            toast.success('Order updated');
        } catch (error: any) {
            if (error.code === 'provider_auth_expired') setProviderToken(undefined);
            toast.error(error.error || error.message || 'Order update failed');
        } finally {
            setBusy(false);
        }
    };

    const openOrders = useMemo(() => orders.filter((order) =>
        ['preparing', 'prepared', 'activating', 'open', 'executing', 'partially_filled', 'cancel_pending'].includes(order.state)
    ), [orders]);

    return (
        <aside className="flex h-full min-h-0 flex-col bg-[var(--term-bg)] text-[clamp(.7rem,.76vw,.78rem)] text-[var(--term-muted)]">
            <section className="shrink-0 border-b border-[var(--term-border)] px-[clamp(.75rem,1.15vw,1.25rem)] py-3">
                <div className="grid grid-cols-4 gap-[clamp(.35rem,.8vw,.9rem)]">
                    {flowStats.map(({ label, value, tone }) => (
                        <div key={label} className="min-w-0">
                            <div className="truncate text-[clamp(.61rem,.75vw,.74rem)] text-[var(--term-muted)]">{label}</div>
                            <div
                                className="mt-1 truncate text-[clamp(.7rem,.84vw,.86rem)] font-medium"
                                style={{ color: tone === 'buy' ? BUY_COLOR : tone === 'sell' ? SELL_COLOR : 'var(--term-text)' }}
                            >
                                {value}
                            </div>
                        </div>
                    ))}
                </div>
                <div className="mt-2.5 flex h-[3px] gap-1.5 overflow-hidden rounded-full bg-[var(--term-border)]">
                    {flowCount > 0 && <>
                        <span className="h-full basis-0 rounded-full transition-[flex-grow]" style={{ background: BUY_COLOR, flexGrow: buyCount ?? 0 }} />
                        <span className="h-full basis-0 rounded-full transition-[flex-grow]" style={{ background: SELL_COLOR, flexGrow: sellCount ?? 0 }} />
                    </>}
                </div>
            </section>

            <div className="min-h-0 flex-1 overflow-y-auto">
                <section className="border-b border-[var(--term-border)] px-[clamp(.75rem,1.15vw,1.25rem)] py-3">
                    <div className="flex items-center gap-2">
                        <div className="grid min-w-0 flex-1 grid-cols-2 rounded-[1rem] border border-[var(--term-border)] bg-[var(--term-raised)] p-1">
                            {(['buy', 'sell'] as const).map((value) => {
                                const selected = side === value;
                                const disabled = tab === 'limit' && (((orderKind === 'trailing' || orderKind === 'oco') && value === 'buy') || (orderKind === 'otoco' && value === 'sell'));
                                return (
                                    <button
                                        key={value}
                                        disabled={disabled}
                                        onClick={() => setSide(value)}
                                        className="h-9 rounded-[.72rem] text-[clamp(.72rem,.85vw,.88rem)] font-semibold capitalize transition disabled:cursor-not-allowed disabled:opacity-30"
                                        style={selected ? { background: value === 'buy' ? BUY_COLOR : SELL_COLOR, color: '#0e0f12' } : { color: 'var(--term-text)' }}
                                    >
                                        {value}
                                    </button>
                                );
                            })}
                        </div>
                        <button
                            type="button"
                            onClick={() => setExecutionOpen((value) => !value)}
                            aria-label={executionOpen ? 'Collapse execution menu' : 'Expand execution menu'}
                            aria-expanded={executionOpen}
                            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-[var(--term-border)] bg-[var(--term-raised)] text-[var(--term-text)] hover:border-[var(--term-border-strong)]"
                        >
                            <ChevronDownIcon className={`h-4 w-4 transition-transform ${executionOpen ? '' : '-rotate-90'}`} />
                        </button>
                    </div>
                </section>

                {executionOpen && <>
                <section className="border-b border-[var(--term-border)]">
                    <div className="flex min-w-0 items-center px-[clamp(.75rem,1.15vw,1.25rem)]">
                        {([
                            ['market', 'Market'],
                            ['limit', 'Limit'],
                        ] as [Tab, string][]).map(([value, label]) => (
                            <button
                                key={value}
                                onClick={() => {
                                    setTab(value);
                                    if (value === 'limit') setOrderKind('limit');
                                }}
                                className={`relative mr-[clamp(.8rem,2vw,1.8rem)] h-11 text-[clamp(.68rem,.82vw,.84rem)] font-medium ${tab === value ? 'text-[var(--term-text)]' : 'text-[var(--term-muted)] hover:text-[var(--term-text)]'}`}
                            >
                                {label}
                                {tab === value && <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-[var(--term-text)]" />}
                            </button>
                        ))}
                        <button className="ml-auto flex h-8 max-w-[46%] items-center gap-1.5 rounded-full border border-[var(--term-border)] bg-[var(--term-raised)] px-2.5 text-[var(--term-text)]">
                            <WalletIcon className="h-4 w-4 shrink-0 text-[var(--term-muted)]" />
                            <span className="truncate">{wallet.walletName ? '1' : '0'}</span>
                            <SolanaMark className="h-4 w-4 shrink-0" />
                            <span className="truncate">{wallet.publicKey ? '1.655' : '0.000'}</span>
                        </button>
                    </div>
                </section>

                <div className="px-[clamp(.75rem,1.15vw,1.25rem)] py-4">
                    <div className="overflow-hidden rounded-lg border border-[var(--term-border)] bg-[var(--term-raised)]">
                                <label className="flex h-[3.35rem] items-center px-3 focus-within:bg-[var(--term-control)]/40">
                                    <span className="text-[clamp(.67rem,.8vw,.8rem)] font-medium uppercase text-[var(--term-muted)]">Amount</span>
                                    <input
                                        value={amount}
                                        onChange={(event) => setAmount(event.target.value)}
                                        inputMode="decimal"
                                        aria-label="Trade total"
                                        placeholder="0.0"
                                        className="min-w-0 flex-1 border-0 bg-transparent px-2 text-left text-[clamp(.72rem,.9vw,.9rem)] text-[var(--term-text)] outline-none placeholder:text-[var(--term-muted)] focus:ring-0"
                                    />
                                    {side === 'buy' ? <SolanaMark className="h-[1.125rem] w-[1.125rem] shrink-0" /> : <span className="max-w-16 truncate font-medium text-[var(--term-text)]">{tokenSymbol}</span>}
                                </label>
                                <div className="grid grid-cols-5 border-t border-[var(--term-border)]">
                                    {['0.1', '0.2', '0.3', '1'].map((value) => (
                                        <button
                                            key={value}
                                            onClick={() => setAmount(value)}
                                            className="h-10 border-r border-[var(--term-border)] text-[clamp(.68rem,.82vw,.82rem)] text-[var(--term-text)] transition hover:bg-[var(--term-control)]"
                                        >
                                            {value}
                                        </button>
                                    ))}
                                    <button className="grid h-10 place-items-center text-[var(--term-text)] transition hover:bg-[var(--term-control)]" aria-label="Edit presets">
                                        <PencilSquareIcon className="h-4 w-4" />
                                    </button>
                                </div>
                    </div>

                    <div className="mt-3 flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[clamp(.61rem,.74vw,.74rem)] text-[var(--term-muted)]">
                                <button title={`Execution: ${modeLabel}`} className="hover:text-[var(--term-text)]">♨ {Math.max(0, 100 - slippageBps / 100).toFixed(0)}%</button>
                                <span className="h-3.5 w-px bg-[var(--term-border)]" />
                                <button onClick={() => setLandingMode((value) => value === 'managed' ? 'custom' : 'managed')} className="hover:text-[var(--term-text)]">⛽ 0.005</button>
                                <span className="h-3.5 w-px bg-[var(--term-border)]" />
                                <span>◉ 0.005</span>
                                <span className="h-3.5 w-px bg-[var(--term-border)]" />
                                <button onClick={() => setSlippageBps((value) => value >= 2_000 ? 100 : value + 100)} className="hover:text-[var(--term-text)]">◇ {modeLabel === 'Off' ? 'Off' : 'On'}</button>
                    </div>

                    {tab === 'market' && (
                        <div className="mt-8">
                            {landingMode === 'custom' && (
                                <div className="mb-3 grid grid-cols-2 gap-2">
                                    <label className="text-[10px] uppercase tracking-wider text-[var(--term-dim)]">
                                        Priority SOL
                                        <input value={priorityFeeSol} onChange={(event) => setPriorityFeeSol(event.target.value)} placeholder="0.001" inputMode="decimal" className="mt-1 h-9 w-full rounded-lg border border-[var(--term-border)] bg-[var(--term-raised)] px-2 text-right text-xs normal-case tracking-normal text-white outline-none" />
                                    </label>
                                    <label className="text-[10px] uppercase tracking-wider text-[var(--term-dim)]">
                                        Jito tip SOL
                                        <input value={jitoTipSol} onChange={(event) => setJitoTipSol(event.target.value)} placeholder="0.00001" inputMode="decimal" className="mt-1 h-9 w-full rounded-lg border border-[var(--term-border)] bg-[var(--term-raised)] px-2 text-right text-xs normal-case tracking-normal text-white outline-none" />
                                    </label>
                                </div>
                            )}
                            {quote && (
                                <div className="mb-3 space-y-2 rounded-lg border border-[var(--term-border)] bg-[var(--term-raised)] p-3 text-xs text-[var(--term-text)]">
                                    <div className="flex justify-between"><span className="text-[var(--term-dim)]">Expected</span><span>{quote.outputAmount} base units</span></div>
                                    <div className="flex justify-between"><span className="text-[var(--term-dim)]">Minimum</span><span>{quote.minOutputAmount}</span></div>
                                    <div className="flex justify-between"><span className="text-[var(--term-dim)]">Route</span><span className="max-w-[180px] truncate">{quote.route.map((route) => route.venue).join(' → ') || quote.provider}</span></div>
                                    {quote.fees.priorityLamports && <div className="flex justify-between"><span className="text-[var(--term-dim)]">Priority fee</span><span>{quote.fees.priorityLamports} lamports</span></div>}
                                </div>
                            )}
                            <button
                                disabled={busy || !executionMode?.canQuote}
                                onClick={quote ? submitSwap : previewSwap}
                                className="h-12 w-full rounded-full text-[clamp(.78rem,.94vw,.98rem)] font-semibold text-[#0e0f12] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
                                style={{ background: side === 'buy' ? BUY_COLOR : SELL_COLOR }}
                            >
                                {busy ? 'Working…' : signedSwap ? 'Retry Submit' : quote ? 'Sign & Submit' : executionMode?.canQuote ? `${side === 'buy' ? 'Buy' : 'Sell'} ${tokenSymbol}` : 'Trading Disabled'}
                            </button>
                        </div>
                    )}

                    {tab === 'limit' && (
                        <div className="mt-6">
                            <label className="flex h-[3.55rem] items-center overflow-hidden rounded-lg border border-[var(--term-border)] bg-[var(--term-raised)] px-3 focus-within:border-[var(--term-border-strong)]">
                                <span className="shrink-0 text-[clamp(.68rem,.78vw,.78rem)] font-medium uppercase text-[var(--term-muted)]">MKT CAP</span>
                                <input
                                    value={limitCap}
                                    onChange={(event) => updateLimitCap(event.target.value)}
                                    inputMode="numeric"
                                    aria-label="Limit order market cap"
                                    className="min-w-0 flex-1 border-0 bg-transparent px-3 text-[clamp(.72rem,.88vw,.9rem)] font-medium tabular-nums text-[var(--term-text)] outline-none focus:ring-0"
                                />
                                <span className="text-base text-[var(--term-text)]">$</span>
                            </label>

                            <div className="mt-5 grid grid-cols-[minmax(0,1fr)_4.25rem] items-start gap-3">
                                <div className="min-w-0 pt-1">
                                    <div className="relative px-1">
                                        <div className="pointer-events-none absolute inset-x-1 top-1/2 h-px -translate-y-1/2 bg-[var(--term-border-strong)]" />
                                        <div className="pointer-events-none absolute inset-x-1 top-1/2 flex -translate-y-1/2 justify-between">
                                            {[0, 1, 2, 3, 4].map((tick) => <span key={tick} className="h-1.5 w-1 rounded-sm bg-[var(--term-muted)]" />)}
                                        </div>
                                        <input
                                            type="range"
                                            min="-100"
                                            max="100"
                                            step="1"
                                            value={Math.max(-100, Math.min(100, limitPercent))}
                                            onChange={(event) => updateLimitPercent(Number(event.target.value))}
                                            className="limit-range relative z-[1] w-full"
                                            aria-label="Limit order market cap percentage"
                                        />
                                    </div>
                                    <div className="mt-2 flex justify-between text-[clamp(.58rem,.68vw,.68rem)] tabular-nums text-[var(--term-muted)]">
                                        <span>-100%</span><span>-50%</span><span>0%</span><span>+50%</span><span>+100%</span>
                                    </div>
                                </div>
                                <label className="flex h-10 items-center overflow-hidden rounded-lg border border-[var(--term-border-strong)] bg-[var(--term-bg)] px-2 text-[var(--term-text)]">
                                    <input
                                        value={Number.isFinite(limitPercent) ? Math.round(limitPercent) : 0}
                                        onChange={(event) => updateLimitPercent(Number(event.target.value))}
                                        inputMode="decimal"
                                        aria-label="Limit order percentage"
                                        className="min-w-0 flex-1 border-0 bg-transparent text-center tabular-nums outline-none focus:ring-0"
                                    />
                                    <span>%</span>
                                </label>
                            </div>

                            {orderMode?.custody === 'third_party_vault' && <p className="mt-3 text-xs leading-5 text-amber-200/80">Funds move to the configured third-party execution vault while this order is open.</p>}
                            <button disabled={busy || !orderMode?.canPrepare || !validLimitCap || marketCap <= 0} onClick={createOrder} className="mt-10 h-12 w-full rounded-full text-[clamp(.78rem,.94vw,.98rem)] font-semibold text-[#0f0f12] disabled:opacity-40" style={{ background: side === 'buy' ? BUY_COLOR : SELL_COLOR }}>{busy ? 'Working…' : `${side === 'buy' ? 'Buy' : 'Sell'} @ ${formatCap(limitMarketCap)} MC`}</button>
                            {openOrders.length > 0 && (
                                <div className="mt-5 border-t border-[var(--term-border)] pt-4">
                                    <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wider text-[var(--term-dim)]"><span>Open orders</span><button disabled={busy} onClick={syncOrders} className="normal-case text-[var(--term-accent)] hover:text-white">Sync</button></div>
                                    <div className="space-y-2">
                                        {openOrders.slice(0, 6).map((order) => (
                                            <div key={order.id} className="rounded-lg border border-[var(--term-border)] p-2 text-xs">
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="min-w-0"><div className="truncate text-white">{
                                                        order.params.trailingBps
                                                            ? `Trailing ${Number(order.params.trailingBps) / 100}%`
                                                            : order.orderType === 'otoco'
                                                                ? `Entry $${String(order.params.triggerPriceUsd)} · TP $${String(order.params.takeProfitPriceUsd)} · SL $${String(order.params.stopLossPriceUsd)}`
                                                                : order.orderType === 'oco'
                                                                    ? `TP $${String(order.params.takeProfitPriceUsd)} · SL $${String(order.params.stopLossPriceUsd)}`
                                                                    : `${String(order.params.triggerCondition)} · $${String(order.params.triggerPriceUsd)}`
                                                    }</div><div className="mt-1 text-[var(--term-dim)]">{order.state}</div></div>
                                                    <div className="flex gap-1">
                                                        {order.state === 'open' && <button disabled={busy} onClick={() => beginOrderEdit(order)} className="rounded-md border border-[var(--term-border-strong)] px-2 py-1 text-[var(--term-muted)]">Edit</button>}
                                                        {['open', 'expired', 'cancel_pending'].includes(order.state) && <button disabled={busy} onClick={() => cancelOrder(order)} className="rounded-md border border-rose-500/40 px-2 py-1 text-rose-300">Cancel</button>}
                                                    </div>
                                                </div>
                                                {editingOrder === order.id && (
                                                    <div className="mt-2 flex gap-1 border-t border-[var(--term-border)] pt-2">
                                                        <input value={editPrimary} onChange={(event) => setEditPrimary(event.target.value)} inputMode="decimal" aria-label={order.orderType === 'oco' ? 'Take profit price' : order.orderType === 'otoco' ? 'Entry price' : order.params.trailingBps ? 'Trailing percent' : 'Trigger price'} className="h-8 min-w-0 flex-1 rounded-md bg-[var(--term-raised)] px-2 text-right text-white" />
                                                        {(order.orderType === 'oco' || order.orderType === 'otoco') && <input value={editSecondary} onChange={(event) => setEditSecondary(event.target.value)} inputMode="decimal" aria-label={order.orderType === 'otoco' ? 'Take profit price' : 'Stop loss price'} className="h-8 min-w-0 flex-1 rounded-md bg-[var(--term-raised)] px-2 text-right text-white" />}
                                                        {order.orderType === 'otoco' && <input value={editTertiary} onChange={(event) => setEditTertiary(event.target.value)} inputMode="decimal" aria-label="Stop loss price" className="h-8 min-w-0 flex-1 rounded-md bg-[var(--term-raised)] px-2 text-right text-white" />}
                                                        <button disabled={busy} onClick={() => updateOrder(order)} className="rounded-md bg-[var(--term-accent)] px-2 text-[#0f0f12]">Save</button>
                                                        <button disabled={busy} onClick={() => setEditingOrder(undefined)} className="rounded-md px-2 text-[var(--term-muted)]">×</button>
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                </div>

                <section className="grid grid-cols-4 border-y border-[var(--term-border)] px-[clamp(.35rem,.7vw,.75rem)] py-2.5">
                    {walletStats.map(({ label, value, tone, unit }, index) => (
                        <div key={label} className={`min-w-0 px-1.5 text-center ${index > 0 ? 'border-l border-[var(--term-border)]' : ''}`}>
                            <div className="truncate text-[var(--term-muted)]">{label}</div>
                            <div className="mt-1 flex items-center justify-center gap-1 truncate" style={{ color: tone === 'buy' ? BUY_COLOR : tone === 'sell' ? SELL_COLOR : 'var(--term-text)' }}>
                                {unit === 'sol' && value !== '—' && <SolanaMark className="h-3.5 w-3.5 shrink-0" />}
                                {unit === 'token' && value !== '—' && <span className="shrink-0 text-[.58rem] text-[var(--term-dim)]">{tokenSymbol}</span>}
                                {value}
                            </div>
                        </div>
                    ))}
                </section>

                <section className="flex items-center gap-1 border-b border-[var(--term-border)] px-[clamp(.75rem,1.15vw,1.25rem)] py-2">
                    {['PRESET 1', 'PRESET 2', 'PRESET 3'].map((preset, index) => (
                        <button key={preset} className={`h-8 flex-1 rounded-lg text-[clamp(.65rem,.78vw,.78rem)] font-medium ${index === 0 ? 'bg-[var(--term-accent)]/15 text-[var(--term-accent)]' : 'text-[var(--term-text)] hover:bg-[var(--term-raised)]'}`}>{preset}</button>
                    ))}
                    <button aria-label="Hot preset" className="ml-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--term-border)] bg-[var(--term-control)] text-[var(--term-accent)]"><FireIcon className="h-4 w-4" /></button>
                </section>
                </>}

                <section className="px-[clamp(.75rem,1.15vw,1.25rem)] py-4">
                    <div className="flex items-center text-[clamp(.78rem,.9vw,.92rem)] font-medium text-[var(--term-text)]">
                        <button type="button" onClick={() => setTokenInfoOpen((value) => !value)} className="flex items-center text-left" aria-expanded={tokenInfoOpen}>
                            Token Info <ChevronDownIcon className={`ml-1.5 h-3.5 w-3.5 transition-transform ${tokenInfoOpen ? '' : '-rotate-90'}`} />
                        </button>
                        <span className="ml-auto text-[.6rem] text-[var(--term-dim)]">{replayMode ? 'Replay cut' : 'Verified only'}</span>
                    </div>
                    {tokenInfoOpen && <>
                    <div className="mt-3 grid grid-cols-3 gap-2">
                        {tokenStats.map(({ icon, value, label, tone }) => (
                            <div key={label} title={value === '—' ? 'Unavailable from verified source data' : undefined} className="rounded-lg border border-[var(--term-border)] px-1.5 py-2.5 text-center">
                                <div className="truncate text-[clamp(.68rem,.82vw,.84rem)]" style={{ color: tone === 'buy' ? BUY_COLOR : tone === 'sell' ? SELL_COLOR : 'var(--term-muted)' }}>{icon} {value}</div>
                                <div className="mt-1.5 truncate text-[clamp(.58rem,.7vw,.7rem)] text-[var(--term-muted)]">{label}</div>
                            </div>
                        ))}
                    </div>

                    <div className="my-4 h-px bg-[var(--term-border)]" />
                    <div className="grid grid-cols-3 gap-2">
                        <div className="rounded-lg border border-[var(--term-border)] px-1.5 py-2.5 text-center">
                            <div className="flex items-center justify-center gap-1.5 text-[var(--term-text)]"><UserGroupIcon className="h-4 w-4" />{replayMode ? formatMetric(participants?.holderCount) : '—'}</div>
                            <div className="mt-1.5 truncate text-[clamp(.58rem,.7vw,.7rem)] text-[var(--term-muted)]">{replayMode ? 'Obs. holders' : 'Holders'}</div>
                        </div>
                        <div className="rounded-lg border border-[var(--term-border)] px-1.5 py-2.5 text-center">
                            <div className="flex items-center justify-center gap-1.5 text-[var(--term-text)]"><CurrencyDollarIcon className="h-4 w-4" />{replayMode ? formatMetric(participants?.traderCount) : '—'}</div>
                            <div className="mt-1.5 truncate text-[clamp(.58rem,.7vw,.7rem)] text-[var(--term-muted)]">Traders</div>
                        </div>
                        <div title="Unavailable from verified source data" className="rounded-lg border border-[var(--term-border)] px-1.5 py-2.5 text-center">
                            <div className="flex items-center justify-center gap-1.5 text-[var(--term-muted)]"><ShieldCheckIcon className="h-4 w-4" />—</div>
                            <div className="mt-1.5 truncate text-[clamp(.58rem,.7vw,.7rem)] text-[var(--term-muted)]">Dex Paid</div>
                        </div>
                    </div>
                    </>}
                </section>
            </div>
        </aside>
    );
}
