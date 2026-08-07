/* ================================================================
   config.js — إعدادات Supabase (واجهة فقط)
   ────────────────────────────────────────────────────────────────
   - استخدم مفتاح anon / publishable فقط.
   - لا تضع service_role هنا أبداً.
   - الحماية الحقيقية: Supabase Auth + RLS + Edge Function Secrets.
   ================================================================ */

window.SUPABASE_URL = 'https://qeabgktifyyyjrzphtpw.supabase.co';
// anon / publishable key فقط — لا تضع service_role هنا أبداً
window.SUPABASE_ANON = 'sb_publishable_G3EvrlPIwhYfrnauHQDveA_bW4YpVwl';
window.supabaseClient = supabase.createClient(
  window.SUPABASE_URL,
  window.SUPABASE_ANON,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: window.localStorage,
    },
  }
);
