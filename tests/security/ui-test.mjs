import { PGlite } from '@electric-sql/pglite';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { REPO, U, Y_ACTIVE, Y_ARCH, buildBaseline } from './sql-test.mjs';

const TZ = process.env.TZ || '(system)';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

// ---------- DB: baseline + migrations in deployment order (final state) ----------
const db = new PGlite();
await buildBaseline(db);
for (const f of ['phase_security_hardening_review.sql', 'phase_task_schedule_evidence_review.sql',
                 'phase_task_schedule_enforce_review.sql', 'phase_storage_teacher_read_review.sql']) {
  await db.exec(readFileSync(`${REPO}/sql/${f}`, 'utf8'));
}

const COLTYPE = Object.fromEntries((await db.query(
  `SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='tasks'`
)).rows.map(r => [r.column_name, r.udt_name]));
let currentRole = 'vice';
async function runAs(sql, params) {
  await db.exec('RESET ROLE');
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [U[currentRole] || '']);
  await db.exec('SET ROLE authenticated');
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}

// ---------- minimal PostgREST-like mock over PGlite (tasks only) ----------
const YEAR_ROW = { id: Y_ACTIVE, name: '1447', label_ar: '1447', status: 'active', is_active: true,
  is_archived: false, start_date: '2025-08-01', end_date: '2026-12-31', notes: null, hijri_year: '1447', created_at: '2025-01-01' };

class Q {
  constructor(table) { this.table = table; this.op = 'select'; this.filters = []; this.one = false; }
  select() { return this; }
  insert(p) { this.op = 'insert'; this.payload = p; return this; }
  update(p) { this.op = 'update'; this.payload = p; return this; }
  upsert(p) { this.op = 'noop'; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(k, v) { this.filters.push([k, v]); return this; }
  order() { return this; } limit() { return this; } range() { return this; } in() { return this; }
  single() { this.one = true; return this; }
  maybeSingle() { this.one = true; this.maybe = true; return this; }
  then(res, rej) { return this.exec().then(res, rej); }
  async exec() {
    if (this.table === 'school_years') return { data: this.one ? YEAR_ROW : [YEAR_ROW], error: null };
    if (this.table === 'profiles') return { data: null, error: null };
    if (this.table !== 'tasks') return { data: this.one ? null : [], error: null };
    const params = []; const p = (v, col) => { params.push(v); return `$${params.length}::${COLTYPE[col] || 'text'}`; };
    const where = (this.op === 'select' || this.op === 'delete') && this.filters.length
      ? ' WHERE ' + this.filters.map(([k, v]) => `${k} = ${p(v, k)}`).join(' AND ') : '';
    let sql;
    if (this.op === 'select') sql = `SELECT row_to_json(t) j FROM public.tasks t${where} ORDER BY created_at`;
    else if (this.op === 'insert') {
      const cols = Object.keys(this.payload);
      sql = `WITH r AS (INSERT INTO public.tasks (${cols.join(',')}) VALUES (${cols.map(c => p(this.payload[c], c)).join(',')}) RETURNING *) SELECT row_to_json(r) j FROM r`;
    } else if (this.op === 'update') {
      const sets = Object.keys(this.payload).map(c => `${c} = ${p(this.payload[c], c)}`).join(', ');
      const w = ' WHERE ' + this.filters.map(([k, v]) => `${k} = ${p(v, k)}`).join(' AND ');
      sql = `WITH r AS (UPDATE public.tasks SET ${sets}${w} RETURNING *) SELECT row_to_json(r) j FROM r`;
    } else if (this.op === 'delete') sql = `WITH r AS (DELETE FROM public.tasks${where} RETURNING *) SELECT row_to_json(r) j FROM r`;
    else return { data: null, error: null };
    try {
      const rows = (await runAs(sql, params)).rows.map(r => r.j);
      if (this.one) {
        if (rows.length !== 1) return this.maybe && !rows.length ? { data: null, error: null }
          : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
        return { data: rows[0], error: null };
      }
      return { data: rows, error: null };
    } catch (e) {
      if (process.env.DEBUG_SQL) console.log('  [sql-error]', e.message, '\n   ', sql, JSON.stringify(params));
      return { data: null, error: { code: e.code || '', message: e.message } };
    }
  }
}
const mockClient = {
  from: t => new Q(t),
  rpc: async () => ({ data: null, error: null }),
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
    setSession: async () => ({ data: {}, error: null }),
  },
  storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }), upload: async () => ({}), remove: async () => ({}) }) },
  functions: { invoke: async () => ({ data: null, error: null }) },
};

