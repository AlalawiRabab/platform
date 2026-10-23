-- ============================================================
-- REVIEW ONLY — DO NOT RUN AUTOMATICALLY. Rollback for phase_evidence_attribution_grandfathering_review.sql
-- Run manually in the SQL Editor only after a separate approval, and only if that migration was applied.
-- ============================================================
-- What it does: restores the previous body of public.validate_evidence_attribution() verbatim
-- (md5(prosrc) = f1aeb900e059ceba0a178856fb355743, as applied by phase_evidence_attribution_review.sql) and deletes the
-- history row phase_evidence_attribution_grandfathering_v1. Owner, SECURITY DEFINER, search_path, ACL and the
-- trigger are kept (CREATE OR REPLACE). It does not touch any row, RLS or Storage.
--
-- Scope guard: it REFUSES to run while strict mode is enabled (history key phase_evidence_attribution_strict_v1).
-- Run sql/phase_evidence_attribution_strict_rollback_review.sql first (back to compatible mode), then this file.
-- Expected ROW_COUNT of the history DELETE: 1 if the migration was applied, 0 on a re-run; anything else stops.
-- ============================================================
BEGIN;

DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM public.platform_migration_history
             WHERE migration_key = 'phase_evidence_attribution_strict_v1') THEN
    RAISE EXCEPTION 'STOP: الوضع الصارم مفعّل. شغّلي أولاً phase_evidence_attribution_strict_rollback_review.sql ثم أعيدي هذا الملف';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.validate_evidence_attribution()'::regprocedure)
     NOT IN ('d61528202d04396bb9e47118a3a673ab', 'f1aeb900e059ceba0a178856fb355743') THEN
    RAISE EXCEPTION 'STOP: نسخة دالة التحقق غير متوقعة — راجعها قبل التراجع';
  END IF;
  IF pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = 'public.validate_evidence_attribution()'::regprocedure)) <> 'postgres'
     OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'STOP: مالك الدالة أو الدور الحالي ليس postgres';
  END IF;
END
$pre$;

CREATE TEMP TABLE _attribution_gf_rollback_precheck ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM public.evidences) AS evidences_cnt,
  (SELECT md5(coalesce(string_agg(to_jsonb(e)::text, ',' ORDER BY e.id), '')) FROM public.evidences e) AS evidences_md5,
  (SELECT count(*) FROM storage.objects WHERE bucket_id = 'evidences') AS storage_cnt,
  (SELECT coalesce(proacl::text, '') FROM pg_proc WHERE oid = 'public.validate_evidence_attribution()'::regprocedure) AS fn_acl;

CREATE OR REPLACE FUNCTION public.validate_evidence_attribution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  link_only boolean;
  strict_mode boolean;
  url_pattern text;
  url_message constant text := 'الرابط غير صالح. يجب أن يبدأ بـ https://';
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.platform_migration_history AS h
                 WHERE h.migration_key = 'phase_evidence_attribution_strict_v1')
    INTO strict_mode;
  -- الوضع المتوافق يقبل http أيضاً لأن الواجهة القديمة تقبله؛ الصارم https فقط
  url_pattern := CASE WHEN strict_mode
    THEN '^https://[a-z0-9.-]+\.[a-z0-9-]+(:[0-9]{1,5})?([/?#][^[:space:]]*)?$'
    ELSE '^https?://[a-z0-9.-]+\.[a-z0-9-]+(:[0-9]{1,5})?([/?#][^[:space:]]*)?$' END;

  IF TG_OP = 'INSERT' OR NEW.person IS DISTINCT FROM OLD.person THEN
    NEW.person := NULLIF(btrim(regexp_replace(coalesce(NEW.person, ''), '\s+', ' ', 'g')), '');
    IF strict_mode AND NEW.person IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'يرجى كتابة اسم المعلمة المسؤولة عن الشاهد',
        HINT = 'evidence_person_required';
    END IF;
    IF strict_mode AND (char_length(NEW.person) < 2 OR char_length(NEW.person) > 100) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'اسم المعلمة المسؤولة يجب أن يكون بين 2 و100 حرفاً',
        HINT = 'evidence_person_length';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.link IS DISTINCT FROM OLD.link THEN
    IF coalesce(btrim(NEW.link), '') <> '' AND NEW.link !~* url_pattern THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = url_message, HINT = 'evidence_link_protocol';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.evidence_link IS DISTINCT FROM OLD.evidence_link THEN
    IF coalesce(btrim(NEW.evidence_link), '') <> '' AND NEW.evidence_link !~* url_pattern THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = url_message, HINT = 'evidence_link_protocol';
    END IF;
  END IF;

  link_only := coalesce(btrim(NEW.file_url), '') = ''
    AND (coalesce(btrim(NEW.link), '') <> '' OR coalesce(btrim(NEW.evidence_link), '') <> '');

  IF link_only AND (TG_OP = 'INSERT' OR NEW.file_name IS DISTINCT FROM OLD.file_name) THEN
    NEW.file_name := NULLIF(btrim(regexp_replace(coalesce(NEW.file_name, ''), '\s+', ' ', 'g')), '');
    IF strict_mode AND NEW.file_name IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'يرجى كتابة اسم الملف أو الشاهد لكل رابط',
        HINT = 'evidence_link_label_required';
    END IF;
    IF strict_mode AND char_length(NEW.file_name) > 150 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'اسم الملف أو الشاهد يجب ألا يتجاوز 150 حرفاً',
        HINT = 'evidence_link_label_length';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_evidence_attribution() FROM PUBLIC, anon, authenticated;

