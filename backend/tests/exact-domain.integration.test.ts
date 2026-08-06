import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const suite = process.env.RUN_INFRA_TESTS === 'true' ? describe : describe.skip;

suite('exact domain infrastructure', () => {
    let query: typeof import('../src/config/database').query;
    let closeDatabase: typeof import('../src/config/database').closeDatabase;

    beforeAll(async () => {
        process.env.CORE_DATABASE_URL = 'postgresql://fervor@localhost:55432/fervor';
        process.env.MARKET_DATABASE_URL = 'postgresql://fervor@localhost:55432/fervor';
        process.env.DB_COLOCATED = 'true';
        ({ query, closeDatabase } = await import('../src/config/database'));
    });

    afterAll(async () => {
        await closeDatabase?.();
    });

    it.each([
        '0',
        '1',
        '9007199254740992',
        '9223372036854775808',
        '18446744073709551615',
    ])('round-trips sol_u64 value %s', async (value) => {
        const result = await query('SELECT $1::sol_u64 AS value', [value]);
        expect(result.rows[0].value).toBe(value);
    });

    it.each([
        '-1',
        '1.5',
        '18446744073709551616',
        'NaN',
        'Infinity',
    ])('rejects invalid sol_u64 value %s', async (value) => {
        await expect(query('SELECT $1::numeric::sol_u64', [value])).rejects.toBeTruthy();
    });

    it('preserves wider signed and unsigned accumulator boundaries', async () => {
        const max = '9'.repeat(78);
        const result = await query(
            'SELECT $1::wide_uint AS positive, $2::wide_int AS negative',
            [max, `-${max}`]
        );
        expect(result.rows[0]).toEqual({ positive: max, negative: `-${max}` });
        await expect(query('SELECT $1::wide_uint', ['9'.repeat(79)])).rejects.toBeTruthy();
        await expect(query('SELECT $1::wide_int', [`-${'9'.repeat(79)}`])).rejects.toBeTruthy();
    });

    it('preserves a null wallet checkpoint when the provider slot is unsafe', async () => {
        const wallet = `ExactSlot${crypto.randomBytes(8).toString('hex')}`;
        const source = await query(
            `INSERT INTO wallet_sources (wallet_address, provider, backfill_complete)
             VALUES ($1, 'fixture', TRUE) RETURNING id`,
            [wallet]
        );
        const provider = {
            name: 'fixture' as const,
            history: async () => ({
                transactions: [{
                    signature: '5'.repeat(88),
                    slot: '9007199254740992',
                    tokenTransfers: [],
                }],
            }),
        };
        const { WalletIndexerService } = await import('../src/services/wallets/walletIndexerService');

        await new WalletIndexerService(provider, query).runBatch(1000);
        const checkpoint = await query('SELECT last_slot FROM wallet_sources WHERE id = $1', [source.rows[0].id]);
        expect(checkpoint.rows[0].last_slot).toBeNull();
        await query('DELETE FROM wallet_sources WHERE id = $1', [source.rows[0].id]);
    });
});
