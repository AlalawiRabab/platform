/* =======================================================================
   SCHOOL OPERATIONAL PLAN — script.js  v4.0
   -----------------------------------------------------------------------
   ✅ programs          → Supabase (CRUD كامل)
   ✅ program_indicators → Supabase (مؤشرات إنجاز فعلية)
   ✅ users             → Supabase (نظام صلاحيات)
   🔒 بقية الجداول     → LocalStorage
   -----------------------------------------------------------------------
   SQL لإنشاء الجداول في Supabase:

   -- جدول المستخدمين
   CREATE TABLE users (
     id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
     name        text NOT NULL,
     email       text UNIQUE NOT NULL,
     password    text NOT NULL,          -- plain text للتجربة فقط
     role        text NOT NULL CHECK (role IN ('admin','vice','teacher')),
     created_at  timestamptz DEFAULT now()
   );

   -- جدول البرامج
   CREATE TABLE programs (
     id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
     name        text NOT NULL,
     description text,
     start_date  date,
     end_date    date,
     status      text DEFAULT 'planning',
     progress    int2 DEFAULT 0,
     created_at  timestamptz DEFAULT now()
   );

   -- جدول مؤشرات الإنجاز
   CREATE TABLE program_indicators (
     id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
     program_id     uuid REFERENCES programs(id) ON DELETE CASCADE,
     indicator_text text NOT NULL,
     is_completed   boolean DEFAULT false,
     created_at     timestamptz DEFAULT now()
   );

   -- RLS (Row Level Security) — anon key يقرأ فقط
   ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
   ALTER TABLE programs           ENABLE ROW LEVEL SECURITY;
   ALTER TABLE program_indicators ENABLE ROW LEVEL SECURITY;

   CREATE POLICY "public read users"   ON users              FOR SELECT USING (true);
   CREATE POLICY "public all programs" ON programs           FOR ALL    USING (true) WITH CHECK (true);
   CREATE POLICY "public all indicators" ON program_indicators FOR ALL  USING (true) WITH CHECK (true);

   -- بيانات تجريبية للمستخدمين
   INSERT INTO users (name, email, password, role) VALUES
     ('سارة العتيبي',  'admin@school.sa',   '1234', 'admin'),
     ('نورة القحطاني', 'vice@school.sa',    '1234', 'vice'),
     ('هند الزهراني',  'teacher@school.sa', '1234', 'teacher');
   ======================================================================= */

'use strict';

// =========================================================
// ===== 0. SUPABASE CLIENT
// =========================================================
const sb = (typeof supabaseClient !== 'undefined') ? supabaseClient : null;

// =========================================================
// ===== 1. GLOBAL STATE
// =========================================================
let currentUser   = null;   // { id, name, email, role }
let calendarMonth = new Date().getMonth();
let calendarYear  = new Date().getFullYear();

let programsCache    = [];  // [{ id, name, desc, start, end, progress, resp, target, evidence, indicators:[] }]
let indicatorsCache  = {};  // { programId: [{ id, program_id, indicator_text, is_completed }] }

let pendingFileData  = null;
let pendingImageData = null;

// =========================================================
// ===== 2. PERMISSIONS MAP
// =========================================================
/*
  admin   → وصول كامل
  vice    → إضافة/تعديل برامج + متابعة (لا حذف، لا إدارة مستخدمين)
  teacher → مشاهدة + إضافة شواهد + تحديث مؤشراته فقط
*/
const PERMS = {
  admin: {
    addProgram: true, editProgram: true, deleteProgram: true,
    addIndicator: true, editIndicator: true, deleteIndicator: true,
    toggleIndicator: true,
    addEvidence: true, deleteEvidence: true,
    manageUsers: true,
    viewAllSections: true,
  },
  vice: {
    addProgram: true, editProgram: true, deleteProgram: false,
    addIndicator: true, editIndicator: true, deleteIndicator: false,
    toggleIndicator: true,
    addEvidence: true, deleteEvidence: false,
    manageUsers: false,
    viewAllSections: false,
  },
  teacher: {
    addProgram: false, editProgram: false, deleteProgram: false,
    addIndicator: false, editIndicator: false, deleteIndicator: false,
    toggleIndicator: true,   // يحدّث مؤشراته فقط (نتحكم بذلك في الكود)
    addEvidence: true, deleteEvidence: false,
    manageUsers: false,
    viewAllSections: false,
  },
};

function can(action) {
  if (!currentUser) return false;
  return PERMS[currentUser.role]?.[action] === true;
}

// =========================================================
// ===== 3. DEMO / LOCAL DATA
// =========================================================
const DEMO_INITIATIVES = [
  { id:1, goal:'تحسين التحصيل الدراسي', name:'تفعيل الاختبارات القصيرة', desc:'اختبارات قصيرة أسبوعية لجميع المواد', resp:'أ. نورة العتيبي', start:'2024-09-01', end:'2025-05-30', status:'قيد التنفيذ', progress:75, link:'' },
  { id:2, goal:'تحسين التحصيل الدراسي', name:'متابعة الفاقد التعليمي', desc:'رصد ومتابعة الطالبات ذوات الفاقد التعليمي', resp:'أ. هند القحطاني', start:'2024-09-15', end:'2025-05-15', status:'قيد التنفيذ', progress:60, link:'' },
  { id:3, goal:'تعزيز الانضباط', name:'برنامج الانضباط المدرسي', desc:'برنامج شامل لتعزيز الانضباط', resp:'أ. سلمى الزهراني', start:'2024-09-01', end:'2025-06-01', status:'قيد التنفيذ', progress:80, link:'' },
  { id:4, goal:'التنمية المهنية', name:'التنمية المهنية للمعلمات', desc:'برامج تدريبية لتطوير مهارات المعلمات', resp:'أ. ريم الحربي', start:'2024-10-01', end:'2025-04-30', status:'منجزة', progress:100, link:'' },
  { id:5, goal:'الشراكة المجتمعية', name:'تفعيل الشراكة المجتمعية', desc:'شراكات مع مؤسسات المجتمع', resp:'أ. مها الشمري', start:'2024-11-01', end:'2025-03-31', status:'منجزة', progress:100, link:'' },
  { id:6, goal:'تعزيز الهوية الوطنية', name:'تعزيز الهوية الوطنية', desc:'فعاليات تعزز الانتماء الوطني', resp:'أ. فاطمة الدوسري', start:'2024-09-22', end:'2025-02-23', status:'منجزة', progress:100, link:'' },
  { id:7, goal:'تحسين التحصيل الدراسي', name:'التعلم التعاوني', desc:'استراتيجيات التعلم التعاوني', resp:'أ. نورة العتيبي', start:'2024-10-15', end:'2025-05-15', status:'قيد التنفيذ', progress:55, link:'' },
  { id:8, goal:'متابعة الفاقد التعليمي', name:'حلقات الدعم الأكاديمي', desc:'حلقات دعم أسبوعية للطالبات', resp:'أ. هند القحطاني', start:'2024-09-20', end:'2025-05-20', status:'قيد التنفيذ', progress:45, link:'' },
];
const DEMO_TASKS = [
  { id:1, name:'إعداد جدول الاختبارات القصيرة', resp:'أ. نورة العتيبي', due:'2025-01-15', priority:'high', status:'done', notes:'تم الإعداد' },
  { id:2, name:'رصد نتائج الاختبارات التشخيصية', resp:'أ. هند القحطاني', due:'2025-01-20', priority:'high', status:'done', notes:'' },
  { id:3, name:'تنفيذ ورشة التعلم التعاوني', resp:'أ. ريم الحربي', due:'2025-02-10', priority:'medium', status:'inprogress', notes:'' },
  { id:4, name:'إعداد تقرير الفاقد التعليمي', resp:'أ. هند القحطاني', due:'2025-02-28', priority:'high', status:'pending', notes:'' },
  { id:5, name:'تنظيم فعالية اليوم الوطني', resp:'أ. فاطمة الدوسري', due:'2024-09-22', priority:'high', status:'done', notes:'تم تنفيذها' },
  { id:6, name:'متابعة الطالبات المتعثرات', resp:'أ. سلمى الزهراني', due:'2025-03-15', priority:'medium', status:'inprogress', notes:'' },
  { id:7, name:'تقرير الزيارات الصفية', resp:'أ. مها الشمري', due:'2025-01-31', priority:'low', status:'done', notes:'' },
  { id:8, name:'إعداد خطة الأنشطة الفصلية', resp:'أ. فاطمة الدوسري', due:'2025-03-01', priority:'medium', status:'pending', notes:'' },
];
const DEMO_KPI = [
  { id:1, name:'نسبة النجاح العامة', target:95, achieved:91, unit:'%' },
  { id:2, name:'نسبة الحضور اليومي', target:98, achieved:96.5, unit:'%' },
  { id:3, name:'عدد الاختبارات المنفذة', target:80, achieved:68, unit:'اختبار' },
  { id:4, name:'نسبة رضا أولياء الأمور', target:90, achieved:87, unit:'%' },
  { id:5, name:'عدد الزيارات الصفية', target:120, achieved:105, unit:'زيارة' },
  { id:6, name:'عدد الطالبات المستفيدات', target:50, achieved:43, unit:'طالبة' },
];
const DEMO_REPORTS = [
  { id:1, title:'نتائج الاختبارات - الفصل الأول', type:'PDF', initiative:'تفعيل الاختبارات القصيرة', person:'أ. نورة العتيبي', date:'2024-11-15', link:'https://drive.google.com/example1', notes:'' },
  { id:2, title:'صور فعالية اليوم الوطني', type:'صورة', initiative:'تعزيز الهوية الوطنية', person:'أ. فاطمة الدوسري', date:'2024-09-25', link:'https://drive.google.com/example2', notes:'' },
  { id:3, title:'تقرير ورشة التنمية المهنية', type:'Google Drive', initiative:'التنمية المهنية للمعلمات', person:'أ. ريم الحربي', date:'2024-12-10', link:'https://drive.google.com/example3', notes:'15 معلمة' },
  { id:4, title:'فيديو الشراكة المجتمعية', type:'YouTube', initiative:'تفعيل الشراكة المجتمعية', person:'أ. مها الشمري', date:'2024-12-20', link:'https://youtube.com/example4', notes:'' },
];
const DEMO_TEACHERS = [
  { id:1, name:'أ. نورة العتيبي', assigned:12, done:10, lastReport:'2024-12-15', notes:'' },
  { id:2, name:'أ. هند القحطاني', assigned:8,  done:5,  lastReport:'2024-12-10', notes:'' },
  { id:3, name:'أ. سلمى الزهراني', assigned:10, done:9, lastReport:'2024-12-20', notes:'' },
  { id:4, name:'أ. ريم الحربي',    assigned:6,  done:6, lastReport:'2024-12-12', notes:'' },
  { id:5, name:'أ. مها الشمري',    assigned:7,  done:6, lastReport:'2024-12-18', notes:'' },
  { id:6, name:'أ. فاطمة الدوسري', assigned:9,  done:8, lastReport:'2024-12-22', notes:'' },
];
const DEMO_SETTINGS = {
  schoolName:'مدرسة النور الابتدائية', year:'١٤٤٦ / ١٤٤٧هـ',
  principal:'أ. سارة العتيبي', region:'منطقة المدينة المنورة'
};

// =========================================================
// ===== 4. LOCALSTORAGE HELPERS
// =========================================================
function lsSave(key, data) { localStorage.setItem('sop_' + key, JSON.stringify(data)); }
function lsLoad(key, def) {
  try { const v = localStorage.getItem('sop_' + key); return v ? JSON.parse(v) : def; }
  catch { return def; }
}
const save = lsSave;
const load = lsLoad;

