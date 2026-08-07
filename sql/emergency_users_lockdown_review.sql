-- ============================================================
-- emergency_users_lockdown_review.sql
-- للمراجعة فقط — لا يُنفَّذ تلقائياً
-- ============================================================
-- الهدف (طارئ):
-- 1) منع القراءة/الكتابة المباشرة على public.users عبر anon
-- 2) الإبقاء على تسجيل الدخول عبر authenticate_user فقط
-- 3) عدم إعادة عمود password مطلقاً من الدوال
-- 4) منع تغيير role إلا عبر admin_change_role
--
-- تحذير مهم جداً:
-- نفّذ أقسام PRECHECK و STEP A أولاً، واختبر تسجيل الدخول من الواجهة
-- قبل STEP B (users_deny_all). إن توقف الدخول، استخدم ROLLBACK.
-- ============================================================

-- ------------------------------------------------------------
-- PRECHECK — أوامر فحص قبل التنفيذ
-- ------------------------------------------------------------
-- 1) هل الدالة موجودة؟
SELECT n.nspname AS schema, p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef AS is_security_definer
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'authenticate_user','get_user_by_id',
     'admin_list_users','admin_add_user',
     'admin_delete_user','admin_change_role'
   )
 ORDER BY p.proname;

-- 2) هل يمكن لـ anon تنفيذ authenticate_user؟
SELECT grantee, privilege_type
  FROM information_schema.routine_privileges
 WHERE routine_schema = 'public'
   AND routine_name = 'authenticate_user';

-- 3) هل RLS مفعّل على users؟
SELECT relname, relrowsecurity
  FROM pg_class
 WHERE relname = 'users';

-- 4) السياسات الحالية على users
SELECT policyname, cmd, roles, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'users';

-- 5) اختبار دخولي يدوي (استبدل القيم مؤقتاً في SQL Editor فقط — لا تحفظ أسراراً في Git)
-- SELECT * FROM public.authenticate_user('<LOGIN_ID>', '<PASSWORD>');
-- يجب أن تُرجع: id, name, email, role فقط — بلا password.

-- ============================================================
-- STEP A — إعادة نشر دوال آمنة (قبل إغلاق الجدول)
-- ============================================================

