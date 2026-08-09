-- ============================================================
-- academic_year_archive_foundation_v2_review.sql
-- مراجعة فقط — المرحلة 1 (v2) لأرشفة السنوات
-- الفرع: feature/academic-year-archive-hijri-calendar
-- يستبدل مقترح: sql/academic_year_archive_foundation_review.sql (v1)
-- التراجع بعد COMMIT: sql/academic_year_archive_foundation_rollback_review.sql
-- ============================================================
-- الغرض (v2):
--   - frozen + توحيد الحالات
--   - كتابة تشغيلية على status='active' فقط
--   - حقول الحالة (status/is_active/is_archived) لا تُغيَّر إلا عبر دوال admin
--   - activate لا يجمّد تلقائياً إلا مع p_freeze_current=true
--   - قفل تزامن عند التفعيل
--
-- مصدر الحقيقة للتواريخ: الميلادي ISO (start_date/end_date).
-- hijri_year للعرض فقط — ليس مصدر حقيقة ولا يُستخدم في منطق الانتقال.
--
-- ترتيب تطبيق آمن مقترح (بعد موافقة المراجعة):
--   1) schema + functions + قيود school_years (هذا الملف)
--   2) الواجهة: فلترة السنة + استدعاء دوال admin من جلسة Auth حقيقية (JWT)
--   3) التحقق اليدوي ثم الاعتماد على RLS النهائي في هذا الملف
-- لا تختبر دوال admin من SQL Editor بدون JWT لجلسة المستخدم؛
-- is_admin()/auth.uid() يعتمدان على جلسة Auth حقيقية من الواجهة (أو عميل مع JWT).
--
-- يحافظ على: Supabase Auth، public.users مغلق، صلاحيات المعلمة
-- (مشاهدة + إرفاق شاهد في active فقط)، Storage خاص وSigned URLs (لا يُمس هنا).
--
-- ملاحظة مستقلة: حماية ملفات Storage الخاصة بالسنة المؤرشفة/المجمّدة
-- مرحلة لاحقة منفصلة — لم تُنفَّذ في هذا الملف (لا سياسات storage.objects هنا).
--
-- عند خطأ داخل BEGIN: نفّذ ROLLBACK; صراحة قبل إعادة المحاولة.
-- لا يُنفَّذ تلقائياً من المستودع.
-- ============================================================


-- ############################################################################
-- PRECHECK (قراءة فقط)
-- ############################################################################

-- P0) السنوات
SELECT id, name, status, is_active, is_archived, start_date, end_date, hijri_year
FROM public.school_years
ORDER BY created_at;

-- P1) عدد الحالات
SELECT
  COUNT(*) FILTER (
    WHERE is_active = true AND status = 'active' AND is_archived = false
  ) AS active_count,
  COUNT(*) AS total_years
FROM public.school_years;

-- P2) أعمدة school_years
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'school_years'
  AND column_name IN (
    'id', 'name', 'status', 'is_active', 'is_archived',
    'start_date', 'end_date', 'label_ar', 'hijri_year', 'notes'
  )
ORDER BY column_name;

-- P3) قيود school_years
SELECT tc.constraint_name, tc.constraint_type, cc.check_clause
FROM information_schema.table_constraints tc
LEFT JOIN information_schema.check_constraints cc
  ON cc.constraint_schema = tc.constraint_schema
 AND cc.constraint_name = tc.constraint_name
WHERE tc.table_schema = 'public'
  AND tc.table_name = 'school_years'
ORDER BY tc.constraint_type, tc.constraint_name;

-- P4) فهرس السنة النشطة الواحدة — التعريف الفعلي لا الاسم فقط
SELECT
  i.relname AS index_name,
  ix.indisunique AS is_unique,
  pg_get_expr(ix.indpred, ix.indrelid) AS partial_predicate,
  pg_get_indexdef(i.oid) AS index_def
FROM pg_class t
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_index ix ON ix.indrelid = t.oid
JOIN pg_class i ON i.oid = ix.indexrelid
WHERE n.nspname = 'public'
  AND t.relname = 'school_years'
  AND i.relname = 'school_years_one_active_idx';

-- P4b) بصمات activate_school_year الموجودة (كشف overload)
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef,
  p.proconfig
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'activate_school_year'
ORDER BY 2;

-- P5) school_year_id (uuid / nullability)
SELECT table_name, data_type, udt_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'school_year_id'
  AND table_name IN (
    'programs', 'initiatives', 'tasks', 'evidences', 'teacher_followups'
  )
ORDER BY table_name;

-- P6) FK الخمسة → school_years
SELECT tc.table_name, tc.constraint_name, ccu.table_name AS foreign_table
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name
 AND kcu.constraint_schema = tc.constraint_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
 AND ccu.constraint_schema = tc.constraint_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
  AND kcu.column_name = 'school_year_id'
  AND tc.table_name IN (
    'programs', 'initiatives', 'tasks', 'evidences', 'teacher_followups'
  )
ORDER BY tc.table_name;

-- P7) evidences.created_by
SELECT column_name, data_type, udt_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'evidences'
  AND column_name = 'created_by';

-- P8) RLS
SELECT c.relname, c.relrowsecurity
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    'school_years', 'programs', 'program_indicators', 'evidences',
    'initiatives', 'tasks', 'teacher_followups'
  )
ORDER BY c.relname;

