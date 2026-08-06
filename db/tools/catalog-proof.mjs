import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';

export const byteCompare = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

export const canonicalJson = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const entries = Object.keys(value)
            .sort(byteCompare)
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
        return `{${entries.join(',')}}`;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Catalog proof cannot serialize undefined');
    return encoded;
};

export const canonicalManifest = (rows) => {
    const encoded = rows.map(canonicalJson).sort(byteCompare);
    return `[${encoded.join(',')}]`;
};

const aclJson = (acl, owner, kind) => `jsonb_build_object(
    'default', ${acl} IS NULL,
    'grants', coalesce((
        SELECT jsonb_agg(
            jsonb_build_object(
                'grantor', grantor_role.rolname,
                'grantee', CASE WHEN grant_row.grantee = 0 THEN 'PUBLIC' ELSE grantee_role.rolname END,
                'privilege', grant_row.privilege_type,
                'grantable', grant_row.is_grantable
            )
            ORDER BY grantor_role.rolname COLLATE "C",
                     (CASE WHEN grant_row.grantee = 0 THEN 'PUBLIC' ELSE grantee_role.rolname END) COLLATE "C",
                     grant_row.privilege_type COLLATE "C",
                     grant_row.is_grantable
        )
          FROM aclexplode(coalesce(${acl}, acldefault(${kind}, ${owner}))) grant_row
          LEFT JOIN pg_roles grantor_role ON grantor_role.oid = grant_row.grantor
          LEFT JOIN pg_roles grantee_role ON grantee_role.oid = grant_row.grantee
    ), '[]'::jsonb)
)`;

