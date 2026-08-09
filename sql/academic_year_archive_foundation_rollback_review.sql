-- ============================================================
-- academic_year_archive_foundation_rollback_review.sql
-- تراجع مستقل بعد COMMIT لـ academic_year_archive_foundation_v2_review.sql
-- الفرع: feature/academic-year-archive-hijri-calendar
-- ============================================================
-- الغرض:
--   إعادة القيود والدوال والسياسات إلى وضع ما قبل foundation v2
--   (مطابق لـ phase_rls_cutover_review) دون حذف بيانات تشغيلية.
--
-- ترتيب إلزامي داخل BEGIN (بدون CASCADE):
--   1) إسقاط سياسات RLS التي تعتمد على
--      school_year_allows_write / school_year_is_active فقط
--   2) إسقاط Trigger الحماية trg_school_years_guard_state
--   3) تحويل status='frozen' → archived داخل المعاملة
--   4) إسقاط الدوال الجديدة
--   5) إسقاط سياسات الجداول المستهدفة المتبقية تمهيداً لإعادة إنشائها
--   6) إعادة قيود school_years لما قبل v2
--   7) إنشاء سياسات ما قبل v2 الآمنة
--
-- خارج النطاق صراحة (لا يُلمس):
--   auth.users · public.profiles · public.users · Storage / buckets / objects
--   لا DELETE/TRUNCATE لبيانات تشغيلية · لا حذف سنوات/ملفات/حسابات
--   تحويل frozen يحفظ الصف ويغيّر حالته فقط (لا حذف).
--
-- تحذير:
--   1) عند أي خطأ: نفّذ ROLLBACK; صراحة قبل إعادة المحاولة.
--   2) لا يُنفَّذ تلقائياً — مراجعة يدوية ثم موافقة.
-- ============================================================


-- ############################################################################
-- PRECHECK
-- ############################################################################

SELECT id, name, status, is_active, is_archived
FROM public.school_years
ORDER BY created_at;

-- معلومة فقط: عدد frozen — Rollback يعالجها داخل المعاملة بعد إسقاط Trigger
-- (لا STOP هنا؛ لا تحاول UPDATE يدوياً قبل BEGIN لأن Trigger الحماية يرفضه)
SELECT
  COUNT(*) FILTER (WHERE status = 'frozen') AS frozen_rows_info,
  'سيتم تحويل frozen → archived داخل BEGIN بعد DROP TRIGGER'::text AS note
FROM public.school_years;

-- سياسات تعتمد على دوال السنة (يجب إسقاطها قبل DROP FUNCTION)
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    COALESCE(qual, '') ILIKE '%school_year_allows_write%'
    OR COALESCE(with_check, '') ILIKE '%school_year_allows_write%'
    OR COALESCE(qual, '') ILIKE '%school_year_is_active%'
    OR COALESCE(with_check, '') ILIKE '%school_year_is_active%'
  )
ORDER BY tablename, policyname;

SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'create_school_year', 'update_school_year_meta',
    'activate_school_year', 'freeze_school_year', 'archive_school_year',
    'school_year_allows_write', 'school_year_is_active',
    'trg_school_years_guard_state'
  )
ORDER BY p.proname;


-- ############################################################################
-- TRANSACTION — تراجع بدون حذف بيانات وبدون CASCADE
-- ############################################################################

BEGIN;

-- ##########################################################################
-- 1) DROP سياسات RLS التي تعتمد على school_year_allows_write / school_year_is_active
-- ##########################################################################

DROP POLICY IF EXISTS programs_insert ON public.programs;
DROP POLICY IF EXISTS programs_update ON public.programs;
DROP POLICY IF EXISTS programs_delete ON public.programs;

DROP POLICY IF EXISTS indicators_insert ON public.program_indicators;
DROP POLICY IF EXISTS indicators_update ON public.program_indicators;
DROP POLICY IF EXISTS indicators_delete ON public.program_indicators;

DROP POLICY IF EXISTS evidences_insert ON public.evidences;
DROP POLICY IF EXISTS evidences_update ON public.evidences;
DROP POLICY IF EXISTS evidences_delete ON public.evidences;