-- P9) دوال الدور
SELECT p.proname, p.prosecdef, p.proconfig
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('current_app_role', 'is_admin')
ORDER BY p.proname;

-- P10) لقطة سياسات الجداول المستهدفة
SELECT tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'school_years', 'programs', 'program_indicators', 'evidences',
    'initiatives', 'tasks', 'teacher_followups', 'users'
  )
ORDER BY tablename, policyname;


-- ---------- STOP (يجب أن تكون فارغة) ----------

-- STOP: ليست سنة active واحدة بالضبط
SELECT
  'STOP: يلزم سنة active واحدة بالضبط'::text AS action,
  COUNT(*) FILTER (
    WHERE is_active = true AND status = 'active' AND is_archived = false
  ) AS active_count
FROM public.school_years
HAVING COUNT(*) FILTER (
  WHERE is_active = true AND status = 'active' AND is_archived = false
) IS DISTINCT FROM 1;

-- STOP: school_year_id ليس uuid NOT NULL
SELECT
  v.table_name,
  'STOP: school_year_id يجب uuid NOT NULL'::text AS action,
  c.udt_name,
  c.is_nullable
FROM (
  VALUES
    ('programs'), ('initiatives'), ('tasks'),
    ('evidences'), ('teacher_followups')
) AS v(table_name)
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public'
 AND c.table_name = v.table_name
 AND c.column_name = 'school_year_id'
WHERE c.column_name IS NULL
   OR c.is_nullable <> 'NO'
   OR c.udt_name IS DISTINCT FROM 'uuid';

-- STOP: نقص FK إلى school_years (يجب 5)
SELECT
  v.table_name,
  'STOP: FK school_year_id → school_years مفقود'::text AS action
FROM (
  VALUES
    ('programs'), ('initiatives'), ('tasks'),
    ('evidences'), ('teacher_followups')
) AS v(table_name)
WHERE NOT EXISTS (
  SELECT 1
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name
   AND kcu.constraint_schema = tc.constraint_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
   AND ccu.constraint_schema = tc.constraint_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
    AND tc.table_name = v.table_name
    AND kcu.column_name = 'school_year_id'
    AND ccu.table_name = 'school_years'
);

-- STOP: evidences.created_by ليس uuid
SELECT
  'STOP: evidences.created_by يجب أن يكون uuid'::text AS action,
  udt_name,
  data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'evidences'
  AND column_name = 'created_by'
  AND udt_name IS DISTINCT FROM 'uuid'
UNION ALL
SELECT
  'STOP: evidences.created_by مفقود'::text,
  NULL,
  NULL
WHERE NOT EXISTS (
  SELECT 1
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'evidences'
    AND column_name = 'created_by'
);

-- STOP: فهرس السنة النشطة غائب أو تعريفه غير مطابق
-- المطلوب: UNIQUE partial index يسمح بصف واحد فقط حيث is_active = true
SELECT
  'STOP: school_years_one_active_idx مفقود أو ليس UNIQUE partial على is_active=true'::text AS action
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_index ix ON ix.indrelid = t.oid
  JOIN pg_class i ON i.oid = ix.indexrelid
  WHERE n.nspname = 'public'
    AND t.relname = 'school_years'
    AND i.relname = 'school_years_one_active_idx'
    AND ix.indisunique IS TRUE
    AND ix.indpred IS NOT NULL
    AND pg_get_expr(ix.indpred, ix.indrelid) ~* 'is_active'
    AND pg_get_expr(ix.indpred, ix.indrelid) ~* 'true'
    AND pg_get_indexdef(i.oid) ILIKE '%UNIQUE%'
    AND pg_get_indexdef(i.oid) ILIKE '%WHERE%'
);

-- STOP: overload خطر — activate_school_year(uuid) بدون boolean
-- أوقف التنفيذ؛ داخل BEGIN يُحذف بأمان قبل إنشاء (uuid, boolean) إن وُجد
SELECT
  'STOP: وُجدت activate_school_year(uuid) — أزلها أو اعتمد معالجة BEGIN الآمنة قبل (uuid,boolean)'::text AS action,
  pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'activate_school_year'
  AND pg_get_function_identity_arguments(p.oid) = 'uuid';

-- STOP: دوال الدور غير آمنة / غائبة
SELECT
  v.fn AS function_name,
  'STOP: دالة دور غائبة أو بلا SECURITY DEFINER/search_path'::text AS action,
  p.prosecdef,
  p.proconfig
FROM (VALUES ('current_app_role'), ('is_admin')) AS v(fn)
LEFT JOIN pg_proc p
  ON p.proname = v.fn
 AND p.pronamespace = 'public'::regnamespace
WHERE p.oid IS NULL
   OR p.prosecdef IS NOT TRUE
   OR p.proconfig IS NULL
   OR NOT EXISTS (
        SELECT 1
        FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg(x)
        WHERE cfg.x LIKE 'search_path=%'
          AND cfg.x NOT LIKE 'search_path=%public%'
      );

-- STOP: سياسات anon/PUBLIC أو USING/WITH CHECK true
-- استثناء: users_deny_all فقط
SELECT
  'STOP: سياسة غير آمنة (anon/PUBLIC أو true)'::text AS action,
  tablename,
  policyname,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'school_years', 'programs', 'program_indicators', 'evidences',
    'initiatives', 'tasks', 'teacher_followups', 'settings', 'users'
  )
  AND policyname IS DISTINCT FROM 'users_deny_all'
  AND (
    roles::text ILIKE '%anon%'
    OR roles::text ILIKE '%public%'
    OR COALESCE(qual, '') IN ('true', '(true)')
    OR COALESCE(with_check, '') IN ('true', '(true)')
  );

