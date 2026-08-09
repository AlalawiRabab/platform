-- ============================================================
-- academic_year_live_precheck_review.sql
-- مرحلة 1 — فحص حي للقراءة فقط (Live Precheck)
-- الفرع: feature/academic-year-archive-hijri-calendar
-- ============================================================
-- الغرض:
--   تشخيص حالة school_years وربط school_year_id وRLS والدوال
--   قبل أي مخطط أرشفة / frozen — دون تعديل قاعدة البيانات.
--
-- قواعد صارمة:
--   SELECT / قراءة من information_schema وpg_catalog وpg_policies وpublic فقط.
--   ممنوع: INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/GRANT/REVOKE/TRUNCATE
--           وDO blocks وأي دالة تغيّر البيانات.
--
-- الخصوصية:
--   لا تُعرض أسماء مستخدمين أو بريد أو كلمات مرور أو بيانات شخصية.
--   أعداد + معرّفات السنوات + بيانات وصفية للسنوات فقط.
--
-- التنفيذ:
--   مراجعة يدوية ثم تشغيل اختياري في SQL Editor — هذا الملف لا يُنفَّذ تلقائياً.
--   إذا فشل استعلام على جدول/عمود تشغيلي: غالباً العنصر غير موجود (سجّل ذلك).
-- ============================================================


-- ############################################################################
-- أولاً: school_years — البنية
-- النتيجة المطلوبة: قائمة أعمدة/أنواع/nullable/default إن وُجد الجدول.
-- ############################################################################

-- 1.1 هل جدول school_years موجود؟
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  c.relkind AS relkind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'school_years'
  AND c.relkind = 'r';
-- متوقع: صف واحد إن كان الجدول موجوداً؛ صفر صفوف إن لم يُنشأ بعد.

-- 1.2 أعمدة school_years (أنواع + nullable + default)
SELECT
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default,
  c.character_maximum_length
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name = 'school_years'
ORDER BY c.ordinal_position;
-- متوقع: id, name, label_ar, start_date, end_date, status, is_active, is_archived, ...

-- 1.3 قيود school_years
SELECT
  tc.constraint_type,
  tc.constraint_name,
  kcu.column_name,
  cc.check_clause
FROM information_schema.table_constraints tc
LEFT JOIN information_schema.key_column_usage kcu
  ON tc.constraint_schema = kcu.constraint_schema
 AND tc.constraint_name = kcu.constraint_name
LEFT JOIN information_schema.check_constraints cc
  ON tc.constraint_schema = cc.constraint_schema
 AND tc.constraint_name = cc.constraint_name
WHERE tc.table_schema = 'public'
  AND tc.table_name = 'school_years'
ORDER BY tc.constraint_type, tc.constraint_name, kcu.ordinal_position;
-- متوقع: PRIMARY KEY / UNIQUE / CHECK لحالات السنة.

-- 1.4 فهارس school_years
SELECT
  i.relname AS index_name,
  ix.indisunique AS is_unique,
  ix.indisprimary AS is_primary,
  pg_get_indexdef(ix.indexrelid) AS index_def
FROM pg_index ix
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname = 'school_years'
ORDER BY i.relname;
-- متوقع: فهرس فريد جزئي لسنة نشطة واحدة إن وُجد.


-- ############################################################################
-- أولاً (تابع): school_years — القيم الحالية (قراءة آمنة عبر to_jsonb)
-- النتيجة المطلوبة: صفوف السنوات + أعداد حسب الحالة + كشف تعدد النشط.
-- الأعمدة الاختيارية تُقرأ بـ to_jsonb(sy)->>'…' حتى لا يفشل الاستعلام إن غابت.
-- ############################################################################

-- 1.5 صفوف السنوات (أعمدة آمنة؛ الاختيارية عبر jsonb)
SELECT
  sy.id,
  to_jsonb(sy)->>'name' AS name,
  to_jsonb(sy)->>'label_ar' AS label_ar,
  to_jsonb(sy)->>'status' AS status,
  to_jsonb(sy)->>'is_active' AS is_active,
  to_jsonb(sy)->>'is_archived' AS is_archived,
  to_jsonb(sy)->>'start_date' AS start_date,
  to_jsonb(sy)->>'end_date' AS end_date
FROM public.school_years sy
ORDER BY to_jsonb(sy)->>'name' NULLS LAST, sy.id;
-- متوقع: قائمة السنوات؛ الحقول الغائبة تظهر NULL دون فشل الاستعلام.

