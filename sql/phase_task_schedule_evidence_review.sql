-- ============================================================
-- phase_task_schedule_evidence_review.sql   (الخطوة 1 — توسيع متوافق، قسم المهام فقط)
-- وقت بدء/انتهاء المهمة + شاهد Drive يُرفق من حساب المعلمات المشترك
-- مراجعة / تطبيق يدوي بعد نسخة احتياطية — لا يُنفَّذ تلقائياً
-- ============================================================
-- نموذج العمل: كل المعلمات يدخلن بحساب مشترك واحد (role = 'teacher').
--   * «المسؤولة» (resp) معلومة تنظيمية للعرض فقط — ليست هوية من أرفق الشاهد.
--   * evidence_added_by = معرّف الحساب الذي أرفق الرابط (قد يكون الحساب المشترك)،
--     ولا يحدد معلمة بعينها.
-- متوافق مع الواجهة الحالية والجديدة معًا:
--   * لا يفرض الأوقات عند الإضافة (يُفرض لاحقًا في phase_task_schedule_enforce_review.sql
--     بعد نشر الواجهة الجديدة) → لا فترة تتعطل فيها إضافة المهام.
-- النطاق: جدول public.tasks فقط. لا يمس البرامج أو المؤشرات أو شواهدها أو Storage أو profiles
--   أو أي جدول/سياسة/منحة أخرى، ولا سياسات tasks الحالية (tasks_select/insert/update/delete).
-- ضوابط الأمان:
--   * بلا DROP TABLE / TRUNCATE / DELETE / حذف أعمدة، ولا تعديل لـ resp أو أي بيانات قائمة
--   * المهام القديمة: start_at و end_at تبقى NULL (لا افتراض قيم)
--   * end_at > start_at و (كلاهما أو لا شيء) — CHECK
--   * شاهد المهمة = رابط Google Drive واحد فقط (عمود نصي واحد، بلا اسم شاهد، بلا رفع ملفات،
--     بلا روابط متعددة): https://drive.google.com أو https://docs.google.com فقط — CHECK
--   * حساب المعلمات: يرى مهام السنة النشطة، ويضيف/يستبدل رابط الشاهد فقط
--     لمهمة في السنة النشطة شاهدها غير معتمد (RLS + Trigger يمنع أي عمود آخر وحذف الرابط)
--   * اعتماد شاهد المهمة: القائدة (admin) فقط؛ الشاهد المعتمد مقفل
--   * سياسات admin/vice الحالية على tasks لا تتغير
-- ============================================================
-- PRECHECK: شغّل sql/phase_task_schedule_precheck.sql (قراءة فقط) وأرفق نتيجته.

BEGIN;

-- ------------------------------------------------------------
-- 1) أعمدة جديدة (nullable أو بقيمة افتراضية آمنة)
-- ------------------------------------------------------------
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS start_at timestamptz,
  ADD COLUMN IF NOT EXISTS end_at timestamptz,
  ADD COLUMN IF NOT EXISTS evidence_drive_url text,
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
COMMENT ON COLUMN public.tasks.evidence_added_by IS
  'معرّف الحساب الذي أرفق رابط الشاهد. للحساب المشترك لا يحدد معلمة بعينها.';
COMMENT ON COLUMN public.tasks.evidence_drive_url IS
  'رابط Google Drive واحد كشاهد للمهمة (https://drive.google.com أو https://docs.google.com فقط).';
COMMENT ON COLUMN public.tasks.evidence_approved IS
  'اعتماد شاهد المهمة — القائدة فقط عبر trg_tasks_enforce_evidence.';

CREATE INDEX IF NOT EXISTS tasks_end_at_idx ON public.tasks (end_at);

-- ------------------------------------------------------------
-- 2) قيود التحقق (لا تفشل على المهام القديمة: الحقول الجديدة فيها NULL)
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

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_evidence_approval_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_evidence_approval_check
  CHECK (evidence_approved = false OR evidence_drive_url IS NOT NULL);

-- ------------------------------------------------------------
-- 3) Trigger: حدود حساب المعلمات + ختم الشاهد + اعتماد القائدة فقط
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tasks_enforce_schedule_and_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_evidence_cols constant text[] := ARRAY[
    'evidence_drive_url', 'evidence_added_by', 'evidence_added_at', 'updated_at'
  ];
