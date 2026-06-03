/* ================================================================
   config.js — إعدادات Supabase
   ────────────────────────────────────────────────────────────────
   ⚠️ مهم للأمان:
   - استخدم مفتاح anon (العام) فقط هنا. وهو آمن للاستخدام في الواجهة الأمامية.
   - لا تضع أبداً مفتاح service_role في هذا الملف أو في أي كود يصل للمتصفح،
     لأنه يمنح صلاحيات كاملة على قاعدة البيانات ويتجاوز سياسات RLS.
   - الحماية الفعلية تأتي من تفعيل Row Level Security (RLS) على الجداول.

   احصل على القيمتين من:
   Supabase Dashboard → Project Settings → API → Project URL + anon public key
   ================================================================ */

const SUPABASE_URL = 'https://qeabgktifyyyjrzphtpw.supabase.co';

const SUPABASE_ANON = 'sb_publishable_G3EvrlPIwhYfrnauHQDveA_bW4YpVwl';
const supabaseClient = supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON
);
