-- ============================================================
-- phase_storage_teacher_read_review.sql   (الخطوة 6 — بعد مراجعة S7)
-- قراءة المعلمة لملفات bucket evidences دون قطع أي ملف تفتحه اليوم من الواجهة
-- مراجعة / تطبيق يدوي — لا يُنفَّذ تلقائياً
-- ============================================================
-- المشكلة (ثابتة من سياسة evidences_auth_select المطبّقة):
--   المعلمة تستطيع سرد/توقيع أي ملف في bucket evidences، بما فيها ملفات السنوات
--   المؤرشفة/المجمّدة، متجاوزة عزل القراءة المطبّق على جدول evidences.
--
-- الحل الآمن (لا يجعل أي ملف عامًا، ولا يقطع وصولًا قائمًا):
--   public.evidence_storage_key(file_url) تستخرج مفتاح الكائن بنفس منطق الواجهة
--   extractEvidenceStoragePath() حرفيًا (مسار نسبي، أو رابط public/sign/authenticated
--   قديم مع فك ترميز %XX للأسماء العربية). الواجهة توقّع الرابط بهذا المفتاح نفسه،
--   فكل ملف تفتحه المعلمة اليوم لشاهد تراه يبقى مطابقًا للسياسة الجديدة.
--   تبقى للمعلمة أيضًا كل الملفات داخل مجلدها {auth.uid()}/ (ملفاتها هي، أيًا كانت السنة).
--   admin/vice: كما هو (كل الملفات). الرفع/التعديل/الحذف: بلا تغيير.
--
-- حاجز التطبيق: القسم «GATE» داخل المعاملة يُجهضها إن وُجد شاهد في السنة النشطة
--   يُفتح اليوم (كائنه موجود) ولا يطابق المفتاح الجديد. المتوقع 0 بالبناء.
-- PRECHECK: sql/precheck_readonly_report.sql (المفتاح S7).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.evidence_storage_key(p_file_url text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_raw text := btrim(COALESCE(p_file_url, ''));
  v_path text;
  v_enc text;
  v_marker text;
  v_pos int;
  v_bytes bytea := '\x'::bytea;
  v_i int := 1;
  v_c text;
BEGIN
  IF v_raw = '' THEN
    RETURN NULL;
  END IF;

  IF v_raw !~* '^https?://' THEN
    RETURN regexp_replace(regexp_replace(v_raw, '^/+', ''), '^evidences/', '');
  END IF;

  v_path := split_part(split_part(regexp_replace(v_raw, '^https?://[^/]*', '', 'i'), '?', 1), '#', 1);
  FOREACH v_marker IN ARRAY ARRAY[
    '/storage/v1/object/public/evidences/',
    '/storage/v1/object/sign/evidences/',
    '/storage/v1/object/authenticated/evidences/'
  ] LOOP
    v_pos := strpos(v_path, v_marker);
    IF v_pos > 0 THEN
      v_enc := substr(v_path, v_pos + length(v_marker));
      EXIT;
    END IF;
  END LOOP;

  IF v_enc IS NULL OR v_enc = '' THEN
    RETURN NULL;
  END IF;

  WHILE v_i <= length(v_enc) LOOP
    v_c := substr(v_enc, v_i, 1);
    IF v_c = '%' AND substr(v_enc, v_i + 1, 2) ~ '^[0-9A-Fa-f]{2}$' THEN
      v_bytes := v_bytes || decode(substr(v_enc, v_i + 1, 2), 'hex');
      v_i := v_i + 3;
    ELSE
      v_bytes := v_bytes || convert_to(v_c, 'UTF8');
      v_i := v_i + 1;
    END IF;
  END LOOP;
  RETURN convert_from(v_bytes, 'UTF8');
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.evidence_storage_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.evidence_storage_key(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.evidence_storage_key(text) TO authenticated;

CREATE INDEX IF NOT EXISTS evidences_storage_key_idx
  ON public.evidences (public.evidence_storage_key(file_url));

-- GATE: شواهد السنة النشطة التي يوجد كائنها اليوم لكن لا يطابق المفتاح → إجهاض
SELECT 1 / CASE WHEN NOT EXISTS (
  SELECT 1
  FROM public.evidences e
  JOIN public.school_years sy ON sy.id = e.school_year_id AND sy.is_active
  WHERE e.file_url IS NOT NULL AND btrim(e.file_url) <> ''
    AND public.evidence_storage_key(e.file_url) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = 'evidences' AND o.name = public.evidence_storage_key(e.file_url)
    )
    AND EXISTS (
      SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = 'evidences'
        AND (o.name = e.file_url OR right(e.file_url, length(o.name) + 11) = '/evidences/' || o.name)
    )
) THEN 1 ELSE 0 END AS gate_no_openable_file_would_be_cut;

DROP POLICY IF EXISTS evidences_auth_select ON storage.objects;
CREATE POLICY evidences_auth_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'evidences'
    AND (
      public.is_staff()
      OR (
        public.current_app_role() = 'teacher'
        AND (
          (storage.foldername(objects.name))[1] = auth.uid()::text
          OR EXISTS (
            SELECT 1 FROM public.evidences AS e
            WHERE public.evidence_storage_key(e.file_url) = objects.name
          )
        )
      )
    )
  );

COMMIT;

-- POSTCHECK (يدوي):
--   كمعلمة: فتح شاهد ملف من السنة النشطة (ومنه اسم عربي قديم) → يعمل
--   كمعلمة: فتح ملف رفعته بنفسها → يعمل
--   كمعلمة: createSignedUrl لمسار ملف سنة مؤرشفة ليس في مجلدها → Object not found
--   كوكيلة/قائدة: فتح أي ملف → يعمل

-- ROLLBACK (فوري — يعيد السياسة السابقة حرفيًا):
/*
BEGIN;
DROP POLICY IF EXISTS evidences_auth_select ON storage.objects;
CREATE POLICY evidences_auth_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'evidences' AND public.current_app_role() IN ('admin','vice','teacher'));
COMMIT;
-- الدالة والفهرس غير ضارّين ويمكن إبقاؤهما.
*/