BEGIN
  NEW.evidence_drive_url := NULLIF(btrim(COALESCE(NEW.evidence_drive_url, '')), '');

  -- حساب المعلمات: رابط الشاهد فقط — أي عمود آخر (الاسم، المسؤولة، الحالة، الأوقات، الاعتماد…) مرفوض
  IF TG_OP = 'UPDATE' AND public.current_app_role() = 'teacher' THEN
    IF (to_jsonb(NEW) - v_evidence_cols) IS DISTINCT FROM (to_jsonb(OLD) - v_evidence_cols) THEN
      RAISE EXCEPTION 'حساب المعلمات يستطيع إرفاق رابط الشاهد فقط';
    END IF;
    -- حساب مشترك: لا يُحذف رابط أُرفق (يمكن استبداله ما دام غير معتمد)
    IF NEW.evidence_drive_url IS NULL AND OLD.evidence_drive_url IS NOT NULL THEN
      RAISE EXCEPTION 'لا يمكن حذف رابط الشاهد من حساب المعلمات';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.evidence_drive_url IS NOT NULL THEN
      NEW.evidence_added_by := auth.uid();
      NEW.evidence_added_at := now();
    ELSE
      NEW.evidence_added_by := NULL;
      NEW.evidence_added_at := NULL;
    END IF;

    IF COALESCE(NEW.evidence_approved, false) THEN
      IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'فقط القائدة يمكنها اعتماد الشواهد';
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
     AND NEW.evidence_drive_url IS DISTINCT FROM OLD.evidence_drive_url THEN
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
      RAISE EXCEPTION 'فقط القائدة يمكنها اعتماد الشواهد أو إلغاء الاعتماد';
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
-- 4) RLS لحساب المعلمات (سياسات إضافية؛ سياسات admin/vice كما هي)
--    school_year_allows_read للمعلمة = السنة النشطة فقط
-- ------------------------------------------------------------
DROP POLICY IF EXISTS tasks_select_assignee ON public.tasks;
DROP POLICY IF EXISTS tasks_update_assignee_evidence ON public.tasks;

DROP POLICY IF EXISTS tasks_select_teacher ON public.tasks;
CREATE POLICY tasks_select_teacher ON public.tasks
  FOR SELECT TO authenticated
  USING (
    public.current_app_role() = 'teacher'
    AND public.school_year_allows_read(school_year_id)
  );

DROP POLICY IF EXISTS tasks_update_teacher_evidence ON public.tasks;
CREATE POLICY tasks_update_teacher_evidence ON public.tasks
  FOR UPDATE TO authenticated
  USING (
    public.current_app_role() = 'teacher'
    AND public.school_year_is_active(school_year_id)
    AND evidence_approved = false
  )
  WITH CHECK (
    public.current_app_role() = 'teacher'
    AND public.school_year_is_active(school_year_id)
    AND evidence_approved = false
  );
-- لا INSERT ولا DELETE لحساب المعلمات (tasks_insert / tasks_delete كما هي)

-- ------------------------------------------------------------
-- 5) تحقق داخل المعاملة (division by zero = فشل → ROLLBACK;)
-- ------------------------------------------------------------
SELECT 1 / CASE WHEN (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'tasks'
    AND column_name IN (
      'start_at','end_at','evidence_drive_url',
      'evidence_added_by','evidence_added_at',
      'evidence_approved','evidence_approved_by','evidence_approved_at'
    )
) = 8 THEN 1 ELSE 0 END AS tx_check_columns;

SELECT 1 / CASE WHEN (
  SELECT COUNT(*) FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'tasks'
    AND policyname IN ('tasks_select_teacher', 'tasks_update_teacher_evidence')
) = 2 THEN 1 ELSE 0 END AS tx_check_teacher_policies;

COMMIT;


-- ############################################################################
-- POSTCHECK (قراءة فقط)
-- ############################################################################
SELECT
  COUNT(*)                                             AS tasks_total,
  COUNT(*) FILTER (WHERE start_at IS NULL)             AS tasks_without_times,
  COUNT(*) FILTER (WHERE evidence_drive_url IS NOT NULL) AS tasks_with_drive_evidence,
  COUNT(*) FILTER (WHERE evidence_approved)            AS approved_task_evidence
FROM public.tasks;
-- المتوقع مباشرة بعد التطبيق: tasks_total كما في PRECHECK، tasks_without_times = tasks_total، والباقي 0
-- resp («المسؤولة») لا يُمس ولا يُطابَق بأي حساب.


-- ############################################################################
-- ROLLBACK (يدوي — معلّق). يحذف الإضافات فقط، لا يمس بيانات المهام الأصلية.
-- تحذير: يفقد الأوقات وروابط الشواهد التي أُدخلت بعد التطبيق، فلا يُستخدم إلا عند الضرورة
-- وبعد نسخة احتياطية. إن طُبّق phase_task_schedule_enforce_review.sql فارجع عنه أولًا.
-- ############################################################################
/*
BEGIN;
DROP POLICY IF EXISTS tasks_select_teacher ON public.tasks;
DROP POLICY IF EXISTS tasks_update_teacher_evidence ON public.tasks;
DROP TRIGGER IF EXISTS trg_tasks_enforce_evidence ON public.tasks;
DROP FUNCTION IF EXISTS public.tasks_enforce_schedule_and_evidence();
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_schedule_pair_check;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_schedule_order_check;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_evidence_drive_url_check;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_evidence_approval_check;
DROP INDEX IF EXISTS public.tasks_end_at_idx;
ALTER TABLE public.tasks
  DROP COLUMN IF EXISTS start_at,
  DROP COLUMN IF EXISTS end_at,
  DROP COLUMN IF EXISTS evidence_drive_url,
  DROP COLUMN IF EXISTS evidence_added_by,
  DROP COLUMN IF EXISTS evidence_added_at,
  DROP COLUMN IF EXISTS evidence_approved,
  DROP COLUMN IF EXISTS evidence_approved_by,
  DROP COLUMN IF EXISTS evidence_approved_at;
COMMIT;
*/

