'use client';

import {
    createContext,
    ReactNode,
    useContext,
    useEffect,
    useMemo,
    useState,
} from 'react';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { getWallets } from '@wallet-standard/app';
import {
    StandardConnect,
    StandardConnectFeature,
    StandardDisconnect,
    StandardDisconnectFeature,
    StandardEvents,
    StandardEventsFeature,
} from '@wallet-standard/features';
import {
    SolanaSignMessage,
    SolanaSignMessageFeature,
    SolanaSignTransaction,
    SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features';
import { VersionedTransaction } from '@solana/web3.js';
import { createReplayWallet } from '../services/replayWallet';

type SignMessage = (message: Uint8Array, display?: 'utf8' | 'hex') =>
    Promise<Uint8Array | { signature: Uint8Array }>;
type SignTransaction = (transaction: VersionedTransaction) => Promise<VersionedTransaction>;

export interface WalletOption {
    name: string;
    icon: string;
}

interface WalletConnection {
    publicKey: string;
    signMessage?: SignMessage;
    signTransaction?: SignTransaction;
}

interface WalletContextType {
    connected: boolean;
    connecting: boolean;
    publicKey: string | null;
    walletName: string | null;
    wallets: WalletOption[];
    signMessage?: SignMessage;
    signTransaction?: SignTransaction;
    selectWallet: (name: string) => void;
    connect: () => Promise<WalletConnection>;
    disconnect: () => Promise<void>;
}

type SolanaWallet = Wallet;

const WalletContext = createContext<WalletContextType | undefined>(undefined);
const walletKey = 'fervor_wallet';
const replayMode = process.env.NEXT_PUBLIC_DATA_MODE === 'replay';
const replayName = 'Replay wallet';
const walletRegistry = () => getWallets();
const supportsSolana = (wallet: Wallet): wallet is SolanaWallet =>
    StandardConnect in wallet.features && wallet.chains.some((chain) => chain.startsWith('solana:'));
const solanaAccount = (accounts: readonly WalletAccount[]): WalletAccount | undefined =>
    accounts.find((account) => account.chains.some((chain) => chain.startsWith('solana:')));

const getConnection = (wallet: SolanaWallet, account: WalletAccount): WalletConnection => {
    const messageFeature = wallet.features[SolanaSignMessage] as
        SolanaSignMessageFeature[typeof SolanaSignMessage] | undefined;
    const transactionFeature = wallet.features[SolanaSignTransaction] as
        SolanaSignTransactionFeature[typeof SolanaSignTransaction] | undefined;
    const chain = account.chains.find((value) => value.startsWith('solana:')) || 'solana:mainnet';

    return {
        publicKey: account.address,
        signMessage: messageFeature ? async (message) => {
            const [output] = await messageFeature.signMessage({ account, message });
            if (!output) throw new Error('Wallet returned no message signature');
            return { signature: output.signature };
        } : undefined,
        signTransaction: transactionFeature ? async (transaction) => {
            if (!transactionFeature.supportedTransactionVersions.includes(0)) {
                throw new Error('Wallet does not support versioned Solana transactions');
            }
            const [output] = await transactionFeature.signTransaction({
                account,
                chain,
                transaction: transaction.serialize(),
            });
            if (!output) throw new Error('Wallet returned no signed transaction');
            return VersionedTransaction.deserialize(output.signedTransaction);
        } : undefined,
    };
};

export const WalletContextProvider = ({ children }: { children: ReactNode }) => {
    const [available, setAvailable] = useState<SolanaWallet[]>([]);
    const [walletName, setWalletName] = useState<string | null>(replayMode ? replayName : null);
    const [account, setAccount] = useState<WalletAccount | null>(null);
    const [replay, setReplay] = useState<WalletConnection | null>(null);
    const [connecting, setConnecting] = useState(false);

    useEffect(() => {
        const registry = walletRegistry();
        const refresh = () => {
            const next = registry.get().filter(supportsSolana);
            setAvailable(next);
            setWalletName((current) => {
                if (replayMode && current === replayName) return current;
                if (current && next.some((wallet) => wallet.name === current)) return current;
                const stored = localStorage.getItem(walletKey) || localStorage.getItem('fervor_wallet');
                return next.find((wallet) => wallet.name === stored)?.name
                    || (replayMode ? replayName : next[0]?.name || null);
            });
        };
        refresh();
        const offRegister = registry.on('register', refresh);
        const offUnregister = registry.on('unregister', refresh);
        return () => {
            offRegister();
            offUnregister();
        };
    }, []);

    const selected = available.find((wallet) => wallet.name === walletName) || null;

    useEffect(() => {
        if (walletName === replayName) {
            setAccount(null);
            return;
        }
        if (!selected) {
            setAccount(null);
            return;
        }
        setAccount(solanaAccount(selected.accounts) || null);
        const events = selected.features[StandardEvents] as
            StandardEventsFeature[typeof StandardEvents] | undefined;
        if (!events) return;
        return events.on('change', (change) => {
            if (change.accounts) setAccount(solanaAccount(change.accounts) || null);
        });
    }, [selected, walletName]);

    const selectWallet = (name: string) => {
        if ((name === replayName && !replayMode)
            || (name !== replayName && !available.some((wallet) => wallet.name === name))) return;
        setAccount(null);
        setReplay(null);
        setWalletName(name);
        localStorage.setItem(walletKey, name);
    };

    const connect = async (): Promise<WalletConnection> => {
        if (replayMode && walletName === replayName) {
            setConnecting(true);
            try {
                const next = replay || await createReplayWallet();
                setReplay(next);
                return next;
            } finally {
                setConnecting(false);
            }
        }
        if (!selected) throw new Error('No compatible Solana wallet was found');
        setConnecting(true);
        try {
            const connectFeature = selected.features[StandardConnect] as
                StandardConnectFeature[typeof StandardConnect];
            const output = await connectFeature.connect();
            const nextAccount = solanaAccount(output.accounts);
            if (!nextAccount) throw new Error(`${selected.name} returned no Solana account`);
            setAccount(nextAccount);
            localStorage.setItem(walletKey, selected.name);
            return getConnection(selected, nextAccount);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Wallet connection failed';
            throw new Error(message);
        } finally {
            setConnecting(false);
        }
    };

    const disconnect = async () => {
        if (replay) {
            setReplay(null);
            return;
        }
        const disconnectFeature = selected?.features[StandardDisconnect] as
            StandardDisconnectFeature[typeof StandardDisconnect] | undefined;
        if (disconnectFeature) await disconnectFeature.disconnect();
        setAccount(null);
    };

    const connection = useMemo(
        () => replay || (selected && account ? getConnection(selected, account) : null),
        [selected, account, replay]
    );

    return (
        <WalletContext.Provider value={{
            connected: !!connection,
            connecting,
            publicKey: connection?.publicKey || null,
            walletName,
            wallets: [
                ...(replayMode ? [{ name: replayName, icon: '' }] : []),
                ...available.map((wallet) => ({ name: wallet.name, icon: wallet.icon })),
            ],
            signMessage: connection?.signMessage,
            signTransaction: connection?.signTransaction,
            selectWallet,
            connect,
            disconnect,
        }}>
            {children}
        </WalletContext.Provider>
    );
};

export const useWallet = () => {
    const context = useContext(WalletContext);
    if (!context) throw new Error('useWallet must be used within a WalletContextProvider');
    return context;
};