-- STOP: RLS غير مفعّل
SELECT c.relname AS table_name, 'STOP: RLS غير مفعّل'::text AS action
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    'school_years', 'programs', 'program_indicators', 'evidences',
    'initiatives', 'tasks', 'teacher_followups'
  )
  AND c.relrowsecurity IS NOT TRUE;


-- ############################################################################
-- حاجز: لا تنفّذ BEGIN إن ظهر أي STOP
-- ############################################################################


-- ############################################################################
-- TRANSACTION
-- ############################################################################

BEGIN;

-- ------------------------------------------------------------
-- A) مساعدات السنة
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.school_year_allows_write(p_year_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  -- v2: الكتابة التشغيلية للسنة active فقط (ليس draft/frozen/archived)
  SELECT EXISTS (
    SELECT 1
    FROM public.school_years AS sy
    WHERE sy.id = p_year_id
      AND sy.is_active = true
      AND sy.is_archived = false
      AND sy.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.school_year_is_active(p_year_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.school_years AS sy
    WHERE sy.id = p_year_id
      AND sy.is_active = true
      AND sy.is_archived = false
      AND sy.status = 'active'
  );
$$;

REVOKE ALL ON FUNCTION public.school_year_allows_write(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.school_year_allows_write(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.school_year_is_active(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.school_year_is_active(uuid) FROM anon;
-- GRANT EXECUTE يُجمَّع لاحقاً مع بقية الدوال الإدارية

-- ------------------------------------------------------------
-- B) حارس يمنع تغيير حقول الحالة إلا عبر دوال admin (set_config)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trg_school_years_guard_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_allow text := current_setting('app.school_year_state_change', true);
BEGIN
  IF v_allow IS NOT DISTINCT FROM 'allowed' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.is_active IS DISTINCT FROM false
       OR NEW.is_archived IS DISTINCT FROM false
       OR NEW.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION
        'direct INSERT cannot set school year state; use create_school_year()';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.is_active IS DISTINCT FROM OLD.is_active
       OR NEW.is_archived IS DISTINCT FROM OLD.is_archived THEN
      RAISE EXCEPTION
        'school year state fields (status/is_active/is_archived) are immutable via direct UPDATE; use admin RPCs';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_school_years_guard_state ON public.school_years;
CREATE TRIGGER trg_school_years_guard_state
  BEFORE INSERT OR UPDATE ON public.school_years
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_school_years_guard_state();

-- لا GRANT EXECUTE على دالة المشغّل للعملاء
REVOKE ALL ON FUNCTION public.trg_school_years_guard_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_school_years_guard_state() FROM anon;
REVOKE ALL ON FUNCTION public.trg_school_years_guard_state() FROM authenticated;

-- ------------------------------------------------------------
-- C) قيود الحالات + تواريخ ميلادية
-- ------------------------------------------------------------

ALTER TABLE public.school_years
  DROP CONSTRAINT IF EXISTS school_years_state_check;

ALTER TABLE public.school_years
  DROP CONSTRAINT IF EXISTS school_years_status_check;

ALTER TABLE public.school_years
  DROP CONSTRAINT IF EXISTS school_years_dates_check;

ALTER TABLE public.school_years
  ADD CONSTRAINT school_years_status_check
  CHECK (status IN ('draft', 'active', 'frozen', 'archived'));

ALTER TABLE public.school_years
  ADD CONSTRAINT school_years_state_check
  CHECK (
    (is_active = true  AND is_archived = false AND status = 'active')
    OR (is_active = false AND is_archived = false AND status = 'draft')
    OR (is_active = false AND is_archived = false AND status = 'frozen')
    OR (is_active = false AND is_archived = true  AND status = 'archived')
  );

-- التواريخ الميلادية ISO هي مصدر الحقيقة للحدود الزمنية
ALTER TABLE public.school_years
  ADD CONSTRAINT school_years_dates_check
  CHECK (
    start_date IS NULL
    OR end_date IS NULL
    OR start_date <= end_date
  );

COMMENT ON COLUMN public.school_years.start_date IS
  'تاريخ ميلادي ISO — مصدر الحقيقة لبداية السنة.';
COMMENT ON COLUMN public.school_years.end_date IS
  'تاريخ ميلادي ISO — مصدر الحقيقة لنهاية السنة.';
COMMENT ON COLUMN public.school_years.hijri_year IS
  'عرض فقط (اختياري). ليس مصدر حقيقة للأرشفة أو التفعيل.';
COMMENT ON COLUMN public.school_years.status IS
  'draft|active|frozen|archived — يُغيَّر فقط عبر دوال admin.';

CREATE UNIQUE INDEX IF NOT EXISTS school_years_one_active_idx
  ON public.school_years (is_active)
  WHERE (is_active = true);

-- ------------------------------------------------------------
-- D) دوال admin (JWT حقيقي مطلوب عند الاستدعاء من العميل)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_school_year(
  p_name text,
  p_label_ar text DEFAULT NULL,
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_hijri_year_display text DEFAULT NULL
)
RETURNS public.school_years
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.school_years;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only (requires authenticated Auth JWT session)';
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'name is required';
  END IF;

  IF p_start_date IS NOT NULL
     AND p_end_date IS NOT NULL
     AND p_start_date > p_end_date THEN
    RAISE EXCEPTION 'start_date must be <= end_date (Gregorian ISO source of truth)';
  END IF;

  PERFORM set_config('app.school_year_state_change', 'allowed', true);

  INSERT INTO public.school_years (
    name, label_ar, start_date, end_date, notes, hijri_year,
    is_active, is_archived, status
  ) VALUES (
    btrim(p_name),
    NULLIF(btrim(COALESCE(p_label_ar, '')), ''),
    p_start_date,
    p_end_date,
    p_notes,
    NULLIF(btrim(COALESCE(p_hijri_year_display, '')), ''),
    false,
    false,
    'draft'
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_school_year_meta(
  p_year_id uuid,
  p_name text DEFAULT NULL,
  p_label_ar text DEFAULT NULL,
  p_start_date date DEFAULT NULL,
  p_end_date date DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.school_years
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.school_years;
  v_start date;
  v_end date;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only (requires authenticated Auth JWT session)';
  END IF;

  IF p_year_id IS NULL THEN
    RAISE EXCEPTION 'year id is required';
  END IF;

  SELECT sy.start_date, sy.end_date
  INTO v_start, v_end
  FROM public.school_years AS sy
  WHERE sy.id = p_year_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'school year not found';
  END IF;

  v_start := COALESCE(p_start_date, v_start);
  v_end := COALESCE(p_end_date, v_end);

  IF v_start IS NOT NULL AND v_end IS NOT NULL AND v_start > v_end THEN
    RAISE EXCEPTION 'start_date must be <= end_date (Gregorian ISO source of truth)';
  END IF;

  -- لا يغيّر status/is_active/is_archived — لا حاجة لـ set_config
  UPDATE public.school_years AS sy
  SET
    name = COALESCE(NULLIF(btrim(COALESCE(p_name, '')), ''), sy.name),
    label_ar = CASE
      WHEN p_label_ar IS NULL THEN sy.label_ar
      ELSE NULLIF(btrim(p_label_ar), '')
    END,
    start_date = CASE WHEN p_start_date IS NULL THEN sy.start_date ELSE p_start_date END,
    end_date = CASE WHEN p_end_date IS NULL THEN sy.end_date ELSE p_end_date END,
    notes = CASE WHEN p_notes IS NULL THEN sy.notes ELSE p_notes END,
    updated_at = now()
  WHERE sy.id = p_year_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.freeze_school_year(p_year_id uuid)
RETURNS public.school_years
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.school_years;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only (requires authenticated Auth JWT session)';
  END IF;

  IF p_year_id IS NULL THEN
    RAISE EXCEPTION 'year id is required';
  END IF;

  LOCK TABLE public.school_years IN SHARE ROW EXCLUSIVE MODE;

  PERFORM set_config('app.school_year_state_change', 'allowed', true);

  UPDATE public.school_years AS sy
  SET
    is_active = false,
    is_archived = false,
    status = 'frozen',
    updated_at = now()
  WHERE sy.id = p_year_id
    AND sy.status = 'active'
    AND sy.is_active = true
    AND sy.is_archived = false
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'freeze allowed only from active year';
  END IF;

  RETURN v_row;
END;
$$;

-- إزالة overload (uuid) إن وُجد — بأمان وبدون CASCADE — قبل إنشاء (uuid, boolean)
DROP FUNCTION IF EXISTS public.activate_school_year(uuid);

CREATE OR REPLACE FUNCTION public.activate_school_year(
  p_year_id uuid,
  p_freeze_current boolean DEFAULT false
)
RETURNS public.school_years
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.school_years;
  v_current uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only (requires authenticated Auth JWT session)';
  END IF;

  IF p_year_id IS NULL THEN
    RAISE EXCEPTION 'year id is required';
  END IF;

  -- قفل لمنع تفعيلَين متزامنين
  LOCK TABLE public.school_years IN SHARE ROW EXCLUSIVE MODE;

  IF NOT EXISTS (
    SELECT 1
    FROM public.school_years AS sy
    WHERE sy.id = p_year_id
      AND sy.is_archived = false
      AND sy.status IN ('draft', 'frozen')
  ) THEN
    RAISE EXCEPTION 'activate allowed only for draft or frozen (non-archived) year';
  END IF;

  SELECT sy.id
  INTO v_current
  FROM public.school_years AS sy
  WHERE sy.is_active = true
    AND sy.status = 'active'
    AND sy.id IS DISTINCT FROM p_year_id
  FOR UPDATE;

  IF v_current IS NOT NULL THEN
    IF COALESCE(p_freeze_current, false) IS NOT TRUE THEN
      RAISE EXCEPTION
        'another active school year exists (%). Pass p_freeze_current=true to freeze it explicitly, or freeze it first.',
        v_current;
    END IF;

    PERFORM set_config('app.school_year_state_change', 'allowed', true);

    UPDATE public.school_years AS sy
    SET
      is_active = false,
      is_archived = false,
      status = 'frozen',
      updated_at = now()
    WHERE sy.id = v_current;
  END IF;

  PERFORM set_config('app.school_year_state_change', 'allowed', true);

  UPDATE public.school_years AS sy
  SET
    is_active = true,
    is_archived = false,
    status = 'active',
    updated_at = now()
  WHERE sy.id = p_year_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.archive_school_year(p_year_id uuid)
RETURNS public.school_years
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.school_years;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only (requires authenticated Auth JWT session)';
  END IF;

  IF p_year_id IS NULL THEN
    RAISE EXCEPTION 'year id is required';
  END IF;

  LOCK TABLE public.school_years IN SHARE ROW EXCLUSIVE MODE;

  PERFORM set_config('app.school_year_state_change', 'allowed', true);

  UPDATE public.school_years AS sy
  SET
    is_active = false,
    is_archived = true,
    status = 'archived',
    updated_at = now()
  WHERE sy.id = p_year_id
    AND sy.status = 'frozen'
    AND sy.is_active = false
    AND sy.is_archived = false
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'archive allowed only from frozen year';
  END IF;

  RETURN v_row;
END;
$$;

-- ------------------------------------------------------------
-- D2) REVOKE ALL من anon/PUBLIC لكل الدوال الجديدة، ثم GRANT لـ authenticated
-- ------------------------------------------------------------

REVOKE ALL ON FUNCTION public.school_year_allows_write(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.school_year_allows_write(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.school_year_is_active(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.school_year_is_active(uuid) FROM anon;

REVOKE ALL ON FUNCTION public.create_school_year(text, text, date, date, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_school_year(text, text, date, date, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.update_school_year_meta(uuid, text, text, date, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_school_year_meta(uuid, text, text, date, date, text) FROM anon;
REVOKE ALL ON FUNCTION public.activate_school_year(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_school_year(uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.freeze_school_year(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.freeze_school_year(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.archive_school_year(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.archive_school_year(uuid) FROM anon;

REVOKE ALL ON FUNCTION public.trg_school_years_guard_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_school_years_guard_state() FROM anon;
REVOKE ALL ON FUNCTION public.trg_school_years_guard_state() FROM authenticated;

-- مساعدات + دوال admin: EXECUTE لـ authenticated فقط
GRANT EXECUTE ON FUNCTION public.school_year_allows_write(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.school_year_is_active(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_school_year(text, text, date, date, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_school_year_meta(uuid, text, text, date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.activate_school_year(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.freeze_school_year(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.archive_school_year(uuid) TO authenticated;
-- لا GRANT EXECUTE على trg_school_years_guard_state للعملاء

-- ------------------------------------------------------------
-- E) سياسات school_years — لا sy_update فعّال لتغيير الحالة
-- ------------------------------------------------------------

DROP POLICY IF EXISTS sy_select ON public.school_years;
DROP POLICY IF EXISTS sy_insert ON public.school_years;
DROP POLICY IF EXISTS sy_update ON public.school_years;
DROP POLICY IF EXISTS sy_delete ON public.school_years;
DROP POLICY IF EXISTS sy_write ON public.school_years;
DROP POLICY IF EXISTS app_read ON public.school_years;
DROP POLICY IF EXISTS app_write ON public.school_years;
DROP POLICY IF EXISTS allow_all ON public.school_years;

CREATE POLICY sy_select ON public.school_years
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice', 'teacher'));

-- الإدراج المباشر مرفوض؛ استخدم create_school_year()
CREATE POLICY sy_insert ON public.school_years
  FOR INSERT TO authenticated
  WITH CHECK (false);

-- التحديث المباشر مرفوض؛ meta عبر update_school_year_meta() والحالة عبر دوال admin
CREATE POLICY sy_update ON public.school_years
  FOR UPDATE TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY sy_delete ON public.school_years
  FOR DELETE TO authenticated
  USING (false);

-- ------------------------------------------------------------
-- F) سياسات الكتابة التشغيلية (active فقط عبر school_year_allows_write)
-- ------------------------------------------------------------

DROP POLICY IF EXISTS programs_select ON public.programs;
DROP POLICY IF EXISTS programs_insert ON public.programs;
DROP POLICY IF EXISTS programs_update ON public.programs;
DROP POLICY IF EXISTS programs_delete ON public.programs;

CREATE POLICY programs_select ON public.programs
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice', 'teacher'));

CREATE POLICY programs_insert ON public.programs
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_write(school_year_id)
  );

CREATE POLICY programs_update ON public.programs
  FOR UPDATE TO authenticated
  USING (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_write(school_year_id)
  )
  WITH CHECK (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_write(school_year_id)
  );

CREATE POLICY programs_delete ON public.programs
  FOR DELETE TO authenticated
  USING (
    public.is_admin()
    AND public.school_year_allows_write(school_year_id)
  );

DROP POLICY IF EXISTS indicators_select ON public.program_indicators;
DROP POLICY IF EXISTS indicators_insert ON public.program_indicators;
DROP POLICY IF EXISTS indicators_update ON public.program_indicators;
DROP POLICY IF EXISTS indicators_delete ON public.program_indicators;

CREATE POLICY indicators_select ON public.program_indicators
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice', 'teacher'));

CREATE POLICY indicators_insert ON public.program_indicators
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_app_role() IN ('admin', 'vice')
    AND EXISTS (
      SELECT 1 FROM public.programs AS pr
      WHERE pr.id = program_id
        AND public.school_year_allows_write(pr.school_year_id)
    )
  );

CREATE POLICY indicators_update ON public.program_indicators
  FOR UPDATE TO authenticated
  USING (
    public.current_app_role() IN ('admin', 'vice')
    AND EXISTS (
      SELECT 1 FROM public.programs AS pr
      WHERE pr.id = program_id
        AND public.school_year_allows_write(pr.school_year_id)
    )
  )
  WITH CHECK (
    public.current_app_role() IN ('admin', 'vice')
    AND EXISTS (
      SELECT 1 FROM public.programs AS pr
      WHERE pr.id = program_id
        AND public.school_year_allows_write(pr.school_year_id)
    )
  );

CREATE POLICY indicators_delete ON public.program_indicators
  FOR DELETE TO authenticated
  USING (
    public.is_admin()
    AND EXISTS (
      SELECT 1 FROM public.programs AS pr
      WHERE pr.id = program_id
        AND public.school_year_allows_write(pr.school_year_id)
    )
  );

DROP POLICY IF EXISTS evidences_select ON public.evidences;
DROP POLICY IF EXISTS evidences_insert ON public.evidences;
DROP POLICY IF EXISTS evidences_update ON public.evidences;
DROP POLICY IF EXISTS evidences_delete ON public.evidences;

CREATE POLICY evidences_select ON public.evidences
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice', 'teacher'));

-- المعلمة: إرفاق شاهد في active فقط؛ admin/vice: كتابة تشغيلية في active فقط
CREATE POLICY evidences_insert ON public.evidences
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      public.current_app_role() IN ('admin', 'vice')
      AND public.school_year_allows_write(school_year_id)
      AND created_by = auth.uid()
    )
    OR (
      public.current_app_role() = 'teacher'
      AND public.school_year_is_active(school_year_id)
      AND created_by = auth.uid()
    )
  );

CREATE POLICY evidences_update ON public.evidences
  FOR UPDATE TO authenticated
  USING (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_write(school_year_id)
  )
  WITH CHECK (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_write(school_year_id)
  );

CREATE POLICY evidences_delete ON public.evidences
  FOR DELETE TO authenticated
  USING (
    public.is_admin()
    AND public.school_year_allows_write(school_year_id)
  );

DROP POLICY IF EXISTS initiatives_select ON public.initiatives;
DROP POLICY IF EXISTS initiatives_insert ON public.initiatives;
DROP POLICY IF EXISTS initiatives_update ON public.initiatives;
DROP POLICY IF EXISTS initiatives_delete ON public.initiatives;
DROP POLICY IF EXISTS initiatives_write ON public.initiatives;

CREATE POLICY initiatives_select ON public.initiatives
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY initiatives_insert ON public.initiatives
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_write(school_year_id)
  );

CREATE POLICY initiatives_update ON public.initiatives
  FOR UPDATE TO authenticated
  USING (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_write(school_year_id)
  )
  WITH CHECK (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_write(school_year_id)
  );

CREATE POLICY initiatives_delete ON public.initiatives
  FOR DELETE TO authenticated
  USING (
    public.is_admin()
    AND public.school_year_allows_write(school_year_id)
  );

DROP POLICY IF EXISTS tasks_select ON public.tasks;
DROP POLICY IF EXISTS tasks_insert ON public.tasks;
DROP POLICY IF EXISTS tasks_update ON public.tasks;
DROP POLICY IF EXISTS tasks_delete ON public.tasks;

CREATE POLICY tasks_select ON public.tasks
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY tasks_insert ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_write(school_year_id)
  );

CREATE POLICY tasks_update ON public.tasks
  FOR UPDATE TO authenticated
  USING (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_write(school_year_id)
  )
  WITH CHECK (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_write(school_year_id)
  );

CREATE POLICY tasks_delete ON public.tasks
  FOR DELETE TO authenticated
  USING (
    public.is_admin()
    AND public.school_year_allows_write(school_year_id)
  );

DROP POLICY IF EXISTS tf_select ON public.teacher_followups;
DROP POLICY IF EXISTS tf_insert ON public.teacher_followups;
DROP POLICY IF EXISTS tf_update ON public.teacher_followups;
DROP POLICY IF EXISTS tf_delete ON public.teacher_followups;

CREATE POLICY tf_select ON public.teacher_followups
  FOR SELECT TO authenticated
  USING (public.current_app_role() IN ('admin', 'vice'));

CREATE POLICY tf_insert ON public.teacher_followups
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_write(school_year_id)
  );

CREATE POLICY tf_update ON public.teacher_followups
  FOR UPDATE TO authenticated
  USING (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_write(school_year_id)
  )
  WITH CHECK (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_write(school_year_id)
  );

CREATE POLICY tf_delete ON public.teacher_followups
  FOR DELETE TO authenticated
  USING (
    public.current_app_role() IN ('admin', 'vice')
    AND public.school_year_allows_write(school_year_id)
  );

-- ------------------------------------------------------------
-- G) REVOKE anon/PUBLIC + GRANT authenticated (لا يمس Storage)
-- ------------------------------------------------------------

REVOKE ALL ON TABLE public.school_years FROM anon;
REVOKE ALL ON TABLE public.school_years FROM PUBLIC;
REVOKE ALL ON TABLE public.programs FROM anon;
REVOKE ALL ON TABLE public.programs FROM PUBLIC;
REVOKE ALL ON TABLE public.program_indicators FROM anon;
REVOKE ALL ON TABLE public.program_indicators FROM PUBLIC;
REVOKE ALL ON TABLE public.evidences FROM anon;
REVOKE ALL ON TABLE public.evidences FROM PUBLIC;
REVOKE ALL ON TABLE public.initiatives FROM anon;
REVOKE ALL ON TABLE public.initiatives FROM PUBLIC;
REVOKE ALL ON TABLE public.tasks FROM anon;
REVOKE ALL ON TABLE public.tasks FROM PUBLIC;
REVOKE ALL ON TABLE public.teacher_followups FROM anon;
REVOKE ALL ON TABLE public.teacher_followups FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.school_years TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.programs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.program_indicators TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.evidences TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.initiatives TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.teacher_followups TO authenticated;

-- ------------------------------------------------------------
-- H) تحقق داخل المعاملة
-- ------------------------------------------------------------

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND rel.relname = 'school_years'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%frozen%'
  ) THEN 1 ELSE 0
END AS tx_check_frozen;

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND rel.relname = 'school_years'
      AND con.conname = 'school_years_dates_check'
  ) THEN 1 ELSE 0
END AS tx_check_dates;

SELECT 1 / CASE
  WHEN (
    SELECT COUNT(*)::int FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'create_school_year', 'update_school_year_meta',
        'activate_school_year', 'freeze_school_year', 'archive_school_year',
        'school_year_allows_write', 'school_year_is_active'
      )
      AND p.prosecdef = true
      AND EXISTS (
        SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg(x)
        WHERE cfg.x LIKE 'search_path=%'
      )
  ) = 7 THEN 1 ELSE 0
END AS tx_check_secure_functions;

SELECT 1 / CASE
  WHEN pg_get_functiondef('public.school_year_allows_write(uuid)'::regprocedure)
       ILIKE '%status%''active''%'
    OR pg_get_functiondef('public.school_year_allows_write(uuid)'::regprocedure)
       ILIKE '%status = ''active''%'
  THEN 1 ELSE 0
END AS tx_check_write_active_only;

SELECT 1 / CASE
  WHEN (
    SELECT COUNT(*)::int FROM public.school_years
    WHERE is_active AND status = 'active' AND NOT is_archived
  ) = 1 THEN 1 ELSE 0
END AS tx_check_one_active;

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'school_years'
      AND policyname = 'sy_update'
      AND COALESCE(qual, '') IN ('false', '(false)')
  ) THEN 1 ELSE 0
END AS tx_check_sy_update_denied;

SELECT 1 / CASE
  WHEN EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN (
        'school_years', 'programs', 'program_indicators', 'evidences',
        'initiatives', 'tasks', 'teacher_followups'
      )
      AND grantee IN ('anon', 'PUBLIC')
  ) THEN 0 ELSE 1
END AS tx_check_no_anon_grants;

COMMIT;

-- عند الفشل: ROLLBACK; صراحة ثم أعد PRECHECK


-- ############################################################################
-- POSTCHECK — تعريفات وصلاحيات (ليس أسماء فقط)
-- ############################################################################

-- PC1) لا EXECUTE مباشر لـ anon/PUBLIC؛ authenticated فقط على الدوال المطلوبة
--     (trg بدون EXECUTE لأي دور عميل)
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  r.rolname AS grantee,
  has_function_privilege(r.oid, p.oid, 'EXECUTE') AS can_execute,
  CASE
    WHEN r.rolname IN ('anon', 'PUBLIC')
         AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
      THEN 'FAIL: anon/PUBLIC must not EXECUTE'
    WHEN p.proname = 'trg_school_years_guard_state'
         AND r.rolname = 'authenticated'
         AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
      THEN 'FAIL: trigger fn must not be granted to authenticated'
    WHEN p.proname <> 'trg_school_years_guard_state'
         AND r.rolname = 'authenticated'
         AND NOT has_function_privilege(r.oid, p.oid, 'EXECUTE')
      THEN 'FAIL: authenticated missing EXECUTE'
    ELSE 'ok'
  END AS grant_check
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN pg_roles r
WHERE n.nspname = 'public'
  AND p.proname IN (
    'create_school_year', 'update_school_year_meta',
    'activate_school_year', 'freeze_school_year', 'archive_school_year',
    'school_year_allows_write', 'school_year_is_active',
    'trg_school_years_guard_state'
  )
  AND r.rolname IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY p.proname, r.rolname;

-- PC2) لا بصمة activate_school_year(uuid) متبقية
SELECT
  'FAIL: leftover activate_school_year(uuid)'::text AS check_result,
  pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'activate_school_year'
  AND pg_get_function_identity_arguments(p.oid) = 'uuid';
-- المتوقع: 0 صفوف

-- PC3) لا سياسات anon/public أو USING/WITH CHECK true على الجداول المستهدفة
--     (استثناء users_deny_all فقط إن ظهر في اللقطة)
SELECT
  'FAIL: unsafe policy'::text AS check_result,
  tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'school_years', 'programs', 'program_indicators', 'evidences',
    'initiatives', 'tasks', 'teacher_followups', 'settings'
  )
  AND (
    roles::text ILIKE '%anon%'
    OR roles::text ILIKE '%public%'
    OR COALESCE(qual, '') IN ('true', '(true)')
    OR COALESCE(with_check, '') IN ('true', '(true)')
  );
