-- ============================================================
-- phase_indicator_delete_guard.sql
-- حذف المؤشرات: القائدة والوكيلة فقط، ومنع حذف مؤشر مرتبط ببيانات
-- آمن لإعادة التشغيل، لا يحذف ولا يعدّل أي صف بيانات
-- ============================================================
-- ماذا يفعل:
--   * سياسة indicators_delete: admin أو vice (بدل admin فقط) وفي سنة قابلة للكتابة.
--     المعلمة (teacher) لا تملك سياسة حذف → أي طلب حذف مباشر يحذف 0 صفوف.
--   * Trigger قبل الحذف يرفض حذف مؤشر له شواهد مطلوبة (evidence_requirements)
--     أو مرفقات/شواهد (evidences) — والملاحظات محفوظة داخل evidences.
--     بدونه كان الحذف يحذف أسماء الشواهد تلقائياً (ON DELETE CASCADE)
--     ويفك ربط المرفقات (ON DELETE SET NULL).
--   * حذف البرنامج نفسه (programs → program_indicators ON DELETE CASCADE) يبقى كما هو:
--     الـ Trigger لا يتدخل عندما يكون البرنامج الأب قد حُذف في العملية نفسها.
--   * سحب TRUNCATE على program_indicators من anon/authenticated/PUBLIC
--     (TRUNCATE يتجاوز RLS والـ Triggers).
--   * لا يمس evidences ولا evidence_requirements ولا المهام ولا المبادرات ولا الإعدادات ولا التخزين.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.program_indicators'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'STOP: RLS غير مفعّل على program_indicators';
  END IF;
  IF to_regprocedure('public.current_app_role()') IS NULL
     OR to_regprocedure('public.school_year_allows_write(uuid)') IS NULL THEN
    RAISE EXCEPTION 'STOP: دوال الصلاحيات المطلوبة غير موجودة';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.platform_migration_history (
  migration_key text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.platform_migration_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_migration_history FROM PUBLIC, anon, authenticated;

CREATE TEMP TABLE _indicator_guard_precheck ON COMMIT DROP AS
SELECT
  (SELECT COUNT(*) FROM public.program_indicators) AS indicators_cnt,
  (SELECT COUNT(*) FROM public.evidence_requirements) AS requirements_cnt,
  (SELECT COUNT(*) FROM public.evidences) AS evidences_cnt;

-- ------------------------------------------------------------
-- 1) منع حذف مؤشر مرتبط ببيانات
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_delete_linked_indicator()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  req_cnt bigint;
  ev_cnt bigint;
  note_cnt bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.programs AS pr WHERE pr.id = OLD.program_id) THEN
    RETURN OLD;
  END IF;

  SELECT COUNT(*) INTO req_cnt
  FROM public.evidence_requirements AS r
  WHERE r.indicator_id = OLD.id;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE COALESCE(btrim(e.notes), '') <> '')
    INTO ev_cnt, note_cnt
  FROM public.evidences AS e
  WHERE e.indicator_id = OLD.id
     OR e.requirement_id IN (
       SELECT r.id FROM public.evidence_requirements AS r WHERE r.indicator_id = OLD.id
     );

  IF req_cnt > 0 OR ev_cnt > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = format(
        'لا يمكن حذف المؤشر لأنه مرتبط بـ %s شاهد مطلوب و%s مرفق و%s ملاحظة. أزيلي الشواهد والمرفقات المرتبطة به أولاً؛ لا تُحذف بياناته تلقائياً.',
        req_cnt, ev_cnt, note_cnt),
      HINT = 'indicator_has_linked_data';
  END IF;

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_delete_linked_indicator() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_prevent_delete_linked_indicator ON public.program_indicators;
CREATE TRIGGER trg_prevent_delete_linked_indicator
  BEFORE DELETE ON public.program_indicators
  FOR EACH ROW EXECUTE FUNCTION public.prevent_delete_linked_indicator();

-- ------------------------------------------------------------
-- 2) سياسة الحذف: القائدة والوكيلة فقط، في سنة قابلة للكتابة
-- ------------------------------------------------------------
DROP POLICY IF EXISTS indicators_delete ON public.program_indicators;
CREATE POLICY indicators_delete ON public.program_indicators
  FOR DELETE TO authenticated
  USING (
    public.current_app_role() IN ('admin', 'vice')
    AND EXISTS (
      SELECT 1 FROM public.programs AS pr
      WHERE pr.id = program_indicators.program_id
        AND public.school_year_allows_write(pr.school_year_id)
    )
  );

-- ------------------------------------------------------------
-- 3) TRUNCATE يتجاوز RLS والـ Triggers
-- ------------------------------------------------------------
REVOKE TRUNCATE ON TABLE public.program_indicators FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4) سجل التنفيذ + التأكد أن لا صف تغيّر
-- ------------------------------------------------------------
INSERT INTO public.platform_migration_history (migration_key)
VALUES ('phase_indicator_delete_guard_v1')
ON CONFLICT (migration_key) DO NOTHING;

DO $$
DECLARE
  b record;
BEGIN
  SELECT * INTO b FROM _indicator_guard_precheck;
  IF b.indicators_cnt IS DISTINCT FROM (SELECT COUNT(*) FROM public.program_indicators)
     OR b.requirements_cnt IS DISTINCT FROM (SELECT COUNT(*) FROM public.evidence_requirements)
     OR b.evidences_cnt IS DISTINCT FROM (SELECT COUNT(*) FROM public.evidences) THEN
    RAISE EXCEPTION 'row counts changed — rolled back';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================
-- تحقق بعد التطبيق:
--   SELECT policyname, qual FROM pg_policies
--     WHERE tablename = 'program_indicators' AND policyname = 'indicators_delete';
--   SELECT tgname FROM pg_trigger
--     WHERE tgrelid = 'public.program_indicators'::regclass AND NOT tgisinternal;
--   SELECT has_table_privilege('authenticated', 'public.program_indicators', 'TRUNCATE'); -- false
-- ============================================================

-- تراجع (يعيد سياسة الحذف للقائدة فقط ويزيل الـ Trigger؛ لا يعيد TRUNCATE):
/*
BEGIN;
DROP TRIGGER IF EXISTS trg_prevent_delete_linked_indicator ON public.program_indicators;
DROP FUNCTION IF EXISTS public.prevent_delete_linked_indicator();
DROP POLICY IF EXISTS indicators_delete ON public.program_indicators;
CREATE POLICY indicators_delete ON public.program_indicators
  FOR DELETE TO authenticated
  USING (
    public.is_admin()
    AND EXISTS (
      SELECT 1 FROM public.programs AS pr
      WHERE pr.id = program_indicators.program_id
        AND public.school_year_allows_write(pr.school_year_id)
    )
  );
DELETE FROM public.platform_migration_history WHERE migration_key = 'phase_indicator_delete_guard_v1';
NOTIFY pgrst, 'reload schema';
COMMIT;
*/
