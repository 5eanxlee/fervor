-- New provider evidence carries its exact canonical document. Every leg of a
-- provider claim binds to that one document, and only chain evidence for the
-- same transaction and semantic effect may clear the claim.
-- stride: destructive-review=provider-evidence-integrity-v58

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE asset_evidence
    ADD COLUMN payload_canon TEXT;

CREATE FUNCTION asset_json_canon(value JSONB) RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    kind TEXT := pg_catalog.jsonb_typeof(value);
    encoded TEXT;
BEGIN
    IF kind = 'object' THEN
        SELECT '{' || coalesce(pg_catalog.string_agg(
                   pg_catalog.to_jsonb(item.key)::text || ':' || public.asset_json_canon(item.value),
                   ',' ORDER BY pg_catalog.convert_to(item.key, 'UTF8')
               ), '') || '}'
          INTO encoded
          FROM pg_catalog.jsonb_each(value) item;
        RETURN encoded;
    END IF;
    IF kind = 'array' THEN
        SELECT '[' || coalesce(pg_catalog.string_agg(
                   public.asset_json_canon(item.value), ',' ORDER BY item.ordinality
               ), '') || ']'
          INTO encoded
          FROM pg_catalog.jsonb_array_elements(value) WITH ORDINALITY item(value, ordinality);
        RETURN encoded;
    END IF;
    RETURN value::text;
END;
$$;

CREATE FUNCTION asset_payload_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NEW.payload IS NULL THEN
        IF NEW.payload_canon IS NOT NULL THEN
            RAISE EXCEPTION 'evidence without a payload cannot carry canonical payload bytes'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.payload_canon IS NULL
        OR pg_catalog.octet_length(NEW.payload_canon) > 16384 THEN
        RAISE EXCEPTION 'evidence payload requires bounded canonical bytes'
            USING ERRCODE = '23514';
    END IF;
    BEGIN
        IF NEW.payload_canon::jsonb IS DISTINCT FROM NEW.payload THEN
            RAISE EXCEPTION 'canonical evidence bytes do not encode the stored payload'
                USING ERRCODE = '23514';
        END IF;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'canonical evidence bytes are not valid JSON'
            USING ERRCODE = '23514';
    END;
    IF NEW.payload_canon IS DISTINCT FROM public.asset_json_canon(NEW.payload) THEN
        RAISE EXCEPTION 'evidence payload bytes are not canonical JSON'
            USING ERRCODE = '23514';
    END IF;
    IF pg_catalog.encode(public.digest(
        pg_catalog.convert_to(NEW.payload_canon, 'UTF8'), 'sha256'
    ), 'hex') <> NEW.payload_hash THEN
        RAISE EXCEPTION 'evidence payload hash does not match its canonical bytes'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER asset_evidence_payload_guard
    BEFORE INSERT ON asset_evidence
    FOR EACH ROW EXECUTE FUNCTION asset_payload_guard();

CREATE FUNCTION asset_assert_claim_doc(target UUID) RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    obligation asset_obligations%ROWTYPE;
    opening asset_evidence%ROWTYPE;
