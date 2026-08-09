-- ============================================================
-- emergency_legacy_rls_cleanup_review.sql
-- إصلاح طارئ للمراجعة — إسقاط 7 سياسات RLS قديمة مفتوحة (anon/public)
-- الفرع: feature/academic-year-archive-hijri-calendar
-- ============================================================
-- الغرض:
--   سياسات PERMISSIVE قديمة بـ USING/WITH CHECK true تُجمَع بـ OR مع
--   السياسات الآمنة فتُلغي أثرها وتفتح الجداول لـ anon/public رغم Auth.
--
-- النطاق فقط: programs / program_indicators / settings / users
-- خارج النطاق: evidences، school_years، الأرشفة، حذف بيانات/جداول/حسابات.
--
-- عدد السياسات الخطرة المؤكدة حيًا: 7 (وليس 8).
-- users_deny_all = سياسة إنكار آمنة — لا تُحذف.
--
-- ترتيب العمل:
--   1) نفّذ PRECHECK فقط. إن ظهر أي صف تحت STOP — توقّف ولا تنفّذ الإصلاح.
--   2) بعد نجاح PRECHECK، نفّذ كتلة BEGIN … COMMIT كاملة كدفعة واحدة.
--   3) عند أي خطأ داخل المعاملة تصبح الحالة aborted:
--      نفّذ ROLLBACK; صراحة قبل أي إعادة محاولة أو أوامر لاحقة.
--      لا تعتمد على COMMIT بعد الفشل، ولا تُعدّ المحاولة داخل معاملة مجهَضة.
--   4) نفّذ POSTCHECK بعد نجاح COMMIT للتوثيق.
--
-- لا يُنفَّذ تلقائياً من المستودع — مراجعة يدوية ثم موافقة.
-- ============================================================


-- ############################################################################
-- PRECHECK (قراءة فقط) — يثبت وجود السياسات الآمنة وتعريفها بدقة
-- إن ظهر أي صف من استعلامات STOP_* أدناه: توقّف — لا تنفّذ BEGIN.
-- ############################################################################

-- P0) لقطة كل السياسات على الجداول المستهدفة
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('programs', 'program_indicators', 'settings', 'users')
ORDER BY tablename, policyname;

-- P1) السياسات الخطرة السبعة المؤكدة (يجب أن تظهر قبل الإصلاح)
SELECT
  tablename,
  policyname,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    (tablename = 'program_indicators' AND policyname IN (
      'allow delete indicators',
      'allow insert indicators',
      'allow read indicators',
      'allow update indicators'
    ))
    OR (tablename = 'programs' AND policyname = 'public all programs')
    OR (tablename = 'settings' AND policyname = 'Allow all settings access')
    OR (tablename = 'users' AND policyname = 'public read users')
  )
ORDER BY tablename, policyname;

-- P2) الدوال المطلوبة للسياسات الآمنة (بدون إنشاء؛ فقط التحقق من current_app_role و is_admin)
SELECT
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('current_app_role', 'is_admin')
ORDER BY p.proname;

-- ---------- STOP: غياب دالة مطلوبة ----------
-- إن ظهر صف هنا للدالة الناقصة — توقّف.
SELECT
  missing.fn AS missing_function,
  'STOP: نفّذ phase_auth_foundation_review قبل أي إصلاح للجداول'::text AS action
FROM (
  VALUES ('current_app_role'), ('is_admin')
) AS missing(fn)
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = missing.fn
);

-- ---------- STOP: سياسة آمنة غائبة أو تعريفها غير مطابق ----------
-- الناتج يجب أن يكون فارغًا تمامًا. أي صف = حاجز: لا تنفّذ BEGIN.
-- متطلبات التعريف:
--   SELECT: authenticated + current_app_role + admin + vice + teacher
--   INSERT/UPDATE (programs/indicators): authenticated + current_app_role + admin + vice
--   DELETE (programs/indicators) وكتابة settings: is_admin() فقط
--   users_deny_all: anon + authenticated + qual=false + with_check=false
SELECT
  v.tablename,
  v.policyname,
  v.expected_cmd,
  'STOP: سياسة آمنة غائبة أو تعريفها غير مطابق — لا تنفّذ الإصلاح'::text AS action,
  p.cmd AS actual_cmd,
  p.roles AS actual_roles,
  p.qual AS actual_qual,
  p.with_check AS actual_with_check