// ---------- load the real index.html + script.js ----------
const html = readFileSync(`${REPO}/index.html`, 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) console.log('  [jsdom]', e.message); });
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/index.html', virtualConsole: vc, pretendToBeVisual: true });
const w = dom.window;
w.supabaseClient = mockClient;
w.confirm = () => true; w.alert = () => {};
const s = w.document.createElement('script');
s.textContent = readFileSync(`${REPO}/script.js`, 'utf8');
w.document.body.appendChild(s);
await new Promise(r => setTimeout(r, 50));

const $ = id => w.document.getElementById(id);
const toast = () => $('toast')?.textContent || '';
const setVal = (id, v) => { $(id).value = v; };
async function login(role) {
  currentRole = role;
  const names = { admin: 'القائدة', vice: 'الوكيلة', teacher: 'المعلمة', teacher2: 'معلمة ثانية' };
  const appRole = role.startsWith('teacher') ? 'teacher' : role;
  w.eval(`currentUser = { id: '${U[role]}', name: '${names[role]}', role: '${appRole}', email: '' };
          schoolYearsCache = []; selectedSchoolYearId = '${Y_ACTIVE}'; activeSchoolYearId = '${Y_ACTIVE}';`);
  await w.eval('fetchSchoolYears()');
  w.eval(`selectedSchoolYearId = '${Y_ACTIVE}'`);
  await w.eval('fetchTasks()');
}
const tasks = () => w.eval('tasksCache');
const dbTask = async name => (await db.query(`SELECT row_to_json(t) j FROM public.tasks t WHERE name = $1`, [name])).rows[0]?.j;

console.log(`\n== UI tests (TZ=${TZ}) ==`);

// 1) vice adds a task with start/end + Drive link
await login('vice');
ok('vice: approve checkbox hidden', (w.eval("openTaskModal()"), $('task-evidence-approve-group').classList.contains('hidden')));
ok('vice: timezone hint shown', /توقيت جهازك/.test($('task-tz-hint').textContent), $('task-tz-hint').textContent);
ok('vice: no per-teacher account assignment field', !$('task-assignee'));
setVal('task-name', 'اجتماع أولياء الأمور');
setVal('task-resp', 'أ. نورة');
setVal('task-start', '2026-10-05T08:00');
setVal('task-end', '2026-10-05T10:30');
setVal('task-evidence-url', 'https://drive.google.com/file/d/1AbC/view?usp=sharing');
setVal('task-evidence-title', 'محضر الاجتماع');
await w.eval('saveTask()');
let row = await dbTask('اجتماع أولياء الأمور');
const expStart = new Date('2026-10-05T08:00').toISOString();
const expEnd = new Date('2026-10-05T10:30').toISOString();
ok('add: row saved in DB', !!row, toast());
ok('add: start_at = local input converted to UTC', row && new Date(row.start_at).toISOString() === expStart, `${row?.start_at} vs ${expStart}`);
ok('add: end_at = local input converted to UTC', row && new Date(row.end_at).toISOString() === expEnd, `${row?.end_at} vs ${expEnd}`);
if (TZ === 'Asia/Riyadh') ok('add: Riyadh 08:00 stored as 05:00Z', expStart === '2026-10-05T05:00:00.000Z', expStart);
if (TZ === 'America/New_York') ok('add: New York 08:00 stored as 12:00Z', expStart === '2026-10-05T12:00:00.000Z', expStart);
ok('add: due_date synced to local end date', row?.due_date === '2026-10-05', row?.due_date);
ok('add: Drive link + title saved, not approved', row?.evidence_drive_url === 'https://drive.google.com/file/d/1AbC/view?usp=sharing' && row?.evidence_title === 'محضر الاجتماع' && row?.evidence_approved === false);
ok('add: evidence_added_by = vice (server-side)', row?.evidence_added_by === U.vice);
ok('add: «المسؤولة» saved as display text', row?.resp === 'أ. نورة' && !('assignee_id' in row), JSON.stringify(row));

