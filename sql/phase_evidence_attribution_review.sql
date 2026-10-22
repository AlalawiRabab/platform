-- ============================================================
-- REVIEW ONLY — DO NOT RUN AUTOMATICALLY. Manual apply in the SQL Editor after separate approval.
-- ============================================================
-- phase_evidence_attribution_review.sql
-- اسم المعلمة المسؤولة + اسم عرض رابط Drive + https — تحقق على الخادم للعمليات الجديدة فقط
-- مراجعة / تطبيق يدوي في محرر SQL — لا يُنفَّذ تلقائياً ولا من المستودع
-- Rollback مستقل: sql/phase_evidence_attribution_rollback_review.sql
-- تفعيل الإلزام الكامل لاحقاً (خطوة منفصلة بعد نشر الواجهة الجديدة): sql/phase_evidence_attribution_strict_review.sql
-- ============================================================
-- المتطلب السابق: phase_evidence_multi_attachments_review.sql مطبَّق (مسجَّل في platform_migration_history)
--
-- ماذا يفعل:
--   * Trigger قبل INSERT/UPDATE على public.evidences (لا يمس أي صف موجود) بوضعين:
--     - الوضع المتوافق (افتراضي بعد هذا الملف؛ الواجهة القديمة تعمل كاملة):
--         تُزال المسافات الزائدة من person وfile_name، والرابط إن وُجد يجب أن يكون http(s) بلا مسافات
--         (يرفض javascript: وdata: وأي بروتوكول آخر)، دون إلزام الاسم أو اسم الرابط.
--     - الوضع الصارم (بعد sql/phase_evidence_attribution_strict_review.sql فقط):
--         INSERT: person إلزامي (2–100 حرف)، ولمرفق رابط فقط (بلا file_url) file_name إلزامي (1–150 حرفاً)،
--         والرابط https:// فقط.
--     - UPDATE في الوضعين: لا يتحقق إلا من الحقول التي تغيّرت فعلاً؛ لذلك اعتماد/إلغاء اعتماد
--         الشواهد القديمة (بلا اسم معلمة) يبقى يعمل دون تغيير.
--     - الوضع يُقرأ من وجود المفتاح phase_evidence_attribution_strict_v1 في platform_migration_history؛
--       لذلك الدالة SECURITY DEFINER بـ search_path فارغ وأسماء مؤهلة، وتنفيذها مسحوب من كل أدوار المستخدمين.
--   * لا أعمدة جديدة: person (text, nullable) موجود أصلاً لاسم المعلمة، وfile_name (text, nullable)
--     موجود أصلاً لاسم العرض. الرابط الأصلي يبقى في link كما هو.
--   * لا NOT NULL ولا CHECK ولا DEFAULT، ولا UPDATE/DELETE لأي بيانات، ولا اسم افتراضي للسجلات القديمة.
--   * لا يغيّر RLS ولا صلاحيات الأدوار ولا الاعتماد ولا Storage ولا تعليق العمود file_name الحالي.
-- ============================================================

BEGIN;

DO $pre$
DECLARE
  person_comment text;