-- 1.6 عدد السنوات حسب status (آمن إن غاب العمود)
SELECT
  to_jsonb(sy)->>'status' AS status,
  COUNT(*) AS year_count
FROM public.school_years sy
GROUP BY to_jsonb(sy)->>'status'
ORDER BY 1 NULLS LAST;
-- متوقع: توزيع الحالات؛ إن غاب status تكون كل الصفوف تحت NULL.

-- 1.7 عدد حسب is_active / is_archived (آمن عبر jsonb)
SELECT
  to_jsonb(sy)->>'is_active' AS is_active,
  to_jsonb(sy)->>'is_archived' AS is_archived,
  COUNT(*) AS year_count
FROM public.school_years sy
GROUP BY to_jsonb(sy)->>'is_active', to_jsonb(sy)->>'is_archived'
ORDER BY 1 DESC NULLS LAST, 2 NULLS LAST;
-- متوقع: صف واحد على الأكثر بقيمة is_active = 'true' إن وُجد العمود.

-- 1.8 هل توجد أكثر من سنة نشطة؟ (مقارنة نصية/jsonb بلا مرجع عمود مباشر اختياري)
SELECT
  COUNT(*) FILTER (WHERE to_jsonb(sy)->>'is_active' = 'true') AS active_flag_count,
  COUNT(*) FILTER (WHERE to_jsonb(sy)->>'status' = 'active') AS status_active_count,
  (COUNT(*) FILTER (WHERE to_jsonb(sy)->>'is_active' = 'true') > 1) AS has_multiple_active_flags,
  (COUNT(*) FILTER (WHERE to_jsonb(sy)->>'status' = 'active') > 1) AS has_multiple_status_active
FROM public.school_years sy;
-- متوقع التشخيص: has_multiple_* = false في الحالة السليمة.


-- ############################################################################
-- ثانياً: ربط الجداول بالسنة — وجود school_year_id / النوع / nullable / FK
-- النتيجة المطلوبة: صف لكل جدول مستهدف يوضح إن وُجد العمود وخصائصه وFK.
-- ############################################################################

-- 2.1 وصف عمود school_year_id في الجداول المستهدفة
SELECT
  t.table_name,
  CASE WHEN c.column_name IS NULL THEN false ELSE true END AS has_school_year_id,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default
FROM (
  VALUES
    ('programs'),
    ('initiatives'),
    ('tasks'),
    ('evidences'),
    ('teacher_followups'),
    ('program_indicators')
) AS t(table_name)
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public'
 AND c.table_name = t.table_name
 AND c.column_name = 'school_year_id'
ORDER BY t.table_name;
-- متوقع: وجود العمود على الجداول التشغيلية؛ غالباً غائب عن program_indicators (يرث من البرنامج).

-- 2.2 مفاتيح أجنبية تشير من school_year_id إلى school_years
SELECT
  tc.table_name,
  tc.constraint_name,
  kcu.column_name,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name,
  rc.update_rule,
  rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_schema = kcu.constraint_schema
 AND tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_schema = tc.constraint_schema
 AND ccu.constraint_name = tc.constraint_name
JOIN information_schema.referential_constraints rc
  ON rc.constraint_schema = tc.constraint_schema
 AND rc.constraint_name = tc.constraint_name
WHERE tc.table_schema = 'public'
  AND tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name IN (
    'programs', 'initiatives', 'tasks', 'evidences',
    'teacher_followups', 'program_indicators'
  )
  AND kcu.column_name = 'school_year_id'
ORDER BY tc.table_name, tc.constraint_name;
-- متوقع: FK إلى school_years(id) إن فُرضت القيود؛ صفر صفوف إن لم تُضف بعد.


-- ############################################################################
-- ثالثاً: سلامة البيانات — أعداد فقط (قراءة school_year_id عبر to_jsonb)
-- إن غاب العمود: school_year_id_status = COLUMN_MISSING وnull/orphan = NULL
-- (لا تُحسب كل الصفوف كـ NULL بالخطأ). teacher_followups غالباً بلا العمود حالياً.
-- ############################################################################

