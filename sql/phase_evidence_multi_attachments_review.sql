-- ============================================================
-- phase_evidence_multi_attachments_review.sql
-- عدة مرفقات (ملفات وروابط) تحت اسم الشاهد المطلوب نفسه
-- + اعتماد مستقل لكل مرفق
-- مراجعة / تطبيق يدوي في محرر SQL بعد نسخة احتياطية
-- لا يُنفَّذ تلقائياً ولا يُشغَّل على الإنتاج من المستودع
-- ============================================================
-- المتطلب السابق: phase_evidence_requirements_review.sql مطبَّق
--   (جدول evidence_requirements وعمود evidences.requirement_id)
--
-- ماذا يفعل:
--   * يزيل قيد «مرفق واحد لكل اسم شاهد» دون حذف أي صف
--   * يضيف اعتماداً مستقلاً على كل مرفق (is_approved / approved_by / approved_at)
--   * ينسخ الاعتماد الحالي من اسم الشاهد إلى مرفقه الموجود حتى تبقى النسب كما هي
--   * يسمح بإضافة مرفقات جديدة حتى لو وُجد مرفق معتمد على الاسم نفسه
--   * الاعتماد وإلغاؤه للقائدة (admin) فقط عبر Trigger
--   * المعلمة تبقى قادرة على الإضافة حسب سياسات RLS الحالية
--   * لا يمس مسارات Storage ولا سياسات التخزين الخاص ولا صلاحيات المستخدمين
--   * لا DROP TABLE ولا TRUNCATE ولا DELETE لبيانات تشغيلية
-- ============================================================

BEGIN;

-- سجل دائم ومحمي للترقيات. تسجيل التنفيذ ونسخ الاعتمادات في المعاملة نفسها.
CREATE TABLE IF NOT EXISTS public.platform_migration_history (
  migration_key text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.platform_migration_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_migration_history FROM PUBLIC, anon, authenticated;

CREATE TEMP TABLE _evidence_multi_precheck AS
SELECT
  (SELECT COUNT(*) FROM public.evidences) AS evidences_cnt,
  (SELECT COUNT(*) FROM public.evidence_requirements) AS requirements_cnt,
  (SELECT COUNT(*) FROM public.programs) AS programs_cnt;

-- ------------------------------------------------------------
-- 1) أعمدة الاعتماد على المرفق نفسه
-- ------------------------------------------------------------
ALTER TABLE public.evidences
  ADD COLUMN IF NOT EXISTS is_approved boolean NOT NULL DEFAULT false;

ALTER TABLE public.evidences
  ADD COLUMN IF NOT EXISTS approved_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'evidences_approved_by_fkey'
      AND conrelid = 'public.evidences'::regclass
  ) THEN
    ALTER TABLE public.evidences
      ADD CONSTRAINT evidences_approved_by_fkey
      FOREIGN KEY (approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.evidences
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

COMMENT ON COLUMN public.evidences.is_approved IS
  'اعتماد هذا المرفق وحده. نسبة الشاهد = المعتمد ÷ إجمالي المرفقات.';

-- ------------------------------------------------------------
-- 2) نسخ الاعتماد الحالي مرة واحدة فقط، بسجل دائم داخل المعاملة
--    شاهد كان معتمداً بمرفق واحد يبقى 1/1 = 100٪
-- ------------------------------------------------------------
DO $$
DECLARE
  n integer := 0;
  has_evidence_link boolean;
  first_application boolean;
BEGIN
  -- ON CONFLICT يمنع نسخ الاعتمادات ثانية، حتى مع تنفيذ متزامن.
  -- إذا فشلت أي خطوة لاحقة، تتراجع العلامة والنسخ معاً بواسطة ROLLBACK.
  INSERT INTO public.platform_migration_history (migration_key)
  VALUES ('phase_evidence_multi_attachments_review_v1')
  ON CONFLICT (migration_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  first_application := n = 1;
  IF NOT first_application THEN
    RAISE NOTICE 'legacy approval backfill skipped: migration already applied';
    RETURN;
  END IF;
  n := 0;
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'evidences'
      AND column_name = 'evidence_link'
  ) INTO has_evidence_link;

  IF has_evidence_link THEN
    UPDATE public.evidences e
    SET is_approved = true,
        approved_by = r.approved_by,
        approved_at = COALESCE(r.approved_at, now())
    FROM public.evidence_requirements r
    WHERE e.requirement_id = r.id
      AND COALESCE(r.is_approved, false) IS TRUE
      AND COALESCE(e.is_approved, false) IS NOT TRUE
      AND (
        COALESCE(btrim(e.file_url), '') <> ''
        OR COALESCE(btrim(e.link), '') <> ''
        OR COALESCE(btrim(e.evidence_link), '') <> ''
      );
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    UPDATE public.evidences e
    SET is_approved = true,
        approved_by = r.approved_by,
        approved_at = COALESCE(r.approved_at, now())
    FROM public.evidence_requirements r
    WHERE e.requirement_id = r.id
      AND COALESCE(r.is_approved, false) IS TRUE
      AND COALESCE(e.is_approved, false) IS NOT TRUE
      AND (
        COALESCE(btrim(e.file_url), '') <> ''
        OR COALESCE(btrim(e.link), '') <> ''
      );
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;
  RAISE NOTICE 'backfilled attachment approvals: %', n;