-- المتوقع: 0 صفوف

-- PC4) سياسات الكتابة تشير لحارس السنة؛ SELECT بلا حارس كتابة
SELECT tablename, policyname, cmd, qual, with_check,
  CASE
    WHEN cmd = 'SELECT' THEN 'ok-select-read-allowed'
    WHEN tablename = 'school_years' THEN 'ok-sy-client-locked'
    WHEN COALESCE(qual, '') ILIKE '%school_year_allows_write%'
      OR COALESCE(with_check, '') ILIKE '%school_year_allows_write%'
      OR COALESCE(with_check, '') ILIKE '%school_year_is_active%'
    THEN 'ok-year-guard-write'
    ELSE 'FAIL: MISSING_YEAR_GUARD'
  END AS definition_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'school_years', 'programs', 'program_indicators', 'evidences',
    'initiatives', 'tasks', 'teacher_followups'
  )
ORDER BY tablename, cmd, policyname;

-- PC5) frozen/archived للقراءة فقط عبر الحارس (allows_write = active فقط)
SELECT
  CASE
    WHEN pg_get_functiondef('public.school_year_allows_write(uuid)'::regprocedure)
         ~* 'status\s*=\s*''active'''
     AND pg_get_functiondef('public.school_year_allows_write(uuid)'::regprocedure)
         ~* 'is_active\s*=\s*true'
     AND pg_get_functiondef('public.school_year_allows_write(uuid)'::regprocedure)
         !~* 'status\s+IN\s*\('
    THEN 'ok: write guard active-only (frozen/archived read-only via RLS writes denied)'
    ELSE 'FAIL: school_year_allows_write not active-only'
  END AS frozen_archived_read_only_check;

