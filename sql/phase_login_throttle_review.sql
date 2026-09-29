-- ============================================================
-- phase_login_throttle_review.sql   (الخطوة 5 — قبل نشر username-login الجديدة)
-- حدّ لمحاولات الدخول لـ Edge Function username-login
-- مراجعة / تطبيق يدوي — لا يُنفَّذ تلقائياً
-- ============================================================
-- لماذا: Auth يحدّ المحاولات حسب IP، وكل طلبات signInWithPassword تأتي من IP الدالة نفسها،
--   فالحد الأصلي لا يحمي حسابًا من التخمين. وفحص Origin لا يوقف عميلًا خارج المتصفح.
--
-- واقع المدرسة: كل المعلمات يدخلن بحساب مشترك واحد ومن شبكة المدرسة نفسها (IP واحد).
--   لذلك الحد الأساسي لكل (اسم مستخدم + IP) — لا لكل اسم مستخدم وحده، ولا لكل IP وحده:
--   * pair  (اسم + IP): 10 محاولات فاشلة / 15 دقيقة → يقفل هذا الاسم من هذه الشبكة فقط.
--       أي دخول ناجح للاسم من الشبكة نفسها قبل بلوغ الحد يصفّر عدّادها، فأخطاء متفرقة من
--       معلمات مختلفات لا تتراكم. عند بلوغ الحد يُرفض حتى الكود الصحيح من هذه الشبكة حتى
--       تمضي 15 دقيقة على أقدم محاولة. محاولات مهاجم من شبكة أخرى لا تقفل المدرسة.
--   خطر متبقٍ: 100 محاولة موزعة على 10 شبكات أو أكثر تقفل الاسم للجميع 15 دقيقة.
--   * user  (اسم عبر كل الشبكات): 100 / 15 دقيقة → سقف للتخمين الموزّع من شبكات كثيرة.
--   * ip    (شبكة عبر كل الأسماء): 200 / 15 دقيقة → سقف لرشّ أسماء كثيرة من شبكة واحدة.
--   المحاولات الناجحة لا تُحتسب على أي عدّاد (تُمحى سجلات المحاولة نفسها).
--
-- التخزين: private.login_attempts خارج public (غير مكشوف عبر REST)، مفاتيح SHA-256 فقط،
--   RLS مفعّل بلا سياسات، والدوال لـ service_role فقط.
-- ============================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON SCHEMA private FROM anon;
REVOKE ALL ON SCHEMA private FROM authenticated;

CREATE TABLE IF NOT EXISTS private.login_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL,
  attempt_id uuid NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_key_time_idx ON private.login_attempts (key, attempted_at);
CREATE INDEX IF NOT EXISTS login_attempts_time_idx ON private.login_attempts (attempted_at);
CREATE INDEX IF NOT EXISTS login_attempts_attempt_idx ON private.login_attempts (attempt_id);
ALTER TABLE private.login_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.login_attempts FROM PUBLIC;
REVOKE ALL ON TABLE private.login_attempts FROM anon;
REVOKE ALL ON TABLE private.login_attempts FROM authenticated;

DROP FUNCTION IF EXISTS public.login_throttle_begin(text, text);
DROP FUNCTION IF EXISTS public.login_throttle_success(text, uuid);

