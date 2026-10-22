-- ============================================================
-- REVIEW ONLY — DO NOT RUN AUTOMATICALLY. Manual apply in the SQL Editor after separate approval.
-- ============================================================
-- phase_security_grants_hardening_review.sql
-- تشديد الصلاحيات المباشرة (GRANT) بعد فحص الإنتاج وSecurity Advisors في 2026-10-22
-- مراجعة / تطبيق يدوي في محرر SQL — لا يُنفَّذ تلقائياً ولا من المستودع
-- Rollback مستقل (طوارئ فقط): sql/phase_security_grants_hardening_rollback_review.sql
-- ============================================================
-- ما وُجد على الإنتاج (relacl / proacl):
--   * anon يملك arwdDxtm (كل الصلاحيات بما فيها DELETE وTRUNCATE) على evidence_requirements.
--     RLS يمنع الصفوف لأن لا سياسة لـ anon، لكن TRUNCATE يتجاوز RLS والـ Triggers.
--   * authenticated يملك TRUNCATE/REFERENCES/TRIGGER/MAINTAIN على evidences وevidence_requirements وprograms
--     وinitiatives وschool_years وsettings وteacher_followups، وREFERENCES/TRIGGER/MAINTAIN على program_indicators وtasks.
--     (PostgreSQL 17: الحرف m في arwdDxtm = MAINTAIN، ويشمل LOCK TABLE وVACUUM وREINDEX.)
--   * دوال Trigger بصلاحية SECURITY DEFINER قابلة للتنفيذ من anon/authenticated عبر /rest/v1/rpc.
--   * دوال الأدوار والسنة (is_admin/is_staff/current_app_role/get_active_school_year/list_school_years)
--     قابلة للتنفيذ من anon؛ الواجهة تستدعيها بعد تسجيل الدخول فقط.
--   * evidence_attachment_present بلا search_path ثابت.
--
-- ماذا يفعل:
--   * يسحب كل صلاحيات PUBLIC وanon من جداول public الأربعة عشر (فعلياً: anon على evidence_requirements فقط).
--   * يسحب TRUNCATE وREFERENCES وTRIGGER وMAINTAIN من authenticated على الجداول نفسها.
--   * يسحب EXECUTE من PUBLIC/anon/authenticated على دوال الـ Trigger ودالة evidence_attachment_present
--     (الـ Trigger يعمل بدون صلاحية EXECUTE للمستخدم؛ مثال قائم: tasks_enforce_schedule_and_evidence).
--   * يسحب EXECUTE من PUBLIC/anon على دوال الأدوار/السنة، ويُبقيها لـ authenticated (تحتاجها سياسات RLS والواجهة).
--   * يثبّت search_path فارغاً لـ evidence_attachment_present (لا تستخدم إلا دوال pg_catalog).
--
-- لا يمس: SELECT/INSERT/UPDATE/DELETE لـ authenticated، سياسات RLS، المشغّلات، البيانات، Storage،
--   service_role، مالك الجداول والدوال (postgres)، دوال السنة الإدارية (create/activate/freeze/archive/update)،
--   ولا الصلاحيات الافتراضية للمخطط. لا يستخدم GRANT ALL.
-- ============================================================

BEGIN;

DO $pre$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['evidences', 'evidence_requirements', 'programs', 'program_indicators',
                           'initiatives', 'school_years', 'settings', 'teacher_followups', 'tasks',
                           'kpis', 'profiles', 'reports', 'users', 'platform_migration_history'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'STOP: الجدول public.% غير موجود', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'STOP: RLS غير مفعّل على public.%', t;
    END IF;
  END LOOP;
  IF to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.current_app_role()') IS NULL
     OR to_regprocedure('public.school_year_allows_write(uuid)') IS NULL THEN
    RAISE EXCEPTION 'STOP: دوال الصلاحيات المطلوبة غير موجودة';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname IN ('public', 'storage')
               AND ('anon' = ANY (roles) OR 'public' = ANY (roles))
               AND NOT (coalesce(qual, 'false') = 'false' AND coalesce(with_check, 'false') = 'false')) THEN
    RAISE EXCEPTION 'STOP: توجد سياسة RLS فعّالة لـ anon — راجعها قبل سحب تنفيذ الدوال من anon';
  END IF;
END
$pre$;

