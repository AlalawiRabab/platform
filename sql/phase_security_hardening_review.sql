-- ============================================================
-- phase_security_hardening_review.sql
-- مراجعة الحماية: reports + anon + profiles + Storage (قراءة المعلمة)
-- مراجعة / تطبيق يدوي بعد نسخة احتياطية — لا يُنفَّذ تلقائياً
-- ============================================================
-- ما ثبت بالفحص (2026-09-29) عبر REST العام بمفتاح anon (HEAD/limit=0 — بلا قراءة بيانات):
--   * public.reports موجود حيًا (لا يُعرَّف في المستودع) — anon: permission denied (42501) ✅
--     حالة RLS وصلاحيات authenticated عليه غير معروفة → القسم B يقيّده.
--   * public.evidence_requirements: anon يملك SELECT (HTTP 200، 0 صفوف ظاهرة بسبب RLS فقط) ❌
--     → القسم A يسحب كل منح anon في schema public.
--   * بقية الجداول التشغيلية + profiles + users + kpis: anon مرفوض (401) ✅
--
-- ما ثبت من تعريفات المستودع المطبّقة سابقًا:
--   * profiles_update_self + GRANT UPDATE(name, username) → أي مستخدم (ومنه المعلمة)
--     يغيّر اسمه/اسم دخوله مباشرة عبر REST، والواجهة لا تحتاج ذلك (الإدارة عبر admin-users
--     بـ service_role). → القسم C.
--   * evidences_auth_select على storage.objects يسمح للمعلمة بسرد/توقيع كل ملفات bucket
--     evidences بما فيها ملفات السنوات المؤرشفة/المجمّدة، متجاوزًا عزل القراءة
--     school_year_allows_read المطبّق على جدول evidences. → القسم D.
--
-- ضوابط:
--   * بلا DROP TABLE / TRUNCATE / DELETE / حذف ملفات أو حسابات
--   * لا يمس سياسات الجداول التشغيلية (programs / indicators / evidences / tasks …)
--   * نفّذ PRECHECK أولاً؛ أي صف تحت STOP = توقّف
-- ============================================================


-- ############################################################################
-- PRECHECK (قراءة فقط)
-- ############################################################################

-- S0) STOP: دوال الدور المطلوبة غير موجودة
SELECT missing.fn AS missing_function, 'STOP'::text AS action
FROM (VALUES ('current_app_role'), ('is_admin'), ('is_staff'), ('school_year_allows_read')) AS missing(fn)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = missing.fn
);

-- S1) reports: البنية + RLS + السياسات + المنح + عدد الصفوف
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'reports'
ORDER BY ordinal_position;

SELECT c.relname, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'reports';

SELECT policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'reports';

SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'reports'
ORDER BY grantee, privilege_type;

-- عدد فقط (لا محتوى) — الجدول ثبت وجوده حيًا
SELECT COUNT(*) AS reports_row_count FROM public.reports;

-- S2) جداول public بلا RLS (أي صف = جدول مكشوف لمن يملك GRANT عليه)
SELECT c.relname AS table_without_rls
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
ORDER BY c.relname;

-- S3) سياسات مفتوحة (true) أو موجّهة لـ anon/public في schema public
SELECT tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    qual IN ('true', '(true)')
    OR with_check IN ('true', '(true)')
    OR roles::text ILIKE '%anon%'
    OR roles::text ILIKE '%public%'
  )
  AND policyname <> 'users_deny_all'
ORDER BY tablename, policyname;
-- المتوقع: 0 صفوف. أي صف = راجعه قبل المتابعة (لا يُحذف تلقائياً هنا)

-- S4) منح anon / PUBLIC على كائنات public
SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee IN ('anon', 'PUBLIC')
ORDER BY table_name, grantee, privilege_type;

-- S5) دوال public قابلة للتنفيذ من anon
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
ORDER BY p.proname;

-- S6) Storage: الـ buckets وسياساتها
SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets ORDER BY id;
-- STOP إن كان evidences.public = true
SELECT 'STOP: bucket evidences عام' AS action FROM storage.buckets WHERE id = 'evidences' AND public;

SELECT policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
ORDER BY policyname;

-- S7) أثر القسم D: شواهد السنة النشطة التي لن تطابق كائن Storage بالمسار
--     (المعلمة لن تفتح ملفاتها إلا إن كانت في مجلدها). المتوقع: 0 أو أعداد قليلة قديمة.
SELECT COUNT(*) AS active_year_files_not_matchable
FROM public.evidences e
JOIN public.school_years sy ON sy.id = e.school_year_id AND sy.is_active
WHERE e.file_url IS NOT NULL AND btrim(e.file_url) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'evidences'
      AND (e.file_url = o.name OR right(e.file_url, length(o.name) + 11) = '/evidences/' || o.name)
  );

