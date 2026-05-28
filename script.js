/* ================================================================
   SCHOOL OPERATIONAL PLAN — script.js  v5.0  (FINAL)
   ================================================================
   ✅  users              → Supabase  (تسجيل دخول حقيقي)
   ✅  programs           → Supabase  (CRUD كامل)
   ✅  program_indicators → Supabase  (مؤشرات إنجاز فعلية + تحديث تلقائي)
   🔒  بقية البيانات     → LocalStorage

   ═══════════════════════════════════════════════════════════════
   SQL — شغّله مرة واحدة في Supabase → SQL Editor
   ═══════════════════════════════════════════════════════════════

   -- 1. جدول المستخدمين
   CREATE TABLE IF NOT EXISTS users (
     id         uuid  DEFAULT gen_random_uuid() PRIMARY KEY,
     name       text  NOT NULL,
     email      text  UNIQUE NOT NULL,
     password   text  NOT NULL,
     role       text  NOT NULL DEFAULT 'teacher'
                      CHECK (role IN ('admin','vice','teacher')),
     created_at timestamptz DEFAULT now()
   );

   -- 2. جدول البرامج
   CREATE TABLE IF NOT EXISTS programs (
     id          uuid  DEFAULT gen_random_uuid() PRIMARY KEY,
     name        text  NOT NULL,
     description text,
     resp        text,
     target_group text,
     start_date  date,
     end_date    date,
     status      text  DEFAULT 'planning',
     progress    int2  DEFAULT 0,
     created_at  timestamptz DEFAULT now()
   );

   -- 3. جدول مؤشرات الإنجاز
   CREATE TABLE IF NOT EXISTS program_indicators (
     id             uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
     program_id     uuid    REFERENCES programs(id) ON DELETE CASCADE,
     indicator_text text    NOT NULL,
     is_completed   boolean DEFAULT false,
     created_at     timestamptz DEFAULT now()
   );

   -- 4. RLS — السماح للجميع (anon key كافٍ)
   ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
   ALTER TABLE programs           ENABLE ROW LEVEL SECURITY;
   ALTER TABLE program_indicators ENABLE ROW LEVEL SECURITY;

   DROP POLICY IF EXISTS "allow_all_users"      ON users;
   DROP POLICY IF EXISTS "allow_all_programs"   ON programs;
   DROP POLICY IF EXISTS "allow_all_indicators" ON program_indicators;

   CREATE POLICY "allow_all_users"      ON users              FOR ALL USING (true) WITH CHECK (true);
   CREATE POLICY "allow_all_programs"   ON programs           FOR ALL USING (true) WITH CHECK (true);
   CREATE POLICY "allow_all_indicators" ON program_indicators FOR ALL USING (true) WITH CHECK (true);

   -- 5. بيانات تجريبية
   INSERT INTO users (name, email, password, role) VALUES
     ('سارة العتيبي',  'admin@school.sa',   '1234', 'admin'),
     ('نورة القحطاني', 'vice@school.sa',    '1234', 'vice'),
     ('هند الزهراني',  'teacher@school.sa', '1234', 'teacher')
   ON CONFLICT (email) DO NOTHING;

   ================================================================ */

'use strict';

/* ================================================================
   §0 — SUPABASE CLIENT
   ================================================================ */
// supabaseClient مُعرَّف في config.js ومُحمَّل قبل هذا الملف
const sb = (typeof supabaseClient !== 'undefined') ? supabaseClient : null;

/* ================================================================
   §1 — GLOBAL STATE
   ================================================================ */
let currentUser     = null;   // { id, name, email, role }
let programsCache   = [];     // Program[]
let indicatorsCache = {};     // { [programId]: Indicator[] }
let calendarMonth   = new Date().getMonth();
let calendarYear    = new Date().getFullYear();
let pendingFileData  = null;
let pendingImageData = null;

/* ================================================================
   §2 — PERMISSIONS
   ================================================================
   admin   → وصول كامل + إدارة المستخدمين
   vice    → إضافة / تعديل البرامج + متابعة  (لا حذف / لا إدارة)
   teacher → عرض + رفع شواهد + تحديث مؤشرات برامجه فقط
   ================================================================ */
const PERMS = {
  admin: {
    addProgram:true, editProgram:true, deleteProgram:true,
    addIndicator:true, deleteIndicator:true, toggleIndicator:true,
    addEvidence:true,  deleteEvidence:true,
    manageUsers:true,
  },
  vice: {
    addProgram:true,  editProgram:true,  deleteProgram:false,
    addIndicator:true, deleteIndicator:false, toggleIndicator:true,
    addEvidence:true,  deleteEvidence:false,
    manageUsers:false,
  },
  teacher: {
    addProgram:false, editProgram:false, deleteProgram:false,
    addIndicator:false, deleteIndicator:false, toggleIndicator:true,
    addEvidence:true,  deleteEvidence:false,
    manageUsers:false,
  },
};

function can(action) {
  return currentUser ? (PERMS[currentUser.role]?.[action] === true) : false;
}

/* ================================================================
   §3 — DEMO / LOCAL DATA
   ================================================================ */
const DEMO_INITIATIVES = [
  {id:1,goal:'تحسين التحصيل الدراسي',name:'تفعيل الاختبارات القصيرة',desc:'اختبارات قصيرة أسبوعية لجميع المواد',resp:'أ. نورة العتيبي',start:'2024-09-01',end:'2025-05-30',status:'قيد التنفيذ',progress:75,link:''},
  {id:2,goal:'تحسين التحصيل الدراسي',name:'متابعة الفاقد التعليمي',desc:'رصد ومتابعة الطالبات ذوات الفاقد',resp:'أ. هند القحطاني',start:'2024-09-15',end:'2025-05-15',status:'قيد التنفيذ',progress:60,link:''},
  {id:3,goal:'تعزيز الانضباط',name:'برنامج الانضباط المدرسي',desc:'برنامج شامل لتعزيز الانضباط',resp:'أ. سلمى الزهراني',start:'2024-09-01',end:'2025-06-01',status:'قيد التنفيذ',progress:80,link:''},
  {id:4,goal:'التنمية المهنية',name:'التنمية المهنية للمعلمات',desc:'برامج تدريبية لتطوير مهارات المعلمات',resp:'أ. ريم الحربي',start:'2024-10-01',end:'2025-04-30',status:'منجزة',progress:100,link:''},
  {id:5,goal:'الشراكة المجتمعية',name:'تفعيل الشراكة المجتمعية',desc:'شراكات مع مؤسسات المجتمع',resp:'أ. مها الشمري',start:'2024-11-01',end:'2025-03-31',status:'منجزة',progress:100,link:''},
  {id:6,goal:'تعزيز الهوية الوطنية',name:'تعزيز الهوية الوطنية',desc:'فعاليات تعزز الانتماء الوطني',resp:'أ. فاطمة الدوسري',start:'2024-09-22',end:'2025-02-23',status:'منجزة',progress:100,link:''},
  {id:7,goal:'تحسين التحصيل الدراسي',name:'التعلم التعاوني',desc:'استراتيجيات التعلم التعاوني',resp:'أ. نورة العتيبي',start:'2024-10-15',end:'2025-05-15',status:'قيد التنفيذ',progress:55,link:''},
  {id:8,goal:'متابعة الفاقد التعليمي',name:'حلقات الدعم الأكاديمي',desc:'حلقات دعم أسبوعية للطالبات',resp:'أ. هند القحطاني',start:'2024-09-20',end:'2025-05-20',status:'قيد التنفيذ',progress:45,link:''},
];
const DEMO_TASKS = [
  {id:1,name:'إعداد جدول الاختبارات القصيرة',resp:'أ. نورة العتيبي',due:'2025-01-15',priority:'high',status:'done',notes:'تم الإعداد'},
  {id:2,name:'رصد نتائج الاختبارات التشخيصية',resp:'أ. هند القحطاني',due:'2025-01-20',priority:'high',status:'done',notes:''},
  {id:3,name:'تنفيذ ورشة التعلم التعاوني',resp:'أ. ريم الحربي',due:'2025-02-10',priority:'medium',status:'inprogress',notes:'الورشة في الثامن'},
  {id:4,name:'إعداد تقرير الفاقد التعليمي',resp:'أ. هند القحطاني',due:'2025-02-28',priority:'high',status:'pending',notes:''},
  {id:5,name:'تنظيم فعالية اليوم الوطني',resp:'أ. فاطمة الدوسري',due:'2024-09-22',priority:'high',status:'done',notes:'تم تنفيذها'},
  {id:6,name:'متابعة الطالبات المتعثرات',resp:'أ. سلمى الزهراني',due:'2025-03-15',priority:'medium',status:'inprogress',notes:''},
  {id:7,name:'تقرير الزيارات الصفية',resp:'أ. مها الشمري',due:'2025-01-31',priority:'low',status:'done',notes:''},
  {id:8,name:'إعداد خطة الأنشطة الفصلية',resp:'أ. فاطمة الدوسري',due:'2025-03-01',priority:'medium',status:'pending',notes:''},
];
const DEMO_KPI = [
  {id:1,name:'نسبة النجاح العامة',target:95,achieved:91,unit:'%'},
  {id:2,name:'نسبة الحضور اليومي',target:98,achieved:96.5,unit:'%'},
  {id:3,name:'عدد الاختبارات المنفذة',target:80,achieved:68,unit:'اختبار'},
  {id:4,name:'نسبة رضا أولياء الأمور',target:90,achieved:87,unit:'%'},
  {id:5,name:'عدد الزيارات الصفية',target:120,achieved:105,unit:'زيارة'},
  {id:6,name:'عدد الطالبات المستفيدات',target:50,achieved:43,unit:'طالبة'},
];
const DEMO_REPORTS = [
  {id:1,title:'نتائج الاختبارات - الفصل الأول',type:'PDF',initiative:'تفعيل الاختبارات القصيرة',person:'أ. نورة العتيبي',date:'2024-11-15',link:'https://drive.google.com/example1',notes:''},
  {id:2,title:'صور فعالية اليوم الوطني',type:'صورة',initiative:'تعزيز الهوية الوطنية',person:'أ. فاطمة الدوسري',date:'2024-09-25',link:'https://drive.google.com/example2',notes:''},
  {id:3,title:'تقرير ورشة التنمية المهنية',type:'Google Drive',initiative:'التنمية المهنية للمعلمات',person:'أ. ريم الحربي',date:'2024-12-10',link:'https://drive.google.com/example3',notes:'15 معلمة'},
  {id:4,title:'فيديو الشراكة المجتمعية',type:'YouTube',initiative:'تفعيل الشراكة المجتمعية',person:'أ. مها الشمري',date:'2024-12-20',link:'https://youtube.com/example4',notes:''},
];
const DEMO_TEACHERS = [
  {id:1,name:'أ. نورة العتيبي',assigned:12,done:10,lastReport:'2024-12-15',notes:''},
  {id:2,name:'أ. هند القحطاني',assigned:8,done:5,lastReport:'2024-12-10',notes:''},
  {id:3,name:'أ. سلمى الزهراني',assigned:10,done:9,lastReport:'2024-12-20',notes:''},
  {id:4,name:'أ. ريم الحربي',assigned:6,done:6,lastReport:'2024-12-12',notes:''},
  {id:5,name:'أ. مها الشمري',assigned:7,done:6,lastReport:'2024-12-18',notes:''},
  {id:6,name:'أ. فاطمة الدوسري',assigned:9,done:8,lastReport:'2024-12-22',notes:''},
];
const DEMO_SETTINGS = {
  schoolName:'مدرسة النور الابتدائية', year:'١٤٤٦ / ١٤٤٧هـ',
  principal:'أ. سارة العتيبي', region:'منطقة المدينة المنورة'
};

/* Fallback users (إذا كان Supabase غير متاح) */
const FALLBACK_USERS = [
  {id:'f1',name:'سارة العتيبي', email:'admin@school.sa',   password:'1234',role:'admin'},
  {id:'f2',name:'نورة القحطاني',email:'vice@school.sa',    password:'1234',role:'vice'},
  {id:'f3',name:'هند الزهراني', email:'teacher@school.sa', password:'1234',role:'teacher'},
];