-- الجداول الأربعة عشر والصلاحيات التطبيقية المقصودة لـ authenticated بعد التطبيق (كما في الإنتاج دون D/x/t/m)
CREATE TEMP TABLE _grants_tables ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('evidences', 'SELECT,INSERT,UPDATE,DELETE'),
  ('evidence_requirements', 'SELECT,INSERT,UPDATE,DELETE'),
  ('programs', 'SELECT,INSERT,UPDATE,DELETE'),
  ('program_indicators', 'SELECT,INSERT,UPDATE,DELETE'),
  ('initiatives', 'SELECT,INSERT,UPDATE,DELETE'),
  ('school_years', 'SELECT,INSERT,UPDATE,DELETE'),
  ('settings', 'SELECT,INSERT,UPDATE,DELETE'),
  ('teacher_followups', 'SELECT,INSERT,UPDATE,DELETE'),
  ('tasks', 'SELECT,INSERT,UPDATE,DELETE'),
  ('kpis', 'SELECT,INSERT,UPDATE,DELETE'),
  ('profiles', 'SELECT'),
  ('reports', ''),
  ('users', ''),
  ('platform_migration_history', '')
) AS v(relname, authenticated_privs);

CREATE TEMP TABLE _grants_privs ON COMMIT DROP AS
SELECT * FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                      ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) AS v(priv);

-- دوال الـ Trigger + الدالة المساعدة: لا تنفيذ لأي دور مستخدم بعد التطبيق
CREATE TEMP TABLE _grants_trigger_fns ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('public.enforce_evidence_requirement_approval()'),
  ('public.enforce_evidence_requirement_indicator_match()'),
  ('public.prevent_delete_requirement_with_approved_attachment()'),
  ('public.protect_approved_evidence_attachment()'),
  ('public.set_evidence_created_by()'),
  ('public.set_evidence_requirement_created_by()'),
  ('public.set_evidence_requirements_updated_at()'),
  ('public.set_profiles_updated_at()'),
  ('public.rls_auto_enable()'),
  ('public.evidence_attachment_present(jsonb)')
) AS v(fn);

-- دوال يحتاجها authenticated (سياسات RLS + الواجهة)
CREATE TEMP TABLE _grants_rls_fns ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('public.is_admin()'), ('public.is_staff()'), ('public.current_app_role()'),
  ('public.get_active_school_year()'), ('public.list_school_years(boolean)'),
  ('public.school_year_allows_read(uuid)'), ('public.school_year_allows_write(uuid)'),
  ('public.school_year_is_active(uuid)')
) AS v(fn);

-- لقطة service_role وpostgres (جداول + دوال) وSELECT/INSERT/UPDATE/DELETE لـ authenticated: يجب ألا تتغيّر
CREATE TEMP TABLE _grants_keep ON COMMIT DROP AS
SELECT r.rolname, t.relname AS obj, p.priv, has_table_privilege(r.rolname, ('public.' || t.relname)::regclass, p.priv) AS has_it
FROM _grants_tables t
CROSS JOIN (VALUES ('service_role'), ('postgres')) AS r(rolname)
CROSS JOIN _grants_privs p
UNION ALL
SELECT 'authenticated', t.relname, p.priv, has_table_privilege('authenticated', ('public.' || t.relname)::regclass, p.priv)
FROM _grants_tables t
CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv)
UNION ALL
SELECT r.rolname, f.fn, 'EXECUTE', has_function_privilege(r.rolname, f.fn::regprocedure, 'EXECUTE')
FROM (SELECT fn FROM _grants_trigger_fns UNION ALL SELECT fn FROM _grants_rls_fns) f
CROSS JOIN (VALUES ('service_role'), ('postgres')) AS r(rolname);

CREATE TEMP TABLE _grants_counts ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM public.evidences) AS evidences_cnt,
  (SELECT count(*) FROM public.evidence_requirements) AS requirements_cnt,
  (SELECT count(*) FROM public.programs) AS programs_cnt,
  (SELECT count(*) FROM public.program_indicators) AS indicators_cnt;

-- ------------------------------------------------------------
-- 1) PUBLIC وanon: لا صلاحيات مباشرة على جداول التطبيق
-- ------------------------------------------------------------
REVOKE ALL ON TABLE
  public.evidences, public.evidence_requirements, public.programs, public.program_indicators,
  public.initiatives, public.school_years, public.settings, public.teacher_followups, public.tasks,
  public.kpis, public.profiles, public.reports, public.users, public.platform_migration_history
FROM PUBLIC, anon;

-- ------------------------------------------------------------
-- 2) authenticated: سحب TRUNCATE / REFERENCES / TRIGGER / MAINTAIN فقط
-- ------------------------------------------------------------
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE
  public.evidences, public.evidence_requirements, public.programs, public.program_indicators,
  public.initiatives, public.school_years, public.settings, public.teacher_followups, public.tasks,
  public.kpis, public.profiles, public.reports, public.users, public.platform_migration_history
FROM authenticated;

