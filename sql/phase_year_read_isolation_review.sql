-- ============================================================
-- phase_year_read_isolation_review.sql
-- مراجعة فقط — لا يُنفَّذ تلقائياً
-- ============================================================
-- الغرض:
--   تشديد SELECT على مستوى RLS لعزل قراءة السنوات الدراسية.
--
-- السياسة المعتمدة:
--   admin / vice  : قراءة بيانات كل السنوات (بما فيها frozen/archived/draft)
--   teacher       : قراءة السنة النشطة فقط
--   الكتابة         : دون تغيير — تبقى عبر school_year_allows_write()
--   لا توسيع لصلاحيات teacher
--
-- النطاق:
--   SELECT policies فقط على:
--     programs, program_indicators, evidences, initiatives,
--     tasks, teacher_followups, school_years
--   settings: بلا تغيير
--   INSERT / UPDATE / DELETE: بلا تغيير
--
-- المتطلبات المسبقة (يجب أن تكون مطبّقة مسبقاً):
--   public.current_app_role()
--   public.is_admin()
--   public.is_staff()          -- admin + vice فقط (ليس teacher)
--   public.school_year_allows_write(uuid)
--   school_years.status ∈ ('draft','active','frozen','archived')  -- وفق archive foundation v2
--
-- أسماء السياسات المستهدفة (مطابقة phase_rls_cutover / archive v2):
--   programs_select, indicators_select, evidences_select,
--   initiatives_select, tasks_select, tf_select, sy_select
-- ============================================================


-- ############################################################################
-- A) PRECHECK — SELECT فقط (توقّف إن ظهر STOP)
-- ############################################################################

-- P1) وجود الجداول والدوال المطلوبة
SELECT
  to_regclass('public.programs') IS NOT NULL AS has_programs,
  to_regclass('public.program_indicators') IS NOT NULL AS has_program_indicators,
  to_regclass('public.evidences') IS NOT NULL AS has_evidences,
  to_regclass('public.initiatives') IS NOT NULL AS has_initiatives,
  to_regclass('public.tasks') IS NOT NULL AS has_tasks,
  to_regclass('public.teacher_followups') IS NOT NULL AS has_teacher_followups,
  to_regclass('public.school_years') IS NOT NULL AS has_school_years,
  to_regprocedure('public.current_app_role()') IS NOT NULL AS has_current_app_role,
  to_regprocedure('public.is_admin()') IS NOT NULL AS has_is_admin,
  to_regprocedure('public.is_staff()') IS NOT NULL AS has_is_staff,
  to_regprocedure('public.school_year_allows_write(uuid)') IS NOT NULL AS has_allows_write;

-- P2) STOP إن نقصت دالة لازمة
SELECT 'STOP: missing required helper function'::text AS action
WHERE to_regprocedure('public.current_app_role()') IS NULL
   OR to_regprocedure('public.is_admin()') IS NULL
   OR to_regprocedure('public.is_staff()') IS NULL
   OR to_regprocedure('public.school_year_allows_write(uuid)') IS NULL;

-- P3) تأكيد أن is_staff = admin|vice فقط (ليس teacher)
SELECT
  CASE
    WHEN pg_get_functiondef('public.is_staff()'::regprocedure)
           ILIKE '%''admin''%'
     AND pg_get_functiondef('public.is_staff()'::regprocedure)
           ILIKE '%''vice''%'
     AND pg_get_functiondef('public.is_staff()'::regprocedure)
           NOT ILIKE '%teacher%'
      THEN 'ok: is_staff is admin|vice only'
    ELSE 'STOP: is_staff definition unexpected — review before applying'
  END AS is_staff_check;

-- P4) قيم status المسموحة على school_years (يجب أن تشمل frozen إن طُبّق v2)
SELECT
  conname,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.school_years'::regclass
  AND contype = 'c'
  AND (conname ILIKE '%status%' OR pg_get_constraintdef(oid) ILIKE '%status%')
ORDER BY conname;

-- P5) سياسات SELECT الحالية (قبل التغيير)
SELECT
  tablename,
  policyname,
  roles,
  cmd,
  qual AS using_expression
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'programs','program_indicators','evidences','initiatives',
    'tasks','teacher_followups','school_years'
  )
  AND cmd = 'SELECT'
ORDER BY tablename, policyname;

-- P6) NULL school_year_id على الجداول التشغيلية (للوعي — لا يمنع التنفيذ)
SELECT 'programs' AS table_name,
       count(*) FILTER (WHERE school_year_id IS NULL) AS null_year_rows,
       count(*) AS total
FROM public.programs
UNION ALL
SELECT 'evidences',
       count(*) FILTER (WHERE school_year_id IS NULL),
       count(*)
FROM public.evidences
UNION ALL
SELECT 'initiatives',
       count(*) FILTER (WHERE school_year_id IS NULL),
       count(*)
FROM public.initiatives
UNION ALL
SELECT 'tasks',
       count(*) FILTER (WHERE school_year_id IS NULL),
       count(*)