// card rendering
w.eval('renderTasks()');
let card = [...$('tasks-grid').querySelectorAll('.task-card')].find(c => c.textContent.includes('اجتماع أولياء الأمور'));
const a = card?.querySelector('a');
ok('card: shows start & end in local time', card && card.textContent.includes('يبدأ') && card.textContent.includes('ينتهي'), card?.textContent);
ok('card: link is https Drive, target=_blank, rel=noopener noreferrer',
  a && a.href.startsWith('https://drive.google.com/') && a.target === '_blank' && a.rel === 'noopener noreferrer', a?.outerHTML);
ok('card: link label = evidence title', a?.textContent === 'محضر الاجتماع');
ok('card: pending-review badge', card?.textContent.includes('قيد المراجعة'));

// 2) validation (no DB writes)
const countBefore = (await db.query('SELECT count(*)::int c FROM public.tasks')).rows[0].c;
async function attempt(fields) {
  w.eval('openTaskModal()');
  setVal('task-name', 'اختبار تحقق');
  setVal('task-start', '2026-10-06T09:00'); setVal('task-end', '2026-10-06T10:00');
  for (const [k, v] of Object.entries(fields)) setVal(k, v);
  await w.eval('saveTask()');
  return toast();
}
ok('validate: end before start', /بعد وقت البداية/.test(await attempt({ 'task-end': '2026-10-06T08:00' })), toast());
ok('validate: end equal to start', /بعد وقت البداية/.test(await attempt({ 'task-end': '2026-10-06T09:00' })), toast());
ok('validate: missing times', /البداية والنهاية/.test(await attempt({ 'task-start': '' })), toast());
for (const bad of ['https://evil.example/x', 'http://drive.google.com/x', 'javascript:alert(1)', 'https://drive.google.com.evil.io/x', 'https://user:pw@drive.google.com/x']) {
  ok(`validate: reject URL ${bad}`, /Google Drive/.test(await attempt({ 'task-evidence-url': bad })), toast());
}
ok('validate: title without link', /قبل تسمية/.test(await attempt({ 'task-evidence-title': 'بدون رابط' })), toast());
ok('validate: nothing written by rejected attempts', (await db.query('SELECT count(*)::int c FROM public.tasks')).rows[0].c === countBefore);

// 3) edit times
const t1 = tasks().find(t => t.name === 'اجتماع أولياء الأمور');
w.eval(`openTaskModal('${t1.id}')`);
ok('edit: start prefilled in local time', $('task-start').value === '2026-10-05T08:00', $('task-start').value);
ok('edit: end prefilled in local time', $('task-end').value === '2026-10-05T10:30', $('task-end').value);
ok('edit: Drive link prefilled', $('task-evidence-url').value.startsWith('https://drive.google.com/'));
setVal('task-start', '2026-10-07T13:15');
setVal('task-end', '2026-10-08T09:00');
await w.eval('saveTask()');
row = await dbTask('اجتماع أولياء الأمور');
ok('edit: new start saved', new Date(row.start_at).toISOString() === new Date('2026-10-07T13:15').toISOString(), row.start_at);
ok('edit: new end saved', new Date(row.end_at).toISOString() === new Date('2026-10-08T09:00').toISOString(), row.end_at);
ok('edit: due_date follows new end', row.due_date === '2026-10-08', row.due_date);