-- ------------------------------------------------------------
-- 3) دوال الـ Trigger: لا تُستدعى مباشرة عبر RPC
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  public.enforce_evidence_requirement_approval(),
  public.enforce_evidence_requirement_indicator_match(),
  public.prevent_delete_requirement_with_approved_attachment(),
  public.protect_approved_evidence_attachment(),
  public.set_evidence_created_by(),
  public.set_evidence_requirement_created_by(),
  public.set_evidence_requirements_updated_at(),
  public.set_profiles_updated_at(),
  public.rls_auto_enable()
FROM PUBLIC, anon, authenticated;

-- دالة مساعدة تستدعيها protect_approved_evidence_attachment (SECURITY DEFINER) فقط
REVOKE EXECUTE ON FUNCTION public.evidence_attachment_present(jsonb) FROM PUBLIC, anon, authenticated;
ALTER FUNCTION public.evidence_attachment_present(jsonb) SET search_path = '';

-- ------------------------------------------------------------
-- 4) دوال الأدوار والسنة: للمستخدم المسجّل فقط
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  public.is_admin(),
  public.is_staff(),
  public.current_app_role(),
  public.get_active_school_year(),
  public.list_school_years(boolean)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.is_admin(),
  public.is_staff(),
  public.current_app_role(),
  public.get_active_school_year(),
  public.list_school_years(boolean)
TO authenticated;

-- ------------------------------------------------------------
-- 5) سجل التنفيذ: 1 في التشغيل الأول، 0 عند إعادة التشغيل، وأي قيمة أخرى توقف
-- ------------------------------------------------------------
DO $hist$
DECLARE
  n integer;
BEGIN
  INSERT INTO public.platform_migration_history (migration_key)
  VALUES ('phase_security_grants_hardening_v1')
  ON CONFLICT (migration_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n NOT IN (0, 1) THEN
    RAISE EXCEPTION 'STOP: سجل التنفيذ أدخل % صفوف (المسموح 0 أو 1)', n;
  END IF;
  IF (SELECT count(*) FROM public.platform_migration_history
      WHERE migration_key = 'phase_security_grants_hardening_v1') <> 1 THEN
    RAISE EXCEPTION 'STOP: migration_key غير موجود مرة واحدة بالضبط';
  END IF;
END
$hist$;

-- ------------------------------------------------------------
-- 6) Postchecks
-- ------------------------------------------------------------
DO $post$
DECLARE
  r record;
  b record;
