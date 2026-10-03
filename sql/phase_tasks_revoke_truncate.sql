-- ============================================================
-- phase_tasks_revoke_truncate.sql   (قسم المهام فقط — صلاحية TRUNCATE)
-- TRUNCATE يتجاوز RLS والمشغّلات الصفّية، وكان ممنوحًا لـ authenticated مباشرة على public.tasks
-- (relacl: authenticated=arwdDxtm). الواجهة لا تستخدمه، فيُسحب من أدوار المستخدمين فقط.
-- لا يمس: SELECT/INSERT/UPDATE/DELETE، سياسات RLS، المشغّلات، البيانات، service_role، مالك الجدول،
--   أو أي جدول آخر أو الصلاحيات الافتراضية للمخطط.
-- ============================================================

BEGIN;

REVOKE TRUNCATE ON TABLE public.tasks FROM authenticated, anon, PUBLIC;

DO $check$
BEGIN
  IF has_table_privilege('authenticated', 'public.tasks', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.tasks', 'TRUNCATE')
     OR has_table_privilege('public', 'public.tasks', 'TRUNCATE') THEN
    RAISE EXCEPTION 'STOP: TRUNCATE ما زال متاحًا لدور مستخدم على tasks (منحة موروثة؟)';
  END IF;
  IF NOT (has_table_privilege('authenticated', 'public.tasks', 'SELECT')
      AND has_table_privilege('authenticated', 'public.tasks', 'INSERT')
      AND has_table_privilege('authenticated', 'public.tasks', 'UPDATE')
      AND has_table_privilege('authenticated', 'public.tasks', 'DELETE')) THEN
    RAISE EXCEPTION 'STOP: تغيّرت صلاحيات authenticated الأخرى على tasks';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.tasks', 'TRUNCATE') THEN
    RAISE EXCEPTION 'STOP: تغيّرت صلاحية service_role';
  END IF;
END
$check$;

COMMIT;

-- POSTCHECK (قراءة فقط)
SELECT relacl::text AS tasks_acl,
       has_table_privilege('authenticated', 'public.tasks', 'TRUNCATE') AS authenticated_truncate,
       has_table_privilege('anon', 'public.tasks', 'TRUNCATE')          AS anon_truncate,
       has_table_privilege('public', 'public.tasks', 'TRUNCATE')        AS public_truncate
FROM pg_class WHERE oid = 'public.tasks'::regclass;
-- المتوقع: authenticated=arwdxtm (بلا D)، والقيم الثلاث false

-- ROLLBACK (يدوي — معلّق): يعيد الوضع السابق حرفيًا
/*
GRANT TRUNCATE ON TABLE public.tasks TO authenticated;
*/
