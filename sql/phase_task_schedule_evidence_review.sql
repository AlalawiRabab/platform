-- ============================================================
-- phase_task_schedule_evidence_review.sql   (الخطوة 2 — توسيع متوافق)
-- وقت بدء/انتهاء المهمة + شاهد Drive + إسناد المهمة لحساب المعلمة
-- مراجعة / تطبيق يدوي بعد نسخة احتياطية — لا يُنفَّذ تلقائياً
-- ============================================================
-- متوافق مع الواجهة الحالية والجديدة معًا:
--   * لا يفرض الأوقات عند الإضافة (يُفرض لاحقًا في phase_task_schedule_enforce_review.sql
--     بعد نشر الواجهة الجديدة) → لا فترة تتعطل فيها إضافة المهام.
-- ضوابط الأمان:
--   * بلا DROP TABLE / TRUNCATE / DELETE / حذف أعمدة
--   * المهام القديمة: start_at و end_at و assignee_id تبقى NULL (لا افتراض قيم)
--   * end_at > start_at و (كلاهما أو لا شيء) — CHECK
--   * رابط الشاهد: https://drive.google.com أو https://docs.google.com فقط — CHECK
--   * assignee_id يشير لحساب معلمة (profiles.role = 'teacher') — Trigger
--   * المعلمة: ترى مهامها المسندة إليها فقط، وتعدّل رابط الشاهد واسمه فقط
--     في مهمتها وفي السنة النشطة فقط (RLS + Trigger يمنع تعديل أي عمود آخر)
--   * اعتماد شاهد المهمة: القائدة (admin) فقط؛ الشاهد المعتمد مقفل
--   * سياسات admin/vice الحالية على tasks لا تتغير
-- ============================================================
-- PRECHECK: شغّل sql/precheck_readonly_report.sql وأرفق نتيجته.

BEGIN;

-- ------------------------------------------------------------
-- 1) أعمدة جديدة (nullable أو بقيمة افتراضية آمنة)
-- ------------------------------------------------------------
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS start_at timestamptz,
  ADD COLUMN IF NOT EXISTS end_at timestamptz,
  ADD COLUMN IF NOT EXISTS assignee_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
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
COMMENT ON COLUMN public.tasks.resp IS
  'اسم المسؤولة للعرض فقط. الإسناد الموثوق في assignee_id.';
COMMENT ON COLUMN public.tasks.assignee_id IS
  'حساب المعلمة المسندة إليها المهمة (profiles.id). مصدر صلاحية إرفاق شاهد المهمة.';
COMMENT ON COLUMN public.tasks.evidence_drive_url IS
  'رابط Google Drive كشاهد للمهمة (https://drive.google.com أو https://docs.google.com فقط).';
COMMENT ON COLUMN public.tasks.evidence_approved IS
  'اعتماد شاهد المهمة — القائدة فقط عبر trg_tasks_enforce_evidence.';

CREATE INDEX IF NOT EXISTS tasks_end_at_idx ON public.tasks (end_at);
CREATE INDEX IF NOT EXISTS tasks_assignee_id_idx ON public.tasks (assignee_id);

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

-- ------------------------------------------------------------
-- 3) Trigger: حدود المعلمة + إسناد صالح + ختم الشاهد + اعتماد القائدة فقط
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tasks_enforce_schedule_and_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_evidence_cols constant text[] := ARRAY[
    'evidence_drive_url', 'evidence_title', 'evidence_added_by', 'evidence_added_at', 'updated_at'
  ];
BEGIN
  NEW.evidence_drive_url := NULLIF(btrim(COALESCE(NEW.evidence_drive_url, '')), '');
  NEW.evidence_title := NULLIF(btrim(COALESCE(NEW.evidence_title, '')), '');
  IF NEW.evidence_drive_url IS NULL THEN
    NEW.evidence_title := NULL;
  END IF;

  -- المعلمة: رابط الشاهد واسمه فقط — أي عمود آخر (الاسم، الحالة، الأوقات، الإسناد، الاعتماد…) مرفوض
  IF TG_OP = 'UPDATE' AND public.current_app_role() = 'teacher' THEN
    IF (to_jsonb(NEW) - v_evidence_cols) IS DISTINCT FROM (to_jsonb(OLD) - v_evidence_cols) THEN
      RAISE EXCEPTION 'المعلمة تستطيع إرفاق رابط الشاهد واسمه فقط لمهمتها';
    END IF;
  END IF;

  IF NEW.assignee_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles p WHERE p.id = NEW.assignee_id AND p.role = 'teacher'
     ) THEN
    RAISE EXCEPTION 'يجب إسناد المهمة إلى حساب معلمة';
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
-- 4) RLS للمعلمة (سياسات إضافية؛ سياسات admin/vice كما هي)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS tasks_select_assignee ON public.tasks;
CREATE POLICY tasks_select_assignee ON public.tasks
  FOR SELECT TO authenticated
  USING (
    public.current_app_role() = 'teacher'
    AND assignee_id = auth.uid()
    AND public.school_year_allows_read(school_year_id)
  );

DROP POLICY IF EXISTS tasks_update_assignee_evidence ON public.tasks;
CREATE POLICY tasks_update_assignee_evidence ON public.tasks
  FOR UPDATE TO authenticated
  USING (
    public.current_app_role() = 'teacher'
    AND assignee_id = auth.uid()
    AND public.school_year_is_active(school_year_id)
  )
  WITH CHECK (
    public.current_app_role() = 'teacher'
    AND assignee_id = auth.uid()
    AND public.school_year_is_active(school_year_id)
  );
