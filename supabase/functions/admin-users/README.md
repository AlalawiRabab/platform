# Edge Function: admin-users (مراجعة — لا تُنشر تلقائياً)

## Secrets
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (Secrets فقط — ممنوع في الواجهة)
- `ALLOWED_ORIGINS` قائمة مفصولة بفواصل، مثال محلي:
  `http://127.0.0.1:5500,http://localhost:5500,http://127.0.0.1:8080,http://localhost:8080`
  أضف رابط GitHub Pages المؤكد لاحقاً دون تخمين.

## النشر اليدوي لاحقاً
```bash
supabase secrets set ALLOWED_ORIGINS="..."
supabase functions deploy admin-users
```

## الأمان
- POST و OPTIONS فقط
- JWT → قراءة profile للمستدعي → يجب `role=admin` → ثم service_role
- لا تُعاد كلمات المرور
- أخطاء عامة فقط
