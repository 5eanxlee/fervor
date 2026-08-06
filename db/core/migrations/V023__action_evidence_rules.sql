-- Version observation proof lineage and make evidence-derived action outcomes
-- authoritative at the database boundary.
-- stride: destructive-review=action-evidence-rules-v23

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE order_actions
    ADD COLUMN rule_ver SMALLINT NOT NULL DEFAULT 1 CHECK (rule_ver = 1);

ALTER TABLE action_obs
    ADD COLUMN fact_key VARCHAR(220),
    ADD COLUMN fact_rev INTEGER NOT NULL DEFAULT 1 CHECK (fact_rev > 0),
    ADD COLUMN supersedes UUID,
    ADD COLUMN verdict VARCHAR(12) NOT NULL DEFAULT 'context' CHECK (
        verdict IN ('context', 'presence', 'absence', 'conflict')
    ),
    ADD COLUMN predicate VARCHAR(80) NOT NULL DEFAULT 'legacy_unqualified',
    ADD COLUMN rule_ver SMALLINT NOT NULL DEFAULT 1 CHECK (rule_ver = 1);

ALTER TABLE action_obs
    ADD CONSTRAINT action_obs_supersedes_fk
        FOREIGN KEY (supersedes) REFERENCES action_obs(id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE action_obs VALIDATE CONSTRAINT action_obs_supersedes_fk;

CREATE TABLE order_proof_caps (
    provider VARCHAR(32) NOT NULL,
    rule_ver SMALLINT NOT NULL CHECK (rule_ver = 1),
    provider_absence BOOLEAN NOT NULL DEFAULT false,
    source_key VARCHAR(220) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider, rule_ver)
);

INSERT INTO order_proof_caps (provider, rule_ver, provider_absence, source_key)
VALUES ('fixture', 1, true, 'migration:v23:fixture-proof-v1');

CREATE FUNCTION order_proof_caps_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    RAISE EXCEPTION 'order proof capabilities are migration-owned' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER order_proof_caps_guard
    BEFORE INSERT OR UPDATE OR DELETE ON order_proof_caps
    FOR EACH ROW EXECUTE FUNCTION order_proof_caps_guard();

