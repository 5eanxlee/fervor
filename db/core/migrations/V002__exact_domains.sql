-- Exact chain values use a checked numeric domain because PostgreSQL bigint is
-- signed. The unconstrained numeric base is intentional: NUMERIC(20,0) would
-- round fractional input before a domain check could reject it.
-- stride: destructive-review=exact-domains-v2

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

CREATE DOMAIN sol_u64 AS NUMERIC
    CONSTRAINT sol_u64_integer CHECK (VALUE = trunc(VALUE))
    CONSTRAINT sol_u64_range CHECK (VALUE BETWEEN 0 AND 18446744073709551615);

CREATE DOMAIN wide_uint AS NUMERIC
    CONSTRAINT wide_uint_integer CHECK (VALUE = trunc(VALUE))
    CONSTRAINT wide_uint_range CHECK (VALUE >= 0 AND VALUE < 1e78::numeric);

CREATE DOMAIN wide_int AS NUMERIC
    CONSTRAINT wide_int_integer CHECK (VALUE = trunc(VALUE))
    CONSTRAINT wide_int_range CHECK (abs(VALUE) < 1e78::numeric);

ALTER TABLE trades
    ALTER COLUMN token_amount_raw TYPE sol_u64 USING token_amount_raw::sol_u64,
    ALTER COLUMN quote_amount_raw TYPE sol_u64 USING quote_amount_raw::sol_u64;

ALTER TABLE trade_quotes
    ALTER COLUMN input_amount TYPE sol_u64 USING input_amount::sol_u64,
    ALTER COLUMN output_amount TYPE sol_u64 USING output_amount::sol_u64,
    ALTER COLUMN min_output_amount TYPE sol_u64 USING min_output_amount::sol_u64;

ALTER TABLE trade_executions
    ALTER COLUMN expected_input_amount TYPE sol_u64 USING expected_input_amount::sol_u64,
    ALTER COLUMN expected_output_amount TYPE sol_u64 USING expected_output_amount::sol_u64,
    ALTER COLUMN actual_input_amount TYPE sol_u64 USING actual_input_amount::sol_u64,
    ALTER COLUMN actual_output_amount TYPE sol_u64 USING actual_output_amount::sol_u64;

ALTER TABLE order_intents
    ALTER COLUMN input_amount TYPE sol_u64 USING input_amount::sol_u64;

ALTER TABLE wallet_activity
    ALTER COLUMN quantity_base TYPE sol_u64 USING quantity_base::sol_u64,
    ALTER COLUMN value_micro_usd TYPE wide_uint USING value_micro_usd::wide_uint;

ALTER TABLE wallet_positions
    ALTER COLUMN quantity_base DROP DEFAULT,
    ALTER COLUMN cost_micro_usd DROP DEFAULT,
    ALTER COLUMN realized_pnl_micro_usd DROP DEFAULT,
    ALTER COLUMN untracked_sold_base DROP DEFAULT;

ALTER TABLE wallet_positions
    ALTER COLUMN quantity_base TYPE wide_uint USING quantity_base::wide_uint,
    ALTER COLUMN cost_micro_usd TYPE wide_uint USING cost_micro_usd::wide_uint,
    ALTER COLUMN realized_pnl_micro_usd TYPE wide_int USING realized_pnl_micro_usd::wide_int,
    ALTER COLUMN untracked_sold_base TYPE wide_uint USING untracked_sold_base::wide_uint;

ALTER TABLE wallet_positions
    ALTER COLUMN quantity_base SET DEFAULT 0,
    ALTER COLUMN cost_micro_usd SET DEFAULT 0,
    ALTER COLUMN realized_pnl_micro_usd SET DEFAULT 0,
    ALTER COLUMN untracked_sold_base SET DEFAULT 0;

COMMENT ON DOMAIN sol_u64 IS 'Canonical Solana unsigned 64-bit wire value';
COMMENT ON DOMAIN wide_uint IS 'Nonnegative exact accumulator with at most 78 decimal digits';
COMMENT ON DOMAIN wide_int IS 'Signed exact accumulator with at most 78 decimal digits';
