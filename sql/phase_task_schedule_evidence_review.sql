-- ============================================================
-- phase_task_schedule_evidence_review.sql
-- وقت بدء/انتهاء المهمة + رابط Google Drive كشاهد للمهمة
-- مراجعة / تطبيق يدوي بعد نسخة احتياطية — لا يُنفَّذ تلقائياً
-- ============================================================
-- ضوابط الأمان:
--   * بلا DROP TABLE / TRUNCATE / DELETE / حذف أعمدة
--   * المهام القديمة: start_at و end_at تبقى NULL (لا افتراض أوقات)
--     due_date القديم لا يُمس ويظل يُعرض كـ «تاريخ الاستحقاق»
--   * المهام الجديدة: start_at و end_at إلزاميان (Trigger) و end_at > start_at (CHECK)
--   * رابط الشاهد: https://drive.google.com أو https://docs.google.com فقط (CHECK)
--   * اعتماد شاهد المهمة للمدير فقط (نفس قاعدة evidence_requirements):
--       - الوكيلة تضيف/تعدّل الرابط واسمه دون اعتماد
--       - لا اعتماد بدون رابط
--       - الشاهد المعتمد مقفل: لا تعديل للرابط أو الاسم قبل إلغاء الاعتماد
--   * لا تغيير على سياسات RLS الخاصة بـ tasks:
--       SELECT/INSERT/UPDATE: admin + vice (ضمن سنة قابلة للكتابة)
--       DELETE: admin فقط — المعلمة بلا وصول
-- ============================================================

-- ############################################################################
-- PRECHECK (قراءة فقط) — سجّل النتائج قبل التطبيق
-- ############################################################################

-- P1) الأعمدة الحالية لجدول tasks
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'tasks'
ORDER BY ordinal_position;

-- P2) أعداد المهام قبل الترحيل
SELECT
  COUNT(*)                                   AS tasks_total,
  COUNT(*) FILTER (WHERE due_date IS NOT NULL) AS tasks_with_due_date
FROM public.tasks;

-- P3) سياسات tasks الحالية (المتوقع: tasks_select/insert/update/delete فقط)
SELECT policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'tasks'
ORDER BY policyname;

-- P4) الدوال المطلوبة
SELECT p.proname
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('is_admin', 'current_app_role');
-- المتوقع: صفّان


-- ############################################################################
-- TRANSACTION
-- عند أي خطأ: نفّذ ROLLBACK; صراحة قبل إعادة المحاولة.
-- ############################################################################

BEGIN;

-- ------------------------------------------------------------
-- 1) أعمدة جديدة (كلها nullable أو بقيمة افتراضية آمنة)
-- ------------------------------------------------------------
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS start_at timestamptz,
  ADD COLUMN IF NOT EXISTS end_at timestamptz,
  ADD COLUMN IF NOT EXISTS evidence_drive_url text,
  ADD COLUMN IF NOT EXISTS evidence_title text,
  ADD COLUMN IF NOT EXISTS evidence_added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS evidence_added_at timestamptz,
  ADD COLUMN IF NOT EXISTS evidence_approved boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS evidence_approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS evidence_approved_at timestamptz;

COMMENT ON COLUMN public.tasks.start_at IS
  'بداية المهمة (timestamptz — تُخزَّن UTC وتُعرض بتوقيت المستخدم). NULL للمهام القديمة فقط.';
COMMENT ON COLUMN public.tasks.end_at IS
  'نهاية المهمة (timestamptz). يجب أن تكون بعد start_at. NULL للمهام القديمة فقط.';
COMMENT ON COLUMN public.tasks.due_date IS
  'تاريخ الاستحقاق (قديم). للمهام الجديدة تضبطه الواجهة = تاريخ end_at المحلي للتوافق مع اللوحة والتقويم.';
COMMENT ON COLUMN public.tasks.evidence_drive_url IS
  'رابط Google Drive كشاهد للمهمة (https://drive.google.com أو https://docs.google.com فقط).';
COMMENT ON COLUMN public.tasks.evidence_approved IS
  'اعتماد شاهد المهمة — المدير فقط عبر trg_tasks_enforce_evidence.';