END $$;

-- ------------------------------------------------------------
-- 3) إزالة قيد المرفق الواحد (فهرس فريد جزئي أو قيد بنفس الاسم)
-- ------------------------------------------------------------
ALTER TABLE public.evidences
  DROP CONSTRAINT IF EXISTS uq_evidences_one_per_requirement;

DROP INDEX IF EXISTS public.uq_evidences_one_per_requirement;

-- الفهرس غير الفريد يبقى لتسريع الجلب حسب اسم الشاهد
CREATE INDEX IF NOT EXISTS idx_evidences_requirement_id
  ON public.evidences (requirement_id);

CREATE INDEX IF NOT EXISTS idx_evidences_requirement_approval
  ON public.evidences (requirement_id, is_approved);

-- ------------------------------------------------------------
-- 4) اعتماد المرفق: القائدة فقط، ومنع تعديل/حذف المرفق المعتمد
--    الإضافة مسموحة حتى لو كانت مرفقات أخرى على الاسم نفسه معتمدة
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.evidence_attachment_present(row_data jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    COALESCE(btrim(row_data->>'file_url'), '') <> ''
    OR COALESCE(btrim(row_data->>'link'), '') <> ''
    OR COALESCE(btrim(row_data->>'evidence_link'), '') <> '';
$$;

CREATE OR REPLACE FUNCTION public.protect_approved_evidence_attachment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.is_approved, false) IS TRUE THEN
      IF NOT COALESCE(public.is_admin(), false) THEN
        RAISE EXCEPTION 'فقط القائدة يمكنها اعتماد المرفقات';
      END IF;
      IF NOT public.evidence_attachment_present(to_jsonb(NEW)) THEN
        RAISE EXCEPTION 'لا يمكن اعتماد مرفق بدون ملف أو رابط';
      END IF;
      NEW.approved_by := auth.uid();
      NEW.approved_at := now();
    ELSE
      NEW.is_approved := false;
      NEW.approved_by := NULL;
      NEW.approved_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF COALESCE(OLD.is_approved, false) IS TRUE THEN
      RAISE EXCEPTION 'لا يمكن حذف مرفق معتمد. ألغِ الاعتماد أولاً';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE: لا تعديل لمحتوى مرفق معتمد إلا بعد إلغاء الاعتماد
  IF COALESCE(OLD.is_approved, false) IS TRUE THEN
    IF (to_jsonb(NEW) - 'is_approved' - 'approved_by' - 'approved_at')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'is_approved' - 'approved_by' - 'approved_at') THEN
      RAISE EXCEPTION 'لا يمكن تعديل مرفق معتمد. ألغِ الاعتماد أولاً';
    END IF;
  END IF;

  IF (NEW.is_approved IS DISTINCT FROM OLD.is_approved)
     OR (NEW.approved_by IS DISTINCT FROM OLD.approved_by)
     OR (NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'فقط القائدة يمكنها اعتماد المرفقات أو إلغاء الاعتماد';
    END IF;

    IF COALESCE(NEW.is_approved, false) IS TRUE THEN
      IF NOT public.evidence_attachment_present(to_jsonb(NEW)) THEN
        RAISE EXCEPTION 'لا يمكن اعتماد مرفق بدون ملف أو رابط';
      END IF;
      NEW.approved_by := auth.uid();
      NEW.approved_at := now();
    ELSE
      NEW.is_approved := false;
      NEW.approved_by := NULL;
      NEW.approved_at := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_approved_evidence_attachment ON public.evidences;
CREATE TRIGGER trg_protect_approved_evidence_attachment
  BEFORE INSERT OR UPDATE OR DELETE ON public.evidences
  FOR EACH ROW EXECUTE FUNCTION public.protect_approved_evidence_attachment();

-- ------------------------------------------------------------
-- 5) قفل اسم الشاهد طالما أحد مرفقاته معتمد
--    علم evidence_requirements.is_approved يبقى كما هو (سجل تاريخي)
--    ولم يعد يمنع إضافة مرفقات جديدة
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_evidence_requirement_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  has_approved_attachment boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.is_approved, false) IS TRUE THEN
      IF NOT COALESCE(public.is_admin(), false) THEN
        RAISE EXCEPTION 'فقط القائدة يمكنها اعتماد الشواهد';
      END IF;
      NEW.approved_by := auth.uid();
      NEW.approved_at := now();
    ELSE
      NEW.is_approved := false;
      NEW.approved_by := NULL;
      NEW.approved_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.evidences e
    WHERE e.requirement_id = OLD.id
      AND COALESCE(e.is_approved, false) IS TRUE
  ) INTO has_approved_attachment;

  IF COALESCE(has_approved_attachment, false) IS TRUE THEN
    IF (NEW.name IS DISTINCT FROM OLD.name)
       OR (NEW.indicator_id IS DISTINCT FROM OLD.indicator_id) THEN
      RAISE EXCEPTION 'لا يمكن تعديل اسم أو مؤشر شاهد له مرفق معتمد. ألغِ الاعتماد أولاً';
    END IF;
  END IF;

  IF (NEW.is_approved IS DISTINCT FROM OLD.is_approved)
     OR (NEW.approved_by IS DISTINCT FROM OLD.approved_by)
     OR (NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'فقط القائدة يمكنها اعتماد الشواهد أو إلغاء الاعتماد';
    END IF;
    IF COALESCE(NEW.is_approved, false) IS TRUE THEN
      NEW.approved_by := auth.uid();
      NEW.approved_at := now();
    ELSE
      NEW.is_approved := false;
      NEW.approved_by := NULL;
      NEW.approved_at := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_evidence_requirement_approval ON public.evidence_requirements;
CREATE TRIGGER trg_enforce_evidence_requirement_approval
  BEFORE INSERT OR UPDATE ON public.evidence_requirements
  FOR EACH ROW EXECUTE FUNCTION public.enforce_evidence_requirement_approval();

-- منع حذف اسم الشاهد بينما أحد مرفقاته معتمد (المرفقات نفسها لا تُحذف)
CREATE OR REPLACE FUNCTION public.prevent_delete_requirement_with_approved_attachment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.evidences e
    WHERE e.requirement_id = OLD.id
      AND COALESCE(e.is_approved, false) IS TRUE
  ) THEN
    RAISE EXCEPTION 'ألغِ اعتماد المرفقات أولاً قبل حذف اسم الشاهد';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_delete_requirement_with_approved_attachment
  ON public.evidence_requirements;
