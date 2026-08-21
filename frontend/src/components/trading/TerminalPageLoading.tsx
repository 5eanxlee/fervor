export default function TerminalPageLoading({ token = false }: { token?: boolean }) {
    return (
        <main
            aria-busy="true"
            aria-label="Loading page"
            className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--term-bg)] text-[var(--term-muted)]"
        >
            <span className="sr-only">Loading</span>
            <div className="h-12 shrink-0 border-b border-[var(--term-border)] px-4 py-3">
                <div className="h-5 w-56 animate-pulse rounded bg-[var(--term-control)]" />
            </div>
            <div className={`grid min-h-0 flex-1 ${token ? 'lg:grid-cols-[minmax(0,1fr)_17rem]' : 'lg:grid-cols-3'}`}>
                <section className={`${token ? '' : 'lg:col-span-2'} flex min-h-0 flex-col border-r border-[var(--term-border)]`}>
                    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--term-border)] px-4">
                        {[5, 8, 6, 10].map((width, index) => (
                            <span key={index} className="h-3 animate-pulse rounded bg-[var(--term-control)]" style={{ width: `${width}rem` }} />
                        ))}
                    </div>
                    <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--term-bg)]">
                        <div className="absolute inset-0 opacity-50 [background-image:linear-gradient(var(--term-grid)_1px,transparent_1px),linear-gradient(90deg,var(--term-grid)_1px,transparent_1px)] [background-size:16.666%_20%]" />
                        <div className="absolute bottom-[36%] left-[8%] h-px w-[84%] animate-pulse bg-[var(--term-border-strong)]" />
                    </div>
                </section>
                <aside className="hidden min-h-0 border-l border-[var(--term-border)] p-4 lg:block">
                    <div className="h-9 animate-pulse rounded-lg bg-[var(--term-control)]" />
                    <div className="mt-4 h-24 animate-pulse rounded-lg bg-[var(--term-panel)]" />
                    <div className="mt-4 h-10 animate-pulse rounded-lg bg-[var(--term-control)]" />
                </aside>
            </div>
        </main>
    );
}