CREATE FUNCTION action_source_valid(
    action_kind VARCHAR,
    observation_source VARCHAR
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp AS $$
    SELECT coalesce(CASE action_kind
        WHEN 'chain_sync' THEN observation_source = 'chain'
        WHEN 'activate' THEN observation_source IN ('provider', 'chain')
        WHEN 'cancel_confirm' THEN observation_source IN ('provider', 'chain')
        WHEN 'compensate' THEN observation_source IN ('provider', 'chain')
        WHEN 'prepare' THEN observation_source = 'provider'
        WHEN 'edit' THEN observation_source = 'provider'
        WHEN 'cancel_init' THEN observation_source = 'provider'
        WHEN 'provider_sync' THEN observation_source = 'provider'
        WHEN 'expire' THEN observation_source = 'provider'
        ELSE false
    END, false)
$$;

CREATE OR REPLACE FUNCTION action_obs_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    action order_actions%ROWTYPE;
    prior action_obs%ROWTYPE;
    duplicate action_obs%ROWTYPE;
BEGIN
    SELECT * INTO action FROM order_actions WHERE id = NEW.action_id FOR SHARE;
    IF NOT FOUND
        OR action.desired_hash <> NEW.desired_hash
        OR action.rule_ver <> NEW.rule_ver
        OR (NEW.source = 'provider' AND action.provider <> NEW.provider)
        OR NOT EXISTS (
            SELECT 1 FROM order_intents order_row
             WHERE order_row.id = action.order_id
               AND (order_row.cluster IS NULL OR order_row.cluster = NEW.cluster)
        ) THEN
        RAISE EXCEPTION 'observation does not match its action rule, provider, or cluster'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.attempt_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM action_attempts attempt
         WHERE attempt.id = NEW.attempt_id AND attempt.action_id = NEW.action_id
    ) THEN
        RAISE EXCEPTION 'observation attempt belongs to a different action'
            USING ERRCODE = '23514';
    END IF;

    -- V015 writers omit the versioned columns. Retain their observation as
    -- immutable context, but never let it participate in evidence reduction.
    IF NEW.fact_key IS NULL THEN
        IF NEW.fact_rev <> 1
            OR NEW.supersedes IS NOT NULL
            OR NEW.verdict <> 'context'
            OR NEW.predicate <> 'legacy_unqualified'
            OR NEW.rule_ver <> 1 THEN
            RAISE EXCEPTION 'legacy observation has an invalid compatibility shape'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NOT action_source_valid(action.kind, NEW.source)
        OR (NEW.source = 'provider' AND NEW.verdict = 'absence' AND NOT EXISTS (
            SELECT 1 FROM order_proof_caps capability
             WHERE capability.provider = action.provider
               AND capability.rule_ver = action.rule_ver
               AND capability.provider_absence
        )) THEN
        RAISE EXCEPTION 'observation source or provider proof is not authorized'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.predicate <> concat(
        action.kind, '.', NEW.source, '.effect.v', NEW.rule_ver
    ) THEN
        RAISE EXCEPTION 'observation requires its versioned action predicate'
            USING ERRCODE = '23514';
    END IF;
    IF (NEW.verdict = 'presence' AND (
            NEW.query_kind <> 'found' OR NEW.effect_hash IS DISTINCT FROM NEW.desired_hash
        ))
        OR (NEW.verdict = 'absence' AND (
            NEW.effect_hash IS NOT NULL
            OR (NEW.source = 'provider' AND NEW.query_kind <> 'found')
            OR (NEW.source = 'chain' AND NEW.query_kind <> 'expired_unseen')
        ))
        OR (NEW.verdict = 'conflict' AND (
            NEW.query_kind <> 'found' OR NEW.effect_hash IS NULL
            OR NEW.effect_hash = NEW.desired_hash
        ))
        OR (NEW.verdict = 'context' AND NEW.query_kind = 'expired_unseen') THEN
        RAISE EXCEPTION 'observation verdict does not match its immutable evidence facts'
            USING ERRCODE = '23514';
    END IF;

    IF current_setting('transaction_isolation') <> 'read committed'
        AND NOT EXISTS (
            SELECT 1
              FROM pg_index fact_index
              JOIN pg_index lineage_index ON true
             WHERE fact_index.indexrelid = to_regclass('public.action_obs_fact_idx')
               AND fact_index.indisvalid AND fact_index.indisunique
               AND lineage_index.indexrelid = to_regclass('public.action_obs_supersedes_idx')
               AND lineage_index.indisvalid AND lineage_index.indisunique
        ) THEN
        RAISE EXCEPTION 'versioned observation writes require read committed while uniqueness indexes are unavailable'
            USING ERRCODE = '25001';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(
        concat(NEW.action_id::text, ':', NEW.fact_key), 1937006964
    ));
    SELECT * INTO duplicate
      FROM action_obs used
     WHERE used.action_id = NEW.action_id
       AND used.fact_key = NEW.fact_key
       AND used.fact_rev = NEW.fact_rev;
    IF FOUND THEN
        IF duplicate.id = NEW.id OR (
            duplicate.source = NEW.source
            AND duplicate.cluster = NEW.cluster
            AND duplicate.source_key = NEW.source_key
        ) THEN
            -- A base identity constraint makes the insert a no-op; the runtime
            -- then compares every immutable field before accepting the replay.
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'observation fact revision already exists' USING ERRCODE = '23505';
    END IF;
    IF NEW.fact_rev = 1 THEN
        IF NEW.supersedes IS NOT NULL THEN
            RAISE EXCEPTION 'first observation fact revision cannot supersede another fact'
                USING ERRCODE = '23514';
        END IF;
    ELSE
        SELECT * INTO prior FROM action_obs WHERE id = NEW.supersedes FOR UPDATE;
        IF NOT FOUND
            OR prior.action_id <> NEW.action_id
            OR prior.fact_key IS DISTINCT FROM NEW.fact_key
            OR prior.fact_rev + 1 <> NEW.fact_rev
            OR prior.source <> NEW.source
            OR prior.cluster <> NEW.cluster
            OR prior.predicate <> NEW.predicate
            OR prior.rule_ver <> NEW.rule_ver
            OR EXISTS (SELECT 1 FROM action_obs used WHERE used.supersedes = prior.id) THEN
            RAISE EXCEPTION 'observation correction must extend one exact fact lineage'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE VIEW action_obs_current AS
SELECT DISTINCT ON (action_id, coalesce(fact_key, concat('legacy:', id::text))) *
  FROM action_obs
 ORDER BY action_id, coalesce(fact_key, concat('legacy:', id::text)), fact_rev DESC, id;

CREATE FUNCTION action_effect_derived(target_action UUID) RETURNS VARCHAR
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    action order_actions%ROWTYPE;
    has_conflict BOOLEAN;
    provider_presence BOOLEAN;
    chain_presence BOOLEAN;
    provider_absence BOOLEAN;
    chain_absence BOOLEAN;
    complete_presence BOOLEAN;
    complete_absence BOOLEAN;