-- لا INSERT ولا DELETE للمعلمة (tasks_insert / tasks_delete كما هي)

-- ------------------------------------------------------------
-- 5) قائمة المعلمات للإسناد (profiles_select لا يسمح للوكيلة بقراءة الحسابات)
--    تُرجع id + name فقط، وللقائدة والوكيلة فقط
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_task_assignees()
RETURNS TABLE (id uuid, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.id, p.name
  FROM public.profiles AS p
  WHERE public.is_staff() AND p.role = 'teacher'
  ORDER BY p.name
$$;

REVOKE ALL ON FUNCTION public.list_task_assignees() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_task_assignees() FROM anon;
GRANT EXECUTE ON FUNCTION public.list_task_assignees() TO authenticated;

-- ------------------------------------------------------------
-- 6) تحقق داخل المعاملة (division by zero = فشل → ROLLBACK;)
-- ------------------------------------------------------------
SELECT 1 / CASE WHEN (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'tasks'
    AND column_name IN (
      'start_at','end_at','assignee_id','evidence_drive_url','evidence_title',
      'evidence_added_by','evidence_added_at',
      'evidence_approved','evidence_approved_by','evidence_approved_at'
    )
) = 10 THEN 1 ELSE 0 END AS tx_check_columns;

SELECT 1 / CASE WHEN (
  SELECT COUNT(*) FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'tasks'
    AND policyname IN ('tasks_select_assignee', 'tasks_update_assignee_evidence')
) = 2 THEN 1 ELSE 0 END AS tx_check_teacher_policies;

COMMIT;


-- ############################################################################
-- POSTCHECK (قراءة فقط)
-- ############################################################################
SELECT
  COUNT(*)                                             AS tasks_total,
  COUNT(*) FILTER (WHERE start_at IS NULL)             AS tasks_without_times,
  COUNT(*) FILTER (WHERE assignee_id IS NOT NULL)      AS tasks_assigned,
  COUNT(*) FILTER (WHERE evidence_drive_url IS NOT NULL) AS tasks_with_drive_evidence,
  COUNT(*) FILTER (WHERE evidence_approved)            AS approved_task_evidence
FROM public.tasks;
-- المتوقع مباشرة بعد التطبيق: tasks_total كما في PRECHECK، tasks_without_times = tasks_total، والباقي 0


-- ############################################################################
-- (اختياري — معلّق) إسناد المهام القديمة التي يطابق «المسؤولة» فيها اسم معلمة واحدة حرفيًا.
-- راجع S9_tasks_readiness (resp_exact_unique_teacher_match / resp_ambiguous_teacher_match) في تقرير
-- PRECHECK أولًا. لا يُنفَّذ ضمن المسار العادي؛ البديل الأدق: الإسناد يدويًا من نافذة تعديل المهمة.
-- ############################################################################
/*
BEGIN;
UPDATE public.tasks AS t
SET assignee_id = m.id
FROM (
  SELECT t2.id AS task_id, MIN(p.id::text)::uuid AS id
  FROM public.tasks t2
  JOIN public.profiles p ON p.role = 'teacher' AND btrim(p.name) = btrim(t2.resp)
  WHERE t2.assignee_id IS NULL
  GROUP BY t2.id
  HAVING COUNT(*) = 1
) AS m
WHERE t.id = m.task_id;
COMMIT;
*/


-- ############################################################################
-- ROLLBACK (يدوي — معلّق). يحذف الإضافات فقط، لا يمس بيانات المهام الأصلية.
-- تحذير: يفقد الأوقات والإسناد وروابط الشواهد التي أُدخلت بعد التطبيق.
-- إن طُبّق phase_task_schedule_enforce_review.sql فارجع عنه أولًا.
-- ############################################################################
/*
BEGIN;
DROP POLICY IF EXISTS tasks_select_assignee ON public.tasks;
DROP POLICY IF EXISTS tasks_update_assignee_evidence ON public.tasks;
DROP FUNCTION IF EXISTS public.list_task_assignees();
DROP TRIGGER IF EXISTS trg_tasks_enforce_evidence ON public.tasks;
DROP FUNCTION IF EXISTS public.tasks_enforce_schedule_and_evidence();
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_schedule_pair_check;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_schedule_order_check;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_evidence_drive_url_check;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_evidence_title_check;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_evidence_approval_check;
DROP INDEX IF EXISTS public.tasks_end_at_idx;
DROP INDEX IF EXISTS public.tasks_assignee_id_idx;
ALTER TABLE public.tasks
  DROP COLUMN IF EXISTS start_at,
  DROP COLUMN IF EXISTS end_at,
  DROP COLUMN IF EXISTS assignee_id,
  DROP COLUMN IF EXISTS evidence_drive_url,
  DROP COLUMN IF EXISTS evidence_title,
  DROP COLUMN IF EXISTS evidence_added_by,
  DROP COLUMN IF EXISTS evidence_added_at,
  DROP COLUMN IF EXISTS evidence_approved,
  DROP COLUMN IF EXISTS evidence_approved_by,
  DROP COLUMN IF EXISTS evidence_approved_at;
COMMIT;
*/
