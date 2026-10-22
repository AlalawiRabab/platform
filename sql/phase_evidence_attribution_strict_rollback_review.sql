-- ============================================================
-- REVIEW ONLY — DO NOT RUN AUTOMATICALLY. Rollback for phase_evidence_attribution_strict_review.sql
-- Run manually in the SQL Editor only after a separate approval, and only if strict mode was enabled.
-- Byte-identical to the rollback block at the end of phase_evidence_attribution_strict_review.sql (checked by tests/evidence-attribution/sql-test.mjs).
--
-- What it does: deletes the history row phase_evidence_attribution_strict_v1 only, so the trigger goes back to
-- the compatible mode (no required teacher name / link label; http or https links). The trigger, function and
-- all data stay as they are.
-- ============================================================
BEGIN;
DELETE FROM public.platform_migration_history WHERE migration_key = 'phase_evidence_attribution_strict_v1';
COMMIT;