DROP POLICY IF EXISTS initiatives_insert ON public.initiatives;
DROP POLICY IF EXISTS initiatives_update ON public.initiatives;
DROP POLICY IF EXISTS initiatives_delete ON public.initiatives;

DROP POLICY IF EXISTS tasks_insert ON public.tasks;
DROP POLICY IF EXISTS tasks_update ON public.tasks;
DROP POLICY IF EXISTS tasks_delete ON public.tasks;

DROP POLICY IF EXISTS tf_insert ON public.teacher_followups;
DROP POLICY IF EXISTS tf_update ON public.teacher_followups;
DROP POLICY IF EXISTS tf_delete ON public.teacher_followups;

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        COALESCE(qual, '') ILIKE '%school_year_allows_write%'
        OR COALESCE(with_check, '') ILIKE '%school_year_allows_write%'
        OR COALESCE(qual, '') ILIKE '%school_year_is_active%'
        OR COALESCE(with_check, '') ILIKE '%school_year_is_active%'
      )
  ) THEN 0
  ELSE 1
END AS tx_check_year_guard_policies_dropped;

-- ##########################################################################
-- 2) DROP Trigger الحماية (قبل أي تحويل frozen)
-- ##########################################################################

DROP TRIGGER IF EXISTS trg_school_years_guard_state ON public.school_years;
DROP FUNCTION IF EXISTS public.trg_school_years_guard_state();

-- ##########################################################################
-- 3) تحويل frozen → archived بأمان داخل المعاملة
--    بعد إسقاط Trigger وقبل إعادة قيود الحالة القديمة
--    (لا حذف صفوف — تحديث حالة فقط)
-- ##########################################################################

UPDATE public.school_years
SET
  status = 'archived',
  is_active = false,
  is_archived = true,
  updated_at = now()
WHERE status = 'frozen';

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1 FROM public.school_years WHERE status = 'frozen'
  ) THEN 0
  ELSE 1
END AS tx_check_no_frozen_rows_left;

-- ##########################################################################
-- 4) DROP الدوال الجديدة (بدون CASCADE)
-- ##########################################################################

DROP FUNCTION IF EXISTS public.create_school_year(text, text, date, date, text, text);
DROP FUNCTION IF EXISTS public.update_school_year_meta(uuid, text, text, date, date, text);
DROP FUNCTION IF EXISTS public.activate_school_year(uuid, boolean);
DROP FUNCTION IF EXISTS public.activate_school_year(uuid);
DROP FUNCTION IF EXISTS public.freeze_school_year(uuid);
DROP FUNCTION IF EXISTS public.archive_school_year(uuid);
DROP FUNCTION IF EXISTS public.school_year_allows_write(uuid);
DROP FUNCTION IF EXISTS public.school_year_is_active(uuid);

-- ##########################################################################
-- 5) إسقاط سياسات SELECT / school_years المتبقية تمهيداً لإعادة إنشائها
-- ##########################################################################

DROP POLICY IF EXISTS programs_select ON public.programs;
DROP POLICY IF EXISTS indicators_select ON public.program_indicators;
DROP POLICY IF EXISTS evidences_select ON public.evidences;
DROP POLICY IF EXISTS initiatives_select ON public.initiatives;
DROP POLICY IF EXISTS initiatives_write ON public.initiatives;
DROP POLICY IF EXISTS tasks_select ON public.tasks;
DROP POLICY IF EXISTS tf_select ON public.teacher_followups;

DROP POLICY IF EXISTS sy_select ON public.school_years;
DROP POLICY IF EXISTS sy_insert ON public.school_years;
DROP POLICY IF EXISTS sy_update ON public.school_years;
DROP POLICY IF EXISTS sy_delete ON public.school_years;
DROP POLICY IF EXISTS sy_write ON public.school_years;
DROP POLICY IF EXISTS app_read ON public.school_years;
DROP POLICY IF EXISTS app_write ON public.school_years;
DROP POLICY IF EXISTS allow_all ON public.school_years;

-- ##########################################################################
-- 6) إعادة قيود school_years لما قبل v2 (بدون frozen / بدون dates_check)
-- ##########################################################################

