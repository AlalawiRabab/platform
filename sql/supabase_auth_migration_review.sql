-- ============================================================
-- supabase_auth_migration_review.sql
-- DEPRECATED للمراجعة الجديدة — استُبدل بالملفات:
--   sql/phase_auth_foundation_review.sql
--   sql/phase_rls_cutover_review.sql
--   sql/phase_storage_private_review.sql
-- لا يُنفَّذ هذا الملف.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 0) مساعدات الدور الموثوق (من DB فقط — ليس من الواجهة)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_app_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.role
  FROM public.profiles p
  WHERE p.id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role IN ('admin','vice')
  );
$$;

REVOKE ALL ON FUNCTION public.current_app_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_app_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated;

-- ------------------------------------------------------------
-- 1) جدول profiles
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  username text UNIQUE,
  role text NOT NULL CHECK (role IN ('admin','vice','teacher')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profiles_role_idx ON public.profiles(role);

CREATE OR REPLACE FUNCTION public.set_profiles_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_profiles_updated_at();

-- منع المستخدم من تغيير دوره عبر UPDATE مباشر
CREATE OR REPLACE FUNCTION public.prevent_profile_role_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'role_change_forbidden';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'profile_id_immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_profile_role_escalation ON public.profiles;
CREATE TRIGGER trg_prevent_profile_role_escalation
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_profile_role_escalation();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_select ON public.profiles;
DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
DROP POLICY IF EXISTS profiles_admin_all ON public.profiles;

-- المستخدم يقرأ ملفه؛ المديرة تقرأ الجميع
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_admin());

-- المستخدم يحدّث اسمه/username فقط (الدور محمي بالـ trigger)
CREATE POLICY profiles_update_self ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.is_admin())
  WITH CHECK (id = auth.uid() OR public.is_admin());

-- إدراج profiles يتم عبر Edge Function (service role) أو لوحة التحكم
-- لا سياسة INSERT لـ authenticated/anon

-- ------------------------------------------------------------
-- 2) أعمدة ملكية لازمة لسيا المعلمة (بدون حذف بيانات)
-- ------------------------------------------------------------
ALTER TABLE public.evidences
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.teacher_followups
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.programs
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS evidences_created_by_idx ON public.evidences(created_by);
CREATE INDEX IF NOT EXISTS teacher_followups_owner_id_idx ON public.teacher_followups(owner_id);

-- ------------------------------------------------------------
-- 3) إغلاق public.users القديم عن الوصول المباشر
--    (الجدول يبقى موجوداً حتى نجاح Auth والاختبارات)
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

REVOKE ALL ON TABLE public.users FROM anon, authenticated;

-- سحب دوال الدخول القديمة عن anon إن وُجدت
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='authenticate_user'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.authenticate_user(text, text) FROM PUBLIC, anon, authenticated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='get_user_by_id'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.get_user_by_id(uuid, text) FROM PUBLIC, anon, authenticated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='admin_add_user'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.admin_add_user(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='admin_delete_user'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.admin_delete_user(uuid, text, uuid) FROM PUBLIC, anon, authenticated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='admin_change_role'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.admin_change_role(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='admin_list_users'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.admin_list_users(uuid, text) FROM PUBLIC, anon, authenticated';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4) RLS للجداول التشغيلية — بلا USING(true)
-- ------------------------------------------------------------

-- programs
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

CREATE POLICY programs_delete ON public.programs
  FOR DELETE TO authenticated
  USING (public.current_app_role() IN ('admin','vice'));

-- program_indicators
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

-- المعلمة تحدّث الإنجاز فقط؛ admin/vice يحدّثون بالكامل
CREATE POLICY indicators_update ON public.program_indicators
  FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin','vice','teacher'))
  WITH CHECK (public.current_app_role() IN ('admin','vice','teacher'));

CREATE POLICY indicators_delete ON public.program_indicators
  FOR DELETE TO authenticated
  USING (public.current_app_role() IN ('admin','vice'));

-- evidences
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
  USING (
    public.current_app_role() IN ('admin','vice')
    OR created_by = auth.uid()
    OR public.current_app_role() = 'teacher' -- قراءة الشواهد المرتبطة بالعمل المدرسي للمعلمة
  );

CREATE POLICY evidences_insert ON public.evidences
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_app_role() IN ('admin','vice','teacher')
    AND created_by = auth.uid()
  );

CREATE POLICY evidences_update ON public.evidences
  FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR (public.current_app_role() = 'vice')
    OR (public.current_app_role() = 'teacher' AND created_by = auth.uid())
  )
  WITH CHECK (
    public.is_admin()
    OR (public.current_app_role() = 'vice')
    OR (public.current_app_role() = 'teacher' AND created_by = auth.uid())
  );

CREATE POLICY evidences_delete ON public.evidences
  FOR DELETE TO authenticated
  USING (public.is_admin() OR public.current_app_role() = 'vice');

