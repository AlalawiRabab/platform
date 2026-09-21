-- ============================================================
-- phase_evidence_requirements_review.sql
-- شواهد مطلوبة لكل مؤشر + اعتماد المدير
-- مراجعة / تطبيق يدوي بعد نسخة احتياطية — لا يُنفَّذ تلقائياً
-- ============================================================
-- ضوابط الأمان:
--   * بلا DROP TABLE / TRUNCATE / حذف بيانات تشغيلية
--   * بلا تعديل مسارات Storage
--   * evidences.requirement_id قابل لـ NULL أثناء الترحيل
--   * الشواهد القديمة تُرحَّل كـ «قيد المراجعة» (is_approved = false)
--   * الاعتماد للمدير فقط (admin) عبر Trigger + RLS
--   * مرفق واحد لكل requirement_id (يطابق تصميم الواجهة)
--   * تطابق evidences.indicator_id مع evidence_requirements.indicator_id
--   * created_by لاسم الشاهد من auth.uid() فقط (للجلسات المصادَق عليها)
-- ============================================================
-- ملاحظة مخطط حي (فحص 2026-09-21):
--   program_indicators.id = bigint
--   evidences.indicator_id = bigint
--   programs.id = bigint
--   evidences.id = bigint
--   auth.users.id = uuid
--   الدوال الموجودة: is_admin(), current_app_role(),
--     school_year_allows_write(uuid), school_year_allows_read(uuid),
--     school_year_is_active(uuid)
-- ============================================================
-- PRECHECK (شغّله قبل التطبيق وسجّل الأعداد):
--   SELECT COUNT(*) AS programs_cnt FROM public.programs;
--   SELECT COUNT(*) AS indicators_cnt FROM public.program_indicators;
--   SELECT COUNT(*) AS evidences_cnt FROM public.evidences;
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) جدول أسماء الشواهد المطلوبة لكل مؤشر
--    indicator_id يجب أن يطابق program_indicators.id حرفيًا = bigint
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.evidence_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  indicator_id bigint NOT NULL REFERENCES public.program_indicators(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_approved boolean NOT NULL DEFAULT false,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_requirements_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_evidence_requirements_indicator
  ON public.evidence_requirements (indicator_id);

CREATE INDEX IF NOT EXISTS idx_evidence_requirements_indicator_sort
  ON public.evidence_requirements (indicator_id, sort_order);

-- ------------------------------------------------------------
-- 2) ربط المرفق الحالي باسم الشاهد المطلوب (nullable)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'evidences'
      AND a.attname = 'requirement_id'
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) THEN
    ALTER TABLE public.evidences
      ADD COLUMN requirement_id uuid
      REFERENCES public.evidence_requirements(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_evidences_requirement_id
  ON public.evidences (requirement_id);

-- ------------------------------------------------------------
-- 3) دوال مساعدة: ملكية، اعتماد، حماية مرفق، تطابق مؤشر
-- ------------------------------------------------------------

-- 3a) updated_at
CREATE OR REPLACE FUNCTION public.set_evidence_requirements_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_evidence_requirements_updated_at ON public.evidence_requirements;
CREATE TRIGGER trg_evidence_requirements_updated_at
  BEFORE UPDATE ON public.evidence_requirements
  FOR EACH ROW EXECUTE FUNCTION public.set_evidence_requirements_updated_at();

-- 3b) created_by من الجلسة فقط (لا تزوير من العميل)
--     عند الترحيل بدون auth.uid() يُسمح بالقيمة الممرَّرة (مثل مالك الشاهد القديم)
CREATE OR REPLACE FUNCTION public.set_evidence_requirement_created_by()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NOT NULL THEN
      NEW.created_by := auth.uid();
    END IF;
    IF NEW.created_at IS NULL THEN
      NEW.created_at := now();
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: منع تغيير المالك
  NEW.created_by := OLD.created_by;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_evidence_requirement_created_by ON public.evidence_requirements;