BEGIN
    SELECT * INTO obligation
      FROM asset_obligations stored
     WHERE stored.id = target;
    IF NOT FOUND OR obligation.claim_ver IS DISTINCT FROM 2 THEN
        RETURN;
    END IF;

    SELECT * INTO opening
      FROM asset_evidence evidence
     WHERE evidence.id = obligation.open_evidence_id;
    IF NOT FOUND OR opening.source <> 'provider'
        OR opening.signature IS NULL
        OR opening.payload IS NULL
        OR pg_catalog.encode(public.digest(
            pg_catalog.convert_to(coalesce(
                opening.payload_canon, public.asset_json_canon(opening.payload)
            ), 'UTF8'), 'sha256'
        ), 'hex') <> opening.payload_hash THEN
        RAISE EXCEPTION 'provider claim lacks a verifiable opening document'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM asset_claim_parts part
          JOIN asset_evidence evidence ON evidence.id = part.evidence_id
         WHERE part.obligation_id = target
           AND (
               evidence.source <> 'provider'
               OR evidence.signature IS DISTINCT FROM opening.signature
               OR evidence.effect_key IS DISTINCT FROM opening.effect_key
               OR evidence.payload_hash IS DISTINCT FROM opening.payload_hash
               OR evidence.payload IS DISTINCT FROM opening.payload
               OR coalesce(
                   evidence.payload_canon, public.asset_json_canon(evidence.payload)
               ) IS DISTINCT FROM coalesce(
                   opening.payload_canon, public.asset_json_canon(opening.payload)
               )
               OR pg_catalog.encode(public.digest(
                   pg_catalog.convert_to(coalesce(
                       evidence.payload_canon, public.asset_json_canon(evidence.payload)
                   ), 'UTF8'), 'sha256'
               ), 'hex') <> evidence.payload_hash
               OR evidence.source_at IS DISTINCT FROM opening.source_at
           )
    ) THEN
        RAISE EXCEPTION 'provider claim legs do not share one exact provider document'
            USING ERRCODE = '23514';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION asset_claim_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    PERFORM asset_lock_claim_scope(NEW.id);
    PERFORM asset_assert_claim(NEW.id);
    PERFORM asset_assert_claim_doc(NEW.id);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION asset_claim_part_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    PERFORM asset_assert_claim(NEW.obligation_id);
    PERFORM asset_assert_claim_doc(NEW.obligation_id);
    RETURN NULL;
END;
$$;

CREATE FUNCTION asset_claim_clear_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    opening asset_evidence%ROWTYPE;
BEGIN
    IF OLD.claim_ver IS DISTINCT FROM 2
        OR OLD.state NOT IN ('open', 'review')
        OR NEW.state <> 'cleared' THEN
        RETURN NEW;
    END IF;

    PERFORM public.asset_assert_claim_doc(OLD.id);

    SELECT * INTO opening
      FROM asset_evidence evidence
     WHERE evidence.id = OLD.open_evidence_id;
    IF NOT FOUND OR opening.source <> 'provider'
        OR opening.signature IS NULL OR opening.payload IS NULL
        OR pg_catalog.encode(public.digest(
            pg_catalog.convert_to(coalesce(
                opening.payload_canon, public.asset_json_canon(opening.payload)
            ), 'UTF8'), 'sha256'
        ), 'hex') <> opening.payload_hash
        OR NEW.clear_journal_id IS NULL
        OR NOT EXISTS (
            SELECT 1
              FROM asset_evidence proof
             WHERE proof.source = 'chain'
               AND proof.journal_id = NEW.clear_journal_id
               AND proof.commitment IN ('confirmed', 'finalized')
               AND proof.signature = opening.signature
               AND proof.effect_key = opening.effect_key
               AND proof.cluster = OLD.cluster
               AND proof.wallet_address = OLD.wallet_address
               AND proof.vault_address IS NOT DISTINCT FROM OLD.vault_address
               AND proof.order_id IS NOT DISTINCT FROM OLD.order_id
               AND proof.action_id IS NOT DISTINCT FROM OLD.action_id
        ) THEN
        RAISE EXCEPTION 'provider claim clearing lacks matching independent chain evidence'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER asset_obligation_claim_clear_guard
    BEFORE UPDATE ON asset_obligations
    FOR EACH ROW EXECUTE FUNCTION asset_claim_clear_guard();

COMMENT ON COLUMN asset_evidence.payload_canon IS
    'Exact canonical UTF-8 JSON bytes whose SHA-256 is payload_hash; required for new payload evidence';
COMMENT ON FUNCTION asset_json_canon(JSONB) IS
    'Deterministic UTF-8 byte-ordered compact JSON used to verify current and legacy evidence payloads';
COMMENT ON FUNCTION asset_assert_claim_doc(UUID) IS
    'Requires every version 2 claim leg to share one signature and canonical provider document';
COMMENT ON FUNCTION asset_claim_clear_guard() IS
    'Binds provider claim clearing to confirmed chain evidence for the same signature and effect';
