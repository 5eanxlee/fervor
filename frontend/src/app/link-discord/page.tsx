'use client';

import type { ReactNode } from 'react';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
    CheckCircleIcon,
    ClockIcon,
    ExclamationTriangleIcon,
    LinkIcon,
} from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import DashboardLayout from '../../components/DashboardLayout';
import FervorPage, { panelClass } from '../../components/FervorPage';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api';

interface TokenInfo {
    discordUsername?: string;
    isUsed?: boolean;
    isExpired?: boolean;
}

function LinkDiscordContent() {
    const router = useRouter();
    const params = useSearchParams();
    const { isAuthenticated, signIn, refreshUser } = useAuth();
    const [info, setInfo] = useState<TokenInfo>();
    const [linking, setLinking] = useState(false);
    const [loading, setLoading] = useState(true);
    const [attempted, setAttempted] = useState(false);
    const [failed, setFailed] = useState(false);
    const token = params.get('token');

    const load = useCallback(async () => {
        if (!token) return;
        try {
            const response = await apiService.getDiscordTokenInfo(token);
            if (!response.success) throw new Error(response.error || 'Invalid linking token');
            setInfo(response.data as TokenInfo);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to validate token');
            router.replace('/integrations');
        } finally {
            setLoading(false);
        }
    }, [router, token]);

    const link = useCallback(async () => {
        if (!token || linking || attempted) return;
        setLinking(true);
        setAttempted(true);
        setFailed(false);
        try {
            const response = await apiService.linkDiscordWithToken(token);
            if (!response.success) throw new Error(response.error || 'Failed to link account');
            toast.success(`Discord @${info?.discordUsername || 'account'} linked`);
            await refreshUser();
            router.replace('/integrations?linked=discord');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to link Discord account');
            setFailed(true);
        } finally {
            setLinking(false);
        }
    }, [attempted, info, linking, refreshUser, router, token]);

    useEffect(() => {
        if (!token) {
            router.replace('/integrations');
            return;
        }
        void load();
    }, [load, router, token]);

    useEffect(() => {
        if (isAuthenticated && info && !info.isUsed && !info.isExpired && !linking && !attempted) void link();
    }, [attempted, info, isAuthenticated, link, linking]);

    const retry = () => {
        setFailed(false);
        setAttempted(false);
    };

    if (loading) {
        return <LinkScreen icon={<span className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--term-border-strong)] border-t-[var(--term-accent)]" />} title="Validating link" text="FERVOR is checking this Discord linking request." />;
    }

    if (info?.isExpired) {
        return <LinkScreen icon={<ClockIcon />} tone="danger" title="Link expired" text={<>Generate a new request with the <code className="rounded-md bg-[var(--term-control)] px-1.5 py-1 text-white">/link</code> command in Discord.</>} action={<button onClick={() => router.push('/integrations')} className="rounded-lg bg-[var(--term-accent)] px-4 py-2 text-xs font-[650] text-[#111114]">Open integrations</button>} />;
    }

    if (info?.isUsed) {
        return <LinkScreen icon={<CheckCircleIcon />} tone="success" title="Already linked" text="This Discord account is already connected to a FERVOR wallet." action={<button onClick={() => router.push('/integrations')} className="rounded-lg bg-[var(--term-accent)] px-4 py-2 text-xs font-[650] text-[#111114]">Open integrations</button>} />;
    }

    if (!isAuthenticated) {
        return <LinkScreen icon={<LinkIcon />} title="Connect your wallet" text={<>Sign in to link Discord <strong className="text-white">@{info?.discordUsername || 'account'}</strong>. Your wallet signature proves ownership; it does not grant asset access.</>} action={<button onClick={() => void signIn()} className="rounded-lg bg-[var(--term-accent)] px-5 py-2.5 text-xs font-[650] text-[#111114]">Connect wallet</button>} />;
    }

    if (failed) {
        return <LinkScreen icon={<ExclamationTriangleIcon />} tone="danger" title="Linking failed" text="The request may have expired or the Discord account may already belong to another wallet." action={<button onClick={retry} className="rounded-lg border border-[var(--term-danger)] px-5 py-2.5 text-xs text-[var(--term-danger)] hover:bg-[color-mix(in_srgb,var(--term-danger)_10%,transparent)]">Try again</button>} />;
    }

    return <LinkScreen icon={<LinkIcon />} title={linking ? 'Linking account' : 'Ready to link'} text={<>Connecting <strong className="text-white">@{info?.discordUsername || 'account'}</strong> to your FERVOR profile. This usually takes a few seconds.</>} busy={linking} />;
}

function LinkScreen({ icon, title, text, action, tone = 'accent', busy = false }: { icon: ReactNode; title: string; text: ReactNode; action?: ReactNode; tone?: 'accent' | 'success' | 'danger'; busy?: boolean }) {
    const iconTone = tone === 'success' ? 'text-[var(--term-buy)]' : tone === 'danger' ? 'text-[var(--term-sell)]' : 'text-[var(--term-accent)]';
    return (
        <DashboardLayout live={!busy}>
            <FervorPage eyebrow="Connections" title="Discord linking" summary="Securely connect a notification channel to FERVOR.">
                <section className={`${panelClass} grid min-h-[clamp(25rem,58vh,38rem)] place-items-center p-6`}>
                    <div className="max-w-md text-center">
                        <span className={`mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-[var(--term-border)] bg-[var(--term-raised)] ${iconTone}`}>{typeof icon === 'object' ? <span className="grid h-7 w-7 place-items-center [&>svg]:h-7 [&>svg]:w-7">{icon}</span> : icon}</span>
                        <h1 className="mt-5 text-lg font-[500] text-white">{title}</h1>
                        <p className="mt-2 text-xs leading-relaxed text-[var(--term-muted)]">{text}</p>
                        {busy && <div className="mx-auto mt-5 h-1 w-36 overflow-hidden rounded-full bg-[var(--term-control)]"><span className="block h-full w-1/2 animate-pulse rounded-full bg-[var(--term-accent)]" /></div>}
                        {action && <div className="mt-6">{action}</div>}
                    </div>
                </section>
            </FervorPage>
        </DashboardLayout>
    );
}

export default function LinkDiscordPage() {
    return <Suspense fallback={<main data-terminal-theme="terminal" className="grid h-screen place-items-center bg-[var(--term-bg)]"><div className="spinner" /></main>}><LinkDiscordContent /></Suspense>;
}