function saveProgExtra(id, p) {
  lsSave('prog_extra_' + id, {
    resp    : p.resp     || '',
    target  : p.target   || '',
    evidence: p.evidence || [],
  });
}

// =========================================================
// ===== 5. SUPABASE — USERS
// =========================================================

/** تسجيل الدخول من جدول users */
async function loginFromSupabase(email, password) {
  if (!sb) return null;
  const { data, error } = await sb
    .from('users')
    .select('*')
    .eq('email', email.toLowerCase().trim())
    .eq('password', password)
    .single();
  if (error || !data) return null;
  return data; // { id, name, email, role, ... }
}

/** تحميل كل المستخدمين (للمدير فقط) */
async function fetchAllUsers() {
  if (!sb) return [];
  const { data, error } = await sb.from('users').select('id,name,email,role,created_at').order('created_at');
  if (error) { console.error('[Supabase] fetchAllUsers:', error.message); return []; }
  return data || [];
}

/** إضافة مستخدم جديد */
async function insertUser(u) {
  if (!sb) throw new Error('Supabase غير متصل');
  const { data, error } = await sb.from('users').insert({
    name: u.name, email: u.email.toLowerCase().trim(), password: u.password, role: u.role
  }).select().single();
  if (error) throw error;
  return data;
}

/** حذف مستخدم */
async function deleteUser_db(id) {
  if (!sb) throw new Error('Supabase غير متصل');
  const { error } = await sb.from('users').delete().eq('id', id);
  if (error) throw error;
}

/** تعديل دور مستخدم */
async function updateUserRole_db(id, role) {
  if (!sb) throw new Error('Supabase غير متصل');
  const { error } = await sb.from('users').update({ role }).eq('id', id);
  if (error) throw error;
}

// =========================================================
// ===== 6. SUPABASE — PROGRAMS CRUD
// =========================================================
function sbRowToProgram(row) {
  const extra = lsLoad('prog_extra_' + row.id, {});
  return {
    id        : row.id,
    name      : row.name        || '',
    desc      : row.description || '',
    start     : row.start_date  || '',
    end       : row.end_date    || '',
    progress  : row.progress    || 0,
    resp      : extra.resp      || '',
    target    : extra.target    || '',
    evidence  : extra.evidence  || [],
    indicators: [],   // تُملأ من indicatorsCache
  };
}

function programToSbRow(p) {
  return {
    name       : p.name,
    description: p.desc    || null,
    start_date : p.start   || null,
    end_date   : p.end     || null,
    progress   : Number(p.progress) || 0,
    status     : calcProgramStatus(p),
  };
}

async function fetchPrograms() {
  if (!sb) { programsCache = lsLoad('programs_local', []); return programsCache; }
  showLoadingOverlay(true);
  try {
    const [progRes, indRes] = await Promise.all([
      sb.from('programs').select('*').order('created_at', { ascending: true }),
      sb.from('program_indicators').select('*').order('created_at', { ascending: true }),
    ]);
    if (progRes.error) throw progRes.error;
    if (indRes.error)  throw indRes.error;

    // بناء indicatorsCache
    indicatorsCache = {};
    (indRes.data || []).forEach(ind => {
      if (!indicatorsCache[ind.program_id]) indicatorsCache[ind.program_id] = [];
      indicatorsCache[ind.program_id].push(ind);
    });

    programsCache = (progRes.data || []).map(row => {
      const p = sbRowToProgram(row);
      p.indicators = indicatorsCache[p.id] || [];
      return p;
    });
    return programsCache;
  } catch (err) {
    console.error('[Supabase] fetchPrograms:', err.message);
    showToast('تعذّر تحميل البرامج: ' + err.message, 'error');
    programsCache = lsLoad('programs_local', []);
    return programsCache;
  } finally {
    showLoadingOverlay(false);
  }
}

async function insertProgram(p) {
  if (!sb) {
    p.id = 'local_' + Date.now();
    const local = lsLoad('programs_local', []); local.push(p); lsSave('programs_local', local);
    saveProgExtra(p.id, p); return p;
  }
  const row = programToSbRow(p);
  const { data, error } = await sb.from('programs').insert(row).select().single();
  if (error) throw error;
  saveProgExtra(data.id, p);
  const prog = sbRowToProgram(data); prog.indicators = [];
  return prog;
}

async function updateProgram(p) {
  if (!sb) {
    const local = lsLoad('programs_local', []);
    const idx = local.findIndex(x => x.id === p.id);
    if (idx !== -1) { p.evidence = local[idx].evidence||[]; local[idx] = p; }
    lsSave('programs_local', local); saveProgExtra(p.id, p); return p;
  }
  const row = programToSbRow(p);
  const { data, error } = await sb.from('programs').update(row).eq('id', p.id).select().single();
  if (error) throw error;
  const existing = programsCache.find(x => x.id === p.id) || {};
  p.evidence = existing.evidence || p.evidence || [];
 saveProgExtra(p.id, p);
  const prog = sbRowToProgram(data);
  prog.indicators = indicatorsCache[prog.id] || [];
  prog.evidence   = p.evidence;
   const idx = programsCache.findIndex(x => x.id === p.id);
if (idx !== -1) programsCache[idx] = prog;
  return prog;
}

async function deleteProgram_db(id) {
  if (!sb) {
    let local = lsLoad('programs_local', []);
    local = local.filter(p => p.id !== id); lsSave('programs_local', local);
    localStorage.removeItem('sop_prog_extra_' + id); return;
  }
  // CASCADE يحذف المؤشرات تلقائياً
  const { error } = await sb.from('programs').delete().eq('id', id);
  if (error) throw error;
  localStorage.removeItem('sop_prog_extra_' + id);
  delete indicatorsCache[id];
}

/** تحديث progress + status في programs بعد تغيّر المؤشرات */
async function syncProgramProgress(programId) {
  const inds = indicatorsCache[programId] || [];
  const total     = inds.length;
  const completed = inds.filter(i => i.is_completed).length;
  const progress  = total > 0 ? Math.round((completed / total) * 100) : 0;

  // تحديث الكاش
  const pIdx = programsCache.findIndex(p => p.id === programId);
  if (pIdx !== -1) {
    programsCache[pIdx].progress   = progress;
    programsCache[pIdx].indicators = inds;
  }

  if (!sb) return;

  const prog   = programsCache[pIdx] || { progress };
  const status = calcProgramStatus({ ...prog, progress });

  const { error } = await sb
    .from('programs')
    .update({ progress, status })
    .eq('id', programId);
  if (error) console.error('[Supabase] syncProgramProgress:', error.message);
}

// =========================================================
// ===== 7. SUPABASE — PROGRAM_INDICATORS CRUD
// =========================================================

/** إضافة مؤشر جديد */
async function insertIndicator(programId, text) {
  if (!sb) {
    const ind = { id:'loc_'+Date.now(), program_id:programId, indicator_text:text, is_completed:false, created_at:new Date().toISOString() };
    if (!indicatorsCache[programId]) indicatorsCache[programId] = [];
    indicatorsCache[programId].push(ind);
    await syncProgramProgress(programId);
    return ind;
  }
  const { data, error } = await sb
    .from('program_indicators')
    .insert({ program_id: programId, indicator_text: text, is_completed: false })
    .select().single();
  if (error) throw error;
  if (!indicatorsCache[programId]) indicatorsCache[programId] = [];
  indicatorsCache[programId].push(data);
  await syncProgramProgress(programId);
  return data;
}

/** تبديل حالة مؤشر (مكتمل / غير مكتمل) */
async function toggleIndicator(programId, indicatorId) {
  // التحقق من الصلاحية للمعلم: يتحقق في مكان الاستدعاء
  const inds = indicatorsCache[programId] || [];
  const ind  = inds.find(i => i.id === indicatorId);
  if (!ind) return;

  const newVal = !ind.is_completed;
  ind.is_completed = newVal;

  if (sb) {
    const { error } = await sb
      .from('program_indicators')
      .update({ is_completed: newVal })
      .eq('id', indicatorId);
    if (error) { ind.is_completed = !newVal; throw error; }
  }
  await syncProgramProgress(programId);
}

/** حذف مؤشر */
async function deleteIndicator(programId, indicatorId) {
  if (sb) {
    const { error } = await sb.from('program_indicators').delete().eq('id', indicatorId);
    if (error) throw error;
  }
  if (indicatorsCache[programId]) {
    indicatorsCache[programId] = indicatorsCache[programId].filter(i => i.id !== indicatorId);
  }
  await syncProgramProgress(programId);
}

// =========================================================
// ===== 8. INIT LOCAL
// =========================================================
function initLocalData() {
  if (!lsLoad('sop_initiatives', null)) lsSave('initiatives', DEMO_INITIATIVES);
  if (!lsLoad('sop_tasks',       null)) lsSave('tasks',       DEMO_TASKS);
  if (!lsLoad('sop_kpi',         null)) lsSave('kpi',         DEMO_KPI);
  if (!lsLoad('sop_reports',     null)) lsSave('reports',     DEMO_REPORTS);
  if (!lsLoad('sop_teachers',    null)) lsSave('teachers',    DEMO_TEACHERS);
  if (!lsLoad('sop_settings',    null)) lsSave('settings',    DEMO_SETTINGS);
}

async function resetToDemo() {
  if (!confirm('سيتم إعادة تحميل البيانات التجريبية. هل أنت متأكدة؟')) return;
  lsSave('initiatives', DEMO_INITIATIVES); lsSave('tasks', DEMO_TASKS);
  lsSave('kpi', DEMO_KPI); lsSave('reports', DEMO_REPORTS);
  lsSave('teachers', DEMO_TEACHERS); lsSave('settings', DEMO_SETTINGS);
  await fetchPrograms(); loadSettings(); refreshCurrentSection();
  showToast('تمت إعادة التحميل ✅', 'success');
}

async function clearAllData() {
  if (!confirm('مسح جميع البيانات المحلية؟')) return;
  ['initiatives','tasks','kpi','reports','teachers','settings'].forEach(k => localStorage.removeItem('sop_'+k));
  Object.keys(localStorage).filter(k => k.startsWith('sop_prog_extra_')).forEach(k => localStorage.removeItem(k));
  initLocalData(); await fetchPrograms(); loadSettings(); refreshCurrentSection();
  showToast('تم المسح ✅', 'warning');
}

// =========================================================
// ===== 9. LOADING OVERLAY
// =========================================================
function showLoadingOverlay(show) {
  let el = document.getElementById('loading-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loading-overlay';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(13,43,69,0.55);display:flex;align-items:center;justify-content:center;z-index:9998;backdrop-filter:blur(3px)';
    el.innerHTML = `<div style="background:white;border-radius:16px;padding:32px 48px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
      <div style="font-size:36px;margin-bottom:12px;animation:spin 1s linear infinite;display:inline-block">⏳</div>
      <div style="font-family:Tajawal,sans-serif;font-size:16px;font-weight:700;color:#1a5276">جارٍ التحميل...</div>
      </div><style>@keyframes spin{to{transform:rotate(360deg)}}</style>`;
    document.body.appendChild(el);
  }
  el.style.display = show ? 'flex' : 'none';
}

// =========================================================
// ===== 10. AUTH — LOGIN / LOGOUT
// =========================================================
function selectRole(btn, role) {
  // حُذف — الأدوار تأتي من Supabase الآن، نبقي الدالة فارغة للتوافق مع HTML القديم
}

