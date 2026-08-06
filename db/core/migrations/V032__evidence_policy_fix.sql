-- Keep ignored legacy context outside versioned evidence reduction and expose
-- the source-specific absence-query contract as a callable database policy.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

CREATE OR REPLACE VIEW action_obs_current AS
SELECT DISTINCT ON (action_id, fact_key) *
  FROM action_obs
 WHERE fact_key IS NOT NULL
 ORDER BY action_id, fact_key, fact_rev DESC, id;

CREATE FUNCTION action_absence_query_valid(
    observation_source VARCHAR,
    query_kind VARCHAR
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp AS $$
    SELECT coalesce(CASE observation_source
        WHEN 'provider' THEN query_kind = 'found'
        WHEN 'chain' THEN query_kind = 'expired_unseen'
        ELSE false
    END, false)
$$;

ALTER TABLE action_obs
    ADD CONSTRAINT action_obs_absence_query_v1 CHECK (
        verdict <> 'absence' OR action_absence_query_valid(source, query_kind)
    ) NOT VALID;

ALTER TABLE action_obs VALIDATE CONSTRAINT action_obs_absence_query_v1;

COMMENT ON VIEW action_obs_current IS
    'Current revision of each versioned semantic fact; legacy context is intentionally excluded';
COMMENT ON FUNCTION action_absence_query_valid(VARCHAR, VARCHAR) IS
    'Version 1 source-specific query predicate capable of proving semantic absence';
