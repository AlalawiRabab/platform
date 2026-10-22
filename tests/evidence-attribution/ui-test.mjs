/**
 * Real index.html + script.js in jsdom, backed by PGlite with live-like policies/ACLs
 * and both new migrations. No network, no production access.
 */
import { PGlite } from '@electric-sql/pglite';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { REPO, U, Y_ACTIVE } from '../indicators/sql-test.mjs';
import { buildAll } from './sql-test.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

const db = new PGlite();
await buildAll(db);
const R = { report: '50000000-0000-0000-0000-000000000001', photos: '50000000-0000-0000-0000-000000000002' };
const LEGACY_LINK = 'https://drive.google.com/file/d/LEGACY123/view?usp=sharing';
const LEGACY_FILE = `${U.teacher}/1700000000000-legacy.pdf`;
await db.exec(`
INSERT INTO public.programs (id, name, resp, school_year_id) VALUES (1, 'برنامج القراءة', 'أ. رباب', '${Y_ACTIVE}');
INSERT INTO public.program_indicators (id, program_id, indicator_text) VALUES (10, 1, 'مؤشر التنفيذ'), (11, 1, 'مؤشر المشاركة');
INSERT INTO public.evidence_requirements (id, indicator_id, name, sort_order) VALUES
  ('${R.report}', 10, 'تقرير التنفيذ', 1), ('${R.photos}', 11, 'صور النشاط', 1);
`);
// legacy rows: inserted as the table owner with the trigger off, exactly as old data looks on production
await db.exec(`
ALTER TABLE public.evidences DISABLE TRIGGER trg_validate_evidence_attribution;
INSERT INTO public.evidences (id, title, program_id, indicator_id, requirement_id, link, school_year_id, created_by, notes, type)
  VALUES (900, 'تقرير التنفيذ', 1, 10, '${R.report}', '${LEGACY_LINK}', '${Y_ACTIVE}', '${U.teacher}', 'ملاحظة قديمة', 'Google Drive');
INSERT INTO public.evidences (id, title, program_id, indicator_id, requirement_id, file_url, file_name, school_year_id, created_by, type)
  VALUES (901, 'صور النشاط', 1, 11, '${R.photos}', '${LEGACY_FILE}', 'legacy.pdf', '${Y_ACTIVE}', '${U.teacher}', 'PDF');
INSERT INTO public.evidences (id, title, program_id, link, school_year_id, created_by, type)
  VALUES (902, NULL, 1, 'https://drive.google.com/drive/folders/GENERAL', '${Y_ACTIVE}', '${U.vice}', 'Google Drive');
ALTER TABLE public.evidences ENABLE TRIGGER trg_validate_evidence_attribution;
SELECT setval(pg_get_serial_sequence('public.evidences', 'id'), 1000);
`);
const legacySnap = async () => JSON.stringify((await db.query(
  `SELECT id, title, link, file_url, file_name, person, notes FROM public.evidences WHERE id BETWEEN 900 AND 999 ORDER BY id`)).rows);
const legacyBefore = await legacySnap();

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
const storageOps = { uploads: [], signed: [] };
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
  storage: { from: bucket => ({
    createSignedUrl: async (path, ttl) => { storageOps.signed.push({ bucket, path, ttl }); return { data: { signedUrl: `https://project.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=t` }, error: null }; },
    upload: async (path) => { storageOps.uploads.push({ bucket, path }); return { error: null }; },
    remove: async () => ({ error: null }),
  }) },
  functions: { invoke: async () => ({ data: null, error: null }) },
};

const html = readFileSync(`${REPO}/index.html`, 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const consoleErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) consoleErrors.push(String(e.message)); });
vc.on('error', (...a) => consoleErrors.push(a.map(String).join(' ')));
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://alalawirabab.github.io/platform/', virtualConsole: vc, pretendToBeVisual: true });
const w = dom.window;
w.supabaseClient = mockClient;
const opened = [];
w.open = (url, target, features) => { opened.push({ url, target, features }); return null; };
w.confirm = () => true;
w.alert = () => {};
w.console.info = () => {};
w.Element.prototype.scrollIntoView = function (opts) { w.__scrolled = { id: this.id, opts }; };
const s = w.document.createElement('script');
s.textContent = readFileSync(`${REPO}/script.js`, 'utf8');
w.document.body.appendChild(s);
await new Promise(r => setTimeout(r, 50));

