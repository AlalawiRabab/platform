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

const SCHOOL = '203.0.113.7';
console.log('\n== username-login: shared teacher account from one school network ==');
{
  globalThis.__edge.passwords['t@x'] = 'Correct123';
  let r;
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 9; i++) await login('teacher1', 'typo' + i, { ip: SCHOOL });
    r = await login('teacher1', 'Correct123', { ip: SCHOOL });
  }
  ok('school: 27 scattered typos between successful logins never lock the shared account', r.status === 200 && r.data?.access_token === 'AT', r.text);

  for (let i = 1; i <= 10; i++) r = await login('teacher1', 'wrong' + i, { ip: SCHOOL });
  ok('school: 10 consecutive failures → still 401 (not locked yet)', r.status === 401 && r.data?.error === 'invalid_credentials', r.text);
  globalThis.__edge.calls = [];
  r = await login('teacher1', 'wrong11', { ip: SCHOOL });
  ok('school: 11th consecutive failure → 429 too_many_attempts + Retry-After', r.status === 429 && r.data?.error === 'too_many_attempts'
    && Number(r.headers.get('Retry-After')) > 0 && r.data.retry_after === Number(r.headers.get('Retry-After')), r.text);
  ok('blocked attempt never reaches password check', !globalThis.__edge.calls.includes('signIn') && !globalThis.__edge.calls.includes('from:profiles'),
    JSON.stringify(globalThis.__edge.calls));
  r = await login('teacher1', 'Correct123', { ip: SCHOOL });
  ok('correct code during lockout from the same network also 429 (no oracle)', r.status === 429, r.text);
  r = await login('TEACHER1', 'wrong', { ip: SCHOOL });
  ok('case variations share the same counter', r.status === 429, r.text);
  ok('429 carries CORS for the app to read it', r.headers.get('Access-Control-Allow-Origin') === PROD);
  r = await login('teacher1', 'Correct123', { ip: '198.51.100.77' });
  ok('same shared account from another network (e.g. home) still works', r.status === 200, r.text);
  globalThis.__edge.passwords['v@x'] = 'ViceGood1';
  r = await login('vice1', 'ViceGood1', { ip: SCHOOL });
  ok('vice/admin accounts from the school network unaffected', r.status === 200, r.text);
}

console.log('\n== username-login: unknown usernames are throttled too ==');
{
  let r;
  for (let i = 0; i < 11; i++) r = await login('no.such.user', 'x' + i, { ip: '192.0.2.10' });
  ok('11th attempt on unknown username → 429 (same as real user)', r.status === 429, r.text);
}

console.log('\n== username-login: success resets that network counter ==');
{
  for (let i = 0; i < 5; i++) await login('vice1', 'bad' + i, { ip: '192.0.2.20' });
  let r = await login('vice1', 'ViceGood1', { ip: '192.0.2.20' });
  ok('success → 200 tokens, no email in response', r.status === 200 && r.data.access_token === 'AT' && !r.text.includes('@'), r.text);
  let last;
  for (let i = 0; i < 10; i++) last = await login('vice1', 'bad' + i, { ip: '192.0.2.20' });
  ok('counter cleared: 10 more attempts allowed after success', last.status === 401, last.text);
}

console.log('\n== username-login: distributed guessing and spraying caps ==');
{
  await db.exec('DELETE FROM private.login_attempts');
  let r;
  for (let n = 0; n < 20; n++) for (let i = 0; i < 5; i++) await login('teacher2', 'g' + i, { ip: `100.64.0.${n + 1}` });
  r = await login('teacher2', 'Other123', { ip: '100.64.1.1' });
  ok('username cap: 100 failures from 20 networks → 429 from any network', r.status === 429, r.text);

  await db.exec('DELETE FROM private.login_attempts');
  for (let i = 0; i < 200; i++) await login(`spray.user${i}`, 'x', { ip: '203.0.113.50' });
  r = await login('spray.final', 'x', { ip: '203.0.113.50' });
  ok('network cap: 201st failure across usernames from one network → 429', r.status === 429, r.text);
  await db.exec('DELETE FROM private.login_attempts');
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
