-- ============================================================
-- phase_evidence_requirements_precheck.sql
-- فحص قبل تطبيق ترحيل الشواهد المطلوبة
-- ============================================================

SELECT COUNT(*) AS programs_cnt FROM public.programs;
SELECT COUNT(*) AS indicators_cnt FROM public.program_indicators;
SELECT COUNT(*) AS evidences_cnt FROM public.evidences;

SELECT
  COUNT(*) FILTER (WHERE indicator_id IS NOT NULL) AS evidences_with_indicator,
  COUNT(*) FILTER (WHERE indicator_id IS NULL) AS evidences_without_indicator,
  COUNT(*) FILTER (
    WHERE (file_url IS NOT NULL AND btrim(file_url) <> '')
       OR (link IS NOT NULL AND btrim(link) <> '')
  ) AS evidences_with_attachment
FROM public.evidences;

SELECT to_regclass('public.evidence_requirements') AS requirements_table;
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'evidences'
  AND column_name IN ('requirement_id','indicator_id','file_url','file_name','link','created_by')
ORDER BY column_name;

-- نسخة احتياطية مقترحة (اختياري قبل التطبيق):
-- CREATE TABLE public._bak_evidences_req AS TABLE public.evidences;
-- CREATE TABLE public._bak_program_indicators_req AS TABLE public.program_indicators;
-- CREATE TABLE public._bak_programs_req AS TABLE public.programs;
