export type ShelfKind = 'recent' | 'starred' | 'positions';

export type ShelfToken = {
    address: string;
    symbol: string;
    name?: string;
    logo?: string;
    marketCap?: number;
    price?: number;
    seenAt: number;
};

const eventName = 'fervor-token-shelf';
const key = (kind: ShelfKind) => `fervor_${kind}_tokens_v1`;

const clean = (value: unknown): ShelfToken[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const raw = item as Partial<ShelfToken>;
        if (!raw.address || !raw.symbol) return [];
        return [{
            address: String(raw.address),
            symbol: String(raw.symbol).slice(0, 18),
            name: raw.name ? String(raw.name).slice(0, 80) : undefined,
            logo: raw.logo ? String(raw.logo) : undefined,
            marketCap: Number.isFinite(raw.marketCap) ? Number(raw.marketCap) : undefined,
            price: Number.isFinite(raw.price) ? Number(raw.price) : undefined,
            seenAt: Number.isFinite(raw.seenAt) ? Number(raw.seenAt) : Date.now(),
        }];
    }).slice(0, 24);
};

export const getShelf = (kind: ShelfKind): ShelfToken[] => {
    if (typeof window === 'undefined') return [];
    try {
        return clean(JSON.parse(localStorage.getItem(key(kind)) || '[]'));
    } catch {
        return [];
    }
};

const putShelf = (kind: ShelfKind, tokens: ShelfToken[]) => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(key(kind), JSON.stringify(clean(tokens)));
    window.dispatchEvent(new CustomEvent(eventName, { detail: kind }));
};

export const rememberToken = (token: Omit<ShelfToken, 'seenAt'> & { seenAt?: number }) => {
    const next = { ...token, seenAt: token.seenAt || Date.now() };
    putShelf('recent', [next, ...getShelf('recent').filter((item) => item.address !== token.address)].slice(0, 12));
};

export const setPositions = (tokens: ShelfToken[]) => putShelf('positions', tokens.slice(0, 12));

export const hasStar = (address: string) => getShelf('starred').some((item) => item.address === address);

export const toggleStar = (token: Omit<ShelfToken, 'seenAt'> & { seenAt?: number }) => {
    const current = getShelf('starred');
    const exists = current.some((item) => item.address === token.address);
    if (exists) putShelf('starred', current.filter((item) => item.address !== token.address));
    else putShelf('starred', [{ ...token, seenAt: token.seenAt || Date.now() }, ...current].slice(0, 12));
    return !exists;
};

export const onShelf = (listener: () => void) => {
    if (typeof window === 'undefined') return () => undefined;
    window.addEventListener(eventName, listener);
    window.addEventListener('storage', listener);
    return () => {
        window.removeEventListener(eventName, listener);
        window.removeEventListener('storage', listener);
    };
};
