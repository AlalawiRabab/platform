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

### أسرار مخصصة — المطلوب ضبطها يدوياً
| الاسم | الوصف |
|------|--------|
| `ALLOWED_ORIGINS` | قائمة **origins فقط** (بلا مسارات) مفصولة بفواصل — لـ **CORS فقط** |
| `PASSWORD_RESET_REDIRECT_URLS` | قائمة **روابط كاملة** مسموحة لـ `redirectTo` مفصولة بفواصل (تحافظ على المسار مثل `/platform/`) |

مثال `ALLOWED_ORIGINS` (CORS — أصول بلا مسارات):
```text
http://127.0.0.1:5500,http://localhost:5500,https://alalawirabab.github.io
```

مثال `PASSWORD_RESET_REDIRECT_URLS` (القيمة التي ستُضبط لاحقاً):
```text
http://127.0.0.1:5500/index.html,http://localhost:5500/index.html,https://alalawirabab.github.io/platform/index.html
```

```bash
supabase secrets set ALLOWED_ORIGINS="http://127.0.0.1:5500,http://localhost:5500,https://alalawirabab.github.io"
supabase secrets set PASSWORD_RESET_REDIRECT_URLS="http://127.0.0.1:5500/index.html,http://localhost:5500/index.html,https://alalawirabab.github.io/platform/index.html"
```

⚠️ لا تستخدم `{origin}/index.html` يدوياً للإنتاج — ذلك يحذف مسار `/platform/`.

## إعداد Authentication → URL Configuration
في لوحة Supabase → Authentication → URL Configuration أضف إلى Redirect URLs:

```text
http://127.0.0.1:5500/index.html
http://localhost:5500/index.html
https://alalawirabab.github.io/platform/index.html
```

Site URL يمكن ضبطه لاحقاً على رابط الإنتاج المؤكد عند النشر.

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
6. `redirectTo` يطابق تماماً عنصراً من `PASSWORD_RESET_REDIRECT_URLS` (بلا query/hash، بلا wildcard).
7. لا تُعاد كلمات المرور أو recovery tokens أو action links.
8. منع حذف الذات وآخر admin، ومنع تغيير دور الحساب الحالي.

## مسار استعادة كلمة المرور (واجهة + دالة)
1. Admin يستدعي `send_password_reset` مع `redirect_to` كامل الصفحة (مثل `.../platform/index.html`).
2. المستخدم يفتح رابط البريد → جلسة `PASSWORD_RECOVERY` فقط (بدون إدارة المستخدمين).
3. نافذة «تعيين كلمة مرور جديدة» → `sb.auth.updateUser({ password })`.
4. بعد النجاح: `signOut` + شاشة الدخول ورسالة نجاح عربية.

## النشر (يدوياً لاحقاً)
```bash
supabase login
supabase link --project-ref <PROJECT_REF>
supabase secrets set ALLOWED_ORIGINS="http://127.0.0.1:5500,http://localhost:5500,https://alalawirabab.github.io"
supabase secrets set PASSWORD_RESET_REDIRECT_URLS="http://127.0.0.1:5500/index.html,http://localhost:5500/index.html,https://alalawirabab.github.io/platform/index.html"
supabase functions deploy admin-users
```

## اختبار بعد النشر
1. دخول admin من واجهة ضمن `ALLOWED_ORIGINS`.
2. `list` يظهر المستخدمين بلا كلمات مرور.
3. `update` يغيّر الاسم واسم المستخدم فقط.
4. مسار الاستعادة الكامل (أدناه) — تحقق أن الإنتاج يبقي `/platform/`.
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
    redirect_to: 'https://alalawirabab.github.io/platform/index.html'
  }
});
```
- نجاح الدالة: `{ ok: true, message: "password_reset_sent" }` بلا token/link.
- رفض: `https://alalawirabab.github.io/index.html` (يفقد `/platform/`) أو أي رابط بـ query/hash.

## استدعاء من الواجهة
```js
await sb.functions.invoke('admin-users', {
  body: { action: 'list', page: 1, per_page: 50 }
});
```