async function doLogin() {
  const emailEl = document.getElementById('login-email') || document.getElementById('username');
  const passEl  = document.getElementById('login-password') || document.getElementById('password');
  const email   = emailEl?.value.trim() || '';
  const pass    = passEl?.value.trim()  || '';

  if (!email || !pass) { showToast('يرجى إدخال البريد الإلكتروني وكلمة المرور', 'error'); return; }

  const loginBtn = document.getElementById('login-btn');
  if (loginBtn) { loginBtn.disabled = true; loginBtn.textContent = 'جارٍ التحقق...'; }

  try {
    let userData = null;

    if (sb) {
      userData = await loginFromSupabase(email, pass);
    } else {
      // Fallback محلي للتطوير بدون Supabase
      const LOCAL_USERS = [
        { id:'1', name:'سارة العتيبي',  email:'admin@school.sa',   password:'1234', role:'admin'   },
        { id:'2', name:'نورة القحطاني', email:'vice@school.sa',    password:'1234', role:'vice'    },
        { id:'3', name:'هند الزهراني',  email:'teacher@school.sa', password:'1234', role:'teacher' },
      ];
      userData = LOCAL_USERS.find(u => u.email === email.toLowerCase() && u.password === pass) || null;
    }

    if (!userData) { showToast('البريد الإلكتروني أو كلمة المرور غير صحيحة', 'error'); return; }

    currentUser = { id: userData.id, name: userData.name, email: userData.email, role: userData.role };

    document.getElementById('login-page').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    applyRoleUI();
    loadSettings();
    await fetchPrograms();
    showSection('dashboard', document.querySelector('.nav-item[data-section="dashboard"]'));

  } finally {
    if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'دخول إلى المنصة'; }
  }
}

function doLogout() {
  currentUser  = null;
  programsCache   = [];
  indicatorsCache = {};
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-page').classList.remove('hidden');
  const eEl = document.getElementById('login-email') || document.getElementById('username');
  const pEl = document.getElementById('login-password') || document.getElementById('password');
  if (eEl) eEl.value = '';
  if (pEl) pEl.value = '';
}

// =========================================================
// ===== 11. APPLY ROLE UI
// =========================================================
function applyRoleUI() {
  if (!currentUser) return;
  const role = currentUser.role;

  // شارة الدور
  const roleLabels = { admin:'مدير', vice:'وكيل', teacher:'معلم' };
  const badgeEl = document.getElementById('user-role-badge');
  if (badgeEl) badgeEl.textContent = roleLabels[role] || role;

  const nameEl = document.getElementById('header-user-name');
  if (nameEl) nameEl.textContent = currentUser.name;

  const avatarEl = document.querySelector('.avatar');
  if (avatarEl) avatarEl.textContent = currentUser.name.charAt(0);

  // إخفاء/إظهار عناصر التنقل
  const navRules = {
    admin  : ['dashboard','programs','plan','kpi','tasks','reports','teachers','calendar','stats','settings','users'],
    vice   : ['dashboard','programs','plan','kpi','tasks','reports','teachers','calendar','stats'],
    teacher: ['dashboard','programs','reports'],
  };
  const allowed = navRules[role] || [];
  document.querySelectorAll('.nav-item').forEach(item => {
    item.style.display = allowed.includes(item.dataset.section) ? 'flex' : 'none';
  });

  // عرض/إخفاء قسم إدارة المستخدمين في الـ nav
  const usersNav = document.querySelector('.nav-item[data-section="users"]');
  if (usersNav) usersNav.style.display = can('manageUsers') ? 'flex' : 'none';
}

// =========================================================
// ===== 12. SETTINGS
// =========================================================
function loadSettings() {
  const s = lsLoad('settings', DEMO_SETTINGS);
  const fields = { 'setting-school': s.schoolName, 'setting-year': s.year, 'setting-principal': s.principal, 'setting-region': s.region };
  Object.entries(fields).forEach(([id,val]) => { const el=document.getElementById(id); if(el) el.value=val||''; });
  const sn = document.getElementById('sidebar-school-name'); if(sn) sn.textContent = s.schoolName||'مدرسة النور';
  const sy = document.getElementById('sidebar-year'); if(sy) sy.textContent = s.year||'';
}

function saveSettings() {
  const s = {
    schoolName : document.getElementById('setting-school')?.value     || '',
    year       : document.getElementById('setting-year')?.value       || '',
    principal  : document.getElementById('setting-principal')?.value  || '',
    region     : document.getElementById('setting-region')?.value     || '',
  };
  lsSave('settings', s);
  const sn = document.getElementById('sidebar-school-name'); if(sn) sn.textContent = s.schoolName;
  const sy = document.getElementById('sidebar-year'); if(sy) sy.textContent = s.year;
  showToast('تم حفظ الإعدادات ✅', 'success');
}

// =========================================================
// ===== 13. NAVIGATION
// =========================================================
let activeSection = 'dashboard';

async function showSection(name, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const sec = document.getElementById('section-' + name);
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
  const titleEl = document.getElementById('section-title');
  if (titleEl) titleEl.textContent = titles[name] || '';

  if (window.innerWidth <= 768) {
    document.getElementById('sidebar')?.classList.remove('open');
    document.querySelector('.sidebar-overlay')?.classList.remove('show');
  }

  if (name === 'programs') await fetchPrograms();
  if (name === 'users' && can('manageUsers')) await renderUsersSection();

  renderSection(name);
}

function refreshCurrentSection() { renderSection(activeSection); }

function renderSection(name) {
  switch (name) {
    case 'dashboard' : renderDashboard(); break;
    case 'programs'  : renderPrograms();  break;
    case 'plan'      : renderPlan();      break;
    case 'kpi'       : renderKPI();       break;
    case 'tasks'     : renderTasks();     break;
    case 'reports'   : renderReports();   break;
    case 'teachers'  : renderTeachers();  break;
    case 'calendar'  : renderCalendar();  break;
    case 'stats'     : renderStats();     break;
  }
}

// =========================================================
// ===== 14. SIDEBAR TOGGLE
// =========================================================
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('open');
  let overlay = document.querySelector('.sidebar-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    overlay.onclick = () => { sidebar.classList.remove('open'); overlay.classList.remove('show'); };
    document.body.appendChild(overlay);
  }
  overlay.classList.toggle('show');
}

// =========================================================
// ===== 15. TOAST
// =========================================================
let toastTimer = null;
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg; t.className = 'toast ' + type; t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3400);
}

// =========================================================
// ===== 16. MODALS
// =========================================================
function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
  if (id === 'evidence-modal') { pendingFileData = null; pendingImageData = null; }
}

// =========================================================
// ===== 17. STATUS HELPERS
// =========================================================
function calcProgramStatus(prog) {
  const today = new Date(); today.setHours(0,0,0,0);
  const start = prog.start ? new Date(prog.start) : null;
  const end   = prog.end   ? new Date(prog.end)   : null;
  const pct   = parseInt(prog.progress) || 0;
  if (pct >= 100)                     return 'done';
  if (!start || today < start)        return 'planning';
  if (end && today > end && pct < 100) return 'late';
  if (start && today >= start)        return 'active';
  return 'planning';
}
function getStatusLabel(s) { return {planning:'قيد التخطيط',active:'جارٍ التنفيذ',done:'منتهٍ',late:'متأخر'}[s]||s; }
function getStatusBadge(s) { return {planning:'badge-secondary',active:'badge-info',done:'badge-success',late:'badge-danger'}[s]||'badge-secondary'; }
function getStatusIcon(s)  { return {planning:'⏳',active:'▶️',done:'✅',late:'⚠️'}[s]||'📋'; }

function autoCalcProgStatus() {
  const fake = {
    start: document.getElementById('prog-start')?.value,
    end:   document.getElementById('prog-end')?.value,
    progress: parseInt(document.getElementById('prog-progress')?.value)||0,
  };
  const status = calcProgramStatus(fake);
  const sd = document.getElementById('prog-status-display');
  const sh = document.getElementById('prog-status');
  if (sd) sd.value = getStatusIcon(status)+' '+getStatusLabel(status);
  if (sh) sh.value = status;
}

// =========================================================
// ===== 18. PROGRAMS — UI
// =========================================================
function openProgramModal(id) {
  if (id && !can('editProgram'))   { showToast('ليس لديك صلاحية تعديل البرامج', 'error'); return; }
  if (!id && !can('addProgram'))   { showToast('ليس لديك صلاحية إضافة برامج', 'error'); return; }

  pendingFileData = null; pendingImageData = null;
  document.getElementById('prog-edit-id').value = '';
  const titleEl = document.getElementById('program-modal-title');
  if (titleEl) titleEl.textContent = 'إضافة برنامج جديد';
  ['prog-name','prog-resp','prog-desc','prog-target','prog-start','prog-end'].forEach(f => {
    const el = document.getElementById(f); if (el) el.value = '';
  });
  const ppEl = document.getElementById('prog-progress'); if (ppEl) ppEl.value = '';
  const psEl = document.getElementById('prog-status');   if (psEl) psEl.value = '';
  const pdEl = document.getElementById('prog-status-display'); if (pdEl) pdEl.value = '';

  if (id) {
   const p = programsCache.find(x => String(x.id) === String(id)); if (!p) return;
    document.getElementById('prog-edit-id').value = p.id;
    if (titleEl) titleEl.textContent = 'تعديل البرنامج';
    const setV = (fid, val) => { const el=document.getElementById(fid); if(el) el.value=val||''; };
    setV('prog-name', p.name); setV('prog-resp', p.resp); setV('prog-desc', p.desc);
    setV('prog-target', p.target); setV('prog-start', p.start);
    setV('prog-end', p.end); setV('prog-progress', p.progress||0);
    autoCalcProgStatus();
  }
  openModal('program-modal');
}

async function saveProgram() {
  const editId = document.getElementById('prog-edit-id')?.value;
  if (editId && !can('editProgram')) { showToast('ليس لديك صلاحية تعديل البرامج', 'error'); return; }
  if (!editId && !can('addProgram')) { showToast('ليس لديك صلاحية إضافة برامج', 'error'); return; }

  const name = document.getElementById('prog-name')?.value.trim();
  const resp = document.getElementById('prog-resp')?.value.trim();
  if (!name) { showToast('يرجى إدخال اسم البرنامج', 'error'); return; }
  if (!resp) { showToast('يرجى إدخال اسم المسؤول', 'error'); return; }

  const p = {
    id      : editId || null,
    name,
    resp,
    desc    : document.getElementById('prog-desc')?.value.trim()   || '',
    target  : document.getElementById('prog-target')?.value.trim() || '',
    start   : document.getElementById('prog-start')?.value   || '',
    end     : document.getElementById('prog-end')?.value     || '',
    progress: parseInt(document.getElementById('prog-progress')?.value)||0,
    evidence: [],
  };

  const saveBtn = document.querySelector('#program-modal .btn-primary');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'جارٍ الحفظ...'; }

  try {
    let saved;
    if (editId) {
      const existing = programsCache.find(x => x.id === editId);
      p.evidence = existing?.evidence || [];
      saved = await updateProgram(p);
      const idx = programsCache.findIndex(x => x.id === saved.id);
      if (idx !== -1) programsCache[idx] = saved;
    } else {
      saved = await insertProgram(p);
      saved.indicators = [];
      programsCache.push(saved);
    }
    closeModal('program-modal');
    renderPrograms();
    showToast(editId ? 'تم تعديل البرنامج ✅' : 'تمت إضافة البرنامج ✅', 'success');
  } catch (err) {
    console.error('[Supabase] saveProgram:', err.message);
    showToast('خطأ في الحفظ: ' + err.message, 'error');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 حفظ البرنامج'; }
  }
}

async function deleteProgram(id) {
  if (!can('deleteProgram')) { showToast('ليس لديك صلاحية حذف البرامج', 'error'); return; }
  if (!confirm('هل تريد حذف هذا البرنامج وجميع مؤشراته وشواهده؟')) return;
  try {
    await deleteProgram_db(id);
    programsCache = programsCache.filter(p => p.id !== id);
    renderPrograms();
    showToast('تم حذف البرنامج 🗑️', 'warning');
  } catch (err) {
    showToast('خطأ في الحذف: ' + err.message, 'error');
  }
}

