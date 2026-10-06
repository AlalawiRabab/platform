/**
 * Real index.html + script.js in jsdom, backed by PGlite with the live schema/policies
 * and the new migration. No network, no production access.
 */
import { PGlite } from '@electric-sql/pglite';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { REPO, U, Y_ACTIVE, buildBaseline, applyMigration } from './sql-test.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

const db = new PGlite();
await buildBaseline(db);
await applyMigration(db);

const R = {
  first:  '30000000-0000-0000-0000-000000000001',
  second: '30000000-0000-0000-0000-000000000002',
  other:  '30000000-0000-0000-0000-000000000003',
};
await db.exec(`
INSERT INTO public.programs (id, name, resp, school_year_id) VALUES (1, 'برنامج القيم', 'أ. رباب', '${Y_ACTIVE}');
INSERT INTO public.program_indicators (id, program_id, indicator_text) VALUES
  (10, 1, 'مؤشر أول'), (11, 1, 'مؤشر ثانٍ'), (12, 1, 'مؤشر فارغ'), (13, 1, 'مؤشر فارغ للمعلمات');
INSERT INTO public.evidence_requirements (id, indicator_id, name, sort_order) VALUES
  ('${R.first}', 10, 'تقارير', 1), ('${R.second}', 10, 'تقارير', 2), ('${R.other}', 11, 'تقارير', 1);
`);

const TABLES = ['programs', 'program_indicators', 'evidence_requirements', 'evidences'];
const COLTYPE = {};
for (const r of (await db.query(`SELECT table_name, column_name, udt_name FROM information_schema.columns
  WHERE table_schema='public' AND table_name = ANY($1)`, [TABLES])).rows) {
  (COLTYPE[r.table_name] ||= {})[r.column_name] = r.udt_name;
}

let currentRole = 'teacher';
async function runAs(sql, params) {
  await db.exec('RESET ROLE');
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [U[currentRole] || '']);
  await db.exec('SET ROLE authenticated');
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}

const YEAR_ROW = { id: Y_ACTIVE, name: '1447', label_ar: '1447', status: 'active', is_active: true,
  is_archived: false, start_date: '2025-08-01', end_date: '2026-12-31', notes: null, hijri_year: '1447', created_at: '2025-01-01' };

class Q {
  constructor(table) { this.table = table; this.op = 'select'; this.filters = []; this.one = false; }
  select() { return this; }
  insert(p) { this.op = 'insert'; this.payload = p; return this; }
  update(p) { this.op = 'update'; this.payload = p; return this; }
  upsert() { this.op = 'noop'; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(k, v) { this.filters.push([k, v]); return this; }
  order() { return this; } limit() { return this; } range() { return this; } in() { return this; }
  single() { this.one = true; return this; }
  maybeSingle() { this.one = true; this.maybe = true; return this; }
  then(res, rej) { return this.exec().then(res, rej); }
  async exec() {
    if (this.table === 'school_years') return { data: this.one ? YEAR_ROW : [YEAR_ROW], error: null };
    if (!TABLES.includes(this.table)) return { data: this.one ? null : [], error: null };
    const T = COLTYPE[this.table];
    const params = []; const p = (v, col) => { params.push(v); return `$${params.length}::${T[col] || 'text'}`; };
    const where = this.filters.length ? ' WHERE ' + this.filters.map(([k, v]) => `${k} = ${p(v, k)}`).join(' AND ') : '';
    let sql;
    if (this.op === 'select') sql = `SELECT row_to_json(t) j FROM public.${this.table} t${where} ORDER BY t.id`;
    else if (this.op === 'insert') {
      const cols = Object.keys(this.payload);
      sql = `WITH r AS (INSERT INTO public.${this.table} (${cols.join(',')}) VALUES (${cols.map(c => p(this.payload[c], c)).join(',')}) RETURNING *) SELECT row_to_json(r) j FROM r`;
    } else if (this.op === 'update') {
      const sets = Object.keys(this.payload).map(c => `${c} = ${p(this.payload[c], c)}`).join(', ');
      sql = `WITH r AS (UPDATE public.${this.table} SET ${sets}${where} RETURNING *) SELECT row_to_json(r) j FROM r`;
    } else if (this.op === 'delete') sql = `WITH r AS (DELETE FROM public.${this.table}${where} RETURNING *) SELECT row_to_json(r) j FROM r`;
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

const html = readFileSync(`${REPO}/index.html`, 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) console.log('  [jsdom]', e.message); });
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/index.html', virtualConsole: vc, pretendToBeVisual: true });
const w = dom.window;
w.supabaseClient = mockClient;
const dialogs = { confirm: [], alert: [] };
w.confirm = (m) => { dialogs.confirm.push(m); return true; };
w.alert = (m) => { dialogs.alert.push(m); };
w.console.info = () => {};
const s = w.document.createElement('script');
s.textContent = readFileSync(`${REPO}/script.js`, 'utf8');
w.document.body.appendChild(s);
await new Promise(r => setTimeout(r, 50));

const $ = id => w.document.getElementById(id);
const toast = () => $('toast')?.textContent || '';
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];

