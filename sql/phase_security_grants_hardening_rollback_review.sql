-- ============================================================
-- REVIEW ONLY — DO NOT RUN AUTOMATICALLY. Rollback for phase_security_grants_hardening_review.sql
-- ============================================================
-- !!! WARNING / تحذير !!!
-- !!! This rollback RE-OPENS dangerous anon privileges on public.evidence_requirements,
-- !!! including DELETE and TRUNCATE (TRUNCATE bypasses RLS), and re-grants TRUNCATE/REFERENCES/
-- !!! TRIGGER/MAINTAIN to authenticated and EXECUTE on trigger functions to anon/authenticated.
-- !!! هذا الملف يعيد صلاحيات anon الخطرة على evidence_requirements ومنها DELETE وTRUNCATE.
-- !!!
-- !!! - Never run automatically. لا يُشغَّل تلقائياً.
-- !!! - Emergency use only, after a confirmed incident and a separate explicit approval.
-- !!!   لا يُستخدم إلا في طوارئ مؤكدة وبعد موافقة منفصلة.
-- !!! - If the UI breaks after the hardening, FIRST fix the specific missing GRANT
-- !!!   (e.g. GRANT EXECUTE ON FUNCTION public.<fn> TO authenticated;) — do NOT run this full rollback.
-- !!!   عند تعطّل الواجهة: أصلح الـ GRANT المحدد الناقص أولاً، وليس تشغيل هذا الـ Rollback الكامل.
-- ============================================================
-- Restores the exact ACLs read from production on 2026-10-22.
-- Byte-identical to the rollback block at the end of phase_security_grants_hardening_review.sql (checked by tests/evidence-attribution/sql-test.mjs).
-- ============================================================
BEGIN;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.evidence_requirements TO anon;
GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE
  public.evidences, public.evidence_requirements, public.programs, public.initiatives,
  public.school_years, public.settings, public.teacher_followups
TO authenticated;
GRANT REFERENCES, TRIGGER, MAINTAIN ON TABLE public.program_indicators, public.tasks TO authenticated;
GRANT EXECUTE ON FUNCTION
  public.enforce_evidence_requirement_approval(),
  public.enforce_evidence_requirement_indicator_match(),
  public.prevent_delete_requirement_with_approved_attachment(),
  public.protect_approved_evidence_attachment(),
  public.set_evidence_created_by(),
  public.set_evidence_requirement_created_by(),
  public.set_evidence_requirements_updated_at(),
  public.set_profiles_updated_at(),
  public.evidence_attachment_present(jsonb),
  public.is_admin(),
  public.is_staff(),
  public.current_app_role()
TO anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.rls_auto_enable(),
  public.get_active_school_year(),
  public.list_school_years(boolean)
TO PUBLIC, anon, authenticated;
ALTER FUNCTION public.evidence_attachment_present(jsonb) RESET search_path;
DELETE FROM public.platform_migration_history WHERE migration_key = 'phase_security_grants_hardening_v1';
NOTIFY pgrst, 'reload schema';
COMMIT;
