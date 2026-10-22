-- ============================================================
-- REVIEW ONLY — DO NOT RUN AUTOMATICALLY. Manual apply in the SQL Editor after separate approval.
-- ============================================================
-- phase_evidence_attribution_review.sql
-- اسم المعلمة المسؤولة + اسم عرض رابط Drive + https — تحقق على الخادم للعمليات الجديدة فقط
-- مراجعة / تطبيق يدوي في محرر SQL — لا يُنفَّذ تلقائياً ولا من المستودع
-- ============================================================
-- المتطلب السابق: phase_evidence_multi_attachments_review.sql مطبَّق (مسجَّل في platform_migration_history)
--
-- ماذا يفعل:
--   * Trigger قبل INSERT/UPDATE على public.evidences (لا يمس أي صف موجود):
--       - INSERT: person إلزامي (تُزال المسافات الزائدة، 2–100 حرف).
--       - INSERT لمرفق رابط فقط (بلا file_url): file_name = اسم العرض إلزامي (1–150 حرفاً).
--       - INSERT: link/evidence_link إن وُجد يجب أن يبدأ بـ https:// وبلا مسافات.
--       - UPDATE: لا يتحقق إلا من الحقول التي تغيّرت فعلاً؛ لذلك اعتماد/إلغاء اعتماد
--         الشواهد القديمة (بلا اسم معلمة) يبقى يعمل دون تغيير.
--   * لا أعمدة جديدة: person موجود أصلاً لاسم المعلمة، وfile_name موجود أصلاً لاسم العرض
--     (اسم الملف المرفوع، أو الاسم المكتوب لرابط Drive). الرابط الأصلي يبقى في link كما هو.
--   * لا NOT NULL ولا CHECK على الجدول، ولا UPDATE/DELETE لأي بيانات.
--   * لا يغيّر RLS ولا صلاحيات الأدوار ولا الاعتماد ولا Storage.
-- ============================================================

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.evidences') IS NULL THEN
    RAISE EXCEPTION 'STOP: جدول public.evidences غير موجود';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'evidences'
        AND column_name IN ('person', 'file_name', 'file_url', 'link', 'evidence_link')) <> 5 THEN
    RAISE EXCEPTION 'STOP: أعمدة person/file_name/file_url/link/evidence_link غير مكتملة';
  END IF;
  IF to_regprocedure('public.protect_approved_evidence_attachment()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.platform_migration_history
                    WHERE migration_key = 'phase_evidence_multi_attachments_review_v1') THEN
    RAISE EXCEPTION 'STOP: طبّق phase_evidence_multi_attachments_review.sql أولاً';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.evidences'::regclass) THEN
    RAISE EXCEPTION 'STOP: RLS غير مفعّل على evidences';
  END IF;
END
$pre$;

CREATE TEMP TABLE _evidence_attribution_precheck ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM public.evidences) AS evidences_cnt,
  (SELECT count(*) FROM public.evidence_requirements) AS requirements_cnt,
  (SELECT count(*) FROM public.programs) AS programs_cnt,
  (SELECT count(*) FROM public.program_indicators) AS indicators_cnt,
  (SELECT md5(coalesce(string_agg(to_jsonb(e)::text, ',' ORDER BY e.id), '')) FROM public.evidences e) AS evidences_md5,
  (SELECT count(*) FROM storage.objects WHERE bucket_id = 'evidences') AS storage_cnt;

-- ------------------------------------------------------------
-- 1) دالة التحقق — SECURITY INVOKER، لا تقرأ جداول، تعمل على NEW فقط
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_evidence_attribution()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  link_only boolean;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.person IS DISTINCT FROM OLD.person THEN
    NEW.person := NULLIF(btrim(regexp_replace(coalesce(NEW.person, ''), '\s+', ' ', 'g')), '');
    IF NEW.person IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'يرجى كتابة اسم المعلمة المسؤولة عن الشاهد',
        HINT = 'evidence_person_required';
    END IF;
    IF char_length(NEW.person) < 2 OR char_length(NEW.person) > 100 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'اسم المعلمة المسؤولة يجب أن يكون بين 2 و100 حرفاً',
        HINT = 'evidence_person_length';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.link IS DISTINCT FROM OLD.link THEN
    IF coalesce(btrim(NEW.link), '') <> ''
       AND NEW.link !~* '^https://[a-z0-9.-]+\.[a-z0-9-]+(:[0-9]{1,5})?([/?#][^[:space:]]*)?$' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'الرابط غير صالح. يجب أن يبدأ بـ https://',
        HINT = 'evidence_link_https';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.evidence_link IS DISTINCT FROM OLD.evidence_link THEN
    IF coalesce(btrim(NEW.evidence_link), '') <> ''
       AND NEW.evidence_link !~* '^https://[a-z0-9.-]+\.[a-z0-9-]+(:[0-9]{1,5})?([/?#][^[:space:]]*)?$' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'الرابط غير صالح. يجب أن يبدأ بـ https://',
        HINT = 'evidence_link_https';
    END IF;
  END IF;

  link_only := coalesce(btrim(NEW.file_url), '') = ''
    AND (coalesce(btrim(NEW.link), '') <> '' OR coalesce(btrim(NEW.evidence_link), '') <> '');

  IF link_only AND (TG_OP = 'INSERT' OR NEW.file_name IS DISTINCT FROM OLD.file_name) THEN
    NEW.file_name := NULLIF(btrim(regexp_replace(coalesce(NEW.file_name, ''), '\s+', ' ', 'g')), '');
    IF NEW.file_name IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'يرجى كتابة اسم الملف أو الشاهد لكل رابط',
        HINT = 'evidence_link_label_required';
    END IF;
    IF char_length(NEW.file_name) > 150 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'اسم الملف أو الشاهد يجب ألا يتجاوز 150 حرفاً',
        HINT = 'evidence_link_label_length';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- الصلاحيات الافتراضية للمخطط تمنح anon/authenticated تنفيذ أي دالة جديدة؛ هذه تعمل كـ Trigger فقط