/* ================================================================
   §4 — LOCALSTORAGE HELPERS
   ================================================================ */
function lsSave(key, val) { localStorage.setItem('sop_'+key, JSON.stringify(val)); }
function lsLoad(key, def) {
  try { const v=localStorage.getItem('sop_'+key); return v ? JSON.parse(v) : def; }
  catch { return def; }
}
const save = lsSave;
const load = lsLoad;

/** حفظ بيانات البرنامج الإضافية (resp, target, evidence) محلياً */
function saveProgExtra(id, p) {
  lsSave('pe_'+id, { resp:p.resp||'', target:p.target||'', evidence:p.evidence||[] });
}
function loadProgExtra(id) {
  return lsLoad('pe_'+id, { resp:'', target:'', evidence:[] });
}

/* ================================================================
   §5 — LOADING OVERLAY
   ================================================================ */
function showLoadingOverlay(show) {
  let el = document.getElementById('__overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = '__overlay';
    el.style.cssText = [
      'position:fixed','inset:0','z-index:9999',
      'background:rgba(13,43,69,0.6)',
      'display:flex','align-items:center','justify-content:center',
      'backdrop-filter:blur(4px)',
    ].join(';');
    el.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:36px 52px;text-align:center;
                  box-shadow:0 24px 64px rgba(0,0,0,.35)">
        <div style="font-size:40px;animation:_spin 0.9s linear infinite;display:inline-block">⏳</div>
        <div style="font-family:Tajawal,sans-serif;font-size:16px;font-weight:700;
                    color:#1a5276;margin-top:14px">جارٍ التحميل…</div>
      </div>
      <style>@keyframes _spin{to{transform:rotate(360deg)}}</style>`;
    document.body.appendChild(el);
  }
  el.style.display = show ? 'flex' : 'none';
}

/* ================================================================
   §6 — TOAST
   ================================================================ */
let _toastT = null;
function showToast(msg, type='success') {
  const t = document.getElementById('toast'); if (!t) return;
  t.textContent = msg;
  t.className   = 'toast '+type;
  t.classList.remove('hidden');
  if (_toastT) clearTimeout(_toastT);
  _toastT = setTimeout(()=>t.classList.add('hidden'), 3500);
}

/* ================================================================
   §7 — MODALS
   ================================================================ */
function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
  if (id === 'evidence-modal') { pendingFileData=null; pendingImageData=null; }
}

/* ================================================================
   §8 — SUPABASE: USERS
   ================================================================ */

/**
 * تسجيل الدخول:
 * يقرأ من جدول users بـ email + password (plain-text تجريبي)
 * استبدل هذا بـ Supabase Auth في بيئة الإنتاج
 */
async function sbLogin(email, password) {
  if (!sb) {
    // Fallback offline
    const u = FALLBACK_USERS.find(
      x => x.email === email.toLowerCase().trim() && x.password === password
    );
    return u || null;
  }
  const { data, error } = await sb
    .from('users')
    .select('id,name,email,role')
    .eq('email', email.toLowerCase().trim())
    .eq('password', password)          // ← في الإنتاج استخدم Supabase Auth
    .maybeSingle();
  if (error) { console.error('[Auth]', error.message); return null; }
  return data;  // null إذا لم يُوجد
}

async function sbFetchUsers() {
  if (!sb) return [];
  const { data, error } = await sb
    .from('users')
    .select('id,name,email,role,created_at')
    .order('created_at');
  if (error) { console.error('[Users]', error.message); return []; }
  return data || [];
}

async function sbInsertUser(u) {
  if (!sb) throw new Error('Supabase غير متاح');
  const { data, error } = await sb.from('users')
    .insert({ name:u.name, email:u.email.toLowerCase().trim(), password:u.password, role:u.role })
    .select().single();
  if (error) throw error;
  return data;
}

async function sbDeleteUser(id) {
  if (!sb) throw new Error('Supabase غير متاح');
  const { error } = await sb.from('users').delete().eq('id', id);
  if (error) throw error;
}

async function sbUpdateUserRole(id, role) {
  if (!sb) throw new Error('Supabase غير متاح');
  const { error } = await sb.from('users').update({ role }).eq('id', id);
  if (error) throw error;
}

/* ================================================================
   §9 — SUPABASE: PROGRAMS
   ================================================================ */

/** Supabase row → JS object */
function rowToProgram(row) {
  const ex = loadProgExtra(row.id);
  return {
    id        : row.id,
    name      : row.name        || '',
    desc      : row.description || '',
    start     : row.start_date  || '',
    end       : row.end_date    || '',
    progress  : row.progress    || 0,
    resp      : row.resp        || ex.resp    || '',
    target    : row.target_group|| ex.target  || '',
    evidence  : ex.evidence     || [],
    indicators: [],   // يُملأ من indicatorsCache
  };
}

/** JS object → Supabase insert/update row */
function programToRow(p) {
  return {
    name         : p.name,
    description  : p.desc  || null,
    resp         : p.resp  || null,
    target_group : p.target|| null,
    start_date   : p.start || null,
    end_date     : p.end   || null,
    progress     : Number(p.progress) || 0,
    status       : calcProgramStatus(p),
  };
}

/**
 * تحميل البرامج والمؤشرات دفعة واحدة (Promise.all)
 */
async function sbFetchPrograms() {
  if (!sb) {
    programsCache = lsLoad('programs_local', []);
    indicatorsCache = {};
    programsCache.forEach(p => { indicatorsCache[p.id] = p.indicators||[]; });
    return programsCache;
  }
  showLoadingOverlay(true);
  try {
    const [pr, ir] = await Promise.all([
      sb.from('programs').select('*').order('created_at'),
      sb.from('program_indicators').select('*').order('created_at'),
    ]);
    if (pr.error) throw pr.error;
    if (ir.error) throw ir.error;

    // بناء indicatorsCache
    indicatorsCache = {};
    (ir.data||[]).forEach(ind => {
      if (!indicatorsCache[ind.program_id]) indicatorsCache[ind.program_id] = [];
      indicatorsCache[ind.program_id].push(ind);
    });

    programsCache = (pr.data||[]).map(row => {
      const p = rowToProgram(row);
      p.indicators = indicatorsCache[p.id] || [];
      return p;
    });
    return programsCache;
  } catch (err) {
    console.error('[Programs]', err.message);
    showToast('تعذّر تحميل البرامج: '+err.message, 'error');
    programsCache = lsLoad('programs_local', []);
    return programsCache;
  } finally {
    showLoadingOverlay(false);
  }
}

async function sbInsertProgram(p) {
  if (!sb) {
    p.id = 'L'+Date.now();
    const ls = lsLoad('programs_local',[]); ls.push(p); lsSave('programs_local',ls);
    saveProgExtra(p.id, p); return p;
  }
  const { data, error } = await sb.from('programs').insert(programToRow(p)).select().single();
  if (error) throw error;
  saveProgExtra(data.id, p);
  const prog = rowToProgram(data); prog.indicators = [];
  return prog;
}

async function sbUpdateProgram(p) {
  if (!sb) {
    const ls = lsLoad('programs_local',[]);
    const i = ls.findIndex(x=>x.id===p.id);
    if (i!==-1) { p.evidence=ls[i].evidence||[]; ls[i]=p; }
    lsSave('programs_local',ls); saveProgExtra(p.id,p); return p;
  }
  const { data, error } = await sb.from('programs').update(programToRow(p)).eq('id',p.id).select().single();
  if (error) throw error;
  const ex = programsCache.find(x=>x.id===p.id) || {};
  p.evidence = ex.evidence || p.evidence || [];
  saveProgExtra(data.id, p);
  const prog = rowToProgram(data);
  prog.indicators = indicatorsCache[prog.id] || [];
  prog.evidence   = p.evidence;
  return prog;
}

async function sbDeleteProgram(id) {
  if (!sb) {
    let ls = lsLoad('programs_local',[]);
    ls = ls.filter(p=>p.id!==id); lsSave('programs_local',ls);
    localStorage.removeItem('sop_pe_'+id); delete indicatorsCache[id]; return;
  }
  const { error } = await sb.from('programs').delete().eq('id', id);
  if (error) throw error;
  localStorage.removeItem('sop_pe_'+id);
  delete indicatorsCache[id];
}

/* ================================================================
   §10 — SUPABASE: PROGRAM_INDICATORS
   ================================================================ */

/**
 * syncProgress:
 * يحسب نسبة الإنجاز من عدد المؤشرات المكتملة ثم يحدّث
 * programsCache و programs في Supabase.
 */
async function syncProgress(programId) {
  const inds      = indicatorsCache[programId] || [];
  const total     = inds.length;
  const completed = inds.filter(i=>i.is_completed).length;
  const progress  = total > 0 ? Math.round((completed/total)*100) : 0;

  // تحديث الكاش أولاً (فوري في UI)
  const pIdx = programsCache.findIndex(p=>p.id===programId);
  if (pIdx !== -1) {
    programsCache[pIdx].progress   = progress;
    programsCache[pIdx].indicators = inds;
  }

  if (!sb) return;

  const prog   = programsCache[pIdx] || {};
  const status = calcProgramStatus({...prog, progress});

  const { error } = await sb.from('programs')
    .update({ progress, status })
    .eq('id', programId);
  if (error) console.error('[syncProgress]', error.message);
}

/** إضافة مؤشر جديد */
async function sbAddIndicator(programId, text) {
  if (!sb) {
    const ind = {
      id:'L'+Date.now(), program_id:programId,
      indicator_text:text, is_completed:false,
      created_at: new Date().toISOString()
    };
    if (!indicatorsCache[programId]) indicatorsCache[programId]=[];
    indicatorsCache[programId].push(ind);
    await syncProgress(programId);
    return ind;
  }
  const { data, error } = await sb.from('program_indicators')
    .insert({ program_id:programId, indicator_text:text, is_completed:false })
    .select().single();
  if (error) throw error;
  if (!indicatorsCache[programId]) indicatorsCache[programId]=[];
  indicatorsCache[programId].push(data);
  await syncProgress(programId);
  return data;
}

/** تبديل is_completed */
async function sbToggleIndicator(programId, indicatorId) {
  const inds = indicatorsCache[programId]||[];
  const ind  = inds.find(i=>i.id===indicatorId);
  if (!ind) return;

  const newVal = !ind.is_completed;
  ind.is_completed = newVal; // تحديث optimistic

  if (sb) {
    const { error } = await sb.from('program_indicators')
      .update({ is_completed:newVal })
      .eq('id', indicatorId);
    if (error) { ind.is_completed = !newVal; throw error; }  // rollback
  }
  await syncProgress(programId);
}

/** حذف مؤشر */
async function sbDeleteIndicator(programId, indicatorId) {
  if (sb) {
    const { error } = await sb.from('program_indicators').delete().eq('id', indicatorId);
    if (error) throw error;
  }
  if (indicatorsCache[programId]) {
    indicatorsCache[programId] = indicatorsCache[programId].filter(i=>i.id!==indicatorId);
  }
  await syncProgress(programId);
}

/* ================================================================
   §11 — INIT LOCAL DATA
   ================================================================ */
function initLocalData() {
  if (!lsLoad('sop_initiatives',null)) lsSave('initiatives', DEMO_INITIATIVES);
  if (!lsLoad('sop_tasks',      null)) lsSave('tasks',       DEMO_TASKS);
  if (!lsLoad('sop_kpi',        null)) lsSave('kpi',         DEMO_KPI);
  if (!lsLoad('sop_reports',    null)) lsSave('reports',     DEMO_REPORTS);
  if (!lsLoad('sop_teachers',   null)) lsSave('teachers',    DEMO_TEACHERS);
  if (!lsLoad('sop_settings',   null)) lsSave('settings',    DEMO_SETTINGS);
}

async function resetToDemo() {
  if (!confirm('إعادة تحميل البيانات التجريبية؟')) return;
  ['initiatives','tasks','kpi','reports','teachers','settings'].forEach(k=>lsSave(k,
    k==='initiatives'?DEMO_INITIATIVES:k==='tasks'?DEMO_TASKS:k==='kpi'?DEMO_KPI:
    k==='reports'?DEMO_REPORTS:k==='teachers'?DEMO_TEACHERS:DEMO_SETTINGS));
  await sbFetchPrograms(); loadSettings(); refreshCurrentSection();
  showToast('تمت إعادة التحميل ✅','success');
}

async function clearAllData() {
  if (!confirm('مسح جميع البيانات المحلية؟')) return;
  ['initiatives','tasks','kpi','reports','teachers','settings'].forEach(k=>localStorage.removeItem('sop_'+k));
  Object.keys(localStorage).filter(k=>k.startsWith('sop_pe_')).forEach(k=>localStorage.removeItem(k));
  initLocalData(); await sbFetchPrograms(); loadSettings(); refreshCurrentSection();
  showToast('تم المسح ✅','warning');
}

/* ================================================================
   §12 — LOGIN / LOGOUT
   ================================================================ */

// الدالة القديمة موجودة للتوافق مع HTML القديم
function selectRole() {}

async function doLogin() {
  const eEl = document.getElementById('login-email') || document.getElementById('username');
  const pEl = document.getElementById('login-password') || document.getElementById('password');
  const email = (eEl?.value||'').trim();
  const pass  = (pEl?.value||'').trim();

  if (!email||!pass) { showToast('يرجى إدخال البريد وكلمة المرور','error'); return; }

  const btn = document.getElementById('login-btn');
  if (btn) { btn.disabled=true; btn.textContent='جارٍ التحقق…'; }

  try {
    showLoadingOverlay(true);
    const userData = await sbLogin(email, pass);
    showLoadingOverlay(false);

    if (!userData) {
      showToast('البريد الإلكتروني أو كلمة المرور غير صحيحة','error');
      return;
    }

    // ─── حفظ المستخدم الحالي ───
    currentUser = { id:userData.id, name:userData.name, email:userData.email, role:userData.role };

    // ─── الانتقال لواجهة التطبيق ───
    document.getElementById('login-page').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    applyRoleUI();
    loadSettings();
    await sbFetchPrograms();

    showSection('dashboard', document.querySelector('.nav-item[data-section="dashboard"]'));

  } catch (err) {
    showLoadingOverlay(false);
    showToast('خطأ في تسجيل الدخول: '+err.message,'error');
  } finally {
    if (btn) { btn.disabled=false; btn.textContent='دخول إلى المنصة'; }
  }
}

function doLogout() {
  currentUser     = null;
  programsCache   = [];
  indicatorsCache = {};
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-page').classList.remove('hidden');
  const eEl = document.getElementById('login-email')||document.getElementById('username');
  const pEl = document.getElementById('login-password')||document.getElementById('password');
  if (eEl) eEl.value='';
  if (pEl) pEl.value='';
}

/* ================================================================
   §13 — APPLY ROLE UI
   ================================================================ */
function applyRoleUI() {
  if (!currentUser) return;
  const role = currentUser.role;

  // ─── شارة الدور ───
  const roleAr = { admin:'مدير', vice:'وكيل', teacher:'معلم' };
  const badgeEl = document.getElementById('user-role-badge');
  if (badgeEl) badgeEl.textContent = roleAr[role]||role;

  const nameEl = document.getElementById('header-user-name');
  if (nameEl) nameEl.textContent = currentUser.name;

  const avatarEl = document.querySelector('.avatar');
  if (avatarEl) avatarEl.textContent = currentUser.name.charAt(0);

  // ─── إظهار/إخفاء عناصر الـ nav حسب الدور ───
  const navAllowed = {
    admin  : ['dashboard','programs','plan','kpi','tasks','reports','teachers','calendar','stats','settings','users'],
    vice   : ['dashboard','programs','plan','kpi','tasks','reports','teachers','calendar','stats'],
    teacher: ['dashboard','programs','reports'],
  }[role] || [];

  document.querySelectorAll('.nav-item').forEach(item => {
    item.style.display = navAllowed.includes(item.dataset.section) ? 'flex' : 'none';
  });
}

/* ================================================================
   §14 — SETTINGS
   ================================================================ */
function loadSettings() {
  const s = lsLoad('settings', DEMO_SETTINGS);
  const set = (id,v)=>{ const el=document.getElementById(id); if(el) el.value=v||''; };
  set('setting-school',   s.schoolName);
  set('setting-year',     s.year);
  set('setting-principal',s.principal);
  set('setting-region',   s.region);
  const sn=document.getElementById('sidebar-school-name'); if(sn) sn.textContent=s.schoolName||'';
  const sy=document.getElementById('sidebar-year');        if(sy) sy.textContent=s.year||'';
}

function saveSettings() {
  const g = id => document.getElementById(id)?.value||'';
  const s = { schoolName:g('setting-school'), year:g('setting-year'),
              principal:g('setting-principal'), region:g('setting-region') };
  lsSave('settings',s);
  const sn=document.getElementById('sidebar-school-name'); if(sn) sn.textContent=s.schoolName;
  const sy=document.getElementById('sidebar-year');        if(sy) sy.textContent=s.year;
  showToast('تم حفظ الإعدادات ✅','success');
}

/* ================================================================
   §15 — NAVIGATION
   ================================================================ */
let activeSection = 'dashboard';

async function showSection(name, el) {
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const sec = document.getElementById('section-'+name);
  if (sec) sec.classList.add('active');
  if (el) el.classList.add('active');
  activeSection = name;

  const titles = {
    dashboard:'لوحة التحكم', programs:'برامج الخطة التشغيلية',
    plan:'المبادرات', kpi:'مؤشرات الأداء', tasks:'إدارة المهام',
    reports:'التقارير والشواهد', teachers:'متابعة المعلمات',
    calendar:'التقويم الزمني', stats:'الإحصائيات',
    settings:'الإعدادات', users:'إدارة المستخدمين',
  };
  const titleEl=document.getElementById('section-title');
  if (titleEl) titleEl.textContent=titles[name]||'';

  if (window.innerWidth<=768) {
    document.getElementById('sidebar')?.classList.remove('open');
    document.querySelector('.sidebar-overlay')?.classList.remove('show');
  }

  if (name==='programs') await sbFetchPrograms();
  if (name==='users' && can('manageUsers')) await renderUsersSection();

  renderSection(name);
}

function refreshCurrentSection() { renderSection(activeSection); }

function renderSection(name) {
  ({
    dashboard : renderDashboard,
    programs  : renderPrograms,
    plan      : renderPlan,
    kpi       : renderKPI,
    tasks     : renderTasks,
    reports   : renderReports,
    teachers  : renderTeachers,
    calendar  : renderCalendar,
    stats     : renderStats,
  })[name]?.();
}

/* ================================================================
   §16 — SIDEBAR TOGGLE
   ================================================================ */
function toggleSidebar() {
  const sb2 = document.getElementById('sidebar');
  sb2.classList.toggle('open');
  let ov = document.querySelector('.sidebar-overlay');
  if (!ov) {
    ov=document.createElement('div'); ov.className='sidebar-overlay';
    ov.onclick=()=>{ sb2.classList.remove('open'); ov.classList.remove('show'); };
    document.body.appendChild(ov);
  }
  ov.classList.toggle('show');
}

/* ================================================================
   §17 — STATUS HELPERS
   ================================================================ */
function calcProgramStatus(p) {
  const today=new Date(); today.setHours(0,0,0,0);
  const start=p.start?new Date(p.start):null;
  const end  =p.end  ?new Date(p.end)  :null;
  const pct  =parseInt(p.progress)||0;
  if (pct>=100)                     return 'done';
  if (!start||today<start)          return 'planning';
  if (end&&today>end&&pct<100)      return 'late';
  if (start&&today>=start)          return 'active';
  return 'planning';
}
const STATUS_LABEL  = {planning:'قيد التخطيط',active:'جارٍ التنفيذ',done:'منتهٍ',late:'متأخر'};
const STATUS_BADGE  = {planning:'badge-secondary',active:'badge-info',done:'badge-success',late:'badge-danger'};
const STATUS_ICON   = {planning:'⏳',active:'▶️',done:'✅',late:'⚠️'};
const getStatusLabel= s => STATUS_LABEL[s]||s;
const getStatusBadge= s => STATUS_BADGE[s]||'badge-secondary';
const getStatusIcon = s => STATUS_ICON[s]||'📋';

function autoCalcProgStatus() {
  const fake={
    start   :document.getElementById('prog-start')?.value||'',
    end     :document.getElementById('prog-end')?.value||'',
    progress:parseInt(document.getElementById('prog-progress')?.value)||0,
  };
  const st=calcProgramStatus(fake);
  const d=document.getElementById('prog-status-display'); if(d) d.value=getStatusIcon(st)+' '+getStatusLabel(st);
  const h=document.getElementById('prog-status');         if(h) h.value=st;
}

/* ================================================================
   §18 — PROGRAMS UI
   ================================================================ */
function openProgramModal(id) {
  if (id  && !can('editProgram'))  { showToast('ليس لديك صلاحية تعديل البرامج','error'); return; }
  if (!id && !can('addProgram'))   { showToast('ليس لديك صلاحية إضافة برامج','error'); return; }

  pendingFileData=null; pendingImageData=null;
  const clr=fid=>{ const e=document.getElementById(fid); if(e) e.value=''; };
  ['prog-edit-id','prog-name','prog-resp','prog-desc','prog-target',
   'prog-start','prog-end','prog-progress','prog-status','prog-status-display'].forEach(clr);
  const t=document.getElementById('program-modal-title');
  if(t) t.textContent='إضافة برنامج جديد';

  if (id) {
    const p=programsCache.find(x=>x.id===id); if(!p) return;
    const sv=(fid,v)=>{ const e=document.getElementById(fid); if(e) e.value=v??''; };
    sv('prog-edit-id',p.id); sv('prog-name',p.name); sv('prog-resp',p.resp);
    sv('prog-desc',p.desc); sv('prog-target',p.target);
    sv('prog-start',p.start); sv('prog-end',p.end); sv('prog-progress',p.progress??0);
    if(t) t.textContent='تعديل البرنامج';
    autoCalcProgStatus();
  }
  openModal('program-modal');
}

async function saveProgram() {
  const editId = document.getElementById('prog-edit-id')?.value;
  if (editId && !can('editProgram')) { showToast('ليس لديك صلاحية تعديل البرامج','error'); return; }
  if (!editId && !can('addProgram')) { showToast('ليس لديك صلاحية إضافة برامج','error'); return; }

  const g  = id => document.getElementById(id)?.value||'';
  const name = g('prog-name').trim();
  const resp = g('prog-resp').trim();
  if (!name) { showToast('يرجى إدخال اسم البرنامج','error'); return; }
  if (!resp) { showToast('يرجى إدخال اسم المسؤول','error'); return; }

  const p = {
    id      : editId||null, name, resp,
    desc    : g('prog-desc').trim(),
    target  : g('prog-target').trim(),
    start   : g('prog-start'), end:g('prog-end'),
    progress: parseInt(g('prog-progress'))||0,
    evidence: [],
  };

  const btn=document.querySelector('#program-modal .btn-primary');
  if(btn){ btn.disabled=true; btn.textContent='جارٍ الحفظ…'; }

  try {
    let saved;
    if (editId) {
      const ex=programsCache.find(x=>x.id===editId);
      p.evidence=ex?.evidence||[];
      saved=await sbUpdateProgram(p);
      const i=programsCache.findIndex(x=>x.id===saved.id);
      if(i!==-1) programsCache[i]=saved;
    } else {
      saved=await sbInsertProgram(p);
      saved.indicators=[]; programsCache.push(saved);
    }
    closeModal('program-modal');
    renderPrograms();
    showToast(editId?'تم تعديل البرنامج ✅':'تمت إضافة البرنامج ✅','success');
  } catch(err) {
    console.error('[saveProgram]',err.message);
    showToast('خطأ في الحفظ: '+err.message,'error');
  } finally {
    if(btn){ btn.disabled=false; btn.textContent='💾 حفظ البرنامج'; }
  }
}

async function deleteProgram(id) {
  if (!can('deleteProgram')) { showToast('ليس لديك صلاحية حذف البرامج','error'); return; }
  if (!confirm('حذف هذا البرنامج وجميع مؤشراته وشواهده؟')) return;
  try {
    await sbDeleteProgram(id);
    programsCache=programsCache.filter(p=>p.id!==id);
    renderPrograms();
    showToast('تم حذف البرنامج 🗑️','warning');
  } catch(err) { showToast('خطأ في الحذف: '+err.message,'error'); }
}

/* ================================================================
   §19 — PROGRAMS GRID RENDER
   ================================================================ */
function renderPrograms() {
  const programs     = programsCache;
  const filterStatus = document.getElementById('prog-filter-status')?.value||'all';
  const searchVal    = (document.getElementById('prog-search')?.value||'').toLowerCase();

  // إحصائيات
  const total=programs.length;
  const cnt={planning:0,active:0,done:0,late:0};
  programs.forEach(p=>{ const s=calcProgramStatus(p); cnt[s]=(cnt[s]||0)+1; });
  const avg=total?Math.round(programs.reduce((s,p)=>s+(p.progress||0),0)/total):0;

  const stEl=document.getElementById('programs-stats');
  if(stEl) stEl.innerHTML=`
    <div class="stat-card"><span class="stat-icon">🗂️</span><span class="stat-number">${total}</span><span class="stat-label">إجمالي البرامج</span></div>
    <div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${cnt.done}</span><span class="stat-label">برامج منتهية</span></div>
    <div class="stat-card"><span class="stat-icon">▶️</span><span class="stat-number">${cnt.active}</span><span class="stat-label">برامج جارية</span></div>
    <div class="stat-card red"><span class="stat-icon">⚠️</span><span class="stat-number">${cnt.late}</span><span class="stat-label">برامج متأخرة</span></div>
    <div class="stat-card gold"><span class="stat-icon">📊</span><span class="stat-number">${avg}%</span><span class="stat-label">متوسط الإنجاز</span></div>`;

  // إخفاء زر الإضافة للمعلم
  const addBtn=document.getElementById('btn-add-program');
  if(addBtn) addBtn.style.display=can('addProgram')?'':'none';

  // فلترة
  const filtered=programs.filter(p=>{
    const ms=filterStatus==='all'||calcProgramStatus(p)===filterStatus;
    const mq=!searchVal||p.name.toLowerCase().includes(searchVal)||(p.resp||'').toLowerCase().includes(searchVal);
    return ms&&mq;
  });

  const grid=document.getElementById('programs-grid'); if(!grid) return;
  if(!filtered.length){
    grid.innerHTML=`<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🗂️</div><p>لا توجد برامج مطابقة</p><small>غيّر الفلتر أو أضف برنامجاً جديداً</small></div>`;
    return;
  }
  grid.innerHTML=filtered.map(p=>buildProgramCard(p)).join('');
}

function buildProgramCard(p) {
  const status = calcProgramStatus(p);
  const pct    = parseInt(p.progress)||0;
  const inds   = p.indicators || indicatorsCache[p.id] || [];
  const evs    = p.evidence   || [];
  const clr    = pct>=90?'#27ae60':pct>=60?'#2e86c1':pct>=30?'#f39c12':'#e74c3c';
  const total  = inds.length;
  const done   = inds.filter(i=>i.is_completed).length;

  /* ── مؤشرات الإنجاز ── */
  const indsHtml = total
    ? inds.map(ind => {
        const done1 = ind.is_completed;
        const tgl   = can('toggleIndicator');
        const del   = can('deleteIndicator');
        return `<div class="indicator-row" id="irow-${ind.id}">
          <button class="ind-toggle ${done1?'ind-check-done':'ind-check-empty'}"
            ${tgl?`onclick="handleToggle('${p.id}','${ind.id}')"`:' disabled'}
            title="${done1?'إلغاء الإنجاز':'وضع علامة مكتمل'}">${done1?'✅':'⬜'}</button>
          <span class="ind-text" style="${done1?'text-decoration:line-through;color:var(--text-muted)':''}">${ind.indicator_text}</span>
          ${del?`<button class="ind-delete" onclick="handleDelInd('${p.id}','${ind.id}')" title="حذف">✕</button>`:''}
        </div>`;
      }).join('')
    : `<div style="font-size:12px;color:var(--text-muted);padding:4px 0">لا توجد مؤشرات بعد</div>`;

  /* ── حقل إضافة مؤشر ── */
  const addIndHtml = can('addIndicator') ? `
    <div class="add-indicator-row">
      <input id="iinput-${p.id}" class="ind-input" type="text"
             placeholder="أضف مؤشر إنجاز…"
             onkeydown="if(event.key==='Enter')handleAddInd('${p.id}')"/>
      <button class="btn-sm btn-evidence" onclick="handleAddInd('${p.id}')">+</button>
    </div>` : '';

  /* ── الشواهد ── */
  const evHtml = evs.length
    ? evs.map(ev=>{
        const icon=getEvIcon(ev.type);
        const href=ev.link?`href="${ev.link}" target="_blank"`:'';
        const tag =ev.link?'a':'span';
        const del =can('deleteEvidence')?`<span class="ev-delete" onclick="event.preventDefault();event.stopPropagation();handleDelEv('${p.id}','${ev.id}')" title="حذف">✕</span>`:'';
        return `<${tag} class="evidence-chip${ev.link?'':' no-link'}" ${href}>${icon} ${ev.title}${del}</${tag}>`;
      }).join('')
    : `<span style="font-size:12px;color:var(--text-muted)">لا توجد شواهد بعد</span>`;

  /* ── أزرار الإجراءات حسب الدور ── */
  const editBtn   = can('editProgram')   ? `<button class="btn-sm btn-edit"   onclick="openProgramModal('${p.id}')">✏️ تعديل</button>`  : '';
  const delBtn    = can('deleteProgram') ? `<button class="btn-sm btn-delete" onclick="deleteProgram('${p.id}')">🗑️ حذف</button>`     : '';
  const addEvBtn  = can('addEvidence')   ? `<button class="btn-sm btn-evidence" onclick="openEvidenceModal('${p.id}')">+ شاهد</button>` : '';

  return `
  <div class="program-card status-${status}" id="pcard-${p.id}">
    <div class="program-card-header">
      <div class="program-card-title">${p.name}</div>
      <span class="badge ${getStatusBadge(status)}">${getStatusIcon(status)} ${getStatusLabel(status)}</span>
    </div>
    <div class="program-card-body">
      ${p.desc?`<div class="program-card-desc">${p.desc}</div>`:''}
      <div class="program-meta-grid">
        <div class="program-meta-item">👩‍🏫 <strong>${p.resp||'—'}</strong></div>
        <div class="program-meta-item">🎯 <strong>${p.target||'—'}</strong></div>
        <div class="program-meta-item">📅 <strong>${formatDate(p.start)}</strong></div>
        <div class="program-meta-item">🏁 <strong>${formatDate(p.end)}</strong></div>
      </div>

      <!-- شريط التقدم -->
      <div class="program-progress-section">
        <div class="program-progress-label">
          <span id="plbl-${p.id}">نسبة الإنجاز${total?' ('+done+'/'+total+' مؤشر)':''}</span>
          <span id="ppct-${p.id}" style="font-weight:800;color:${clr}">${pct}%</span>
        </div>
        <div class="progress-bar" style="height:10px">
          <div id="pbar-${p.id}" class="progress-fill"
               style="width:${pct}%;background:linear-gradient(90deg,${clr},${clr}cc)"></div>
        </div>
      </div>

      <!-- مؤشرات الإنجاز -->
      <div class="program-indicators">
        <div class="program-indicators-title">📌 مؤشرات الإنجاز</div>
        <div class="indicators-list" id="ilist-${p.id}">${indsHtml}</div>
        ${addIndHtml}
      </div>

      <!-- الشواهد -->
      <div class="program-evidence-section">
        <div class="program-evidence-title">
          <span>📎 الشواهد (${evs.length})</span>${addEvBtn}
        </div>
        <div class="evidence-chips" id="echips-${p.id}">${evHtml}</div>
      </div>
    </div>
    <div class="program-card-actions">
      <button class="btn-sm btn-detail" onclick="viewProgramDetail('${p.id}')">👁️ التفاصيل</button>
      ${editBtn}${delBtn}
    </div>
  </div>`;
}

/* ================================================================
   §20 — INDICATOR HANDLERS (داخل البطاقة)
   ================================================================ */
async function handleAddInd(programId) {
  if (!can('addIndicator')) { showToast('ليس لديك صلاحية إضافة مؤشرات','error'); return; }
  const inp = document.getElementById('iinput-'+programId); if (!inp) return;
  const txt = inp.value.trim();
  if (!txt) { showToast('أدخل نص المؤشر أولاً','error'); return; }
  inp.disabled = true;
  try {
    await sbAddIndicator(programId, txt);
    inp.value = '';
    repaintCard(programId);
    showToast('تمت إضافة المؤشر ✅','success');
  } catch(err) { showToast('خطأ: '+err.message,'error'); }
  finally { inp.disabled=false; inp.focus(); }
}

async function handleToggle(programId, indicatorId) {
  // المعلم: يستطيع التبديل فقط في برامج هو المسؤول عنها
  if (currentUser.role==='teacher') {
    const prog=programsCache.find(p=>p.id===programId);
    if (prog?.resp && !prog.resp.includes(currentUser.name)) {
      showToast('يمكنك تحديث مؤشرات برامجك أنت فقط','error'); return;
    }
  }
  try {
    await sbToggleIndicator(programId, indicatorId);
    repaintCard(programId);
  } catch(err) { showToast('خطأ: '+err.message,'error'); }
}

async function handleDelInd(programId, indicatorId) {
  if (!can('deleteIndicator')) { showToast('ليس لديك صلاحية حذف مؤشرات','error'); return; }
  if (!confirm('حذف هذا المؤشر؟')) return;
  try {
    await sbDeleteIndicator(programId, indicatorId);
    repaintCard(programId);
    showToast('تم الحذف 🗑️','warning');
  } catch(err) { showToast('خطأ: '+err.message,'error'); }
}

/**
 * repaintCard — يُحدّث بطاقة برنامج واحدة دون إعادة رسم الشبكة كاملاً.
 * يعمل عبر إعادة بناء innerHTML لعناصر محددة.
 */
function repaintCard(programId) {
  const p    = programsCache.find(x=>x.id===programId); if (!p) return;
  const inds = indicatorsCache[programId]||[];
  p.indicators = inds;

  const pct   = parseInt(p.progress)||0;
  const total = inds.length;
  const done  = inds.filter(i=>i.is_completed).length;
  const clr   = pct>=90?'#27ae60':pct>=60?'#2e86c1':pct>=30?'#f39c12':'#e74c3c';

  // شريط التقدم
  const pctEl =document.getElementById('ppct-'+programId);
  const barEl =document.getElementById('pbar-'+programId);
  const lblEl =document.getElementById('plbl-'+programId);
  if(pctEl){ pctEl.textContent=pct+'%'; pctEl.style.color=clr; }
  if(barEl){ barEl.style.width=pct+'%'; barEl.style.background=`linear-gradient(90deg,${clr},${clr}cc)`; }
  if(lblEl) lblEl.textContent=`نسبة الإنجاز${total?' ('+done+'/'+total+' مؤشر)':''}`;

  // حالة البطاقة
  const cardEl=document.getElementById('pcard-'+programId);
  if(cardEl){
    cardEl.className='program-card status-'+calcProgramStatus(p);
    const badgeEl=cardEl.querySelector('.badge');
    const st=calcProgramStatus(p);
    if(badgeEl){ badgeEl.className='badge '+getStatusBadge(st); badgeEl.textContent=getStatusIcon(st)+' '+getStatusLabel(st); }
  }

  // قائمة المؤشرات
  const listEl=document.getElementById('ilist-'+programId); if(!listEl) return;
  if(!inds.length){ listEl.innerHTML='<div style="font-size:12px;color:var(--text-muted);padding:4px 0">لا توجد مؤشرات بعد</div>'; return; }
  listEl.innerHTML=inds.map(ind=>{
    const done1=ind.is_completed;
    const tgl=can('toggleIndicator');
    const del=can('deleteIndicator');
    return `<div class="indicator-row" id="irow-${ind.id}">
      <button class="ind-toggle ${done1?'ind-check-done':'ind-check-empty'}"
        ${tgl?`onclick="handleToggle('${programId}','${ind.id}')"`:' disabled'}
        title="${done1?'إلغاء الإنجاز':'وضع علامة مكتمل'}">${done1?'✅':'⬜'}</button>
      <span class="ind-text" style="${done1?'text-decoration:line-through;color:var(--text-muted)':''}">${ind.indicator_text}</span>
      ${del?`<button class="ind-delete" onclick="handleDelInd('${programId}','${ind.id}')" title="حذف">✕</button>`:''}
    </div>`;
  }).join('');
}

/* ================================================================
   §21 — PROGRAM DETAIL MODAL
   ================================================================ */
function viewProgramDetail(id) {
  const p=programsCache.find(x=>x.id===id); if(!p) return;
  const st=calcProgramStatus(p);
  const pct=parseInt(p.progress)||0;
  const clr=pct>=90?'#27ae60':pct>=60?'#2e86c1':pct>=30?'#f39c12':'#e74c3c';
  const inds=indicatorsCache[id]||p.indicators||[];
  const evs=p.evidence||[];

  const titleEl=document.getElementById('detail-modal-title');
  if(titleEl) titleEl.textContent=p.name;

  const indsHtml=inds.length
    ? inds.map(ind=>`
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-light)">
        <span style="font-size:18px">${ind.is_completed?'✅':'⬜'}</span>
        <span style="font-size:13px;${ind.is_completed?'text-decoration:line-through;color:var(--text-muted)':''}">${ind.indicator_text}</span>
      </div>`).join('')
    : '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">لا توجد مؤشرات</p>';

  const evHtml=evs.length
    ? evs.map(ev=>{
        const icon=getEvIcon(ev.type);
        const delBtn=can('deleteEvidence')
          ?`<button class="btn-sm btn-delete" onclick="handleDelEv('${p.id}','${ev.id}');closeModal('program-detail-modal');viewProgramDetail('${p.id}')">🗑️</button>`
          :'';
        return `<div class="evidence-detail-item">
          <div class="ev-det-icon">${icon}</div>
          <div class="ev-det-info">
            <div class="ev-det-title">${ev.title}</div>
            <div class="ev-det-meta">${ev.person||''} · ${formatDate(ev.date)} · ${getEvTypeLabel(ev.type)}</div>
            ${ev.notes?`<div class="ev-det-meta" style="font-style:italic">${ev.notes}</div>`:''}
          </div>
          <div class="ev-det-actions">
            ${ev.link?`<a href="${ev.link}" target="_blank" class="btn-sm btn-view">🔗 فتح</a>`:''}
            ${ev.type==='image'&&ev.imageData?`<button class="btn-sm btn-view" onclick="viewImage('${ev.imageData}')">🖼️ عرض</button>`:''}
            ${delBtn}
          </div>
        </div>`;
      }).join('')
    : '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">لا توجد شواهد</p>';

  const addEvBtn=can('addEvidence')
    ?`<button class="btn-primary" style="font-size:12px;padding:6px 14px" onclick="openEvidenceModal('${p.id}');closeModal('program-detail-modal')">+ إضافة شاهد</button>`:'';

  const bodyEl=document.getElementById('program-detail-body'); if(!bodyEl) return;
  bodyEl.innerHTML=`
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;padding:16px;background:var(--bg);border-radius:10px">
      <div style="flex:1">
        <div style="font-size:14px;color:var(--text-muted);margin-bottom:4px">حالة التنفيذ</div>
        <span class="badge ${getStatusBadge(st)}" style="font-size:13px">${getStatusIcon(st)} ${getStatusLabel(st)}</span>
      </div>
      <div style="text-align:center">
        <div style="font-size:28px;font-weight:800;color:${clr}">${pct}%</div>
        <div style="font-size:12px;color:var(--text-muted)">نسبة الإنجاز</div>
      </div>
    </div>
    <div style="margin-bottom:16px">
      <div class="progress-bar" style="height:12px;border-radius:6px">
        <div class="progress-fill" style="width:${pct}%;background:linear-gradient(90deg,${clr},${clr}cc)"></div>
      </div>
    </div>
    <div class="detail-section">
      <h4>📋 بيانات البرنامج</h4>
      <div class="detail-grid">
        <div class="detail-item"><div class="detail-item-label">المسؤول</div><div class="detail-item-value">${p.resp||'—'}</div></div>
        <div class="detail-item"><div class="detail-item-label">الفئة المستهدفة</div><div class="detail-item-value">${p.target||'—'}</div></div>
        <div class="detail-item"><div class="detail-item-label">تاريخ البدء</div><div class="detail-item-value">${formatDate(p.start)}</div></div>
        <div class="detail-item"><div class="detail-item-label">تاريخ الانتهاء</div><div class="detail-item-value">${formatDate(p.end)}</div></div>
      </div>
      ${p.desc?`<div style="margin-top:12px;padding:12px 14px;background:var(--bg);border-radius:8px;font-size:13px;line-height:1.7">${p.desc}</div>`:''}
    </div>
    <div class="detail-section">
      <h4>📌 مؤشرات الإنجاز (${inds.filter(i=>i.is_completed).length}/${inds.length})</h4>
      ${indsHtml}
    </div>
    <div class="detail-section">
      <h4 style="display:flex;justify-content:space-between;align-items:center">
        📎 الشواهد (${evs.length}) ${addEvBtn}
      </h4>
      <div class="evidence-list-detail">${evHtml}</div>
    </div>`;

  openModal('program-detail-modal');
}

function viewImage(b64) { const w=window.open(''); w.document.write(`<img src="${b64}" style="max-width:100%;height:auto">`); }

/* ================================================================
   §22 — EVIDENCE
   ================================================================ */
const getEvIcon      = t => ({link:'🔗',file:'📎',image:'🖼️',pdf:'📄',word:'📝',excel:'📊'}[t]||'📎');
const getEvTypeLabel = t => ({link:'رابط خارجي',file:'ملف',image:'صورة',pdf:'PDF',word:'Word',excel:'Excel'}[t]||t);
// alias للتوافق
const getEvidenceIcon      = getEvIcon;
const getEvidenceTypeLabel = getEvTypeLabel;

function toggleEvidenceInput() {
  const type=document.getElementById('ev-type')?.value;
  document.getElementById('ev-link-group')?.classList.toggle('hidden', type!=='link');
  document.getElementById('ev-file-group')?.classList.toggle('hidden', type!=='file');
  document.getElementById('ev-image-group')?.classList.toggle('hidden',type!=='image');
  pendingFileData=null; pendingImageData=null;
  ['ev-file-preview','ev-image-preview'].forEach(id=>{
    const el=document.getElementById(id); if(el){el.classList.add('hidden');el.innerHTML='';}
  });
}

function openEvidenceModal(programId, evidenceId) {
  if (!can('addEvidence')) { showToast('ليس لديك صلاحية رفع الشواهد','error'); return; }
  pendingFileData=null; pendingImageData=null;
  document.getElementById('ev-program-id').value = programId;
  document.getElementById('ev-edit-id').value    = evidenceId||'';
  const t=document.getElementById('evidence-modal-title');
  if(t) t.textContent=evidenceId?'تعديل الشاهد':'إضافة شاهد';
  ['ev-title','ev-link','ev-person','ev-notes'].forEach(f=>{const e=document.getElementById(f);if(e)e.value='';});
  const typeEl=document.getElementById('ev-type'); if(typeEl) typeEl.value='link';
  toggleEvidenceInput();

  if (evidenceId) {
    const p=programsCache.find(x=>x.id===programId);
    const ev=(p?.evidence||[]).find(e=>e.id===evidenceId);
    if(ev){
      const sv=(id,v)=>{const e=document.getElementById(id);if(e)e.value=v||'';};
      sv('ev-title',ev.title);sv('ev-type',ev.type);sv('ev-link',ev.link);
      sv('ev-person',ev.person);sv('ev-notes',ev.notes);
      toggleEvidenceInput();
    }
  }
  openModal('evidence-modal');
}

function saveEvidence() {
  if (!can('addEvidence')) { showToast('ليس لديك صلاحية رفع الشواهد','error'); return; }
  const g   = id=>(document.getElementById(id)?.value||'');
  const progId=g('ev-program-id');
  const editId=g('ev-edit-id');
  const title =g('ev-title').trim();
  const type  =g('ev-type');
  if (!title) { showToast('يرجى إدخال عنوان الشاهد','error'); return; }

  const ev={
    id       : editId||('ev_'+Date.now()),
    title, type,
    link     : type==='link'?(g('ev-link').trim()):'',
    fileData : type==='file' ?(pendingFileData?.base64||null):null,
    fileName : type==='file' ?(pendingFileData?.name||null):null,
    imageData: type==='image'?(pendingImageData?.base64||null):null,
    imageName: type==='image'?(pendingImageData?.name||null):null,
    person   : g('ev-person').trim(),
    date     : new Date().toISOString().split('T')[0],
    notes    : g('ev-notes').trim(),
  };

  const pIdx=programsCache.findIndex(p=>p.id===progId||p.id===parseInt(progId));
  if(pIdx===-1){ showToast('البرنامج غير موجود','error'); return; }
  if(!programsCache[pIdx].evidence) programsCache[pIdx].evidence=[];

  if(editId){
    const i=programsCache[pIdx].evidence.findIndex(e=>e.id===editId);
    if(i!==-1) programsCache[pIdx].evidence[i]=ev; else programsCache[pIdx].evidence.push(ev);
  } else {
    programsCache[pIdx].evidence.push(ev);
  }
  saveProgExtra(programsCache[pIdx].id, programsCache[pIdx]);
  closeModal('evidence-modal');
  renderPrograms();
  showToast('تم حفظ الشاهد ✅','success');
}

function handleDelEv(progId, evId) {
  if (!can('deleteEvidence')) { showToast('ليس لديك صلاحية حذف الشواهد','error'); return; }
  if (!confirm('حذف هذا الشاهد؟')) return;
  const pIdx=programsCache.findIndex(p=>p.id===progId||p.id===parseInt(progId));
  if(pIdx===-1) return;
  programsCache[pIdx].evidence=(programsCache[pIdx].evidence||[]).filter(e=>e.id!==evId);
  saveProgExtra(programsCache[pIdx].id, programsCache[pIdx]);
  renderPrograms();
  showToast('تم حذف الشاهد 🗑️','warning');
}
// alias
function deleteEvidence(a,b){ handleDelEv(a,b); }

function handleFileSelect(input) {
  const file=input.files[0]; if(!file) return;
  if(file.size>5*1024*1024){showToast('الملف أكبر من 5 MB','error');input.value='';return;}
  const reader=new FileReader();
  reader.onload=e=>{
    pendingFileData={name:file.name,mimeType:file.type,base64:e.target.result};
    const prev=document.getElementById('ev-file-preview'); if(!prev) return;
    prev.classList.remove('hidden');
    prev.innerHTML=`<span style="font-size:20px">${getFileIcon(file.name)}</span>
      <span class="file-name">${file.name}</span>
      <span style="font-size:11px;color:var(--text-muted)">${(file.size/1024).toFixed(0)} KB</span>
      <span class="file-remove" onclick="pendingFileData=null;document.getElementById('ev-file-input').value='';this.parentElement.classList.add('hidden')">✕</span>`;
  };
  reader.readAsDataURL(file);
}

function handleImageSelect(input) {
  const file=input.files[0]; if(!file) return;
  if(file.size>5*1024*1024){showToast('الصورة أكبر من 5 MB','error');input.value='';return;}
  const reader=new FileReader();
  reader.onload=e=>{
    pendingImageData={name:file.name,base64:e.target.result};
    const prev=document.getElementById('ev-image-preview'); if(!prev) return;
    prev.classList.remove('hidden');
    prev.innerHTML=`<img src="${e.target.result}" alt="${file.name}"/>`;
  };
  reader.readAsDataURL(file);
}

function getFileIcon(name) {
  const ext=name.split('.').pop().toLowerCase();
  return ext==='pdf'?'📄':ext==='doc'||ext==='docx'?'📝':ext==='xls'||ext==='xlsx'?'📊':'📎';
}

/* ================================================================
   §23 — USERS MANAGEMENT (admin only)
   ================================================================ */
async function renderUsersSection() {
  if (!can('manageUsers')) return;
  const sec=document.getElementById('section-users'); if(!sec) return;
  const users=await sbFetchUsers();
  const RL={admin:'مدير',vice:'وكيل',teacher:'معلم'};
  const RB={admin:'badge-danger',vice:'badge-info',teacher:'badge-success'};

  sec.innerHTML=`
    <div class="section-top">
      <h2>إدارة المستخدمين</h2>
      <button class="btn-primary" onclick="openAddUserModal()">+ إضافة مستخدم</button>
    </div>
    <div class="table-wrapper">
      <table class="data-table">
        <thead><tr><th>#</th><th>الاسم</th><th>البريد الإلكتروني</th><th>الدور</th><th>تاريخ الإضافة</th><th>إجراءات</th></tr></thead>
        <tbody>
          ${users.map((u,i)=>`
            <tr>
              <td>${i+1}</td>
              <td style="font-weight:700">${u.name}</td>
              <td style="direction:ltr;text-align:right">${u.email}</td>
              <td><span class="badge ${RB[u.role]||'badge-secondary'}">${RL[u.role]||u.role}</span></td>
              <td>${formatDate(u.created_at)}</td>
              <td>
                <div style="display:flex;gap:6px;align-items:center">
                  <select class="task-status-select" onchange="handleChgRole('${u.id}',this.value)">
                    <option value="admin"   ${u.role==='admin'  ?'selected':''}>مدير</option>
                    <option value="vice"    ${u.role==='vice'   ?'selected':''}>وكيل</option>
                    <option value="teacher" ${u.role==='teacher'?'selected':''}>معلم</option>
                  </select>
                  ${u.id!==currentUser?.id
                    ?`<button class="btn-sm btn-delete" onclick="handleDelUser('${u.id}','${u.name}')">🗑️</button>`
                    :'<span style="font-size:12px;color:var(--text-muted)">أنت</span>'}
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div id="add-user-modal" class="modal-overlay hidden">
      <div class="modal">
        <div class="modal-header">
          <h3>إضافة مستخدم جديد</h3>
          <button onclick="closeModal('add-user-modal')">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label>الاسم الكامل</label><input type="text"     id="nu-name"  placeholder="الاسم الكامل"/></div>
          <div class="form-group"><label>البريد الإلكتروني</label><input type="email" id="nu-email" placeholder="email@school.sa"/></div>
          <div class="form-group"><label>كلمة المرور</label><input type="password" id="nu-pass"  placeholder="كلمة المرور"/></div>
          <div class="form-group"><label>الدور</label>
            <select id="nu-role">
              <option value="teacher">معلم</option>
              <option value="vice">وكيل</option>
              <option value="admin">مدير</option>
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-primary" onclick="handleAddUser()">💾 إضافة</button>
          <button class="btn-secondary" onclick="closeModal('add-user-modal')">إلغاء</button>
        </div>
      </div>
    </div>`;
}

function openAddUserModal() { openModal('add-user-modal'); }

async function handleAddUser() {
  const g=id=>(document.getElementById(id)?.value||'').trim();
  const name=g('nu-name'),email=g('nu-email'),pass=g('nu-pass'),role=g('nu-role');
  if(!name||!email||!pass){ showToast('يرجى تعبئة جميع الحقول','error'); return; }
  try {
    await sbInsertUser({name,email,password:pass,role});
    closeModal('add-user-modal');
    showToast('تمت إضافة المستخدم ✅','success');
    await renderUsersSection();
  } catch(err){ showToast('خطأ: '+err.message,'error'); }
}

async function handleDelUser(id,name) {
  if(!confirm(`حذف المستخدم "${name}"؟`)) return;
  try{
    await sbDeleteUser(id);
    showToast('تم الحذف 🗑️','warning');
    await renderUsersSection();
  }catch(err){ showToast('خطأ: '+err.message,'error'); }
}

async function handleChgRole(id,role) {
  try{
    await sbUpdateUserRole(id,role);
    showToast('تم تعديل الدور ✅','success');
  }catch(err){ showToast('خطأ: '+err.message,'error'); }
}

/* ================================================================
   §24 — DASHBOARD
   ================================================================ */
function renderDashboard() {
  const progs  = programsCache;
  const tasks  = lsLoad('tasks',[]);
  const reps   = lsLoad('reports',[]);
  const kpi    = lsLoad('kpi',[]);
  const avg    = progs.length?Math.round(progs.reduce((s,p)=>s+(p.progress||0),0)/progs.length):0;
  const doneP  = progs.filter(p=>calcProgramStatus(p)==='done').length;
  const lateT  = tasks.filter(t=>t.status!=='done'&&t.due&&new Date(t.due)<new Date()).length;
  const avgKPI = kpi.length?Math.round(kpi.reduce((s,k)=>s+Math.min(100,Math.round((k.achieved/k.target)*100)),0)/kpi.length):0;
  const totalEv= progs.reduce((s,p)=>s+(p.evidence||[]).length,0)+reps.length;

  const dsEl=document.getElementById('dashboard-stats'); if(!dsEl) return;
  dsEl.innerHTML=`
    <div class="stat-card"><span class="stat-icon">🗂️</span><span class="stat-number">${progs.length}</span><span class="stat-label">إجمالي البرامج</span></div>
    <div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${doneP}</span><span class="stat-label">برامج منتهية</span></div>
    <div class="stat-card gold"><span class="stat-icon">📊</span><span class="stat-number">${avg}%</span><span class="stat-label">متوسط الإنجاز</span></div>
    <div class="stat-card red"><span class="stat-icon">⏰</span><span class="stat-number">${lateT}</span><span class="stat-label">مهام متأخرة</span></div>
    <div class="stat-card purple"><span class="stat-icon">📎</span><span class="stat-number">${totalEv}</span><span class="stat-label">شواهد مرفوعة</span></div>
    <div class="stat-card teal"><span class="stat-icon">🎯</span><span class="stat-number">${avgKPI}%</span><span class="stat-label">متوسط KPI</span></div>`;

  const upcoming=tasks.filter(t=>t.status!=='done').sort((a,b)=>new Date(a.due)-new Date(b.due)).slice(0,5);
  const upEl=document.getElementById('upcoming-tasks-list');
  if(upEl) upEl.innerHTML=upcoming.length
    ?'<div class="upcoming-list">'+upcoming.map(t=>{
        const isLate=t.due&&new Date(t.due)<new Date();
        return`<div class="upcoming-item"><div class="upcoming-dot ${t.priority}"></div><div class="upcoming-info"><div class="upcoming-name">${t.name}</div><div class="upcoming-due">${isLate?'⚠️ متأخرة — ':''}${formatDate(t.due)} · ${t.resp}</div></div></div>`;
      }).join('')+'</div>'
    :'<p style="padding:16px;color:var(--text-muted);text-align:center">لا توجد مهام قادمة</p>';

  const ipEl=document.getElementById('initiatives-progress');
  if(ipEl) ipEl.innerHTML='<div class="initiatives-progress-list">'+progs.map(p=>`
    <div class="ini-progress-item">
      <span class="ini-progress-name">${p.name}</span>
      <div class="ini-progress-bar"><div class="progress-bar"><div class="progress-fill" style="width:${p.progress||0}%"></div></div></div>
      <span class="progress-text">${p.progress||0}%</span>
    </div>`).join('')+'</div>';

  setTimeout(()=>drawPieChart(progs),50);
}

function drawPieChart(programs) {
  const canvas=document.getElementById('initiatives-chart'); if(!canvas) return;
  const ctx=canvas.getContext('2d');const W=canvas.width,H=canvas.height; ctx.clearRect(0,0,W,H);
  const cnt={'منتهٍ':0,'جارٍ التنفيذ':0,'قيد التخطيط':0,'متأخر':0};
  programs.forEach(p=>{const s=calcProgramStatus(p);if(s==='done')cnt['منتهٍ']++;else if(s==='active')cnt['جارٍ التنفيذ']++;else if(s==='planning')cnt['قيد التخطيط']++;else cnt['متأخر']++;});
  const colors=['#27ae60','#2e86c1','#95a5a6','#e74c3c'];
  const labels=Object.keys(cnt),values=Object.values(cnt),total=values.reduce((a,b)=>a+b,0);
  if(!total) return;
  const cx=W/2,cy=H/2-15,r=Math.min(W,H)/2-30; let sa=-Math.PI/2;
  values.forEach((v,i)=>{if(!v)return;const sl=(v/total)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,sa,sa+sl);ctx.closePath();ctx.fillStyle=colors[i];ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=2;ctx.stroke();const mid=sa+sl/2;ctx.fillStyle='white';ctx.font='bold 12px Tajawal';ctx.textAlign='center';ctx.fillText(v,cx+(r*.65)*Math.cos(mid),cy+(r*.65)*Math.sin(mid)+5);sa+=sl;});
  let li=0;labels.forEach((l,i)=>{if(!values[i])return;const x=10+(li%2)*(W/2),y=H-48+Math.floor(li/2)*20;ctx.fillStyle=colors[i];ctx.fillRect(x,y,12,12);ctx.fillStyle='#333';ctx.font='11px Tajawal';ctx.textAlign='right';ctx.fillText(l+' ('+values[i]+')',x+W/2-18,y+10);li++;});
}

/* ================================================================
   §25 — PLAN (INITIATIVES)
   ================================================================ */
let planFilter='all', planSearch='';
function filterPlan(v){planFilter=v;renderPlan();}
function searchPlan(v){planSearch=v.toLowerCase();renderPlan();}

function renderPlan(){
  let data=lsLoad('initiatives',[]);
  const MAP={academic:'تحسين التحصيل الدراسي',discipline:'تعزيز الانضباط',professional:'التنمية المهنية',community:'الشراكة المجتمعية',identity:'تعزيز الهوية الوطنية'};
  if(planFilter!=='all'&&MAP[planFilter]) data=data.filter(i=>i.goal===MAP[planFilter]);
  if(planSearch) data=data.filter(i=>(i.name+i.goal+i.resp+i.desc).toLowerCase().includes(planSearch));
  const tbody=document.getElementById('plan-tbody'); if(!tbody) return;
  tbody.innerHTML=data.length?data.map((ini,idx)=>`
    <tr><td>${idx+1}</td>
      <td><span class="badge ${GOAL_BADGE[ini.goal]||'badge-secondary'}">${ini.goal}</span></td>
      <td style="font-weight:600">${ini.name}</td><td>${ini.resp}</td>
      <td>${formatDate(ini.start)}</td><td>${formatDate(ini.end)}</td>
      <td><span class="badge ${STATUS_BADGE_MAP[ini.status]||'badge-secondary'}">${ini.status}</span></td>
      <td><div class="progress-wrap"><div class="progress-bar" style="min-width:70px"><div class="progress-fill" style="width:${ini.progress||0}%"></div></div><span class="progress-text">${ini.progress||0}%</span></div></td>
      <td>${ini.link?`<a href="${ini.link}" target="_blank" class="btn-sm btn-view">📎 عرض</a>`:'—'}</td>
      <td><div style="display:flex;gap:4px"><button class="btn-sm btn-edit" onclick="editInitiative(${ini.id})">✏️</button><button class="btn-sm btn-delete" onclick="deleteInitiative(${ini.id})">🗑️</button></div></td>
    </tr>`).join('')
    :'<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-muted)">لا توجد بيانات</td></tr>';
}
const GOAL_BADGE={'تحسين التحصيل الدراسي':'badge-info','تعزيز الانضباط':'badge-warning','التنمية المهنية':'badge-purple','الشراكة المجتمعية':'badge-success','تعزيز الهوية الوطنية':'badge-secondary','متابعة الفاقد التعليمي':'badge-danger'};
const STATUS_BADGE_MAP={'منجزة':'badge-success','قيد التنفيذ':'badge-info','لم تبدأ':'badge-secondary','متأخرة':'badge-danger'};

function saveInitiative(){
  const editId=document.getElementById('initiative-edit-id')?.value;
  const g=id=>document.getElementById(id)?.value||'';
  const ini={id:editId?parseInt(editId):Date.now(),goal:g('ini-goal'),name:g('ini-name').trim(),desc:g('ini-desc').trim(),resp:g('ini-resp').trim(),start:g('ini-start'),end:g('ini-end'),status:g('ini-status'),progress:parseInt(g('ini-progress'))||0,link:g('ini-link').trim()};
  if(!ini.name){showToast('يرجى إدخال اسم المبادرة','error');return;}
  let data=lsLoad('initiatives',[]);
  if(editId){const i=data.findIndex(x=>x.id===ini.id);if(i!==-1)data[i]=ini;}else data.push(ini);
  lsSave('initiatives',data);closeModal('initiative-modal');renderPlan();
  showToast(editId?'تم التعديل ✅':'تمت الإضافة ✅','success');
}
function editInitiative(id){
  const ini=lsLoad('initiatives',[]).find(i=>i.id===id); if(!ini) return;
  const sv=(fid,v)=>{const e=document.getElementById(fid);if(e)e.value=v??'';};
  sv('initiative-edit-id',ini.id);sv('ini-goal',ini.goal);sv('ini-name',ini.name);sv('ini-desc',ini.desc);sv('ini-resp',ini.resp);sv('ini-start',ini.start);sv('ini-end',ini.end);sv('ini-status',ini.status);sv('ini-progress',ini.progress||0);sv('ini-link',ini.link||'');
  openModal('initiative-modal');
}
function deleteInitiative(id){if(!confirm('حذف هذه المبادرة؟'))return;lsSave('initiatives',lsLoad('initiatives',[]).filter(i=>i.id!==id));renderPlan();showToast('تم الحذف 🗑️','warning');}

/* ================================================================
   §26 — KPI
   ================================================================ */
function renderKPI(){
  const kpi=lsLoad('kpi',[]);
  const kc=document.getElementById('kpi-cards');
  if(kc) kc.innerHTML=kpi.map(k=>{const pct=k.target>0?Math.min(100,Math.round((k.achieved/k.target)*100)):0;const clr=pct>=90?'#27ae60':pct>=70?'#f39c12':'#e74c3c';const deg=Math.round(pct*3.6);return`<div class="kpi-card"><div class="kpi-card-name">${k.name}</div><div class="kpi-circle" style="background:conic-gradient(${clr} ${deg}deg,#eaecee ${deg}deg)"><div class="kpi-circle-inner">${pct}%</div></div><div class="kpi-values">المستهدف: <strong>${k.target} ${k.unit}</strong> · المتحقق: <strong>${k.achieved} ${k.unit}</strong></div></div>`;}).join('');
  const kt=document.getElementById('kpi-tbody');
  if(kt) kt.innerHTML=kpi.map(k=>{const pct=k.target>0?Math.min(100,Math.round((k.achieved/k.target)*100)):0;const bc=pct>=90?'badge-success':pct>=70?'badge-warning':'badge-danger';const bl=pct>=90?'ممتاز':pct>=70?'جيد':'يحتاج تحسين';return`<tr><td style="font-weight:600">${k.name}</td><td>${k.target} ${k.unit}</td><td>${k.achieved} ${k.unit}</td><td><div class="progress-wrap"><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div><span class="progress-text">${pct}%</span></div></td><td><span class="badge ${bc}">${bl}</span></td></tr>`;}).join('');
  setTimeout(()=>drawKPIBars(kpi),50);
}
function saveKPI(){
  const g=id=>(document.getElementById(id)?.value||'');
  const item={id:Date.now(),name:g('kpi-name').trim(),target:parseFloat(g('kpi-target'))||0,achieved:parseFloat(g('kpi-achieved'))||0,unit:g('kpi-unit').trim()||'%'};
  if(!item.name){showToast('يرجى إدخال اسم المؤشر','error');return;}
  const data=lsLoad('kpi',[]);data.push(item);lsSave('kpi',data);closeModal('kpi-modal');renderKPI();showToast('تمت الإضافة ✅','success');
}
function drawKPIBars(kpi){
  const c=document.getElementById('kpi-chart'); if(!c) return;
  const ctx=c.getContext('2d');const W=c.offsetWidth||700;c.width=W;const H=300;ctx.clearRect(0,0,W,H);
  const pL=20,pR=20,pT=20,pB=80,cW=W-pL-pR,cH=H-pT-pB;const bW=Math.min(38,cW/kpi.length/2.5),gap=cW/kpi.length;
  for(let i=0;i<=5;i++){const y=pT+cH-(cH*i/5);ctx.strokeStyle='#eaecee';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pL,y);ctx.lineTo(W-pR,y);ctx.stroke();ctx.fillStyle='#aaa';ctx.font='11px Tajawal';ctx.textAlign='left';ctx.fillText((i*20)+'%',pL,y-3);}
  kpi.forEach((k,i)=>{const pct=k.target>0?Math.min(100,(k.achieved/k.target)*100):0;const x=pL+i*gap+gap/2,bH=(pct/100)*cH;ctx.fillStyle='#dce8f5';ctx.fillRect(x-bW*.6,pT,bW*1.2,cH);const clr=pct>=90?'#27ae60':pct>=70?'#f39c12':'#e74c3c';ctx.fillStyle=clr;ctx.fillRect(x-bW/2,pT+cH-bH,bW,bH);ctx.fillStyle='#333';ctx.font='bold 11px Tajawal';ctx.textAlign='center';ctx.fillText(Math.round(pct)+'%',x,pT+cH-bH-5);const w=k.name.split(' ');ctx.fillStyle='#555';ctx.font='11px Tajawal';ctx.fillText(w.slice(0,2).join(' '),x,H-pB+16);if(w.length>2)ctx.fillText(w.slice(2).join(' '),x,H-pB+30);});
}