FROM public.tasks
UNION ALL
SELECT 'teacher_followups',
       count(*) FILTER (WHERE school_year_id IS NULL),
       count(*)
FROM public.teacher_followups;

-- P7) السنوات النشطة حالياً
SELECT id, name, status, is_active, is_archived
FROM public.school_years
WHERE is_active = true
ORDER BY created_at NULLS LAST;


-- ############################################################################
-- B–E) التطبيق داخل معاملة
-- ############################################################################

BEGIN;

-- ------------------------------------------------------------
-- C) school_year_allows_read(uuid)
--    - admin/vice (is_staff): أي سنة موجودة
--    - teacher: السنة النشطة فقط (status=active, is_active, not archived)
--    - NULL year id → false (آمن)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.school_year_allows_read(p_year_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_year_id IS NULL THEN false
    WHEN public.is_staff() THEN
      EXISTS (
        SELECT 1
        FROM public.school_years AS sy
        WHERE sy.id = p_year_id
      )
    WHEN public.current_app_role() = 'teacher' THEN
      EXISTS (
        SELECT 1
        FROM public.school_years AS sy
        WHERE sy.id = p_year_id
          AND sy.is_active = true
          AND sy.is_archived = false
          AND sy.status = 'active'
      )
    ELSE false
  END;
$$;

COMMENT ON FUNCTION public.school_year_allows_read(uuid) IS
  'SELECT isolation: staff(admin|vice) may read any school year; teacher only the active year. NULL → false.';

REVOKE ALL ON FUNCTION public.school_year_allows_read(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.school_year_allows_read(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.school_year_allows_read(uuid) TO authenticated;

-- ------------------------------------------------------------
-- D) إعادة تعريف SELECT policies فقط
--    لا تُمس سياسات INSERT / UPDATE / DELETE
-- ------------------------------------------------------------

-- programs
DROP POLICY IF EXISTS programs_select ON public.programs;
CREATE POLICY programs_select ON public.programs
  FOR SELECT TO authenticated
  USING (
    public.current_app_role() IN ('admin', 'vice', 'teacher')
    AND public.school_year_allows_read(school_year_id)
  );

-- program_indicators (السنة عبر programs)
DROP POLICY IF EXISTS indicators_select ON public.program_indicators;
CREATE POLICY indicators_select ON public.program_indicators
  FOR SELECT TO authenticated
  USING (
    public.current_app_role() IN ('admin', 'vice', 'teacher')
    AND EXISTS (
      SELECT 1
      FROM public.programs AS pr
      WHERE pr.id = program_id
        AND public.school_year_allows_read(pr.school_year_id)
    )
  );

-- evidences
DROP POLICY IF EXISTS evidences_select ON public.evidences;
CREATE POLICY evidences_select ON public.evidences
  FOR SELECT TO authenticated
  USING (
    public.current_app_role() IN ('admin', 'vice', 'teacher')
    AND public.school_year_allows_read(school_year_id)
  );

-- initiatives (admin/vice فقط — كما السابق؛ بلا teacher)
DROP POLICY IF EXISTS initiatives_select ON public.initiatives;
CREATE POLICY initiatives_select ON public.initiatives
  FOR SELECT TO authenticated
  USING (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_read(school_year_id)
  );

-- tasks
DROP POLICY IF EXISTS tasks_select ON public.tasks;
CREATE POLICY tasks_select ON public.tasks
  FOR SELECT TO authenticated
  USING (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_read(school_year_id)
  );

-- teacher_followups
DROP POLICY IF EXISTS tf_select ON public.teacher_followups;
CREATE POLICY tf_select ON public.teacher_followups
  FOR SELECT TO authenticated
  USING (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_read(school_year_id)
  );

-- school_years
-- admin/vice: كل السنوات (أرشيف/تجميد/مسودة)
-- teacher: السنة النشطة فقط (لا توسيع صلاحيات)
DROP POLICY IF EXISTS sy_select ON public.school_years;
CREATE POLICY sy_select ON public.school_years
  FOR SELECT TO authenticated
  USING (
    public.is_staff()
    OR (
      public.current_app_role() = 'teacher'
      AND is_active = true
      AND is_archived = false
      AND status = 'active'
    )
  );

-- E)
COMMIT;


-- ############################################################################
-- F) POSTCHECK — SELECT فقط
-- ############################################################################

-- PC1) تعريف الدالة
SELECT
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef AS security_definer,
  pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'school_year_allows_read';

-- PC2) grants على الدالة
SELECT
  r.rolname AS grantee,
  has_function_privilege(r.oid, 'public.school_year_allows_read(uuid)'::regprocedure, 'EXECUTE') AS can_execute
FROM pg_roles r
WHERE r.rolname IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY r.rolname;

-- PC3) كل SELECT policies بعد التغيير (يجب أن تشير لـ school_year_allows_read ما عدا sy_select)
SELECT
  tablename,
  policyname,
  roles,
  cmd,
  qual AS using_expression
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'programs','program_indicators','evidences','initiatives',
    'tasks','teacher_followups','school_years'
  )
  AND cmd = 'SELECT'