-- 3.1 programs — إجمالي / حالة العمود / NULL / orphan / توزيع
SELECT
  'programs'::text AS table_name,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'programs'
        AND c.column_name = 'school_year_id'
    ) THEN 'PRESENT'
    ELSE 'COLUMN_MISSING'
  END AS school_year_id_status,
  COUNT(*) AS total_rows,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'programs'
        AND c.column_name = 'school_year_id'
    ) THEN COUNT(*) FILTER (WHERE to_jsonb(p)->>'school_year_id' IS NULL)
    ELSE NULL
  END AS null_year_rows,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'programs'
        AND c.column_name = 'school_year_id'
    ) THEN COUNT(*) FILTER (
      WHERE to_jsonb(p)->>'school_year_id' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.school_years sy
          WHERE sy.id::text = to_jsonb(p)->>'school_year_id'
        )
    )
    ELSE NULL
  END AS orphan_year_rows
FROM public.programs p;
-- متوقع: PRESENT مع null/orphan = 0 بعد ترحيل سليم.

SELECT
  CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'programs'
        AND c.column_name = 'school_year_id'
    ) THEN 'COLUMN_MISSING'
    ELSE to_jsonb(p)->>'school_year_id'
  END AS school_year_id,
  COUNT(*) AS row_count
FROM public.programs p
GROUP BY 1
ORDER BY row_count DESC, school_year_id NULLS LAST;
-- متوقع: توزيع حسب معرّف السنة؛ أو صف واحد COLUMN_MISSING.

-- 3.2 initiatives
SELECT
  'initiatives'::text AS table_name,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'initiatives'
        AND c.column_name = 'school_year_id'
    ) THEN 'PRESENT'
    ELSE 'COLUMN_MISSING'
  END AS school_year_id_status,
  COUNT(*) AS total_rows,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'initiatives'
        AND c.column_name = 'school_year_id'
    ) THEN COUNT(*) FILTER (WHERE to_jsonb(i)->>'school_year_id' IS NULL)
    ELSE NULL
  END AS null_year_rows,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'initiatives'
        AND c.column_name = 'school_year_id'
    ) THEN COUNT(*) FILTER (
      WHERE to_jsonb(i)->>'school_year_id' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.school_years sy
          WHERE sy.id::text = to_jsonb(i)->>'school_year_id'
        )
    )
    ELSE NULL
  END AS orphan_year_rows
FROM public.initiatives i;

SELECT
  CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'initiatives'
        AND c.column_name = 'school_year_id'
    ) THEN 'COLUMN_MISSING'
    ELSE to_jsonb(i)->>'school_year_id'
  END AS school_year_id,
  COUNT(*) AS row_count
FROM public.initiatives i
GROUP BY 1
ORDER BY row_count DESC, school_year_id NULLS LAST;

-- 3.3 tasks
SELECT
  'tasks'::text AS table_name,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'tasks'
        AND c.column_name = 'school_year_id'
    ) THEN 'PRESENT'
    ELSE 'COLUMN_MISSING'
  END AS school_year_id_status,
  COUNT(*) AS total_rows,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'tasks'
        AND c.column_name = 'school_year_id'
    ) THEN COUNT(*) FILTER (WHERE to_jsonb(t)->>'school_year_id' IS NULL)
    ELSE NULL
  END AS null_year_rows,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'tasks'
        AND c.column_name = 'school_year_id'
    ) THEN COUNT(*) FILTER (
      WHERE to_jsonb(t)->>'school_year_id' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.school_years sy
          WHERE sy.id::text = to_jsonb(t)->>'school_year_id'
        )
    )
    ELSE NULL
  END AS orphan_year_rows
FROM public.tasks t;

SELECT
  CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'tasks'
        AND c.column_name = 'school_year_id'
    ) THEN 'COLUMN_MISSING'
    ELSE to_jsonb(t)->>'school_year_id'
  END AS school_year_id,
  COUNT(*) AS row_count
FROM public.tasks t
GROUP BY 1
ORDER BY row_count DESC, school_year_id NULLS LAST;

-- 3.4 evidences
SELECT
  'evidences'::text AS table_name,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'evidences'
        AND c.column_name = 'school_year_id'
    ) THEN 'PRESENT'
    ELSE 'COLUMN_MISSING'
  END AS school_year_id_status,
  COUNT(*) AS total_rows,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'evidences'
        AND c.column_name = 'school_year_id'
    ) THEN COUNT(*) FILTER (WHERE to_jsonb(e)->>'school_year_id' IS NULL)
    ELSE NULL
  END AS null_year_rows,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'evidences'
        AND c.column_name = 'school_year_id'
    ) THEN COUNT(*) FILTER (
      WHERE to_jsonb(e)->>'school_year_id' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.school_years sy
          WHERE sy.id::text = to_jsonb(e)->>'school_year_id'
        )
    )
    ELSE NULL
  END AS orphan_year_rows