/* ================================================================
   §27 — TASKS
   ================================================================ */
let taskFilter='all',taskPriFilter='all';
function filterTasks(v){taskFilter=v;renderTasks();}
function filterTasksPriority(v){taskPriFilter=v;renderTasks();}
function renderTasks(){
  let tasks=lsLoad('tasks',[]);
  if(currentUser?.role==='teacher') tasks=tasks.filter(t=>t.resp.includes(currentUser.name));
  if(taskFilter==='late')  tasks=tasks.filter(t=>t.status!=='done'&&t.due&&new Date(t.due)<new Date());
  else if(taskFilter!=='all') tasks=tasks.filter(t=>t.status===taskFilter);
  if(taskPriFilter!=='all') tasks=tasks.filter(t=>t.priority===taskPriFilter);
  const pL={high:'عالية',medium:'متوسطة',low:'منخفضة'};
  const sL={pending:'معلقة',inprogress:'قيد التنفيذ',done:'منجزة'};
  const sBM={pending:'badge-warning',inprogress:'badge-info',done:'badge-success'};
  const grid=document.getElementById('tasks-grid'); if(!grid) return;
  grid.innerHTML=tasks.length
    ?tasks.map(t=>{const late=t.status!=='done'&&t.due&&new Date(t.due)<new Date();return`<div class="task-card priority-${t.priority}"><div class="task-card-header"><div class="task-title">${t.name}</div><span class="badge ${late?'badge-danger':sBM[t.status]}">${late?'⚠️ متأخرة':sL[t.status]}</span></div><div class="task-meta"><span>👩‍🏫 ${t.resp}</span><span>📅 ${formatDate(t.due)}</span><span>🔴 ${pL[t.priority]}</span>${t.notes?`<span>📝 ${t.notes}</span>`:''}</div><div class="task-actions"><select class="task-status-select" onchange="chgTaskStatus(${t.id},this.value)"><option value="pending" ${t.status==='pending'?'selected':''}>معلقة</option><option value="inprogress" ${t.status==='inprogress'?'selected':''}>قيد التنفيذ</option><option value="done" ${t.status==='done'?'selected':''}>منجزة</option></select><button class="btn-sm btn-edit" onclick="editTask(${t.id})">✏️</button><button class="btn-sm btn-delete" onclick="deleteTask(${t.id})">🗑️</button></div></div>`;}).join('')
    :'<p style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px">لا توجد مهام</p>';
}
function chgTaskStatus(id,status){const tasks=lsLoad('tasks',[]);const i=tasks.findIndex(t=>t.id===id);if(i!==-1){tasks[i].status=status;lsSave('tasks',tasks);}showToast('تم التحديث ✅','success');}
function saveTask(){
  const editId=document.getElementById('task-edit-id')?.value;
  const g=id=>(document.getElementById(id)?.value||'');
  const task={id:editId?parseInt(editId):Date.now(),name:g('task-name').trim(),resp:g('task-resp').trim(),due:g('task-due'),priority:g('task-priority'),status:g('task-status'),notes:g('task-notes').trim()};
  if(!task.name){showToast('يرجى إدخال اسم المهمة','error');return;}
  const data=lsLoad('tasks',[]);
  if(editId){const i=data.findIndex(t=>t.id===task.id);if(i!==-1)data[i]=task;}else data.push(task);
  lsSave('tasks',data);closeModal('task-modal');renderTasks();showToast(editId?'تم التعديل ✅':'تمت الإضافة ✅','success');
}
function editTask(id){
  const t=lsLoad('tasks',[]).find(t=>t.id===id); if(!t) return;
  const sv=(fid,v)=>{const e=document.getElementById(fid);if(e)e.value=v??'';};
  sv('task-edit-id',t.id);sv('task-name',t.name);sv('task-resp',t.resp);sv('task-due',t.due||'');sv('task-priority',t.priority);sv('task-status',t.status);sv('task-notes',t.notes||'');
  openModal('task-modal');
}
function deleteTask(id){if(!confirm('حذف هذه المهمة؟'))return;lsSave('tasks',lsLoad('tasks',[]).filter(t=>t.id!==id));renderTasks();showToast('تم الحذف 🗑️','warning');}