-- PC6) teacher: SELECT evidences + INSERT عبر school_year_is_active؛ لا UPDATE/DELETE للمعلمة
SELECT
  policyname,
  cmd,
  roles,
  with_check,
  qual,
  CASE
    WHEN policyname = 'evidences_select'
         AND cmd = 'SELECT'
         AND COALESCE(qual, '') ILIKE '%teacher%'
      THEN 'ok-teacher-select'
    WHEN policyname = 'evidences_insert'
         AND cmd = 'INSERT'
         AND COALESCE(with_check, '') ILIKE '%teacher%'
         AND COALESCE(with_check, '') ILIKE '%school_year_is_active%'
      THEN 'ok-teacher-insert-active-only'
    WHEN policyname = 'evidences_update'
         AND COALESCE(qual, '') NOT ILIKE '%teacher%'
         AND COALESCE(with_check, '') NOT ILIKE '%teacher%'
      THEN 'ok-teacher-no-update'
    WHEN policyname = 'evidences_delete'
         AND COALESCE(qual, '') NOT ILIKE '%teacher%'
      THEN 'ok-teacher-no-delete'
    ELSE 'FAIL: teacher evidence policy unexpected'
  END AS teacher_evidence_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'evidences'
  AND policyname LIKE 'evidences_%'
