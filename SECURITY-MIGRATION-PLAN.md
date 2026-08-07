# خطة الانتقال إلى Supabase Auth

**محدّث:** تم تجهيز الانتقال داخل فرع `security-hardening`. راجع `SECURITY-AUTH-TRANSITION.md` كمصدر التنفيذ الحالي.

## الهدف

- إلغاء `authenticate_user` / جدول كلمات المرور المخصصة كمسار دخول
- استخدام **Supabase Auth** مع جلسات JWT
- ربط الصلاحيات بـ `profiles.role` عبر `auth.uid()` وRLS
- أدوار: `admin` / `vice` / `teacher`

## ما تم تجهيزه في الفرع (لم يُنفَّذ على السحابة بعد)

1. `sql/supabase_auth_migration_review.sql` — profiles + RLS + Storage private
2. `sql/trial_evidence_cleanup_review.sql` — تنظيف شواهد تجريبية لاحقاً
3. واجهة: `signInWithPassword` / `getSession` / `onAuthStateChange` / `signOut`
4. Edge Function stubs: `supabase/functions/admin-users`
5. Signed URLs لعرض ملفات evidences

## ترتيب التنفيذ

انظر `SECURITY-AUTH-TRANSITION.md`.

## معايير القبول

- [ ] لا دخول بدون جلسة Supabase Auth
- [ ] لا قراءة password من الواجهة أو anon
- [ ] Storage private + Signed URL
- [ ] اختبار admin/vice/teacher
- [ ] anon لا يقرأ/يكتب بيانات تشغيلية