// alias
function changeTaskStatus(id,status){ chgTaskStatus(id,status); }

/* ================================================================
   §28 — REPORTS
   ================================================================ */
function openReportModal(){
  const sel=document.getElementById('rep-initiative');
  if(sel) sel.innerHTML=[...programsCache.map(p=>`<option value="${p.name}">📋 ${p.name}</option>`),...lsLoad('initiatives',[]).map(i=>`<option value="${i.name}">📌 ${i.name}</option>`)].join('');
  ['rep-title','rep-person','rep-link','rep-notes'].forEach(f=>{const e=document.getElementById(f);if(e)e.value='';});
  openModal('report-modal');
}
function renderReports(){
  const reps=lsLoad('reports',[]);
  const TI={'صورة':'📷','PDF':'📄','Word':'📝','Excel':'📊','Google Drive':'☁️','YouTube':'🎥','رابط خارجي':'🔗'};
  const tbody=document.getElementById('reports-tbody'); if(!tbody) return;
  tbody.innerHTML=reps.length?reps.map((r,i)=>`<tr><td>${i+1}</td><td style="font-weight:600">${r.title}</td><td><span class="badge badge-info">${TI[r.type]||'📎'} ${r.type}</span></td><td>${r.initiative}</td><td>${r.person}</td><td>${formatDate(r.date)}</td><td>${r.link?`<a href="${r.link}" target="_blank" class="btn-sm btn-view">🔗 فتح</a>`:'—'}</td><td><button class="btn-sm btn-delete" onclick="deleteReport(${r.id})">🗑️</button></td></tr>`).join('')
    :'<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">لا توجد شواهد</td></tr>';
}
function saveReport(){
  const g=id=>(document.getElementById(id)?.value||'');
  const rep={id:Date.now(),title:g('rep-title').trim(),type:g('rep-type'),initiative:g('rep-initiative'),person:g('rep-person').trim(),date:new Date().toISOString().split('T')[0],link:g('rep-link').trim(),notes:g('rep-notes').trim()};
  if(!rep.title){showToast('يرجى إدخال عنوان الشاهد','error');return;}
  const data=lsLoad('reports',[]);data.push(rep);lsSave('reports',data);closeModal('report-modal');renderReports();showToast('تم رفع الشاهد ✅','success');
}
function deleteReport(id){if(!confirm('حذف هذا الشاهد؟'))return;lsSave('reports',lsLoad('reports',[]).filter(r=>r.id!==id));renderReports();showToast('تم الحذف 🗑️','warning');}