// =========================================================
// ===== 19. RENDER PROGRAMS GRID
// =========================================================
function renderPrograms() {
  const programs     = programsCache;
  const filterStatus = document.getElementById('prog-filter-status')?.value || 'all';
  const searchVal    = (document.getElementById('prog-search')?.value || '').toLowerCase();

  const total = programs.length;
  const counts = {planning:0,active:0,done:0,late:0};
  programs.forEach(p => { const s = calcProgramStatus(p); counts[s] = (counts[s]||0)+1; });
  const avgPct = total ? Math.round(programs.reduce((s,p) => s+(p.progress||0),0)/total) : 0;

  const statsEl = document.getElementById('programs-stats');
  if (statsEl) statsEl.innerHTML = `
    <div class="stat-card"><span class="stat-icon">🗂️</span><span class="stat-number">${total}</span><span class="stat-label">إجمالي البرامج</span></div>
    <div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${counts.done}</span><span class="stat-label">برامج منتهية</span></div>
    <div class="stat-card"><span class="stat-icon">▶️</span><span class="stat-number">${counts.active}</span><span class="stat-label">برامج جارية</span></div>
    <div class="stat-card red"><span class="stat-icon">⚠️</span><span class="stat-number">${counts.late}</span><span class="stat-label">برامج متأخرة</span></div>
    <div class="stat-card gold"><span class="stat-icon">📊</span><span class="stat-number">${avgPct}%</span><span class="stat-label">متوسط الإنجاز</span></div>`;

  // زر إضافة برنامج — يظهر فقط لمن يملك الصلاحية
  const addBtn = document.getElementById('btn-add-program');
  if (addBtn) addBtn.style.display = can('addProgram') ? '' : 'none';

  const filtered = programs.filter(p => {
    const matchStatus = filterStatus === 'all' || calcProgramStatus(p) === filterStatus;
    const matchSearch = !searchVal || p.name.toLowerCase().includes(searchVal) || (p.resp||'').toLowerCase().includes(searchVal);
    return matchStatus && matchSearch;
  });

  const grid = document.getElementById('programs-grid');
  if (!grid) return;
  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🗂️</div><p>لا توجد برامج مطابقة</p><small>جربي تغيير الفلتر أو إضافة برنامج جديد</small></div>`;
    return;
  }
  grid.innerHTML = filtered.map(p => renderProgramCard(p)).join('');
}

function renderProgramCard(p) {
  const status         = calcProgramStatus(p);
  const pct            = parseInt(p.progress) || 0;
  const evidence       = p.evidence || [];
  const indicators     = p.indicators || indicatorsCache[p.id] || [];
  const progressColor  = pct>=90?'#27ae60':pct>=60?'#2e86c1':pct>=30?'#f39c12':'#e74c3c';
  const totalInd       = indicators.length;
  const completedInd   = indicators.filter(i=>i.is_completed).length;

  // === مؤشرات الإنجاز الفعلية ===
  const indicatorsHtml = indicators.length
    ? indicators.map(ind => {
        const canToggle  = can('toggleIndicator');
        const canDelete  = can('deleteIndicator');
        const checkClass = ind.is_completed ? 'ind-check-done' : 'ind-check-empty';
        const textStyle  = ind.is_completed ? 'text-decoration:line-through;color:var(--text-muted)' : '';
        return `<div class="indicator-row" id="ind-row-${ind.id}">
          <button class="ind-toggle ${checkClass}" ${canToggle?`onclick="handleToggleIndicator('${p.id}','${ind.id}')"`:'disabled'}
            title="${ind.is_completed?'إلغاء الإنجاز':'وضع علامة مكتمل'}">
            ${ind.is_completed ? '✅' : '⬜'}
          </button>
          <span class="ind-text" style="${textStyle}">${ind.indicator_text}</span>
          ${canDelete ? `<button class="ind-delete" onclick="handleDeleteIndicator('${p.id}','${ind.id}')" title="حذف">✕</button>` : ''}
        </div>`;
      }).join('')
    : '<div style="font-size:12px;color:var(--text-muted);padding:4px 0">لا توجد مؤشرات بعد</div>';

  // حقل إضافة مؤشر — للمدير والوكيل فقط
  const addIndHtml = can('addIndicator') ? `
    <div class="add-indicator-row">
      <input type="text" id="ind-input-${p.id}" class="ind-input" placeholder="أضف مؤشر إنجاز جديد..." onkeydown="if(event.key==='Enter')handleAddIndicator('${p.id}')" />
      <button class="btn-sm btn-evidence" onclick="handleAddIndicator('${p.id}')">+</button>
    </div>` : '';

  // الشواهد
  const evidenceHtml = evidence.length
    ? evidence.map(ev => {
        const icon = getEvidenceIcon(ev.type);
        const href = ev.link ? `href="${ev.link}" target="_blank"` : '';
        const tag  = ev.link ? 'a' : 'span';
        const delBtn = can('deleteEvidence') ? `<span class="ev-delete" onclick="event.preventDefault();event.stopPropagation();handleDeleteEvidence('${p.id}','${ev.id}')" title="حذف">✕</span>` : '';
        return `<${tag} class="evidence-chip${ev.link?'':' no-link'}" ${href}>${icon} ${ev.title}${delBtn}</${tag}>`;
      }).join('')
    : '<span style="font-size:12px;color:var(--text-muted)">لا توجد شواهد بعد</span>';

  // أزرار الإجراءات حسب الصلاحية
  const editBtn   = can('editProgram')   ? `<button class="btn-sm btn-edit"   onclick="openProgramModal('${p.id}')">✏️ تعديل</button>` : '';
  const deleteBtn = can('deleteProgram') ? `<button class="btn-sm btn-delete" onclick="deleteProgram('${p.id}')">🗑️ حذف</button>` : '';
  const addEvBtn  = can('addEvidence')   ? `<button class="btn-sm btn-evidence" onclick="openEvidenceModal('${p.id}')">+ إضافة شاهد</button>` : '';

  return `
  <div class="program-card status-${status}" id="prog-card-${p.id}">
    <div class="program-card-header">
      <div class="program-card-title">${p.name}</div>
      <span class="badge ${getStatusBadge(status)}">${getStatusIcon(status)} ${getStatusLabel(status)}</span>
    </div>
    <div class="program-card-body">
      ${p.desc ? `<div class="program-card-desc">${p.desc}</div>` : ''}
      <div class="program-meta-grid">
        <div class="program-meta-item">👩‍🏫 <strong>${p.resp||'—'}</strong></div>
        <div class="program-meta-item">🎯 <strong>${p.target||'—'}</strong></div>
        <div class="program-meta-item">📅 <strong>${formatDate(p.start)}</strong></div>
        <div class="program-meta-item">🏁 <strong>${formatDate(p.end)}</strong></div>
      </div>

      <!-- شريط التقدم -->
      <div class="program-progress-section">
        <div class="program-progress-label">
          <span>نسبة الإنجاز ${totalInd>0?`(${completedInd}/${totalInd} مؤشر)`:''}</span>
          <span id="prog-pct-${p.id}">${pct}%</span>
        </div>
        <div class="progress-bar" style="height:10px">
          <div class="progress-fill" id="prog-bar-${p.id}"
            style="width:${pct}%;background:linear-gradient(90deg,${progressColor},${progressColor}cc)"></div>
        </div>
      </div>

      <!-- مؤشرات الإنجاز الفعلية -->
      <div class="program-indicators">
        <div class="program-indicators-title">📌 مؤشرات الإنجاز</div>
        <div class="indicators-list" id="ind-list-${p.id}">${indicatorsHtml}</div>
        ${addIndHtml}
      </div>

      <!-- الشواهد -->
      <div class="program-evidence-section">
        <div class="program-evidence-title">
          <span>📎 الشواهد (${evidence.length})</span>
          ${addEvBtn}
        </div>
        <div class="evidence-chips" id="ev-chips-${p.id}">${evidenceHtml}</div>
      </div>
    </div>
    <div class="program-card-actions">
      <button class="btn-sm btn-detail" onclick="viewProgramDetail('${p.id}')">👁️ التفاصيل</button>
      ${editBtn}${deleteBtn}
    </div>
  </div>`;
}

// =========================================================
// ===== 20. INDICATORS HANDLERS (in-card)
// =========================================================
async function handleAddIndicator(programId) {
  if (!can('addIndicator')) { showToast('ليس لديك صلاحية إضافة مؤشرات', 'error'); return; }
  const input = document.getElementById('ind-input-' + programId);
  if (!input) return;
  const text = input.value.trim();
  if (!text) { showToast('أدخل نص المؤشر أولاً', 'error'); return; }
  input.disabled = true;
  try {
    await insertIndicator(programId, text);
    input.value = '';
    refreshIndicatorsInCard(programId);
    showToast('تمت إضافة المؤشر ✅', 'success');
  } catch(err) {
    showToast('خطأ: ' + err.message, 'error');
  } finally {
    input.disabled = false;
    input.focus();
  }
}

async function handleToggleIndicator(programId, indicatorId) {
  // المعلم: يتحقق من أن المؤشر مرتبط ببرنامج هو مسؤوله
  if (currentUser.role === 'teacher') {
    const prog = programsCache.find(p => p.id === programId);
    if (prog && prog.resp && !prog.resp.includes(currentUser.name)) {
      showToast('يمكنك تحديث مؤشرات برامجك فقط', 'error');
      return;
    }
  }
  try {
    await toggleIndicator(programId, indicatorId);
    refreshIndicatorsInCard(programId);
  } catch(err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

async function handleDeleteIndicator(programId, indicatorId) {
  if (!can('deleteIndicator')) { showToast('ليس لديك صلاحية حذف مؤشرات', 'error'); return; }
  if (!confirm('حذف هذا المؤشر؟')) return;
  try {
    await deleteIndicator(programId, indicatorId);
    refreshIndicatorsInCard(programId);
    showToast('تم الحذف 🗑️', 'warning');
  } catch(err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

/** تحديث بطاقة مؤشرات برنامج واحد بدون إعادة رسم كل الشبكة */
function refreshIndicatorsInCard(programId) {
  const p    = programsCache.find(x => x.id === programId);
  if (!p) return;
  const inds         = indicatorsCache[programId] || [];
  p.indicators       = inds;
  const totalInd     = inds.length;
  const completedInd = inds.filter(i => i.is_completed).length;
  const pct          = p.progress || 0;
  const progressColor = pct>=90?'#27ae60':pct>=60?'#2e86c1':pct>=30?'#f39c12':'#e74c3c';

  // تحديث النسبة في البطاقة
  const pctEl = document.getElementById('prog-pct-' + programId);
  const barEl = document.getElementById('prog-bar-' + programId);
  if (pctEl) pctEl.textContent = pct + '%';
  if (barEl) { barEl.style.width = pct + '%'; barEl.style.background = `linear-gradient(90deg,${progressColor},${progressColor}cc)`; }

  // تحديث label العداد
  const lblEl = document.querySelector(`#prog-card-${programId} .program-progress-label span:first-child`);
  if (lblEl) lblEl.textContent = `نسبة الإنجاز ${totalInd>0?`(${completedInd}/${totalInd} مؤشر)`:''}`;

  // إعادة رسم قائمة المؤشرات
  const listEl = document.getElementById('ind-list-' + programId);
  if (!listEl) return;

  if (!inds.length) {
    listEl.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:4px 0">لا توجد مؤشرات بعد</div>';
    return;
  }

  listEl.innerHTML = inds.map(ind => {
    const canToggle = can('toggleIndicator');
    const canDelete = can('deleteIndicator');
    const checkClass = ind.is_completed ? 'ind-check-done' : 'ind-check-empty';
    const textStyle  = ind.is_completed ? 'text-decoration:line-through;color:var(--text-muted)' : '';
    return `<div class="indicator-row" id="ind-row-${ind.id}">
      <button class="ind-toggle ${checkClass}" ${canToggle?`onclick="handleToggleIndicator('${programId}','${ind.id}')"`:'disabled'}
        title="${ind.is_completed?'إلغاء الإنجاز':'وضع علامة مكتمل'}">
        ${ind.is_completed ? '✅' : '⬜'}
      </button>
      <span class="ind-text" style="${textStyle}">${ind.indicator_text}</span>
      ${canDelete ? `<button class="ind-delete" onclick="handleDeleteIndicator('${programId}','${ind.id}')" title="حذف">✕</button>` : ''}
    </div>`;
  }).join('');
}

