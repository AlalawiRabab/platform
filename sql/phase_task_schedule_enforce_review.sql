-- ============================================================
-- phase_task_schedule_enforce_review.sql   (الخطوة 3 — بعد نشر الواجهة الجديدة)
-- فرض تاريخ ووقت البداية والنهاية عند إضافة أي مهمة جديدة
-- مراجعة / تطبيق يدوي — لا يُنفَّذ تلقائياً
-- ============================================================
-- لا تنفّذه قبل أن تصبح الواجهة الجديدة (index.html/script.js) منشورة ومحمّلة لدى المستخدمين،
-- وإلا تُرفض الإضافة من الواجهة القديمة لأنها لا ترسل الأوقات.
-- لا يمس المهام القائمة (INSERT فقط).
-- ============================================================

-- PRECHECK: هل ما زالت مهام جديدة تُضاف بلا أوقات؟ (المتوقع 0 بعد نشر الواجهة الجديدة)
SELECT COUNT(*) AS untimed_tasks_created_last_24h
FROM public.tasks
WHERE start_at IS NULL AND created_at > now() - interval '24 hours';

BEGIN;

CREATE OR REPLACE FUNCTION public.tasks_require_schedule_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.start_at IS NULL OR NEW.end_at IS NULL THEN
    RAISE EXCEPTION 'يجب تحديد تاريخ ووقت البداية والنهاية للمهمة';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_require_schedule ON public.tasks;
CREATE TRIGGER trg_tasks_require_schedule
  BEFORE INSERT ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.tasks_require_schedule_on_insert();

REVOKE ALL ON FUNCTION public.tasks_require_schedule_on_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tasks_require_schedule_on_insert() FROM anon;
REVOKE ALL ON FUNCTION public.tasks_require_schedule_on_insert() FROM authenticated;

COMMIT;

-- ROLLBACK (فوري وآمن — لا يمس بيانات):
/*
BEGIN;
DROP TRIGGER IF EXISTS trg_tasks_require_schedule ON public.tasks;
DROP FUNCTION IF EXISTS public.tasks_require_schedule_on_insert();
COMMIT;
*/