// 4) XSS in evidence title is escaped
w.eval(`openTaskModal('${t1.id}')`);
setVal('task-evidence-title', '<img src=x onerror="window.__xss=1">');
await w.eval('saveTask()');
w.eval('renderTasks()');
card = [...$('tasks-grid').querySelectorAll('.task-card')].find(c => c.textContent.includes('اجتماع أولياء الأمور'));
ok('xss: title rendered as text, no <img> injected', card && !card.querySelector('img') && card.textContent.includes('<img'), card?.innerHTML);
ok('xss: no script executed', w.__xss === undefined);

// 5) admin approves via modal; vice then sees locked evidence
await login('admin');
w.eval(`openTaskModal('${t1.id}')`);
ok('admin: approve checkbox visible', !$('task-evidence-approve-group').classList.contains('hidden'));
$('task-evidence-approved').checked = true;
await w.eval('saveTask()');
row = await dbTask('اجتماع أولياء الأمور');
ok('admin: evidence approved in DB with approver', row.evidence_approved === true && row.evidence_approved_by === U.admin, toast());

await login('vice');
w.eval(`openTaskModal('${t1.id}')`);
ok('vice: approved evidence inputs disabled + lock hint', $('task-evidence-url').disabled && !$('task-evidence-lock-hint').classList.contains('hidden'));
$('task-status').value = 'done';
await w.eval('saveTask()');
row = await dbTask('اجتماع أولياء الأمور');
ok('vice: can still save other fields on approved task', row.status === 'done' && row.evidence_approved === true, toast());
w.eval('renderTasks()');
ok('card: approved badge', $('tasks-grid').textContent.includes('معتمد'));

// 6) backend is the barrier: bypass the UI
const bypass = await w.eval(`sbUpdateTask({ ...tasksCache.find(t => t.id === '${t1.id}'), evidence_url: 'https://docs.google.com/x' })`
  + `.then(() => 'saved', e => arabicDbError(e))`);
ok('bypass: vice direct update of approved link rejected by DB', /ألغِ الاعتماد/.test(bypass), bypass);
const forged = await w.eval(`sb.from('tasks').update({ evidence_approved: false }).eq('id', '${t1.id}').select().single()`
  + `.then(r => r.error ? r.error.message : 'saved')`);
ok('bypass: vice cannot revoke approval via API', /فقط القائدة/.test(forged), forged);
const forged2 = await w.eval(`sb.from('tasks').update({ evidence_approved: true }).eq('name', 'مهمة قديمة 2').select().single()`
  + `.then(r => r.error ? r.error.message : 'saved')`);
ok('bypass: vice cannot approve via API', forged2 !== 'saved', forged2);

// 7) legacy task edit without times
const legacy = tasks().find(t => t.name === 'مهمة قديمة 1');
w.eval(`openTaskModal('${legacy.id}')`);
ok('legacy: hint shows previous due date', !$('task-legacy-due-hint').classList.contains('hidden'), $('task-legacy-due-hint').textContent);
ok('legacy: time inputs empty (no fabricated values)', $('task-start').value === '' && $('task-end').value === '');
setVal('task-notes', 'تحديث ملاحظة');
await w.eval('saveTask()');
row = await dbTask('مهمة قديمة 1');
ok('legacy: saved without times, due_date unchanged', row.notes === 'تحديث ملاحظة' && row.start_at === null && row.due_date === '2026-09-10', JSON.stringify(row));

// 8) shared teacher account: sees active-year tasks with «المسؤولة», attaches Drive evidence, nothing else
await login('admin');
w.eval('openTaskModal()');
setVal('task-name', 'تنفيذ الإذاعة');
setVal('task-resp', 'أ. هند');
setVal('task-start', '2026-10-10T07:00'); setVal('task-end', '2026-10-10T08:00');
await w.eval('saveTask()');
const t2 = await dbTask('تنفيذ الإذاعة');
ok('admin: task created with «المسؤولة» only', t2?.resp === 'أ. هند', toast());
await db.exec(`INSERT INTO public.tasks (name, resp, school_year_id, start_at, end_at)
  VALUES ('مهمة سنة مؤرشفة','أ. هند','${Y_ARCH}','2025-10-01T05:00:00Z','2025-10-01T06:00:00Z')`);