BEGIN
    SELECT * INTO action FROM order_actions WHERE id = target_action;
    IF NOT FOUND THEN RETURN NULL; END IF;

    SELECT
        coalesce(bool_or(obs.verdict = 'conflict'), false),
        coalesce(bool_or(obs.source = 'provider' AND obs.verdict = 'presence'), false),
        coalesce(bool_or(obs.source = 'chain' AND obs.verdict = 'presence'), false),
        coalesce(bool_or(obs.source = 'provider' AND obs.verdict = 'absence'), false),
        coalesce(bool_or(obs.source = 'chain' AND obs.verdict = 'absence'), false)
      INTO has_conflict, provider_presence, chain_presence,
           provider_absence, chain_absence
      FROM action_obs_current obs
     WHERE obs.action_id = target_action
       AND obs.rule_ver = action.rule_ver
       AND obs.fact_key IS NOT NULL
       AND action_source_valid(action.kind, obs.source);

    IF has_conflict OR (
        (provider_presence OR chain_presence) AND (provider_absence OR chain_absence)
    ) THEN
        RETURN 'conflict';
    END IF;

    complete_presence := CASE action.kind
        WHEN 'activate' THEN provider_presence AND chain_presence
        WHEN 'cancel_confirm' THEN provider_presence AND chain_presence
        WHEN 'compensate' THEN provider_presence AND chain_presence
        WHEN 'chain_sync' THEN chain_presence
        ELSE provider_presence
    END;
    complete_absence := CASE action.kind
        WHEN 'activate' THEN provider_absence AND chain_absence
        WHEN 'cancel_confirm' THEN provider_absence AND chain_absence
        WHEN 'compensate' THEN provider_absence AND chain_absence
        WHEN 'chain_sync' THEN chain_absence
        ELSE provider_absence
    END;
    IF complete_presence THEN RETURN 'present'; END IF;
    IF complete_absence THEN RETURN 'absent'; END IF;
    RETURN 'possible';
END;
$$;

CREATE FUNCTION order_action_transition_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    derived VARCHAR;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.action_ver <> 0
            OR NEW.work_state <> 'queued'
            OR NEW.effect_state <> 'not_possible'
            OR NEW.outcome <> 'pending'
            OR NEW.block_reason IS NOT NULL
            OR NEW.attempt_count <> 0
            OR NEW.lease_owner IS NOT NULL
            OR NEW.completed_at IS NOT NULL THEN
            RAISE EXCEPTION 'new action must begin as an unfenced queued intent'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.work_state <> OLD.work_state AND NOT (
        (OLD.work_state = 'queued' AND NEW.work_state IN ('awaiting_sig', 'ready', 'parked', 'done'))
        OR (OLD.work_state = 'awaiting_sig' AND NEW.work_state IN ('ready', 'parked', 'done'))
        OR (OLD.work_state = 'ready' AND NEW.work_state IN ('dispatching', 'parked', 'done'))
        OR (OLD.work_state = 'dispatching' AND NEW.work_state IN ('reconciling', 'parked', 'done'))
        OR (OLD.work_state = 'reconciling' AND NEW.work_state IN ('ready', 'parked', 'done'))
        OR (OLD.work_state = 'parked' AND NEW.work_state IN ('ready', 'done'))
    ) THEN
        RAISE EXCEPTION 'invalid action work transition % to %', OLD.work_state, NEW.work_state
            USING ERRCODE = '23514';
    END IF;
    IF NEW.effect_state <> OLD.effect_state AND NOT (
        (OLD.effect_state = 'not_possible' AND NEW.effect_state IN ('possible', 'absent'))
        OR (OLD.effect_state = 'possible' AND NEW.effect_state IN ('present', 'absent', 'conflict'))
        OR (OLD.effect_state = 'present' AND NEW.effect_state = 'conflict')
        OR (OLD.effect_state = 'absent' AND NEW.effect_state = 'conflict')
        OR (OLD.effect_state = 'conflict' AND NEW.effect_state IN ('present', 'absent'))
    ) THEN
        RAISE EXCEPTION 'invalid action effect transition % to %', OLD.effect_state, NEW.effect_state
            USING ERRCODE = '23514';
    END IF;
    IF NEW.outcome <> OLD.outcome AND NOT (
        (OLD.outcome = 'pending' AND NEW.outcome IN ('succeeded', 'failed', 'manual_review'))
        OR (OLD.outcome = 'manual_review' AND NEW.outcome IN ('succeeded', 'failed'))
    ) THEN
        RAISE EXCEPTION 'invalid action outcome transition % to %', OLD.outcome, NEW.outcome
            USING ERRCODE = '23514';
    END IF;
    IF NEW.work_state = 'dispatching' AND OLD.work_state <> 'dispatching'
        AND (NEW.lease_owner IS NULL OR NEW.attempt_count <> OLD.attempt_count + 1
            OR NEW.effect_state <> 'possible') THEN
        RAISE EXCEPTION 'dispatch transition requires one active fenced attempt'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.effect_state <> 'not_possible' THEN
        derived := action_effect_derived(NEW.id);
        IF derived IN ('present', 'absent', 'conflict')
            AND NEW.effect_state <> derived THEN
            RAISE EXCEPTION 'action effect does not match its current decisive evidence'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.effect_state = 'conflict'
        AND OLD.effect_state <> 'conflict'
        AND derived IS DISTINCT FROM 'conflict' THEN
        RAISE EXCEPTION 'action cannot enter conflict without current conflict evidence'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.effect_state IN ('present', 'absent') AND NOT (
        NEW.work_state = 'done'
        AND ((NEW.effect_state = 'present' AND NEW.outcome = 'succeeded')
            OR (NEW.effect_state = 'absent' AND NEW.outcome = 'failed'))
    ) THEN
        RAISE EXCEPTION 'decisive action evidence must settle the action atomically'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.effect_state = 'conflict'
        AND NEW.work_state NOT IN ('reconciling', 'parked') THEN
        RAISE EXCEPTION 'conflicting action evidence requires reconciliation or review'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_actions_transition_guard
    BEFORE INSERT OR UPDATE ON order_actions
    FOR EACH ROW EXECUTE FUNCTION order_action_transition_guard();