/** Simulates a full page reload + login: wipes every in-memory cache, then refetches from the DB. */
async function freshLogin(role) {
  currentRole = role;
  const names = { admin: 'القائدة', vice: 'الوكيلة', teacher: 'حساب المعلمات' };
  w.eval(`currentUser = { id: '${U[role]}', name: '${names[role]}', role: '${role}', email: '' };
    programsCache = []; indicatorsCache = {}; evidencesCache = []; evidenceRequirementsCache = [];
    schoolYearsCache = []; selectedSchoolYearId = '${Y_ACTIVE}'; activeSchoolYearId = '${Y_ACTIVE}';`);
  await w.eval('fetchSchoolYears()');
  w.eval(`selectedSchoolYearId = '${Y_ACTIVE}'`);
  await w.eval('(async () => { await fetchEvidenceRequirements(); await fetchPrograms(); await fetchEvidences(); await fetchIndicators(); syncEvidencesToPrograms(); })()');
}
const openDetail = () => { w.eval(`viewProgramDetail(1)`); return $('program-detail-body'); };
const reqRow = (body, id) => body.querySelector(`.req-row[data-req-id="${id}"]`);

async function addAttachments(reqId, indId, links, notes) {
  w.eval(`openEvidenceModalForRequirement('1','${indId}','${reqId}')`);
  $('ev-links').value = links.join('\n');
  $('ev-notes').value = notes;
  await w.eval('saveEvidence()');
}

console.log('\n== Notes: saved on the right evidence (by id), not by name ==');
await freshLogin('teacher');
openDetail();
await addAttachments(R.second, 10, ['https://drive.google.com/file/d/second/view'], 'ملاحظة على المرفق الثاني');
{
  const row = await one(`SELECT requirement_id, indicator_id, notes FROM public.evidences WHERE link LIKE '%second%'`);
  ok('note stored with the clicked evidence id (second of two «تقارير»)', row?.requirement_id === R.second && row.notes === 'ملاحظة على المرفق الثاني', JSON.stringify(row));
  const body = $('program-detail-body');
  ok('detail refreshed right after save: note shown under the second «تقارير»',
    reqRow(body, R.second)?.querySelector('.req-attachment-note')?.textContent.includes('ملاحظة على المرفق الثاني'));
  ok('note not shown under the first «تقارير» (same name, same indicator)', !reqRow(body, R.first)?.textContent.includes('ملاحظة على المرفق الثاني'));
  ok('note not shown under «تقارير» of another indicator', !reqRow(body, R.other)?.textContent.includes('ملاحظة على المرفق الثاني'));
}

console.log('\n== Notes: one note for a batch of attachments = note on the evidence as a whole ==');
await addAttachments(R.first, 10, ['https://drive.google.com/file/d/b1/view', 'https://drive.google.com/file/d/b2/view'], 'ملاحظة للشاهد ككل');
{
  const body = $('program-detail-body');
  const row = reqRow(body, R.first);
  const reqNotes = row?.querySelectorAll('.req-notes .ev-note') || [];
  ok('shown once under the evidence name', reqNotes.length === 1 && reqNotes[0].textContent.includes('ملاحظة للشاهد ككل'), row?.innerHTML);
  ok('not repeated beside each attachment', !row?.querySelector('.req-attachment-note'));
  ok('both attachments listed', row?.querySelectorAll('.req-attachment-item').length === 2);
}

console.log('\n== Notes survive reload and re-login, visible to all authorized roles ==');
for (const role of ['admin', 'vice', 'teacher']) {
  await freshLogin(role);
  const body = openDetail();
  ok(`${role}: attachment note still under the second «تقارير»`,
    reqRow(body, R.second)?.querySelector('.req-attachment-note')?.textContent.includes('ملاحظة على المرفق الثاني'));
  ok(`${role}: evidence note still under the first «تقارير»`,
    reqRow(body, R.first)?.querySelector('.req-notes')?.textContent.includes('ملاحظة للشاهد ككل'));
  ok(`${role}: no cross-over to the other «تقارير»`, !reqRow(body, R.other)?.textContent.includes('ملاحظة'));
}
w.eval('renderReports()');
ok('reports table shows the notes too', $('reports-tbody').textContent.includes('ملاحظة على المرفق الثاني')
  && $('reports-tbody').textContent.includes('ملاحظة للشاهد ككل'));
{
  await db.exec(`INSERT INTO public.evidences (title, program_id, indicator_id, link, notes, school_year_id, created_by)
    VALUES ('شاهد بلا اسم مطلوب', 1, 11, 'https://drive.google.com/x', 'ملاحظة شاهد عام', '${Y_ACTIVE}', '${U.vice}')`);
  await freshLogin('teacher');
  const body = openDetail();
  ok('note on evidence without a requirement shown under its indicator', body.querySelector('.orphan-evidences')?.textContent.includes('ملاحظة شاهد عام'));
  await db.exec(`DELETE FROM public.evidences WHERE title = 'شاهد بلا اسم مطلوب'`);
}

