# Edge Function: admin-users

مراجعة فقط — لا تُنشر تلقائياً من المستودع.

## الغرض
إدارة مستخدمي المنصة من حساب **admin** فقط عبر Supabase Auth + `public.profiles`.

## الأسرار

### افتراضية للدالة المستضافة (لا تُعاد ضبطها يدوياً عادةً)
عند نشر Edge Function على Supabase تتوفر تلقائياً، والدالة تتحقق من وجودها فقط:

| الاسم | الاستخدام داخل الدالة |
|------|------------------------|
| `SUPABASE_URL` | عملاء Auth / Admin |
| `SUPABASE_ANON_KEY` | التحقق من JWT + `resetPasswordForEmail` |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin API وprofiles (داخل الدالة فقط) |

لا تضع قيم هذه المفاتيح في Git أو في هذا الملف.

### سر مخصص — المطلوب ضبطه يدوياً فقط
| الاسم | الوصف |
|------|--------|
| `ALLOWED_ORIGINS` | قائمة origins مسموحة مفصولة بفواصل لـ CORS وبناء `redirectTo` |

مثال شكل القيمة (origins فقط، بدون مفاتيح):
```text
http://127.0.0.1:5500,http://localhost:5500
```
أضف لاحقاً أصل بيئة الإنتاج المؤكد (مثل GitHub Pages) دون تخمين.

```bash
supabase secrets set ALLOWED_ORIGINS="http://127.0.0.1:5500,http://localhost:5500"
```

## إعداد Authentication → URL Configuration
في لوحة Supabase → Authentication → URL Configuration أضف إلى Redirect URLs (وربط Site URL حسب الحاجة):

```text
http://127.0.0.1:5500/index.html
http://localhost:5500/index.html
```

ثم أضف رابط الإنتاج الكامل لاحقاً (نفس مسار الصفحة، مثل `.../index.html`).

بدون هذه الروابط قد تفشل رسالة الاستعادة أو يُرفض `redirectTo`.

## العمليات المدعومة (`action`)
| action | مرادفات | الوصف |
|--------|---------|--------|
| `list` | — | قائمة مستخدمين مع ترقيم صفحات (`page`, `per_page`) |
| `create` | — | إنشاء Auth user + profile |
| `update` | — | تعديل `name` و`username` فقط |
| `change_role` | `change-role` | تغيير الدور مع حماية آخر admin |
| `send_password_reset` | `reset-password` | إرسال رسالة استعادة كلمة المرور |
| `delete` | — | حذف Auth user (CASCADE للـ profile) |

الأدوار المسموحة فقط: `admin` | `vice` | `teacher`.

## الأمان
1. POST و OPTIONS فقط.
2. JWT عبر `getUser` أولاً.
3. قراءة `profiles.role` للمستدعي — يجب `admin`.
4. بعدها فقط يُستخدم `service_role`.
5. CORS من أصول `ALLOWED_ORIGINS` فقط — بلا `*`.
6. `redirectTo` يُبنى كـ `{origin}/index.html` من أصل مسموح فقط؛ أي redirect حر خارج القائمة يُرفض.
7. لا تُعاد كلمات المرور أو recovery tokens أو action links.
8. منع حذف الذات وآخر admin، ومنع تغيير دور الحساب الحالي.

## مسار استعادة كلمة المرور (واجهة + دالة)
1. Admin يستدعي `send_password_reset` مع `redirect_to` مثل `http://127.0.0.1:5500/index.html`.
2. المستخدم يفتح رابط البريد → يصل للمنصة بجلسة `PASSWORD_RECOVERY` فقط (بدون دخول لإدارة المستخدمين).
3. نافذة «تعيين كلمة مرور جديدة» → `sb.auth.updateUser({ password })`.
4. بعد النجاح: `signOut` + شاشة الدخول ورسالة نجاح عربية.

## النشر (يدوياً لاحقاً)
```bash
supabase login
supabase link --project-ref <PROJECT_REF>
supabase secrets set ALLOWED_ORIGINS="http://127.0.0.1:5500,http://localhost:5500"
supabase functions deploy admin-users
```

## اختبار بعد النشر
1. دخول admin من واجهة ضمن `ALLOWED_ORIGINS`.
2. `list` يظهر المستخدمين بلا كلمات مرور.
3. `update` يغيّر الاسم واسم المستخدم فقط.
4. مسار الاستعادة الكامل (أدناه).
5. teacher/vice → `forbidden`؛ بلا JWT → `unauthorized`.
6. خفض آخر admin أو تغيير دور الذات → `forbidden`.

### اختبار `update`
```js
await sb.functions.invoke('admin-users', {
  body: {
    action: 'update',
    target_id: '<uuid>',
    name: 'اسم جديد',
    username: 'unique_user'
  }
});
```

### اختبار `send_password_reset` + الواجهة
```js
await sb.functions.invoke('admin-users', {
  body: {
    action: 'send_password_reset',
    target_id: '<uuid>',
    redirect_to: 'http://127.0.0.1:5500/index.html'
  }
});
```
- نجاح الدالة: `{ ok: true, message: "password_reset_sent" }` بلا token/link.
- افتح رابط البريد → تظهر نافذة التعيين (جلسة `PASSWORD_RECOVERY` دون صلاحيات الإدارة).
- عيّن كلمة مرور ≥ 8 ومتطابقة → تسجيل خروج ورسالة نجاح على شاشة الدخول.
- رابط منتهٍ/غير صالح → رسالة عربية واضحة.

## استدعاء من الواجهة
```js
await sb.functions.invoke('admin-users', {
  body: { action: 'list', page: 1, per_page: 50 }
});
```
