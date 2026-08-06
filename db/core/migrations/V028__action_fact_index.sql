-- Build fact-revision uniqueness without blocking observation writers.
-- stride: destructive-review=action-fact-index-v28

SET lock_timeout = '5s';
SET statement_timeout = '7min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS action_obs_fact_idx;
CREATE UNIQUE INDEX CONCURRENTLY action_obs_fact_idx
    ON action_obs (action_id, fact_key, fact_rev)
    WHERE fact_key IS NOT NULL;