-- S8) صلاحيات أعمدة profiles لـ authenticated
SELECT column_name, privilege_type
FROM information_schema.column_privileges
WHERE table_schema = 'public' AND table_name = 'profiles' AND grantee = 'authenticated'
ORDER BY column_name, privilege_type;


-- ############################################################################
-- TRANSACTION — نفّذها كاملة فقط بعد مراجعة PRECHECK
-- عند أي خطأ: ROLLBACK; صراحة قبل إعادة المحاولة.
-- ############################################################################

BEGIN;

-- ------------------------------------------------------------
-- A) anon بلا أي وصول مباشر لـ schema public
--    الواجهة لا تقرأ أي جدول/RPC قبل تسجيل الدخول؛ username-login يعمل بـ service_role.
--    يغلق evidence_requirements (المثبت) وأي جدول مستقبلي يُنشأ بالمنح الافتراضية.
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
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_had
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef AND p.prokind = 'f'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f.sig);
    IF f.auth_had THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig);
    END IF;
  END LOOP;
END $$;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;

-- ------------------------------------------------------------
-- B) reports: RLS مفعّل + قراءة للمدير فقط + بلا كتابة من العملاء
--    لا تستخدمه الواجهة الحالية (التقارير تُبنى من evidences). لا يُحذف ولا تُمس بياناته.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- C) profiles: لا تعديل مباشر من العملاء
--    الإنشاء/التعديل/تغيير الدور عبر admin-users (service_role) فقط — غير متأثر.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.profiles FROM authenticated;
REVOKE UPDATE (name, username) ON TABLE public.profiles FROM authenticated;
GRANT SELECT ON TABLE public.profiles TO authenticated;

-- ------------------------------------------------------------
-- D) Storage: قراءة ملفات evidences
--    admin/vice: كل الملفات (كما هو)
--    teacher: ملفات مجلدها {auth.uid()}/ + الملفات المرتبطة بشاهد تستطيع قراءته
--             (evidences_select يطبّق school_year_allows_read → السنة النشطة فقط)
--    الرفع/التعديل/الحذف: بلا تغيير.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS evidences_file_url_idx ON public.evidences (file_url);

DROP POLICY IF EXISTS evidences_auth_select ON storage.objects;
CREATE POLICY evidences_auth_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'evidences'
    AND (
      public.is_staff()
      OR (
        public.current_app_role() = 'teacher'
        AND (
          (storage.foldername(objects.name))[1] = auth.uid()::text
          OR EXISTS (
            SELECT 1 FROM public.evidences AS e
            WHERE e.file_url = objects.name
               OR right(e.file_url, length(objects.name) + 11) = '/evidences/' || objects.name
          )
        )
      )
    )
  );

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

SELECT 1 / CASE WHEN to_regclass('public.reports') IS NULL OR (
  EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.reports'::regclass AND relrowsecurity)
  AND (SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'reports') = 1
) THEN 1 ELSE 0 END AS tx_check_reports_locked;

SELECT 1 / CASE WHEN NOT EXISTS (
  SELECT 1 FROM information_schema.column_privileges
  WHERE table_schema = 'public' AND table_name = 'profiles'
    AND grantee = 'authenticated' AND privilege_type IN ('UPDATE', 'INSERT', 'DELETE')
) THEN 1 ELSE 0 END AS tx_check_profiles_readonly;

COMMIT;


-- ############################################################################
-- POSTCHECK (قراءة فقط)
-- ############################################################################
-- 1) أعد S3 و S4 و S5 → المتوقع: لا صفوف لـ anon
-- 2) من المتصفح بلا تسجيل دخول (anon):
--      GET /rest/v1/evidence_requirements?select=id → 401
--      GET /rest/v1/reports?select=id            → 401
-- 3) كمعلمة: PATCH /rest/v1/profiles?id=eq.<uid> {"name":"x"} → 401/403
-- 4) كمعلمة: فتح شاهد ملف من السنة النشطة → يعمل
--    كمعلمة: createSignedUrl لمسار ملف من سنة مؤرشفة (ليس في مجلدها) → Object not found
-- 5) كوكيلة/مديرة: فتح أي ملف شاهد → يعمل


-- ############################################################################
-- ROLLBACK (يدوي — معلّق). يعيد الوضع السابق للأقسام C و D فقط.
-- لا تُرجع منح anon (القسم A) — لا حاجة تشغيلية لها.
-- ############################################################################
/*
BEGIN;
-- C
GRANT UPDATE (name, username) ON TABLE public.profiles TO authenticated;
CREATE POLICY profiles_update_self ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.is_admin())
  WITH CHECK (id = auth.uid() OR public.is_admin());
-- D
DROP POLICY IF EXISTS evidences_auth_select ON storage.objects;
CREATE POLICY evidences_auth_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'evidences' AND public.current_app_role() IN ('admin','vice','teacher'));
-- B: سياسات reports الأصلية تُستعاد من لقطة S1 يدويًا عند الحاجة
COMMIT;
*/