FROM (
  VALUES
    -- programs: SELECT = admin+vice+teacher
    ('programs', 'programs_select', 'SELECT',
     '%authenticated%',
     '%current_app_role%', '%admin%', '%vice%', '%teacher%',
     NULL::text, NULL::text, NULL::text, NULL::text),
    -- programs: INSERT = admin+vice
    ('programs', 'programs_insert', 'INSERT',
     '%authenticated%',
     NULL, NULL, NULL, NULL,
     '%current_app_role%', '%admin%', '%vice%', NULL),
    -- programs: UPDATE = admin+vice على qual و with_check
    ('programs', 'programs_update', 'UPDATE',
     '%authenticated%',
     '%current_app_role%', '%admin%', '%vice%', NULL,
     '%current_app_role%', '%admin%', '%vice%', NULL),
    -- programs: DELETE = is_admin()
    ('programs', 'programs_delete', 'DELETE',
     '%authenticated%',
     '%is_admin%', NULL, NULL, NULL,
     NULL, NULL, NULL, NULL),
    -- program_indicators
    ('program_indicators', 'indicators_select', 'SELECT',
     '%authenticated%',
     '%current_app_role%', '%admin%', '%vice%', '%teacher%',
     NULL, NULL, NULL, NULL),
    ('program_indicators', 'indicators_insert', 'INSERT',
     '%authenticated%',
     NULL, NULL, NULL, NULL,
     '%current_app_role%', '%admin%', '%vice%', NULL),
    ('program_indicators', 'indicators_update', 'UPDATE',
     '%authenticated%',
     '%current_app_role%', '%admin%', '%vice%', NULL,
     '%current_app_role%', '%admin%', '%vice%', NULL),
    ('program_indicators', 'indicators_delete', 'DELETE',
     '%authenticated%',
     '%is_admin%', NULL, NULL, NULL,
     NULL, NULL, NULL, NULL),
    -- settings: SELECT = admin+vice+teacher؛ الكتابة = is_admin() فقط
    ('settings', 'settings_select', 'SELECT',
     '%authenticated%',
     '%current_app_role%', '%admin%', '%vice%', '%teacher%',
     NULL, NULL, NULL, NULL),
    ('settings', 'settings_update', 'UPDATE',
     '%authenticated%',
     '%is_admin%', NULL, NULL, NULL,
     '%is_admin%', NULL, NULL, NULL),
    ('settings', 'settings_insert', 'INSERT',
     '%authenticated%',
     NULL, NULL, NULL, NULL,
     '%is_admin%', NULL, NULL, NULL),
    ('settings', 'settings_delete', 'DELETE',
     '%authenticated%',
     '%is_admin%', NULL, NULL, NULL,
     NULL, NULL, NULL, NULL),
    -- users_deny_all (إنكار آمن — لا يُحذف لاحقاً)
    ('users', 'users_deny_all', 'ALL',
     '%authenticated%',
     NULL, NULL, NULL, NULL,
     NULL, NULL, NULL, NULL)
) AS v(
  tablename, policyname, expected_cmd, roles_like,
  qual_like_1, qual_like_2, qual_like_3, qual_like_4,
  check_like_1, check_like_2, check_like_3, check_like_4
)
LEFT JOIN pg_policies p
  ON p.schemaname = 'public'
 AND p.tablename = v.tablename
 AND p.policyname = v.policyname
WHERE
  p.policyname IS NULL
  OR (
    v.policyname = 'users_deny_all'
    AND NOT (
      p.cmd IN ('ALL', '*')
      AND p.roles::text ILIKE '%authenticated%'
      AND p.roles::text ILIKE '%anon%'
      AND COALESCE(p.qual, '') IN ('false', '(false)')
      AND COALESCE(p.with_check, '') IN ('false', '(false)')
    )
  )
  OR (
    v.policyname <> 'users_deny_all'
    AND (
      p.cmd IS DISTINCT FROM v.expected_cmd
      OR p.roles::text NOT ILIKE v.roles_like
      OR (v.qual_like_1 IS NOT NULL AND COALESCE(p.qual, '') NOT ILIKE v.qual_like_1)
      OR (v.qual_like_2 IS NOT NULL AND COALESCE(p.qual, '') NOT ILIKE v.qual_like_2)
      OR (v.qual_like_3 IS NOT NULL AND COALESCE(p.qual, '') NOT ILIKE v.qual_like_3)
      OR (v.qual_like_4 IS NOT NULL AND COALESCE(p.qual, '') NOT ILIKE v.qual_like_4)
      OR (v.check_like_1 IS NOT NULL AND COALESCE(p.with_check, '') NOT ILIKE v.check_like_1)
      OR (v.check_like_2 IS NOT NULL AND COALESCE(p.with_check, '') NOT ILIKE v.check_like_2)
      OR (v.check_like_3 IS NOT NULL AND COALESCE(p.with_check, '') NOT ILIKE v.check_like_3)
      OR (v.check_like_4 IS NOT NULL AND COALESCE(p.with_check, '') NOT ILIKE v.check_like_4)
    )
  )