ORDER BY tablename, policyname;

-- PC4) تأكيد أن SELECT التشغيلية تستخدم school_year_allows_read
SELECT
  tablename,
  policyname,
  CASE
    WHEN coalesce(qual, '') ILIKE '%school_year_allows_read%'
      THEN 'ok: uses school_year_allows_read'
    WHEN tablename = 'school_years' AND policyname = 'sy_select'
      THEN 'ok: sy_select uses role/active rules (no helper required)'
    ELSE 'FAIL: SELECT policy missing school_year_allows_read'
  END AS read_isolation_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'programs','program_indicators','evidences','initiatives',
    'tasks','teacher_followups','school_years'
  )
  AND cmd = 'SELECT'
ORDER BY tablename, policyname;

-- PC5) التأكد أن سياسات الكتابة لم تُمس (ما زالت تستخدم allows_write حيث متوقع)
SELECT
  tablename,
  policyname,
  cmd,
  CASE
    WHEN cmd IN ('INSERT', 'UPDATE', 'DELETE')
     AND (
       coalesce(qual, '') ILIKE '%school_year_allows_write%'
       OR coalesce(with_check, '') ILIKE '%school_year_allows_write%'
       OR coalesce(with_check, '') ILIKE '%school_year_is_active%'
       OR tablename = 'school_years'  -- sy_insert/update/delete قد تكون false الثابتة
     )
      THEN 'ok: write policy present / expected'
    WHEN cmd IN ('INSERT', 'UPDATE', 'DELETE')
      THEN 'REVIEW: write policy expression'
    ELSE 'n/a'
  END AS write_untouched_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'programs','program_indicators','evidences','initiatives',
    'tasks','teacher_followups','school_years'
  )
  AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
ORDER BY tablename, cmd, policyname;

-- PC6) سياسات SELECT قديمة متعارضة / مفتوحة (يجب ألا تظهر)
SELECT
  tablename,
  policyname,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'programs','program_indicators','evidences','initiatives',
    'tasks','teacher_followups','school_years'
  )
  AND cmd = 'SELECT'
  AND (
    policyname = 'allow_all'
    OR policyname ILIKE 'app_read'
    OR coalesce(qual, '') IN ('true', '(true)')
    OR (
      coalesce(qual, '') ILIKE '%current_app_role%'
      AND coalesce(qual, '') NOT ILIKE '%school_year_allows_read%'
      AND tablename <> 'school_years'
    )
  )
ORDER BY tablename, policyname;

-- PC7) settings لم تتغير بهذا الملف (توثيق فقط)
SELECT
  tablename,
  policyname,
  cmd,
  qual
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'settings'
ORDER BY cmd, policyname;


-- ############################################################################
-- G) ROLLBACK PLAN — تعليقات فقط؛ لا تُنفَّذ تلقائياً
-- ############################################################################
-- بعد موافقة صريحة فقط، يمكن إعادة SELECT السابقة (بدون عزل السنة) كالتالي:
--
-- BEGIN;
--
-- DROP POLICY IF EXISTS programs_select ON public.programs;
-- CREATE POLICY programs_select ON public.programs
--   FOR SELECT TO authenticated
--   USING (public.current_app_role() IN ('admin', 'vice', 'teacher'));
--
-- DROP POLICY IF EXISTS indicators_select ON public.program_indicators;
-- CREATE POLICY indicators_select ON public.program_indicators
--   FOR SELECT TO authenticated
--   USING (public.current_app_role() IN ('admin', 'vice', 'teacher'));
--
-- DROP POLICY IF EXISTS evidences_select ON public.evidences;
-- CREATE POLICY evidences_select ON public.evidences
--   FOR SELECT TO authenticated
--   USING (public.current_app_role() IN ('admin', 'vice', 'teacher'));
--
-- DROP POLICY IF EXISTS initiatives_select ON public.initiatives;
-- CREATE POLICY initiatives_select ON public.initiatives
--   FOR SELECT TO authenticated
--   USING (public.current_app_role() IN ('admin', 'vice'));
--
-- DROP POLICY IF EXISTS tasks_select ON public.tasks;
-- CREATE POLICY tasks_select ON public.tasks
--   FOR SELECT TO authenticated
--   USING (public.current_app_role() IN ('admin', 'vice'));
--
-- DROP POLICY IF EXISTS tf_select ON public.teacher_followups;
-- CREATE POLICY tf_select ON public.teacher_followups
--   FOR SELECT TO authenticated
--   USING (public.current_app_role() IN ('admin', 'vice'));
--
-- DROP POLICY IF EXISTS sy_select ON public.school_years;
-- CREATE POLICY sy_select ON public.school_years
--   FOR SELECT TO authenticated
--   USING (public.current_app_role() IN ('admin', 'vice', 'teacher'));
--
-- DROP FUNCTION IF EXISTS public.school_year_allows_read(uuid);
--
-- COMMIT;
--
-- ملاحظة: لا يستعيد هذا أي سياسات INSERT/UPDATE/DELETE — لم تُغيَّر أصلاً.
-- نهاية الملف.