CREATE OR REPLACE FUNCTION public.authenticate_user(p_email text, p_password text)
RETURNS TABLE(id uuid, name text, email text, role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_email IS NULL OR p_password IS NULL
     OR length(trim(p_email)) < 3 OR length(p_email) > 254
     OR length(p_password) < 4 OR length(p_password) > 128 THEN
    RETURN;
  END IF;

  -- مقارنة نصية مؤقتة للحفاظ على النظام الحالي
  -- (الانتقال إلى hash / Supabase Auth في مرحلة مستقلة)
  RETURN QUERY
  SELECT u.id, u.name, u.email, u.role
  FROM public.users u
  WHERE lower(u.email) = lower(trim(p_email))
    AND u.password = p_password
    AND u.role IN ('admin','vice','teacher')
  LIMIT 1;
END;
$$;

-- تعطيل استعادة الجلسة بـ id/email من الواجهة: لا نمنح get_user_by_id لـ anon
CREATE OR REPLACE FUNCTION public.get_user_by_id(p_id uuid, p_email text)
RETURNS TABLE(id uuid, name text, email text, role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- تُبقى للدعم الداخلي فقط؛ يُفضّل عدم منحها لـ anon بعد الطوارئ
  RETURN QUERY
  SELECT u.id, u.name, u.email, u.role
  FROM public.users u
  WHERE u.id = p_id
    AND lower(u.email) = lower(trim(p_email))
    AND u.role IN ('admin','vice','teacher')
  LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_list_users(p_admin_id uuid, p_admin_email text)
RETURNS TABLE(id uuid, name text, email text, role text, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users a
    WHERE a.id = p_admin_id
      AND lower(a.email) = lower(trim(p_admin_email))
      AND a.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  RETURN QUERY
  SELECT u.id, u.name, u.email, u.role, u.created_at
  FROM public.users u
  ORDER BY u.created_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_add_user(
  p_admin_id uuid, p_admin_email text,
  p_name text, p_email text, p_password text, p_role text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users a
    WHERE a.id = p_admin_id
      AND lower(a.email) = lower(trim(p_admin_email))
      AND a.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  IF p_role IS NULL OR p_role NOT IN ('admin','vice','teacher') THEN
    RAISE EXCEPTION 'invalid_role';
  END IF;

  IF p_name IS NULL OR length(trim(p_name)) < 2 OR length(p_name) > 200 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;

  IF p_email IS NULL OR length(trim(p_email)) < 3 THEN
    RAISE EXCEPTION 'invalid_email';
  END IF;

  IF p_password IS NULL OR length(p_password) < 4 OR length(p_password) > 128 THEN
    RAISE EXCEPTION 'invalid_password';
  END IF;

  INSERT INTO public.users (name, email, password, role)
  VALUES (trim(p_name), lower(trim(p_email)), p_password, p_role)
  RETURNING users.id INTO new_id;

  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_user(
  p_admin_id uuid, p_admin_email text, p_target_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users a
    WHERE a.id = p_admin_id
      AND lower(a.email) = lower(trim(p_admin_email))
      AND a.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  IF p_target_id = p_admin_id THEN
    RAISE EXCEPTION 'cannot_delete_self';
  END IF;

  DELETE FROM public.users WHERE id = p_target_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_change_role(
  p_admin_id uuid, p_admin_email text, p_target_id uuid, p_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users a
    WHERE a.id = p_admin_id
      AND lower(a.email) = lower(trim(p_admin_email))
      AND a.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  IF p_role IS NULL OR p_role NOT IN ('admin','vice','teacher') THEN
    RAISE EXCEPTION 'invalid_role';
  END IF;

  IF p_target_id = p_admin_id THEN
    RAISE EXCEPTION 'cannot_change_own_role';
  END IF;

  UPDATE public.users SET role = p_role WHERE id = p_target_id;
END;
$$;

-- صلاحيات التنفيذ
GRANT EXECUTE ON FUNCTION public.authenticate_user(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_users(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_add_user(uuid, text, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid, text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_change_role(uuid, text, uuid, text) TO anon, authenticated;

-- منع تجاوز الجلسة عبر get_user_by_id من الواجهة
REVOKE ALL ON FUNCTION public.get_user_by_id(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_user_by_id(uuid, text) FROM anon, authenticated;

-- >>> توقف هنا واختبر تسجيل الدخول من الواجهة قبل STEP B <<<

-- ============================================================
-- STEP B — إغلاق الوصول المباشر لجدول users
-- نفّذ فقط بعد نجاح تسجيل الدخول عبر authenticate_user
-- ============================================================

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS allow_all ON public.users;
DROP POLICY IF EXISTS app_read ON public.users;
DROP POLICY IF EXISTS app_write ON public.users;
DROP POLICY IF EXISTS users_deny_all ON public.users;

CREATE POLICY users_deny_all ON public.users
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- سحب صلاحيات الجدول المباشرة إن وُجدت (الدوال SECURITY DEFINER تتجاوز RLS كمالك)
REVOKE ALL ON TABLE public.users FROM anon, authenticated;

-- ============================================================
-- POSTCHECK — تحقق بعد التنفيذ
-- ============================================================
-- A) الدخول عبر الدالة ما زال يعمل:
-- SELECT id, name, email, role FROM public.authenticate_user('<LOGIN_ID>', '<PASSWORD>');

-- B) القراءة المباشرة يجب أن تفشل/ترجع صفراً لـ anon:
-- (من PostgREST / REST بـ anon key)
-- GET /rest/v1/users?select=id,email,password

-- C) تحديث الدور المباشر يجب أن يُرفض:
-- PATCH /rest/v1/users?id=eq.<uuid>  {"role":"admin"}

-- D) السياسات:
SELECT policyname, cmd, roles, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'users';

-- ============================================================
-- ROLLBACK — إذا توقف تسجيل الدخول
-- ============================================================
-- 1) أعد فتح قراءة محدودة مؤقتاً للطوارئ فقط (أقصر وقت ممكن):
-- DROP POLICY IF EXISTS users_deny_all ON public.users;
-- CREATE POLICY users_temp_read ON public.users
--   FOR SELECT TO anon USING (true);
-- GRANT SELECT ON TABLE public.users TO anon;
--
-- 2) أو أعد نشر authenticate_user من STEP A وتأكد GRANT EXECUTE لـ anon.
--
-- 3) لا تُبقِ سياسة القراءة المؤقتة؛ أعد STEP B فوراً بعد إصلاح الدخول.
--
-- 4) الواجهة يجب أن تبقى على RPC فقط (بدون .eq('password')).
