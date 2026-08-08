# SQL قديم معطل — Legacy disabled (أرشيف فقط)

هذه المجلد يحفظ نسخًا تاريخية من سكربتات SQL **خطرة أو متقادمة** بعد انتقال المنصة إلى **Supabase Auth**.

## ممنوع

- نسخ أي ملف من هنا إلى SQL Editor وتنفيذه على مشروع Supabase الحالي.
- إعادة تسمية `.sql.disabled` إلى `.sql` بغرض التشغيل.
- استخدام هذه السكربتات كمرجع لسياسات الإنتاج الحالية.

## الملفات ولماذا عُطّلت

| الملف | السبب |
|------|--------|
| `supabase-security.sql.disabled` | مسار دخول قديم عبر `authenticate_user` مع مقارنة كلمة مرور نصية، و`GRANT EXECUTE … TO anon`. |
| `emergency_users_lockdown_review.sql.disabled` | إبقاء/إعادة نشر `authenticate_user` وGRANT لـ anon كمسار دخول طارئ ما قبل Auth. |
| `phase1_08_evidences_storage.sql.disabled` | يجعل bucket `evidences` عامًا (`public = true`) ويفتح سياسات anon للقراءة/الرفع/التعديل/الحذف. |

جميعها **محفوظة للتاريخ فقط** — لا تُنفَّذ.

## ترتيب ملفات الانتقال الآمنة المعتمدة (مراجعة يدوية)

1. `sql/phase_auth_foundation_review.sql`
2. `sql/phase_rls_cutover_review.sql`
3. `sql/phase_storage_private_review.sql`

لا تُنفَّذ تلقائيًا من المستودع؛ تُراجع ثم تُطبَّق يدويًا عند الحاجة وبطريقة idempotent قدر الإمكان.

## ملاحظة

امتداد `.sql.disabled` يقلل احتمال اللصق العرضي في SQL Editor. المحتوى الأصلي لم يُحذف.
