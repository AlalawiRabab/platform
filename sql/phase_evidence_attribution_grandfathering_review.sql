-- ============================================================
-- REVIEW ONLY — DO NOT RUN AUTOMATICALLY. Manual apply in the SQL Editor after separate approval.
-- ============================================================
-- phase_evidence_attribution_grandfathering_review.sql
-- مبدأ grandfathering لاسم المعلمة واسم عرض الرابط وhttps
-- Rollback مستقل: sql/phase_evidence_attribution_grandfathering_rollback_review.sql
-- ============================================================
-- المتطلب السابق: phase_evidence_attribution_review.sql مطبَّق (الدالة بالنسخة f1aeb900…).
-- يصلح قبل تفعيل الوضع الصارم أو بعده.
--
-- ماذا يغيّر (دالة التحقق فقط؛ لا بيانات):
--   * الوضع المتوافق: بلا أي تغيير في السلوك.
--   * الوضع الصارم — INSERT: كما هو (person 2–100 بعد trim، اسم عرض لمرفق الرابط ≤150، https فقط).
--   * الوضع الصارم — UPDATE:
--       - إذا تغيّر أي من حقول المحتوى (person, file_name, file_url, link, evidence_link)
--         تُطبَّق كل الشروط الصارمة على الصف الناتج (كان سابقاً يتحقق من الحقل المتغيّر وحده،
--         فتغيير الرابط أو الملف في شاهد قديم بلا اسم معلمة كان يمرّ).
--       - غير ذلك (is_approved / approved_by / approved_at / notes / أي عمود آخر): لا شرط إطلاقاً،
--         فيبقى اعتماد الشواهد القديمة بلا اسم معلمة وإلغاؤه وتعديل ملاحظاتها ممكناً.
--   * لا backfill، لا أسماء افتراضية، لا UPDATE/DELETE لأي صف، لا NOT NULL/CHECK/DEFAULT.
--   * لا يغيّر الـ Trigger ولا RLS ولا الصلاحيات ولا Storage.
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
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.validate_evidence_attribution()'::regprocedure)
     NOT IN ('f1aeb900e059ceba0a178856fb355743', 'd61528202d04396bb9e47118a3a673ab') THEN
    RAISE EXCEPTION 'STOP: نسخة دالة التحقق غير متوقعة — راجعها قبل الاستبدال';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                 WHERE oid = 'public.validate_evidence_attribution()'::regprocedure
                   AND prosecdef AND array_to_string(proconfig, ',') = 'search_path=""'
                   AND pg_get_userbyid(proowner) = 'postgres') THEN
    RAISE EXCEPTION 'STOP: الدالة ليست SECURITY DEFINER بـ search_path فارغ، أو مالكها ليس postgres';
  END IF;
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'STOP: شغّلي هذا الملف بدور postgres (مالك الدالة)';
  END IF;
END
$pre$;

