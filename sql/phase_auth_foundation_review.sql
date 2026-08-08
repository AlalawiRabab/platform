-- ============================================================
-- phase_auth_foundation_review.sql
-- مراجعة فقط — لا يُنفَّذ تلقائياً
-- ============================================================
-- المرحلة 1: profiles + أعمدة الملكية + دوال الدور الآمنة
-- لا يغلق public.users
-- لا يغيّر سياسات الجداول التشغيلية
-- لا يحذف بيانات
-- ============================================================

-- PRECHECK
-- SELECT to_regclass('public.profiles') IS NULL AS profiles_missing;
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='evidences';

BEGIN;

-- ------------------------------------------------------------
-- 1) جدول profiles أولاً (قبل أي دالة تقرأه)
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
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_profiles_updated_at();

-- إزالة trigger تصعيد الدور القديم إن وُجد (قد يمنع Edge Function)
DROP TRIGGER IF EXISTS trg_prevent_profile_role_escalation ON public.profiles;
DROP FUNCTION IF EXISTS public.prevent_profile_role_escalation();

-- ------------------------------------------------------------
-- 2) أعمدة ملكية للشواهد الجديدة (بدون backfill)
-- ------------------------------------------------------------
-- إذا كان created_by موجوداً كـ text (تنفيذ يدوي سابق)، حوّله بأمان إلى uuid
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'evidences'
    AND column_name = 'created_by';

  IF col_type IS NULL THEN
    ALTER TABLE public.evidences
      ADD COLUMN created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
  ELSIF col_type IN ('text', 'character varying') THEN
    BEGIN
      ALTER TABLE public.evidences DROP CONSTRAINT IF EXISTS evidences_created_by_fkey;
    EXCEPTION WHEN undefined_object THEN
      NULL;
    END;
    ALTER TABLE public.evidences
      ALTER COLUMN created_by TYPE uuid
      USING (
        CASE
          WHEN created_by IS NULL OR btrim(created_by::text) = '' THEN NULL
          WHEN created_by::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN created_by::text::uuid
          ELSE NULL
        END
      );
    ALTER TABLE public.evidences
      DROP CONSTRAINT IF EXISTS evidences_created_by_fkey;
    ALTER TABLE public.evidences
      ADD CONSTRAINT evidences_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.evidences
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

ALTER TABLE public.programs
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.teacher_followups
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS evidences_created_by_idx ON public.evidences(created_by);

-- ضبط created_by من الجلسة الموثوقة عند الإدراج (لا تعتمد على الواجهة وحدها)
CREATE OR REPLACE FUNCTION public.set_evidence_created_by()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.created_by IS NULL THEN
    NEW.created_by := auth.uid();
  END IF;
  IF NEW.created_by IS DISTINCT FROM auth.uid() AND auth.uid() IS NOT NULL THEN
    -- المستخدم العادي لا يزوّر المالك؛ service_role يتجاوز RLS لاحقاً فقط
    IF auth.role() = 'authenticated' THEN
      NEW.created_by := auth.uid();
    END IF;
  END IF;
  IF NEW.created_at IS NULL THEN
    NEW.created_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_evidence_created_by ON public.evidences;
CREATE TRIGGER trg_set_evidence_created_by
  BEFORE INSERT ON public.evidences
  FOR EACH ROW EXECUTE FUNCTION public.set_evidence_created_by();

-- ------------------------------------------------------------
-- 3) دوال الدور (بعد وجود profiles)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_app_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.role
  FROM public.profiles AS p
  WHERE p.id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles AS p
    WHERE p.id = auth.uid()
      AND p.role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles AS p
    WHERE p.id = auth.uid()
      AND p.role IN ('admin', 'vice')
  );
$$;

REVOKE ALL ON FUNCTION public.current_app_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_staff() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_evidence_created_by() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_profiles_updated_at() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.current_app_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated;

-- ------------------------------------------------------------
-- 4) RLS + Column Privileges على profiles
-- ------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_select ON public.profiles;
DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
DROP POLICY IF EXISTS profiles_admin_all ON public.profiles;
DROP POLICY IF EXISTS profiles_insert ON public.profiles;
DROP POLICY IF EXISTS profiles_delete ON public.profiles;

-- المستخدم يقرأ صفه؛ المديرة تقرأ الجميع
-- is_admin() SECURITY DEFINER يمنع infinite recursion مع سياسات profiles
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_admin());

-- تحديث الصف مسموح لصاحب الحساب أو admin؛ الأعمدة محمية بـ GRANT عمودي
CREATE POLICY profiles_update_self ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.is_admin())
  WITH CHECK (id = auth.uid() OR public.is_admin());

-- لا INSERT/DELETE لـ authenticated (Edge Function / Dashboard فقط)

REVOKE ALL ON TABLE public.profiles FROM anon;
REVOKE ALL ON TABLE public.profiles FROM authenticated;
GRANT SELECT ON TABLE public.profiles TO authenticated;
GRANT UPDATE (name, username) ON TABLE public.profiles TO authenticated;
-- لا GRANT على role أو id لـ authenticated

COMMIT;

-- POSTCHECK
-- SELECT public.current_app_role(); -- من جلسة authenticated بعد إنشاء profile
-- SELECT column_name FROM information_schema.column_privileges
--  WHERE table_name='profiles' AND grantee='authenticated';

-- ROLLBACK (يدوي عند الحاجة)
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_set_evidence_created_by ON public.evidences;
-- DROP FUNCTION IF EXISTS public.set_evidence_created_by();
-- DROP POLICY IF EXISTS profiles_select ON public.profiles;
-- DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
-- DROP FUNCTION IF EXISTS public.current_app_role();
-- DROP FUNCTION IF EXISTS public.is_admin();
-- DROP FUNCTION IF EXISTS public.is_staff();
-- -- لا تحذف public.profiles إن وُجدت حسابات مرتبطة إلا بعد مراجعة
-- COMMIT;
