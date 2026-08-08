-- ============================================================
-- trial_evidence_cleanup_review.sql
-- مراجعة فقط — لا تُنفَّذ الآن
-- ============================================================
-- بعد نجاح Auth والنشر فقط.
-- لا يوجد جدول reports مستقل — التقارير من evidences.
-- ============================================================

-- PRECHECK — أعداد قبل الحذف
SELECT 'evidences_total' AS metric, COUNT(*)::text AS value FROM public.evidences
UNION ALL
SELECT 'evidences_with_file_url', COUNT(*)::text FROM public.evidences
 WHERE file_url IS NOT NULL AND btrim(file_url) <> ''
UNION ALL
SELECT 'storage_objects_evidences', COUNT(*)::text FROM storage.objects WHERE bucket_id = 'evidences'
UNION ALL
SELECT 'programs_kept', COUNT(*)::text FROM public.programs
UNION ALL
SELECT 'program_indicators_kept', COUNT(*)::text FROM public.program_indicators
UNION ALL
SELECT 'initiatives_kept', COUNT(*)::text FROM public.initiatives
UNION ALL
SELECT 'tasks_kept', COUNT(*)::text FROM public.tasks
UNION ALL
SELECT 'settings_kept', COUNT(*)::text FROM public.settings
UNION ALL
SELECT 'school_years_kept', COUNT(*)::text FROM public.school_years
UNION ALL
SELECT 'profiles_kept', COUNT(*)::text FROM public.profiles
UNION ALL
SELECT 'users_kept', COUNT(*)::text FROM public.users;

SELECT id, title, type, program_id, file_url, link, created_at
  FROM public.evidences
 ORDER BY created_at DESC NULLS LAST;

-- ------------------------------------------------------------
-- نسخة احتياطية قبل الحذف (يدوياً من Dashboard / COPY)
-- ------------------------------------------------------------
-- Table Editor → evidences → Export
-- قائمة ملفات Storage عبر API/لوحة التحكم

-- ------------------------------------------------------------
-- حذف Storage عبر API أولاً (ليس SQL) — 3 ملفات معروفة
-- ------------------------------------------------------------
-- e6efa95a-862c-47d4-8a41-92db35ae1e3f/45/general/1786055396187-36.pdf
-- e6efa95a-862c-47d4-8a41-92db35ae1e3f/46/30/1786055459561-66.pdf
-- e6efa95a-862c-47d4-8a41-92db35ae1e3f/46/30/1786057608827-NST_GetTeacherInfoByUser2_3_.pdf
--
-- ترتيب: Storage API delete → ثم DELETE evidences

-- تأكيد يدوي مطلوب:
-- CONFIRM_DELETE_TRIAL_EVIDENCES = YES
-- العدد المتوقع: 30 سجل evidences + 3 ملفات
-- التاريخ / المراجع:

-- مثال حذف صفوف فقط بعد نجاح حذف الملفات (لا TRUNCATE، لا يُنفَّذ الآن):
-- BEGIN;
-- DELETE FROM public.evidences WHERE id IN (SELECT id FROM public.evidences);
-- SELECT COUNT(*) FROM public.evidences;
-- COMMIT;

-- يُحظر حذف:
-- programs, program_indicators, initiatives, tasks, settings,
-- school_years, profiles, public.users