CREATE TRIGGER trg_set_evidence_requirement_created_by
  BEFORE INSERT OR UPDATE ON public.evidence_requirements
  FOR EACH ROW EXECUTE FUNCTION public.set_evidence_requirement_created_by();

-- 3c) اعتماد المدير فقط + منع تعديل name/indicator_id والشاهد معتمد
CREATE OR REPLACE FUNCTION public.enforce_evidence_requirement_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  has_attachment boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_approved IS TRUE THEN
      IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'فقط المدير يمكنه اعتماد الشواهد';
      END IF;
      SELECT EXISTS (
        SELECT 1 FROM public.evidences e
        WHERE e.requirement_id = NEW.id
          AND (
            (e.file_url IS NOT NULL AND btrim(e.file_url) <> '')
            OR (e.link IS NOT NULL AND btrim(e.link) <> '')
            OR (e.evidence_link IS NOT NULL AND btrim(e.evidence_link) <> '')
          )
      ) INTO has_attachment;
      IF NOT has_attachment THEN
        RAISE EXCEPTION 'لا يمكن اعتماد شاهد بدون ملف أو رابط مرفق';
      END IF;
      NEW.approved_by := auth.uid();
      NEW.approved_at := now();
    ELSE
      NEW.approved_by := NULL;
      NEW.approved_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: لا تعديل الاسم أو المؤشر بينما الاعتماد ساري
  IF COALESCE(OLD.is_approved, false) IS TRUE
     AND COALESCE(NEW.is_approved, false) IS TRUE THEN
    IF (NEW.name IS DISTINCT FROM OLD.name)
       OR (NEW.indicator_id IS DISTINCT FROM OLD.indicator_id) THEN
      RAISE EXCEPTION 'لا يمكن تعديل اسم أو مؤشر شاهد معتمد. ألغِ الاعتماد أولاً';
    END IF;
  END IF;

  IF (NEW.is_approved IS DISTINCT FROM OLD.is_approved)
     OR (NEW.approved_by IS DISTINCT FROM OLD.approved_by)
     OR (NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION 'فقط المدير يمكنه اعتماد الشواهد أو إلغاء الاعتماد';
    END IF;

    IF NEW.is_approved IS TRUE THEN
      SELECT EXISTS (
        SELECT 1 FROM public.evidences e
        WHERE e.requirement_id = NEW.id
          AND (
            (e.file_url IS NOT NULL AND btrim(e.file_url) <> '')
            OR (e.link IS NOT NULL AND btrim(e.link) <> '')
            OR (e.evidence_link IS NOT NULL AND btrim(e.evidence_link) <> '')
          )
      ) INTO has_attachment;
      IF NOT has_attachment THEN
        RAISE EXCEPTION 'لا يمكن اعتماد شاهد بدون ملف أو رابط مرفق';
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

DROP TRIGGER IF EXISTS trg_enforce_evidence_requirement_approval ON public.evidence_requirements;
CREATE TRIGGER trg_enforce_evidence_requirement_approval
  BEFORE INSERT OR UPDATE ON public.evidence_requirements
  FOR EACH ROW EXECUTE FUNCTION public.enforce_evidence_requirement_approval();

-- 3d) حماية المرفق المعتمد: INSERT + UPDATE + DELETE
CREATE OR REPLACE FUNCTION public.protect_approved_evidence_attachment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  req_id uuid;
  is_appr boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.requirement_id IS NOT NULL THEN
      SELECT r.is_approved INTO is_appr
      FROM public.evidence_requirements r
      WHERE r.id = NEW.requirement_id;
      IF COALESCE(is_appr, false) THEN
        RAISE EXCEPTION 'لا يمكن إضافة مرفق لشاهد معتمد. ألغِ الاعتماد أولاً';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    req_id := OLD.requirement_id;
    IF req_id IS NOT NULL THEN
      SELECT r.is_approved INTO is_appr
      FROM public.evidence_requirements r
      WHERE r.id = req_id;
      IF COALESCE(is_appr, false) THEN
        RAISE EXCEPTION 'لا يمكن حذف مرفق شاهد معتمد. ألغِ الاعتماد أولاً';
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  req_id := COALESCE(NEW.requirement_id, OLD.requirement_id);
  IF req_id IS NOT NULL THEN
    SELECT r.is_approved INTO is_appr
    FROM public.evidence_requirements r
    WHERE r.id = req_id;
    IF COALESCE(is_appr, false) THEN
      IF (NEW.file_url IS DISTINCT FROM OLD.file_url)
         OR (NEW.link IS DISTINCT FROM OLD.link)
         OR (NEW.evidence_link IS DISTINCT FROM OLD.evidence_link)
         OR (NEW.requirement_id IS DISTINCT FROM OLD.requirement_id)
         OR (NEW.file_name IS DISTINCT FROM OLD.file_name)
         OR (NEW.file_data IS DISTINCT FROM OLD.file_data)
         OR (NEW.file_size IS DISTINCT FROM OLD.file_size) THEN
        RAISE EXCEPTION 'لا يمكن تعديل مرفق شاهد معتمد. ألغِ الاعتماد أولاً';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_approved_evidence_attachment ON public.evidences;