BEGIN
  IF to_regclass('public.evidences') IS NULL THEN
    RAISE EXCEPTION 'STOP: جدول public.evidences غير موجود';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'evidences'
        AND column_name IN ('person', 'file_name', 'file_url', 'link', 'evidence_link')
        AND data_type = 'text' AND is_nullable = 'YES') <> 5 THEN
    RAISE EXCEPTION 'STOP: أعمدة person/file_name/file_url/link/evidence_link ليست كلها text قابلة لـ NULL';
  END IF;
  IF to_regprocedure('public.protect_approved_evidence_attachment()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.platform_migration_history
                    WHERE migration_key = 'phase_evidence_multi_attachments_review_v1') THEN
    RAISE EXCEPTION 'STOP: طبّق phase_evidence_multi_attachments_review.sql أولاً';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.evidences'::regclass) THEN
    RAISE EXCEPTION 'STOP: RLS غير مفعّل على evidences';
  END IF;
  -- الـ Rollback يعيد تعليق person إلى NULL؛ لذا يجب ألا يكون له تعليق آخر غير تعليق هذا الملف
  SELECT col_description('public.evidences'::regclass, a.attnum) INTO person_comment
  FROM pg_attribute a WHERE a.attrelid = 'public.evidences'::regclass AND a.attname = 'person';
  IF person_comment IS NOT NULL AND person_comment NOT LIKE 'اسم المعلمة المسؤولة كما كتبته%' THEN
    RAISE EXCEPTION 'STOP: للعمود person تعليق سابق؛ راجع الـ Rollback قبل التطبيق';
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
  (SELECT md5(coalesce(string_agg(e.id::text || '|' || coalesce(e.link, '') || '|' || coalesce(e.evidence_link, ''), ',' ORDER BY e.id), ''))
     FROM public.evidences e) AS links_md5,
  (SELECT count(*) FROM storage.objects WHERE bucket_id = 'evidences') AS storage_cnt,
  (SELECT md5(coalesce(string_agg(o.id::text || '|' || o.name, ',' ORDER BY o.name), ''))
     FROM storage.objects o WHERE o.bucket_id = 'evidences') AS storage_md5,
  (SELECT col_description('public.evidences'::regclass, a.attnum) FROM pg_attribute a
     WHERE a.attrelid = 'public.evidences'::regclass AND a.attname = 'file_name') AS file_name_comment;

-- ------------------------------------------------------------
-- 1) دالة التحقق — تعمل على NEW فقط، وتقرأ مفتاح الوضع الصارم من platform_migration_history
--    (SECURITY DEFINER لأن الجدول غير مقروء لأدوار المستخدمين؛ search_path فارغ وكل الأسماء مؤهلة)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_evidence_attribution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  link_only boolean;
  strict_mode boolean;
  url_pattern text;
  url_message constant text := 'الرابط غير صالح. يجب أن يبدأ بـ https://';
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.platform_migration_history AS h
                 WHERE h.migration_key = 'phase_evidence_attribution_strict_v1')
    INTO strict_mode;
  -- الوضع المتوافق يقبل http أيضاً لأن الواجهة القديمة تقبله؛ الصارم https فقط
  url_pattern := CASE WHEN strict_mode
    THEN '^https://[a-z0-9.-]+\.[a-z0-9-]+(:[0-9]{1,5})?([/?#][^[:space:]]*)?$'
    ELSE '^https?://[a-z0-9.-]+\.[a-z0-9-]+(:[0-9]{1,5})?([/?#][^[:space:]]*)?$' END;

  IF TG_OP = 'INSERT' OR NEW.person IS DISTINCT FROM OLD.person THEN
    NEW.person := NULLIF(btrim(regexp_replace(coalesce(NEW.person, ''), '\s+', ' ', 'g')), '');
    IF strict_mode AND NEW.person IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'يرجى كتابة اسم المعلمة المسؤولة عن الشاهد',
        HINT = 'evidence_person_required';
    END IF;
    IF strict_mode AND (char_length(NEW.person) < 2 OR char_length(NEW.person) > 100) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'اسم المعلمة المسؤولة يجب أن يكون بين 2 و100 حرفاً',
        HINT = 'evidence_person_length';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.link IS DISTINCT FROM OLD.link THEN
    IF coalesce(btrim(NEW.link), '') <> '' AND NEW.link !~* url_pattern THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = url_message, HINT = 'evidence_link_protocol';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.evidence_link IS DISTINCT FROM OLD.evidence_link THEN
    IF coalesce(btrim(NEW.evidence_link), '') <> '' AND NEW.evidence_link !~* url_pattern THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = url_message, HINT = 'evidence_link_protocol';
    END IF;
  END IF;

  link_only := coalesce(btrim(NEW.file_url), '') = ''
    AND (coalesce(btrim(NEW.link), '') <> '' OR coalesce(btrim(NEW.evidence_link), '') <> '');

  IF link_only AND (TG_OP = 'INSERT' OR NEW.file_name IS DISTINCT FROM OLD.file_name) THEN
    NEW.file_name := NULLIF(btrim(regexp_replace(coalesce(NEW.file_name, ''), '\s+', ' ', 'g')), '');
    IF strict_mode AND NEW.file_name IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'يرجى كتابة اسم الملف أو الشاهد لكل رابط',
        HINT = 'evidence_link_label_required';
    END IF;
    IF strict_mode AND char_length(NEW.file_name) > 150 THEN
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