// =========================================================
// ===== 21. PROGRAM DETAIL MODAL
// =========================================================
function viewProgramDetail(id) {
  const p = programsCache.find(x => x.id === id); if (!p) return;
  const status        = calcProgramStatus(p);
  const pct           = parseInt(p.progress) || 0;
  const progressColor = pct>=90?'#27ae60':pct>=60?'#2e86c1':pct>=30?'#f39c12':'#e74c3c';
  const evidence      = p.evidence || [];
  const inds          = indicatorsCache[id] || p.indicators || [];

  const titleEl = document.getElementById('detail-modal-title');
  if (titleEl) titleEl.textContent = p.name;

  const evHtml = evidence.length
    ? evidence.map(ev => {
        const icon = getEvidenceIcon(ev.type);
        const delBtn = can('deleteEvidence')
          ? `<button class="btn-sm btn-delete" onclick="handleDeleteEvidence('${p.id}','${ev.id}');closeModal('program-detail-modal')">🗑️</button>` : '';
        return `<div class="evidence-detail-item">
          <div class="ev-det-icon">${icon}</div>
          <div class="ev-det-info">
            <div class="ev-det-title">${ev.title}</div>
            <div class="ev-det-meta">${ev.person||''} · ${formatDate(ev.date)} · ${getEvidenceTypeLabel(ev.type)}</div>
            ${ev.notes?`<div class="ev-det-meta" style="font-style:italic">${ev.notes}</div>`:''}
          </div>
          <div class="ev-det-actions">
            ${ev.link?`<a href="${ev.link}" target="_blank" class="btn-sm btn-view">🔗 فتح</a>`:''}
            ${ev.type==='image'&&ev.imageData?`<button class="btn-sm btn-view" onclick="viewImage('${ev.imageData}')">🖼️ عرض</button>`:''}
            ${delBtn}
          </div>
        </div>`;
      }).join('')
    : '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">لا توجد شواهد مرفوعة</p>';

  const indsHtml = inds.length
    ? inds.map(ind => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-light)">
        <span style="font-size:18px">${ind.is_completed?'✅':'⬜'}</span>
        <span style="font-size:13px;${ind.is_completed?'text-decoration:line-through;color:var(--text-muted)':''}">${ind.indicator_text}</span>
      </div>`).join('')
    : '<p style="color:var(--text-muted);font-size:13px">لا توجد مؤشرات</p>';

  const addEvBtnDetail = can('addEvidence')
    ? `<button class="btn-primary" style="font-size:12px;padding:6px 14px" onclick="openEvidenceModal('${p.id}');closeModal('program-detail-modal')">+ إضافة شاهد</button>` : '';

  const bodyEl = document.getElementById('program-detail-body');
  if (!bodyEl) return;
  bodyEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;padding:16px;background:var(--bg);border-radius:10px">
      <div style="flex:1">
        <div style="font-size:14px;color:var(--text-muted);margin-bottom:4px">حالة التنفيذ</div>
        <span class="badge ${getStatusBadge(status)}" style="font-size:13px">${getStatusIcon(status)} ${getStatusLabel(status)}</span>
      </div>
      <div style="text-align:center">
        <div style="font-size:28px;font-weight:800;color:${progressColor}">${pct}%</div>
        <div style="font-size:12px;color:var(--text-muted)">نسبة الإنجاز</div>
      </div>
    </div>
    <div style="margin-bottom:16px">
      <div class="progress-bar" style="height:12px;border-radius:6px">
        <div class="progress-fill" style="width:${pct}%;background:linear-gradient(90deg,${progressColor},${progressColor}cc)"></div>
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
    <div class="detail-section"><h4>📌 مؤشرات الإنجاز (${inds.filter(i=>i.is_completed).length}/${inds.length})</h4>${indsHtml}</div>
    <div class="detail-section">
      <h4 style="display:flex;justify-content:space-between;align-items:center">
        📎 الشواهد (${evidence.length}) ${addEvBtnDetail}
      </h4>
      <div class="evidence-list-detail">${evHtml}</div>
    </div>`;

  openModal('program-detail-modal');
}

function viewImage(base64) {
  const w = window.open(''); w.document.write(`<img src="${base64}" style="max-width:100%;height:auto">`);
}

// =========================================================
// ===== 22. EVIDENCE
// =========================================================
function getEvidenceIcon(type) {
  return {link:'🔗',file:'📎',image:'🖼️',pdf:'📄',word:'📝',excel:'📊'}[type]||'📎';
}
function getEvidenceTypeLabel(type) {
  return {link:'رابط خارجي',file:'ملف',image:'صورة',pdf:'PDF',word:'Word',excel:'Excel'}[type]||type;
}

function toggleEvidenceInput() {
  const type = document.getElementById('ev-type')?.value;
  document.getElementById('ev-link-group')?.classList.toggle('hidden', type !== 'link');
  document.getElementById('ev-file-group')?.classList.toggle('hidden', type !== 'file');
  document.getElementById('ev-image-group')?.classList.toggle('hidden', type !== 'image');
  pendingFileData = null; pendingImageData = null;
  ['ev-file-preview','ev-image-preview'].forEach(id => {
    const el = document.getElementById(id); if(el){el.classList.add('hidden');el.innerHTML='';}
  });
}

function openEvidenceModal(programId, evidenceId) {
  if (!can('addEvidence')) { showToast('ليس لديك صلاحية رفع الشواهد', 'error'); return; }
  pendingFileData = null; pendingImageData = null;
  document.getElementById('ev-program-id').value = programId;
  document.getElementById('ev-edit-id').value    = evidenceId || '';
  const titleEl = document.getElementById('evidence-modal-title');
  if (titleEl) titleEl.textContent = evidenceId ? 'تعديل الشاهد' : 'إضافة شاهد';
  ['ev-title','ev-link','ev-person','ev-notes'].forEach(f => { const el=document.getElementById(f);if(el)el.value=''; });
  const typeEl = document.getElementById('ev-type'); if(typeEl) typeEl.value = 'link';
  toggleEvidenceInput();
  if (evidenceId) {
    const p  = programsCache.find(x => x.id === programId);
    const ev = (p?.evidence||[]).find(e => e.id === evidenceId);
    if (ev) {
      const sv = (id,v) => { const el=document.getElementById(id);if(el)el.value=v||''; };
      sv('ev-title',ev.title); sv('ev-type',ev.type); sv('ev-link',ev.link);
      sv('ev-person',ev.person); sv('ev-notes',ev.notes); toggleEvidenceInput();
    }
  }
  openModal('evidence-modal');
}

function handleFileSelect(input) {
  const file = input.files[0]; if (!file) return;
  if (file.size > 5*1024*1024) { showToast('الملف أكبر من 5 MB','error'); input.value=''; return; }
  const reader = new FileReader();
  reader.onload = e => {
    pendingFileData = { name:file.name, mimeType:file.type, base64:e.target.result };
    const prev = document.getElementById('ev-file-preview'); if(!prev)return;
    prev.classList.remove('hidden');
    prev.innerHTML = `<span style="font-size:20px">${getFileIcon(file.name)}</span><span class="file-name">${file.name}</span><span style="font-size:11px;color:var(--text-muted)">${(file.size/1024).toFixed(0)} KB</span><span class="file-remove" onclick="pendingFileData=null;document.getElementById('ev-file-input').value='';document.getElementById('ev-file-preview').classList.add('hidden')">✕</span>`;
  };
  reader.readAsDataURL(file);
}

function handleImageSelect(input) {
  const file = input.files[0]; if (!file) return;
  if (file.size > 5*1024*1024) { showToast('الصورة أكبر من 5 MB','error'); input.value=''; return; }
  const reader = new FileReader();
  reader.onload = e => {
    pendingImageData = { name:file.name, base64:e.target.result };
    const prev = document.getElementById('ev-image-preview'); if(!prev)return;
    prev.classList.remove('hidden');
    prev.innerHTML = `<img src="${e.target.result}" alt="${file.name}"/>`;
  };
  reader.readAsDataURL(file);
}

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if(ext==='pdf')return'📄'; if(ext==='doc'||ext==='docx')return'📝'; if(ext==='xls'||ext==='xlsx')return'📊'; return'📎';
}

function saveEvidence() {
  if (!can('addEvidence')) { showToast('ليس لديك صلاحية رفع الشواهد','error'); return; }
  const progId = document.getElementById('ev-program-id')?.value;
  const editId = document.getElementById('ev-edit-id')?.value;
  const title  = document.getElementById('ev-title')?.value.trim();
  const type   = document.getElementById('ev-type')?.value;
  if (!title) { showToast('يرجى إدخال عنوان الشاهد','error'); return; }

  const evidence = {
    id       : editId || ('ev_'+Date.now()),
    title, type,
    link     : type==='link'?(document.getElementById('ev-link')?.value.trim()||''):'',
    fileData : type==='file' ?(pendingFileData?.base64||null):null,
    fileName : type==='file' ?(pendingFileData?.name||null):null,
    imageData: type==='image'?(pendingImageData?.base64||null):null,
    imageName: type==='image'?(pendingImageData?.name||null):null,
    person   : document.getElementById('ev-person')?.value.trim(),
    date     : new Date().toISOString().split('T')[0],
    notes    : document.getElementById('ev-notes')?.value.trim(),
  };

  const pIdx = programsCache.findIndex(p => p.id === progId || p.id === parseInt(progId));
  if (pIdx === -1) { showToast('البرنامج غير موجود','error'); return; }
  if (!programsCache[pIdx].evidence) programsCache[pIdx].evidence = [];

  if (editId) {
    const eIdx = programsCache[pIdx].evidence.findIndex(e => e.id === editId);
    if (eIdx !== -1) programsCache[pIdx].evidence[eIdx] = evidence;
    else programsCache[pIdx].evidence.push(evidence);
  } else {
    programsCache[pIdx].evidence.push(evidence);
  }
  saveProgExtra(programsCache[pIdx].id, programsCache[pIdx]);
  closeModal('evidence-modal');
  renderPrograms();
  showToast('تم حفظ الشاهد ✅','success');
}

function handleDeleteEvidence(progId, evId) {
  if (!can('deleteEvidence')) { showToast('ليس لديك صلاحية حذف الشواهد','error'); return; }
  if (!confirm('حذف هذا الشاهد؟')) return;
  const pIdx = programsCache.findIndex(p => p.id === progId || p.id === parseInt(progId));
  if (pIdx === -1) return;
  programsCache[pIdx].evidence = (programsCache[pIdx].evidence||[]).filter(e => e.id !== evId);
  saveProgExtra(programsCache[pIdx].id, programsCache[pIdx]);
  renderPrograms();
  showToast('تم حذف الشاهد 🗑️','warning');
}

// بقاء دالة deleteEvidence للتوافق
function deleteEvidence(progId, evId) { handleDeleteEvidence(progId, evId); }