ORDER BY v.tablename, v.policyname;

-- P3) لقطة المنح الحالية للمراجعة
SELECT
  table_name,
  grantee,
  privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('programs', 'program_indicators', 'settings', 'users')
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY table_name, grantee, privilege_type;

-- ############################################################################
-- حاجز التنفيذ
-- طالما استعلامات STOP_* أعلاه تُرجع أي صف: لا تنفّذ المعاملة أدناه.
-- لا يوجد ENSURE_SAFE_POLICIES في مسار التنفيذ الطبيعي:
-- لا DROP/CREATE لـ programs_* أو indicators_* أو settings_* أو users_deny_all.
-- ############################################################################


-- ############################################################################
-- TRANSACTION — التعديلات الفعلية فقط (7 سياسات خطرة + REVOKE/GRANT)
-- نفّذ هذه الكتلة كاملة فقط بعد نجاح PRECHECK يدويًا.
-- عند أي خطأ تصبح المعاملة aborted: نفّذ ROLLBACK; صراحة قبل إعادة المحاولة.
-- ############################################################################

BEGIN;

-- A) إسقاط السياسات السبعة الخطرة المؤكدة حيًا فقط
DROP POLICY IF EXISTS "allow delete indicators" ON public.program_indicators;
DROP POLICY IF EXISTS "allow insert indicators" ON public.program_indicators;
DROP POLICY IF EXISTS "allow read indicators" ON public.program_indicators;
DROP POLICY IF EXISTS "allow update indicators" ON public.program_indicators;

DROP POLICY IF EXISTS "public all programs" ON public.programs;

DROP POLICY IF EXISTS "Allow all settings access" ON public.settings;

DROP POLICY IF EXISTS "public read users" ON public.users;

-- B) REVOKE وصول anon/PUBLIC عن الجداول التشغيلية المستهدفة
REVOKE ALL ON TABLE public.programs FROM anon;
REVOKE ALL ON TABLE public.programs FROM PUBLIC;
REVOKE ALL ON TABLE public.program_indicators FROM anon;
REVOKE ALL ON TABLE public.program_indicators FROM PUBLIC;
REVOKE ALL ON TABLE public.settings FROM anon;
REVOKE ALL ON TABLE public.settings FROM PUBLIC;

-- C) REVOKE وفق التصميم الحالي عن public.users (مغلق للعملاء بعد Auth)
REVOKE ALL ON TABLE public.users FROM anon;
REVOKE ALL ON TABLE public.users FROM authenticated;
REVOKE ALL ON TABLE public.users FROM PUBLIC;

-- D) الحفاظ على GRANT المطلوب لـ authenticated (RLS يقيّد الصفوف)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.programs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.program_indicators TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.settings TO authenticated;
-- لا GRANT على public.users نحو anon/authenticated/PUBLIC
-- لا مساس بسياسات evidences أو صلاحيات المعلمة هنا

-- E) تحقق داخل المعاملة — المقسوم عليه غير ثابت ويأتي من نتيجة الاستعلام
--    عند الفشل: division by zero → أوقف ونفّذ ROLLBACK; صراحة قبل أي إعادة محاولة
-- E1) السياسات الخطرة السبعة يجب أن تختفي
SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        (tablename = 'program_indicators' AND policyname IN (
          'allow delete indicators',
          'allow insert indicators',
          'allow read indicators',
          'allow update indicators'
        ))
        OR (tablename = 'programs' AND policyname = 'public all programs')
        OR (tablename = 'settings' AND policyname = 'Allow all settings access')
        OR (tablename = 'users' AND policyname = 'public read users')
      )
  ) THEN 0
  ELSE 1
END AS tx_check_dangerous_policies_gone;