ORDER BY cmd, policyname;

-- PC7) سنة active واحدة فقط
SELECT
  COUNT(*) FILTER (
    WHERE is_active = true AND status = 'active' AND is_archived = false
  ) AS active_count,
  CASE
    WHEN COUNT(*) FILTER (
      WHERE is_active = true AND status = 'active' AND is_archived = false
    ) = 1 THEN 'ok-one-active'
    ELSE 'FAIL: expected exactly one active year'
  END AS active_year_check
FROM public.school_years;

-- PC8) فهرس UNIQUE partial فعلي
SELECT
  i.relname,
  ix.indisunique,
  pg_get_expr(ix.indpred, ix.indrelid) AS pred,
  pg_get_indexdef(i.oid) AS index_def,
  CASE
    WHEN ix.indisunique
     AND ix.indpred IS NOT NULL
     AND pg_get_expr(ix.indpred, ix.indrelid) ~* 'is_active'
     AND pg_get_expr(ix.indpred, ix.indrelid) ~* 'true'
    THEN 'ok-unique-partial-active'
    ELSE 'FAIL: index definition'
  END AS index_check
FROM pg_class t
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_index ix ON ix.indrelid = t.oid
JOIN pg_class i ON i.oid = ix.indexrelid
WHERE n.nspname = 'public'
  AND t.relname = 'school_years'
  AND i.relname = 'school_years_one_active_idx';

