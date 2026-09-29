// Run: node --import ./edge-register.mjs edge-test.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { REPO, buildBaseline } from './sql-test.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

const db = new PGlite();
await buildBaseline(db);
for (const f of ['phase_security_hardening_review.sql', 'phase_login_throttle_review.sql']) {
  await db.exec(readFileSync(`${REPO}/sql/${f}`, 'utf8'));
}
globalThis.__db = db;
globalThis.__edge = { calls: [], rpcFail: false, passwords: { 't@x': 'Correct123', 't2@x': 'Other123' } };

const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'service-key', ALLOWED_ORIGINS: '' };
let handler;
globalThis.Deno = { env: { get: k => env[k] }, serve: h => { handler = h; } };
await import(pathToFileURL(`${REPO}/supabase/functions/username-login/index.ts`).href);

const PROD = 'https://alalawirabab.github.io';
let ipSeq = 0;
function req({ method = 'POST', origin = PROD, body, ip } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  headers['x-forwarded-for'] = ip || `198.51.100.${++ipSeq % 250}`;
  return new Request('https://x.supabase.co/functions/v1/username-login', {
    method, headers, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
}
async function login(username, password, opts = {}) {
  const res = await handler(req({ body: { username, password }, ...opts }));
  let data = null; try { data = await res.clone().json(); } catch {}
  return { status: res.status, data, headers: res.headers, text: data ? JSON.stringify(data) : '' };
}

console.log('\n== username-login: origin handling ==');
{
  let r = await handler(req({ method: 'OPTIONS' }));
  ok('OPTIONS from production origin → 204 + ACAO', r.status === 204 && r.headers.get('Access-Control-Allow-Origin') === PROD);
  r = await handler(req({ method: 'OPTIONS', origin: 'http://localhost:5173' }));
  ok('localhost not allowed by default in production', r.status === 403 && !r.headers.get('Access-Control-Allow-Origin'));
  env.ALLOWED_ORIGINS = 'http://localhost:5173';
  r = await handler(req({ method: 'OPTIONS', origin: 'http://localhost:5173' }));
  ok('localhost allowed only when set via ALLOWED_ORIGINS secret (dev project)', r.status === 204);
  env.ALLOWED_ORIGINS = '';
  r = await login('teacher1', 'x', { origin: '' });
  ok('POST without Origin → 403', r.status === 403);
  r = await login('teacher1', 'x', { origin: 'https://evil.example' });
  ok('POST from foreign Origin → 403', r.status === 403);
}

console.log('\n== username-login: attempt limit (Origin spoofed = non-browser attacker) ==');
{
  const ip = '203.0.113.7';
  for (let i = 1; i <= 5; i++) {
    const r = await login('teacher1', 'wrong' + i, { ip });
    if (i === 5) ok('attempts 1-5 wrong password → 401 invalid_credentials', r.status === 401 && r.data?.error === 'invalid_credentials', r.text);
  }
  globalThis.__edge.calls = [];
  let r = await login('teacher1', 'wrong6', { ip });
  ok('6th attempt → 429 too_many_attempts + Retry-After', r.status === 429 && r.data?.error === 'too_many_attempts'
    && Number(r.headers.get('Retry-After')) > 0 && r.data.retry_after === Number(r.headers.get('Retry-After')), r.text);
  ok('blocked attempt never reaches password check', !globalThis.__edge.calls.includes('signIn') && !globalThis.__edge.calls.includes('from:profiles'),
    JSON.stringify(globalThis.__edge.calls));
  r = await login('teacher1', 'Correct123', { ip: '192.0.2.99' });
  ok('correct password during lockout also 429 (no oracle), even from new IP', r.status === 429, r.text);
  r = await login('TEACHER1', 'wrong', { ip: '192.0.2.100' });
  ok('case variations share the same counter', r.status === 429, r.text);
  ok('429 carries CORS for the app to read it', r.headers.get('Access-Control-Allow-Origin') === PROD);
  r = await login('teacher2', 'Other123', { ip });
  ok('another user unaffected', r.status === 200 && r.data?.access_token === 'AT', r.text);
}

console.log('\n== username-login: unknown usernames are throttled too ==');
{
  let r;
  for (let i = 0; i < 6; i++) r = await login('no.such.user', 'x' + i);
  ok('6th attempt on unknown username → 429 (same as real user)', r.status === 429, r.text);
}

console.log('\n== username-login: success resets counter ==');
{
  await login('vice1', 'bad1'); await login('vice1', 'bad2');
  globalThis.__edge.passwords['v@x'] = 'ViceGood1';
  let r = await login('vice1', 'ViceGood1');
  ok('success → 200 tokens, no email in response', r.status === 200 && r.data.access_token === 'AT' && !r.text.includes('@'), r.text);
  let last;
  for (let i = 0; i < 5; i++) last = await login('vice1', 'bad' + i);
  ok('counter cleared: 5 more attempts allowed after success', last.status === 401, last.text);
}

console.log('\n== username-login: IP spraying limit ==');
{
  let r;
  for (let i = 0; i < 31; i++) r = await login(`spray.user${i}`, 'x', { ip: '203.0.113.50' });
  ok('31st attempt from one IP across usernames → 429', r.status === 429, r.text);
}

console.log('\n== username-login: fail closed ==');
{
  globalThis.__edge.rpcFail = true; globalThis.__edge.calls = [];
  const r = await login('teacher2', 'Other123', { ip: '192.0.2.200' });
  ok('throttle RPC unavailable → 503, password not checked', r.status === 503 && !globalThis.__edge.calls.includes('signIn'), r.text);
  globalThis.__edge.rpcFail = false;
}

console.log('\n== secrets hygiene in function source ==');
{
  const src = readFileSync(`${REPO}/supabase/functions/username-login/index.ts`, 'utf8');
  ok('no console logging of password/tokens', !/console\.(log|error|warn|info)\([^)]*(password|token|email)/i.test(src));
  ok('no hardcoded keys', !/eyJ[A-Za-z0-9_-]{20,}/.test(src) && !/sb_secret_/.test(src));
  const fe = readFileSync(`${REPO}/config.js`, 'utf8') + readFileSync(`${REPO}/script.js`, 'utf8') + readFileSync(`${REPO}/index.html`, 'utf8');
  const roles = [...fe.matchAll(/eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)]
    .map(m => { try { return JSON.parse(Buffer.from(m[1], 'base64url').toString()).role; } catch { return '?'; } });
  ok('frontend has no service_role / secret key', !roles.includes('service_role') && !/sb_secret_/.test(fe), JSON.stringify(roles));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
