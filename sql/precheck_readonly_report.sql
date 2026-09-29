-- ============================================================
-- precheck_readonly_report.sql   (الخطوة 0 — قراءة فقط)
-- تقرير JSON واحد بالمفاتيح S0..S9 قبل أي ترحيل
-- ============================================================
-- التشغيل: Supabase → SQL Editor → الصق الملف كاملًا → Run.
--   المحرر يعرض نتيجة آخر جملة فقط = عمود report واحد (JSON).
-- قراءة فقط: لا يعدّل أي جدول أو سياسة أو منحة. ينشئ دوال مؤقتة في pg_temp فقط
--   (خاصة بالجلسة وتختفي بانتهائها)، وآخر جملة SELECT.
-- الخصوصية: المستودع عام. التقرير لا يُخرج أسماء أو بريدًا أو مسارات ملفات أو محتوى صفوف —
--   أعداد وبنية وتعريفات سياسات فقط، فيمكن لصقه في الـ PR.
-- STOP: إن احتوى report.stop على أي عنصر فلا يُطبَّق أي ترحيل قبل المراجعة.
-- ============================================================

CREATE OR REPLACE FUNCTION pg_temp.ev_key(p_file_url text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_raw text := btrim(COALESCE(p_file_url, ''));
  v_path text; v_enc text; v_marker text; v_pos int;
  v_bytes bytea := '\x'::bytea; v_i int := 1; v_c text;
BEGIN
  IF v_raw = '' THEN RETURN NULL; END IF;
  IF v_raw !~* '^https?://' THEN
    RETURN regexp_replace(regexp_replace(v_raw, '^/+', ''), '^evidences/', '');
  END IF;
  v_path := split_part(split_part(regexp_replace(v_raw, '^https?://[^/]*', '', 'i'), '?', 1), '#', 1);
  FOREACH v_marker IN ARRAY ARRAY[
    '/storage/v1/object/public/evidences/',
    '/storage/v1/object/sign/evidences/',
    '/storage/v1/object/authenticated/evidences/'
  ] LOOP
    v_pos := strpos(v_path, v_marker);
    IF v_pos > 0 THEN v_enc := substr(v_path, v_pos + length(v_marker)); EXIT; END IF;
  END LOOP;
  IF v_enc IS NULL OR v_enc = '' THEN RETURN NULL; END IF;
  WHILE v_i <= length(v_enc) LOOP
    v_c := substr(v_enc, v_i, 1);
    IF v_c = '%' AND substr(v_enc, v_i + 1, 2) ~ '^[0-9A-Fa-f]{2}$' THEN
      v_bytes := v_bytes || decode(substr(v_enc, v_i + 1, 2), 'hex'); v_i := v_i + 3;
    ELSE
      v_bytes := v_bytes || convert_to(v_c, 'UTF8'); v_i := v_i + 1;
    END IF;
  END LOOP;
  RETURN convert_from(v_bytes, 'UTF8');
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

-- S1: نشاط reports (عدد فعلي + آخر كتابة إن وُجدت أعمدة زمنية) — بلا محتوى صفوف
CREATE OR REPLACE FUNCTION pg_temp.reports_activity()
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb := '{}'::jsonb; v bigint; t timestamptz; c text;
BEGIN
  IF to_regclass('public.reports') IS NULL THEN RETURN jsonb_build_object('exists', false); END IF;
  EXECUTE 'SELECT COUNT(*) FROM public.reports' INTO v;
  r := r || jsonb_build_object('exists', true, 'row_count', v);
  FOREACH c IN ARRAY ARRAY['created_at','updated_at','inserted_at'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='reports' AND column_name=c) THEN
      EXECUTE format('SELECT MAX(%I)::timestamptz FROM public.reports', c) INTO t;
      r := r || jsonb_build_object('max_' || c, t);
      EXECUTE format('SELECT COUNT(*) FROM public.reports WHERE %I > now() - interval ''30 days''', c) INTO v;
      r := r || jsonb_build_object('rows_last_30d_by_' || c, v);
    END IF;
  END LOOP;
  RETURN r;
END $$;

-- S7: أثر سياسة Storage الجديدة على شواهد السنة النشطة
CREATE OR REPLACE FUNCTION pg_temp.s7()
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  IF to_regclass('public.evidences') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RETURN jsonb_build_object('skipped', 'evidences or storage.objects missing');
  END IF;
  WITH ev AS (
    SELECT e.id, e.file_url, pg_temp.ev_key(e.file_url) AS k
    FROM public.evidences e
    JOIN public.school_years sy ON sy.id = e.school_year_id AND sy.is_active
    WHERE e.file_url IS NOT NULL AND btrim(e.file_url) <> ''
  ), m AS (
    SELECT ev.*,
      EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id='evidences' AND o.name = ev.k) AS new_match,
      EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id='evidences'
              AND (o.name = ev.file_url OR right(ev.file_url, length(o.name) + 11) = '/evidences/' || o.name)) AS old_match
    FROM ev
  )
  SELECT jsonb_build_object(
    'active_year_file_evidences', COUNT(*),
    'key_extractable', COUNT(*) FILTER (WHERE k IS NOT NULL),
    'object_found_by_new_key', COUNT(*) FILTER (WHERE new_match),
    'object_found_by_old_path_match', COUNT(*) FILTER (WHERE old_match),
    'WOULD_BE_CUT_old_match_but_not_new_key', COUNT(*) FILTER (WHERE old_match AND NOT new_match),
    'object_missing_both_ways', COUNT(*) FILTER (WHERE NOT old_match AND NOT new_match),
    'legacy_http_urls', COUNT(*) FILTER (WHERE file_url ~* '^https?://'),
    'legacy_http_urls_matched', COUNT(*) FILTER (WHERE file_url ~* '^https?://' AND new_match)
  ) INTO r FROM m;
  RETURN r || jsonb_build_object(
    'objects_in_bucket', (SELECT COUNT(*) FROM storage.objects WHERE bucket_id='evidences'),
    'objects_outside_uuid_folder', (SELECT COUNT(*) FROM storage.objects WHERE bucket_id='evidences'
        AND split_part(name, '/', 1) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  );
END $$;

-- S9: جاهزية ترحيل المهام + مرشّحات الإسناد (أعداد فقط)
CREATE OR REPLACE FUNCTION pg_temp.s9()
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  IF to_regclass('public.tasks') IS NULL THEN RETURN jsonb_build_object('tasks_exists', false); END IF;
  SELECT jsonb_build_object(
    'tasks_total', COUNT(*),
    'tasks_with_due_date', COUNT(*) FILTER (WHERE t.due_date IS NOT NULL),
    'tasks_with_resp', COUNT(*) FILTER (WHERE NULLIF(btrim(t.resp), '') IS NOT NULL),
    'resp_exact_unique_teacher_match', COUNT(*) FILTER (WHERE (
        SELECT COUNT(*) FROM public.profiles p WHERE p.role='teacher' AND btrim(p.name) = btrim(t.resp)) = 1),
    'resp_ambiguous_teacher_match', COUNT(*) FILTER (WHERE (
        SELECT COUNT(*) FROM public.profiles p WHERE p.role='teacher' AND btrim(p.name) = btrim(t.resp)) > 1),
    'resp_no_teacher_match', COUNT(*) FILTER (WHERE NULLIF(btrim(t.resp), '') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.profiles p WHERE p.role='teacher' AND btrim(p.name) = btrim(t.resp)))
  ) INTO r FROM public.tasks t;
  RETURN r || jsonb_build_object(
    'teacher_profiles', (SELECT COUNT(*) FROM public.profiles WHERE role='teacher'),
    'teacher_duplicate_names', (SELECT COUNT(*) FROM (SELECT btrim(name) FROM public.profiles
        WHERE role='teacher' GROUP BY 1 HAVING COUNT(*) > 1) d),
    'new_columns_already_present', (SELECT COALESCE(jsonb_agg(column_name ORDER BY column_name), '[]')
        FROM information_schema.columns WHERE table_schema='public' AND table_name='tasks'
        AND column_name IN ('start_at','end_at','assignee_id','evidence_drive_url','evidence_title','evidence_approved')),
    'tasks_policies', (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', policyname, 'cmd', cmd, 'roles', roles) ORDER BY policyname), '[]')
        FROM pg_policies WHERE schemaname='public' AND tablename='tasks'),
    'tasks_triggers', (SELECT COALESCE(jsonb_agg(tgname ORDER BY tgname), '[]')
        FROM pg_trigger WHERE tgrelid = 'public.tasks'::regclass AND NOT tgisinternal),
    'private_login_attempts_exists', to_regclass('private.login_attempts') IS NOT NULL
  );