const archivedId = (await dbTask('مهمة سنة مؤرشفة')).id;
const activeCount = (await db.query(`SELECT count(*)::int c FROM public.tasks WHERE school_year_id = $1`, [Y_ACTIVE])).rows[0].c;

await login('teacher');
ok('shared account: tasks section allowed in nav', w.eval(`isSectionAllowed('tasks')`) === true);
ok(`shared account: loads all ${activeCount} active-year tasks, no archived-year task (RLS)`,
  tasks().length === activeCount && !tasks().some(t => t.id === archivedId), JSON.stringify(tasks().map(t => t.name)));
w.eval('renderTasks()');
const cards = [...$('tasks-grid').querySelectorAll('.task-card')];
const tCard = cards.find(c => c.textContent.includes('تنفيذ الإذاعة'));
const tCardApproved = cards.find(c => c.textContent.includes('اجتماع أولياء الأمور'));
const tCardLegacy = cards.find(c => c.textContent.includes('مهمة قديمة 2'));
ok('shared account: cards show «المسؤولة» of each task', tCard?.textContent.includes('أ. هند') && tCardApproved?.textContent.includes('أ. نورة'));
ok('shared account card: attach-evidence button, no edit/delete/status controls',
  tCard && /إرفاق شاهد/.test(tCard.textContent) && !tCard.querySelector('.btn-delete') && !tCard.querySelector('select')
  && ![...tCard.querySelectorAll('button')].some(b => (b.getAttribute('onclick') || '').includes('openTaskModal')), tCard?.innerHTML);
ok('shared account card: attach button also on legacy task', tCardLegacy && /إرفاق شاهد/.test(tCardLegacy.textContent));
ok('shared account card: no attach button on approved evidence', tCardApproved && !/إرفاق شاهد|تعديل الشاهد/.test(tCardApproved.textContent));
w.eval('openTaskModal()');
ok('shared account: UI blocks add', /ليس لديك صلاحية/.test(toast()), toast());

w.eval(`openTaskEvidenceModal('${t2.id}')`);
ok('shared account: evidence modal opens and shows task + «المسؤولة»',
  !$('task-evidence-modal').classList.contains('hidden') && /تنفيذ الإذاعة/.test($('task-ev-task-name').textContent) && /أ\. هند/.test($('task-ev-task-name').textContent));
setVal('task-ev-url', 'https://evil.example/x');
await w.eval('saveTaskEvidence()');
ok('shared account: non-Drive URL rejected in UI', /Google Drive/.test(toast()), toast());
setVal('task-ev-url', 'https://drive.google.com/drive/folders/XYZ');
setVal('task-ev-title', 'صور الإذاعة');
await w.eval('saveTaskEvidence()');
row = await dbTask('تنفيذ الإذاعة');
ok('shared account: Drive evidence saved, stamped with shared account id, pending approval',
  row.evidence_drive_url === 'https://drive.google.com/drive/folders/XYZ' && row.evidence_title === 'صور الإذاعة'
  && row.evidence_added_by === U.teacher && row.evidence_approved === false, toast() + JSON.stringify(row));
ok('shared account: task fields and «المسؤولة» untouched', row.name === 'تنفيذ الإذاعة' && row.status === 'pending' && row.resp === 'أ. هند');

const legacy2 = tasks().find(t => t.name === 'مهمة قديمة 2');
w.eval(`openTaskEvidenceModal('${legacy2.id}')`);
setVal('task-ev-url', 'https://docs.google.com/document/d/legacy');
await w.eval('saveTaskEvidence()');
row = await dbTask('مهمة قديمة 2');
ok('shared account: evidence attached to a legacy task', row.evidence_drive_url === 'https://docs.google.com/document/d/legacy' && row.start_at === null, toast());

