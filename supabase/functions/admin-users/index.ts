// Supabase Edge Function: admin-users
 // مراجعة فقط — لا تُنشر تلقائياً
 // Secrets:
 //   SUPABASE_URL
 //   SUPABASE_ANON_KEY
 //   SUPABASE_SERVICE_ROLE_KEY  ← فقط في Secrets
 //   ALLOWED_ORIGINS           ← قائمة مفصولة بفواصل، بدون تخمين رابط الإنتاج

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

const ALLOWED_METHODS = new Set(['POST', 'OPTIONS'])

function parseAllowedOrigins(): string[] {
  const raw = Deno.env.get('ALLOWED_ORIGINS') ?? ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function corsHeadersFor(req: Request): Record<string, string> {
  const allowed = parseAllowedOrigins()
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

function isStrongPassword(password: string): boolean {
  if (password.length < 8 || password.length > 128) return false
  const hasLetter = /[A-Za-z\u0600-\u06FF]/.test(password)
  const hasNumber = /\d/.test(password)
  return hasLetter && hasNumber
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

    // 1) تحقق JWT أولاً بمفتاح anon + توكن المستدعي
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData?.user?.id) return json(req, { error: 'unauthorized' }, 401)

    const callerId = userData.user.id

    // 2) قراءة profile للمستدعي الموثوق (ليس role من الواجهة)
    const { data: callerProfile, error: callerProfileErr } = await userClient
      .from('profiles')
      .select('id,role')
      .eq('id', callerId)
      .maybeSingle()

    if (callerProfileErr || !callerProfile || callerProfile.role !== 'admin') {
      return json(req, { error: 'forbidden' }, 403)
    }

    // 3) بعد تأكيد admin فقط: استخدم service_role
    const admin = createClient(supabaseUrl, serviceKey)

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return json(req, { error: 'invalid_payload' }, 400)
    const action = String((body as { action?: string }).action || '')

    if (action === 'list') {
      const { data: profiles, error } = await admin
        .from('profiles')
        .select('id,name,username,role,created_at')
        .order('created_at', { ascending: true })
      if (error) return json(req, { error: 'operation_failed' }, 400)

      const { data: authList, error: authErr } = await admin.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      })
      if (authErr) return json(req, { error: 'operation_failed' }, 400)

      const emailById = new Map((authList?.users || []).map((u) => [u.id, u.email || '']))
      const users = (profiles || []).map((p) => ({
        id: p.id,
        name: p.name,
        username: p.username,
        role: p.role,
        created_at: p.created_at,
        email: emailById.get(p.id) || '',
      }))
      return json(req, { users })
    }

    if (action === 'create') {
      const email = String((body as { email?: string }).email || '').trim().toLowerCase()
      const password = String((body as { password?: string }).password || '')
      const name = String((body as { name?: string }).name || '').trim()
      const usernameRaw = (body as { username?: string }).username
      const username = usernameRaw ? String(usernameRaw).trim() : null
      const role = String((body as { role?: string }).role || '')

      if (!email || !name || !['admin', 'vice', 'teacher'].includes(role)) {
        return json(req, { error: 'invalid_payload' }, 400)
      }
      if (!isStrongPassword(password)) return json(req, { error: 'invalid_payload' }, 400)

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

      // لا تُعاد كلمة المرور
      return json(req, { id: created.user.id, email, name, username, role })
    }

    if (action === 'change_role') {
      const targetId = String((body as { target_id?: string }).target_id || '')
      const role = String((body as { role?: string }).role || '')
      if (!targetId || !['admin', 'vice', 'teacher'].includes(role)) {
        return json(req, { error: 'invalid_payload' }, 400)
      }
      if (targetId === callerId) return json(req, { error: 'forbidden' }, 403)

      const { data: target, error: targetErr } = await admin
        .from('profiles')
        .select('id,role')
        .eq('id', targetId)
        .maybeSingle()
      if (targetErr || !target) return json(req, { error: 'invalid_payload' }, 400)

      if (target.role === 'admin' && role !== 'admin') {
        const { count, error: countErr } = await admin
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('role', 'admin')
        if (countErr || count == null) return json(req, { error: 'operation_failed' }, 400)
        if (count <= 1) return json(req, { error: 'forbidden' }, 403)
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

    if (action === 'delete') {
      const targetId = String((body as { target_id?: string }).target_id || '')
      if (!targetId) return json(req, { error: 'invalid_payload' }, 400)
      if (targetId === callerId) return json(req, { error: 'forbidden' }, 403)

      const { data: target, error: targetErr } = await admin
        .from('profiles')
        .select('id,role')
        .eq('id', targetId)
        .maybeSingle()
      if (targetErr || !target) return json(req, { error: 'invalid_payload' }, 400)

      if (target.role === 'admin') {
        const { count, error: countErr } = await admin
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('role', 'admin')
        if (countErr || count == null) return json(req, { error: 'operation_failed' }, 400)
        if (count <= 1) return json(req, { error: 'forbidden' }, 403)
      }

      // احذف Auth user أولاً؛ CASCADE يحذف profile
      const { error: delAuthErr } = await admin.auth.admin.deleteUser(targetId)
      if (delAuthErr) return json(req, { error: 'operation_failed' }, 400)
      return json(req, { ok: true })
    }

    return json(req, { error: 'invalid_payload' }, 400)
  } catch (_e) {
    return json(req, { error: 'operation_failed' }, 500)
  }
})
