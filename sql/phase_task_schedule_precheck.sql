-- ============================================================
-- phase_task_schedule_precheck.sql   (قراءة فقط — قبل الخطوة 1)
-- جاهزية قسم المهام لإضافة أوقات البداية/النهاية ورابط Drive.
-- لا يكتب ولا ينشئ أي كائن. الناتج أعداد فقط، بلا أسماء أو بريد أو روابط.
-- SQL Editor ← Run ← انسخ عمود report.
-- ============================================================
SELECT jsonb_pretty(jsonb_build_object(
  'tasks_total',               (SELECT count(*) FROM public.tasks),
  'tasks_active_year',         (SELECT count(*) FROM public.tasks t JOIN public.school_years sy ON sy.id = t.school_year_id
                                  WHERE sy.is_active AND NOT sy.is_archived),
  'tasks_without_school_year', (SELECT count(*) FROM public.tasks WHERE school_year_id IS NULL),
  'tasks_with_due_date',       (SELECT count(*) FROM public.tasks WHERE due_date IS NOT NULL),
  'tasks_with_resp',           (SELECT count(*) FROM public.tasks WHERE resp IS NOT NULL AND btrim(resp) <> ''),
  'teacher_accounts',          (SELECT count(*) FROM public.profiles WHERE role = 'teacher'),
  'tasks_has_created_by',      EXISTS (SELECT 1 FROM information_schema.columns
                                  WHERE table_schema='public' AND table_name='tasks' AND column_name='created_by'),
  'new_columns_already_present', COALESCE((SELECT jsonb_agg(column_name ORDER BY column_name) FROM information_schema.columns
                                  WHERE table_schema='public' AND table_name='tasks'
                                    AND column_name IN ('start_at','end_at','evidence_drive_url','evidence_title',
                                                        'evidence_approved','assignee_id')), '[]'::jsonb),
  'missing_helpers',           COALESCE((SELECT jsonb_agg(h ORDER BY h) FROM unnest(ARRAY['current_app_role','is_admin',
                                  'school_year_allows_read','school_year_is_active']) h
                                  WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                                    WHERE n.nspname='public' AND p.proname=h)), '[]'::jsonb),
  'tasks_rls_enabled',         (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tasks'::regclass),
  'tasks_policies',            COALESCE((SELECT jsonb_agg(jsonb_build_object('name', policyname, 'cmd', cmd, 'roles', roles,
                                  'permissive', permissive, 'using', qual, 'with_check', with_check)
                                  ORDER BY policyname) FROM pg_policies WHERE schemaname='public' AND tablename='tasks'), '[]'::jsonb),
  'tasks_table_grants',        COALESCE((SELECT jsonb_agg(grantee || ':' || privilege_type ORDER BY grantee, privilege_type)
                                  FROM information_schema.role_table_grants
                                  WHERE table_schema='public' AND table_name='tasks'
                                    AND grantee IN ('anon','authenticated')), '[]'::jsonb),
  'tasks_triggers',            COALESCE((SELECT jsonb_agg(tgname ORDER BY tgname) FROM pg_trigger
                                  WHERE tgrelid = 'public.tasks'::regclass AND NOT tgisinternal), '[]'::jsonb)
)) AS report;
-- توقّف إن كان: missing_helpers غير فارغ، أو new_columns_already_present غير فارغ (راجعه أولًا)،
-- أو كانت شروط tasks_policies غير مقصورة على admin/vice. الخطوة 1 تتحقق من ذلك أيضًا وتُجهض عند أي اختلاف.
-- tasks_has_created_by = false مقبول: لا الترحيل ولا الواجهة يعتمدان على هذا العمود.
