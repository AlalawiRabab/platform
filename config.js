/* ================================================================
   config.js — إعدادات Supabase (واجهة فقط)
   ────────────────────────────────────────────────────────────────
   - استخدم مفتاح anon / publishable فقط.
   - لا تضع service_role هنا أبداً.
   - الحماية الحقيقية: Supabase Auth + RLS + Edge Function Secrets.
   ================================================================ */

(function captureAuthRedirectBeforeClient() {
  // يجب أن يعمل قبل createClient: detectSessionInUrl يستهلك hash ويمسح type=recovery
  try {
    const hashParams = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
    const queryParams = new URLSearchParams(window.location.search || '');
    const type = hashParams.get('type') || queryParams.get('type') || '';
    const err = hashParams.get('error') || queryParams.get('error') || '';
    const desc = hashParams.get('error_description') || queryParams.get('error_description') || '';
    const hasCode = !!(queryParams.get('code'));
    const hasAccessToken = hashParams.has('access_token');
    const isRecovery = type === 'recovery'
      || queryParams.get('recovery') === '1'
      || (hasCode && (!type || type === 'recovery'));
    window.__SOP_AUTH_REDIRECT = {
      isRecovery: !!isRecovery,
      hasCode,
      hasAccessToken,
      error: err,
      errorDescription: desc,
    };
    if (isRecovery) {
      sessionStorage.setItem('sop_pw_recovery', '1');
    }
  } catch {
    window.__SOP_AUTH_REDIRECT = {
      isRecovery: false,
      hasCode: false,
      hasAccessToken: false,
      error: '',
      errorDescription: '',
    };
  }
})();

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
