-- ============================================================
-- phase_login_throttle_review.sql   (الخطوة 5 — قبل نشر username-login الجديدة)
-- حدّ لمحاولات الدخول لـ Edge Function username-login
-- مراجعة / تطبيق يدوي — لا يُنفَّذ تلقائياً
-- ============================================================
-- لماذا: Auth يحدّ المحاولات حسب IP، وكل طلبات signInWithPassword تأتي من IP الدالة نفسها،
--   فالحد الأصلي لا يحمي حسابًا بعينه من التخمين. وفحص Origin لا يوقف عميلًا خارج المتصفح.
-- التصميم:
--   * private.login_attempts: جدول خارج schema public (غير مكشوف عبر REST)، بلا منح للعملاء.
--   * المفاتيح تُخزَّن SHA-256 (لا أسماء مستخدمين ولا عناوين IP صريحة).
--   * كل محاولة تُسجَّل قبل التحقق من كلمة المرور (يمنع تجاوز الحد بطلبات متزامنة)،
--     والنجاح يمحو محاولات اسم المستخدم ومحاولة الـ IP الحالية.
--   * الحد: 5 محاولات لكل اسم مستخدم و 30 لكل IP خلال 15 دقيقة (نافذة منزلقة).
--   * الدوال للـ service_role فقط (لا anon ولا authenticated).
-- أثر جانبي مقبول: من يعرف اسم مستخدم يستطيع قفله مؤقتًا (15 دقيقة كحد أقصى) بمحاولات خاطئة.
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

-- يسجّل محاولة إن كانت مسموحة؛ وإلا يعيد مدة الانتظار دون تسجيل.
CREATE OR REPLACE FUNCTION public.login_throttle_begin(p_user_key text, p_ip_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_window constant interval := interval '15 minutes';
  v_user_limit constant int := 5;
  v_ip_limit constant int := 30;
  v_user text;
  v_ip text;
  v_cnt int;
  v_oldest timestamptz;
  v_retry int := 0;
  v_attempt uuid := gen_random_uuid();
BEGIN
  IF p_user_key IS NULL OR p_user_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid user key';
  END IF;
  IF p_ip_key IS NOT NULL AND p_ip_key <> '' AND p_ip_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid ip key';
  END IF;
  v_user := 'u:' || p_user_key;
  v_ip := CASE WHEN COALESCE(p_ip_key, '') = '' THEN NULL ELSE 'ip:' || p_ip_key END;

  -- تسلسل المحاولات المتزامنة لنفس اسم المستخدم
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user, 0));

  SELECT COUNT(*), MIN(attempted_at) INTO v_cnt, v_oldest
  FROM private.login_attempts
  WHERE key = v_user AND attempted_at > now() - v_window;
  IF v_cnt >= v_user_limit THEN
    v_retry := GREATEST(v_retry, CEIL(EXTRACT(EPOCH FROM (v_oldest + v_window - now())))::int);
  END IF;

  IF v_ip IS NOT NULL THEN
    SELECT COUNT(*), MIN(attempted_at) INTO v_cnt, v_oldest
    FROM private.login_attempts
    WHERE key = v_ip AND attempted_at > now() - v_window;
    IF v_cnt >= v_ip_limit THEN
      v_retry := GREATEST(v_retry, CEIL(EXTRACT(EPOCH FROM (v_oldest + v_window - now())))::int);
    END IF;
  END IF;

  IF v_retry > 0 THEN
    RETURN jsonb_build_object('allowed', false, 'retry_after', GREATEST(v_retry, 1));
  END IF;

  INSERT INTO private.login_attempts (key, attempt_id) VALUES (v_user, v_attempt);
  IF v_ip IS NOT NULL THEN
    INSERT INTO private.login_attempts (key, attempt_id) VALUES (v_ip, v_attempt);
  END IF;

  DELETE FROM private.login_attempts WHERE attempted_at < now() - interval '1 day';

  RETURN jsonb_build_object('allowed', true, 'attempt_id', v_attempt);
END;
$$;

-- نجاح الدخول: يمحو محاولات اسم المستخدم + سجل هذه المحاولة للـ IP
CREATE OR REPLACE FUNCTION public.login_throttle_success(p_user_key text, p_attempt_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_user_key IS NULL OR p_user_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid user key';
  END IF;
  DELETE FROM private.login_attempts
  WHERE key = 'u:' || p_user_key OR attempt_id = p_attempt_id;
END;
$$;

REVOKE ALL ON FUNCTION public.login_throttle_begin(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.login_throttle_begin(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.login_throttle_begin(text, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.login_throttle_success(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.login_throttle_success(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.login_throttle_success(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.login_throttle_begin(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.login_throttle_success(text, uuid) TO service_role;

SELECT 1 / CASE WHEN NOT has_function_privilege('anon', 'public.login_throttle_begin(text,text)', 'EXECUTE')
                 AND NOT has_function_privilege('authenticated', 'public.login_throttle_begin(text,text)', 'EXECUTE')
                 AND has_function_privilege('service_role', 'public.login_throttle_begin(text,text)', 'EXECUTE')
           THEN 1 ELSE 0 END AS tx_check_service_role_only;

COMMIT;

-- POSTCHECK:
--   6 محاولات خاطئة لنفس اسم المستخدم خلال دقائق → السادسة 429 too_many_attempts
--   دخول صحيح بعد محاولتين خاطئتين → يمحو العداد
--   SELECT COUNT(*) FROM private.login_attempts;  -- من SQL Editor فقط

-- ROLLBACK (بعد إرجاع username-login للنسخة السابقة أولًا، وإلا يتعطل الدخول):
/*
BEGIN;
DROP FUNCTION IF EXISTS public.login_throttle_begin(text, text);
DROP FUNCTION IF EXISTS public.login_throttle_success(text, uuid);
DROP TABLE IF EXISTS private.login_attempts;
COMMIT;
*/
