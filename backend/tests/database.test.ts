import { describe, expect, it } from 'vitest';
import {
    coreDb,
    egressDb,
    getClient,
    marketDb,
    poolStats,
    query,
    transaction,
} from '../src/config/database';

describe('database planes', () => {
    it('constructs isolated core and market pool boundaries', () => {
        expect(coreDb).not.toBe(marketDb);
        expect(egressDb).not.toBe(coreDb);
        expect(coreDb.plane).toBe('core');
        expect(marketDb.plane).toBe('market');
        expect(egressDb.plane).toBe('egress');
        expect(poolStats()).toEqual({
            core: { total: 0, idle: 0, waiting: 0, max: 10, min: 0 },
            market: { total: 0, idle: 0, waiting: 0, max: 10, min: 0 },
            egress: { total: 0, idle: 0, waiting: 0, max: 4, min: 0 },
        });
    });

    it('keeps legacy repository helpers pinned to the core plane', () => {
        expect(query).toBe(coreDb.query);
        expect(transaction).toBe(coreDb.transaction);
        expect(getClient).toBe(coreDb.getClient);
    });
});