CREATE TEMP TABLE _attribution_gf_precheck ON COMMIT DROP AS
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
  content_changed boolean;
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
  END IF;

  link_only := coalesce(btrim(NEW.file_url), '') = ''
    AND (coalesce(btrim(NEW.link), '') <> '' OR coalesce(btrim(NEW.evidence_link), '') <> '');

  IF link_only AND (TG_OP = 'INSERT' OR NEW.file_name IS DISTINCT FROM OLD.file_name) THEN
    NEW.file_name := NULLIF(btrim(regexp_replace(coalesce(NEW.file_name, ''), '\s+', ' ', 'g')), '');
  END IF;

  -- البروتوكول في الوضعين عند الإضافة أو تغيير الرابط
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

  IF NOT strict_mode THEN
    RETURN NEW;
  END IF;

  -- grandfathering: الصفوف القديمة لا تُفحص إلا إذا تغيّر محتواها (لا عند الاعتماد أو الملاحظات)
  content_changed := TG_OP = 'INSERT'
    OR NEW.person IS DISTINCT FROM OLD.person
    OR NEW.file_name IS DISTINCT FROM OLD.file_name
    OR NEW.file_url IS DISTINCT FROM OLD.file_url
    OR NEW.link IS DISTINCT FROM OLD.link
    OR NEW.evidence_link IS DISTINCT FROM OLD.evidence_link;
  IF NOT content_changed THEN
    RETURN NEW;
  END IF;

  IF NEW.person IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'يرجى كتابة اسم المعلمة المسؤولة عن الشاهد',
      HINT = 'evidence_person_required';
  END IF;
  IF char_length(NEW.person) < 2 OR char_length(NEW.person) > 100 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'اسم المعلمة المسؤولة يجب أن يكون بين 2 و100 حرفاً',
      HINT = 'evidence_person_length';
  END IF;
  IF coalesce(btrim(NEW.link), '') <> '' AND NEW.link !~* url_pattern THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = url_message, HINT = 'evidence_link_protocol';
  END IF;
  IF coalesce(btrim(NEW.evidence_link), '') <> '' AND NEW.evidence_link !~* url_pattern THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = url_message, HINT = 'evidence_link_protocol';
  END IF;
  IF link_only THEN
    NEW.file_name := NULLIF(btrim(regexp_replace(coalesce(NEW.file_name, ''), '\s+', ' ', 'g')), '');
    IF NEW.file_name IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'يرجى كتابة اسم الملف أو الشاهد لكل رابط',
        HINT = 'evidence_link_label_required';
    END IF;
    IF char_length(NEW.file_name) > 150 THEN
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
  INSERT INTO public.platform_migration_history (migration_key)
  VALUES ('phase_evidence_attribution_grandfathering_v1')
  ON CONFLICT (migration_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n NOT IN (0, 1) THEN
    RAISE EXCEPTION 'STOP: سجل التنفيذ أدخل % صفوف (المسموح 0 أو 1)', n;
  END IF;
  IF (SELECT count(*) FROM public.platform_migration_history
      WHERE migration_key = 'phase_evidence_attribution_grandfathering_v1') <> 1 THEN
    RAISE EXCEPTION 'STOP: migration_key غير موجود مرة واحدة بالضبط';
  END IF;
END
$hist$;

DO $post$
DECLARE
  b record;
BEGIN
  SELECT * INTO b FROM _attribution_gf_precheck;
  IF b.evidences_cnt IS DISTINCT FROM (SELECT count(*) FROM public.evidences)
     OR b.evidences_md5 IS DISTINCT FROM
        (SELECT md5(coalesce(string_agg(to_jsonb(e)::text, ',' ORDER BY e.id), '')) FROM public.evidences e)
     OR b.storage_cnt IS DISTINCT FROM (SELECT count(*) FROM storage.objects WHERE bucket_id = 'evidences') THEN
    RAISE EXCEPTION 'STOP: تغيّرت البيانات — تم التراجع';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.validate_evidence_attribution()'::regprocedure)
     IS DISTINCT FROM 'd61528202d04396bb9e47118a3a673ab' THEN
    RAISE EXCEPTION 'STOP: جسم الدالة بعد الاستبدال لا يطابق النسخة المراجعة';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                 WHERE oid = 'public.validate_evidence_attribution()'::regprocedure
                   AND prosecdef AND array_to_string(proconfig, ',') = 'search_path=""') THEN
    RAISE EXCEPTION 'STOP: الدالة فقدت SECURITY DEFINER أو search_path الفارغ';
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
  IF pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = 'public.validate_evidence_attribution()'::regprocedure)) <> 'postgres' THEN
    RAISE EXCEPTION 'STOP: مالك الدالة ليس postgres';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
             WHERE p.oid = 'public.validate_evidence_attribution()'::regprocedure
               AND a.privilege_type = 'EXECUTE'
               AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) NOT IN ('postgres', 'service_role'))) THEN
    RAISE EXCEPTION 'STOP: صلاحية EXECUTE على الدالة لغير postgres/service_role';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.validate_evidence_attribution()'::regprocedure)
     ~* '(^|[^a-z_])(execute|format)([^a-z_]|$)' THEN
    RAISE EXCEPTION 'STOP: الدالة تحتوي SQL ديناميكياً غير متوقع';
  END IF;
  -- «IS DISTINCT FROM» مقارنة وليست جدولاً، و«SELECT … INTO» متغير PL/pgSQL
  IF regexp_replace((SELECT prosrc FROM pg_proc WHERE oid = 'public.validate_evidence_attribution()'::regprocedure),
                    'distinct\s+from', '', 'gi')
     ~* '(^|[^a-z_])(from|join|update|insert\s+into|delete\s+from)\s+(?!public\.)' THEN
    RAISE EXCEPTION 'STOP: الدالة تشير إلى جدول غير مؤهل بالمخطط public';
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

-- ============================================================
-- POSTCHECK (قراءة فقط):
--   SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.validate_evidence_attribution()'::regprocedure;
--     -- المتوقع: d61528202d04396bb9e47118a3a673ab
--   SELECT count(*) FROM public.evidences;   -- مطابق لما قبل التطبيق
-- ============================================================

-- تراجع: sql/phase_evidence_attribution_grandfathering_rollback_review.sql
--   (يعيد جسم الدالة السابق حرفياً f1aeb900… ويحذف مفتاح هذا الملف فقط؛ لا يمس البيانات)
--   يرفض التنفيذ إذا كان الوضع الصارم مفعّلاً: شغّلي أولاً sql/phase_evidence_attribution_strict_rollback_review.sql
