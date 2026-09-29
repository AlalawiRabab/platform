-- ============================================================
-- phase_reports_lockdown_review.sql   (مسودة — معلّق على قرار بعد مراجعة S1)
-- ⚠️ ليس ضمن ترتيب التطبيق. لا تنفّذه قبل مراجعة المفاتيح S1_* في
--    precheck_readonly_report.sql وتحديد من يكتب في public.reports.
-- ============================================================
-- الحقائق المعروفة:
--   * public.reports موجود حيًا ولا يُعرَّف في المستودع.
--   * anon: permission denied (42501) — ثابت بالفحص الحي.
--   * الواجهة (script.js) و admin-users و username-login لا تقرأ ولا تكتب reports
--     (قسم «التقارير» في الواجهة يُبنى من جدول evidences).
-- المجهول (يكشفه S1): حالة RLS، السياسات، منح authenticated، ودوال/مشغّلات/عروض
--   تشير إليه، وإحصاءات الكتابة (n_tup_ins/upd/del) منذ آخر تصفير للإحصاءات.
--
-- الخيارات بعد S1:
--   (أ) لا كتابة ولا مستخدم خارجي → نفّذ هذا الملف كما هو (قراءة للقائدة فقط).
--   (ب) يكتب فيه نظام آخر بـ service_role → هذا الملف لا يؤثر عليه (service_role يتجاوز RLS).
--   (ج) يكتب فيه مستخدمون مسجلون من تطبيق آخر → لا تنفّذه؛ نصمم سياسة كتابة مطابقة أولًا.
-- ============================================================

BEGIN;

DO $$
DECLARE pol record;
BEGIN
  IF to_regclass('public.reports') IS NULL THEN
    RAISE NOTICE 'public.reports غير موجود — تخطٍّ';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY';

  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'reports'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.reports', pol.policyname);
  END LOOP;

  EXECUTE 'REVOKE ALL ON TABLE public.reports FROM anon';
  EXECUTE 'REVOKE ALL ON TABLE public.reports FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON TABLE public.reports FROM authenticated';
  EXECUTE 'GRANT SELECT ON TABLE public.reports TO authenticated';

  EXECUTE $p$
    CREATE POLICY reports_admin_select ON public.reports
      FOR SELECT TO authenticated
      USING (public.is_admin())
  $p$;
END $$;

COMMIT;

-- ROLLBACK: أعد إنشاء السياسات والمنح الأصلية حرفيًا من لقطة التقرير
--   (S1_reports.policies و S1_reports.grants) المحفوظة في الـ PR قبل التطبيق.