DO $hist$
DECLARE
  n integer;
BEGIN
  DELETE FROM public.platform_migration_history WHERE migration_key = 'phase_evidence_attribution_grandfathering_v1';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n NOT IN (0, 1) THEN
    RAISE EXCEPTION 'STOP: حذف سجل التنفيذ أثّر في % صفوف (المسموح 0 أو 1)', n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.platform_migration_history
             WHERE migration_key = 'phase_evidence_attribution_grandfathering_v1') THEN
    RAISE EXCEPTION 'STOP: مفتاح grandfathering ما زال موجوداً';
  END IF;
END
$hist$;

DO $post$
DECLARE
  b record;
BEGIN
  SELECT * INTO b FROM _attribution_gf_rollback_precheck;
  IF b.evidences_cnt IS DISTINCT FROM (SELECT count(*) FROM public.evidences)
     OR b.evidences_md5 IS DISTINCT FROM
        (SELECT md5(coalesce(string_agg(to_jsonb(e)::text, ',' ORDER BY e.id), '')) FROM public.evidences e)
     OR b.storage_cnt IS DISTINCT FROM (SELECT count(*) FROM storage.objects WHERE bucket_id = 'evidences') THEN
    RAISE EXCEPTION 'STOP: تغيّرت البيانات — تم التراجع';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.validate_evidence_attribution()'::regprocedure)
     IS DISTINCT FROM 'f1aeb900e059ceba0a178856fb355743' THEN
    RAISE EXCEPTION 'STOP: لم يُستعد جسم الدالة السابق حرفياً';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                 WHERE oid = 'public.validate_evidence_attribution()'::regprocedure
                   AND prosecdef AND array_to_string(proconfig, ',') = 'search_path=""'
                   AND pg_get_userbyid(proowner) = 'postgres') THEN
    RAISE EXCEPTION 'STOP: الدالة فقدت SECURITY DEFINER أو search_path الفارغ أو المالك postgres';
  END IF;
  IF has_function_privilege('public', 'public.validate_evidence_attribution()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.validate_evidence_attribution()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.validate_evidence_attribution()', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP: دالة التحقق قابلة للاستدعاء من PUBLIC/anon/authenticated';
  END IF;
  IF b.fn_acl IS DISTINCT FROM (SELECT coalesce(proacl::text, '') FROM pg_proc
                                WHERE oid = 'public.validate_evidence_attribution()'::regprocedure) THEN
    RAISE EXCEPTION 'STOP: تغيّرت صلاحيات الدالة';
  END IF;
  IF EXISTS (SELECT 1 FROM public.platform_migration_history
             WHERE migration_key = 'phase_evidence_attribution_strict_v1') THEN
    RAISE EXCEPTION 'STOP: الوضع الصارم مفعّل بعد التراجع';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.evidences'::regclass
                   AND tgname = 'trg_validate_evidence_attribution' AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'STOP: الـ Trigger لم يعد مفعّلاً';
  END IF;
END
$post$;

NOTIFY pgrst, 'reload schema';

COMMIT;