REVOKE ALL ON FUNCTION public.validate_evidence_attribution() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_validate_evidence_attribution ON public.evidences;
CREATE TRIGGER trg_validate_evidence_attribution
  BEFORE INSERT OR UPDATE ON public.evidences
  FOR EACH ROW EXECUTE FUNCTION public.validate_evidence_attribution();

COMMENT ON COLUMN public.evidences.person IS
  'اسم المعلمة المسؤولة كما كتبته (الحساب مشترك). إلزامي للإضافات الجديدة؛ القديم بلا اسم يُعرض «غير محدد».';
COMMENT ON COLUMN public.evidences.file_name IS
  'اسم العرض: اسم الملف المرفوع، أو الاسم المكتوب لرابط Drive. الرابط الأصلي في link دون تغيير.';

-- ------------------------------------------------------------
-- 2) سجل التنفيذ + التأكد أن لا صف ولا ملف تغيّر
-- ------------------------------------------------------------
INSERT INTO public.platform_migration_history (migration_key)
VALUES ('phase_evidence_attribution_v1')
ON CONFLICT (migration_key) DO NOTHING;

DO $post$
DECLARE
  b record;
BEGIN
  SELECT * INTO b FROM _evidence_attribution_precheck;
  IF b.evidences_cnt IS DISTINCT FROM (SELECT count(*) FROM public.evidences)
     OR b.requirements_cnt IS DISTINCT FROM (SELECT count(*) FROM public.evidence_requirements)
     OR b.programs_cnt IS DISTINCT FROM (SELECT count(*) FROM public.programs)
     OR b.indicators_cnt IS DISTINCT FROM (SELECT count(*) FROM public.program_indicators)
     OR b.storage_cnt IS DISTINCT FROM (SELECT count(*) FROM storage.objects WHERE bucket_id = 'evidences') THEN
    RAISE EXCEPTION 'STOP: تغيّرت أعداد الصفوف — تم التراجع';
  END IF;
  IF b.evidences_md5 IS DISTINCT FROM
     (SELECT md5(coalesce(string_agg(to_jsonb(e)::text, ',' ORDER BY e.id), '')) FROM public.evidences e) THEN
    RAISE EXCEPTION 'STOP: تغيّر محتوى evidences — تم التراجع';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.evidences'::regclass
                   AND tgname = 'trg_validate_evidence_attribution' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'STOP: لم يُنشأ الـ Trigger';
  END IF;
  IF has_function_privilege('anon', 'public.validate_evidence_attribution()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.validate_evidence_attribution()', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP: دالة التحقق قابلة للاستدعاء من anon/authenticated';
  END IF;
END
$post$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================
-- POSTCHECK (قراءة فقط):
--   SELECT tgname FROM pg_trigger
--     WHERE tgrelid = 'public.evidences'::regclass AND NOT tgisinternal ORDER BY tgname;
--     -- المتوقع: trg_enforce_evidence_requirement_indicator_match, trg_protect_approved_evidence_attachment,
--     --          trg_set_evidence_created_by, trg_validate_evidence_attribution
--   SELECT count(*) FROM public.evidences;                          -- 55 قبل وبعد
--   SELECT count(*) FROM public.evidences WHERE coalesce(btrim(person),'') = '';  -- 25 قبل وبعد (لم تُعدَّل)
-- ============================================================

-- تراجع (يزيل التحقق على الخادم فقط؛ لا يمس أي بيانات):
/*
BEGIN;
DROP TRIGGER IF EXISTS trg_validate_evidence_attribution ON public.evidences;
DROP FUNCTION IF EXISTS public.validate_evidence_attribution();
COMMENT ON COLUMN public.evidences.person IS NULL;
COMMENT ON COLUMN public.evidences.file_name IS NULL;
DELETE FROM public.platform_migration_history WHERE migration_key = 'phase_evidence_attribution_v1';
NOTIFY pgrst, 'reload schema';
COMMIT;
*/
