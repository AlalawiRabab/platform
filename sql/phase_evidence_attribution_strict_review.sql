-- ============================================================
-- REVIEW ONLY — DO NOT RUN AUTOMATICALLY. Manual apply in the SQL Editor after separate approval.
-- ============================================================
-- phase_evidence_attribution_strict_review.sql
-- تفعيل الإلزام الكامل لاسم المعلمة واسم عرض الرابط وhttps (الوضع الصارم)
-- يُطبَّق فقط بعد: دمج PR ونشر الواجهة الجديدة على GitHub Pages واختبارها يدوياً
--   (الواجهة القديمة لا تحتوي حقل اسم الرابط، فلو فُعّل قبلها لرُفضت إضافة روابط Drive منها).
-- Rollback مستقل (يعيد الوضع المتوافق): sql/phase_evidence_attribution_strict_rollback_review.sql
-- ============================================================
-- ماذا يفعل:
--   * يضيف المفتاح phase_evidence_attribution_strict_v1 إلى platform_migration_history فقط.
--     الـ Trigger المثبّت من phase_evidence_attribution_review.sql يقرأ هذا المفتاح فيصبح صارماً
--     للإضافات والتعديلات الجديدة. لا يمس أي صف في evidences ولا أي سجل قديم.
-- ============================================================

BEGIN;

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.platform_migration_history
                 WHERE migration_key = 'phase_evidence_attribution_v1') THEN
    RAISE EXCEPTION 'STOP: طبّق phase_evidence_attribution_review.sql أولاً';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.evidences'::regclass
                   AND tgname = 'trg_validate_evidence_attribution' AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'STOP: الـ Trigger trg_validate_evidence_attribution غير موجود أو معطّل';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                 WHERE oid = 'public.validate_evidence_attribution()'::regprocedure
                   AND prosecdef
                   AND prosrc LIKE '%phase_evidence_attribution_strict_v1%') THEN
    RAISE EXCEPTION 'STOP: نسخة دالة التحقق لا تدعم الوضع الصارم';
  END IF;
END
$pre$;

CREATE TEMP TABLE _attribution_strict_precheck ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM public.evidences) AS evidences_cnt,
  (SELECT md5(coalesce(string_agg(to_jsonb(e)::text, ',' ORDER BY e.id), '')) FROM public.evidences e) AS evidences_md5;

DO $hist$
DECLARE
  n integer;
BEGIN
  INSERT INTO public.platform_migration_history (migration_key)
  VALUES ('phase_evidence_attribution_strict_v1')
  ON CONFLICT (migration_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n NOT IN (0, 1) THEN
    RAISE EXCEPTION 'STOP: سجل التنفيذ أدخل % صفوف (المسموح 0 أو 1)', n;
  END IF;
  IF (SELECT count(*) FROM public.platform_migration_history
      WHERE migration_key = 'phase_evidence_attribution_strict_v1') <> 1 THEN
    RAISE EXCEPTION 'STOP: migration_key غير موجود مرة واحدة بالضبط';
  END IF;
END
$hist$;

DO $post$
DECLARE
  b record;
BEGIN
  SELECT * INTO b FROM _attribution_strict_precheck;
  IF b.evidences_cnt IS DISTINCT FROM (SELECT count(*) FROM public.evidences)
     OR b.evidences_md5 IS DISTINCT FROM
        (SELECT md5(coalesce(string_agg(to_jsonb(e)::text, ',' ORDER BY e.id), '')) FROM public.evidences e) THEN
    RAISE EXCEPTION 'STOP: تغيّر محتوى evidences — تم التراجع';
  END IF;
END
$post$;

COMMIT;

-- ============================================================
-- POSTCHECK (قراءة فقط):
--   SELECT migration_key FROM public.platform_migration_history WHERE migration_key LIKE 'phase_evidence_attribution%';
--     -- المتوقع: phase_evidence_attribution_v1 وphase_evidence_attribution_strict_v1
-- ============================================================

-- تراجع (يعيد الوضع المتوافق فقط؛ الـ Trigger يبقى، ولا يمس أي بيانات):
/*
BEGIN;
DELETE FROM public.platform_migration_history WHERE migration_key = 'phase_evidence_attribution_strict_v1';
COMMIT;
*/
