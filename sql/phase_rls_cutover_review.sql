-- ============================================================
-- phase_rls_cutover_review.sql
-- مراجعة فقط — لا يُنفَّذ تلقائياً
-- ============================================================
-- المرحلة 2: إغلاق users القديم + RLS للجداول التشغيلية
-- ⚠️ يوقف الواجهة القديمة المعتمدة على public.users
-- نفّذ فقط بعد جاهزية الواجهة الجديدة + حساب admin + profiles
-- لا يحذف public.users
-- ============================================================

-- PRECHECK
-- SELECT COUNT(*) FROM public.profiles WHERE role = 'admin'; -- يجب >= 1
-- SELECT auth.uid(); -- من جلسة admin للاختبار لاحقاً

BEGIN;

-- ------------------------------------------------------------
-- 0) منح/سحب صلاحيات الجداول (صريحة)
-- ------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'programs','program_indicators','evidences','initiatives',
    'tasks','settings','teacher_followups','school_years'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', t);
    END IF;
  END LOOP;
END $$;

-- settings: الكتابة عادة صف واحد؛ نترك GRANT العام ونقيّد بالسياسات
-- teacher_followups: المعلمة بلا وصول في السياسات أدناه

-- ------------------------------------------------------------
-- 1) إغلاق public.users (بدون حذف)
-- ------------------------------------------------------------
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS allow_all ON public.users;
DROP POLICY IF EXISTS app_read ON public.users;
DROP POLICY IF EXISTS app_write ON public.users;
DROP POLICY IF EXISTS users_deny_all ON public.users;

CREATE POLICY users_deny_all ON public.users
  FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.users FROM anon;
REVOKE ALL ON TABLE public.users FROM authenticated;

-- سحب دوال الدخول/الإدارة القديمة بتواقيع آمنة (لا يفشل إن غابت)
DO $$
DECLARE
  sig text;
  candidates text[] := ARRAY[
    'public.authenticate_user(text,text)',
    'public.get_user_by_id(uuid,text)',
    'public.admin_add_user(uuid,text,text,text,text,text)',
    'public.admin_delete_user(uuid,text,uuid)',
    'public.admin_change_role(uuid,text,uuid,text)',
    'public.admin_list_users(uuid,text)'
  ];
BEGIN
  FOREACH sig IN ARRAY candidates LOOP
    IF to_regprocedure(sig) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', sig);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', sig);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', sig);
    END IF;
  END LOOP;
END $$;

-- اقتراح لاحق (لا يُنفَّذ هنا):
-- ALTER TABLE public.users RENAME TO users_legacy;

-- ------------------------------------------------------------
-- 2) programs — teacher: SELECT فقط
-- ------------------------------------------------------------
ALTER TABLE public.programs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON public.programs;
DROP POLICY IF EXISTS app_read ON public.programs;
DROP POLICY IF EXISTS app_write ON public.programs;
DROP POLICY IF EXISTS programs_select ON public.programs;
DROP POLICY IF EXISTS programs_insert ON public.programs;
DROP POLICY IF EXISTS programs_update ON public.programs;
DROP POLICY IF EXISTS programs_delete ON public.programs;

CREATE POLICY programs_select ON public.programs
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin','vice','teacher'));

CREATE POLICY programs_insert ON public.programs
  FOR INSERT TO authenticated
  WITH CHECK (public.current_app_role() IN ('admin','vice'));

CREATE POLICY programs_update ON public.programs
  FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin','vice'))
  WITH CHECK (public.current_app_role() IN ('admin','vice'));