/* ================================================================
   §29 — TEACHERS
   ================================================================ */
function renderTeachers(){
  const teachers=lsLoad('teachers',[]);
  const tbody=document.getElementById('teachers-tbody'); if(!tbody) return;
  tbody.innerHTML=teachers.map(t=>{const pct=t.assigned>0?Math.round((t.done/t.assigned)*100):0;const bc=pct>=90?'badge-success':pct>=70?'badge-warning':'badge-danger';return`<tr><td style="font-weight:700">${t.name}</td><td style="text-align:center">${t.assigned}</td><td style="text-align:center">${t.done}</td><td><div class="progress-wrap"><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div><span class="progress-text">${pct}%</span></div></td><td>${formatDate(t.lastReport)}</td><td style="font-size:13px">${t.notes||'<span style="color:#ccc">—</span>'}</td><td><button class="btn-sm btn-note" onclick="openTeacherNote(${t.id})">📝</button></td></tr>`;}).join('');
}
function openTeacherNote(id){const t=lsLoad('teachers',[]).find(t=>t.id===id);if(!t)return;document.getElementById('teacher-note-id').value=id;document.getElementById('teacher-note-text').value=t.notes||'';openModal('teacher-note-modal');}
function saveTeacherNote(){const id=parseInt(document.getElementById('teacher-note-id')?.value);const note=document.getElementById('teacher-note-text')?.value.trim();const ts=lsLoad('teachers',[]);const i=ts.findIndex(t=>t.id===id);if(i!==-1){ts[i].notes=note;lsSave('teachers',ts);}closeModal('teacher-note-modal');renderTeachers();showToast('تم الحفظ ✅','success');}

