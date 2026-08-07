# خطة انتقال Supabase Auth (فرع security-hardening)

**الحالة:** تجهيز للمراجعة فقط — لم يُنفَّذ SQL، ولم يُحذف شيء، ولم يُنشر، ولم يُعمل Push.

## مخطط الانتقال

```
[شاشة الدخول: email+password]
        │
        ▼
supabase.auth.signInWithPassword
        │
        ▼
JWT session (localStorage عبر supabase-js فقط)
        │
        ▼
profiles WHERE id = auth.uid()
        │
   ┌────┴────┐
لا يوجد/دور باطل     دور صالح
   │                    │
signOut + رسالة عامة   دخول المنصة
                        │
                        ▼
              RLS عبر current_app_role()
              Storage: Private + Signed URL
              إدارة المستخدمين: Edge Function admin-users
```

## أين تُخزَّن البيانات (فحص حي سابق)

| النوع | الموقع | ملاحظة |
|------|--------|--------|
| الشواهد | `public.evidences` | لا يوجد جدول `reports` |
| التقارير (واجهة) | نفس `public.evidences` | شاشة التقارير تقرأ evidences |
| ملفات PDF/صور | Storage bucket `evidences` + أعمدة `file_url`/`link` | |
| المستخدمون/الأدوار حالياً | `public.users` (قديم) | يُغلق بالـ RLS ثم يُستبدل بـ Auth |
| المستخدمون/الأدوار بعد الانتقال | `auth.users` + `public.profiles.role` | مصدر الدور الموثوق للـ RLS |
| KPI | localStorage فقط | ليس جدولاً |

### أعداد تجريبية مرشحة للحذف لاحقاً (بدون حذف الآن)

| الجدول/المصدر | العدد | إجراء مقترح |
|---------------|------:|-------------|
| evidences | 30 | حذف بعد التأكيد (تجريبية) |
| evidences بملف `file_url` | 3 | مع حذف ملفات Storage |
| evidences برابط `link` | 13 | حذف السجل فقط |
| Storage `evidences` | 3 ملفات PDF | حذف عبر Storage API أولاً |
| users | 3 | **لا تُحذف** حتى نجاح Auth |
| programs | 7 | **تُحفظ** |
| program_indicators | 14 | **تُحفظ** |
| initiatives | 5 | **تُحفظ** |
| tasks | 2 | **تُحفظ** |
| settings | 1 | **تُحفظ** |
| school_years | 1 | **تُحفظ** |
| teacher_followups | 0 | — |

ملفات Storage المرشحة:
- `e6efa95a-862c-47d4-8a41-92db35ae1e3f/45/general/1786055396187-36.pdf`
- `e6efa95a-862c-47d4-8a41-92db35ae1e3f/46/30/1786055459561-66.pdf`
- `e6efa95a-862c-47d4-8a41-92db35ae1e3f/46/30/1786057608827-NST_GetTeacherInfoByUser2_3_.pdf`

## ترتيب التنفيذ الآمن

1. نسخة احتياطية Database + Storage.
2. تفعيل Email Auth في Dashboard.
3. إنشاء أول حساب admin يدوياً في Authentication → Users.
4. تشغيل `sql/supabase_auth_migration_review.sql` يدوياً بعد المراجعة.
5. إدراج صف `profiles` للمديرة (`id` = Auth user id، `role='admin'`).
6. اختبار دخول المديرة من الواجهة المعدّلة.
7. إنشاء vice/teacher عبر Dashboard أو بعد نشر `admin-users`.
8. نشر Edge Function `admin-users` + Secrets (بدون service_role في الواجهة).
9. اختبار الأدوار + Signed URL + منع anon.
10. بعد الاستقرار: تنظيف evidences عبر `sql/trial_evidence_cleanup_review.sql` + Storage API.
11. لاحقاً فقط: إسقاط `public.users` بعد التأكيد.

## خطة الرجوع إذا فشل الدخول

1. لا تحذف `public.users`.
2. أوقف استخدام الواجهة الجديدة مؤقتاً (الرجوع لـ commit سابق على الفرع).
3. راجع أن صف `profiles` موجود ومرتبط بـ `auth.users.id`.
4. راجع سياسات RLS على `profiles` و`programs`.
5. يمكن تعطيل سياسات Storage الجديدة مؤقتاً إن انكسر العرض — بدون حذف بيانات.
6. لا تنفّذ cleanup evidences أثناء فشل Auth.

## إنشاء أول حساب admin يدوياً

1. Supabase Dashboard → Authentication → Users → Add user.
2. أدخل البريد وكلمة مرور قوية (لا تُحفظ في المستودع).
3. Auto Confirm User = ON.
4. نفّذ SQL الهجرة (profiles).
5. أدرج الملف الشخصي:
```sql
INSERT INTO public.profiles (id, name, username, role)
VALUES ('<AUTH_USER_UUID>', 'مديرة المدرسة', NULL, 'admin');
```
6. جرّب الدخول من الواجهة بالبريد فقط.

## المخاطر المتبقية

- SQL وEdge Function لم يُنفَّذا/يُنشرا بعد — الإنتاج الحالي ما زال على الوضع القديم حتى التنفيذ اليدوي.
- evidences القديمة بلا `created_by` قد تحتاج backfill قبل تضييق سياسات المعلمة أكثر.
- تحويل bucket إلى Private قبل نشر الواجهة الجديدة يكسر الروابط العامة القديمة.
- `admin-users` غير منشور → إدارة المستخدمين من الواجهة لن تعمل حتى النشر.
- دور المعلمة في تحديث `program_indicators` واسع نسبياً (إنجاز المؤشر) — راقب إساءة الاستخدام.
- مفتاح anon يبقى في الواجهة (طبيعي) — الحماية تعتمد على RLS/Auth.
