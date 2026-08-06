-- Validate the lifetime-generation shape online after V044 guards every write.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE order_intents
    VALIDATE CONSTRAINT order_intents_op_shape_v4;