/* ================================================================
   §30 — CALENDAR
   ================================================================ */
function prevMonth(){calendarMonth--;if(calendarMonth<0){calendarMonth=11;calendarYear--;}renderCalendar();}
function nextMonth(){calendarMonth++;if(calendarMonth>11){calendarMonth=0;calendarYear++;}renderCalendar();}
function renderCalendar(){
  const MN=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const lbl=document.getElementById('calendar-month-label'); if(lbl) lbl.textContent=MN[calendarMonth]+' '+calendarYear;
  const tasks=lsLoad('tasks',[]);const today=new Date();
  const fd=new Date(calendarYear,calendarMonth,1).getDay();const dm=new Date(calendarYear,calendarMonth+1,0).getDate();
  const ev={};
  tasks.forEach(t=>{if(!t.due)return;const d=new Date(t.due);if(d.getFullYear()===calendarYear&&d.getMonth()===calendarMonth){const day=d.getDate();if(!ev[day])ev[day]=[];ev[day].push({text:t.name,cls:t.status!=='done'&&d<today?'late-event':'task-event'});}});
  programsCache.forEach(p=>{if(p.end){const d=new Date(p.end);if(d.getFullYear()===calendarYear&&d.getMonth()===calendarMonth){const day=d.getDate();if(!ev[day])ev[day]=[];ev[day].push({text:'📋 '+p.name,cls:'ini-event'});}}});
  const DN=['أحد','اثنين','ثلاثاء','أربعاء','خميس','جمعة','سبت'];
  let html='<div class="calendar-grid"><div class="calendar-header-row">'+DN.map(d=>`<div class="calendar-day-name">${d}</div>`).join('')+'</div><div class="calendar-body">';
  let col=0;for(let i=0;i<fd;i++){html+='<div class="calendar-cell empty"></div>';col++;}
  for(let day=1;day<=dm;day++){const isT=today.getFullYear()===calendarYear&&today.getMonth()===calendarMonth&&today.getDate()===day;const de=ev[day]||[];html+=`<div class="calendar-cell${isT?' today':''}"><div class="calendar-date${isT?' today-num':''}">${day}</div>${de.slice(0,3).map(e=>`<div class="calendar-event ${e.cls}" title="${e.text}">${e.text}</div>`).join('')}${de.length>3?`<div style="font-size:10px;color:var(--text-muted)">+${de.length-3}</div>`:''}</div>`;col++;}
  const rem=(7-(col%7))%7;for(let i=0;i<rem;i++)html+='<div class="calendar-cell empty"></div>';
  html+='</div></div>';
  const ce=document.getElementById('calendar-container'); if(ce) ce.innerHTML=html;
}

