-- ============================================================
-- REVIEW ONLY — DO NOT RUN AUTOMATICALLY. Rollback for phase_evidence_attribution_review.sql
-- Run manually in the SQL Editor only after a separate approval, and only if that migration was applied.
-- Byte-identical to the rollback block at the end of phase_evidence_attribution_review.sql (checked by tests/evidence-attribution/sql-test.mjs).
--
-- What it does: drops the validation trigger + function, removes the comment on evidences.person,
-- and deletes the migration history row. It drops NO columns (the migration added none) and does not
-- touch any row: teacher names / display names saved after the migration stay in person / file_name.
-- The existing comment on evidences.file_name is not touched by the migration nor by this rollback.
-- ============================================================
BEGIN;
DROP TRIGGER IF EXISTS trg_validate_evidence_attribution ON public.evidences;
DROP FUNCTION IF EXISTS public.validate_evidence_attribution();
COMMENT ON COLUMN public.evidences.person IS NULL;
DELETE FROM public.platform_migration_history WHERE migration_key = 'phase_evidence_attribution_v1';
NOTIFY pgrst, 'reload schema';
COMMIT;