const $ = id => w.document.getElementById(id);
const toast = () => $('toast')?.textContent || '';
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const evCount = async () => (await one(`SELECT count(*)::int c FROM public.evidences`)).c;

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
const reqRow = id => $('program-detail-body').querySelector(`.req-row[data-req-id="${id}"]`);
function fillForRequirement(reqId, indId, { person, links = [], notes = '' }) {
  w.eval(`openEvidenceModalForRequirement('1','${indId}','${reqId}')`);
  $('ev-link-rows').replaceChildren();
  links.forEach(l => w.addEvidenceLinkRow(l.name, l.url));
  if (!links.length) w.addEvidenceLinkRow();
  $('ev-person').value = person;
  $('ev-notes').value = notes;
}

console.log('\n== 1–2. Teacher name is required for new evidence ==');
await freshLogin('teacher');
openDetail();
const NEW_URL = 'https://drive.google.com/file/d/1NewReport_ABC/view?usp=drive_link';
let before = await evCount();
fillForRequirement(R.report, 10, { person: '   ', links: [{ name: 'تقرير تنفيذ البرنامج', url: NEW_URL }] });
await w.eval('saveEvidence()');
ok('blank name: nothing saved', await evCount() === before);
ok('blank name: Arabic message', toast() === 'يرجى كتابة اسم المعلمة المسؤولة عن الشاهد', toast());
ok('blank name: inline error + aria-invalid', $('ev-person-error').textContent === 'يرجى كتابة اسم المعلمة المسؤولة عن الشاهد'
  && !$('ev-person-error').classList.contains('hidden') && $('ev-person').getAttribute('aria-invalid') === 'true');
ok('modal stays open for correction', !$('evidence-modal').classList.contains('hidden'));

$('ev-person').value = 'أ';
await w.eval('saveEvidence()');
ok('1-char name refused', await evCount() === before && toast().includes('بين 2 و100'), toast());

fillForRequirement(R.report, 10, { person: 'أ. سارة', links: [{ name: '', url: NEW_URL }] });
await w.eval('saveEvidence()');
ok('link without display name refused in UI', await evCount() === before && toast() === 'يرجى كتابة اسم الملف أو الشاهد لكل رابط', toast());
fillForRequirement(R.report, 10, { person: 'أ. سارة', links: [{ name: 'ملف', url: 'javascript:alert(1)' }] });
await w.eval('saveEvidence()');
ok('javascript: link refused in UI', await evCount() === before && toast().includes('https://'), toast());
fillForRequirement(R.report, 10, { person: 'أ. سارة', links: [{ name: 'ملف', url: 'http://drive.google.com/file/d/x/view' }] });
await w.eval('saveEvidence()');
ok('http: link refused in UI', await evCount() === before && toast().includes('https://'), toast());

fillForRequirement(R.report, 10, { person: '  أ.  سارة   العتيبي ', links: [{ name: 'تقرير تنفيذ البرنامج', url: NEW_URL }], notes: 'ملاحظة جديدة' });
await w.eval('saveEvidence()');
const saved = await one(`SELECT id, person, file_name, link, notes, is_approved FROM public.evidences WHERE link = $1`, [NEW_URL]);
ok('with name: saved once', await evCount() === before + 1 && !!saved, toast());
ok('teacher name stored (normalised)', saved?.person === 'أ. سارة العتيبي', saved?.person);
ok('display name stored separately', saved?.file_name === 'تقرير تنفيذ البرنامج', saved?.file_name);

console.log('\n== 3–4. Drive link shows its name, URL kept as-is ==');
ok('original Drive URL unchanged in DB', saved?.link === NEW_URL, saved?.link);
{
  const item = $(`evidence-${saved.id}`);
  ok('attachment card has stable id evidence-{id}', !!item && item.classList.contains('req-attachment-item'));
  ok('card shows the written name', item?.querySelector('.req-attachment-name')?.textContent === 'تقرير تنفيذ البرنامج');
  ok('URL text not shown in the card', !item?.textContent.includes('drive.google.com'), item?.textContent);
  const a = item?.querySelector('a.evidence-view-btn');
  ok('open button is a link to the original URL', a?.getAttribute('href') === NEW_URL, a?.outerHTML);
  ok('opens in a new tab with noopener noreferrer', a?.getAttribute('target') === '_blank' && a?.getAttribute('rel') === 'noopener noreferrer');
  ok('teacher name visible on the card', item?.querySelector('.ev-teacher')?.textContent.includes('أ. سارة العتيبي'));
}