FROM public.evidences e;

SELECT
  CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'evidences'
        AND c.column_name = 'school_year_id'
    ) THEN 'COLUMN_MISSING'
    ELSE to_jsonb(e)->>'school_year_id'
  END AS school_year_id,
  COUNT(*) AS row_count
FROM public.evidences e
GROUP BY 1
ORDER BY row_count DESC, school_year_id NULLS LAST;

-- 3.5 teacher_followups (غالباً COLUMN_MISSING حالياً — يجب ألا يوقف الملف)
SELECT
  'teacher_followups'::text AS table_name,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'teacher_followups'
        AND c.column_name = 'school_year_id'
    ) THEN 'PRESENT'
    ELSE 'COLUMN_MISSING'
  END AS school_year_id_status,
  COUNT(*) AS total_rows,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'teacher_followups'
        AND c.column_name = 'school_year_id'
    ) THEN COUNT(*) FILTER (WHERE to_jsonb(tf)->>'school_year_id' IS NULL)
    ELSE NULL
  END AS null_year_rows,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'teacher_followups'
        AND c.column_name = 'school_year_id'
    ) THEN COUNT(*) FILTER (
      WHERE to_jsonb(tf)->>'school_year_id' IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.school_years sy
          WHERE sy.id::text = to_jsonb(tf)->>'school_year_id'
        )
    )
    ELSE NULL
  END AS orphan_year_rows
FROM public.teacher_followups tf;
-- متوقع حالياً: school_year_id_status = COLUMN_MISSING دون خطأ.

SELECT
  CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'teacher_followups'
        AND c.column_name = 'school_year_id'
    ) THEN 'COLUMN_MISSING'
    ELSE to_jsonb(tf)->>'school_year_id'
  END AS school_year_id,
  COUNT(*) AS row_count
FROM public.teacher_followups tf
GROUP BY 1
ORDER BY row_count DESC, school_year_id NULLS LAST;

-- 3.6 program_indicators — إجمالي فقط + حالة العمود من information_schema (غالباً غائب بالتصميم)
SELECT
  'program_indicators'::text AS table_name,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'program_indicators'
        AND c.column_name = 'school_year_id'
    ) THEN 'PRESENT'
    ELSE 'COLUMN_MISSING'
  END AS school_year_id_status,
  COUNT(*) AS total_rows
FROM public.program_indicators;
-- متوقع: COLUMN_MISSING مع إجمالي مؤشرات (وراثة السنة من programs).


-- ############################################################################
-- رابعاً: RLS والصلاحيات والدوال
-- ############################################################################

-- 4.1 حالة RLS للجداول ذات الصلة
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    'school_years', 'programs', 'program_indicators', 'initiatives',
    'tasks', 'evidences', 'teacher_followups', 'settings', 'profiles', 'users'
  )
ORDER BY c.relname;
-- متوقع: rls_enabled = true للجداول التشغيلية بعد cutover.

-- 4.2 سياسات RLS الحالية (تعريفات فقط — بلا بيانات صفوف)
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'school_years', 'programs', 'program_indicators', 'initiatives',
    'tasks', 'evidences', 'teacher_followups', 'settings', 'profiles', 'users'
  )
ORDER BY tablename, cmd, policyname;
-- متوقع: سياسات sy_* / role-aware؛ راقب أي USING (true) مفتوح.

-- 4.3 صلاحيات الجداول لـ anon و authenticated (أسماء صلاحيات فقط)
SELECT
  table_schema,
  table_name,
  grantee,
  privilege_type,
  is_grantable
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN (
    'school_years', 'programs', 'program_indicators', 'initiatives',
    'tasks', 'evidences', 'teacher_followups', 'settings', 'profiles', 'users'
  )
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY table_name, grantee, privilege_type;
-- متوقع بعد Auth: تقليل صلاحيات anon؛ authenticated حسب RLS.

-- 4.4 الدوال المتعلقة بالسنة/الأدوار — metadata فقط (بدون أسرار)
SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef AS security_definer,
  COALESCE(
    (
      SELECT cfg
      FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg
      WHERE cfg LIKE 'search_path=%'
      LIMIT 1
    ),
    '(not set in proconfig)'
  ) AS search_path_setting
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'get_active_school_year',
    'list_school_years',
    'current_app_role',
    'is_admin',
    'is_staff'
  )
