-- ============================================================
-- supabase-security.sql
-- نفّذ هذا الملف في Supabase SQL Editor بعد إنشاء الجداول.
-- يشدّد أمان جدول users ويمنع قراءة كلمات المرور مباشرة،
-- ويستبدل سياسة allow_all الخطرة بسيا أكثر أماناً.
-- ============================================================

-- ① دوال المصادقة (SECURITY DEFINER — تعمل بصلاحيات المالك)
CREATE OR REPLACE FUNCTION public.authenticate_user(p_email text, p_password text)
RETURNS TABLE(id uuid, name text, email text, role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_email IS NULL OR p_password IS NULL
     OR length(p_email) < 3 OR length(p_email) > 254
     OR length(p_password) < 4 OR length(p_password) > 128 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT u.id, u.name, u.email, u.role
  FROM public.users u
  WHERE lower(u.email) = lower(trim(p_email))
    AND u.password = p_password
    AND u.role IN ('admin','vice','teacher')
  LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_user_by_id(p_id uuid, p_email text)
RETURNS TABLE(id uuid, name text, email text, role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
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

  IF p_email IS NULL OR p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
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

-- ② صلاحيات التنفيذ للـ anon فقط على الدوال
GRANT EXECUTE ON FUNCTION public.authenticate_user(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_by_id(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_users(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_add_user(uuid, text, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid, text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_change_role(uuid, text, uuid, text) TO anon, authenticated;

-- ③ إغلاق الوصول المباشر لجدول users (كلمات المرور + تصعيد الصلاحيات)
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS allow_all ON public.users;
DROP POLICY IF EXISTS users_deny_all ON public.users;

-- منع أي وصول مباشر عبر PostgREST (القراءة/الكتابة عبر الدوال فقط)
CREATE POLICY users_deny_all ON public.users
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- ④ إزالة allow_all من الجداول الأخرى واستبدالها بسيا قراءة/كتابة محدودة
-- ملاحظة: بدون Supabase Auth لا يمكن ربط الدور بالطلب على مستوى RLS.
-- لذلك تبقى عمليات البيانات مفتوحة للـ anon بعد تسجيل الدخول من الواجهة.
-- الحماية الحقيقية للأدوار حالياً في طبقة الواجهة + إغلاق جدول users.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'programs','program_indicators','initiatives',
    'tasks','evidences','teacher_followups','settings'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS allow_all ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS app_read ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS app_write ON %I', t);
    -- قراءة للجميع (البيانات التشغيلية المدرسية)
    EXECUTE format(
      'CREATE POLICY app_read ON %I FOR SELECT USING (true)', t
    );
    -- كتابة للجميع عبر anon — يُستحسن لاحقاً ربطها بـ auth.uid()
    EXECUTE format(
      'CREATE POLICY app_write ON %I FOR ALL USING (true) WITH CHECK (true)', t
    );
  END LOOP;
END $$;

-- ⑤ تذكير: لا تُدرج كلمات مرور حقيقية في المستودع.
-- غيّر كلمات المرور يدوياً من SQL Editor ثم انتقل إلى Supabase Auth
-- (راجع SECURITY-MIGRATION-PLAN.md).
-- UPDATE users SET password = '<NEW_STRONG_PASSWORD>' WHERE email = '<LOGIN_ID>';
