-- Remove every writable-schema and inherited-role path into the signed-blob
-- security-definer boundary. Production preflight reuses assert_tx_roles after
-- this version is recorded so later catalog drift also fails closed.
-- stride: destructive-review=transaction-role-hardening-v2

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.assert_blob_access(
    target_action UUID,
    target_attempt UUID,
    target_owner VARCHAR,
    target_gen BIGINT,
    target_scope VARCHAR,
    target_epoch BIGINT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    action_row public.order_actions%ROWTYPE;
    attempt_row public.action_attempts%ROWTYPE;
    target_order UUID;
    blob_ok BOOLEAN;
    now_at TIMESTAMPTZ;
BEGIN
    SELECT stored.order_id INTO target_order
      FROM public.order_actions stored
     WHERE stored.id = target_action;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'blob-read action does not exist' USING ERRCODE = '23514';
    END IF;

    PERFORM 1 FROM public.order_intents stored WHERE stored.id = target_order FOR SHARE;
    SELECT * INTO action_row
      FROM public.order_actions stored
     WHERE stored.id = target_action
     FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'blob-read action does not exist' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO attempt_row
      FROM public.action_attempts stored
     WHERE stored.id = target_attempt
     FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'blob-read attempt does not exist' USING ERRCODE = '23514';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtextextended(target_scope, 1937006964)
    );
    PERFORM 1
      FROM public.order_tx_blobs blob
     WHERE blob.action_id = target_action
       AND blob.aad_ver = 2
       AND blob.purged_at IS NULL
       AND blob.expires_at > attempt_row.deadline_at
     FOR SHARE;
    blob_ok := FOUND;
    now_at := pg_catalog.clock_timestamp();

    IF attempt_row.action_id <> action_row.id
        OR attempt_row.send_state <> 'started'
        OR attempt_row.deadline_at <= now_at
        OR action_row.lease_owner IS NULL
        OR target_owner IS NULL
        OR action_row.lease_owner <> target_owner
        OR action_row.lease_gen <> target_gen
        OR action_row.lease_until <= now_at
        OR action_row.write_scope <> target_scope
        OR action_row.write_epoch <> target_epoch
        OR attempt_row.lease_gen <> target_gen
        OR attempt_row.write_scope <> target_scope
        OR attempt_row.write_epoch <> target_epoch
        OR NOT EXISTS (
            SELECT 1 FROM public.order_epoch_current epoch
             WHERE epoch.scope = target_scope
               AND epoch.epoch = target_epoch
               AND epoch.mode = 'live'
        )
        OR NOT blob_ok THEN
        RAISE EXCEPTION 'blob access does not match one live outbound authorization'
            USING ERRCODE = '40001';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.order_blob_read_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM public.assert_blob_access(
        NEW.action_id,
        NEW.attempt_id,
        NEW.lease_owner,
        NEW.lease_gen,
        NEW.write_scope,
        NEW.write_epoch
    );
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_order_tx_blob(
    target UUID,
    proof VARCHAR,
    destroyed TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    target_order UUID;
BEGIN
    IF proof IS NULL OR pg_catalog.btrim(proof) = '' OR destroyed IS NULL THEN
        RAISE EXCEPTION 'destruction proof and time are required' USING ERRCODE = '22023';
    END IF;

    SELECT action.order_id INTO target_order
      FROM public.order_actions action
     WHERE action.id = target;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    PERFORM 1
      FROM public.order_intents order_row
     WHERE order_row.id = target_order
     FOR UPDATE;
    PERFORM 1 FROM public.order_actions action WHERE action.id = target FOR UPDATE;
    PERFORM 1 FROM public.action_attempts attempt WHERE attempt.action_id = target FOR SHARE;
    PERFORM 1
      FROM public.order_tx_blobs blob
     WHERE blob.action_id = target AND blob.purged_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    UPDATE public.order_tx_blobs blob
       SET ciphertext = pg_catalog.decode(pg_catalog.repeat('00', 17), 'hex'),
           nonce = pg_catalog.decode(
               pg_catalog.repeat('00', CASE WHEN blob.alg = 'aes_256_gcm' THEN 12 ELSE 24 END),
               'hex'
           ),
           wrapped_key = pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex'),
           key_id = 'destroyed',
           destroyed_at = destroyed,
           destroy_ref = proof,
           purged_at = pg_catalog.clock_timestamp()
     WHERE blob.action_id = target AND blob.purged_at IS NULL;
    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_blob_access(
    UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.order_blob_read_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ) FROM PUBLIC;

CREATE FUNCTION public.assert_tx_roles() RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    runtime_oid OID;
    maintenance_oid OID;
    owner_oid OID;
    schema_oid OID;
    schema_owner OID;
    unsafe_role TEXT;
BEGIN
    SELECT role.oid INTO runtime_oid
      FROM pg_catalog.pg_roles role
     WHERE role.rolname = 'core_runtime';
    SELECT role.oid INTO maintenance_oid
      FROM pg_catalog.pg_roles role
     WHERE role.rolname = 'core_maintenance';
    IF runtime_oid IS NULL OR maintenance_oid IS NULL THEN
        RAISE EXCEPTION 'required core transaction roles are missing'
            USING ERRCODE = '42501';
    END IF;

    SELECT role.rolname INTO unsafe_role
      FROM pg_catalog.pg_roles role
     WHERE role.oid IN (runtime_oid, maintenance_oid)
       AND (
           role.rolsuper OR role.rolcreaterole OR role.rolcreatedb
           OR role.rolreplication OR role.rolbypassrls
       )
     ORDER BY role.rolname
     LIMIT 1;
    IF unsafe_role IS NOT NULL THEN
        RAISE EXCEPTION 'core transaction role % has unsafe attributes', unsafe_role
            USING ERRCODE = '42501';
    END IF;

    WITH RECURSIVE parents(root_oid, role_oid) AS (
        SELECT membership.member, membership.roleid
          FROM pg_catalog.pg_auth_members membership
         WHERE membership.member IN (runtime_oid, maintenance_oid)
        UNION
        SELECT parents.root_oid, membership.roleid
          FROM parents
          JOIN pg_catalog.pg_auth_members membership ON membership.member = parents.role_oid
    )
    SELECT parent.rolname INTO unsafe_role
      FROM parents
      JOIN pg_catalog.pg_roles parent ON parent.oid = parents.role_oid
     ORDER BY parent.rolname
     LIMIT 1;
    IF unsafe_role IS NOT NULL THEN
        RAISE EXCEPTION 'core transaction roles must not inherit or set parent role %', unsafe_role
            USING ERRCODE = '42501';
    END IF;

    SELECT fn.proowner INTO owner_oid
      FROM pg_catalog.pg_proc fn
     WHERE fn.oid = 'public.assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)'::pg_catalog.regprocedure;
    IF owner_oid IN (runtime_oid, maintenance_oid)
        OR pg_catalog.pg_has_role(runtime_oid, owner_oid, 'MEMBER')
        OR pg_catalog.pg_has_role(maintenance_oid, owner_oid, 'MEMBER')
        OR EXISTS (
            SELECT 1
              FROM pg_catalog.pg_proc fn
             WHERE fn.oid IN (
                 'public.assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)'::pg_catalog.regprocedure,
                 'public.order_blob_read_guard()'::pg_catalog.regprocedure,
                 'public.purge_order_tx_blob(uuid,character varying,timestamp with time zone)'::pg_catalog.regprocedure
             )
               AND fn.proowner <> owner_oid
        ) THEN
        RAISE EXCEPTION 'transaction function owner is not isolated from caller roles'
            USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc fn
         WHERE fn.oid IN (
             'public.assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)'::pg_catalog.regprocedure,
             'public.purge_order_tx_blob(uuid,character varying,timestamp with time zone)'::pg_catalog.regprocedure
         )
           AND (
               NOT fn.prosecdef
               OR fn.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::TEXT[]
           )
    ) OR EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc fn
         WHERE fn.oid = 'public.order_blob_read_guard()'::pg_catalog.regprocedure
           AND (
               fn.prosecdef
               OR fn.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::TEXT[]
           )
    ) THEN
        RAISE EXCEPTION 'transaction functions have an unsafe execution context'
            USING ERRCODE = '42501';
    END IF;

    IF NOT pg_catalog.has_function_privilege(
            runtime_oid,
            'public.assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)'::pg_catalog.regprocedure,
            'EXECUTE'
        )
        OR pg_catalog.has_function_privilege(
            runtime_oid,
            'public.purge_order_tx_blob(uuid,character varying,timestamp with time zone)'::pg_catalog.regprocedure,
            'EXECUTE'
        )
        OR pg_catalog.has_function_privilege(
            runtime_oid,
            'public.order_blob_read_guard()'::pg_catalog.regprocedure,
            'EXECUTE'
        )
        OR NOT pg_catalog.has_function_privilege(
            maintenance_oid,
            'public.purge_order_tx_blob(uuid,character varying,timestamp with time zone)'::pg_catalog.regprocedure,
            'EXECUTE'
        )
        OR pg_catalog.has_function_privilege(
            maintenance_oid,
            'public.assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)'::pg_catalog.regprocedure,
            'EXECUTE'
        )
        OR pg_catalog.has_function_privilege(
            maintenance_oid,
            'public.order_blob_read_guard()'::pg_catalog.regprocedure,
            'EXECUTE'
        ) THEN
        RAISE EXCEPTION 'transaction caller roles have unsafe effective function privileges'
            USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_proc fn
          CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(fn.proacl, pg_catalog.acldefault('f', fn.proowner))
          ) acl
         WHERE fn.oid IN (
             'public.assert_blob_access(uuid,uuid,character varying,bigint,character varying,bigint)'::pg_catalog.regprocedure,
             'public.order_blob_read_guard()'::pg_catalog.regprocedure,
             'public.purge_order_tx_blob(uuid,character varying,timestamp with time zone)'::pg_catalog.regprocedure
         )
           AND acl.grantee = 0
           AND acl.privilege_type = 'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'transaction functions remain executable by PUBLIC'
            USING ERRCODE = '42501';
    END IF;

    SELECT namespace.oid, namespace.nspowner INTO schema_oid, schema_owner
      FROM pg_catalog.pg_namespace namespace
     WHERE namespace.nspname = 'public';
    IF pg_catalog.has_schema_privilege(runtime_oid, schema_oid, 'CREATE')
        OR pg_catalog.has_schema_privilege(maintenance_oid, schema_oid, 'CREATE')
        OR EXISTS (
            SELECT 1
              FROM pg_catalog.pg_namespace namespace
              CROSS JOIN LATERAL pg_catalog.aclexplode(
                  COALESCE(
                      namespace.nspacl,
                      pg_catalog.acldefault('n', namespace.nspowner)
                  )
              ) acl
             WHERE namespace.oid = schema_oid
               AND acl.grantee = 0
               AND acl.privilege_type = 'CREATE'
        ) THEN
        RAISE EXCEPTION 'public schema remains writable by transaction callers or PUBLIC'
            USING ERRCODE = '42501';
    END IF;

    SELECT role.rolname INTO unsafe_role
      FROM pg_catalog.pg_roles role
     WHERE pg_catalog.has_schema_privilege(role.oid, schema_oid, 'CREATE')
       AND NOT role.rolsuper
       AND NOT pg_catalog.pg_has_role(role.oid, schema_owner, 'MEMBER')
     ORDER BY role.rolname
     LIMIT 1;
    IF unsafe_role IS NOT NULL THEN
        RAISE EXCEPTION 'public schema has untrusted creator role %', unsafe_role
            USING ERRCODE = '42501';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_tx_roles() FROM PUBLIC;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'core_runtime'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'core_maintenance'
    ) THEN
        RETURN;
    END IF;

    GRANT USAGE ON SCHEMA public TO core_runtime, core_maintenance;
    REVOKE CREATE ON SCHEMA public FROM core_runtime, core_maintenance;

    GRANT EXECUTE ON FUNCTION public.assert_blob_access(
        UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT
    ) TO core_runtime;
    REVOKE ALL ON FUNCTION public.order_blob_read_guard() FROM core_runtime;
    REVOKE ALL ON FUNCTION public.purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ)
        FROM core_runtime;

    GRANT EXECUTE ON FUNCTION public.purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ)
        TO core_maintenance;
    REVOKE ALL ON FUNCTION public.assert_blob_access(
        UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT
    ) FROM core_maintenance;
    REVOKE ALL ON FUNCTION public.order_blob_read_guard() FROM core_maintenance;

    PERFORM public.assert_tx_roles();
END;
$$;

COMMENT ON FUNCTION public.assert_blob_access(
    UUID, UUID, VARCHAR, BIGINT, VARCHAR, BIGINT
) IS 'Isolated security-definer authorization for one exact live signed-blob attempt';
COMMENT ON FUNCTION public.purge_order_tx_blob(UUID, VARCHAR, TIMESTAMPTZ) IS
    'Isolated security-definer terminal crypto tombstone for signed transaction bytes';
COMMENT ON FUNCTION public.assert_tx_roles() IS
    'Fail-closed catalog assertion for signed-blob caller roles, owners, paths, and ACLs';