const queries = [
    `SELECT jsonb_build_object(
         'kind', 'server',
         'major', current_setting('server_version_num')::int / 10000,
         'encoding', pg_encoding_to_char(d.encoding),
         'locale_provider', d.datlocprovider,
         'collate', d.datcollate,
         'ctype', d.datctype,
         'icu_locale', coalesce(d.daticulocale, ''),
         'icu_rules', coalesce(d.daticurules, ''),
         'collation_version', coalesce(d.datcollversion, '')
       ) AS value
       FROM pg_database d
      WHERE d.datname = current_database()`,
    `SELECT jsonb_build_object(
         'kind', 'extension', 'name', e.extname, 'version', e.extversion,
         'schema', n.nspname, 'owner', r.rolname, 'relocatable', e.extrelocatable,
         'config', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                        'relation', format('%I.%I', config_ns.nspname, config_rel.relname),
                        'condition', coalesce(e.extcondition[config_row.position::int], '')
                    ) ORDER BY config_row.position)
               FROM unnest(e.extconfig) WITH ORDINALITY config_row(relation_oid, position)
               JOIN pg_class config_rel ON config_rel.oid = config_row.relation_oid
               JOIN pg_namespace config_ns ON config_ns.oid = config_rel.relnamespace
         ), '[]'::jsonb)
       ) AS value
       FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace
       JOIN pg_roles r ON r.oid = e.extowner
      WHERE e.extname = 'pgcrypto'`,
    `SELECT jsonb_build_object(
         'kind', 'schema', 'name', n.nspname, 'owner', r.rolname,
         'acl', ${aclJson('n.nspacl', 'n.nspowner', `'n'::"char"`)}
       ) AS value
       FROM pg_namespace n
       JOIN pg_roles r ON r.oid = n.nspowner
      WHERE n.nspname = 'public'`,
    `SELECT jsonb_build_object(
         'kind', 'relation', 'name', c.relname, 'type', c.relkind,
         'owner', r.rolname, 'persistence', c.relpersistence,
         'acl', ${aclJson('c.relacl', 'c.relowner', `CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END`)},
         'partition', coalesce(pg_get_expr(c.relpartbound, c.oid, true), ''),
         'partition_key', CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) ELSE '' END,
         'row_security', c.relrowsecurity, 'force_row_security', c.relforcerowsecurity,
         'replica_identity', c.relreplident,
         'options', coalesce(c.reloptions::text, ''),
         'tablespace', coalesce(ts.spcname, '')
       ) AS value
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.oid = c.relowner
       LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')`,
    `SELECT jsonb_build_object(
         'kind', 'inheritance',
         'child_schema', child_ns.nspname, 'child', child.relname,
         'parent_schema', parent_ns.nspname, 'parent', parent.relname,
         'position', i.inhseqno, 'detach_pending', i.inhdetachpending
       ) AS value
       FROM pg_inherits i
       JOIN pg_class child ON child.oid = i.inhrelid
       JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
       JOIN pg_class parent ON parent.oid = i.inhparent
       JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
      WHERE child_ns.nspname = 'public' OR parent_ns.nspname = 'public'`,
    `SELECT jsonb_build_object(
         'kind', 'view', 'name', c.relname, 'definition', pg_get_viewdef(c.oid, true)
       ) AS value
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('v', 'm')`,
    `SELECT jsonb_build_object(
         'kind', 'sequence', 'name', c.relname, 'type', pg_catalog.format_type(s.seqtypid, NULL),
         'start', s.seqstart::text, 'increment', s.seqincrement::text, 'max', s.seqmax::text,
         'min', s.seqmin::text, 'cache', s.seqcache::text, 'cycle', s.seqcycle
       ) AS value
       FROM pg_sequence s
       JOIN pg_class c ON c.oid = s.seqrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'`,
    `SELECT jsonb_build_object(
         'kind', 'column', 'relation', c.relname, 'position', a.attnum,
         'name', a.attname, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
         'not_null', a.attnotnull, 'identity', a.attidentity,
         'generated', a.attgenerated, 'collation', coalesce(coll.collname, ''),
         'default', coalesce(pg_get_expr(d.adbin, d.adrelid, true), ''),
         'acl', ${aclJson('a.attacl', 'c.relowner', `'c'::"char"`)}
       ) AS value
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_collation coll ON coll.oid = a.attcollation AND a.attcollation <> 0
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'c')
        AND a.attnum > 0
        AND NOT a.attisdropped`,
    `SELECT jsonb_build_object(
         'kind', 'constraint', 'relation', c.relname, 'name', con.conname,
         'type', con.contype, 'validated', con.convalidated,
         'definition', pg_get_constraintdef(con.oid, true)
       ) AS value
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'`,
    `SELECT jsonb_build_object(
         'kind', 'index', 'relation', t.relname, 'name', i.relname,
         'definition', pg_get_indexdef(i.oid), 'valid', x.indisvalid,
         'ready', x.indisready, 'live', x.indislive,
         'primary', x.indisprimary, 'unique', x.indisunique,
         'exclusion', x.indisexclusion, 'replica_identity', x.indisreplident,
         'owner', r.rolname, 'options', coalesce(i.reloptions::text, ''),
         'tablespace', coalesce(ts.spcname, '')
       ) AS value
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_roles r ON r.oid = i.relowner
       LEFT JOIN pg_tablespace ts ON ts.oid = i.reltablespace
      WHERE n.nspname = 'public'`,
    `SELECT jsonb_build_object(
         'kind', 'trigger', 'relation', c.relname, 'name', t.tgname,
         'enabled', t.tgenabled, 'definition', pg_get_triggerdef(t.oid, true)
       ) AS value
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND NOT t.tgisinternal`,
    `SELECT jsonb_build_object(
         'kind', 'function', 'name', p.proname,
         'args', pg_get_function_identity_arguments(p.oid),
         'definition', pg_get_functiondef(p.oid), 'owner', r.rolname,
         'acl', ${aclJson('p.proacl', 'p.proowner', `'f'::"char"`)}, 'language', l.lanname,
         'function_kind', p.prokind, 'security_definer', p.prosecdef,
         'leakproof', p.proleakproof, 'strict', p.proisstrict,
         'volatility', p.provolatile, 'parallel', p.proparallel,
         'config', coalesce(p.proconfig::text, '')
       ) AS value
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_roles r ON r.oid = p.proowner
       JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = 'public'
        AND NOT EXISTS (
          SELECT 1
            FROM pg_depend d
           WHERE d.classid = 'pg_proc'::regclass
             AND d.objid = p.oid
             AND d.deptype = 'e'
        )`,
    `SELECT jsonb_build_object(
         'kind', 'type', 'name', t.typname, 'type_class', t.typtype,
         'owner', r.rolname, 'acl', ${aclJson('t.typacl', 't.typowner', `'T'::"char"`)},
         'not_null', t.typnotnull, 'default', coalesce(t.typdefault, ''),
         'collation', CASE WHEN coll.oid IS NULL THEN '' ELSE format('%I.%I', coll_ns.nspname, coll.collname) END,
         'relation', coalesce(c.relname, ''), 'length', t.typlen,
         'by_value', t.typbyval, 'alignment', t.typalign, 'storage', t.typstorage,
         'category', t.typcategory, 'preferred', t.typispreferred,
         'delimiter', t.typdelim,
         'definition',
         CASE WHEN t.typtype = 'd' THEN jsonb_build_object(
                    'base', pg_catalog.format_type(t.typbasetype, t.typtypmod))
              WHEN t.typtype = 'e' THEN coalesce((
                    SELECT jsonb_agg(jsonb_build_object('label', e.enumlabel, 'order', e.enumsortorder::text)
                                     ORDER BY e.enumsortorder)
                      FROM pg_enum e WHERE e.enumtypid = t.oid
              ), '[]'::jsonb)
              ELSE '{}'::jsonb END
       ) AS value
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_roles r ON r.oid = t.typowner
       LEFT JOIN pg_collation coll ON coll.oid = t.typcollation AND t.typcollation <> 0
       LEFT JOIN pg_namespace coll_ns ON coll_ns.oid = coll.collnamespace
       LEFT JOIN pg_class c ON c.oid = t.typrelid
      WHERE n.nspname = 'public'
        AND t.typtype IN ('b', 'c', 'd', 'e', 'm', 'r')
        AND NOT (t.typcategory = 'A' AND t.typelem <> 0)
        AND NOT EXISTS (
          SELECT 1
            FROM pg_depend d
           WHERE d.classid = 'pg_type'::regclass
             AND d.objid = t.oid
             AND d.deptype = 'e'
        )`,
    `SELECT jsonb_build_object(
         'kind', 'type_constraint', 'type', t.typname, 'name', con.conname,
         'validated', con.convalidated, 'definition', pg_get_constraintdef(con.oid, true)
       ) AS value
       FROM pg_constraint con
       JOIN pg_type t ON t.oid = con.contypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'`,
    `SELECT jsonb_build_object(
         'kind', 'range', 'type', pg_catalog.format_type(r.rngtypid, NULL),
         'subtype', pg_catalog.format_type(r.rngsubtype, NULL),
         'collation', CASE WHEN coll.oid IS NULL THEN '' ELSE format('%I.%I', coll_ns.nspname, coll.collname) END,
         'opclass', format('%I.%I', op_ns.nspname, op.opcname),
         'canonical', CASE WHEN r.rngcanonical = 0 THEN '' ELSE r.rngcanonical::regprocedure::text END,
         'subdiff', CASE WHEN r.rngsubdiff = 0 THEN '' ELSE r.rngsubdiff::regprocedure::text END,
         'multirange', pg_catalog.format_type(r.rngmultitypid, NULL)
       ) AS value
       FROM pg_range r
       JOIN pg_type t ON t.oid = r.rngtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_opclass op ON op.oid = r.rngsubopc
       JOIN pg_namespace op_ns ON op_ns.oid = op.opcnamespace
       LEFT JOIN pg_collation coll ON coll.oid = r.rngcollation AND r.rngcollation <> 0
       LEFT JOIN pg_namespace coll_ns ON coll_ns.oid = coll.collnamespace
      WHERE n.nspname = 'public'`,
    `SELECT jsonb_build_object(
         'kind', 'policy', 'relation', c.relname, 'name', p.polname,
         'permissive', p.polpermissive, 'roles', ARRAY(
             SELECT CASE WHEN role_oid = 0 THEN 'public' ELSE r.rolname END
               FROM unnest(p.polroles) role_oid
               LEFT JOIN pg_roles r ON r.oid = role_oid
              ORDER BY (CASE WHEN role_oid = 0 THEN 'public' ELSE r.rolname END) COLLATE "C"
         )::text,
         'command', p.polcmd, 'using', coalesce(pg_get_expr(p.polqual, p.polrelid, true), ''),
         'check', coalesce(pg_get_expr(p.polwithcheck, p.polrelid, true), '')
       ) AS value
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'`,
    `SELECT jsonb_build_object(
         'kind', 'rule', 'relation', c.relname, 'name', r.rulename,
         'enabled', r.ev_enabled, 'definition', pg_get_ruledef(r.oid, true)
       ) AS value
       FROM pg_rewrite r
       JOIN pg_class c ON c.oid = r.ev_class
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND r.rulename <> '_RETURN'`,
    `SELECT jsonb_build_object(
         'kind', 'operator', 'name', o.oprname, 'owner', r.rolname,
         'operator_kind', o.oprkind,
         'left', CASE WHEN o.oprleft = 0 THEN '' ELSE pg_catalog.format_type(o.oprleft, NULL) END,
         'right', CASE WHEN o.oprright = 0 THEN '' ELSE pg_catalog.format_type(o.oprright, NULL) END,
         'result', pg_catalog.format_type(o.oprresult, NULL),
         'function', o.oprcode::regprocedure::text,
         'commutator', CASE WHEN o.oprcom = 0 THEN '' ELSE o.oprcom::regoperator::text END,
         'negator', CASE WHEN o.oprnegate = 0 THEN '' ELSE o.oprnegate::regoperator::text END,
         'restrict', CASE WHEN o.oprrest = 0 THEN '' ELSE o.oprrest::regprocedure::text END,
         'join', CASE WHEN o.oprjoin = 0 THEN '' ELSE o.oprjoin::regprocedure::text END,
         'hash', o.oprcanhash, 'merge', o.oprcanmerge
       ) AS value
       FROM pg_operator o
       JOIN pg_namespace n ON n.oid = o.oprnamespace
       JOIN pg_roles r ON r.oid = o.oprowner
      WHERE n.nspname = 'public'`,
    `SELECT jsonb_build_object(
         'kind', 'collation', 'name', c.collname, 'owner', r.rolname,
         'provider', c.collprovider, 'deterministic', c.collisdeterministic,
         'encoding', c.collencoding, 'collate', c.collcollate,
         'ctype', c.collctype,
         'locale', coalesce(to_jsonb(c)->>'colliculocale', to_jsonb(c)->>'colllocale', ''),
         'icu_rules', coalesce(to_jsonb(c)->>'collicurules', ''),
         'version', coalesce(c.collversion, '')
       ) AS value
       FROM pg_collation c
       JOIN pg_namespace n ON n.oid = c.collnamespace
      JOIN pg_roles r ON r.oid = c.collowner
      WHERE n.nspname = 'public'`,
    `SELECT jsonb_build_object(
         'kind', 'default_acl', 'owner', owner_role.rolname,
         'schema', coalesce(n.nspname, ''), 'object_type', d.defaclobjtype,
         'acl', ${aclJson('d.defaclacl', 'd.defaclrole', `CASE WHEN d.defaclobjtype = 'S' THEN 's'::"char" ELSE d.defaclobjtype END`)}
       ) AS value
       FROM pg_default_acl d
       JOIN pg_roles owner_role ON owner_role.oid = d.defaclrole
       LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      WHERE (d.defaclnamespace = 0 OR n.nspname = 'public')
        AND EXISTS (
            SELECT 1 FROM pg_class c
             WHERE c.relnamespace = 'public'::regnamespace AND c.relowner = d.defaclrole
            UNION ALL
            SELECT 1 FROM pg_proc p
             WHERE p.pronamespace = 'public'::regnamespace AND p.proowner = d.defaclrole
            UNION ALL
            SELECT 1 FROM pg_type t
             WHERE t.typnamespace = 'public'::regnamespace AND t.typowner = d.defaclrole
        )`,
];

export const catalogRows = async (client) => {
    const result = await client.query(queries.map((query) => `(${query})`).join('\nUNION ALL\n'));
    const manifest = canonicalManifest(result.rows.map((row) => row.value));
    return JSON.parse(manifest);
};

export const catalogProof = async (client) => {
    const rows = await catalogRows(client);
    const encoded = canonicalManifest(rows);
    const digest = createHash('sha256').update(encoded).digest('hex');
    return { digest, rows: rows.length, manifest: JSON.parse(encoded) };
};

export const publicRelations = async (client) => {
    const result = await client.query(`
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
         ORDER BY c.relname COLLATE "C"
    `);
    return result.rows.map((row) => row.relname);
};

export const hasHistory = async (client, plane) => {
    const relation = `fervor_${plane}_meta.fervor_${plane}_history`;
    const result = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [relation]);
    return result.rows[0].present;
};

export const dataViolations = async (client, root, plane) => {
    if (plane !== 'core') return [];
    const sql = fs.readFileSync(path.join(root, 'db/core/adoption/data-checks.sql'), 'utf8');
    const result = await client.query(sql);
    return result.rows.filter((row) => Number(row.violations) !== 0);
};