CREATE TRIGGER trg_protect_approved_evidence_attachment
  BEFORE INSERT OR UPDATE OR DELETE ON public.evidences
  FOR EACH ROW EXECUTE FUNCTION public.protect_approved_evidence_attachment();

-- 3e) تطابق indicator_id مع اسم الشاهد المطلوب عند وجود requirement_id
CREATE OR REPLACE FUNCTION public.enforce_evidence_requirement_indicator_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  req_indicator_id bigint;
BEGIN
  IF NEW.requirement_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT r.indicator_id INTO req_indicator_id
  FROM public.evidence_requirements r
  WHERE r.id = NEW.requirement_id;

  IF req_indicator_id IS NULL THEN
    RAISE EXCEPTION 'اسم الشاهد المطلوب غير موجود';
  END IF;

  IF NEW.indicator_id IS DISTINCT FROM req_indicator_id THEN
    RAISE EXCEPTION 'indicator_id للمرفق يجب أن يطابق مؤشر اسم الشاهد المطلوب';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_evidence_requirement_indicator_match ON public.evidences;
CREATE TRIGGER trg_enforce_evidence_requirement_indicator_match
  BEFORE INSERT OR UPDATE ON public.evidences
  FOR EACH ROW EXECUTE FUNCTION public.enforce_evidence_requirement_indicator_match();

-- ------------------------------------------------------------
-- 4) Backfill آمن للشواهد القديمة (مرة واحدة لكل سجل بلا requirement_id)
--    الحالة: قيد المراجعة — لا اعتماد تلقائي
-- ------------------------------------------------------------
DO $$
DECLARE
  r record;
  new_req_id uuid;
  next_ord integer;
  req_name text;
BEGIN
  FOR r IN
    SELECT e.*
    FROM public.evidences e
    WHERE e.indicator_id IS NOT NULL
      AND e.requirement_id IS NULL
    ORDER BY e.indicator_id, e.created_at NULLS LAST, e.id
  LOOP
    SELECT COALESCE(MAX(er.sort_order), 0) + 1
      INTO next_ord
    FROM public.evidence_requirements er
    WHERE er.indicator_id = r.indicator_id;

    req_name := COALESCE(
      NULLIF(btrim(COALESCE(r.title, '')), ''),
      NULLIF(btrim(COALESCE(r.file_name, '')), ''),
      'شاهد سابق'
    );

    INSERT INTO public.evidence_requirements (
      indicator_id, name, sort_order, is_approved,
      approved_by, approved_at, created_by, created_at
    ) VALUES (
      r.indicator_id,
      req_name,
      next_ord,
      false,
      NULL,
      NULL,
      r.created_by,
      COALESCE(r.created_at, now())
    )
    RETURNING id INTO new_req_id;

    UPDATE public.evidences
    SET requirement_id = new_req_id
    WHERE id = r.id
      AND requirement_id IS NULL;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 4b) فهرس فريد جزئي: مرفق واحد لكل اسم شاهد (يطابق الواجهة)
