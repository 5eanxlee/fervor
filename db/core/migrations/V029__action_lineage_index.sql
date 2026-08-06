-- Build one-successor lineage uniqueness without blocking observation writers.
-- stride: destructive-review=action-lineage-index-v29

SET lock_timeout = '5s';
SET statement_timeout = '7min';
SET idle_in_transaction_session_timeout = '60s';
SET search_path = public;

DROP INDEX CONCURRENTLY IF EXISTS action_obs_supersedes_idx;
CREATE UNIQUE INDEX CONCURRENTLY action_obs_supersedes_idx
    ON action_obs (supersedes)
    WHERE supersedes IS NOT NULL;
