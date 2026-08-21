import TradingTerminal from '../../../components/trading/TradingTerminal';

type RouteQuery = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

export default async function TradePage({
    params,
    searchParams,
}: {
    params: Promise<{ mint: string }>;
    searchParams: Promise<RouteQuery>;
}) {
    const [{ mint }, routeQuery] = await Promise.all([params, searchParams]);
    return <TradingTerminal key={mint} tokenMint={mint} query={{
        amount: first(routeQuery.amount),
        slippage: first(routeQuery.slippage),
        tab: first(routeQuery.tab),
    }} />;
}
