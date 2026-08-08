# AUTH-REVIEW-PACK

فرع: `security-hardening`  
حالة: تجهيز ومراجعة فقط — لم يُنفَّذ SQL، ولم تُحذف بيانات، ولم يحدث Push/Merge/نشر.

---

## 1) المحتوى الكامل — `sql/phase_auth_foundation_review.sql`

```sql
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
ALTER TABLE public.evidences
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

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
```

---

## 2) المحتوى الكامل — `sql/phase_rls_cutover_review.sql`

```sql
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
```

---

## 3) المحتوى الكامل — `sql/phase_storage_private_review.sql`

```sql
-- ============================================================
-- phase_storage_private_review.sql
-- مراجعة فقط — لا يُنفَّذ تلقائياً
-- ============================================================
-- المرحلة 3: bucket evidences خاص + سياسات Storage
-- لا يحذف الملفات القديمة التجريبية
-- ============================================================

-- PRECHECK
-- SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id='evidences';
-- SELECT COUNT(*) FROM storage.objects WHERE bucket_id='evidences';

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'evidences',
  'evidences',
  false,
  10485760,
  ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = 10485760,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- إسقاط سياسات evidences السابقة فقط (قابلة لإعادة التشغيل)
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND (
        policyname ILIKE '%evidence%'
        OR policyname IN (
          'evidences_auth_select','evidences_auth_insert',
          'evidences_auth_update','evidences_auth_delete',
          'evidences_select','evidences_insert','evidences_update','evidences_delete'
        )
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', pol.policyname);
  END LOOP;
END $$;

-- قراءة للمستخدمين المسجلين ذوي دور صالح
CREATE POLICY evidences_auth_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'evidences'
    AND public.current_app_role() IN ('admin','vice','teacher')
  );

-- رفع:
-- admin/vice: أي مسار داخل evidences
-- teacher: فقط داخل مجلد auth.uid()/
CREATE POLICY evidences_auth_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'evidences'
    AND (
      public.current_app_role() IN ('admin','vice')
      OR (
        public.current_app_role() = 'teacher'
        AND (storage.foldername(name))[1] = auth.uid()::text
      )
    )
  );

-- تعديل/نقل/استبدال: المديرة فقط (لا للمعلمة ولا توسيع بلا حاجة للوكيلة)
CREATE POLICY evidences_auth_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'evidences'
    AND public.is_admin()
  )
  WITH CHECK (
    bucket_id = 'evidences'
    AND public.is_admin()
  );

-- حذف ملفات: المديرة فقط
CREATE POLICY evidences_auth_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'evidences'
    AND public.is_admin()
  );

-- anon بلا سياسات على هذا الـ bucket → مرفوض

COMMIT;

-- POSTCHECK
-- SELECT public FROM storage.buckets WHERE id='evidences'; -- false
-- كـ anon: download/list يجب أن يفشل
-- كـ teacher: upload خارج مجلدها يجب أن يفشل
-- كـ teacher: update/delete يجب أن يفشل

-- ROLLBACK (يدوي بعد موافقة — لا يُنفَّذ تلقائياً)
-- BEGIN;
-- DROP POLICY IF EXISTS evidences_auth_select ON storage.objects;
-- DROP POLICY IF EXISTS evidences_auth_insert ON storage.objects;
-- DROP POLICY IF EXISTS evidences_auth_update ON storage.objects;
-- DROP POLICY IF EXISTS evidences_auth_delete ON storage.objects;
-- UPDATE storage.buckets SET public = true WHERE id = 'evidences'; -- طارئ فقط
-- COMMIT;
-- ملاحظة: إعادة Public تكسر نموذج Signed URL ويجب تجنبها بعد النشر.
```

---

## 4) المحتوى الكامل — `supabase/functions/admin-users/index.ts`

```typescript
// Supabase Edge Function: admin-users
 // مراجعة فقط — لا تُنشر تلقائياً
 // Secrets:
 //   SUPABASE_URL
 //   SUPABASE_ANON_KEY
 //   SUPABASE_SERVICE_ROLE_KEY  ← فقط في Secrets
 //   ALLOWED_ORIGINS           ← قائمة مفصولة بفواصل، بدون تخمين رابط الإنتاج

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

const ALLOWED_METHODS = new Set(['POST', 'OPTIONS'])

function parseAllowedOrigins(): string[] {
  const raw = Deno.env.get('ALLOWED_ORIGINS') ?? ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function corsHeadersFor(req: Request): Record<string, string> {
  const allowed = parseAllowedOrigins()
  const origin = req.headers.get('Origin') || ''
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

function json(req: Request, payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
  })
}

function isStrongPassword(password: string): boolean {
  if (password.length < 8 || password.length > 128) return false
  const hasLetter = /[A-Za-z\u0600-\u06FF]/.test(password)
  const hasNumber = /\d/.test(password)
  return hasLetter && hasNumber
}

Deno.serve(async (req) => {
  const headers = corsHeadersFor(req)

  if (!ALLOWED_METHODS.has(req.method)) {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...headers, 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' },
    })
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    if (!supabaseUrl || !anonKey || !serviceKey) {
      return json(req, { error: 'operation_failed' }, 500)
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json(req, { error: 'unauthorized' }, 401)

    // 1) تحقق JWT أولاً بمفتاح anon + توكن المستدعي
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData?.user?.id) return json(req, { error: 'unauthorized' }, 401)

    const callerId = userData.user.id

    // 2) قراءة profile للمستدعي الموثوق (ليس role من الواجهة)
    const { data: callerProfile, error: callerProfileErr } = await userClient
      .from('profiles')
      .select('id,role')
      .eq('id', callerId)
      .maybeSingle()

    if (callerProfileErr || !callerProfile || callerProfile.role !== 'admin') {
      return json(req, { error: 'forbidden' }, 403)
    }

    // 3) بعد تأكيد admin فقط: استخدم service_role
    const admin = createClient(supabaseUrl, serviceKey)

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return json(req, { error: 'invalid_payload' }, 400)
    const action = String((body as { action?: string }).action || '')

    if (action === 'list') {
      const { data: profiles, error } = await admin
        .from('profiles')
        .select('id,name,username,role,created_at')
        .order('created_at', { ascending: true })
      if (error) return json(req, { error: 'operation_failed' }, 400)

      const { data: authList, error: authErr } = await admin.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      })
      if (authErr) return json(req, { error: 'operation_failed' }, 400)

      const emailById = new Map((authList?.users || []).map((u) => [u.id, u.email || '']))
      const users = (profiles || []).map((p) => ({
        id: p.id,
        name: p.name,
        username: p.username,
        role: p.role,
        created_at: p.created_at,
        email: emailById.get(p.id) || '',
      }))
      return json(req, { users })
    }

    if (action === 'create') {
      const email = String((body as { email?: string }).email || '').trim().toLowerCase()
      const password = String((body as { password?: string }).password || '')
      const name = String((body as { name?: string }).name || '').trim()
      const usernameRaw = (body as { username?: string }).username
      const username = usernameRaw ? String(usernameRaw).trim() : null
      const role = String((body as { role?: string }).role || '')

      if (!email || !name || !['admin', 'vice', 'teacher'].includes(role)) {
        return json(req, { error: 'invalid_payload' }, 400)
      }
      if (!isStrongPassword(password)) return json(req, { error: 'invalid_payload' }, 400)

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })
      if (createErr || !created?.user) return json(req, { error: 'operation_failed' }, 400)

      const { error: profileInsertErr } = await admin.from('profiles').insert({
        id: created.user.id,
        name,
        username,
        role,
      })
      if (profileInsertErr) {
        await admin.auth.admin.deleteUser(created.user.id)
        return json(req, { error: 'operation_failed' }, 400)
      }

      // لا تُعاد كلمة المرور
      return json(req, { id: created.user.id, email, name, username, role })
    }

    if (action === 'change_role') {
      const targetId = String((body as { target_id?: string }).target_id || '')
      const role = String((body as { role?: string }).role || '')
      if (!targetId || !['admin', 'vice', 'teacher'].includes(role)) {
        return json(req, { error: 'invalid_payload' }, 400)
      }
      if (targetId === callerId) return json(req, { error: 'forbidden' }, 403)

      const { data: target, error: targetErr } = await admin
        .from('profiles')
        .select('id,role')
        .eq('id', targetId)
        .maybeSingle()
      if (targetErr || !target) return json(req, { error: 'invalid_payload' }, 400)

      if (target.role === 'admin' && role !== 'admin') {
        const { count, error: countErr } = await admin
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('role', 'admin')
        if (countErr || count == null) return json(req, { error: 'operation_failed' }, 400)
        if (count <= 1) return json(req, { error: 'forbidden' }, 403)
      }

      const { data: updated, error } = await admin
        .from('profiles')
        .update({ role })
        .eq('id', targetId)
        .select('id,role')
        .maybeSingle()
      if (error || !updated) return json(req, { error: 'operation_failed' }, 400)
      return json(req, { ok: true })
    }

    if (action === 'delete') {
      const targetId = String((body as { target_id?: string }).target_id || '')
      if (!targetId) return json(req, { error: 'invalid_payload' }, 400)
      if (targetId === callerId) return json(req, { error: 'forbidden' }, 403)

      const { data: target, error: targetErr } = await admin
        .from('profiles')
        .select('id,role')
        .eq('id', targetId)
        .maybeSingle()
      if (targetErr || !target) return json(req, { error: 'invalid_payload' }, 400)

      if (target.role === 'admin') {
        const { count, error: countErr } = await admin
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('role', 'admin')
        if (countErr || count == null) return json(req, { error: 'operation_failed' }, 400)
        if (count <= 1) return json(req, { error: 'forbidden' }, 403)
      }

      // احذف Auth user أولاً؛ CASCADE يحذف profile
      const { error: delAuthErr } = await admin.auth.admin.deleteUser(targetId)
      if (delAuthErr) return json(req, { error: 'operation_failed' }, 400)
      return json(req, { ok: true })
    }

    return json(req, { error: 'invalid_payload' }, 400)
  } catch (_e) {
    return json(req, { error: 'operation_failed' }, 500)
  }
})
```