console.log('\n== 5–6. Clicking an evidence name jumps inside the program; open button is separate ==');
{
  const body = $('program-detail-body');
  const box = $('indicator-section-10');
  box.open = false;
  const jump = body.querySelector(`.evidence-jump[data-evidence-target="evidence-req-${R.report}"]`);
  ok('evidence index lists the requirement name as a button', !!jump && jump.tagName === 'BUTTON' && jump.textContent.includes('تقرير التنفيذ'));
  opened.length = 0;
  jump.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const target = $(`evidence-req-${R.report}`);
  ok('collapsed indicator section opened', box.open === true);
  ok('scrolled smoothly to the evidence in this program', w.__scrolled?.id === `evidence-req-${R.report}` && w.__scrolled?.opts?.behavior === 'smooth', JSON.stringify(w.__scrolled));
  ok('evidence highlighted', target.classList.contains('evidence-highlight'));
  ok('hash updated without leaving the page', w.location.hash === `#evidence-req-${R.report}` && w.location.pathname === '/platform/', w.location.href);
  ok('clicking the name opened no external link', opened.length === 0);
  ok('name button has no href / onclick to Drive', !jump.getAttribute('href') && !jump.getAttribute('onclick'));

  const general = $('evidence-general-section');
  general.open = false;
  body.querySelector('.evidence-jump[data-evidence-target="evidence-902"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  ok('general evidence: jumps into «شواهد عامة للبرنامج» (opened)', general.open === true && w.__scrolled?.id === 'evidence-902');

  const fileBtn = $('evidence-901').querySelector('button.evidence-view-btn');
  fileBtn.click();
  await new Promise(r => setTimeout(r, 20));
  ok('old file opens through a signed URL of the same stored path', storageOps.signed.at(-1)?.path === LEGACY_FILE && storageOps.signed.at(-1)?.bucket === 'evidences');
  ok('signed URL opened in a new tab with noopener', opened.at(-1)?.url.includes('/object/sign/evidences/') && opened.at(-1)?.features === 'noopener,noreferrer', JSON.stringify(opened.at(-1)));
  ok('unknown target id rejected', w.eval(`jumpToEvidence('evidence-<img>')`) === false && w.eval(`jumpToEvidence('program-1')`) === false);
  w.eval(`closeModal('program-detail-modal')`);
  ok('closing the details clears the evidence hash', w.location.hash === '');
}

console.log('\n== 7–8. Legacy evidence keeps working ==');
{
  const body = openDetail();
  const legacy = $('evidence-900');
  ok('legacy link without display name falls back to the evidence name', legacy?.querySelector('.req-attachment-name')?.textContent === 'تقرير التنفيذ');
  ok('legacy row shows «غير محدد» for the teacher', legacy?.querySelector('.ev-teacher')?.textContent.includes('غير محدد'));
  ok('legacy link still opens its original URL', legacy?.querySelector('a.evidence-view-btn')?.getAttribute('href') === LEGACY_LINK);
  ok('legacy note still shown', legacy?.textContent.includes('ملاحظة قديمة'));
  const gen = $('evidence-902');
  ok('legacy link with no name at all shows «فتح الشاهد»', gen?.querySelector('.ev-det-title')?.textContent === 'فتح الشاهد', gen?.outerHTML);
  ok('legacy file shows its file name', $('evidence-901')?.querySelector('.req-attachment-name')?.textContent === 'legacy.pdf');
  ok('legacy rows unchanged in DB', legacyBefore === await legacySnap());
  ok('detail shows no raw URL text anywhere', !body.textContent.includes('drive.google.com'));
}

console.log('\n== 9–11. Multiple attachments, notes, approval, leader sees teacher name ==');
{
  fillForRequirement(R.report, 10, { person: 'أ. هند', links: [
    { name: 'محضر الاجتماع', url: 'https://drive.google.com/file/d/M1/view' },
    { name: 'كشف الحضور', url: 'https://docs.google.com/spreadsheets/d/K2/edit' },
  ], notes: 'دفعة واحدة' });
  w.eval(`pendingEvidenceFiles = [new File(['x'], 'خطة.pdf', { type: 'application/pdf', lastModified: 5 })]`);
  await w.eval('saveEvidence()');
  const rows = (await db.query(`SELECT person, file_name, file_url, link FROM public.evidences WHERE person = 'أ. هند' ORDER BY id`)).rows;
  ok('3 attachments saved in one go (2 links + 1 file)', rows.length === 3, JSON.stringify(rows));
  ok('uploaded file kept its own name + storage path under the user folder', rows.some(r => r.file_name === 'خطة.pdf' && r.file_url?.startsWith(`${U.teacher}/`)));
  ok('each link saved with its own display name', rows.filter(r => r.link).map(r => r.file_name).sort().join('،') === ['كشف الحضور', 'محضر الاجتماع'].sort().join('،'));
  const row = reqRow(R.report);
  ok('shared note shown once on the evidence', row?.querySelectorAll('.req-notes .ev-note').length === 1 && row.textContent.includes('دفعة واحدة'));
  ok('teacher: no approve buttons', !row?.innerHTML.includes('handleToggleAttachmentApproval'));
  const target = (await one(`SELECT id FROM public.evidences WHERE file_name = 'محضر الاجتماع'`)).id;
  await w.eval(`handleToggleAttachmentApproval('1', '${target}')`);
  ok('teacher cannot approve (handler refuses, DB unchanged)', (await one(`SELECT is_approved FROM public.evidences WHERE id = $1`, [target])).is_approved === false && toast().includes('فقط القائدة'));
  const r = await mockClient.from('evidences').update({ is_approved: true }).eq('id', target).select('*');
  ok('teacher direct API approval updates 0 rows', !r.error && r.data.length === 0, JSON.stringify(r));

  await freshLogin('admin');
  openDetail();
  const adminItem = $(`evidence-${target}`);
  ok('leader sees the teacher name', adminItem?.querySelector('.ev-teacher')?.textContent.includes('أ. هند'));
  ok('leader sees approve button', !!adminItem?.querySelector('.req-approve-btn'));
  await w.eval(`handleToggleAttachmentApproval('1', '${target}')`);
  ok('leader approval works', (await one(`SELECT is_approved FROM public.evidences WHERE id = $1`, [target])).is_approved === true, toast());
  await w.eval(`handleToggleAttachmentApproval('1', '900')`);
  ok('leader approves a legacy attachment without teacher name', (await one(`SELECT is_approved FROM public.evidences WHERE id = 900`)).is_approved === true, toast());
  await w.eval(`handleToggleAttachmentApproval('1', '900')`);
  ok('leader un-approves it again', (await one(`SELECT is_approved FROM public.evidences WHERE id = 900`)).is_approved === false, toast());
  ok('legacy content still unchanged after approval cycle', legacyBefore === await legacySnap());
}

console.log('\n== Reports modal: same rules ==');
{
  await freshLogin('teacher');
  w.eval('openReportModal()');
  ok('teacher name not prefilled with the shared account name', $('rep-person').value === '');
  $('rep-title').value = 'تقرير ختامي';
  $('rep-program-id').value = '1';
  w.eval(`fillReportIndicators('1')`);
  $('rep-indicator-id').value = '10';
  w.document.querySelector('input[name="rep-source"][value="drive"]').checked = true;
  w.eval(`toggleEvidenceSource('rep')`);
  $('rep-link').value = 'https://drive.google.com/file/d/REP/view';
  before = await evCount();
  await w.eval('saveReport()');
  ok('reports: blank name refused', await evCount() === before && toast() === 'يرجى كتابة اسم المعلمة المسؤولة عن الشاهد', toast());
  $('rep-person').value = 'أ. نورة';
  await w.eval('saveReport()');
  ok('reports: missing display name refused', await evCount() === before && toast().includes('اسم الملف أو الشاهد'), toast());
  $('rep-link-name').value = 'التقرير الختامي';
  await w.eval('saveReport()');
  const rep = await one(`SELECT person, file_name, link FROM public.evidences WHERE link = 'https://drive.google.com/file/d/REP/view'`);
  ok('reports: saved with teacher + display name, URL unchanged', rep?.person === 'أ. نورة' && rep.file_name === 'التقرير الختامي' && rep.link === 'https://drive.google.com/file/d/REP/view', JSON.stringify(rep));
  w.eval('renderReports()');
  ok('reports table shows teacher names and «غير محدد» for legacy', $('reports-tbody').textContent.includes('أ. نورة') && $('reports-tbody').textContent.includes('غير محدد'));
}

console.log('\n== 16. XSS: HTML in teacher name / file name / notes renders as text ==');
{
  const payload = '<img src=x onerror="window.__xss=1">';
  fillForRequirement(R.photos, 11, { person: `أ. ${payload}`, links: [{ name: `<script>window.__xss=2</script>${payload}`, url: 'https://drive.google.com/file/d/XSS/view' }], notes: `<b onmouseover="window.__xss=3">ملاحظة</b>` });
  await w.eval('saveEvidence()');
  const x = await one(`SELECT id, person, file_name, notes FROM public.evidences WHERE link = 'https://drive.google.com/file/d/XSS/view'`);
  ok('payload saved as plain text', !!x && x.person.includes('<img') && x.file_name.includes('<script>'), JSON.stringify(x));
  await freshLogin('admin');
  const body = openDetail();
  w.eval('renderReports(); renderPrograms();');
  const item = $(`evidence-${x.id}`);
  ok('no injected <img>/<script>/<b> elements in details', !body.querySelector('img[src="x"]') && !body.querySelector('script') && !item.querySelector('b'));
  ok('no injected elements in reports/programs', !$('reports-tbody').querySelector('img[src="x"]') && !$('programs-grid').querySelector('img[src="x"]'));
  ok('text shown literally', item.querySelector('.req-attachment-name').textContent.includes('<script>window.__xss=2</script>')
    && item.querySelector('.ev-teacher').textContent.includes('<img src=x'));
  ok('no script executed', w.__xss === undefined);
}

console.log('\n== Program cards: compact, counts, details collapsible ==');
{
  w.eval('renderPrograms()');
  const card = $('pcard-1');
  ok('card is an <article> with heading', card?.tagName === 'ARTICLE' && card.querySelector('h3.program-card-title')?.textContent === 'برنامج القراءة');
  ok('card shows responsible', card.querySelector('.program-card-facts')?.textContent.includes('أ. رباب'));
  const counts = card.querySelector('.program-card-counts')?.textContent.replace(/\s+/g, ' ');
  const nEv = (await one(`SELECT count(*)::int c FROM public.evidences WHERE program_id = 1`)).c;
  ok('card counts indicators / requirements / attachments', counts.includes('2 مؤشرات') && counts.includes('2 شواهد مطلوبة') && counts.includes(`${nEv} مرفقات`), counts);
  const more = card.querySelector('details.program-card-more');
  ok('indicators are inside a collapsed <details>', !!more && !more.open && more.querySelector('#ilist-1 .indicator-row'));
  ok('«عرض التفاصيل» button present', card.querySelector('.btn-detail-main')?.textContent.includes('عرض التفاصيل'));
  more.open = true;
  w.eval('renderPrograms()');
  ok('open state kept across re-render', $('pcard-1').querySelector('details.program-card-more').open === true);
  const pct = w.eval('calcProgramProgress(1)');
  ok('card shows the same percentage as the formula', $('ppct-1').textContent === `${pct}%`);
}

console.log('\n== Deep link: #evidence-… opens the right program after login ==');
{
  w.eval(`closeModal('program-detail-modal')`);
  w.history.replaceState(null, '', `/platform/#evidence-req-${R.photos}`);
  const done = w.eval('openEvidenceFromHash()');
  ok('deep link opens program details and jumps', done === true && !$('program-detail-modal').classList.contains('hidden')
    && $(`evidence-req-${R.photos}`).classList.contains('evidence-highlight'));
  w.eval(`closeModal('program-detail-modal')`);
}

ok('no console errors during the whole run', consoleErrors.length === 0, consoleErrors.join(' | '));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