-- E2) السياسات الآمنة الـ 13 ما زالت موجودة (أسماء فقط داخل الـ TX)
SELECT 1 / CASE
  WHEN (
    SELECT COUNT(*)::int
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        (tablename = 'programs' AND policyname IN (
          'programs_select', 'programs_insert', 'programs_update', 'programs_delete'
        ))
        OR (tablename = 'program_indicators' AND policyname IN (
          'indicators_select', 'indicators_insert', 'indicators_update', 'indicators_delete'
        ))
        OR (tablename = 'settings' AND policyname IN (
          'settings_select', 'settings_update', 'settings_insert', 'settings_delete'
        ))
        OR (tablename = 'users' AND policyname = 'users_deny_all')
      )
  ) < 13 THEN 0
  ELSE 1
END AS tx_check_safe_policies_still_present;

-- E3) لا منح متبقية لـ anon/PUBLIC على الجداول الأربعة
SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('programs', 'program_indicators', 'settings', 'users')
      AND grantee IN ('anon', 'PUBLIC')
  ) THEN 0
  ELSE 1
END AS tx_check_anon_public_grants_gone;

-- نجح التحقق داخل الـ TX: ثبّت التغييرات
COMMIT;

-- عند أي خطأ قبل COMMIT:
--   1) المعاملة تصبح aborted
--   2) نفّذ صراحة: ROLLBACK;
--   3) لا تعِد تشغيل أوامر داخل نفس الجلسة قبل ROLLBACK;
--   4) أصلح السبب، أعد PRECHECK، ثم ابدأ BEGIN جديدًا


-- ############################################################################
-- POSTCHECK (بعد COMMIT الناجح) — توثيق النتيجة يدويًا
-- ############################################################################

SELECT
  tablename,
  policyname,
  roles,
  cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    (tablename = 'program_indicators' AND policyname IN (
      'allow delete indicators',
      'allow insert indicators',
      'allow read indicators',
      'allow update indicators'
    ))
    OR (tablename = 'programs' AND policyname = 'public all programs')
    OR (tablename = 'settings' AND policyname = 'Allow all settings access')
    OR (tablename = 'users' AND policyname = 'public read users')
  );
-- المتوقع: 0 صفوف.

SELECT
  tablename,
  policyname,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('programs', 'program_indicators', 'settings', 'users')
  AND (
    qual IN ('true', '(true)')
    OR with_check IN ('true', '(true)')
  );
-- المتوقع: 0 صفوف.

SELECT
  tablename,
  policyname
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    (tablename = 'programs' AND policyname LIKE 'programs_%')
    OR (tablename = 'program_indicators' AND policyname LIKE 'indicators_%')
    OR (tablename = 'settings' AND policyname LIKE 'settings_%')
    OR (tablename = 'users' AND policyname = 'users_deny_all')
  )
ORDER BY tablename, policyname;
-- المتوقع: 13 سياسة بما فيها users_deny_all الباقية.

SELECT
  table_name,
  grantee,
  privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('programs', 'program_indicators', 'settings', 'users')
  AND grantee IN ('anon', 'PUBLIC');
-- المتوقع: 0 صفوف.


-- ############################################################################
-- ROLLBACK غير الآمن — معلّق بالكامل — تحذير واضح — لا يُنفَّذ في المسار العادي
-- تحذير: يعيد فتح الجداول بسياسات خطرة لـ anon/public. لا تستخدمه إلا بقرار صريح منفصل.
-- ############################################################################

/*
-- ===== BEGIN UNSAFE ROLLBACK (DO NOT RUN IN NORMAL FLOW) =====
-- يعيد 7 سياسات خطرة. خطر أمني. لا تضعه داخل BEGIN…COMMIT العادي ولا تنفّذه بعد إصلاح ناجح.

CREATE POLICY "allow read indicators" ON public.program_indicators
  FOR SELECT TO anon USING (true);
CREATE POLICY "allow insert indicators" ON public.program_indicators
  FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "allow update indicators" ON public.program_indicators
  FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "allow delete indicators" ON public.program_indicators
  FOR DELETE TO anon USING (true);

CREATE POLICY "public all programs" ON public.programs
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "Allow all settings access" ON public.settings
  FOR ALL TO public USING (true) WITH CHECK (true);

CREATE POLICY "public read users" ON public.users
  FOR SELECT TO public USING (true);

GRANT ALL ON TABLE public.programs TO anon;
GRANT ALL ON TABLE public.program_indicators TO anon;
GRANT ALL ON TABLE public.settings TO PUBLIC;
GRANT SELECT ON TABLE public.users TO PUBLIC;

-- ===== END UNSAFE ROLLBACK =====
*/

-- ============================================================
-- نهاية ملف المراجعة
-- ============================================================