// =========================================================
// ===== 23. USERS MANAGEMENT (admin only)
// =========================================================
async function renderUsersSection() {
  if (!can('manageUsers')) return;
  const sec = document.getElementById('section-users');
  if (!sec) return;

  const users = await fetchAllUsers();
  const roleLabel = { admin:'مدير', vice:'وكيل', teacher:'معلم' };
  const roleBadge = { admin:'badge-danger', vice:'badge-info', teacher:'badge-success' };

  sec.innerHTML = `
    <div class="section-top">
      <h2>إدارة المستخدمين</h2>
      <button class="btn-primary" onclick="openAddUserModal()">+ إضافة مستخدم</button>
    </div>
    <div class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr><th>#</th><th>الاسم</th><th>البريد الإلكتروني</th><th>الدور</th><th>تاريخ الإضافة</th><th>إجراءات</th></tr>
        </thead>
        <tbody>
          ${users.map((u,i) => `
            <tr>
              <td>${i+1}</td>
              <td style="font-weight:700">${u.name}</td>
              <td style="direction:ltr;text-align:right">${u.email}</td>
              <td><span class="badge ${roleBadge[u.role]||'badge-secondary'}">${roleLabel[u.role]||u.role}</span></td>
              <td>${formatDate(u.created_at)}</td>
              <td>
                <div style="display:flex;gap:6px">
                  <select class="task-status-select" onchange="handleChangeUserRole('${u.id}',this.value)" title="تغيير الدور">
                    <option value="admin"   ${u.role==='admin'   ?'selected':''}>مدير</option>
                    <option value="vice"    ${u.role==='vice'    ?'selected':''}>وكيل</option>
                    <option value="teacher" ${u.role==='teacher' ?'selected':''}>معلم</option>
                  </select>
                  ${u.id !== currentUser?.id
                    ? `<button class="btn-sm btn-delete" onclick="handleDeleteUser('${u.id}','${u.name}')">🗑️ حذف</button>`
                    : '<span style="font-size:12px;color:var(--text-muted)">أنت</span>'}
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <!-- Add User Modal trigger area -->
    <div id="add-user-modal" class="modal-overlay hidden">
      <div class="modal">
        <div class="modal-header">
          <h3>إضافة مستخدم جديد</h3>
          <button onclick="closeModal('add-user-modal')">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group"><label>الاسم الكامل</label><input type="text" id="new-user-name" placeholder="اسم المستخدم" /></div>
          <div class="form-group"><label>البريد الإلكتروني</label><input type="email" id="new-user-email" placeholder="email@school.sa" /></div>
          <div class="form-group"><label>كلمة المرور</label><input type="password" id="new-user-pass" placeholder="كلمة المرور" /></div>
          <div class="form-group">
            <label>الدور</label>
            <select id="new-user-role">
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
  const name  = document.getElementById('new-user-name')?.value.trim();
  const email = document.getElementById('new-user-email')?.value.trim();
  const pass  = document.getElementById('new-user-pass')?.value.trim();
  const role  = document.getElementById('new-user-role')?.value;
  if (!name||!email||!pass) { showToast('يرجى تعبئة جميع الحقول','error'); return; }
  try {
    await insertUser({ name, email, password: pass, role });
    closeModal('add-user-modal');
    showToast('تمت إضافة المستخدم ✅','success');
    await renderUsersSection();
  } catch(err) {
    showToast('خطأ: ' + err.message,'error');
  }
}

async function handleDeleteUser(id, name) {
  if (!confirm(`حذف المستخدم "${name}"؟`)) return;
  try {
    await deleteUser_db(id);
    showToast('تم الحذف 🗑️','warning');
    await renderUsersSection();
  } catch(err) {
    showToast('خطأ: ' + err.message,'error');
  }
}

async function handleChangeUserRole(id, role) {
  try {
    await updateUserRole_db(id, role);
    showToast('تم تعديل الدور ✅','success');
  } catch(err) {
    showToast('خطأ: ' + err.message,'error');
  }
}

// =========================================================
// ===== 24. DASHBOARD
// =========================================================
function renderDashboard() {
  const programs = programsCache;
  const tasks    = lsLoad('tasks',  []);
  const reports  = lsLoad('reports',[]);
  const kpi      = lsLoad('kpi',    []);
  const avgPct   = programs.length?Math.round(programs.reduce((s,p)=>s+(p.progress||0),0)/programs.length):0;
  const doneProg = programs.filter(p=>calcProgramStatus(p)==='done').length;
  const lateTasks= tasks.filter(t=>t.status!=='done'&&t.due&&new Date(t.due)<new Date()).length;
  const avgKPI   = kpi.length?Math.round(kpi.reduce((s,k)=>s+Math.min(100,Math.round((k.achieved/k.target)*100)),0)/kpi.length):0;
  const totalEv  = programs.reduce((s,p)=>s+(p.evidence||[]).length,0)+reports.length;

  const dsEl = document.getElementById('dashboard-stats');
  if (dsEl) dsEl.innerHTML = `
    <div class="stat-card"><span class="stat-icon">🗂️</span><span class="stat-number">${programs.length}</span><span class="stat-label">إجمالي البرامج</span></div>
    <div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${doneProg}</span><span class="stat-label">برامج منتهية</span></div>
    <div class="stat-card gold"><span class="stat-icon">📊</span><span class="stat-number">${avgPct}%</span><span class="stat-label">متوسط الإنجاز</span></div>
    <div class="stat-card red"><span class="stat-icon">⏰</span><span class="stat-number">${lateTasks}</span><span class="stat-label">مهام متأخرة</span></div>
    <div class="stat-card purple"><span class="stat-icon">📎</span><span class="stat-number">${totalEv}</span><span class="stat-label">شواهد مرفوعة</span></div>
    <div class="stat-card teal"><span class="stat-icon">🎯</span><span class="stat-number">${avgKPI}%</span><span class="stat-label">متوسط KPI</span></div>`;

  const upcoming = tasks.filter(t=>t.status!=='done').sort((a,b)=>new Date(a.due)-new Date(b.due)).slice(0,5);
  const upEl = document.getElementById('upcoming-tasks-list');
  if (upEl) upEl.innerHTML = upcoming.length
    ? '<div class="upcoming-list">'+upcoming.map(t=>{
        const isLate=t.due&&new Date(t.due)<new Date();
        return `<div class="upcoming-item"><div class="upcoming-dot ${t.priority}"></div><div class="upcoming-info"><div class="upcoming-name">${t.name}</div><div class="upcoming-due">${isLate?'⚠️ متأخرة — ':''}${formatDate(t.due)} · ${t.resp}</div></div></div>`;
      }).join('')+'</div>'
    : '<p style="padding:16px;color:var(--text-muted);text-align:center">لا توجد مهام قادمة</p>';

  const ipEl = document.getElementById('initiatives-progress');
  if (ipEl) ipEl.innerHTML = '<div class="initiatives-progress-list">'+programs.map(p=>`
    <div class="ini-progress-item">
      <span class="ini-progress-name">${p.name}</span>
      <div class="ini-progress-bar"><div class="progress-bar"><div class="progress-fill" style="width:${p.progress||0}%"></div></div></div>
      <span class="progress-text">${p.progress||0}%</span>
    </div>`).join('')+'</div>';

  setTimeout(()=>drawInitiativesChart(programs),50);
}

function drawInitiativesChart(programs) {
  const canvas=document.getElementById('initiatives-chart');if(!canvas)return;
  const ctx=canvas.getContext('2d');const W=canvas.width,H=canvas.height;ctx.clearRect(0,0,W,H);
  const counts={'منتهٍ':0,'جارٍ التنفيذ':0,'قيد التخطيط':0,'متأخر':0};
  programs.forEach(p=>{const s=calcProgramStatus(p);if(s==='done')counts['منتهٍ']++;else if(s==='active')counts['جارٍ التنفيذ']++;else if(s==='planning')counts['قيد التخطيط']++;else if(s==='late')counts['متأخر']++;});
  const colors=['#27ae60','#2e86c1','#95a5a6','#e74c3c'];
  const labels=Object.keys(counts),values=Object.values(counts),total=values.reduce((a,b)=>a+b,0);
  if(!total)return;
  const cx=W/2,cy=H/2-15,r=Math.min(W,H)/2-30;let sa=-Math.PI/2;
  values.forEach((v,i)=>{if(!v)return;const sl=(v/total)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,sa,sa+sl);ctx.closePath();ctx.fillStyle=colors[i];ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=2;ctx.stroke();const mid=sa+sl/2;ctx.fillStyle='white';ctx.font='bold 12px Tajawal';ctx.textAlign='center';ctx.fillText(v,cx+(r*0.65)*Math.cos(mid),cy+(r*0.65)*Math.sin(mid)+5);sa+=sl;});
  let li=0;labels.forEach((l,i)=>{if(!values[i])return;const x=10+(li%2)*(W/2),y=H-48+Math.floor(li/2)*20;ctx.fillStyle=colors[i];ctx.fillRect(x,y,12,12);ctx.fillStyle='#333';ctx.font='11px Tajawal';ctx.textAlign='right';ctx.fillText(l+' ('+values[i]+')',x+W/2-18,y+10);li++;});
}

// =========================================================
// ===== 25. PLAN (INITIATIVES)
// =========================================================
let planFilter='all',planSearch='';
function filterPlan(val){planFilter=val;renderPlan();}
function searchPlan(val){planSearch=val.toLowerCase();renderPlan();}

function renderPlan(){
  let data=lsLoad('initiatives',[]);
  if(planFilter!=='all'){const map={academic:'تحسين التحصيل الدراسي',discipline:'تعزيز الانضباط',professional:'التنمية المهنية',community:'الشراكة المجتمعية',identity:'تعزيز الهوية الوطنية'};if(map[planFilter])data=data.filter(i=>i.goal===map[planFilter]);}
  if(planSearch)data=data.filter(i=>(i.name+i.goal+i.resp+i.desc).toLowerCase().includes(planSearch));
  const tbody=document.getElementById('plan-tbody');if(!tbody)return;
  tbody.innerHTML=data.length?data.map((ini,idx)=>`
    <tr><td>${idx+1}</td><td><span class="badge ${goalBadge(ini.goal)}">${ini.goal}</span></td><td style="font-weight:600">${ini.name}</td><td>${ini.resp}</td><td>${formatDate(ini.start)}</td><td>${formatDate(ini.end)}</td><td><span class="badge ${statusBadge(ini.status)}">${ini.status}</span></td>
    <td><div class="progress-wrap"><div class="progress-bar" style="min-width:70px"><div class="progress-fill" style="width:${ini.progress||0}%"></div></div><span class="progress-text">${ini.progress||0}%</span></div></td>
    <td>${ini.link?`<a href="${ini.link}" target="_blank" class="btn-sm btn-view">📎 عرض</a>`:'—'}</td>
    <td><div style="display:flex;gap:4px"><button class="btn-sm btn-edit" onclick="editInitiative(${ini.id})">✏️</button><button class="btn-sm btn-delete" onclick="deleteInitiative(${ini.id})">🗑️</button></div></td></tr>`).join('')
    :'<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-muted)">لا توجد بيانات</td></tr>';
}

function goalBadge(g){return{' تحسين التحصيل الدراسي':'badge-info','تعزيز الانضباط':'badge-warning','التنمية المهنية':'badge-purple','الشراكة المجتمعية':'badge-success','تعزيز الهوية الوطنية':'badge-secondary','متابعة الفاقد التعليمي':'badge-danger'}[g]||'badge-secondary';}
function statusBadge(s){return{'منجزة':'badge-success','قيد التنفيذ':'badge-info','لم تبدأ':'badge-secondary','متأخرة':'badge-danger'}[s]||'badge-secondary';}