---

## 5) git diff (مفاتيح مخفية)

### 5.1 `config.js`

```diff
diff --git a/config.js b/config.js
index b814647..a9d94c4 100644
--- a/config.js
+++ b/config.js
@@ -1,14 +1,9 @@
 /* ================================================================
-   config.js — إعدادات Supabase
+   config.js — إعدادات Supabase (واجهة فقط)
    ────────────────────────────────────────────────────────────────
-   ⚠️ مهم للأمان:
-   - استخدم مفتاح anon (العام) فقط هنا. وهو آمن للاستخدام في الواجهة الأمامية.
-   - لا تضع أبداً مفتاح service_role في هذا الملف أو في أي كود يصل للمتصفح،
-     لأنه يمنح صلاحيات كاملة على قاعدة البيانات ويتجاوز سياسات RLS.
-   - الحماية الفعلية تأتي من تفعيل Row Level Security (RLS) على الجداول.
-
-   احصل على القيمتين من:
-   Supabase Dashboard → Project Settings → API → Project URL + anon public key
+   - استخدم مفتاح anon / publishable فقط.
+   - لا تضع service_role هنا أبداً.
+   - الحماية الحقيقية: Supabase Auth + RLS + Edge Function Secrets.
    ================================================================ */
 
 window.SUPABASE_URL = 'https://qeabgktifyyyjrzphtpw.supabase.co';
@@ -19,10 +14,10 @@ window.supabaseClient = supabase.createClient(
   window.SUPABASE_ANON,
   {
     auth: {
-      persistSession: false,
-      autoRefreshToken: false,
-      detectSessionInUrl: false,
+      persistSession: true,
+      autoRefreshToken: true,
+      detectSessionInUrl: true,
+      storage: window.localStorage,
     },
   }
 );
-
```

### 5.2 `index.html`

```diff
diff --git a/index.html b/index.html
index 06266c6..7814c9f 100644
--- a/index.html
+++ b/index.html
@@ -35,13 +35,13 @@
     <div class="login-card">
       <h2>تسجيل الدخول</h2>
       <div class="login-field-group">
-        <label for="login-email">اسم المستخدم</label>
-        <input type="text" id="login-email" placeholder="اسم المستخدم" autocomplete="username"/>
+        <label for="login-email">البريد الإلكتروني</label>
+        <input type="email" id="login-email" placeholder="email@school.sa" autocomplete="username" dir="ltr"/>
       </div>
       <div class="login-field-group">
         <label for="login-password">كلمة المرور</label>
         <input type="password" id="login-password" placeholder="كلمة المرور" autocomplete="current-password"
-               onkeydown="if(event.key==='Enter')doLogin()"/>
+               onkeydown="if(event.key==='Enter')window.doLogin()"/>
       </div>
      <button id="login-btn" class="btn-login" onclick="window.doLogin()">دخول إلى المنصة</button>
       
@@ -642,7 +642,7 @@
   
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1"></script>
 <script src="config.js"></script>
-<script src="./script.js?v=20260807c"></script>
+<script src="./script.js?v=20260807-auth2"></script>
   
 </body>
 </html>
```

### 5.3 `script.js`

