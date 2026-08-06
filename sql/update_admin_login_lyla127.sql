-- ============================================================
-- تحديث بيانات دخول المسؤول فقط
-- ============================================================
-- نفّذ يدوياً في Supabase SQL Editor.
-- لا يُنشئ مستخدماً جديداً، ولا يغيّر أدوار المستخدمين الآخرين.
--
-- الهدف:
--   اسم المستخدم: Lyla127  (يُخزَّن في عمود email كـ lyla127)
--   كلمة المرور: 1277
--
-- يحدّث حساب المدير الحالي admin@school.sa إن وُجد.
-- ============================================================

DO $$
DECLARE
  v_updated int := 0;
BEGIN
  -- إن كان الحساب محدَّثاً مسبقاً إلى lyla127، حدّث كلمة المرور فقط
  UPDATE public.users
     SET password = '1277',
         email = 'lyla127'
   WHERE role = 'admin'
     AND lower(email) IN ('admin@school.sa', 'lyla127');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RAISE EXCEPTION 'No admin user found with email admin@school.sa or lyla127. No changes applied.';
  END IF;

  IF v_updated > 1 THEN
    RAISE NOTICE 'Updated % admin row(s). Review users table if unexpected.', v_updated;
  ELSE
    RAISE NOTICE 'Admin login updated successfully to username=lyla127';
  END IF;
END $$;

-- تحقق سريع (بدون إظهار كلمات مرور الآخرين بتفاصيل زائدة)
SELECT id, name, email, role
  FROM public.users
 WHERE lower(email) = 'lyla127'
   AND role = 'admin';