-- ------------------------------------------------------------
-- 2) سجل التنفيذ: 1 في التشغيل الأول، 0 عند إعادة التشغيل، وأي قيمة أخرى توقف
-- ------------------------------------------------------------
DO $hist$
DECLARE
  n integer;
BEGIN
  INSERT INTO public.platform_migration_history (migration_key)
  VALUES ('phase_evidence_attribution_v1')
  ON CONFLICT (migration_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n NOT IN (0, 1) THEN
    RAISE EXCEPTION 'STOP: سجل التنفيذ أدخل % صفوف (المسموح 0 أو 1)', n;
  END IF;
  IF (SELECT count(*) FROM public.platform_migration_history
      WHERE migration_key = 'phase_evidence_attribution_v1') <> 1 THEN
    RAISE EXCEPTION 'STOP: migration_key غير موجود مرة واحدة بالضبط';
  END IF;
END
$hist$;

-- ------------------------------------------------------------
-- 3) Postchecks: لا صف ولا رابط ولا ملف ولا تعليق file_name تغيّر
-- ------------------------------------------------------------
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
  IF b.links_md5 IS DISTINCT FROM
     (SELECT md5(coalesce(string_agg(e.id::text || '|' || coalesce(e.link, '') || '|' || coalesce(e.evidence_link, ''), ',' ORDER BY e.id), ''))
      FROM public.evidences e) THEN
    RAISE EXCEPTION 'STOP: تغيّرت روابط Drive — تم التراجع';
  END IF;
  IF b.storage_md5 IS DISTINCT FROM
     (SELECT md5(coalesce(string_agg(o.id::text || '|' || o.name, ',' ORDER BY o.name), ''))
      FROM storage.objects o WHERE o.bucket_id = 'evidences') THEN
    RAISE EXCEPTION 'STOP: تغيّرت ملفات Storage — تم التراجع';
  END IF;
  IF b.file_name_comment IS DISTINCT FROM
     (SELECT col_description('public.evidences'::regclass, a.attnum) FROM pg_attribute a
      WHERE a.attrelid = 'public.evidences'::regclass AND a.attname = 'file_name') THEN
    RAISE EXCEPTION 'STOP: تغيّر تعليق file_name — تم التراجع';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = 'public.evidences'::regclass
               AND a.attname IN ('person', 'file_name', 'link') AND a.attnotnull) THEN
    RAISE EXCEPTION 'STOP: أصبح أحد الأعمدة NOT NULL';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.evidences'::regclass
                   AND tgname = 'trg_validate_evidence_attribution' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'STOP: لم يُنشأ الـ Trigger';
  END IF;
  IF has_function_privilege('public', 'public.validate_evidence_attribution()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.validate_evidence_attribution()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.validate_evidence_attribution()', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP: دالة التحقق قابلة للاستدعاء من PUBLIC/anon/authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                 WHERE oid = 'public.validate_evidence_attribution()'::regprocedure
                   AND prosecdef AND array_to_string(proconfig, ',') = 'search_path=""') THEN
    RAISE EXCEPTION 'STOP: دالة التحقق ليست SECURITY DEFINER بـ search_path فارغ';
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
--   SELECT migration_key FROM public.platform_migration_history WHERE migration_key LIKE 'phase_evidence_attribution%';
--     -- المتوقع بعد هذا الملف: phase_evidence_attribution_v1 فقط (الوضع المتوافق)
-- ============================================================

-- تراجع كامل (يزيل التحقق على الخادم بوضعيه؛ لا يحذف أعمدة ولا يمس أي بيانات):
/*
BEGIN;
DROP TRIGGER IF EXISTS trg_validate_evidence_attribution ON public.evidences;
DROP FUNCTION IF EXISTS public.validate_evidence_attribution();
COMMENT ON COLUMN public.evidences.person IS NULL;
DELETE FROM public.platform_migration_history
WHERE migration_key IN ('phase_evidence_attribution_v1', 'phase_evidence_attribution_strict_v1');
NOTIFY pgrst, 'reload schema';
COMMIT;
*/
