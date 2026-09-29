// Minimal supabase-js stand-in for username-login, backed by PGlite (globalThis.__db)
const S = () => globalThis.__edge;

async function asService(sql, params) {
  const db = globalThis.__db;
  await db.exec('RESET ROLE; SET ROLE service_role;');
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE;'); }
}

export function createClient(url, key) {
  const isService = key === 'service-key';
  return {
    async rpc(fn, args) {
      S().calls.push(`rpc:${fn}`);
      if (!isService) return { data: null, error: { message: 'not service' } };
      if (S().rpcFail) return { data: null, error: { message: 'function does not exist' } };
      try {
        if (fn === 'login_throttle_begin') {
          const r = await asService('SELECT public.login_throttle_begin($1, $2, $3) AS r', [args.p_user_key, args.p_ip_key, args.p_pair_key]);
          return { data: r.rows[0].r, error: null };
        }
        if (fn === 'login_throttle_success') {
          await asService('SELECT public.login_throttle_success($1, $2::uuid)', [args.p_pair_key, args.p_attempt_id || null]);
          return { data: null, error: null };
        }
      } catch (e) { return { data: null, error: { message: e.message } }; }
      return { data: null, error: { message: 'unknown rpc' } };
    },
    from(table) {
      const q = { col: null, val: null };
      const b = {
        select() { return b; },
        ilike(col, val) { q.col = col; q.val = val; return b; },
        limit() { return b; },
        then(res, rej) {
          S().calls.push(`from:${table}`);
          return globalThis.__db.query(`SELECT id FROM public.profiles WHERE ${q.col} ILIKE $1 ESCAPE '\\'`, [q.val])
            .then(r => ({ data: r.rows, error: null }), e => ({ data: null, error: { message: e.message } }))
            .then(res, rej);
        },
      };
      return b;
    },
    auth: {
      admin: {
        async getUserById(id) {
          const r = await globalThis.__db.query('SELECT email FROM auth.users WHERE id = $1', [id]);
          return { data: { user: r.rows[0] ? { email: r.rows[0].email } : null }, error: null };
        },
      },
      async signInWithPassword({ email, password }) {
        S().calls.push('signIn');
        if (S().passwords[email] === password) {
          return { data: { session: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, expires_at: 1, token_type: 'bearer' } }, error: null };
        }
        return { data: { session: null }, error: { message: 'Invalid login credentials' } };
      },
    },
  };
}