-- الحذف للمديرة فقط (يطابق صلاحيات الواجهة للوكيلة: بدون حذف)
CREATE POLICY programs_delete ON public.programs
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- ------------------------------------------------------------
-- 3) program_indicators — teacher: SELECT فقط (لا is_completed)
-- ------------------------------------------------------------
ALTER TABLE public.program_indicators ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON public.program_indicators;
DROP POLICY IF EXISTS app_read ON public.program_indicators;
DROP POLICY IF EXISTS app_write ON public.program_indicators;
DROP POLICY IF EXISTS indicators_select ON public.program_indicators;
DROP POLICY IF EXISTS indicators_insert ON public.program_indicators;
DROP POLICY IF EXISTS indicators_update ON public.program_indicators;
DROP POLICY IF EXISTS indicators_delete ON public.program_indicators;

CREATE POLICY indicators_select ON public.program_indicators
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin','vice','teacher'));

CREATE POLICY indicators_insert ON public.program_indicators
  FOR INSERT TO authenticated
  WITH CHECK (public.current_app_role() IN ('admin','vice'));

CREATE POLICY indicators_update ON public.program_indicators
  FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin','vice'))
  WITH CHECK (public.current_app_role() IN ('admin','vice'));

CREATE POLICY indicators_delete ON public.program_indicators
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- ------------------------------------------------------------
-- 4) evidences — teacher: SELECT + INSERT فقط
-- ------------------------------------------------------------
ALTER TABLE public.evidences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON public.evidences;
DROP POLICY IF EXISTS app_read ON public.evidences;
DROP POLICY IF EXISTS app_write ON public.evidences;
DROP POLICY IF EXISTS evidences_select ON public.evidences;
DROP POLICY IF EXISTS evidences_insert ON public.evidences;
DROP POLICY IF EXISTS evidences_update ON public.evidences;
DROP POLICY IF EXISTS evidences_delete ON public.evidences;

CREATE POLICY evidences_select ON public.evidences
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin','vice','teacher'));

CREATE POLICY evidences_insert ON public.evidences
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_app_role() IN ('admin','vice','teacher')
    AND created_by = auth.uid()
  );

-- المعلمة ممنوعة من UPDATE؛ الوكيلة والمديرة فقط
CREATE POLICY evidences_update ON public.evidences
  FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin','vice'))
  WITH CHECK (public.current_app_role() IN ('admin','vice'));

-- الحذف للمديرة فقط (الوكيلة بدون حذف شواهد في الواجهة الحالية)
CREATE POLICY evidences_delete ON public.evidences
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- ------------------------------------------------------------
-- 5) initiatives
-- ------------------------------------------------------------
ALTER TABLE public.initiatives ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON public.initiatives;
DROP POLICY IF EXISTS app_read ON public.initiatives;
DROP POLICY IF EXISTS app_write ON public.initiatives;
DROP POLICY IF EXISTS initiatives_select ON public.initiatives;
DROP POLICY IF EXISTS initiatives_insert ON public.initiatives;
DROP POLICY IF EXISTS initiatives_update ON public.initiatives;
DROP POLICY IF EXISTS initiatives_write ON public.initiatives;
DROP POLICY IF EXISTS initiatives_delete ON public.initiatives;

-- المعلمة لا ترى قسم المبادرات → لا SELECT لها
CREATE POLICY initiatives_select ON public.initiatives
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin','vice'));

CREATE POLICY initiatives_insert ON public.initiatives
  FOR INSERT TO authenticated
  WITH CHECK (public.current_app_role() IN ('admin','vice'));

CREATE POLICY initiatives_update ON public.initiatives
  FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin','vice'))
  WITH CHECK (public.current_app_role() IN ('admin','vice'));

CREATE POLICY initiatives_delete ON public.initiatives
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- ------------------------------------------------------------
-- 6) tasks
-- ------------------------------------------------------------
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON public.tasks;
DROP POLICY IF EXISTS app_read ON public.tasks;
DROP POLICY IF EXISTS app_write ON public.tasks;
DROP POLICY IF EXISTS tasks_select ON public.tasks;
DROP POLICY IF EXISTS tasks_insert ON public.tasks;
DROP POLICY IF EXISTS tasks_update ON public.tasks;
DROP POLICY IF EXISTS tasks_delete ON public.tasks;

