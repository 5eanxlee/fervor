import type { ReactNode } from 'react';

interface FervorPageProps {
    title: string;
    summary: string;
    eyebrow?: string;
    action?: ReactNode;
    children: ReactNode;
}

export const fieldClass = 'h-9 min-w-0 rounded-lg border border-[var(--term-border)] bg-[var(--term-raised)] px-3 text-xs text-[var(--term-text)] outline-none transition-colors placeholder:text-[var(--term-dim)] hover:border-[var(--term-border-strong)] focus:border-[var(--term-border-strong)]';
export const panelClass = 'overflow-hidden rounded-xl border border-[var(--term-border)] bg-[var(--term-panel)]';
export const iconClass = 'grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[var(--term-border)] bg-[var(--term-raised)] text-[var(--term-muted)] transition-colors hover:border-[var(--term-border-strong)] hover:bg-[var(--term-control)] hover:text-white disabled:opacity-40';

export default function FervorPage({ title, summary, eyebrow = 'FERVOR', action, children }: FervorPageProps) {
    return (
        <div className="mx-auto flex w-full max-w-[96rem] flex-col gap-[clamp(.8rem,1.35vw,1.25rem)] px-[clamp(.75rem,1.6vw,1.5rem)] py-[clamp(.8rem,1.5vw,1.35rem)]">
            <header className="flex min-h-[3.25rem] flex-wrap items-end justify-between gap-3 border-b border-[var(--term-border)] pb-[clamp(.75rem,1vw,1rem)]">
                <div className="min-w-0">
                    <p className="mb-1 text-[9px] font-[600] uppercase tracking-[.2em] text-[var(--term-accent)]">{eyebrow}</p>
                    <h1 className="text-[clamp(1.1rem,1.55vw,1.35rem)] font-[500] tracking-[-.025em] text-white">{title}</h1>
                    <p className="mt-1 text-[clamp(.67rem,.82vw,.76rem)] text-[var(--term-muted)]">{summary}</p>
                </div>
                {action}
            </header>
            {children}
        </div>
    );
}