ORDER BY p.proname;
-- متوقع: security_definer وsearch_path مضبوطان للدوال المساعدة إن وُجدت.

-- 4.5 صلاحيات EXECUTE على هذه الدوال (أسماء grantee فقط)
SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS args,
  r.rolname AS grantee,
  has_function_privilege(r.oid, p.oid, 'EXECUTE') AS can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN pg_roles r
WHERE n.nspname = 'public'
  AND p.proname IN (
    'get_active_school_year',
    'list_school_years',
    'current_app_role',
    'is_admin',
    'is_staff'
  )
  AND r.rolname IN ('anon', 'authenticated', 'service_role')
ORDER BY p.proname, r.rolname;
-- متوقع التشخيص: راقب EXECUTE لـ anon على دوال السنة.


-- ############################################################################
-- خامساً: ازدواج المصدر — settings.academic_year مقابل السنة النشطة
-- ############################################################################

-- 5.1 هل عمود settings.academic_year موجود؟
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'settings'
  AND column_name = 'academic_year';
-- متوقع: صف واحد إن وُجد العمود.

-- 5.2 قيمة academic_year فقط عبر to_jsonb (لا مرجع عمود مباشر؛ لا ORDER BY على اختياري مباشر)
SELECT
  to_jsonb(s)->>'academic_year' AS academic_year
FROM public.settings s
ORDER BY to_jsonb(s)->>'id' NULLS LAST
LIMIT 5;
-- متوقع: نص العام أو NULL إن غاب العمود — دون فشل الاستعلام.

-- 5.3 مقارنة نص الإعداد مع السنة النشطة (قراءة آمنة بالكامل عبر jsonb)
SELECT
  to_jsonb(s)->>'academic_year' AS settings_academic_year,
  sy.id AS active_year_id,
  to_jsonb(sy)->>'name' AS active_year_name,
  to_jsonb(sy)->>'label_ar' AS active_year_label_ar,
  to_jsonb(sy)->>'status' AS active_year_status,
  to_jsonb(sy)->>'is_active' AS is_active,
  (
    to_jsonb(s)->>'academic_year' IS NOT DISTINCT FROM to_jsonb(sy)->>'name'
    OR to_jsonb(s)->>'academic_year' IS NOT DISTINCT FROM to_jsonb(sy)->>'label_ar'
  ) AS text_matches_active_year
FROM public.settings s
LEFT JOIN public.school_years sy
  ON to_jsonb(sy)->>'is_active' = 'true'
ORDER BY to_jsonb(s)->>'id' NULLS LAST
LIMIT 5;
-- متوقع التشخيص: text_matches_active_year يوضح الاتساق أو الازدواج دون أي UPDATE.


-- ############################################################################
-- سادساً: ملخص تشخيص للقراءة (تجميعي)
-- ############################################################################

-- 6.1 ملخص وجود الجداول المستهدفة
SELECT
  t.table_name,
  EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname = t.table_name
  ) AS table_exists
FROM (
  VALUES
    ('school_years'),
    ('programs'),
    ('initiatives'),
    ('tasks'),
    ('evidences'),
    ('teacher_followups'),
    ('program_indicators'),
    ('settings'),
    ('profiles')
) AS t(table_name)
ORDER BY t.table_name;
-- متوقع: true للجداول المستخدمة حالياً.

-- 6.2 تذكير المراجعة (تعليق فقط — لا إصلاح هنا)
-- بعد تشغيل هذا الملف يدوياً، سجّل:
--   [ ] عدد السنوات النشطة <= 1
--   [ ] null_year_rows لكل جدول تشغيلي
--   [ ] orphan_year_rows = 0
--   [ ] teacher_followups → COLUMN_MISSING حالياً دون إيقاف الملف
--   [ ] program_indicators بلا school_year_id (أو موثّق إن وُجد)
--   [ ] لا سياسات USING (true) مفتوحة على school_years بعد Auth
--   [ ] صلاحيات anon على get_active_school_year
--   [ ] تطابق/عدم تطابق settings.academic_year مع السنة النشطة
-- لا تُدرج أي أوامر إصلاح في هذا الملف.

-- ============================================================
-- نهاية الملف — قراءة فقط
-- ============================================================