-- ------------------------------------------------------------
-- 2) قيود التحقق
--    لا تفشل على المهام القديمة لأن start_at/end_at/evidence_* فيها NULL
-- ------------------------------------------------------------
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_schedule_pair_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_schedule_pair_check
  CHECK ((start_at IS NULL) = (end_at IS NULL));

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_schedule_order_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_schedule_order_check
  CHECK (start_at IS NULL OR end_at IS NULL OR end_at > start_at);

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_evidence_drive_url_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_evidence_drive_url_check
  CHECK (
    evidence_drive_url IS NULL
    OR (
      length(evidence_drive_url) <= 2048
      AND evidence_drive_url ~ '^https://(drive|docs)\.google\.com/[^[:space:]<>"''`\\]*$'
    )
  );

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_evidence_title_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_evidence_title_check
  CHECK (
    evidence_title IS NULL
    OR (
      evidence_drive_url IS NOT NULL
      AND length(btrim(evidence_title)) BETWEEN 1 AND 200
    )
  );

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_evidence_approval_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_evidence_approval_check
  CHECK (evidence_approved = false OR evidence_drive_url IS NOT NULL);

CREATE INDEX IF NOT EXISTS tasks_end_at_idx ON public.tasks (end_at);

-- ------------------------------------------------------------
-- 3) Trigger: أوقات إلزامية للمهام الجديدة + ختم الشاهد + اعتماد المدير فقط
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tasks_enforce_schedule_and_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.evidence_drive_url := NULLIF(btrim(COALESCE(NEW.evidence_drive_url, '')), '');
  NEW.evidence_title := NULLIF(btrim(COALESCE(NEW.evidence_title, '')), '');
  IF NEW.evidence_drive_url IS NULL THEN
    NEW.evidence_title := NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.start_at IS NULL OR NEW.end_at IS NULL THEN
      RAISE EXCEPTION 'يجب تحديد تاريخ ووقت البداية والنهاية للمهمة';
    END IF;

    IF NEW.evidence_drive_url IS NOT NULL THEN
      NEW.evidence_added_by := auth.uid();
      NEW.evidence_added_at := now();
    ELSE
      NEW.evidence_added_by := NULL;
      NEW.evidence_added_at := NULL;
    END IF;

    IF COALESCE(NEW.evidence_approved, false) THEN
      IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'فقط المدير يمكنه اعتماد الشواهد';
      END IF;
      IF NEW.evidence_drive_url IS NULL THEN
        RAISE EXCEPTION 'لا يمكن اعتماد شاهد بدون رابط مرفق';
      END IF;
      NEW.evidence_approved_by := auth.uid();
      NEW.evidence_approved_at := now();
    ELSE
      NEW.evidence_approved := false;
      NEW.evidence_approved_by := NULL;
      NEW.evidence_approved_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: شاهد معتمد مقفل حتى يُلغى الاعتماد
  IF COALESCE(OLD.evidence_approved, false)
     AND COALESCE(NEW.evidence_approved, false)
     AND (
       NEW.evidence_drive_url IS DISTINCT FROM OLD.evidence_drive_url
       OR NEW.evidence_title IS DISTINCT FROM OLD.evidence_title
     ) THEN
    RAISE EXCEPTION 'لا يمكن تعديل شاهد معتمد. ألغِ الاعتماد أولاً';
  END IF;

  IF NEW.evidence_drive_url IS DISTINCT FROM OLD.evidence_drive_url THEN
    IF NEW.evidence_drive_url IS NOT NULL THEN
      NEW.evidence_added_by := auth.uid();
      NEW.evidence_added_at := now();
    ELSE
      NEW.evidence_added_by := NULL;
      NEW.evidence_added_at := NULL;
    END IF;
  ELSE
    NEW.evidence_added_by := OLD.evidence_added_by;
    NEW.evidence_added_at := OLD.evidence_added_at;
  END IF;

  IF (NEW.evidence_approved IS DISTINCT FROM OLD.evidence_approved)
     OR (NEW.evidence_approved_by IS DISTINCT FROM OLD.evidence_approved_by)
     OR (NEW.evidence_approved_at IS DISTINCT FROM OLD.evidence_approved_at) THEN
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION 'فقط المدير يمكنه اعتماد الشواهد أو إلغاء الاعتماد';
    END IF;
    IF COALESCE(NEW.evidence_approved, false) THEN
      IF NEW.evidence_drive_url IS NULL THEN
        RAISE EXCEPTION 'لا يمكن اعتماد شاهد بدون رابط مرفق';
      END IF;
      NEW.evidence_approved_by := auth.uid();
      NEW.evidence_approved_at := now();
    ELSE
      NEW.evidence_approved := false;
      NEW.evidence_approved_by := NULL;
      NEW.evidence_approved_at := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_enforce_evidence ON public.tasks;