BEGIN
  -- PUBLIC وanon: لا أي صلاحية من الثماني على أي من الجداول الأربعة عشر
  FOR r IN
    SELECT t.relname, p.priv, g.grantee
    FROM _grants_tables t CROSS JOIN _grants_privs p CROSS JOIN (VALUES ('public'), ('anon')) AS g(grantee)
    WHERE has_table_privilege(g.grantee, ('public.' || t.relname)::regclass, p.priv)
  LOOP
    RAISE EXCEPTION 'STOP: % ما زال يملك % على public.%', r.grantee, r.priv, r.relname;
  END LOOP;

  -- authenticated: الصلاحيات الفعلية تساوي المقصودة بالضبط (ولا D/x/t/m)
  FOR r IN
    SELECT t.relname, p.priv,
           has_table_privilege('authenticated', ('public.' || t.relname)::regclass, p.priv) AS has_it,
           coalesce(p.priv = ANY (string_to_array(nullif(t.authenticated_privs, ''), ',')), false) AS wanted
    FROM _grants_tables t CROSS JOIN _grants_privs p
  LOOP
    IF r.has_it IS DISTINCT FROM r.wanted THEN
      RAISE EXCEPTION 'STOP: authenticated % على public.%: الفعلي=% المقصود=%', r.priv, r.relname, r.has_it, r.wanted;
    END IF;
  END LOOP;

  -- لا تغيير على service_role وpostgres، ولا على SELECT/INSERT/UPDATE/DELETE لـ authenticated
  FOR r IN
    SELECT k.* FROM _grants_keep k
    WHERE k.has_it IS DISTINCT FROM CASE
      WHEN k.priv = 'EXECUTE' THEN has_function_privilege(k.rolname, k.obj::regprocedure, 'EXECUTE')
      ELSE has_table_privilege(k.rolname, ('public.' || k.obj)::regclass, k.priv) END
  LOOP
    RAISE EXCEPTION 'STOP: تغيّرت صلاحية % على % لـ %', r.priv, r.obj, r.rolname;
  END LOOP;

  -- كل دوال الـ Trigger: لا تنفيذ لـ PUBLIC/anon/authenticated، والمالك postgres ما زال ينفّذ
  FOR r IN SELECT fn FROM _grants_trigger_fns LOOP
    IF has_function_privilege('public', r.fn::regprocedure, 'EXECUTE')
       OR has_function_privilege('anon', r.fn::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', r.fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'STOP: % ما زالت قابلة للاستدعاء من دور مستخدم', r.fn;
    END IF;
    IF NOT has_function_privilege('postgres', r.fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'STOP: المالك postgres فقد تنفيذ %', r.fn;
    END IF;
  END LOOP;

  -- دوال RLS والواجهة: authenticated ينفّذها، وanon/PUBLIC لا
  FOR r IN SELECT fn FROM _grants_rls_fns LOOP
    IF NOT has_function_privilege('authenticated', r.fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'STOP: authenticated فقد تنفيذ % (تحتاجها سياسات RLS)', r.fn;
    END IF;
    IF has_function_privilege('anon', r.fn::regprocedure, 'EXECUTE')
       OR has_function_privilege('public', r.fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'STOP: anon/PUBLIC ما زال ينفّذ %', r.fn;
    END IF;
  END LOOP;

  -- evidence_attachment_present تعمل بـ search_path فارغ
  IF (SELECT array_to_string(proconfig, ',') FROM pg_proc
      WHERE oid = 'public.evidence_attachment_present(jsonb)'::regprocedure) IS DISTINCT FROM 'search_path=""' THEN
    RAISE EXCEPTION 'STOP: search_path لـ evidence_attachment_present غير مضبوط';
  END IF;
  IF public.evidence_attachment_present('{"link": "https://drive.google.com/x"}'::jsonb) IS NOT TRUE
     OR public.evidence_attachment_present('{"file_url": "u/a.pdf"}'::jsonb) IS NOT TRUE
     OR public.evidence_attachment_present('{"link": "  "}'::jsonb) IS NOT FALSE THEN
    RAISE EXCEPTION 'STOP: evidence_attachment_present لا تعمل كما يجب بعد ضبط search_path';
  END IF;

  SELECT * INTO b FROM _grants_counts;
  IF b.evidences_cnt IS DISTINCT FROM (SELECT count(*) FROM public.evidences)
     OR b.requirements_cnt IS DISTINCT FROM (SELECT count(*) FROM public.evidence_requirements)
     OR b.programs_cnt IS DISTINCT FROM (SELECT count(*) FROM public.programs)
     OR b.indicators_cnt IS DISTINCT FROM (SELECT count(*) FROM public.program_indicators) THEN
    RAISE EXCEPTION 'STOP: تغيّرت أعداد الصفوف — تم التراجع';
  END IF;
END
$post$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================
-- POSTCHECK (قراءة فقط):
--   SELECT relname, relacl::text FROM pg_class
--     WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1;
--     -- المتوقع: لا anon على أي جدول، وauthenticated بلا D/x/t/m (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN)
--   ثم أعد تشغيل: supabase db advisors --linked --type security
-- ============================================================

-- !!! تحذير: هذا الـ Rollback يعيد صلاحيات anon الخطرة على evidence_requirements (منها DELETE وTRUNCATE)
-- !!! لا يُشغَّل تلقائياً، ولا يُستخدم إلا في طوارئ مؤكدة وبعد موافقة منفصلة.
-- !!! عند تعطّل الواجهة: أصلح الـ GRANT المحدد الناقص أولاً، ولا تشغّل الـ Rollback الكامل.
-- تراجع (يعيد صلاحيات ما قبل هذا الملف حرفياً كما قُرئت من الإنتاج في 2026-10-22):
/*
BEGIN;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.evidence_requirements TO anon;
GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE
  public.evidences, public.evidence_requirements, public.programs, public.initiatives,
  public.school_years, public.settings, public.teacher_followups
TO authenticated;
GRANT REFERENCES, TRIGGER, MAINTAIN ON TABLE public.program_indicators, public.tasks TO authenticated;
GRANT EXECUTE ON FUNCTION
  public.enforce_evidence_requirement_approval(),
  public.enforce_evidence_requirement_indicator_match(),
  public.prevent_delete_requirement_with_approved_attachment(),
  public.protect_approved_evidence_attachment(),
  public.set_evidence_created_by(),
  public.set_evidence_requirement_created_by(),
  public.set_evidence_requirements_updated_at(),
  public.set_profiles_updated_at(),
  public.evidence_attachment_present(jsonb),
  public.is_admin(),
  public.is_staff(),
  public.current_app_role()
TO anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.rls_auto_enable(),
  public.get_active_school_year(),
  public.list_school_years(boolean)
TO PUBLIC, anon, authenticated;
ALTER FUNCTION public.evidence_attachment_present(jsonb) RESET search_path;
DELETE FROM public.platform_migration_history WHERE migration_key = 'phase_security_grants_hardening_v1';
NOTIFY pgrst, 'reload schema';
COMMIT;
*/
