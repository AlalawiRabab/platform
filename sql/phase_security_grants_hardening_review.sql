-- ============================================================
-- REVIEW ONLY — DO NOT RUN AUTOMATICALLY. Manual apply in the SQL Editor after separate approval.
-- ============================================================
-- phase_security_grants_hardening_review.sql
-- تشديد الصلاحيات المباشرة (GRANT) بعد فحص الإنتاج وSecurity Advisors في 2026-10-22
-- مراجعة / تطبيق يدوي في محرر SQL — لا يُنفَّذ تلقائياً ولا من المستودع
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
--   * يسحب كل صلاحيات anon من evidence_requirements.
--   * يسحب TRUNCATE وREFERENCES وTRIGGER وMAINTAIN من PUBLIC/anon/authenticated على جداول public المستخدمة.
--   * يسحب EXECUTE من PUBLIC/anon/authenticated على دوال الـ Trigger فقط
--     (الـ Trigger يعمل بدون صلاحية EXECUTE للمستخدم؛ مثال قائم: tasks_enforce_schedule_and_evidence).
--   * يسحب EXECUTE من PUBLIC/anon على دوال الأدوار/السنة، ويُبقيها لـ authenticated (تحتاجها سياسات RLS).
--   * يثبّت search_path لـ evidence_attachment_present.
--
-- لا يمس: SELECT/INSERT/UPDATE/DELETE لـ authenticated، سياسات RLS، المشغّلات، البيانات، Storage،
--   service_role، مالك الجداول، دوال السنة الإدارية (create/activate/freeze/archive/update)،
--   ولا الصلاحيات الافتراضية للمخطط (راجع التوصية في التقرير).
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

-- لقطة الصلاحيات التي يجب ألا تتغيّر (SELECT/INSERT/UPDATE/DELETE لكل دور على كل جدول)
CREATE TEMP TABLE _grants_keep ON COMMIT DROP AS
SELECT r.rolname, c.relname, p.priv,
       has_table_privilege(r.rolname, c.oid, p.priv) AS has_it
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
CROSS JOIN (VALUES ('authenticated'), ('service_role'), ('postgres')) AS r(rolname)
CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv)
WHERE c.relkind = 'r';

CREATE TEMP TABLE _grants_counts ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM public.evidences) AS evidences_cnt,
  (SELECT count(*) FROM public.evidence_requirements) AS requirements_cnt,
  (SELECT count(*) FROM public.programs) AS programs_cnt,
  (SELECT count(*) FROM public.program_indicators) AS indicators_cnt;

-- ------------------------------------------------------------
-- 1) anon على evidence_requirements
-- ------------------------------------------------------------
REVOKE ALL ON TABLE public.evidence_requirements FROM anon;

-- ------------------------------------------------------------
-- 2) TRUNCATE / REFERENCES / TRIGGER / MAINTAIN من أدوار المستخدمين
-- ------------------------------------------------------------
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE
  public.evidences, public.evidence_requirements, public.programs, public.program_indicators,
  public.initiatives, public.school_years, public.settings, public.teacher_followups, public.tasks,
  public.kpis, public.profiles, public.reports, public.users, public.platform_migration_history
FROM PUBLIC, anon, authenticated;

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
-- 5) سجل التنفيذ + Postchecks
-- ------------------------------------------------------------
INSERT INTO public.platform_migration_history (migration_key)
VALUES ('phase_security_grants_hardening_v1')
ON CONFLICT (migration_key) DO NOTHING;

DO $post$
DECLARE
  t text;
  f text;
  b record;
BEGIN
  FOREACH t IN ARRAY ARRAY['evidences', 'evidence_requirements', 'programs', 'program_indicators',
                           'initiatives', 'school_years', 'settings', 'teacher_followups', 'tasks',
                           'kpis', 'profiles', 'reports', 'users', 'platform_migration_history'] LOOP
    IF has_table_privilege('authenticated', 'public.' || t, 'TRUNCATE')
       OR has_table_privilege('anon', 'public.' || t, 'TRUNCATE')
       OR has_table_privilege('authenticated', 'public.' || t, 'TRIGGER')
       OR has_table_privilege('authenticated', 'public.' || t, 'REFERENCES')
       OR has_table_privilege('authenticated', 'public.' || t, 'MAINTAIN')
       OR has_table_privilege('anon', 'public.' || t, 'MAINTAIN') THEN
      RAISE EXCEPTION 'STOP: صلاحية خطرة ما زالت متاحة على public.%', t;
    END IF;
  END LOOP;

  IF has_table_privilege('anon', 'public.evidence_requirements', 'SELECT')
     OR has_table_privilege('anon', 'public.evidence_requirements', 'INSERT')
     OR has_table_privilege('anon', 'public.evidence_requirements', 'UPDATE')
     OR has_table_privilege('anon', 'public.evidence_requirements', 'DELETE') THEN
    RAISE EXCEPTION 'STOP: anon ما زال يصل إلى evidence_requirements';
  END IF;

  IF EXISTS (SELECT 1 FROM _grants_keep k
             WHERE k.has_it IS DISTINCT FROM has_table_privilege(k.rolname, ('public.' || k.relname)::regclass, k.priv)) THEN
    RAISE EXCEPTION 'STOP: تغيّرت صلاحيات SELECT/INSERT/UPDATE/DELETE — تم التراجع';
  END IF;

  FOREACH f IN ARRAY ARRAY['public.is_admin()', 'public.is_staff()', 'public.current_app_role()',
                           'public.get_active_school_year()', 'public.list_school_years(boolean)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'STOP: anon ما زال ينفّذ %', f;
    END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'STOP: authenticated فقد تنفيذ % (تحتاجها سياسات RLS)', f;
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.school_year_allows_read(uuid)', 'public.school_year_allows_write(uuid)',
                           'public.school_year_is_active(uuid)'] LOOP
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'STOP: authenticated فقد تنفيذ %', f;
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.protect_approved_evidence_attachment()', 'public.set_evidence_created_by()',
                           'public.enforce_evidence_requirement_approval()', 'public.rls_auto_enable()'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'STOP: دالة Trigger ما زالت قابلة للاستدعاء: %', f;
    END IF;
  END LOOP;

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
