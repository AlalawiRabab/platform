-- ============================================================
-- security_storage_private.sql
-- تحويل bucket evidences إلى Private وتقييد سياسات Storage
-- ============================================================
-- نفّذ يدوياً في Supabase SQL Editor بعد الاختبار المحلي.
-- لا يُنفَّذ تلقائياً من الواجهة أو من أي سكربت نشر.
--
-- ماذا يفعل:
-- 1) يجعل bucket evidences خاصاً (private) بدون حذف الملفات الموجودة
-- 2) يحذف سياسات anon المفتوحة السابقة
-- 3) يمنع anon من INSERT / UPDATE / DELETE
-- 4) يقيّد الكتابة/التعديل/الحذف على authenticated فقط
-- 5) يبقي القراءة عبر signed URLs (authenticated) — لا روابط عامة
--
-- ملاحظة:
-- بعد التنفيذ يجب أن تعتمد الواجهة على createSignedUrl لعرض الملفات.
-- ============================================================

-- 1) تحويل الـ bucket إلى Private (لا يحذف objects)
UPDATE storage.buckets
   SET public = false,
       file_size_limit = COALESCE(file_size_limit, 10485760)
 WHERE id = 'evidences';

-- إن لم يكن الـ bucket موجوداً، أنشئه كـ private دون المساس بأي بيانات أخرى
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('evidences', 'evidences', false, 10485760)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = COALESCE(storage.buckets.file_size_limit, EXCLUDED.file_size_limit);

-- 2) حذف السياسات المفتوحة السابقة على storage.objects لهذا الـ bucket
DROP POLICY IF EXISTS evidences_public_read ON storage.objects;
DROP POLICY IF EXISTS evidences_anon_insert ON storage.objects;
DROP POLICY IF EXISTS evidences_anon_update ON storage.objects;
DROP POLICY IF EXISTS evidences_anon_delete ON storage.objects;
DROP POLICY IF EXISTS "evidences_public_read" ON storage.objects;
DROP POLICY IF EXISTS "evidences_anon_insert" ON storage.objects;
DROP POLICY IF EXISTS "evidences_anon_update" ON storage.objects;
DROP POLICY IF EXISTS "evidences_anon_delete" ON storage.objects;

-- سياسات قديمة شائعة أخرى (إن وُجدت بأسماء مختلفة)
DO $$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT policyname
      FROM pg_policies
     WHERE schemaname = 'storage'
       AND tablename = 'objects'
       AND (
         policyname ILIKE '%evidence%'
         OR qual::text ILIKE '%evidences%'
         OR with_check::text ILIKE '%evidences%'
       )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', pol.policyname);
  END LOOP;
END $$;

-- 3) سياسات جديدة: authenticated فقط — لا صلاحيات كتابة لـ anon
-- القراءة للمصادقين (مطلوبة لتوليد/استخدام signed URLs حسب إعدادات المشروع)
CREATE POLICY evidences_authenticated_select
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'evidences');

CREATE POLICY evidences_authenticated_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'evidences');

CREATE POLICY evidences_authenticated_update
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (bucket_id = 'evidences')
  WITH CHECK (bucket_id = 'evidences');

CREATE POLICY evidences_authenticated_delete
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'evidences');

-- تأكيد صريح: لا تُنشأ أي سياسة تمنح anon إد INSERT/UPDATE/DELETE على evidences.
-- (غياب السياسة = المنع الافتراضي مع RLS مفعّل على storage.objects)

-- 4) تحقق سريع بعد التنفيذ
SELECT id, name, public, file_size_limit
  FROM storage.buckets
 WHERE id = 'evidences';

SELECT policyname, roles, cmd
  FROM pg_policies
 WHERE schemaname = 'storage'
   AND tablename = 'objects'
   AND policyname ILIKE 'evidences_%'
 ORDER BY policyname;