-- initiatives
ALTER TABLE public.initiatives ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON public.initiatives;
DROP POLICY IF EXISTS app_read ON public.initiatives;
DROP POLICY IF EXISTS app_write ON public.initiatives;
DROP POLICY IF EXISTS initiatives_select ON public.initiatives;
DROP POLICY IF EXISTS initiatives_write ON public.initiatives;
DROP POLICY IF EXISTS initiatives_delete ON public.initiatives;

CREATE POLICY initiatives_select ON public.initiatives
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin','vice','teacher'));

CREATE POLICY initiatives_insert ON public.initiatives
  FOR INSERT TO authenticated
  WITH CHECK (public.current_app_role() IN ('admin','vice'));

CREATE POLICY initiatives_update ON public.initiatives
  FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin','vice'))
  WITH CHECK (public.current_app_role() IN ('admin','vice'));

CREATE POLICY initiatives_delete ON public.initiatives
  FOR DELETE TO authenticated
  USING (public.current_app_role() IN ('admin','vice'));

-- tasks
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
  USING (public.current_app_role() IN ('admin','vice','teacher'));

CREATE POLICY tasks_insert ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (public.current_app_role() IN ('admin','vice'));

CREATE POLICY tasks_update ON public.tasks
  FOR UPDATE TO authenticated
  USING (public.current_app_role() IN ('admin','vice'))
  WITH CHECK (public.current_app_role() IN ('admin','vice'));

CREATE POLICY tasks_delete ON public.tasks
  FOR DELETE TO authenticated
  USING (public.current_app_role() IN ('admin','vice'));

-- settings
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON public.settings;
DROP POLICY IF EXISTS app_read ON public.settings;
DROP POLICY IF EXISTS app_write ON public.settings;
DROP POLICY IF EXISTS settings_select ON public.settings;
DROP POLICY IF EXISTS settings_write ON public.settings;

CREATE POLICY settings_select ON public.settings
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin','vice','teacher'));

CREATE POLICY settings_write ON public.settings
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- teacher_followups
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
  USING (
    public.current_app_role() IN ('admin','vice')
    OR owner_id = auth.uid()
  );

CREATE POLICY tf_insert ON public.teacher_followups
  FOR INSERT TO authenticated
  WITH CHECK (
    (public.current_app_role() IN ('admin','vice'))
    OR (public.current_app_role() = 'teacher' AND owner_id = auth.uid())
  );

CREATE POLICY tf_update ON public.teacher_followups
  FOR UPDATE TO authenticated
  USING (
    public.current_app_role() IN ('admin','vice')
    OR (public.current_app_role() = 'teacher' AND owner_id = auth.uid())
  )
  WITH CHECK (
    public.current_app_role() IN ('admin','vice')
    OR (public.current_app_role() = 'teacher' AND owner_id = auth.uid())
  );

CREATE POLICY tf_delete ON public.teacher_followups
  FOR DELETE TO authenticated
  USING (public.current_app_role() IN ('admin','vice'));

-- school_years
ALTER TABLE public.school_years ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON public.school_years;
DROP POLICY IF EXISTS app_read ON public.school_years;
DROP POLICY IF EXISTS app_write ON public.school_years;
DROP POLICY IF EXISTS sy_select ON public.school_years;
DROP POLICY IF EXISTS sy_write ON public.school_years;

CREATE POLICY sy_select ON public.school_years
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin','vice','teacher'));

CREATE POLICY sy_write ON public.school_years
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ------------------------------------------------------------
-- 5) Storage: bucket خاص + سياسات authenticated فقط
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('evidences', 'evidences', false, 10485760)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = COALESCE(storage.buckets.file_size_limit, EXCLUDED.file_size_limit);

DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname='storage' AND tablename='objects'
      AND (policyname ILIKE '%evidence%' OR qual::text ILIKE '%evidences%' OR with_check::text ILIKE '%evidences%')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY evidences_auth_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'evidences');

CREATE POLICY evidences_auth_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'evidences' AND public.current_app_role() IN ('admin','vice','teacher'));

CREATE POLICY evidences_auth_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'evidences' AND public.current_app_role() IN ('admin','vice'))
  WITH CHECK (bucket_id = 'evidences' AND public.current_app_role() IN ('admin','vice'));

CREATE POLICY evidences_auth_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'evidences' AND public.current_app_role() IN ('admin','vice'));

-- ------------------------------------------------------------
-- 6) خطة إلغاء public.users لاحقاً (لا تُنفَّذ هنا)
-- ------------------------------------------------------------
-- بعد نجاح Auth + إنشاء profiles لكل حساب:
-- 1) تصدير احتياطي لجدول users
-- 2) التأكد أن لا كود يعتمد يعتمد من users
-- 3) DROP TABLE public.users CASCADE;  -- يدوياً وبعد التأكيد

COMMIT;

-- POSTCHECK مقترح بعد التنفيذ اليدوي:
-- SELECT auth.uid(); -- من جلسة authenticated
-- SELECT * FROM public.profiles WHERE id = auth.uid();
-- SELECT COUNT(*) FROM public.programs; -- يجب أن يفشل بدون JWT