```diff
diff --git a/script.js b/script.js
index 0907585..7979349 100644
--- a/script.js
+++ b/script.js
@@ -127,18 +127,14 @@
    --   END LOOP;
    -- END $$;
 
-   -- ⑩ seed users — غيّر كلمات المرور فوراً بعد أول تشغيل
-   INSERT INTO users (name,email,password,role) VALUES
-     ('سارة العتيبي','lyla127','1277','admin'),
-     ('نورة القحطاني','vice@school.sa','ChangeMe!1234','vice'),
-     ('هند الزهراني','teacher@school.sa','ChangeMe!1234','teacher')
-   ON CONFLICT (email) DO NOTHING;
+   -- ⑩ إنشاء المستخدمين يتم عبر Supabase Auth فقط.
+   -- لا تُدرج كلمات مرور داخل هذا الملف أو أي seed في المستودع.
 
    ================================================================ */
 
 'use strict';
 
-console.log('[script.js] BUILD=20260807a school_year_id insert guard enabled');
+console.log('[script.js] BUILD=20260807-auth-teacher-perms');
 
 /* ─────────────────────────────────────────────────────────────
    §0  SUPABASE
@@ -175,31 +171,33 @@ const PERMS = {
   admin:{
     addProgram:true,editProgram:true,deleteProgram:true,
     addIndicator:true,deleteIndicator:true,toggleIndicator:true,
-    addEvidence:true,deleteEvidence:true,
+    addEvidence:true,editEvidence:true,deleteEvidence:true,
     addInitiative:true,editInitiative:true,deleteInitiative:true,
     addTask:true,editTask:true,deleteTask:true,
     addTeacher:true,editTeacher:true,deleteTeacher:true,
     viewTeacherLinks:true,addTeacherLink:true,
     editSettings:true,manageUsers:true,
   },
+  // صلاحيات الوكيلة المعتمدة سابقاً في المشروع (بدون إدارة مستخدمين/حذف)
   vice:{
     addProgram:true,editProgram:true,deleteProgram:false,
     addIndicator:true,deleteIndicator:false,toggleIndicator:true,
-    addEvidence:true,deleteEvidence:false,
+    addEvidence:true,editEvidence:true,deleteEvidence:false,
     addInitiative:true,editInitiative:true,deleteInitiative:false,
     addTask:true,editTask:true,deleteTask:false,
     addTeacher:true,editTeacher:true,deleteTeacher:true,
     viewTeacherLinks:true,addTeacherLink:true,
     editSettings:false,manageUsers:false,
   },
+  // المعلمة: مشاهدة + إرفاق شاهد فقط
   teacher:{
     addProgram:false,editProgram:false,deleteProgram:false,
-    addIndicator:false,deleteIndicator:false,toggleIndicator:true,
-    addEvidence:true,deleteEvidence:false,
+    addIndicator:false,deleteIndicator:false,toggleIndicator:false,
+    addEvidence:true,editEvidence:false,deleteEvidence:false,
     addInitiative:false,editInitiative:false,deleteInitiative:false,
     addTask:false,editTask:false,deleteTask:false,
     addTeacher:false,editTeacher:false,deleteTeacher:false,
-    viewTeacherLinks:false,addTeacherLink:true,
+    viewTeacherLinks:false,addTeacherLink:false,
     editSettings:false,manageUsers:false,
   },
 };
@@ -208,15 +206,27 @@ const can = a => currentUser ? (PERMS[currentUser.role]?.[a] === true) : false;
 const NAV_ALLOWED = {
   admin  : ['dashboard','programs','plan','kpi','tasks','reports','teachers','calendar','stats','settings','users'],
   vice   : ['dashboard','programs','plan','kpi','tasks','reports','teachers','calendar','stats'],
-  teacher: ['dashboard','programs','reports','teachers'],
+  teacher: ['dashboard','programs','reports'],
 };
 
-const SESSION_KEY = 'sop_session';
 const ALLOWED_EVIDENCE_EXT = ['pdf','jpg','jpeg','png','doc','docx','xls','xlsx'];
 const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
 const MAX_INPUT_LEN = 500;
 const VALID_ROLES = ['admin','vice','teacher'];
 const EVIDENCE_BUCKET = 'evidences';
+const SIGNED_URL_TTL_SEC = 3600;
+const ALLOWED_EVIDENCE_MIME = [
+  'application/pdf',
+  'image/jpeg',
+  'image/png',
+  'application/msword',
+  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
+  'application/vnd.ms-excel',
+  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
+];
+let _authListenerBound = false;
+let _authHandling = false;
+let _sessionBootstrapDone = false;
 
 function escapeHtml(str) {
   if (str == null) return '';
@@ -272,20 +282,10 @@ function isSectionAllowed(section) {
   return (NAV_ALLOWED[currentUser.role] || []).includes(section);
 }
 
-function saveSession(user) {
-  try {
-    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
-      id: user.id,
-      email: user.email,
-      ts: Date.now(),
-    }));
-  } catch {}
-  try { localStorage.removeItem('currentUser'); } catch {}
-}
-
-function clearSession() {
-  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
+function clearLegacySessionArtifacts() {
+  try { sessionStorage.removeItem('sop_session'); } catch {}
   try { localStorage.removeItem('currentUser'); } catch {}
+  try { sessionStorage.removeItem('currentUser'); } catch {}
 }
 
 function showAppShell() {
@@ -298,82 +298,103 @@ function showLoginShell() {
   document.getElementById('login-page')?.classList.remove('hidden');
 }
 
-async function authenticateUser(email, pass) {
-  if (!sb) {
-    const u = FALLBACK_USERS.find(x => x.email === email && x.password === pass);
-    return u ? { id: u.id, name: u.name, email: u.email, role: u.role } : null;
-  }
-  try {
-    const { data, error } = await sb.rpc('authenticate_user', { p_email: email, p_password: pass });
-    if (error) throw error;
-    const user = Array.isArray(data) ? data[0] : data;
-    if (user && VALID_ROLES.includes(user.role)) return user;
-  } catch (err) {
-    console.warn('[Auth] RPC unavailable, using legacy query:', err.message);
-  }
-  const { data, error } = await sb
-    .from('users')
-    .select('id,name,email,role')
-    .eq('email', email)
-    .eq('password', pass)
-    .maybeSingle();
-  if (error) throw error;
-  return data && VALID_ROLES.includes(data.role) ? data : null;
+function clearLoginPasswordField() {
+  const p = document.getElementById('login-password');
+  if (p) p.value = '';
 }
 
-async function fetchUserSession(id, email) {
-  if (!sb) {
-    const u = FALLBACK_USERS.find(x => x.id === id && x.email === email);
-    return u ? { id: u.id, name: u.name, email: u.email, role: u.role } : null;
-  }
-  try {
-    const { data, error } = await sb.rpc('get_user_by_id', { p_id: id, p_email: email });
-    if (error) throw error;
-    const user = Array.isArray(data) ? data[0] : data;
-    if (user && VALID_ROLES.includes(user.role)) return user;
-  } catch (err) {
-    console.warn('[Session] RPC unavailable:', err.message);
-  }
+async function fetchProfileForAuthUser(authUser) {
+  if (!sb || !authUser?.id) return null;
   const { data, error } = await sb
-    .from('users')
-    .select('id,name,email,role')
-    .eq('id', id)
-    .eq('email', email)
+    .from('profiles')
+    .select('id,name,username,role')
+    .eq('id', authUser.id)
     .maybeSingle();
-  if (error) throw error;
-  return data && VALID_ROLES.includes(data.role) ? data : null;
+  if (error || !data || !VALID_ROLES.includes(data.role)) return null;
+  return {
+    id: data.id,
+    name: data.name || data.username || 'مستخدم',
+    username: data.username || null,
+    email: authUser.email || '',
+    role: data.role,
+  };
 }
 
-async function restoreSession() {
-  let raw = null;
-  try { raw = sessionStorage.getItem(SESSION_KEY); } catch {}
-  if (!raw) {
-    try {
-      const legacy = localStorage.getItem('currentUser');
-      if (legacy) {
-        const parsed = JSON.parse(legacy);
-        if (parsed?.id && parsed?.email) {
-          raw = JSON.stringify({ id: parsed.id, email: parsed.email, ts: Date.now() });
-          localStorage.removeItem('currentUser');
-        }
-      }
-    } catch {}
-  }
-  if (!raw) return false;
+async function denyAccessAndSignOut(message) {
+  currentUser = null;
+  _sessionBootstrapDone = false;
+  clearLegacySessionArtifacts();
+  try { if (sb) await sb.auth.signOut(); } catch {}
+  showLoginShell();
+  if (message) showToast(message, 'error');
+}
+
+/** مسار واحد: profile → currentUser → الواجهة → البيانات */
+async function bootstrapAuthenticatedSession(session) {
+  if (!session?.user) return false;
+  if (_authHandling) return false;
+  if (_sessionBootstrapDone && currentUser?.id === session.user.id) return true;
+
+  _authHandling = true;
   try {
-    const { id, email } = JSON.parse(raw);
-    if (!id || !email) { clearSession(); return false; }
-    const user = await fetchUserSession(id, email);
-    if (!user) { clearSession(); return false; }
-    currentUser = user;
-    saveSession(user);
+    const profile = await fetchProfileForAuthUser(session.user);
+    if (!profile) {
+      await denyAccessAndSignOut('تعذّر الدخول. تحقق من بيانات الاعتماد أو راجع المسؤول.');
+      return false;
+    }
+    currentUser = profile;
+    clearLegacySessionArtifacts();
+    showAppShell();
+    await loadSettings();
+    await loadAllData(false);
+    applyRoleUI();
+    _sessionBootstrapDone = true;
     return true;
-  } catch {
-    clearSession();
+  } catch (err) {
+    console.error('[bootstrapAuthenticatedSession]');
+    await denyAccessAndSignOut('تعذّر تجهيز الجلسة. حاول مرة أخرى.');
     return false;
+  } finally {
+    _authHandling = false;
   }
 }
 
+async function handleSignedOut() {
+  currentUser = null;
+  _sessionBootstrapDone = false;
+  clearLegacySessionArtifacts();
+  [programsCache, initiativesCache, tasksCache, evidencesCache, teachersCache, kpiCache] = [[], [], [], [], [], []];
+  indicatorsCache = {};
+  settingsCache = {};
+  activeSchoolYearId = null;
+  showLoginShell();
+}
+
+async function handleAuthStateEvent(event, session) {
+  if (event === 'SIGNED_OUT') {
+    await handleSignedOut();
+    return;
+  }
+  if (!session?.user) return;
+  // TOKEN_REFRESHED: لا تعِد تحميل البيانات
+  if (event === 'TOKEN_REFRESHED') return;
+  // منع التكرار مع doLogin / getSession
+  if (_authHandling) return;
+  if (_sessionBootstrapDone && currentUser?.id === session.user.id) return;
+  await bootstrapAuthenticatedSession(session);
+}
+
+function bindAuthStateListener() {
+  if (!sb || _authListenerBound) return;
+  _authListenerBound = true;
+  sb.auth.onAuthStateChange((event, session) => {
+    // callback خفيف — العمل غير المتزامن خارجاً
+    queueMicrotask(() => {
+      void handleAuthStateEvent(event, session);
+    });
+  });
+}
+
 function requireAuth(action) {
   if (!currentUser) {
     showToast('يجب تسجيل الدخول أولاً', 'error');
@@ -435,26 +456,24 @@ function closeModal(id) {
 /* ─────────────────────────────────────────────────────────────
    §7  AUTH
    ───────────────────────────────────────────────────────────── */
-const FALLBACK_USERS = [
-  {id:'f1',name:'سارة العتيبي', email:'lyla127',           password:'1277',role:'admin'},
-  {id:'f2',name:'نورة القحطاني',email:'vice@school.sa',    password:'ChangeMe!1234',role:'vice'},
-  {id:'f3',name:'هند الزهراني', email:'teacher@school.sa', password:'ChangeMe!1234',role:'teacher'},
-];
-
 async function doLogin() {
   const email = (document.getElementById('login-email')?.value || '').trim().toLowerCase();
   const pass  = (document.getElementById('login-password')?.value || '');
 
   if (!email || !pass) {
-    showToast('يرجى إدخال اسم المستخدم وكلمة المرور', 'error');
+    showToast('يرجى إدخال البريد الإلكتروني وكلمة المرور', 'error');
+    return;
+  }
+  if (!isValidEmail(email)) {
+    showToast('صيغة البريد الإلكتروني غير صحيحة', 'error');
     return;
   }
-  if (!isValidLoginId(email)) {
-    showToast('صيغة اسم المستخدم غير صحيحة', 'error');
+  if (pass.length < 6 || pass.length > 128) {
+    showToast('كلمة المرور غير صحيحة', 'error');
     return;
   }
-  if (pass.length < 4 || pass.length > 128) {
-    showToast('كلمة المرور يجب أن تكون بين 4 و 128 حرفاً', 'error');
+  if (!sb) {
+    showToast('تعذّر الاتصال بخدمة المصادقة', 'error');
     return;
   }
 
@@ -466,27 +485,19 @@ async function doLogin() {
 
   try {
     showLoadingOverlay?.(true);
-
-    const user = await authenticateUser(email, pass);
-
-    if (!user) {
-      showToast('اسم المستخدم أو كلمة المرور غير صحيحة', 'error');
+    const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
+    if (error || !data?.session) {
+      showToast('تعذّر تسجيل الدخول. تحقق من البيانات وحاول مرة أخرى.', 'error');
       return;
     }
-
-    currentUser = user;
-    saveSession(user);
-    showAppShell();
-
-    await loadAllData?.();
-    applyRoleUI?.();
-
+    const ok = await bootstrapAuthenticatedSession(data.session);
+    if (!ok) return;
     showToast('تم تسجيل الدخول بنجاح', 'success');
-
   } catch (err) {
-    console.error('[doLogin]', err);
-    showToast('حدث خطأ أثناء تسجيل الدخول', 'error');
+    console.error('[doLogin]');
+    showToast('تعذّر تسجيل الدخول. حاول مرة أخرى.', 'error');
   } finally {
+    clearLoginPasswordField();
     showLoadingOverlay?.(false);
     if (btn) {
       btn.disabled = false;
@@ -495,16 +506,19 @@ async function doLogin() {
   }
 }
 window.doLogin = doLogin;
-function doLogout() {
+
+async function doLogout() {
+  _sessionBootstrapDone = false;
   currentUser = null;
-  clearSession();
   [programsCache, initiativesCache, tasksCache, evidencesCache, teachersCache, kpiCache] = [[], [], [], [], [], []];
   indicatorsCache = {};
   settingsCache = {};
   activeSchoolYearId = null;
+  clearLegacySessionArtifacts();
+  try { if (sb) await sb.auth.signOut(); } catch {}
   showLoginShell();
   const e = document.getElementById('login-email'); if (e) e.value = '';
-  const p = document.getElementById('login-password'); if (p) p.value = '';
+  clearLoginPasswordField();
 }
 window.doLogout = doLogout;
 /* ─────────────────────────────────────────────────────────────
@@ -551,11 +565,20 @@ async function loadAllData(renderAfter = true) {
     await fetchPrograms();
     await fetchIndicators();
     await fetchEvidences();
-    await fetchTasks();
-    await fetchInitiatives();
-    await fetchTeachers();
+    if (isSectionAllowed('plan') || isSectionAllowed('tasks')) {
+      await fetchTasks();
+      await fetchInitiatives();
+    } else {
+      tasksCache = [];
+      initiativesCache = [];
+    }
+    if (isSectionAllowed('teachers')) {
+      await fetchTeachers();
+    } else {
+      teachersCache = [];
+    }
     await fetchKPI();
-    await loadSettings();
+    // settings تُحمَّل في bootstrapAuthenticatedSession بعد نجاح الجلسة فقط
 
     programsCache.forEach(p => {
       p.progress = calcProgramProgress(p.id);
@@ -564,8 +587,8 @@ async function loadAllData(renderAfter = true) {
     if (renderAfter) renderSection(_activeSection);
 
   } catch (e) {
-    console.error('[loadAllData]', e);
-    showToast('خطأ في تحميل البيانات: ' + e.message, 'error');
+    console.error('[loadAllData]');
+    showToast('تعذّر تحميل بعض البيانات', 'error');
   } finally {
     showLoadingOverlay(false);
   }
@@ -690,7 +713,7 @@ async function fetchActiveSchoolYear() {
       const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
       if (row?.id) {
         activeSchoolYearId = row.id;
-        console.log('[fetchActiveSchoolYear] via rpc =', activeSchoolYearId);
+        console.log('[fetchActiveSchoolYear] via rpc =', activeSchoolYearId ? '(set)' : '(empty)');
         return activeSchoolYearId;
       }
     } else {
@@ -709,7 +732,7 @@ async function fetchActiveSchoolYear() {
     }
     const id = (Array.isArray(data) && data[0]?.id) ? data[0].id : null;
     if (id) activeSchoolYearId = id;
-    console.log('[fetchActiveSchoolYear] via table =', activeSchoolYearId, data);
+    console.log('[fetchActiveSchoolYear] via table =', activeSchoolYearId ? '(set)' : '(empty)');
     return activeSchoolYearId;
   } catch (err) {
     console.error('[fetchActiveSchoolYear] exception', err);
@@ -792,22 +815,19 @@ async function sbInsertProgram(p) {
     progress: parseInt(p.progress) || 0,
     status: calcProgramStatus(p),
     school_year_id: yearId,
+    created_by: currentUser?.id || null,
   };
 
   if (payload.school_year_id == null || payload.school_year_id === undefined) {
-    console.error('[sbInsertProgram] blocked: school_year_id missing', payload);
+    console.error('[sbInsertProgram] blocked: school_year_id missing');
     throw new Error(NO_ACTIVE_YEAR_MSG);
   }
 
-  console.log('[sbInsertProgram] activeSchoolYearId =', yearId);
-  console.log('[sbInsertProgram] insert payload =', JSON.parse(JSON.stringify(payload)));
-
   const { data, error } = await sb.from('programs').insert(payload).select().single();
   if (error) {
-    console.error('[sbInsertProgram] supabase error', error);
+    console.error('[sbInsertProgram] supabase error', error.message || error);
     throw error;
   }
-  console.log('[sbInsertProgram] SUCCESS id=', data?.id, 'school_year_id=', data?.school_year_id);
   return { ...p, id: data.id, school_year_id: data.school_year_id || yearId };
 }
 
@@ -1148,9 +1168,9 @@ async function sbInsertEvidence(ev) {
     file_name: ev.file_name || null,
     file_size: ev.file_size != null ? ev.file_size : null,
     upload_date: ev.date || new Date().toISOString().split('T')[0],
+    created_by: currentUser?.id || null,
   };
 
-  console.log('[sbInsertEvidence] payload =', row);
   const { data, error } = await sb.from('evidences').insert(row).select().single();
   if (error) throw error;
   return {
@@ -1203,6 +1223,7 @@ async function sbInsertTeacher(tf) {
     name:tf.name, assigned_tasks:parseInt(tf.assigned)||0,
     done_tasks:parseInt(tf.done)||0, last_report:tf.lastReport||null, notes:tf.notes||null,
     drive_link:tf.driveLink||null, created_by:tf.createdBy||null,
+    owner_id: currentUser?.id || null,
   }).select().single();
   if (error) throw error;
   return { ...tf, id:data.id };
@@ -1529,7 +1550,6 @@ function openProgramModal(id) {
   if (ti) ti.textContent = 'إضافة برنامج جديد';
   if (id) {
    const p = programsCache.find(x => String(x.id) === String(id)); if (!p) {
-  console.log('لم يتم العثور على البرنامج', id, programsCache);
   showToast('لم يتم العثور على البرنامج','error');
   return;
 }
@@ -1586,7 +1606,6 @@ async function saveProgram() {
         return;
       }
       p.school_year_id = yearId;
-      console.log('[saveProgram] about to insert with school_year_id=', yearId);
       saved = await sbInsertProgram(p);
       saved.indicators = []; saved.evidence = [];
       programsCache.push(saved);
@@ -1901,6 +1920,12 @@ function handleEvidenceFileSelect(input, prefix) {
     pendingEvidenceFile = null;
     return;
   }
+  if (file.type && !ALLOWED_EVIDENCE_MIME.includes(file.type)) {
+    showToast('نوع الملف غير مسموح','error');
+    input.value = '';
+    pendingEvidenceFile = null;
+    return;
+  }
   pendingEvidenceFile = file;
   const prev = document.getElementById(`${prefix}-file-preview`);
   if (!prev) return;
@@ -1921,13 +1946,18 @@ function clearEvidenceFile(prefix) {
 
 async function uploadEvidenceToStorage(file, meta) {
   if (!sb) throw new Error('Supabase غير متصل');
-  const yearId = meta.schoolYearId;
-  const programId = meta.programId || 'general';
-  const indicatorId = meta.indicatorId || 'general';
-  if (!yearId) throw new Error(NO_ACTIVE_YEAR_MSG);
+  if (!currentUser?.id) throw new Error('يجب تسجيل الدخول أولاً');
+  if (file.size > MAX_FILE_SIZE) throw new Error('الملف أكبر من 10MB');
+  if (!validateFileExtension(file.name, ALLOWED_EVIDENCE_EXT)) {
+    throw new Error('نوع الملف غير مسموح');
+  }
+  if (file.type && !ALLOWED_EVIDENCE_MIME.includes(file.type)) {
+    throw new Error('نوع الملف غير مسموح');
+  }
 
   const safeName = sanitizeStorageFileName(file.name);
-  const path = `${yearId}/${programId}/${indicatorId}/${Date.now()}-${safeName}`;
+  // مسار جديد: {auth.uid()}/{اسم فريد}
+  const path = `${currentUser.id}/${Date.now()}-${safeName}`;
 
   const { error: upErr } = await sb.storage
     .from(EVIDENCE_BUCKET)
@@ -1936,30 +1966,80 @@ async function uploadEvidenceToStorage(file, meta) {
       upsert: false,
       contentType: file.type || undefined,
     });
-  if (upErr) throw upErr;
-
-  const { data: pub } = sb.storage.from(EVIDENCE_BUCKET).getPublicUrl(path);
-  const fileUrl = pub?.publicUrl || null;
-  if (!fileUrl) throw new Error('تعذّر الحصول على رابط الملف بعد الرفع');
+  if (upErr) throw new Error('تعذّر رفع الملف');
 
+  // مسار الكائن فقط — بدون getPublicUrl
   return {
     path,
-    file_url: fileUrl,
+    file_url: path,
     file_name: file.name,
     file_size: file.size,
   };
 }
 
+function extractEvidenceStoragePath(fileUrl) {
+  if (!fileUrl) return null;
+  const raw = String(fileUrl).trim();
+  if (!raw) return null;
+  // مسار نسبي داخل الـ bucket
+  if (!/^https?:\/\//i.test(raw)) {
+    return raw.replace(/^\/+/, '').replace(/^evidences\//, '');
+  }
+  try {
+    const u = new URL(raw);
+    const markers = [
+      `/storage/v1/object/public/${EVIDENCE_BUCKET}/`,
+      `/storage/v1/object/sign/${EVIDENCE_BUCKET}/`,
+      `/storage/v1/object/authenticated/${EVIDENCE_BUCKET}/`,
+    ];
+    for (const m of markers) {
+      const idx = u.pathname.indexOf(m);
+      if (idx !== -1) return decodeURIComponent(u.pathname.slice(idx + m.length));
+    }
+  } catch {}
+  return null;
+}
+
+async function resolveEvidenceViewUrl(ev) {
+  if (!ev) return '';
+  const external = sanitizeUrl(ev.link || '');
+  const storagePath = extractEvidenceStoragePath(ev.file_url);
+  if (storagePath && sb) {
+    const { data, error } = await sb.storage
+      .from(EVIDENCE_BUCKET)
+      .createSignedUrl(storagePath, SIGNED_URL_TTL_SEC);
+    if (!error && data?.signedUrl) return data.signedUrl;
+  }
+  // روابط Drive الخارجية أو روابط عامة قديمة أثناء الانتقال
+  return sanitizeUrl(ev.file_url) || external;
+}
+
 function getEvidenceOpenUrl(ev) {
-  return sanitizeUrl(ev?.file_url || ev?.link || '');
+  return sanitizeUrl(ev?.link || '') || sanitizeUrl(ev?.file_url || '');
 }
 
 function evidenceViewButtonHtml(ev) {
-  const url = getEvidenceOpenUrl(ev);
-  if (!url) return '—';
-  return safeLinkHtml(url, 'عرض الملف', 'btn-sm btn-view evidence-view-btn');
+  const hasFile = !!(ev?.file_url || ev?.link);
+  if (!hasFile) return '—';
+  const id = esc(ev.id);
+  return `<button type="button" class="btn-sm btn-view evidence-view-btn" onclick="openEvidenceFile('${id}')">عرض الملف</button>`;
 }
 
+async function openEvidenceFile(evId) {
+  if (!requireAuth()) return;
+  const ev = evidencesCache.find(e => String(e.id) === String(evId));
+  if (!ev) { showToast('الملف غير موجود', 'error'); return; }
+  try {
+    const url = await resolveEvidenceViewUrl(ev);
+    if (!url) { showToast('تعذّر فتح الملف', 'error'); return; }
+    window.open(url, '_blank', 'noopener,noreferrer');
+  } catch (err) {
+    console.error('[openEvidenceFile]');
+    showToast('تعذّر فتح الملف', 'error');
+  }
+}
+window.openEvidenceFile = openEvidenceFile;
+
 function fillEvidenceIndicators(progId) {
   const sel = document.getElementById('ev-indicator-id');
   if (!sel) return;
@@ -2096,7 +2176,7 @@ async function saveEvidence() {
     };
 
     const saved = await sbInsertEvidence(ev);
-    if (indicatorId) {
+    if (indicatorId && can('toggleIndicator')) {
       const list = indicatorsCache[progId] || [];
       const ind = list.find(i => String(i.id) === String(indicatorId));
       if (ind) ind.is_completed = true;
@@ -2113,8 +2193,8 @@ async function saveEvidence() {
     renderReports();
     showToast('تم رفع الشاهد وحفظه بنجاح.','success');
   } catch (err) {
-    console.error('[saveEvidence]', err.message || err);
-    showToast('خطأ: ' + (err.message || err), 'error');
+    console.error('[saveEvidence]');
+    showToast('تعذّر حفظ الشاهد', 'error');
   } finally {
     if (btn) { btn.disabled = false; btn.textContent = '📎 حفظ الشاهد'; }
   }
@@ -2691,8 +2771,8 @@ async function saveReport() {
     renderPrograms();
     showToast('تم رفع الشاهد وحفظه بنجاح.','success');
   } catch (err) {
-    console.error('[saveReport]', err.message || err);
-    showToast('خطأ: ' + (err.message || err), 'error');
+    console.error('[saveReport]');
+    showToast('تعذّر حفظ الشاهد', 'error');
   } finally {
     if (btn) { btn.disabled = false; btn.textContent = '📤 رفع الشاهد'; }
   }
@@ -2980,25 +3060,31 @@ function drawCompare() {
 /* ─────────────────────────────────────────────────────────────
    §34  USERS MANAGEMENT (admin only)
    ───────────────────────────────────────────────────────────── */
+async function invokeAdminUsers(body) {
+  if (!sb) throw new Error('Supabase غير متصل');
+  const { data, error } = await sb.functions.invoke('admin-users', { body });
+  if (error) throw error;
+  if (data?.error) throw new Error(data.error);
+  return data;
+}
+
 async function renderUsersSection() {
   if (!can('manageUsers')) return;
   const sec = document.getElementById('section-users'); if (!sec) return;
   let users = [];
   if (sb) {
     try {
-      const { data, error } = await sb.rpc('admin_list_users', {
-        p_admin_id: currentUser.id,
-        p_admin_email: currentUser.email,
-      });
-      if (error) throw error;
-      users = data || [];
+      const data = await invokeAdminUsers({ action: 'list' });
+      users = data?.users || [];
     } catch (err) {
-      console.warn('[fetchUsers] RPC fallback:', err.message);
-      const { data, error } = await sb.from('users').select('id,name,email,role,created_at').order('created_at');
-      if (error) console.error('[fetchUsers]', error.message);
-      else users = data || [];
+      console.error('[fetchUsers]', err && err.message ? err.message : err);
+      showToast('تعذّر تحميل المستخدمين. تأكد من نشر Edge Function: admin-users', 'error');
+      users = [];
     }
-  } else { users = FALLBACK_USERS.map(u => ({ id:u.id, name:u.name, email:u.email, role:u.role, created_at:null })); }
+  } else {
+    users = [];
+    showToast('تعذّر تحميل المستخدمين: الاتصال بـ Supabase مطلوب', 'error');
+  }
   const RL={admin:'مدير',vice:'وكيل',teacher:'معلم'};
   const RB={admin:'badge-danger',vice:'badge-info',teacher:'badge-success'};
   sec.innerHTML = `
