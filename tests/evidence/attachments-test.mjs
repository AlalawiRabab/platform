/**
 * اختبار محلي لمرفقات الشاهد المتعددة وحساب النسب.
 * يشغّل script.js الحقيقي داخل jsdom مع عميل وهمي — بلا شبكة وبلا إنتاج.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const YEAR_ID = '11111111-1111-1111-1111-111111111111';
const YEAR = {
  id: YEAR_ID,
  name: '1447',
  label_ar: '1447',
  status: 'active',
  is_active: true,
  is_archived: false,
  start_date: '2025-08-01',
  end_date: '2026-12-31',
  notes: null,
  hijri_year: '1447',
  created_at: '2025-01-01T00:00:00Z',
};

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

const db = {
  evidences: [],
  evidence_requirements: [],
  program_indicators: [],
  programs: [],
  school_years: [YEAR],
};
const ops = { inserts: [], updates: [], removes: [], uploads: [] };
const failUpload = new Set();
const failInsertOnce = new Set();
let idSeq = 1;
let uploadGate = null;

class Q {
  constructor(table) {
    this.table = table;
    this.op = 'select';
    this.filters = [];
    this.payload = null;
    this.one = false;
  }
  select() { return this; }
  insert(p) { this.op = 'insert'; this.payload = { ...p }; return this; }
  update(p) { this.op = 'update'; this.payload = { ...p }; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(k, v) { this.filters.push([k, v]); return this; }
  order() { return this; }
  limit() { return this; }
  single() { this.one = true; return this; }
  maybeSingle() { this.one = true; return this; }
  then(res, rej) { return this.exec().then(res, rej); }
  async exec() {
    const rows = db[this.table];
    if (!rows) return { data: this.one ? null : [], error: null };
    const match = row => this.filters.every(([k, v]) => String(row[k]) === String(v));
    if (this.op === 'select') {
      const list = rows.filter(match).map(r => ({ ...r }));
      if (this.one) {
        return list[0]
          ? { data: list[0], error: null }
          : { data: null, error: { code: 'PGRST116', message: 'no row' } };
      }
      return { data: list, error: null };
    }
    if (this.op === 'insert') {
      if (failInsertOnce.has(this.payload.file_name)) {
        failInsertOnce.delete(this.payload.file_name);
        return { data: null, error: { message: 'insert failed once', code: 'P0001' } };
      }
      const row = {
        ...this.payload,
        id: `new-${idSeq++}`,
        created_at: new Date().toISOString(),
        is_approved: this.payload.is_approved === true,
        link: this.payload.link || '',
      };
      rows.push(row);
      ops.inserts.push({ ...row });
      return { data: { ...row }, error: null };
    }
    if (this.op === 'update') {
      const hit = rows.filter(match);
      ops.updates.push({ table: this.table, payload: { ...this.payload }, ids: hit.map(r => r.id) });
      hit.forEach(r => Object.assign(r, this.payload));
      if (this.one) {
        return hit[0]
          ? { data: { ...hit[0] }, error: null }
          : { data: null, error: { code: 'PGRST116', message: 'no row' } };
      }
      return { data: hit.map(r => ({ ...r })), error: null };
    }
    return { data: null, error: null };
  }
}

const mockClient = {
  from: table => new Q(table),
  rpc: async () => ({ data: null, error: { message: 'no rpc' } }),
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
    setSession: async () => ({ data: {}, error: null }),
    updateUser: async () => ({ error: null }),
  },
  storage: {
    from: () => ({
      upload: async () => ({ error: null }),
      remove: async (paths) => { ops.removes.push(...(paths || [])); return { error: null }; },
      createSignedUrl: async () => ({ data: { signedUrl: 'https://example.com/signed' }, error: null }),
    }),
  },
  functions: { invoke: async () => ({ data: null, error: null }) },
};

const html = readFileSync(join(REPO, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Not implemented|Could not load/.test(String(e.message || e))) console.log('  [jsdom]', e.message || e); });
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'http://localhost/index.html',
  virtualConsole: vc,
  pretendToBeVisual: true,
});
const w = dom.window;
w.supabaseClient = mockClient;
w.confirm = () => false;
w.alert = () => {};
const script = w.document.createElement('script');
script.textContent = readFileSync(join(REPO, 'script.js'), 'utf8');
w.document.body.appendChild(script);
await new Promise(r => setTimeout(r, 80));

function file(name, lastModified = 1700000000000) {
  return new w.File(['hello'], name, { type: 'application/pdf', lastModified });
}
function setLet(name, value) {
  w.__assigned = value;
  w.eval(`${name} = __assigned`);
}
function readPendingNames() {
  return w.eval('pendingEvidenceFiles.map(f => f.name)');
}
const countName = name => db.evidences.filter(e => e.file_name === name).length;
const countLink = url => db.evidences.filter(e => e.link === url).length;

function installUpload() {
  w.uploadEvidenceToStorage = async (f) => {
    ops.uploads.push(f.name);
    if (uploadGate && f.name === 'slow.pdf') await uploadGate;
    if (failUpload.has(f.name)) throw new Error('تعذّر رفع الملف');
    const path = `uid/${f.name}-${ops.uploads.length}`;
    return { path, file_url: path, file_name: f.name, file_size: f.size };
  };
}
installUpload();

function setYear() {
  w.eval(`
    currentUser = { id: 'user-teacher', name: 'معلمة', role: 'teacher' };
    schoolYearsCache = [${JSON.stringify(YEAR)}];
    selectedSchoolYearId = '${YEAR_ID}';
    activeSchoolYearId = '${YEAR_ID}';
    evidenceRequirementsReady = true;
  `);
}

console.log('نسب الشاهد والمؤشر والبرنامج');
setYear();
w.eval(`
  evidenceRequirementsCache = [
    { id: 'r1', indicator_id: '1', name: 'شهادة الحضور', sort_order: 1, is_approved: false },
    { id: 'r2', indicator_id: '1', name: 'صور النشاط', sort_order: 2, is_approved: false },
    { id: 'r3', indicator_id: '2', name: 'حزمة كبيرة', sort_order: 1, is_approved: false },
    { id: 'r4', indicator_id: '2', name: 'ملف واحد', sort_order: 2, is_approved: false },
    { id: 'r5', indicator_id: '3', name: 'شاهد فارغ', sort_order: 1, is_approved: false },
    { id: 'r6', indicator_id: '3', name: 'شاهد مكتمل', sort_order: 2, is_approved: true },
  ];
  indicatorsCache = { '10': [{ id: '1', program_id: '10', indicator_text: 'مؤشر الحضور' }] };
  programsCache = [{
    id: '10', name: 'برنامج القراءة', school_year_id: '${YEAR_ID}',
    resp: 'قائدة', target: 'طالبات', start: '2025-09-01', end: '2026-06-01', desc: ''
  }];
  evidencesCache = [
    { id: 'a', requirement_id: 'r1', indicator_id: '1', program_id: '10', school_year_id: '${YEAR_ID}', file_url: 'p/a.pdf', file_name: 'a.pdf', is_approved: true, link: '', created_at: '2026-01-01' },
    { id: 'b', requirement_id: 'r1', indicator_id: '1', program_id: '10', school_year_id: '${YEAR_ID}', file_url: 'p/b.pdf', file_name: 'b.pdf', is_approved: true, link: '', created_at: '2026-01-02' },
    { id: 'c', requirement_id: 'r1', indicator_id: '1', program_id: '10', school_year_id: '${YEAR_ID}', file_url: '', file_name: '', link: 'https://drive.google.com/file/d/c/view', is_approved: false, created_at: '2026-01-03' },
    { id: 'd', requirement_id: 'r1', indicator_id: '1', program_id: '10', school_year_id: '${YEAR_ID}', file_url: '', file_name: '', link: 'https://drive.google.com/file/d/d/view', is_approved: false, created_at: '2026-01-04' },
    { id: 'e', requirement_id: 'r2', indicator_id: '1', program_id: '10', school_year_id: '${YEAR_ID}', file_url: 'p/e.pdf', file_name: 'e.pdf', is_approved: true, link: '', created_at: '2026-01-05' },
    { id: 'full', requirement_id: 'r6', indicator_id: '3', program_id: '10', school_year_id: '${YEAR_ID}', file_url: 'p/full.pdf', file_name: 'full.pdf', is_approved: true, link: '', created_at: '2026-01-06' },
  ];
  for (let i = 0; i < 10; i++) {
    evidencesCache.push({
      id: 'bulk-' + i, requirement_id: 'r3', indicator_id: '2', program_id: '10', school_year_id: '${YEAR_ID}',
      file_url: 'p/bulk-' + i + '.pdf', file_name: 'bulk-' + i + '.pdf', is_approved: false, link: '', created_at: '2026-02-0' + (i % 9)
    });
  }
  evidencesCache.push({
    id: 'one', requirement_id: 'r4', indicator_id: '2', program_id: '10', school_year_id: '${YEAR_ID}',
    file_url: 'p/one.pdf', file_name: 'one.pdf', is_approved: true, link: '', created_at: '2026-03-01'
  });
`);

ok('شاهد 2 من 4 = 50٪', w.calcRequirementProgress({ id: 'r1' }) === 50, String(w.calcRequirementProgress({ id: 'r1' })));
ok('شاهد مكتمل = 100٪', w.calcRequirementProgress({ id: 'r2' }) === 100);
ok('مؤشر = متوسط الشاهدين 75٪', w.calcIndicatorProgress('1') === 75, String(w.calcIndicatorProgress('1')));
ok('برنامج = نسبة مؤشره 75٪', w.calcProgramProgress('10') === 75, String(w.calcProgramProgress('10')));
const heavy = w.calcIndicatorProgress('2');
ok('وزن الشاهد متساوٍ: 0٪ و100٪ = 50 وليس 1/11', heavy === 50 && heavy !== Math.round(100 / 11), String(heavy));
ok('شاهد بلا مرفقات = 0 ويبقى في متوسط المؤشر', w.calcRequirementProgress({ id: 'r5' }) === 0 && w.calcIndicatorProgress('3') === 50);

w.renderDashboard();
w.renderReports();
w.renderKPI();
w.renderPrograms();
const dash = w.document.getElementById('dashboard-stats')?.textContent || '';
const bars = w.document.getElementById('initiatives-progress')?.textContent || '';
const reports = w.document.getElementById('reports-progress-summary')?.textContent || '';
const kpi = w.document.getElementById('kpi-cards')?.textContent || '';
const cards = w.document.getElementById('programs-grid')?.textContent || '';
ok('لوحة التحكم تعرض 75%', dash.includes('75%') && bars.includes('75%'), dash);
ok('التقارير تعرض متوسط 75٪', reports.includes('75'), reports);
ok('مؤشرات الأداء تعرض 75%', kpi.includes('75%'), kpi);
ok('بطاقات البرامج تعرض 75%', cards.includes('75%'), cards);

const req = { id: 'r1', name: 'شهادة الحضور', indicator_id: '1' };
setLet('currentUser', { id: 'user-admin', name: 'القائدة', role: 'admin' });
const adminHtml = w.buildRequirementRowHtml(req, '10', '1');
ok('كل المرفقات تحت اسم الشاهد مع زر فتح', (adminHtml.match(/فتح/g) || []).length === 4, adminHtml);
ok('اعتماد مستقل لكل مرفق للقائدة', (adminHtml.match(/handleToggleAttachmentApproval/g) || []).length === 4);
setLet('currentUser', { id: 'user-teacher', name: 'معلمة', role: 'teacher' });
const teacherHtml = w.buildRequirementRowHtml(req, '10', '1');
ok('المعلمة ترى الفتح والإضافة دون اعتماد', teacherHtml.includes('فتح') && teacherHtml.includes('إضافة مرفقات') && !teacherHtml.includes('handleToggleAttachmentApproval'));

console.log('اختيار عدة ملفات وروابط');
w.eval('pendingEvidenceFiles = []; evidenceSavedKeys = new Set()');
const f1 = file('one.pdf', 1000);
const f2 = file('two.pdf', 2000);
w.handleEvidenceFileSelect({ files: [f1, f2], value: 'a' }, 'ev');
w.handleEvidenceFileSelect({ files: [f1, f2], value: 'b' }, 'ev');
ok('اختيار ملفين دون تكرار نفس الملف', readPendingNames().length === 2, readPendingNames().join(','));
w.handleEvidenceFileSelect({ files: [file('bad.exe', 3000)], value: 'c' }, 'ev');
ok('ملف غير مسموح لا يُضاف', readPendingNames().length === 2, readPendingNames().join(','));
const parsed = w.parseEvidenceLinkLines('https://drive.google.com/file/d/1/view\n\nhttps://drive.google.com/file/d/1/view\nhttps://drive.google.com/file/d/2/view\nnotaurl');
ok('الروابط تُقرأ سطراً سطراً مع حذف التكرار', parsed.valid.length === 2 && parsed.invalid.length === 1, JSON.stringify(parsed));

console.log('حفظ عدة مرفقات وفشل أحد الملفات وإعادة المحاولة');
const OLD = 'https://drive.google.com/file/d/old/view';
const NEW = 'https://drive.google.com/file/d/new/view';
db.evidences = [{
  id: 'keep-1', title: 'شهادة الحضور', requirement_id: 'r1', indicator_id: '1', program_id: '10',
  school_year_id: YEAR_ID, file_url: 'u/keep.pdf', file_name: 'keep.pdf', file_size: 10,
  link: '', is_approved: true, created_at: '2026-01-01T00:00:00Z', person: 'معلمة', notes: '',
}];
db.evidences.push({
  id: 'keep-link', title: 'شهادة الحضور', requirement_id: 'r1', indicator_id: '1', program_id: '10',
  school_year_id: YEAR_ID, file_url: null, file_name: null, file_size: null,
  link: OLD, is_approved: false, created_at: '2026-01-02T00:00:00Z', person: 'معلمة', notes: '',
});
db.evidence_requirements = [
  { id: 'r1', indicator_id: '1', name: 'شهادة الحضور', sort_order: 1, is_approved: false },
  { id: 'r2', indicator_id: '1', name: 'صور النشاط', sort_order: 2, is_approved: false },
];
db.program_indicators = [{ id: '1', program_id: '10', indicator_text: 'مؤشر الحضور', is_completed: false }];
db.programs = [{ id: '10', name: 'برنامج القراءة', progress: 0, school_year_id: YEAR_ID }];
setLet('evidencesCache', db.evidences.map(e => ({ ...e })));
setLet('evidenceRequirementsCache', db.evidence_requirements.map(r => ({ ...r })));
w.eval('evidenceRequirementsReady = true');
setLet('pendingEvidenceFiles', [file('ok.pdf', 11), file('bad.pdf', 12)]);
w.eval('evidenceSavedKeys = new Set()');
w.document.getElementById('ev-program-id').value = '10';
const indicatorSelect = w.document.getElementById('ev-indicator-id');
indicatorSelect.innerHTML = '<option value="1">مؤشر الحضور</option>';
indicatorSelect.value = '1';
w.document.getElementById('ev-requirement-id').value = 'r1';
w.document.getElementById('ev-title').value = 'شهادة الحضور';
w.document.getElementById('ev-person').value = 'معلمة';
w.document.getElementById('ev-notes').value = '';
w.document.getElementById('ev-links').value = `${OLD}\n${NEW}`;
failUpload.add('bad.pdf');
ops.inserts = [];
ops.updates = [];
ops.removes = [];
await w.saveEvidence();
ok('حُفظ الملف الناجح مرة واحدة', countName('ok.pdf') === 1, String(countName('ok.pdf')));
ok('حُفظ الرابط الجديد مرة واحدة', countLink(NEW) === 1, String(countLink(NEW)));
ok('الرابط الموجود لم يُكرر', countLink(OLD) === 1, String(countLink(OLD)));
ok('المرفق السابق بقي ولم يُستبدل', db.evidences.find(e => e.id === 'keep-1')?.file_url === 'u/keep.pdf' && db.evidences.find(e => e.id === 'keep-1')?.is_approved === true);
ok('فشل رفع bad.pdf ولم يُدرج', countName('bad.pdf') === 0);
ok('الحفظ لا يستدعي تحديث المرفق', ops.updates.filter(u => u.table === 'evidences').length === 0, JSON.stringify(ops.updates));
ok('الملف الفاشل بقي لإعادة المحاولة', readPendingNames().includes('bad.pdf') && !readPendingNames().includes('ok.pdf'), readPendingNames().join(','));
ok('رسالة الفشل تطلب إعادة الحفظ دون تكرار', (w.document.getElementById('toast')?.textContent || '').includes('دون تكرار'));
failUpload.delete('bad.pdf');
await w.saveEvidence();
ok('إعادة المحاولة حفظت الملف الفاشل فقط', countName('bad.pdf') === 1 && countName('ok.pdf') === 1 && countLink(NEW) === 1);

console.log('فشل الإدراج بعد الرفع ثم إعادة المحاولة');
failInsertOnce.add('drop.pdf');
ops.removes = [];
setLet('pendingEvidenceFiles', [file('drop.pdf', 13)]);
w.eval('evidenceSavedKeys = new Set()');
w.document.getElementById('ev-links').value = '';
await w.saveEvidence();
ok('فشل الإدراج يحذف الملف المرفوع ولا يترك صفاً', countName('drop.pdf') === 0 && ops.removes.length === 1, `rows=${countName('drop.pdf')} removes=${ops.removes.length}`);
await w.saveEvidence();
ok('إعادة المحاولة بعد فشل الإدراج تحفظ مرة واحدة', countName('drop.pdf') === 1);

console.log('منع تكرار الضغط أثناء الحفظ');
let release;
uploadGate = new Promise(r => { release = r; });
setLet('pendingEvidenceFiles', [file('slow.pdf', 14)]);
w.eval('evidenceSavedKeys = new Set()');
const first = w.saveEvidence();
const second = w.saveEvidence();
await second;
release();
uploadGate = null;
await first;
ok('الضغط المزدوج لا يدرج المرفق مرتين', countName('slow.pdf') === 1, String(countName('slow.pdf')));

console.log('صلاحية الاعتماد');
const target = db.evidences.find(e => e.file_name === 'ok.pdf');
setLet('currentUser', { id: 'user-teacher', name: 'معلمة', role: 'teacher' });
const updatesBefore = ops.updates.filter(u => u.table === 'evidences').length;
await w.handleToggleAttachmentApproval('10', target.id);
ok('المعلمة لا تعتمد المرفق', target.is_approved !== true && ops.updates.filter(u => u.table === 'evidences').length === updatesBefore);
setLet('currentUser', { id: 'user-admin', name: 'القائدة', role: 'admin' });
await w.handleToggleAttachmentApproval('10', target.id);
const approvedRow = db.evidences.find(e => e.id === target.id);
ok('القائدة تعتمد مرفقاً واحداً', approvedRow?.is_approved === true);
const pct = w.calcRequirementProgress({ id: 'r1' });
const total = w.getEvidencesForRequirement('r1').length;
const approved = w.getEvidencesForRequirement('r1').filter(w.isAttachmentApproved).length;
ok('نسبة الشاهد بعد اعتماد مرفق واحد تُحسب من المرفقات', pct === Math.round((approved / total) * 100) && approved >= 1 && total > approved, `${approved}/${total}=${pct}`);

setLet('currentUser', { id: 'user-teacher', name: 'معلمة', role: 'teacher' });
w.eval('evidenceSavedKeys = new Set()');
setLet('pendingEvidenceFiles', [file('extra.pdf', 15)]);
w.document.getElementById('ev-links').value = 'https://drive.google.com/file/d/extra/view';
await w.saveEvidence();
ok('المعلمة تضيف مرفقاً جديداً مع وجود مرفق معتمد', countName('extra.pdf') === 1 && countLink('https://drive.google.com/file/d/extra/view') === 1);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