ALTER TABLE public.school_years
  DROP CONSTRAINT IF EXISTS school_years_state_check;
ALTER TABLE public.school_years
  DROP CONSTRAINT IF EXISTS school_years_status_check;
ALTER TABLE public.school_years
  DROP CONSTRAINT IF EXISTS school_years_dates_check;

ALTER TABLE public.school_years
  ADD CONSTRAINT school_years_status_check
  CHECK (status IN ('draft', 'active', 'archived'));

ALTER TABLE public.school_years
  ADD CONSTRAINT school_years_state_check
  CHECK (
    (is_active = true AND is_archived = false AND status = 'active')
    OR (is_active = false AND is_archived = true AND status = 'archived')
    OR (is_active = false AND is_archived = false AND status = 'draft')
  );

CREATE UNIQUE INDEX IF NOT EXISTS school_years_one_active_idx
  ON public.school_years (is_active)
  WHERE (is_active = true);

-- ##########################################################################
-- 7) إنشاء سياسات ما قبل v2 الآمنة (phase_rls_cutover_review)
-- ##########################################################################

CREATE POLICY programs_select ON public.programs
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice', 'teacher'));

CREATE POLICY programs_insert ON public.programs
  FOR INSERT TO authenticated
  WITH CHECK (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY programs_update ON public.programs
  FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice'))
  WITH CHECK (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY programs_delete ON public.programs
  FOR DELETE TO authenticated
  USING (public.is_admin());

CREATE POLICY indicators_select ON public.program_indicators
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice', 'teacher'));

CREATE POLICY indicators_insert ON public.program_indicators
  FOR INSERT TO authenticated
  WITH CHECK (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY indicators_update ON public.program_indicators
  FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice'))
  WITH CHECK (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY indicators_delete ON public.program_indicators
  FOR DELETE TO authenticated
  USING (public.is_admin());

CREATE POLICY evidences_select ON public.evidences
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice', 'teacher'));

CREATE POLICY evidences_insert ON public.evidences
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_app_role() IN ('admin', 'vice', 'teacher')
    AND created_by = auth.uid()
  );

CREATE POLICY evidences_update ON public.evidences
  FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice'))
  WITH CHECK (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY evidences_delete ON public.evidences
  FOR DELETE TO authenticated
  USING (public.is_admin());

CREATE POLICY initiatives_select ON public.initiatives
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY initiatives_insert ON public.initiatives
  FOR INSERT TO authenticated
  WITH CHECK (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY initiatives_update ON public.initiatives
  FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice'))
  WITH CHECK (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY initiatives_delete ON public.initiatives
  FOR DELETE TO authenticated
  USING (public.is_admin());

CREATE POLICY tasks_select ON public.tasks
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY tasks_insert ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY tasks_update ON public.tasks
  FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice'))
  WITH CHECK (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY tasks_delete ON public.tasks
  FOR DELETE TO authenticated
  USING (public.is_admin());

CREATE POLICY tf_select ON public.teacher_followups
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY tf_insert ON public.teacher_followups
  FOR INSERT TO authenticated
  WITH CHECK (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY tf_update ON public.teacher_followups
  FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice'))
  WITH CHECK (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY tf_delete ON public.teacher_followups
  FOR DELETE TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY sy_select ON public.school_years
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice', 'teacher'));

CREATE POLICY sy_insert ON public.school_years
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY sy_update ON public.school_years
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY sy_delete ON public.school_years
  FOR DELETE TO authenticated
  USING (public.is_admin());

REVOKE ALL ON TABLE public.school_years FROM anon;
REVOKE ALL ON TABLE public.school_years FROM PUBLIC;
REVOKE ALL ON TABLE public.programs FROM anon;
REVOKE ALL ON TABLE public.programs FROM PUBLIC;
REVOKE ALL ON TABLE public.program_indicators FROM anon;
REVOKE ALL ON TABLE public.program_indicators FROM PUBLIC;
REVOKE ALL ON TABLE public.evidences FROM anon;
REVOKE ALL ON TABLE public.evidences FROM PUBLIC;
REVOKE ALL ON TABLE public.initiatives FROM anon;
REVOKE ALL ON TABLE public.initiatives FROM PUBLIC;
REVOKE ALL ON TABLE public.tasks FROM anon;
REVOKE ALL ON TABLE public.tasks FROM PUBLIC;
REVOKE ALL ON TABLE public.teacher_followups FROM anon;
REVOKE ALL ON TABLE public.teacher_followups FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.school_years TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.programs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.program_indicators TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.evidences TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.initiatives TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.teacher_followups TO authenticated;

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'create_school_year', 'activate_school_year',
        'freeze_school_year', 'archive_school_year',
        'school_year_allows_write', 'school_year_is_active',
        'update_school_year_meta', 'trg_school_years_guard_state'
      )
  ) THEN 0 ELSE 1
END AS tx_check_new_functions_gone;

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.school_years'::regclass
      AND conname = 'school_years_status_check'
      AND pg_get_constraintdef(oid) ILIKE '%frozen%'
  ) THEN 0 ELSE 1
END AS tx_check_frozen_constraint_gone;

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        COALESCE(qual, '') ILIKE '%school_year_allows_write%'
        OR COALESCE(with_check, '') ILIKE '%school_year_allows_write%'
        OR COALESCE(qual, '') ILIKE '%school_year_is_active%'
        OR COALESCE(with_check, '') ILIKE '%school_year_is_active%'
      )
  ) THEN 0 ELSE 1
END AS tx_check_no_year_guard_policies;

SELECT 1 / CASE
  WHEN (
    SELECT COUNT(*)::int FROM public.school_years
    WHERE is_active AND status = 'active' AND NOT is_archived
  ) <= 1 THEN 1 ELSE 0
END AS tx_check_at_most_one_active;

COMMIT;

-- عند الفشل: ROLLBACK;


-- ############################################################################
-- POSTCHECK
-- ############################################################################

-- دوال v2 يجب أن تكون غائبة
SELECT p.proname
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'create_school_year', 'update_school_year_meta',
    'activate_school_year', 'freeze_school_year', 'archive_school_year',
    'school_year_allows_write', 'school_year_is_active',
    'trg_school_years_guard_state'
  );
-- المتوقع: 0 صفوف

-- لا سياسات بحارس السنة
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND (
    COALESCE(qual, '') ILIKE '%school_year_allows_write%'
    OR COALESCE(with_check, '') ILIKE '%school_year_allows_write%'
    OR COALESCE(qual, '') ILIKE '%school_year_is_active%'
    OR COALESCE(with_check, '') ILIKE '%school_year_is_active%'
  );
-- المتوقع: 0 صفوف

-- صلاحيات EXECUTE على دوال الدور الباقية:
-- فحص PUBLIC عبر has_function_privilege('public', ...) وليس عبر pg_roles
-- (PUBLIC ليس صفًا في pg_roles)
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
  has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
  CASE
    WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('public', p.oid, 'EXECUTE')
    THEN 'FAIL: anon/PUBLIC must not EXECUTE'
    WHEN NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
    THEN 'FAIL: authenticated missing EXECUTE'
    ELSE 'ok'
  END AS grant_check
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('current_app_role', 'is_admin', 'is_staff')
ORDER BY p.proname;

-- لا صفوف frozen متبقية
SELECT
  COUNT(*) FILTER (WHERE status = 'frozen') AS frozen_left,
  COUNT(*) FILTER (WHERE status = 'archived') AS archived_count,
  CASE
    WHEN COUNT(*) FILTER (WHERE status = 'frozen') = 0 THEN 'ok-no-frozen'
    ELSE 'FAIL: frozen rows remain'
  END AS frozen_check
FROM public.school_years;

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.school_years'::regclass
  AND contype = 'c'
ORDER BY conname;

SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'school_years', 'programs', 'program_indicators', 'evidences',
    'initiatives', 'tasks', 'teacher_followups'
  )
ORDER BY tablename, cmd, policyname;

SELECT id, name, status, is_active, is_archived
FROM public.school_years
ORDER BY created_at;


-- ============================================================
-- نهاية ملف التراجع
-- ============================================================