/* ================================================================
   §31 — STATS
   ================================================================ */
function renderStats(){
  const progs=programsCache,tasks=lsLoad('tasks',[]),reps=lsLoad('reports',[]),kpi=lsLoad('kpi',[]);
  const avg=progs.length?Math.round(progs.reduce((s,p)=>s+(p.progress||0),0)/progs.length):0;
  const dt=tasks.filter(t=>t.status==='done').length,lt=tasks.filter(t=>t.status!=='done'&&t.due&&new Date(t.due)<new Date()).length;
  const top=[...progs].sort((a,b)=>(b.progress||0)-(a.progress||0)).slice(0,3);
  const tev=progs.reduce((s,p)=>s+(p.evidence||[]).length,0);
  const sc=document.getElementById('stats-cards'); if(sc)sc.innerHTML=`
    <div class="stat-card"><span class="stat-icon">📊</span><span class="stat-number">${avg}%</span><span class="stat-label">متوسط إنجاز البرامج</span></div>
    <div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${dt}</span><span class="stat-label">مهام منجزة</span></div>
    <div class="stat-card red"><span class="stat-icon">⚠️</span><span class="stat-number">${lt}</span><span class="stat-label">مهام متأخرة</span></div>
    <div class="stat-card purple"><span class="stat-icon">📎</span><span class="stat-number">${reps.length+tev}</span><span class="stat-label">شواهد مرفوعة</span></div>
    <div class="stat-card gold"><span class="stat-icon">🎯</span><span class="stat-number">${kpi.length}</span><span class="stat-label">مؤشرات الأداء</span></div>
    <div class="stat-card teal"><span class="stat-icon">📋</span><span class="stat-number">${progs.filter(p=>calcProgramStatus(p)==='done').length}</span><span class="stat-label">برامج منتهية</span></div>`;
  const te=document.getElementById('top-initiatives'); if(te)te.innerHTML=top.map((p,i)=>`<div class="top-initiative-item"><span>${['🥇','🥈','🥉'][i]} ${p.name}</span><span style="font-weight:700;color:var(--primary)">${p.progress}%</span></div>`).join('');
  setTimeout(()=>{drawStatsPie(tasks);drawCompare(progs);},50);
}
function drawStatsPie(tasks){
  const c=document.getElementById('tasks-pie-chart'); if(!c) return;
  const ctx=c.getContext('2d');const W=c.width,H=c.height;ctx.clearRect(0,0,W,H);
  const cnt={'منجزة':tasks.filter(t=>t.status==='done').length,'قيد التنفيذ':tasks.filter(t=>t.status==='inprogress').length,'معلقة':tasks.filter(t=>t.status==='pending').length,'متأخرة':tasks.filter(t=>t.status!=='done'&&t.due&&new Date(t.due)<new Date()).length};
  const colors=['#27ae60','#2e86c1','#f39c12','#e74c3c'],L=Object.keys(cnt),V=Object.values(cnt),T=V.reduce((a,b)=>a+b,0);
  if(!T)return;const cx=W/2,cy=H/2-20,r=Math.min(W,H)/2-40;let sa=-Math.PI/2;
  V.forEach((v,i)=>{if(!v)return;const sl=(v/T)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,sa,sa+sl);ctx.closePath();ctx.fillStyle=colors[i];ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=2;ctx.stroke();const mid=sa+sl/2;ctx.fillStyle='white';ctx.font='bold 12px Tajawal';ctx.textAlign='center';ctx.fillText(v,cx+(r*.65)*Math.cos(mid),cy+(r*.65)*Math.sin(mid)+5);sa+=sl;});
  const ly=H-28;L.forEach((l,i)=>{const x=(i%2)*(W/2)+10,y=ly-Math.floor(1-i/2)*18;ctx.fillStyle=colors[i];ctx.fillRect(x,y,11,11);ctx.fillStyle='#444';ctx.font='11px Tajawal';ctx.textAlign='right';ctx.fillText(l+' ('+V[i]+')',x+W/2-14,y+9);});
}
function drawCompare(progs){
  const c=document.getElementById('compare-chart'); if(!c) return;
  const ctx=c.getContext('2d');const W=c.offsetWidth||700;c.width=W;const H=280;ctx.clearRect(0,0,W,H);
  const pL=20,pR=20,pT=20,pB=70,cW=W-pL-pR,cH=H-pT-pB;const n=Math.max(progs.length,1);const bW=Math.min(32,cW/n/3),gap=cW/n;
  for(let i=0;i<=5;i++){const y=pT+cH-(cH*i/5);ctx.strokeStyle='#eaecee';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pL,y);ctx.lineTo(W-pR,y);ctx.stroke();ctx.fillStyle='#aaa';ctx.font='11px Tajawal';ctx.textAlign='left';ctx.fillText((i*20)+'%',pL,y-2);}
  progs.forEach((p,i)=>{const pct=p.progress||0,x=pL+i*gap+gap/2,bH=(pct/100)*cH;ctx.fillStyle='#dce8f5';ctx.fillRect(x-bW*1.1,pT,bW*2.2,cH);const clr=pct>=90?'#27ae60':pct>=60?'#2e86c1':pct>=30?'#f39c12':'#e74c3c';ctx.fillStyle=clr;ctx.fillRect(x-bW/2,pT+cH-bH,bW,bH);ctx.fillStyle='#333';ctx.font='bold 11px Tajawal';ctx.textAlign='center';ctx.fillText(pct+'%',x,pT+cH-bH-5);ctx.fillStyle='#666';ctx.font='11px Tajawal';ctx.fillText(p.name.length>7?p.name.slice(0,7)+'..':p.name,x,H-pB+16);});
}

/* ================================================================
   §32 — HELPERS
   ================================================================ */
function formatDate(d){
  if(!d) return '—';
  try{ return new Date(d).toLocaleDateString('ar-SA',{year:'numeric',month:'short',day:'numeric'}); }
  catch{ return d; }
}

/* ================================================================
   §33 — ENTRY POINT
   ================================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initLocalData();
  calendarMonth = new Date().getMonth();
  calendarYear  = new Date().getFullYear();
  // البرامج والمستخدمون يُحمَّلان بعد doLogin()
});