console.log('\n== Indicator delete: teacher ==');
await freshLogin('teacher');
w.eval('renderPrograms()');
ok('teacher: no «حذف المؤشر» on cards', !$('programs-grid').textContent.includes('حذف المؤشر'));
ok('teacher: no «حذف المؤشر» in details', !openDetail().textContent.includes('حذف المؤشر'));
await w.eval(`handleDelInd('1','13')`);
ok('teacher: handler refuses', toast().includes('ليس لديك صلاحية'), toast());
{
  const r = await mockClient.from('program_indicators').delete().eq('id', 13).select('id');
  ok('teacher: direct API delete request deletes 0 rows', !r.error && Array.isArray(r.data) && r.data.length === 0, JSON.stringify(r));
  ok('teacher: indicator still in DB', !!(await one(`SELECT 1 x FROM public.program_indicators WHERE id=13`)));
}

console.log('\n== Indicator delete: leader/vice ==');
await freshLogin('admin');
await w.eval(`handleToggleAttachmentApproval('1', (evidencesCache.find(e => e.requirement_id === '${R.second}') || {}).id)`);
await freshLogin('vice');
const progBefore = w.eval('calcProgramProgress(1)');
ok('setup: program progress with 4 indicators = round((50+0+0+0)/4) = 13', progBefore === 13, String(progBefore));
w.eval('renderPrograms()');
ok('vice: «حذف المؤشر» on cards', $('programs-grid').textContent.includes('حذف المؤشر'));
ok('vice: «حذف المؤشر» in details', openDetail().textContent.includes('حذف المؤشر'));

dialogs.confirm.length = 0;
await w.eval(`handleDelInd('1','12')`);
ok('confirmation shows the indicator name', dialogs.confirm.at(-1)?.includes('«مؤشر فارغ»'), dialogs.confirm.at(-1));
ok('unlinked indicator deleted from DB', !(await one(`SELECT 1 x FROM public.program_indicators WHERE id=12`)));
ok('removed from the list immediately', !w.eval(`(indicatorsCache[1] || []).some(i => String(i.id) === '12')`)
  && !$('irow-12') && !!$('irow-11') && !/onclick="handleDelInd\('1','12'\)"/.test($('program-detail-body').innerHTML));
const progAfter = w.eval('calcProgramProgress(1)');
ok('program progress recalculated immediately (50/3 = 17)', progAfter === 17, String(progAfter));
ok('program progress saved in DB', (await one(`SELECT progress FROM public.programs WHERE id=1`)).progress === 17);
ok('card shows new percentage', $('pcard-1')?.textContent.includes('17%'), $('pcard-1')?.textContent);

dialogs.alert.length = 0; dialogs.confirm.length = 0;
await w.eval(`handleDelInd('1','11')`);
ok('linked indicator: blocked with a clear reason (no confirm shown)', dialogs.confirm.length === 0
  && dialogs.alert.at(-1)?.includes('لا يمكن حذف المؤشر «مؤشر ثانٍ»') && dialogs.alert.at(-1).includes('1 شاهد مطلوب'), dialogs.alert.at(-1));
ok('linked indicator still in DB', !!(await one(`SELECT 1 x FROM public.program_indicators WHERE id=11`)));

w.eval(`evidenceRequirementsCache = evidenceRequirementsCache.filter(r => String(r.indicator_id) !== '10');
        evidencesCache = evidencesCache.filter(e => String(e.indicator_id) !== '10');`);
dialogs.alert.length = 0;
await w.eval(`handleDelInd('1','10')`);
ok('stale UI cache: DB trigger still refuses and the reason is shown', dialogs.alert.at(-1)?.includes('لا يمكن حذف المؤشر')
  && dialogs.alert.at(-1).includes('ملاحظة'), dialogs.alert.at(-1));
ok('indicator with notes and attachments intact in DB',
  (await one(`SELECT count(*)::int c FROM public.evidences WHERE indicator_id=10 AND notes IS NOT NULL`)).c === 3
  && (await one(`SELECT count(*)::int c FROM public.evidence_requirements WHERE indicator_id=10`)).c === 2);
ok('UI caches reloaded after refusal', w.eval(`evidenceRequirementsCache.filter(r => String(r.indicator_id) === '10').length`) === 2);

await freshLogin('admin');
await w.eval(`handleDelInd('1','13')`);
ok('leader deletes unlinked indicator', !(await one(`SELECT 1 x FROM public.program_indicators WHERE id=13`)), toast());

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