const tIns = await w.eval(`sbInsertTask({ name: 'x', resp: '', due: '', priority: 'low', status: 'pending', notes: '',
  start_at: '2026-10-01T05:00:00Z', end_at: '2026-10-01T06:00:00Z', evidence_url: '', evidence_title: '' })
  .then(() => 'saved', e => arabicDbError(e))`);
ok('shared account: direct API insert rejected by RLS', tIns !== 'saved', tIns);
const tUpd = await w.eval(`sbUpdateTask({ ...tasksCache.find(t => t.id === '${t2.id}'), status: 'done' })
  .then(() => 'saved', e => arabicDbError(e))`);
ok('shared account: direct API task edit (status) rejected by DB', tUpd !== 'saved', tUpd);
const tDel = await w.eval(`sbDeleteTask('${t2.id}').then(() => 'called', e => arabicDbError(e))`);
ok('shared account: direct API delete removes nothing', (await dbTask('تنفيذ الإذاعة')) !== undefined, tDel);
const tAppr = await w.eval(`sb.from('tasks').update({ evidence_approved: true }).eq('id', '${t2.id}').select().single()
  .then(r => r.error ? r.error.message : 'saved')`);
ok('shared account: cannot approve via API', tAppr !== 'saved', tAppr);
const tLocked = await w.eval(`sbUpdateTaskEvidence('${t1.id}', 'https://drive.google.com/new', '')
  .then(() => 'saved', e => arabicDbError(e))`);
ok('shared account: cannot change approved evidence via API', tLocked !== 'saved', tLocked);
const tArch = await w.eval(`sbUpdateTaskEvidence('${archivedId}', 'https://drive.google.com/arch', '')
  .then(() => 'saved', e => arabicDbError(e))`);
ok('shared account: cannot attach evidence to archived-year task via API', tArch !== 'saved' && (await dbTask('مهمة سنة مؤرشفة')).evidence_drive_url === null, tArch);
row = await dbTask('اجتماع أولياء الأمور');
ok('shared account: approved evidence unchanged in DB', row.evidence_approved === true && row.evidence_drive_url.startsWith('https://drive.google.com/file/d/1AbC'));

await login('vice');
w.eval('renderTasks()');
ok('vice: sees shared-account evidence pending review on card', [...$('tasks-grid').querySelectorAll('.task-card')]
  .some(c => c.textContent.includes('تنفيذ الإذاعة') && c.textContent.includes('صور الإذاعة') && c.textContent.includes('قيد المراجعة')));
await login('admin');
w.eval(`openTaskModal('${t2.id}')`);
$('task-evidence-approved').checked = true;
await w.eval('saveTask()');
row = await dbTask('تنفيذ الإذاعة');
ok('admin: approves shared-account evidence; «المسؤولة» unchanged', row.evidence_approved === true && row.evidence_approved_by === U.admin && row.resp === 'أ. هند', toast());

// 8b) throttled login message
ok('login: 429 classified as throttled', w.eval(`classifyUsernameLoginFailure({ payload: { error: 'too_many_attempts', retry_after: 600 }, error: { context: { status: 429 } }, caught: null })`) === 'throttled');
w.eval(`showLoginFailure('throttled', 600)`);
ok('login: throttled message shows wait minutes', /محاولات دخول كثيرة/.test(w.document.body.textContent) && /10 دقيقة/.test(w.document.body.textContent));

// 9) password recovery rule aligned with admin-users
ok('recovery: weak password rejected', w.eval(`isStrongPassword('abcdef')`) === false && w.eval(`isStrongPassword('12345678')`) === false);
ok('recovery: strong password accepted', w.eval(`isStrongPassword('Abcd1234')`) === true);

console.log(`\nRESULT (TZ=${TZ}): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
