// Supabase Edge Function: admin-users
 // مراجعة — لا تُنشر تلقائياً
 // Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, ALLOWED_ORIGINS

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

const ALLOWED_METHODS = new Set(['POST', 'OPTIONS'])
const ALLOWED_ROLES = new Set(['admin', 'vice', 'teacher'])
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type AdminClient = ReturnType<typeof createClient>

function parseAllowedOriginsRaw(): string[] {
  const raw = Deno.env.get('ALLOWED_ORIGINS') ?? ''
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/** يحوّل عناصر ALLOWED_ORIGINS إلى origins فقط (يدعم إدخال أصل أو رابط كامل). */
function allowedOriginsList(): string[] {
  const out: string[] = []
  for (const entry of parseAllowedOriginsRaw()) {
    try {
      const u = new URL(entry)
      if (u.protocol === 'http:' || u.protocol === 'https:') out.push(u.origin)
    } catch {
      /* تجاهل الإدخالات غير الصالحة */
    }
  }
  return [...new Set(out)]
}

function recoveryRedirectForOrigin(origin: string): string {
  return `${origin.replace(/\/$/, '')}/index.html`
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

function json(req: Request, payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
  })
}

function isUuid(v: string): boolean {
  return UUID_RE.test(String(v || '').trim())
}

function isStrongPassword(password: string): boolean {
  if (password.length < 8 || password.length > 128) return false
  const hasLetter = /[A-Za-z\u0600-\u06FF]/.test(password)
  const hasNumber = /\d/.test(password)
  return hasLetter && hasNumber
}

function normalizeUsername(raw: unknown): string | null {
  if (raw == null) return null
  const u = String(raw).trim()
  if (!u) return null
  if (u.length < 3 || u.length > 64) return null
  if (!/^[a-zA-Z0-9._\u0600-\u06FF-]+$/.test(u)) return null
  return u
}

function normalizeAction(raw: unknown): string {
  const a = String(raw || '').trim().toLowerCase()
  if (a === 'change-role') return 'change_role'
  if (a === 'reset-password') return 'send_password_reset'
  return a
}

/**
 * يبني redirectTo كاملاً من أصل مسموح فقط، مثل:
 * http://127.0.0.1:5500/index.html
 * يرفض أي redirect حر خارج ALLOWED_ORIGINS.
 */
function pickRedirectTo(requested: unknown): string | null {
  const allowed = allowedOriginsList()
  if (!allowed.length) return null

  const req = String(requested || '').trim()
  if (!req) return recoveryRedirectForOrigin(allowed[0])

  try {
    const u = new URL(req)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!allowed.includes(u.origin)) return null
    const path = u.pathname || '/'
    if (path !== '/' && path !== '/index.html') return null
    return recoveryRedirectForOrigin(u.origin)
  } catch {
    return null
  }
}

async function countAdmins(admin: AdminClient): Promise<number | null> {
  const { count, error } = await admin
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin')
  if (error || count == null) return null
  return count
}

async function buildEmailMap(admin: AdminClient): Promise<Map<string, string> | null> {
  const emailById = new Map<string, string>()
  const perPage = 200
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
    if (error) return null
    const users = data?.users || []
    for (const u of users) {
      emailById.set(u.id, u.email || '')
    }
    if (users.length < perPage) break
  }
  return emailById
}