-- PC9) دوال: SECURITY DEFINER + search_path
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef,
  p.proconfig,
  CASE
    WHEN p.prosecdef
     AND EXISTS (
       SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg(x)
       WHERE cfg.x LIKE 'search_path=%'
     )
    THEN 'ok-secure'
    ELSE 'FAIL: INSECURE_OR_MISSING_SEARCH_PATH'
  END AS security_check
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'create_school_year', 'update_school_year_meta',
    'activate_school_year', 'freeze_school_year', 'archive_school_year',
    'school_year_allows_write', 'school_year_is_active',
    'trg_school_years_guard_state'
  )
ORDER BY p.proname;

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.school_years'::regclass
  AND contype = 'c'
ORDER BY conname;

SELECT id, name, status, is_active, is_archived, start_date, end_date
FROM public.school_years
ORDER BY created_at;

-- اختبارات يدوية بعد الموافقة — من الواجهة بجلسة Auth (JWT) فقط:
--   admin: create_school_year / update_school_year_meta
--   admin: activate_school_year(id) مع سنة نشطة أخرى → يجب أن يفشل
--   admin: activate_school_year(id, true) → يجمّد الحالي ثم يفعّل
--   teacher على active: INSERT evidence → نجاح
--   teacher على frozen: INSERT evidence → فشل
-- Storage للسنوات المؤرشفة: مرحلة مستقلة — غير مغطاة هنا


-- ============================================================
-- نهاية v2 — التراجع: academic_year_archive_foundation_rollback_review.sql
-- ============================================================
