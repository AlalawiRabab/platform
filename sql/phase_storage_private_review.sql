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