CREATE FUNCTION action_obs_reduction_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    action order_actions%ROWTYPE;
    derived VARCHAR;
    reduced BOOLEAN;
BEGIN
    IF NEW.fact_key IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO action FROM order_actions WHERE id = NEW.action_id;
    derived := action_effect_derived(NEW.action_id);
    reduced := CASE derived
        WHEN 'present' THEN action.work_state = 'done'
            AND action.effect_state = 'present' AND action.outcome = 'succeeded'
        WHEN 'absent' THEN action.work_state = 'done'
            AND action.effect_state = 'absent' AND action.outcome = 'failed'
        WHEN 'conflict' THEN action.work_state IN ('reconciling', 'parked')
            AND action.effect_state = 'conflict'
            AND action.outcome IN ('pending', 'manual_review')
        WHEN 'possible' THEN action.work_state <> 'done'
            AND action.effect_state IN ('possible', 'conflict')
        ELSE false
    END;
    IF reduced THEN RETURN NULL; END IF;

    IF action.work_state = 'done'
        AND action.effect_state IN ('present', 'absent')
        AND EXISTS (
            SELECT 1 FROM order_anomalies anomaly
             WHERE anomaly.action_id = action.id
               AND anomaly.kind = 'policy_violation'
               AND anomaly.state <> 'resolved'
               AND anomaly.blocks_actions
               AND anomaly.detail->>'derivedEffect' = derived
               AND anomaly.detail->>'storedEffect' = action.effect_state
        ) THEN
        RETURN NULL;
    END IF;
    RAISE EXCEPTION 'observation was not reduced into its action or a blocking anomaly'
        USING ERRCODE = '23514';
END;
$$;

CREATE CONSTRAINT TRIGGER action_obs_reduction_guard
    AFTER INSERT ON action_obs
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION action_obs_reduction_guard();

CREATE FUNCTION evidence_anomaly_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF OLD.kind = 'policy_violation'
        AND OLD.detail ? 'observationId'
        AND OLD.detail ? 'derivedEffect'
        AND OLD.detail ? 'storedEffect'
        AND NEW.state = 'resolved'
        AND action_effect_derived(OLD.action_id) IS DISTINCT FROM OLD.detail->>'storedEffect' THEN
        RAISE EXCEPTION 'terminal evidence anomaly cannot resolve while current proof still diverges'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_anomalies_evidence_guard
    BEFORE UPDATE ON order_anomalies
    FOR EACH ROW EXECUTE FUNCTION evidence_anomaly_guard();

COMMENT ON COLUMN order_actions.rule_ver IS
    'Immutable version of the evidence reduction rule admitted for this action';
COMMENT ON VIEW action_obs_current IS
    'Current immutable revision of each versioned semantic observation fact';
COMMENT ON FUNCTION action_source_valid(VARCHAR, VARCHAR) IS
    'Authorize provider or chain evidence for each version 1 action rule';
COMMENT ON TABLE order_proof_caps IS
    'Migration-owned provider proof capabilities for each evidence rule version';
COMMENT ON FUNCTION action_effect_derived(UUID) IS
    'Derive possible, present, absent, or conflict from current versioned observation proofs';
COMMENT ON FUNCTION action_obs_reduction_guard() IS
    'Require every committed evidence fact to reduce its action or open a blocking terminal anomaly';
COMMENT ON FUNCTION evidence_anomaly_guard() IS
    'Keep terminal evidence anomalies blocking until current proof matches the stored terminal effect';
COMMENT ON FUNCTION order_action_transition_guard() IS
    'Enforce old-to-new action tuple edges and evidence-derived decisive outcomes';