function saveInitiative(){
  const editId=document.getElementById('initiative-edit-id')?.value;
  const ini={id:editId?parseInt(editId):Date.now(),goal:document.getElementById('ini-goal')?.value,name:document.getElementById('ini-name')?.value.trim(),desc:document.getElementById('ini-desc')?.value.trim(),resp:document.getElementById('ini-resp')?.value.trim(),start:document.getElementById('ini-start')?.value,end:document.getElementById('ini-end')?.value,status:document.getElementById('ini-status')?.value,progress:parseInt(document.getElementById('ini-progress')?.value)||0,link:document.getElementById('ini-link')?.value.trim()};
  if(!ini.name){showToast('يرجى إدخال اسم المبادرة','error');return;}
  let data=lsLoad('initiatives',[]);
  if(editId){const idx=data.findIndex(i=>i.id===ini.id);if(idx!==-1)data[idx]=ini;}else data.push(ini);
  lsSave('initiatives',data);closeModal('initiative-modal');renderPlan();
  showToast(editId?'تم تعديل المبادرة ✅':'تمت إضافة المبادرة ✅','success');
}
function editInitiative(id){
  const ini=lsLoad('initiatives',[]).find(i=>i.id===id);if(!ini)return;
  const sv=(fid,v)=>{const el=document.getElementById(fid);if(el)el.value=v||'';};
  sv('initiative-edit-id',ini.id);sv('ini-goal',ini.goal);sv('ini-name',ini.name);sv('ini-desc',ini.desc);sv('ini-resp',ini.resp);sv('ini-start',ini.start);sv('ini-end',ini.end);sv('ini-status',ini.status);sv('ini-progress',ini.progress||0);sv('ini-link',ini.link);
  openModal('initiative-modal');
}
function deleteInitiative(id){if(!confirm('حذف هذه المبادرة؟'))return;lsSave('initiatives',lsLoad('initiatives',[]).filter(i=>i.id!==id));renderPlan();showToast('تم الحذف 🗑️','warning');}

// =========================================================
// ===== 26. KPI
// =========================================================
function renderKPI(){
  const kpi=lsLoad('kpi',[]);
  const kpiCards=document.getElementById('kpi-cards');
  if(kpiCards)kpiCards.innerHTML=kpi.map(k=>{const pct=k.target>0?Math.min(100,Math.round((k.achieved/k.target)*100)):0;const color=pct>=90?'#27ae60':pct>=70?'#f39c12':'#e74c3c';const deg=Math.round(pct*3.6);return`<div class="kpi-card"><div class="kpi-card-name">${k.name}</div><div class="kpi-circle" style="background:conic-gradient(${color} ${deg}deg,#eaecee ${deg}deg)"><div class="kpi-circle-inner">${pct}%</div></div><div class="kpi-values">المستهدف: <strong>${k.target} ${k.unit}</strong> · المتحقق: <strong>${k.achieved} ${k.unit}</strong></div></div>`;}).join('');
  const kpiTbody=document.getElementById('kpi-tbody');
  if(kpiTbody)kpiTbody.innerHTML=kpi.map(k=>{const pct=k.target>0?Math.min(100,Math.round((k.achieved/k.target)*100)):0;const bc=pct>=90?'badge-success':pct>=70?'badge-warning':'badge-danger';const bl=pct>=90?'ممتاز':pct>=70?'جيد':'يحتاج تحسين';return`<tr><td style="font-weight:600">${k.name}</td><td>${k.target} ${k.unit}</td><td>${k.achieved} ${k.unit}</td><td><div class="progress-wrap"><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div><span class="progress-text">${pct}%</span></div></td><td><span class="badge ${bc}">${bl}</span></td></tr>`;}).join('');
  setTimeout(()=>drawKPIChart(kpi),50);
}
function saveKPI(){
  const item={id:Date.now(),name:document.getElementById('kpi-name')?.value.trim(),target:parseFloat(document.getElementById('kpi-target')?.value)||0,achieved:parseFloat(document.getElementById('kpi-achieved')?.value)||0,unit:document.getElementById('kpi-unit')?.value.trim()||'%'};
  if(!item.name){showToast('يرجى إدخال اسم المؤشر','error');return;}
  const data=lsLoad('kpi',[]);data.push(item);lsSave('kpi',data);closeModal('kpi-modal');renderKPI();showToast('تم إضافة المؤشر ✅','success');
}
function drawKPIChart(kpi){
  const canvas=document.getElementById('kpi-chart');if(!canvas)return;
  const ctx=canvas.getContext('2d');const W=canvas.offsetWidth||700;canvas.width=W;const H=300;ctx.clearRect(0,0,W,H);
  const padL=20,padR=20,padT=20,padB=80,chartW=W-padL-padR,chartH=H-padT-padB;
  const barW=Math.min(38,chartW/kpi.length/2.5),gap=chartW/kpi.length;
  for(let i=0;i<=5;i++){const y=padT+chartH-(chartH*i/5);ctx.strokeStyle='#eaecee';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(W-padR,y);ctx.stroke();ctx.fillStyle='#aaa';ctx.font='11px Tajawal';ctx.textAlign='left';ctx.fillText((i*20)+'%',padL,y-3);}
  kpi.forEach((k,i)=>{const pct=k.target>0?Math.min(100,(k.achieved/k.target)*100):0;const x=padL+i*gap+gap/2,barH=(pct/100)*chartH;ctx.fillStyle='#dce8f5';ctx.fillRect(x-barW*0.6,padT,barW*1.2,chartH);const color=pct>=90?'#27ae60':pct>=70?'#f39c12':'#e74c3c';ctx.fillStyle=color;ctx.fillRect(x-barW/2,padT+chartH-barH,barW,barH);ctx.fillStyle='#333';ctx.font='bold 11px Tajawal';ctx.textAlign='center';ctx.fillText(Math.round(pct)+'%',x,padT+chartH-barH-5);const words=k.name.split(' ');ctx.fillStyle='#555';ctx.font='11px Tajawal';ctx.fillText(words.slice(0,2).join(' '),x,H-padB+16);if(words.length>2)ctx.fillText(words.slice(2).join(' '),x,H-padB+30);});
}

// =========================================================
// ===== 27. TASKS
// =========================================================
let taskFilter='all',taskPriorityFilter='all';
function filterTasks(val){taskFilter=val;renderTasks();}
function filterTasksPriority(val){taskPriorityFilter=val;renderTasks();}
function renderTasks(){
  let tasks=lsLoad('tasks',[]);
  if(currentUser?.role==='teacher')tasks=tasks.filter(t=>t.resp.includes(currentUser.name));
  if(taskFilter==='late')tasks=tasks.filter(t=>t.status!=='done'&&t.due&&new Date(t.due)<new Date());
  else if(taskFilter!=='all')tasks=tasks.filter(t=>t.status===taskFilter);
  if(taskPriorityFilter!=='all')tasks=tasks.filter(t=>t.priority===taskPriorityFilter);
  const pL={high:'عالية',medium:'متوسطة',low:'منخفضة'};
  const sL={pending:'معلقة',inprogress:'قيد التنفيذ',done:'منجزة'};
  const sBM={pending:'badge-warning',inprogress:'badge-info',done:'badge-success'};
  const grid=document.getElementById('tasks-grid');if(!grid)return;
  grid.innerHTML=tasks.length?tasks.map(t=>{const isLate=t.status!=='done'&&t.due&&new Date(t.due)<new Date();return`<div class="task-card priority-${t.priority}"><div class="task-card-header"><div class="task-title">${t.name}</div><span class="badge ${isLate?'badge-danger':sBM[t.status]}">${isLate?'⚠️ متأخرة':sL[t.status]}</span></div><div class="task-meta"><span>👩‍🏫 ${t.resp}</span><span>📅 ${formatDate(t.due)}</span><span>🔴 ${pL[t.priority]}</span>${t.notes?`<span>📝 ${t.notes}</span>`:''}</div><div class="task-actions"><select class="task-status-select" onchange="changeTaskStatus(${t.id},this.value)"><option value="pending" ${t.status==='pending'?'selected':''}>معلقة</option><option value="inprogress" ${t.status==='inprogress'?'selected':''}>قيد التنفيذ</option><option value="done" ${t.status==='done'?'selected':''}>منجزة</option></select><button class="btn-sm btn-edit" onclick="editTask(${t.id})">✏️</button><button class="btn-sm btn-delete" onclick="deleteTask(${t.id})">🗑️</button></div></div>`;}).join('')
    :'<p style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px">لا توجد مهام</p>';
}
function changeTaskStatus(id,status){const tasks=lsLoad('tasks',[]);const idx=tasks.findIndex(t=>t.id===id);if(idx!==-1){tasks[idx].status=status;lsSave('tasks',tasks);}showToast('تم التحديث ✅','success');}
function saveTask(){
  const editId=document.getElementById('task-edit-id')?.value;
  const task={id:editId?parseInt(editId):Date.now(),name:document.getElementById('task-name')?.value.trim(),resp:document.getElementById('task-resp')?.value.trim(),due:document.getElementById('task-due')?.value,priority:document.getElementById('task-priority')?.value,status:document.getElementById('task-status')?.value,notes:document.getElementById('task-notes')?.value.trim()};
  if(!task.name){showToast('يرجى إدخال اسم المهمة','error');return;}
  const data=lsLoad('tasks',[]);
  if(editId){const idx=data.findIndex(t=>t.id===task.id);if(idx!==-1)data[idx]=task;}else data.push(task);
  lsSave('tasks',data);closeModal('task-modal');renderTasks();
  showToast(editId?'تم التعديل ✅':'تمت الإضافة ✅','success');
}
function editTask(id){
  const t=lsLoad('tasks',[]).find(t=>t.id===id);if(!t)return;
  const sv=(fid,v)=>{const el=document.getElementById(fid);if(el)el.value=v||'';};
  sv('task-edit-id',t.id);sv('task-name',t.name);sv('task-resp',t.resp);sv('task-due',t.due);sv('task-priority',t.priority);sv('task-status',t.status);sv('task-notes',t.notes);
  openModal('task-modal');
}
function deleteTask(id){if(!confirm('حذف هذه المهمة؟'))return;lsSave('tasks',lsLoad('tasks',[]).filter(t=>t.id!==id));renderTasks();showToast('تم الحذف 🗑️','warning');}

// =========================================================
// ===== 28. REPORTS
// =========================================================
function openReportModal(){
  const progs=programsCache;const inis=lsLoad('initiatives',[]);
  const sel=document.getElementById('rep-initiative');
  if(sel)sel.innerHTML=[...progs.map(p=>`<option value="${p.name}">📋 ${p.name}</option>`),...inis.map(i=>`<option value="${i.name}">📌 ${i.name}</option>`)].join('');
  ['rep-title','rep-person','rep-link','rep-notes'].forEach(f=>{const el=document.getElementById(f);if(el)el.value='';});
  openModal('report-modal');
}
function renderReports(){
  const reports=lsLoad('reports',[]);
  const typeIcon={'صورة':'📷','PDF':'📄','Word':'📝','Excel':'📊','Google Drive':'☁️','YouTube':'🎥','رابط خارجي':'🔗'};
  const tbody=document.getElementById('reports-tbody');if(!tbody)return;
  tbody.innerHTML=reports.length?reports.map((r,idx)=>`<tr><td>${idx+1}</td><td style="font-weight:600">${r.title}</td><td><span class="badge badge-info">${typeIcon[r.type]||'📎'} ${r.type}</span></td><td>${r.initiative}</td><td>${r.person}</td><td>${formatDate(r.date)}</td><td>${r.link?`<a href="${r.link}" target="_blank" class="btn-sm btn-view">🔗 فتح</a>`:'—'}</td><td><button class="btn-sm btn-delete" onclick="deleteReport(${r.id})">🗑️</button></td></tr>`).join('')
    :'<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">لا توجد شواهد</td></tr>';
}
function saveReport(){
  const report={id:Date.now(),title:document.getElementById('rep-title')?.value.trim(),type:document.getElementById('rep-type')?.value,initiative:document.getElementById('rep-initiative')?.value,person:document.getElementById('rep-person')?.value.trim(),date:new Date().toISOString().split('T')[0],link:document.getElementById('rep-link')?.value.trim(),notes:document.getElementById('rep-notes')?.value.trim()};
  if(!report.title){showToast('يرجى إدخال عنوان الشاهد','error');return;}
  const data=lsLoad('reports',[]);data.push(report);lsSave('reports',data);closeModal('report-modal');renderReports();showToast('تم رفع الشاهد ✅','success');
}
function deleteReport(id){if(!confirm('حذف هذا الشاهد؟'))return;lsSave('reports',lsLoad('reports',[]).filter(r=>r.id!==id));renderReports();showToast('تم الحذف 🗑️','warning');}