Deno.serve(async (req) => {
  const headers = corsHeadersFor(req)

  if (!ALLOWED_METHODS.has(req.method)) {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...headers, 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' },
    })
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    if (!supabaseUrl || !anonKey || !serviceKey) {
      return json(req, { error: 'operation_failed' }, 500)
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json(req, { error: 'unauthorized' }, 401)

    // 1) JWT أولاً
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData?.user?.id) return json(req, { error: 'unauthorized' }, 401)
    const callerId = userData.user.id

    // 2) profile admin من DB (ليس من الواجهة)
    const { data: callerProfile, error: callerProfileErr } = await userClient
      .from('profiles')
      .select('id,role')
      .eq('id', callerId)
      .maybeSingle()

    if (callerProfileErr || !callerProfile || callerProfile.role !== 'admin') {
      return json(req, { error: 'forbidden' }, 403)
    }

    // 3) service_role بعد تأكيد admin فقط
    const admin = createClient(supabaseUrl, serviceKey)

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return json(req, { error: 'invalid_payload' }, 400)
    const action = normalizeAction((body as { action?: string }).action)

    // ---------- list (ترقيم صفحات) ----------
    if (action === 'list') {
      const page = Math.max(1, Number((body as { page?: number }).page) || 1)
      const perPage = Math.min(100, Math.max(1, Number((body as { per_page?: number }).per_page) || 50))
      const from = (page - 1) * perPage
      const to = from + perPage - 1

      const { data: profiles, error, count } = await admin
        .from('profiles')
        .select('id,name,username,role,created_at', { count: 'exact' })
        .order('created_at', { ascending: true })
        .range(from, to)
      if (error) return json(req, { error: 'operation_failed' }, 400)

      const emailById = await buildEmailMap(admin)
      if (!emailById) return json(req, { error: 'operation_failed' }, 400)

      const users = (profiles || []).map((p) => ({
        id: p.id,
        name: p.name,
        username: p.username,
        role: p.role,
        created_at: p.created_at,
        email: emailById.get(p.id) || '',
      }))
      return json(req, {
        users,
        page,
        per_page: perPage,
        total: count ?? users.length,
      })
    }

    // ---------- create ----------
    if (action === 'create') {
      const email = String((body as { email?: string }).email || '').trim().toLowerCase()
      const password = String((body as { password?: string }).password || '')
      const name = String((body as { name?: string }).name || '').trim()
      const username = normalizeUsername((body as { username?: string }).username)
      const role = String((body as { role?: string }).role || '')

      if (!email || !name || name.length > 120 || !ALLOWED_ROLES.has(role)) {
        return json(req, { error: 'invalid_payload' }, 400)
      }
      if (!isStrongPassword(password)) return json(req, { error: 'invalid_payload' }, 400)
      if ((body as { username?: string }).username != null &&
          String((body as { username?: string }).username).trim() !== '' &&
          !username) {
        return json(req, { error: 'invalid_payload' }, 400)
      }

      if (username) {
        const { data: taken } = await admin
          .from('profiles')
          .select('id')
          .eq('username', username)
          .maybeSingle()
        if (taken) return json(req, { error: 'username_taken' }, 409)
      }

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })
      if (createErr || !created?.user) return json(req, { error: 'operation_failed' }, 400)

      const { error: profileInsertErr } = await admin.from('profiles').insert({
        id: created.user.id,
        name,
        username,
        role,
      })
      if (profileInsertErr) {
        await admin.auth.admin.deleteUser(created.user.id)
        return json(req, { error: 'operation_failed' }, 400)
      }

      return json(req, { id: created.user.id, email, name, username, role })
    }

    // ---------- update (name + username فقط) ----------
    if (action === 'update') {
      const targetId = String((body as { target_id?: string }).target_id || '').trim()
      const name = String((body as { name?: string }).name || '').trim()
      const username = normalizeUsername((body as { username?: string }).username)

      if (!isUuid(targetId) || !name || name.length > 120 || !username) {
        return json(req, { error: 'invalid_payload' }, 400)
      }

      const { data: existing, error: exErr } = await admin
        .from('profiles')
        .select('id')
        .eq('id', targetId)
        .maybeSingle()
      if (exErr || !existing) return json(req, { error: 'invalid_payload' }, 400)

      const { data: taken } = await admin
        .from('profiles')
        .select('id')
        .eq('username', username)
        .neq('id', targetId)
        .maybeSingle()
      if (taken) return json(req, { error: 'username_taken' }, 409)

      // لا تُحدَّث role / id / password / email هنا
      const { data: updated, error } = await admin
        .from('profiles')
        .update({ name, username })
        .eq('id', targetId)
        .select('id,name,username,role,created_at')
        .maybeSingle()
      if (error || !updated) return json(req, { error: 'operation_failed' }, 400)
      return json(req, { ok: true, user: updated })
    }

    // ---------- change_role / change-role ----------
    if (action === 'change_role') {
      const targetId = String((body as { target_id?: string }).target_id || '').trim()
      const role = String((body as { role?: string }).role || '')
      if (!isUuid(targetId) || !ALLOWED_ROLES.has(role)) {
        return json(req, { error: 'invalid_payload' }, 400)
      }
      // منع تغيير دور الحساب الحالي (بما فيها خفض دور admin الذاتي)
      if (targetId === callerId) return json(req, { error: 'forbidden' }, 403)

      const { data: target, error: targetErr } = await admin
        .from('profiles')
        .select('id,role')
        .eq('id', targetId)
        .maybeSingle()
      if (targetErr || !target) return json(req, { error: 'invalid_payload' }, 400)

      if (target.role === 'admin' && role !== 'admin') {
        const n = await countAdmins(admin)
        if (n == null) return json(req, { error: 'operation_failed' }, 400)
        if (n <= 1) return json(req, { error: 'forbidden' }, 403)
      }

      const { data: updated, error } = await admin
        .from('profiles')
        .update({ role })
        .eq('id', targetId)
        .select('id,role')
        .maybeSingle()
      if (error || !updated) return json(req, { error: 'operation_failed' }, 400)
      return json(req, { ok: true })
    }

    // ---------- send_password_reset / reset-password ----------
    if (action === 'send_password_reset') {
      const targetId = String((body as { target_id?: string }).target_id || '').trim()
      if (!isUuid(targetId)) return json(req, { error: 'invalid_payload' }, 400)

      const { data: target, error: targetErr } = await admin
        .from('profiles')
        .select('id')
        .eq('id', targetId)
        .maybeSingle()
      if (targetErr || !target) return json(req, { error: 'invalid_payload' }, 400)

      const { data: authUser, error: authErr } = await admin.auth.admin.getUserById(targetId)
      const email = authUser?.user?.email || ''
      if (authErr || !email) return json(req, { error: 'operation_failed' }, 400)

      const redirectTo = pickRedirectTo((body as { redirect_to?: string }).redirect_to)
      if (!redirectTo) return json(req, { error: 'invalid_payload' }, 400)

      // إرسال رسالة الاستعادة — لا تُعاد الروابط/التوكن في الاستجابة
      const mailClient = createClient(supabaseUrl, anonKey)
      const { error: resetErr } = await mailClient.auth.resetPasswordForEmail(email, {
        redirectTo,
      })
      if (resetErr) return json(req, { error: 'operation_failed' }, 400)

      return json(req, {
        ok: true,
        message: 'password_reset_sent',
      })
    }

    // ---------- delete ----------
    if (action === 'delete') {
      const targetId = String((body as { target_id?: string }).target_id || '').trim()
      if (!isUuid(targetId)) return json(req, { error: 'invalid_payload' }, 400)
      if (targetId === callerId) return json(req, { error: 'forbidden' }, 403)

      const { data: target, error: targetErr } = await admin
        .from('profiles')
        .select('id,role')
        .eq('id', targetId)
        .maybeSingle()
      if (targetErr || !target) return json(req, { error: 'invalid_payload' }, 400)

      if (target.role === 'admin') {
        const n = await countAdmins(admin)
        if (n == null) return json(req, { error: 'operation_failed' }, 400)
        if (n <= 1) return json(req, { error: 'forbidden' }, 403)
      }

      const { error: delAuthErr } = await admin.auth.admin.deleteUser(targetId)
      if (delAuthErr) return json(req, { error: 'operation_failed' }, 400)
      return json(req, { ok: true })
    }

    return json(req, { error: 'invalid_payload' }, 400)
  } catch (_e) {
    return json(req, { error: 'operation_failed' }, 500)
  }
})
