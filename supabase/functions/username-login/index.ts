// Supabase Edge Function: username-login
// مراجعة — لا تُنشر تلقائياً
// Secrets (أسماء فقط): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, ALLOWED_ORIGINS
// ملاحظة نشر لاحقاً: شاشة الدخول بلا JWT → يلزم verify_jwt=false لهذه الدالة فقط (لا يُضبط في هذا الملف).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

const ALLOWED_METHODS = new Set(['POST', 'OPTIONS'])
/** حد أقصى معقول لجسم طلب الدخول (بايت) */
const MAX_BODY_BYTES = 4096

/** مطابق admin-users normalizeUsername */
function normalizeUsername(raw: unknown): string | null {
  if (raw == null) return null
  const u = String(raw).trim()
  if (!u) return null
  if (u.length < 3 || u.length > 64) return null
  if (!/^[a-zA-Z0-9._\u0600-\u06FF-]+$/.test(u)) return null
  return u
}

function parseAllowedOriginsRaw(): string[] {
  const raw = Deno.env.get('ALLOWED_ORIGINS') ?? ''
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/** CORS فقط: origins بلا مسارات (نفس سياسة admin-users). */
function allowedOriginsList(): string[] {
  const out: string[] = []
  for (const entry of parseAllowedOriginsRaw()) {
    try {
      const u = new URL(entry)
      if (u.protocol === 'http:' || u.protocol === 'https:') out.push(u.origin)
    } catch {
      /* تجاهل */
    }
  }
  return [...new Set(out)]
}

function corsHeadersFor(req: Request): Record<string, string> {
  const allowed = allowedOriginsList()
  const origin = req.headers.get('Origin') || ''
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

/**
 * لهذه الدالة العامة (verify_jwt=false): ارفض Origin غير المسموح أو الغائب
 * حتى لا تُسلَّم tokens لطلب من أصل غير مدرج (أو بدون Origin).
 * إن كانت ALLOWED_ORIGINS فارغة → fail closed.
 */
function originAllowedOrReject(req: Request): Response | null {
  const allowed = allowedOriginsList()
  const origin = req.headers.get('Origin') || ''
  if (!allowed.length || !origin || !allowed.includes(origin)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
    })
  }
  return null
}

function json(req: Request, payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
  })
}

/** خطأ دخول موحّد — لا يميّز بين username غير موجود وكلمة مرور خاطئة */
function authFailed(req: Request) {
  return json(req, { error: 'invalid_credentials' }, 401)
}

/**
 * تهريب أحرف LIKE/ILIKE في PostgREST حتى لا يُفسَّر `_` أو `%` كـ wildcard.
 * مطلوب لأن charset المسموح لاسم المستخدم يتضمن `_`.
 */
function escapeIlikeExact(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
}

function isJsonContentType(req: Request): boolean {
  const ct = (req.headers.get('Content-Type') || '').toLowerCase()
  return ct.startsWith('application/json')
}

Deno.serve(async (req) => {
  const headers = corsHeadersFor(req)

  if (!ALLOWED_METHODS.has(req.method)) {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...headers, 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' },
    })
  }

  // CORS / Origin gate قبل أي منطق حساس
  const originReject = originAllowedOrReject(req)
  if (originReject) return originReject

  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeadersFor(req) })
  }

  try {
    if (!isJsonContentType(req)) {
      return json(req, { error: 'invalid_payload' }, 400)
    }

    const contentLengthRaw = req.headers.get('Content-Length')
    if (contentLengthRaw != null && contentLengthRaw !== '') {
      const contentLength = Number(contentLengthRaw)
      if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_BODY_BYTES) {
        return json(req, { error: 'invalid_payload' }, 400)
      }
    }

    const rawBody = await req.arrayBuffer()
    if (rawBody.byteLength > MAX_BODY_BYTES) {
      return json(req, { error: 'invalid_payload' }, 400)
    }

    let body: unknown = null
    try {
      const text = new TextDecoder().decode(rawBody)
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json(req, { error: 'invalid_payload' }, 400)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    if (!supabaseUrl || !anonKey || !serviceKey) {
      return json(req, { error: 'operation_failed' }, 500)
    }

    // Validate قبل أي query — يمنع أحرف wildcard من الوصول لـ ilike أصلاً (% ليست في charset)
    const username = normalizeUsername((body as { username?: unknown }).username)
    const password = String((body as { password?: unknown }).password ?? '')

    if (!username || !password || password.length < 1 || password.length > 128) {
      return authFailed(req)
    }

    // 1) service_role: بحث profile فقط (id) — يتجاوز RLS داخلياً فقط
    //    case-insensitive عبر ilike + تهريب _/% 
    //    limit(2): إن وُجد أكثر من صف → فشل عام (لا اختيار عشوائي)
    const admin = createClient(supabaseUrl, serviceKey)
    const { data: profiles, error: profileErr } = await admin
      .from('profiles')
      .select('id')
      .ilike('username', escapeIlikeExact(username))
      .limit(2)

    if (
      profileErr ||
      !Array.isArray(profiles) ||
      profiles.length !== 1 ||
      !profiles[0]?.id
    ) {
      return authFailed(req)
    }
    const profileId = profiles[0].id as string

    // 2) service_role Admin API: جلب البريد داخلياً فقط — لا يُعاد ولا يُسجَّل
    const { data: authData, error: authLookupErr } = await admin.auth.admin.getUserById(
      profileId,
    )
    const email = authData?.user?.email || ''
    if (authLookupErr || !email) {
      return authFailed(req)
    }

    // 3) التحقق من كلمة المرور عبر anon Auth — ليست جلسة service_role
    const authClient = createClient(supabaseUrl, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
    const { data: signInData, error: signInErr } = await authClient.auth.signInWithPassword({
      email,
      password,
    })

    if (signInErr || !signInData?.session) {
      return authFailed(req)
    }

    const session = signInData.session
    return json(req, {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      expires_at: session.expires_at ?? null,
      token_type: session.token_type || 'bearer',
    })
  } catch (_e) {
    return json(req, { error: 'operation_failed' }, 500)
  }
})
