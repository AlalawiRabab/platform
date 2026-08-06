-- ============================================================
-- شواهد: أعمدة الملفات + Bucket التخزين evidences
-- ============================================================
-- نفّذ يدوياً في Supabase SQL Editor.
-- لا يُنفَّذ تلقائياً من الواجهة.
--
-- أعمدة موجودة مسبقاً (لا تُعاد إضافتها):
--   file_url, school_year_id, link, title, type, program_id,
--   indicator_id, person, notes, created_at, ...
--
-- أعمدة ناقصة يجب إضافتها:
--   file_name, file_size
-- ============================================================

-- 1) أعمدة وصف الملف
ALTER TABLE public.evidences
  ADD COLUMN IF NOT EXISTS file_name text;

ALTER TABLE public.evidences
  ADD COLUMN IF NOT EXISTS file_size bigint;

COMMENT ON COLUMN public.evidences.file_url IS
  'رابط عام لملف مرفوع عبر Supabase Storage (bucket: evidences).';
COMMENT ON COLUMN public.evidences.file_name IS
  'اسم الملف الأصلي كما رفعه المستخدم.';
COMMENT ON COLUMN public.evidences.file_size IS
  'حجم الملف بالبايت.';

-- 2) إنشاء bucket التخزين evidences (عام للقراءة لزر «عرض الملف»)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'evidences',
  'evidences',
  true,
  10485760, -- 10MB
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
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 3) سياسات Storage (متوافقة مع أسلوب المنصة الحالي: anon مفتوح)
-- احذف السياسات القديمة إن وُجدت بنفس الاسم ثم أعد إنشاءها.
DROP POLICY IF EXISTS evidences_public_read ON storage.objects;
DROP POLICY IF EXISTS evidences_anon_insert ON storage.objects;
DROP POLICY IF EXISTS evidences_anon_update ON storage.objects;
DROP POLICY IF EXISTS evidences_anon_delete ON storage.objects;

CREATE POLICY evidences_public_read
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'evidences');

CREATE POLICY evidences_anon_insert
  ON storage.objects
  FOR INSERT
  WITH CHECK (bucket_id = 'evidences');

CREATE POLICY evidences_anon_update
  ON storage.objects
  FOR UPDATE
  USING (bucket_id = 'evidences')
  WITH CHECK (bucket_id = 'evidences');

CREATE POLICY evidences_anon_delete
  ON storage.objects
  FOR DELETE
  USING (bucket_id = 'evidences');