CREATE TRIGGER trg_tasks_enforce_evidence
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.tasks_enforce_schedule_and_evidence();

REVOKE ALL ON FUNCTION public.tasks_enforce_schedule_and_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tasks_enforce_schedule_and_evidence() FROM anon;
REVOKE ALL ON FUNCTION public.tasks_enforce_schedule_and_evidence() FROM authenticated;

-- ------------------------------------------------------------
-- 4) تحقق داخل المعاملة (division by zero = فشل → ROLLBACK;)
-- ------------------------------------------------------------
SELECT 1 / CASE WHEN (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'tasks'
    AND column_name IN (
      'start_at','end_at','evidence_drive_url','evidence_title',
      'evidence_added_by','evidence_added_at',
      'evidence_approved','evidence_approved_by','evidence_approved_at'
    )
) = 9 THEN 1 ELSE 0 END AS tx_check_columns;

COMMIT;


-- ############################################################################
-- POSTCHECK (قراءة فقط)
-- ############################################################################

-- يجب أن يطابق tasks_total في P2 (لا حذف)
SELECT
  COUNT(*)                                       AS tasks_total,
  COUNT(*) FILTER (WHERE start_at IS NULL)       AS legacy_tasks_without_times,
  COUNT(*) FILTER (WHERE evidence_drive_url IS NOT NULL) AS tasks_with_drive_evidence,
  COUNT(*) FILTER (WHERE evidence_approved)      AS approved_task_evidence
FROM public.tasks;
-- المتوقع مباشرة بعد التطبيق: legacy_tasks_without_times = tasks_total، والباقي 0

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.tasks'::regclass AND conname LIKE 'tasks_%check'
ORDER BY conname;

-- اختبارات يدوية من جلسة الواجهة (ليست من SQL Editor لأن auth.uid() فيه NULL):
--   vice : إضافة مهمة بلا أوقات → «يجب تحديد تاريخ ووقت البداية والنهاية»
--   vice : end_at <= start_at → خرق tasks_schedule_order_check
--   vice : evidence_drive_url = 'https://evil.example/x' → خرق tasks_evidence_drive_url_check
--   vice : evidence_approved = true → «فقط المدير يمكنه اعتماد الشواهد»
--   admin: اعتماد شاهد له رابط → ينجح؛ ثم تعديل الرابط → «ألغِ الاعتماد أولاً»
--   teacher: أي SELECT/INSERT/UPDATE على tasks → 0 صفوف / رفض RLS


-- ############################################################################
-- ROLLBACK (يدوي — معلّق). يحذف أعمدة جديدة فقط، لا يمس بيانات المهام الأصلية.
-- تحذير: يفقد الأوقات وروابط الشواهد التي أُدخلت بعد التطبيق.
-- ############################################################################
/*
BEGIN;
DROP TRIGGER IF EXISTS trg_tasks_enforce_evidence ON public.tasks;
DROP FUNCTION IF EXISTS public.tasks_enforce_schedule_and_evidence();
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_schedule_pair_check;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_schedule_order_check;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_evidence_drive_url_check;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_evidence_title_check;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_evidence_approval_check;
DROP INDEX IF EXISTS public.tasks_end_at_idx;
ALTER TABLE public.tasks
  DROP COLUMN IF EXISTS start_at,
  DROP COLUMN IF EXISTS end_at,
  DROP COLUMN IF EXISTS evidence_drive_url,
  DROP COLUMN IF EXISTS evidence_title,
  DROP COLUMN IF EXISTS evidence_added_by,
  DROP COLUMN IF EXISTS evidence_added_at,
  DROP COLUMN IF EXISTS evidence_approved,
  DROP COLUMN IF EXISTS evidence_approved_by,
  DROP COLUMN IF EXISTS evidence_approved_at;
COMMIT;
*/