CREATE POLICY tasks_select ON public.tasks
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin','vice'));

CREATE POLICY tasks_insert ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (public.current_app_role() IN ('admin','vice'));

CREATE POLICY tasks_update ON public.tasks
  FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin','vice'))
  WITH CHECK (public.current_app_role() IN ('admin','vice'));

CREATE POLICY tasks_delete ON public.tasks
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- ------------------------------------------------------------
-- 7) settings — قراءة للأدوار الظاهرة؛ كتابة admin فقط
-- ------------------------------------------------------------
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON public.settings;
DROP POLICY IF EXISTS app_read ON public.settings;
DROP POLICY IF EXISTS app_write ON public.settings;
DROP POLICY IF EXISTS settings_select ON public.settings;
DROP POLICY IF EXISTS settings_write ON public.settings;
DROP POLICY IF EXISTS settings_update ON public.settings;
DROP POLICY IF EXISTS settings_insert ON public.settings;
DROP POLICY IF EXISTS settings_delete ON public.settings;

CREATE POLICY settings_select ON public.settings
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin','vice','teacher'));

CREATE POLICY settings_update ON public.settings
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY settings_insert ON public.settings
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY settings_delete ON public.settings
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- ------------------------------------------------------------
-- 8) teacher_followups — المعلمة بلا وصول
-- ------------------------------------------------------------
ALTER TABLE public.teacher_followups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON public.teacher_followups;
DROP POLICY IF EXISTS app_read ON public.teacher_followups;
DROP POLICY IF EXISTS app_write ON public.teacher_followups;
DROP POLICY IF EXISTS tf_select ON public.teacher_followups;
DROP POLICY IF EXISTS tf_insert ON public.teacher_followups;
DROP POLICY IF EXISTS tf_update ON public.teacher_followups;
DROP POLICY IF EXISTS tf_delete ON public.teacher_followups;

CREATE POLICY tf_select ON public.teacher_followups
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin','vice'));

CREATE POLICY tf_insert ON public.teacher_followups
  FOR INSERT TO authenticated
  WITH CHECK (public.current_app_role() IN ('admin','vice'));

CREATE POLICY tf_update ON public.teacher_followups
  FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin','vice'))
  WITH CHECK (public.current_app_role() IN ('admin','vice'));

CREATE POLICY tf_delete ON public.teacher_followups
  FOR DELETE TO authenticated
  USING (public.current_app_role() IN ('admin','vice'));

-- ------------------------------------------------------------
-- 9) school_years — قراءة للأدوار؛ كتابة admin
-- ------------------------------------------------------------
ALTER TABLE public.school_years ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON public.school_years;
DROP POLICY IF EXISTS app_read ON public.school_years;
DROP POLICY IF EXISTS app_write ON public.school_years;
DROP POLICY IF EXISTS sy_select ON public.school_years;
DROP POLICY IF EXISTS sy_write ON public.school_years;
DROP POLICY IF EXISTS sy_insert ON public.school_years;
DROP POLICY IF EXISTS sy_update ON public.school_years;
DROP POLICY IF EXISTS sy_delete ON public.school_years;

CREATE POLICY sy_select ON public.school_years
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin','vice','teacher'));

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

COMMIT;

-- POSTCHECK
-- SET ROLE anon; SELECT * FROM public.programs; -- يجب أن يفشل
-- كـ teacher: UPDATE program_indicators SET is_completed = true; -- يجب أن يفشل
-- كـ teacher: UPDATE evidences ...; -- يجب أن يفشل

-- ROLLBACK (يدوي — يعيد سياسات مفتوحة مؤقتاً فقط بعد موافقة)
-- لا تستخدم USING(true) في الإنتاج.
-- لإرجاع الوصول التشغيلي الطارئ راجع نسخة احتياطية قبل الـ cutover.
-- public.users يبقى موجوداً؛ يمكن لاحقاً: ALTER TABLE public.users RENAME TO users_legacy;
