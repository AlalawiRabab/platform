-- ============================================================
-- phase_security_hardening_review.sql   (الخطوة 1 — مستقل عن الواجهة)
-- anon بلا وصول مباشر + دوال SECURITY DEFINER + profiles للقراءة فقط
-- مراجعة / تطبيق يدوي بعد نسخة احتياطية — لا يُنفَّذ تلقائياً
-- ============================================================
-- ما ثبت بالفحص الحي (2026-09-29) عبر REST العام بمفتاح anon (HEAD/limit=0 — بلا قراءة بيانات):
--   * public.evidence_requirements: anon يملك SELECT (HTTP 200، 0 صفوف ظاهرة بسبب RLS فقط) ❌
--   * بقية الجداول التشغيلية + profiles + users + kpis + reports: anon مرفوض (401) ✅
-- ما ثبت من تعريفات المستودع المطبّقة سابقًا:
--   * profiles_update_self + GRANT UPDATE(name, username) → أي مستخدم (ومنه المعلمة)
--     يغيّر اسمه/اسم دخوله مباشرة عبر REST، والواجهة لا تحتاج ذلك.
--
-- خارج هذا الملف (قرارات/خطوات منفصلة):
--   * reports → phase_reports_lockdown_review.sql (لا يُطبَّق قبل مراجعة S1)
--   * قراءة المعلمة لملفات Storage → phase_storage_teacher_read_review.sql
--
-- ضوابط: بلا DROP TABLE / TRUNCATE / DELETE؛ لا يمس سياسات الجداول التشغيلية.
-- PRECHECK: sql/precheck_readonly_report.sql (المفاتيح S0 و S4 و S5 و S8).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- A) anon بلا أي وصول مباشر لـ schema public
--    الواجهة لا تقرأ أي جدول/RPC قبل تسجيل الدخول؛ username-login يعمل بـ service_role.
-- ------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;

-- anon يرث EXECUTE عبر PUBLIC؛ دوال SECURITY DEFINER تُغلق عن PUBLIC أيضًا.
-- authenticated يحتفظ بالتنفيذ فقط حيث كان يملكه قبل هذا التغيير (لا يُعاد فتح دوال مغلقة عمدًا).
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_had,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_had
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef AND p.prokind = 'f'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f.sig);
    IF f.auth_had THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig);
    END IF;
    IF f.service_had THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
    END IF;
  END LOOP;
END $$;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;

-- ------------------------------------------------------------
-- C) profiles: لا تعديل مباشر من العملاء
--    الإنشاء/التعديل/تغيير الدور عبر admin-users (service_role) فقط — غير متأثر.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.profiles FROM authenticated;
REVOKE UPDATE (name, username) ON TABLE public.profiles FROM authenticated;
GRANT SELECT ON TABLE public.profiles TO authenticated;

-- ------------------------------------------------------------
-- E) تحقق داخل المعاملة
-- ------------------------------------------------------------
SELECT 1 / CASE WHEN EXISTS (
  SELECT 1 FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND grantee = 'anon'
) THEN 0 ELSE 1 END AS tx_check_no_anon_table_grants;

SELECT 1 / CASE WHEN NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege('anon', p.oid, 'EXECUTE')
) THEN 1 ELSE 0 END AS tx_check_no_anon_security_definer;

SELECT 1 / CASE WHEN NOT EXISTS (
  SELECT 1 FROM information_schema.column_privileges
  WHERE table_schema = 'public' AND table_name = 'profiles'
    AND grantee = 'authenticated' AND privilege_type IN ('UPDATE', 'INSERT', 'DELETE')
) THEN 1 ELSE 0 END AS tx_check_profiles_readonly;

COMMIT;


-- ############################################################################
-- POSTCHECK
-- 1) أعد تشغيل precheck_readonly_report.sql → S4 و S5 بلا صفوف لـ anon
-- 2) بلا تسجيل دخول: GET /rest/v1/evidence_requirements?select=id → 401
-- 3) كمعلمة: PATCH /rest/v1/profiles?id=eq.<uid> {"name":"x"} → 401/403
-- ############################################################################


-- ############################################################################
-- ROLLBACK (يدوي — معلّق). يعيد القسم C فقط.
-- لا تُرجع منح anon (القسم A) — لا حاجة تشغيلية لها. إن احتجت دالة بعينها لـ anon امنحها صراحة.
-- ############################################################################
/*
BEGIN;
GRANT UPDATE (name, username) ON TABLE public.profiles TO authenticated;
CREATE POLICY profiles_update_self ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.is_admin())
  WITH CHECK (id = auth.uid() OR public.is_admin());
COMMIT;
*/