// =========================================================
// ===== 29. TEACHERS
// =========================================================
function renderTeachers(){
  const teachers=lsLoad('teachers',[]);
  const tbody=document.getElementById('teachers-tbody');if(!tbody)return;
  tbody.innerHTML=teachers.map(t=>{const pct=t.assigned>0?Math.round((t.done/t.assigned)*100):0;const bc=pct>=90?'badge-success':pct>=70?'badge-warning':'badge-danger';return`<tr><td style="font-weight:700">${t.name}</td><td style="text-align:center">${t.assigned}</td><td style="text-align:center">${t.done}</td><td><div class="progress-wrap"><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div><span class="progress-text">${pct}%</span></div></td><td>${formatDate(t.lastReport)}</td><td style="font-size:13px">${t.notes||'<span style="color:#ccc">—</span>'}</td><td><button class="btn-sm btn-note" onclick="openTeacherNote(${t.id})">📝 ملاحظة</button></td></tr>`;}).join('');
}
function openTeacherNote(id){const t=lsLoad('teachers',[]).find(t=>t.id===id);if(!t)return;document.getElementById('teacher-note-id').value=id;document.getElementById('teacher-note-text').value=t.notes||'';openModal('teacher-note-modal');}
function saveTeacherNote(){const id=parseInt(document.getElementById('teacher-note-id')?.value);const note=document.getElementById('teacher-note-text')?.value.trim();const teachers=lsLoad('teachers',[]);const idx=teachers.findIndex(t=>t.id===id);if(idx!==-1){teachers[idx].notes=note;lsSave('teachers',teachers);}closeModal('teacher-note-modal');renderTeachers();showToast('تم حفظ الملاحظة ✅','success');}

// =========================================================
// ===== 30. CALENDAR
// =========================================================
function prevMonth(){calendarMonth--;if(calendarMonth<0){calendarMonth=11;calendarYear--;}renderCalendar();}
function nextMonth(){calendarMonth++;if(calendarMonth>11){calendarMonth=0;calendarYear++;}renderCalendar();}
function renderCalendar(){
  const monthNames=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const lblEl=document.getElementById('calendar-month-label');if(lblEl)lblEl.textContent=monthNames[calendarMonth]+' '+calendarYear;
  const tasks=lsLoad('tasks',[]);const programs=programsCache;const today=new Date();
  const firstDay=new Date(calendarYear,calendarMonth,1).getDay();const daysInMonth=new Date(calendarYear,calendarMonth+1,0).getDate();const events={};
  tasks.forEach(t=>{if(!t.due)return;const d=new Date(t.due);if(d.getFullYear()===calendarYear&&d.getMonth()===calendarMonth){const day=d.getDate();if(!events[day])events[day]=[];events[day].push({text:t.name,cls:t.status!=='done'&&d<today?'late-event':'task-event'});}});
  programs.forEach(p=>{if(p.end){const d=new Date(p.end);if(d.getFullYear()===calendarYear&&d.getMonth()===calendarMonth){const day=d.getDate();if(!events[day])events[day]=[];events[day].push({text:'📋 '+p.name,cls:'ini-event'});}}});
  const dayNames=['أحد','اثنين','ثلاثاء','أربعاء','خميس','جمعة','سبت'];
  let html='<div class="calendar-grid"><div class="calendar-header-row">'+dayNames.map(d=>`<div class="calendar-day-name">${d}</div>`).join('')+'</div><div class="calendar-body">';
  let col=0;for(let i=0;i<firstDay;i++){html+='<div class="calendar-cell empty"></div>';col++;}
  for(let day=1;day<=daysInMonth;day++){const isToday=today.getFullYear()===calendarYear&&today.getMonth()===calendarMonth&&today.getDate()===day;const dayEvents=events[day]||[];html+=`<div class="calendar-cell${isToday?' today':''}"><div class="calendar-date${isToday?' today-num':''}">${day}</div>${dayEvents.slice(0,3).map(e=>`<div class="calendar-event ${e.cls}" title="${e.text}">${e.text}</div>`).join('')}${dayEvents.length>3?`<div style="font-size:10px;color:var(--text-muted)">+${dayEvents.length-3}</div>`:''}</div>`;col++;}
  const rem=(7-(col%7))%7;for(let i=0;i<rem;i++)html+='<div class="calendar-cell empty"></div>';html+='</div></div>';
  const calEl=document.getElementById('calendar-container');if(calEl)calEl.innerHTML=html;
}

// =========================================================
// ===== 31. STATS
// =========================================================
function renderStats(){
  const programs=programsCache;const tasks=lsLoad('tasks',[]);const reports=lsLoad('reports',[]);const kpi=lsLoad('kpi',[]);
  const avgPct=programs.length?Math.round(programs.reduce((s,p)=>s+(p.progress||0),0)/programs.length):0;
  const doneTasks=tasks.filter(t=>t.status==='done').length;const lateTasks=tasks.filter(t=>t.status!=='done'&&t.due&&new Date(t.due)<new Date()).length;
  const topProgs=[...programs].sort((a,b)=>(b.progress||0)-(a.progress||0)).slice(0,3);
  const totalEv=programs.reduce((s,p)=>s+(p.evidence||[]).length,0);
  const sc=document.getElementById('stats-cards');
  if(sc)sc.innerHTML=`<div class="stat-card"><span class="stat-icon">📊</span><span class="stat-number">${avgPct}%</span><span class="stat-label">متوسط إنجاز البرامج</span></div><div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${doneTasks}</span><span class="stat-label">مهام منجزة</span></div><div class="stat-card red"><span class="stat-icon">⚠️</span><span class="stat-number">${lateTasks}</span><span class="stat-label">مهام متأخرة</span></div><div class="stat-card purple"><span class="stat-icon">📎</span><span class="stat-number">${reports.length+totalEv}</span><span class="stat-label">شواهد مرفوعة</span></div><div class="stat-card gold"><span class="stat-icon">🎯</span><span class="stat-number">${kpi.length}</span><span class="stat-label">مؤشرات الأداء</span></div><div class="stat-card teal"><span class="stat-icon">📋</span><span class="stat-number">${programs.filter(p=>calcProgramStatus(p)==='done').length}</span><span class="stat-label">برامج منتهية</span></div>`;
  const topEl=document.getElementById('top-initiatives');
  if(topEl)topEl.innerHTML=topProgs.map((p,idx)=>`<div class="top-initiative-item"><span>${['🥇','🥈','🥉'][idx]} ${p.name}</span><span style="font-weight:700;color:var(--primary)">${p.progress}%</span></div>`).join('');
  setTimeout(()=>{drawTasksPieChart(tasks);drawCompareChart(programs);},50);
}
function drawTasksPieChart(tasks){
  const canvas=document.getElementById('tasks-pie-chart');if(!canvas)return;
  const ctx=canvas.getContext('2d');const W=canvas.width,H=canvas.height;ctx.clearRect(0,0,W,H);
  const counts={'منجزة':tasks.filter(t=>t.status==='done').length,'قيد التنفيذ':tasks.filter(t=>t.status==='inprogress').length,'معلقة':tasks.filter(t=>t.status==='pending').length,'متأخرة':tasks.filter(t=>t.status!=='done'&&t.due&&new Date(t.due)<new Date()).length};
  const colors=['#27ae60','#2e86c1','#f39c12','#e74c3c'],labels=Object.keys(counts),values=Object.values(counts),total=values.reduce((a,b)=>a+b,0);
  if(!total)return;const cx=W/2,cy=H/2-20,r=Math.min(W,H)/2-40;let sa=-Math.PI/2;
  values.forEach((v,i)=>{if(!v)return;const sl=(v/total)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,sa,sa+sl);ctx.closePath();ctx.fillStyle=colors[i];ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=2;ctx.stroke();const mid=sa+sl/2;ctx.fillStyle='white';ctx.font='bold 12px Tajawal';ctx.textAlign='center';ctx.fillText(v,cx+(r*0.65)*Math.cos(mid),cy+(r*0.65)*Math.sin(mid)+5);sa+=sl;});
  const legendY=H-28;labels.forEach((l,i)=>{const x=(i%2)*(W/2)+10,y=legendY-Math.floor(1-i/2)*18;ctx.fillStyle=colors[i];ctx.fillRect(x,y,11,11);ctx.fillStyle='#444';ctx.font='11px Tajawal';ctx.textAlign='right';ctx.fillText(l+' ('+values[i]+')',x+W/2-14,y+9);});
}
function drawCompareChart(programs){
  const canvas=document.getElementById('compare-chart');if(!canvas)return;
  const ctx=canvas.getContext('2d');const W=canvas.offsetWidth||700;canvas.width=W;const H=280;ctx.clearRect(0,0,W,H);
  const padL=20,padR=20,padT=20,padB=70,chartW=W-padL-padR,chartH=H-padT-padB;
  const barW=Math.min(32,chartW/Math.max(programs.length,1)/3),gap=chartW/Math.max(programs.length,1);
  for(let i=0;i<=5;i++){const y=padT+chartH-(chartH*i/5);ctx.strokeStyle='#eaecee';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(W-padR,y);ctx.stroke();ctx.fillStyle='#aaa';ctx.font='11px Tajawal';ctx.textAlign='left';ctx.fillText((i*20)+'%',padL,y-2);}
  programs.forEach((p,i)=>{const pct=p.progress||0,x=padL+i*gap+gap/2,barH=(pct/100)*chartH;ctx.fillStyle='#dce8f5';ctx.fillRect(x-barW*1.1,padT,barW*2.2,chartH);const color=pct>=90?'#27ae60':pct>=60?'#2e86c1':pct>=30?'#f39c12':'#e74c3c';ctx.fillStyle=color;ctx.fillRect(x-barW/2,padT+chartH-barH,barW,barH);ctx.fillStyle='#333';ctx.font='bold 11px Tajawal';ctx.textAlign='center';ctx.fillText(pct+'%',x,padT+chartH-barH-5);ctx.fillStyle='#666';ctx.font='11px Tajawal';const short=p.name.length>7?p.name.substring(0,7)+'..':p.name;ctx.fillText(short,x,H-padB+16);});
}

// =========================================================
// ===== 32. HELPERS
// =========================================================
function formatDate(d){if(!d)return'—';try{return new Date(d).toLocaleDateString('ar-SA',{year:'numeric',month:'short',day:'numeric'});}catch{return d;}}

// =========================================================
// ===== 33. ENTRY POINT
// =========================================================
document.addEventListener('DOMContentLoaded', () => {
  initLocalData();
  calendarMonth = new Date().getMonth();
  calendarYear  = new Date().getFullYear();
  // البرامج والمستخدمون يُحمَّلان بعد تسجيل الدخول في doLogin()
});