--     الواجهة: getEvidenceForRequirement يأخذ أحدث مرفق،
--     وsaveEvidence يستبدل عبر UPDATE بدل إدراج ثانٍ.
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_evidences_one_per_requirement
  ON public.evidences (requirement_id)
  WHERE requirement_id IS NOT NULL;

-- ------------------------------------------------------------
-- 5) RLS — الأدوار: admin / vice / teacher
-- ------------------------------------------------------------
ALTER TABLE public.evidence_requirements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS evidence_requirements_select ON public.evidence_requirements;
DROP POLICY IF EXISTS evidence_requirements_insert ON public.evidence_requirements;
DROP POLICY IF EXISTS evidence_requirements_update ON public.evidence_requirements;
DROP POLICY IF EXISTS evidence_requirements_delete ON public.evidence_requirements;

CREATE POLICY evidence_requirements_select ON public.evidence_requirements
  FOR SELECT TO authenticated
  USING (
    public.current_app_role() IN ('admin', 'vice', 'teacher')
    AND EXISTS (
      SELECT 1
      FROM public.program_indicators AS pi
      JOIN public.programs AS pr ON pr.id = pi.program_id
      WHERE pi.id = indicator_id
        AND public.school_year_allows_read(pr.school_year_id)
    )
  );

CREATE POLICY evidence_requirements_insert ON public.evidence_requirements
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_app_role() IN ('admin', 'vice')
    AND EXISTS (
      SELECT 1
      FROM public.program_indicators AS pi
      JOIN public.programs AS pr ON pr.id = pi.program_id
      WHERE pi.id = indicator_id
        AND public.school_year_allows_write(pr.school_year_id)
    )
  );

CREATE POLICY evidence_requirements_update ON public.evidence_requirements
  FOR UPDATE TO authenticated
  USING (
    public.current_app_role() IN ('admin', 'vice')
    AND EXISTS (
      SELECT 1
      FROM public.program_indicators AS pi
      JOIN public.programs AS pr ON pr.id = pi.program_id
      WHERE pi.id = indicator_id
        AND public.school_year_allows_write(pr.school_year_id)
    )
  )
  WITH CHECK (
    public.current_app_role() IN ('admin', 'vice')
    AND EXISTS (
      SELECT 1
      FROM public.program_indicators AS pi
      JOIN public.programs AS pr ON pr.id = pi.program_id
      WHERE pi.id = indicator_id
        AND public.school_year_allows_write(pr.school_year_id)
    )
  );

CREATE POLICY evidence_requirements_delete ON public.evidence_requirements
  FOR DELETE TO authenticated
  USING (
    public.is_admin()
    AND EXISTS (
      SELECT 1
      FROM public.program_indicators AS pi
      JOIN public.programs AS pr ON pr.id = pi.program_id
      WHERE pi.id = indicator_id
        AND public.school_year_allows_write(pr.school_year_id)
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.evidence_requirements TO authenticated;

REVOKE ALL ON FUNCTION public.set_evidence_requirement_created_by() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_evidence_requirement_approval() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_approved_evidence_attachment() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_evidence_requirement_indicator_match() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_evidence_requirements_updated_at() FROM PUBLIC;

COMMIT;

-- ============================================================
-- POSTCHECK (بعد التطبيق — يجب ألا تنقص الأعداد):
--   SELECT COUNT(*) AS programs_cnt FROM public.programs;
--   SELECT COUNT(*) AS indicators_cnt FROM public.program_indicators;
--   SELECT COUNT(*) AS evidences_cnt FROM public.evidences;
--   SELECT COUNT(*) AS requirements_cnt FROM public.evidence_requirements;
--   SELECT COUNT(*) AS linked_evidences
--     FROM public.evidences WHERE requirement_id IS NOT NULL;
--   SELECT COUNT(*) AS approved_cnt
--     FROM public.evidence_requirements WHERE is_approved = true;
--     -- المتوقع بعد الترحيل الأول: 0 معتمد تلقائياً
-- ============================================================