CREATE TRIGGER trg_prevent_delete_requirement_with_approved_attachment
  BEFORE DELETE ON public.evidence_requirements
  FOR EACH ROW EXECUTE FUNCTION public.prevent_delete_requirement_with_approved_attachment();

REVOKE ALL ON FUNCTION public.evidence_attachment_present(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_approved_evidence_attachment() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_evidence_requirement_approval() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_delete_requirement_with_approved_attachment() FROM PUBLIC;

-- ------------------------------------------------------------
-- 6) تأكد أن عدد الصفوف لم ينقص
-- ------------------------------------------------------------
DO $$
DECLARE
  before_ev bigint;
  after_ev bigint;
  before_req bigint;
  after_req bigint;
  before_prog bigint;
  after_prog bigint;
BEGIN
  SELECT evidences_cnt, requirements_cnt, programs_cnt
    INTO before_ev, before_req, before_prog
  FROM _evidence_multi_precheck;

  SELECT COUNT(*) INTO after_ev FROM public.evidences;
  SELECT COUNT(*) INTO after_req FROM public.evidence_requirements;
  SELECT COUNT(*) INTO after_prog FROM public.programs;

  IF before_ev IS DISTINCT FROM after_ev
     OR before_req IS DISTINCT FROM after_req
     OR before_prog IS DISTINCT FROM after_prog THEN
    RAISE EXCEPTION
      'row counts changed evidences %->% requirements %->% programs %->%',
      before_ev, after_ev, before_req, after_req, before_prog, after_prog;
  END IF;
END $$;

DROP TABLE IF EXISTS _evidence_multi_precheck;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- الاختبارات المستقلة مرفقة في migration-tests.mjs.
-- تشغيلها: npm install --no-save @electric-sql/pglite
-- ثم: node migration-tests.mjs
-- لا تتصل بقاعدة الإنتاج.

-- ============================================================
-- بعد التطبيق (راجع الأعداد، ولا يُتوقع نقص):
--   SELECT COUNT(*) AS evidences_cnt FROM public.evidences;
--   SELECT COUNT(*) AS requirements_cnt FROM public.evidence_requirements;
--   SELECT COUNT(*) AS approved_attachments
--     FROM public.evidences WHERE is_approved IS TRUE;
--   SELECT COUNT(*) AS approved_requirements_kept
--     FROM public.evidence_requirements WHERE is_approved IS TRUE;
--   SELECT indexname FROM pg_indexes
--     WHERE schemaname = 'public'
--       AND indexname = 'uq_evidences_one_per_requirement';
--     -- المتوقع: لا صفوف
-- ============================================================