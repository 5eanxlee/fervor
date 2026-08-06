-- Admit provider-backed OTOCO chains through the legacy order aggregate while
-- retaining a checked, closed set of price-order strategies.
-- stride: destructive-review=otoco-order-type-v2

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE order_intents
    ADD CONSTRAINT order_intents_order_type_v2
    CHECK (order_type IN ('single', 'oco', 'otoco')) NOT VALID;

ALTER TABLE order_intents
    VALIDATE CONSTRAINT order_intents_order_type_v2;

ALTER TABLE order_intents
    DROP CONSTRAINT order_intents_order_type_check;