@@ -3007,10 +3093,10 @@ async function renderUsersSection() {
       <button class="btn-primary" onclick="openAddUserModal()">+ إضافة مستخدم</button>
     </div>
     <div class="table-wrapper"><table class="data-table">
-      <thead><tr><th>#</th><th>الاسم</th><th>البريد الإلكتروني</th><th>الدور</th><th>تاريخ الإضافة</th><th>إجراءات</th></tr></thead>
+      <thead><tr><th>#</th><th>الاسم</th><th>البريد / اسم العرض</th><th>الدور</th><th>تاريخ الإضافة</th><th>إجراءات</th></tr></thead>
       <tbody>
         ${users.map((u,i)=>`<tr><td>${i+1}</td><td style="font-weight:700">${esc(u.name)}</td>
-          <td style="direction:ltr;text-align:right">${esc(u.email)}</td>
+          <td style="direction:ltr;text-align:right">${esc(u.email || u.username || '—')}</td>
           <td><span class="badge ${RB[u.role]||'badge-secondary'}">${esc(RL[u.role]||u.role)}</span></td>
           <td>${esc(fmtDate(u.created_at))}</td>
           <td><div style="display:flex;gap:6px;align-items:center">
@@ -3030,7 +3116,8 @@ async function renderUsersSection() {
       <div class="modal-body">
         <div class="form-group"><label>الاسم الكامل</label><input type="text" id="nu-name" placeholder="الاسم الكامل"/></div>
         <div class="form-group"><label>البريد الإلكتروني</label><input type="email" id="nu-email" placeholder="email@school.sa"/></div>
-        <div class="form-group"><label>كلمة المرور</label><input type="password" id="nu-pass" placeholder="كلمة المرور"/></div>
+        <div class="form-group"><label>اسم العرض (اختياري)</label><input type="text" id="nu-username" placeholder="يظهر في الواجهة فقط"/></div>
+        <div class="form-group"><label>كلمة المرور</label><input type="password" id="nu-pass" placeholder="كلمة المرور (8 أحرف على الأقل)"/></div>
         <div class="form-group"><label>الدور</label>
           <select id="nu-role"><option value="teacher">معلم</option><option value="vice">وكيل</option><option value="admin">مدير</option></select>
         </div>
@@ -3053,30 +3140,26 @@ async function handleAddUser() {
   const g = id => (document.getElementById(id)?.value||'').trim();
   const name=clampInput(g('nu-name'));
   const email=g('nu-email').toLowerCase();
+  const username=clampInput(g('nu-username')) || null;
   const pass=g('nu-pass');
   const role=g('nu-role');
   if (!name||!email||!pass) { showToast('يرجى تعبئة جميع الحقول','error'); return; }
   if (!isValidEmail(email)) { showToast('صيغة البريد غير صحيحة','error'); return; }
-  if (pass.length < 4 || pass.length > 128) { showToast('كلمة المرور يجب أن تكون بين 4 و 128 حرفاً','error'); return; }
+  if (pass.length < 8 || pass.length > 128) { showToast('كلمة المرور يجب أن تكون بين 8 و 128 حرفاً','error'); return; }
   if (!VALID_ROLES.includes(role)) { showToast('دور غير صالح','error'); return; }
   try {
-    const { error } = await sb.rpc('admin_add_user', {
-      p_admin_id: currentUser.id,
-      p_admin_email: currentUser.email,
-      p_name: name,
-      p_email: email,
-      p_password: pass,
-      p_role: role,
+    await invokeAdminUsers({
+      action: 'create',
+      email,
+      password: pass,
+      name,
+      username,
+      role,
     });
-    if (error) {
-      // fallback إذا لم تُنفَّذ دوال الأمان بعد
-      const { error: e2 } = await sb.from('users').insert({ name, email, password: pass, role });
-      if (e2) throw e2;
-    }
     closeModal('add-user-modal');
     showToast('تمت إضافة المستخدم ✅','success');
     await renderUsersSection();
-  } catch(err){ console.error('[handleAddUser]',err.message); showToast('خطأ: '+err.message,'error'); }
+  } catch(err){ console.error('[handleAddUser]'); showToast('تعذّر إتمام العملية','error'); }
 }
 
 async function handleDelUser(id) {
@@ -3085,18 +3168,10 @@ async function handleDelUser(id) {
   if (!confirm('حذف هذا المستخدم؟')) return;
   if (!sb) { showToast('Supabase غير متصل','error'); return; }
   try {
-    const { error } = await sb.rpc('admin_delete_user', {
-      p_admin_id: currentUser.id,
-      p_admin_email: currentUser.email,
-      p_target_id: id,
-    });
-    if (error) {
-      const { error: e2 } = await sb.from('users').delete().eq('id', id);
-      if (e2) throw e2;
-    }
+    await invokeAdminUsers({ action: 'delete', target_id: id });
     showToast('تم الحذف 🗑️','warning');
     await renderUsersSection();
-  } catch(err){ console.error('[handleDelUser]',err.message); showToast('خطأ: '+err.message,'error'); }
+  } catch(err){ console.error('[handleDelUser]'); showToast('تعذّر إتمام العملية','error'); }
 }
 
 async function handleChgRole(id, role) {
@@ -3109,18 +3184,9 @@ async function handleChgRole(id, role) {
   }
   if (!sb) { showToast('Supabase غير متصل','error'); return; }
   try {
-    const { error } = await sb.rpc('admin_change_role', {
-      p_admin_id: currentUser.id,
-      p_admin_email: currentUser.email,
-      p_target_id: id,
-      p_role: role,
-    });
-    if (error) {
-      const { error: e2 } = await sb.from('users').update({ role }).eq('id', id);
-      if (e2) throw e2;
-    }
+    await invokeAdminUsers({ action: 'change_role', target_id: id, role });
     showToast('تم تعديل الدور ✅','success');
-  } catch(err){ console.error('[handleChgRole]',err.message); showToast('خطأ: '+err.message,'error'); }
+  } catch(err){ console.error('[handleChgRole]'); showToast('تعذّر إتمام العملية','error'); await renderUsersSection(); }
 }
 
 /* ─────────────────────────────────────────────────────────────
@@ -3130,21 +3196,31 @@ document.addEventListener('DOMContentLoaded', async () => {
   calendarMonth = new Date().getMonth();
   calendarYear = new Date().getFullYear();
 
-  await loadSettings();
+  bindAuthStateListener();
+  showLoginShell();
 
-  const hasSession = await restoreSession();
-  if (hasSession) {
-    showAppShell();
-    await loadAllData(false);
-    applyRoleUI();
-    renderSection(_activeSection || 'dashboard');
-    renderDashboard();
-    renderPrograms();
-    renderReports();
-    drawDashPie();
-  } else {
+  if (!sb) {
+    showToast('تعذّر الاتصال بخدمة المصادقة', 'error');
+    return;
+  }
+
+  clearLegacySessionArtifacts();
+  const { data, error } = await sb.auth.getSession();
+  if (error || !data?.session) {
+    showLoginShell();
+    return;
+  }
+
+  const ok = await bootstrapAuthenticatedSession(data.session);
+  if (!ok) {
     showLoginShell();
+    return;
   }
+  renderSection(_activeSection || 'dashboard');
+  renderDashboard();
+  renderPrograms();
+  renderReports();
+  drawDashPie();
 });
 window.doLogin = doLogin; 
 window.openAddUserModal = openAddUserModal;
```

---

## 6) جدول RLS الكامل

| الجدول | العملية | الأدوار | USING | WITH CHECK |
|---|---|---|---|---|
| profiles | SELECT | authenticated: self أو admin | `id = auth.uid() OR is_admin()` | — |
| profiles | UPDATE | authenticated: self أو admin (أعمدة name/username فقط عبر GRANT) | `id = auth.uid() OR is_admin()` | نفس USING |
| profiles | INSERT/DELETE | لا سياسة لـ authenticated/anon | — | — |
| users | ALL | anon+authenticated | `false` | `false` |
| programs | SELECT | admin/vice/teacher | `current_app_role() IN (...)` | — |
| programs | INSERT/UPDATE | admin/vice | role IN admin/vice | نفس |
| programs | DELETE | admin | `is_admin()` | — |
| program_indicators | SELECT | admin/vice/teacher | role IN | — |
| program_indicators | INSERT/UPDATE | admin/vice | role IN admin/vice | نفس |
| program_indicators | DELETE | admin | `is_admin()` | — |
| evidences | SELECT | admin/vice/teacher | role IN | — |
| evidences | INSERT | admin/vice/teacher | — | role IN AND `created_by = auth.uid()` |
| evidences | UPDATE | admin/vice | role IN admin/vice | نفس |
| evidences | DELETE | admin | `is_admin()` | — |
| initiatives | SELECT/INSERT/UPDATE | admin/vice | role IN | — / نفس |
| initiatives | DELETE | admin | `is_admin()` | — |
| tasks | SELECT/INSERT/UPDATE | admin/vice | role IN | — / نفس |
| tasks | DELETE | admin | `is_admin()` | — |
| settings | SELECT | admin/vice/teacher | role IN | — |
| settings | INSERT/UPDATE/DELETE | admin | `is_admin()` | نفس حيث ينطبق |
| teacher_followups | ALL ops | admin/vice فقط | role IN | نفس |
| school_years | SELECT | admin/vice/teacher | role IN | — |
| school_years | INSERT/UPDATE/DELETE | admin | `is_admin()` | نفس |
| storage.objects | SELECT | admin/vice/teacher | bucket evidences + role | — |
| storage.objects | INSERT | admin/vice أو teacher في مجلدها | — | مسار teacher = `auth.uid()` |
| storage.objects | UPDATE/DELETE | admin فقط | `is_admin()` | نفس |

لا توجد `USING (true)` أو `WITH CHECK (true)`.

---

## 7) جدول الصلاحيات النهائي

| العملية | admin | vice | teacher | anon |
|---|---|---|---|---|
| دخول Auth | نعم | نعم | نعم | لا |
| إدارة مستخدمين/أدوار | نعم (Edge Function) | لا | لا | لا |
| programs قراءة | نعم | نعم | نعم | لا |
| programs إضافة/تعديل | نعم | نعم | لا | لا |
| programs حذف | نعم | لا | لا | لا |
| indicators قراءة | نعم | نعم | نعم | لا |
| indicators إضافة/تعديل/`is_completed` | نعم | نعم | لا | لا |
| indicators حذف | نعم | لا | لا | لا |
| evidences قراءة/فتح ملف | نعم | نعم | نعم | لا |
| evidences إرفاق | نعم | نعم | نعم | لا |
| evidences تعديل بعد الحفظ | نعم | نعم | لا | لا |
| evidences حذف | نعم | لا | لا | لا |
| Storage رفع | نعم | نعم | مجلدها فقط | لا |
| Storage تعديل/حذف ملف | نعم | لا | لا | لا |
| initiatives/tasks | كامل (حذف admin) | إضافة/تعديل | لا | لا |
| settings كتابة | نعم | لا | لا | لا |
| teacher_followups | نعم | نعم | لا | لا |

---

## 8) نتائج الاختبارات

> بيئة التشغيل الحيّة لم تُحدَّث بعد (SQL غير منفَّذ / لا حسابات Auth بعد). الاختبارات التالية: **مراجعة ثابتة للكود = PASS** حيث ينطبق، و**FAIL** لأي اختبار تشغيلي لم يُنفَّذ فعلياً.

### Auth
| اختبار | النتيجة |
|---|---|
| دخول admin | FAIL — لم يُنشأ حساب بعد |
| دخول vice | FAIL — لم يُنشأ حساب بعد |
| دخول teacher | FAIL — لم يُنشأ حساب بعد |
| تسجيل الخروج | PASS (كود: `signOut` + مسح الحالة) |
| استعادة الجلسة | PASS (كود: `getSession` + bootstrap واحد) |
| عدم تكرار loadAllData | PASS (كود: `_authHandling` / `_sessionBootstrapDone`) |
| لا استعلامات محمية قبل الجلسة | PASS (كود: لا `loadSettings` قبل الجلسة) |
| منع غير المسجل | PASS (كود+RLS المقترح) — تشغيلي بعد cutover |

### Teacher
| اختبار | النتيجة |
|---|---|
| مشاهدة برامج/مؤشرات/شواهد | PASS (PERMS+NAV+RLS) |
| فتح ملف | PASS (Signed URL في الكود) — تشغيلي بعد Storage phase |
| إرفاق شاهد | PASS (كود+RLS INSERT) |
| تعديل/حذف شاهد | DENIED / PASS |
| تغيير is_completed | DENIED / PASS |
| تعديل برنامج/مؤشر | DENIED / PASS |
| تعديل/حذف Storage | DENIED / PASS |
| إدارة مستخدمين | DENIED / PASS |

### RLS / Edge / Storage (مراجعة ثابتة)
| اختبار | النتيجة |
|---|---|
| لا USING(true)/WITH CHECK(true) | PASS |
| لا recursive profiles (SECURITY DEFINER) | PASS |
| Edge: JWT ثم profile admin ثم service | PASS |
| منع حذف آخر admin / الحساب الحالي | PASS (كود الدالة) |
| CORS عبر ALLOWED_ORIGINS بدون * | PASS |
| bucket private + MIME + 10MB | PASS (SQL مقترح) |
| اختبارات تشغيلية anon/teacher عبر PostgREST | FAIL — بانتظار تنفيذ SQL |

---

## 9) ترتيب الانتقال (بدون تنفيذ)

1. نسخة احتياطية DB + Storage
2. مراجعة ثم تنفيذ `phase_auth_foundation_review.sql`
3. إنشاء أول admin من Authentication Dashboard
4. إدراج profile بنفس UUID و`role='admin'`
5. نشر Edge Function بعد Secrets و`ALLOWED_ORIGINS`
6. تشغيل الواجهة محلياً واختبار admin
7. إنشاء vice/teacher للاختبار
8. تنفيذ `phase_rls_cutover_review.sql` (يوقف الواجهة القديمة)
9. اختبار صلاحيات الأدوار
10. تنفيذ `phase_storage_private_review.sql`
11. اختبار الرفع والعرض
12. نشر الواجهة بعد نجاح الاختبارات
13. تنظيف evidences التجريبية أخيراً
14. الإبقاء على `public.users` مغلقاً؛ لاحقاً `users_legacy` — بلا حذف الآن

---

## 10) البيانات التجريبية

- 30 سجل evidences — لا backfill — لا حذف الآن
- 3 ملفات PDF — حذف لاحق عبر Storage API أولاً ثم DELETE evidences
- لا جدول reports مستقل
- الخطة: `sql/trial_evidence_cleanup_review.sql`

---

## 11) الملفات المعدّلة والجديدة

**معدّلة:** `script.js`, `index.html`, `config.js` (persistSession فقط), `README.md`, `supabase/functions/admin-users/index.ts`, `sql/trial_evidence_cleanup_review.sql`, `AUTH-REVIEW-PACK.md`

**جديدة:** `sql/phase_auth_foundation_review.sql`, `sql/phase_rls_cutover_review.sql`, `sql/phase_storage_private_review.sql`

**مستبدل/مهمل للمراجعة:** `sql/supabase_auth_migration_review.sql` (أُضيفت ملاحظة DEPRECATED)

---

## 12) المخاطر المتبقية

- SQL وEdge Function غير مطبَّقين/منشورين بعد.
- RLS Cutover يوقف الدخول القديم فوراً — لا يُنفَّذ قبل admin جاهز.
- الملفات القديمة بمسارات year/program لن تطابق مجلد `auth.uid()`؛ ستُحذف كتجريبية.
- يجب ضبط `ALLOWED_ORIGINS` يدوياً قبل نشر الدالة.
- الاختبارات التشغيلية ما زالت FAIL حتى إنشاء الحسابات وتنفيذ المراحل.

---

تم إصلاح وتجهيز حزمة انتقال Supabase Auth وصلاحيات المعلمة داخل فرع security-hardening فقط. لم أنفذ SQL، ولم أحذف بيانات أو ملفات، ولم أنشر أو أعمل Push. أنتظر المراجعة