END $$;

WITH
req_fns AS (
  SELECT f AS fn, to_regprocedure(f) IS NOT NULL AS ok
  FROM unnest(ARRAY[
    'public.current_app_role()', 'public.is_admin()', 'public.is_staff()',
    'public.school_year_allows_write(uuid)', 'public.school_year_is_active(uuid)',
    'public.school_year_allows_read(uuid)'
  ]) f
),
req_tbls AS (
  SELECT t AS tbl, to_regclass(t) IS NOT NULL AS ok
  FROM unnest(ARRAY['public.profiles','public.school_years','public.tasks','public.evidences','storage.objects']) t
),
stop AS (
  SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) AS items FROM (
    SELECT 'missing function ' || fn AS x FROM req_fns WHERE NOT ok
    UNION ALL SELECT 'missing table ' || tbl FROM req_tbls WHERE NOT ok
    UNION ALL SELECT 'no active school year'
      WHERE to_regclass('public.school_years') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.school_years WHERE is_active)
    UNION ALL SELECT 'more than one active school year'
      WHERE (SELECT COUNT(*) FROM public.school_years WHERE is_active) > 1
    UNION ALL SELECT 'bucket evidences is public'
      WHERE EXISTS (SELECT 1 FROM storage.buckets WHERE id='evidences' AND public)
  ) s
)
SELECT jsonb_pretty(jsonb_build_object(
  'generated_at', now(),
  'server_version', current_setting('server_version'),
  'stop', (SELECT items FROM stop),

  'S0_required_objects', jsonb_build_object(
    'functions', (SELECT jsonb_object_agg(fn, ok) FROM req_fns),
    'tables', (SELECT jsonb_object_agg(tbl, ok) FROM req_tbls)),

  'S1_reports', jsonb_build_object(
    'activity', pg_temp.reports_activity(),
    'columns', (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', column_name, 'type', data_type,
                 'nullable', is_nullable, 'default', column_default) ORDER BY ordinal_position), '[]')
               FROM information_schema.columns WHERE table_schema='public' AND table_name='reports'),
    'rls_enabled', (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.reports')),
    'rls_forced', (SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.reports')),
    'owner', (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = to_regclass('public.reports')),
    'policies', (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', policyname, 'cmd', cmd, 'roles', roles,
                  'permissive', permissive, 'using', qual, 'with_check', with_check) ORDER BY policyname), '[]')
                FROM pg_policies WHERE schemaname='public' AND tablename='reports'),
    'grants', (SELECT COALESCE(jsonb_object_agg(grantee, privs), '{}') FROM (
                SELECT grantee, jsonb_agg(privilege_type ORDER BY privilege_type) AS privs
                FROM information_schema.role_table_grants
                WHERE table_schema='public' AND table_name='reports' GROUP BY grantee) g),
    'stats_since_reset', (SELECT jsonb_build_object('n_live_tup', n_live_tup, 'n_tup_ins', n_tup_ins,
                  'n_tup_upd', n_tup_upd, 'n_tup_del', n_tup_del, 'last_analyze', GREATEST(last_analyze, last_autoanalyze))
                FROM pg_stat_user_tables WHERE relid = to_regclass('public.reports')),
    'stats_reset_at', (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()),
    'triggers', (SELECT COALESCE(jsonb_agg(tgname ORDER BY tgname), '[]') FROM pg_trigger
                 WHERE tgrelid = to_regclass('public.reports') AND NOT tgisinternal),
    'functions_referencing', (SELECT COALESCE(jsonb_agg(n.nspname || '.' || p.proname ORDER BY n.nspname, p.proname), '[]')
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
                  AND n.nspname NOT LIKE 'pg_temp%' AND p.prosrc ~* '\mreports\M'),
    'views_referencing', (SELECT COALESCE(jsonb_agg(schemaname || '.' || viewname ORDER BY schemaname, viewname), '[]')
                FROM pg_views WHERE schemaname NOT IN ('pg_catalog','information_schema')
                  AND definition ~* '\mreports\M'),
    'foreign_keys', (SELECT COALESCE(jsonb_agg(conname || ' ' || pg_get_constraintdef(oid) ORDER BY conname), '[]')
                FROM pg_constraint WHERE contype='f'
                  AND (conrelid = to_regclass('public.reports') OR confrelid = to_regclass('public.reports'))),
    'in_realtime_publication', EXISTS (SELECT 1 FROM pg_publication_tables
                WHERE schemaname='public' AND tablename='reports')),

  'S2_public_tables_without_rls', (SELECT COALESCE(jsonb_agg(c.relname ORDER BY c.relname), '[]')
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity),

  'S3_open_or_anon_policies', (SELECT COALESCE(jsonb_agg(jsonb_build_object('schema', schemaname, 'table', tablename,
        'name', policyname, 'cmd', cmd, 'roles', roles, 'using', qual, 'with_check', with_check)
        ORDER BY schemaname, tablename, policyname), '[]')
      FROM pg_policies
      WHERE schemaname IN ('public','storage')
        AND (btrim(COALESCE(qual,'')) IN ('true','(true)') OR btrim(COALESCE(with_check,'')) IN ('true','(true)')
             OR roles && ARRAY['anon','public']::name[])),

  'S4_anon_public_table_grants', (SELECT COALESCE(jsonb_object_agg(k, privs), '{}') FROM (
      SELECT grantee || ':' || table_name AS k, jsonb_agg(privilege_type ORDER BY privilege_type) AS privs
      FROM information_schema.role_table_grants
      WHERE table_schema='public' AND grantee IN ('anon','PUBLIC') GROUP BY grantee, table_name) g),

  'S5_public_functions_executable_by_anon', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'fn', p.oid::regprocedure::text, 'security_definer', p.prosecdef) ORDER BY p.oid::regprocedure::text), '[]')
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.prokind='f'
        AND has_function_privilege('anon', p.oid, 'EXECUTE')),

  'S6_storage', jsonb_build_object(
    'buckets', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'public', public,
                 'file_size_limit', file_size_limit, 'allowed_mime_types', allowed_mime_types) ORDER BY id), '[]')
               FROM storage.buckets),
    'object_policies', (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', policyname, 'cmd', cmd, 'roles', roles,
                 'using', qual, 'with_check', with_check) ORDER BY policyname), '[]')
               FROM pg_policies WHERE schemaname='storage' AND tablename='objects')),

  'S7_storage_teacher_read_impact', pg_temp.s7(),

  'S8_profiles', jsonb_build_object(
    'authenticated_table_privs', (SELECT COALESCE(jsonb_agg(privilege_type ORDER BY privilege_type), '[]')
        FROM information_schema.role_table_grants
        WHERE table_schema='public' AND table_name='profiles' AND grantee='authenticated'),
    'authenticated_column_update', (SELECT COALESCE(jsonb_agg(column_name ORDER BY column_name), '[]')
        FROM information_schema.column_privileges
        WHERE table_schema='public' AND table_name='profiles' AND grantee='authenticated' AND privilege_type='UPDATE'),
    'policies', (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', policyname, 'cmd', cmd, 'roles', roles,
                  'using', qual, 'with_check', with_check) ORDER BY policyname), '[]')
                FROM pg_policies WHERE schemaname='public' AND tablename='profiles')),

  'S9_tasks_readiness', pg_temp.s9()
)) AS report;