-- يسجّل محاولة إن كانت مسموحة؛ وإلا يعيد مدة الانتظار دون تسجيل.
-- p_pair_key = sha256(lower(username) || '|' || ip)
CREATE OR REPLACE FUNCTION public.login_throttle_begin(p_user_key text, p_ip_key text, p_pair_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_window constant interval := interval '15 minutes';
  v_limits constant jsonb := '{"pr": 10, "u": 100, "ip": 200}';
  v_keys text[];
  v_key text;
  v_cnt int;
  v_oldest timestamptz;
  v_retry int := 0;
  v_attempt uuid := gen_random_uuid();
BEGIN
  IF p_user_key IS NULL OR p_user_key !~ '^[0-9a-f]{64}$'
     OR p_pair_key IS NULL OR p_pair_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid key';
  END IF;
  IF p_ip_key IS NOT NULL AND p_ip_key <> '' AND p_ip_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid ip key';
  END IF;

  v_keys := ARRAY['pr:' || p_pair_key, 'u:' || p_user_key];
  IF COALESCE(p_ip_key, '') <> '' THEN
    v_keys := v_keys || ('ip:' || p_ip_key);
  END IF;

  -- تسلسل المحاولات المتزامنة لنفس (الاسم + الشبكة)
  PERFORM pg_advisory_xact_lock(hashtextextended('pr:' || p_pair_key, 0));

  FOREACH v_key IN ARRAY v_keys LOOP
    SELECT COUNT(*), MIN(attempted_at) INTO v_cnt, v_oldest
    FROM private.login_attempts
    WHERE key = v_key AND attempted_at > now() - v_window;
    IF v_cnt >= (v_limits ->> split_part(v_key, ':', 1))::int THEN
      v_retry := GREATEST(v_retry, CEIL(EXTRACT(EPOCH FROM (v_oldest + v_window - now())))::int);
    END IF;
  END LOOP;

  IF v_retry > 0 THEN
    RETURN jsonb_build_object('allowed', false, 'retry_after', GREATEST(v_retry, 1));
  END IF;

  INSERT INTO private.login_attempts (key, attempt_id)
  SELECT k, v_attempt FROM unnest(v_keys) AS k;

  DELETE FROM private.login_attempts WHERE attempted_at < now() - interval '1 day';

  RETURN jsonb_build_object('allowed', true, 'attempt_id', v_attempt);
END;
$$;

-- نجاح الدخول: يمحو سجلات هذه المحاولة + عدّاد (الاسم + الشبكة) نفسها فقط.
-- عدّادات الاسم العامة من شبكات أخرى تبقى حتى انتهاء نافذتها.
CREATE OR REPLACE FUNCTION public.login_throttle_success(p_pair_key text, p_attempt_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_pair_key IS NULL OR p_pair_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid key';
  END IF;
  DELETE FROM private.login_attempts
  WHERE attempt_id = p_attempt_id OR key = 'pr:' || p_pair_key;
END;
$$;

REVOKE ALL ON FUNCTION public.login_throttle_begin(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.login_throttle_begin(text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.login_throttle_begin(text, text, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.login_throttle_success(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.login_throttle_success(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.login_throttle_success(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.login_throttle_begin(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.login_throttle_success(text, uuid) TO service_role;

SELECT 1 / CASE WHEN NOT has_function_privilege('anon', 'public.login_throttle_begin(text,text,text)', 'EXECUTE')
                 AND NOT has_function_privilege('authenticated', 'public.login_throttle_begin(text,text,text)', 'EXECUTE')
                 AND has_function_privilege('service_role', 'public.login_throttle_begin(text,text,text)', 'EXECUTE')
           THEN 1 ELSE 0 END AS tx_check_service_role_only;

COMMIT;

-- POSTCHECK:
--   11 محاولة خاطئة لنفس الاسم من الشبكة نفسها → الحادية عشرة 429 too_many_attempts
--   دخول صحيح من الشبكة نفسها (بعد انتهاء القفل أو قبله) يصفّر عدّادها
--   SELECT split_part(key, ':', 1) AS kind, COUNT(*) FROM private.login_attempts GROUP BY 1;  -- SQL Editor فقط

-- ROLLBACK (بعد إرجاع username-login للنسخة السابقة أولًا، وإلا يتعطل الدخول):
/*
BEGIN;
DROP FUNCTION IF EXISTS public.login_throttle_begin(text, text, text);
DROP FUNCTION IF EXISTS public.login_throttle_success(text, uuid);
DROP TABLE IF EXISTS private.login_attempts;
COMMIT;
*/
