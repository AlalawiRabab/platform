/* ================================================================
   SCHOOL OPERATIONAL PLAN — script.js  v6.0
   ================================================================
   جميع الجداول مرتبطة بـ Supabase | LocalStorage كـ fallback
   ================================================================

   ══════════════════════════════════════════════════════════════
   SQL الكامل — نفّذه مرة واحدة في Supabase SQL Editor
   ══════════════════════════════════════════════════════════════

   -- ① users
   CREATE TABLE IF NOT EXISTS users (
     id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
     name text NOT NULL,
     email text UNIQUE NOT NULL,
     password text NOT NULL,
     role text NOT NULL DEFAULT 'teacher'
          CHECK (role IN ('admin','vice','teacher')),
     created_at timestamptz DEFAULT now()
   );

   -- ② programs
   CREATE TABLE IF NOT EXISTS programs (
     id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
     name text NOT NULL,
     description text,
     resp text,
     target_group text,
     start_date date,
     end_date date,
     status text DEFAULT 'planning',
     progress int2 DEFAULT 0,
     created_at timestamptz DEFAULT now()
   );

   -- ③ program_indicators
   CREATE TABLE IF NOT EXISTS program_indicators (
     id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
     program_id uuid REFERENCES programs(id) ON DELETE CASCADE,
     indicator_text text NOT NULL,
     is_completed boolean DEFAULT false,
     created_at timestamptz DEFAULT now()
   );

   -- ④ initiatives
   CREATE TABLE IF NOT EXISTS initiatives (
     id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
     goal text,
     name text NOT NULL,
     description text,
     resp text,
     start_date date,
     end_date date,
     status text DEFAULT 'لم تبدأ',
     progress int2 DEFAULT 0,
     link text,
     created_at timestamptz DEFAULT now()
   );

   -- ⑤ tasks
   CREATE TABLE IF NOT EXISTS tasks (
     id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
     name text NOT NULL,
     resp text,
     due_date date,
     priority text DEFAULT 'medium'
              CHECK (priority IN ('high','medium','low')),
     status text DEFAULT 'pending'
             CHECK (status IN ('pending','inprogress','done')),
     notes text,
     created_at timestamptz DEFAULT now()
   );

   -- ⑥ evidences (program_id مربوط ببرنامج)
   CREATE TABLE IF NOT EXISTS evidences (
     id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
     title text NOT NULL,
     type text,
     program_id uuid REFERENCES programs(id) ON DELETE SET NULL,
     initiative_label text,
     person text,
     upload_date date DEFAULT CURRENT_DATE,
     link text,
     notes text,
     file_data text,
     created_at timestamptz DEFAULT now()
   );

   -- ⑦ teacher_followups (مستقل عن users)
   CREATE TABLE IF NOT EXISTS teacher_followups (
     id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
     name text NOT NULL,
     assigned_tasks int2 DEFAULT 0,
     done_tasks int2 DEFAULT 0,
     last_report date,
     notes text,
     drive_link text,
     created_by text,
     created_at timestamptz DEFAULT now()
   );
   -- إن كان الجدول موجوداً مسبقاً، أضف العمودين الجديدين:
   ALTER TABLE teacher_followups ADD COLUMN IF NOT EXISTS drive_link text;
   ALTER TABLE teacher_followups ADD COLUMN IF NOT EXISTS created_by text;

   -- ⑧ settings
   CREATE TABLE IF NOT EXISTS settings (
     id int2 PRIMARY KEY DEFAULT 1,
     school_name text,
     academic_year text,
     principal_name text,
     region text,
     updated_at timestamptz DEFAULT now()
   );
   INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING;

   -- ⑨ RLS — anon key يكفي
   DO $$ DECLARE t text;
   BEGIN
     FOREACH t IN ARRAY ARRAY['users','programs','program_indicators',
       'initiatives','tasks','evidences','teacher_followups','settings']
     LOOP
       EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
       EXECUTE format('DROP POLICY IF EXISTS allow_all ON %I', t);
       EXECUTE format('CREATE POLICY allow_all ON %I FOR ALL USING (true) WITH CHECK (true)', t);
     END LOOP;
   END $$;

   -- ⑩ seed users
   INSERT INTO users (name,email,password,role) VALUES
     ('سارة العتيبي','admin@school.sa','1234','admin'),
     ('نورة القحطاني','vice@school.sa','1234','vice'),
     ('هند الزهراني','teacher@school.sa','1234','teacher')
   ON CONFLICT (email) DO NOTHING;

   ================================================================ */

'use strict';

/* ─────────────────────────────────────────────────────────────
   §0  SUPABASE
   ───────────────────────────────────────────────────────────── */
const sb = (typeof supabaseClient !== 'undefined') ? supabaseClient : null;

/* ─────────────────────────────────────────────────────────────
   §1  GLOBAL STATE
   ───────────────────────────────────────────────────────────── */
let currentUser      = null;
let settingsCache = {};
let programsCache    = [];
let indicatorsCache  = {};
let initiativesCache = [];
let tasksCache       = [];
let evidencesCache   = [];
let teachersCache    = [];
let kpiCache         = [];
let calendarMonth    = new Date().getMonth();
let calendarYear     = new Date().getFullYear();
let pendingFileData  = null;
let pendingImageData = null;
let _planFilter      = 'all';
let _planSearch      = '';
let _taskFilter      = 'all';
let _taskPriFilter   = 'all';

/* ─────────────────────────────────────────────────────────────
   §2  PERMISSIONS
   ───────────────────────────────────────────────────────────── */
const PERMS = {
  admin:{
    addProgram:true,editProgram:true,deleteProgram:true,
    addIndicator:true,deleteIndicator:true,toggleIndicator:true,
    addEvidence:true,deleteEvidence:true,
    addInitiative:true,editInitiative:true,deleteInitiative:true,
    addTask:true,editTask:true,deleteTask:true,
    addTeacher:true,editTeacher:true,deleteTeacher:true,
    viewTeacherLinks:true,addTeacherLink:true,
    editSettings:true,manageUsers:true,
  },
  vice:{
    addProgram:true,editProgram:true,deleteProgram:false,
    addIndicator:true,deleteIndicator:false,toggleIndicator:true,
    addEvidence:true,deleteEvidence:false,
    addInitiative:true,editInitiative:true,deleteInitiative:false,
    addTask:true,editTask:true,deleteTask:false,
    addTeacher:true,editTeacher:true,deleteTeacher:true,
    viewTeacherLinks:true,addTeacherLink:true,
    editSettings:false,manageUsers:false,
  },
  teacher:{
    addProgram:false,editProgram:false,deleteProgram:false,
    addIndicator:false,deleteIndicator:false,toggleIndicator:true,
    addEvidence:true,deleteEvidence:false,
    addInitiative:false,editInitiative:false,deleteInitiative:false,
    addTask:false,editTask:false,deleteTask:false,
    addTeacher:false,editTeacher:false,deleteTeacher:false,
    viewTeacherLinks:false,addTeacherLink:true,
    editSettings:false,manageUsers:false,
  },
};
const can = a => currentUser ? (PERMS[currentUser.role]?.[a] === true) : false;

/* ─────────────────────────────────────────────────────────────
   §3  LS HELPERS
   ───────────────────────────────────────────────────────────── */
const lsSave = (k,v) => { try{ localStorage.setItem('sop_'+k, JSON.stringify(v)); }catch{} };
const lsLoad = (k,d) => { try{ const v=localStorage.getItem('sop_'+k); return v?JSON.parse(v):d; }catch{ return d; } };
const lsDel  = k     => { try{ localStorage.removeItem('sop_'+k); }catch{} };

/* ─────────────────────────────────────────────────────────────
   §4  LOADING OVERLAY
   ───────────────────────────────────────────────────────────── */
function showLoadingOverlay(show) {
  let el = document.getElementById('__overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = '__overlay';
    el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(13,43,69,0.6);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)';
    el.innerHTML = '<div style="background:#fff;border-radius:16px;padding:36px 52px;text-align:center;box-shadow:0 24px 64px rgba(0,0,0,.35)"><div style="font-size:40px;animation:_sp 0.9s linear infinite;display:inline-block">⏳</div><div style="font-family:Tajawal,sans-serif;font-size:16px;font-weight:700;color:#1a5276;margin-top:14px">جارٍ التحميل…</div></div><style>@keyframes _sp{to{transform:rotate(360deg)}}</style>';
    document.body.appendChild(el);
  }
  el.style.display = show ? 'flex' : 'none';
}

/* ─────────────────────────────────────────────────────────────
   §5  TOAST
   ───────────────────────────────────────────────────────────── */
let _tt = null;
function showToast(msg, type='success') {
  const t = document.getElementById('toast'); if (!t) return;
  t.textContent = msg; t.className = 'toast '+type; t.classList.remove('hidden');
  if (_tt) clearTimeout(_tt);
  _tt = setTimeout(() => t.classList.add('hidden'), 3500);
}

/* ─────────────────────────────────────────────────────────────
   §6  MODALS
   ───────────────────────────────────────────────────────────── */
function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) {
  document.getElementById(id)?.classList.add('hidden');
  if (id === 'evidence-modal') { pendingFileData = null; pendingImageData = null; }
}

/* ─────────────────────────────────────────────────────────────
   §7  AUTH
   ───────────────────────────────────────────────────────────── */
const FALLBACK_USERS = [
  {id:'f1',name:'سارة العتيبي', email:'admin@school.sa',   password:'1234',role:'admin'},
  {id:'f2',name:'نورة القحطاني',email:'vice@school.sa',    password:'1234',role:'vice'},
  {id:'f3',name:'هند الزهراني', email:'teacher@school.sa', password:'1234',role:'teacher'},
];

async function doLogin() {
  const email = (document.getElementById('login-email')?.value || '').trim().toLowerCase();
  const pass  = (document.getElementById('login-password')?.value || '').trim();
  if (!email || !pass) { showToast('يرجى إدخال البريد وكلمة المرور','error'); return; }
  const btn = document.getElementById('login-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'جارٍ التحقق…'; }
  try {
    showLoadingOverlay(true);
    let user = null;
    if (sb) {
      const { data, error } = await sb.from('users')
        .select('id,name,email,role')
        .eq('email', email)
        .eq('password', pass)
        .maybeSingle();
      if (error) { console.error('[Auth]', error.message); }
      else user = data;
    } else {
      user = FALLBACK_USERS.find(u => u.email === email && u.password === pass) || null;
    }
    showLoadingOverlay(false);
    if (!user) { showToast('البريد الإلكتروني أو كلمة المرور غير صحيحة','error'); return; }
    currentUser = { id:user.id, name:user.name, email:user.email, role:user.role };
    document.getElementById('login-page').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    applyRoleUI();
    await loadAllData(false);
   document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
document.getElementById('section-dashboard')?.classList.add('active');
renderDashboard();
  } catch (err) {
    showLoadingOverlay(false);
    console.error('[Login]', err.message);
    showToast('خطأ في تسجيل الدخول: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'دخول إلى المنصة'; }
  }
}
window.doLogin = doLogin;
function doLogout() {
  currentUser = null;
  [programsCache, initiativesCache, tasksCache, evidencesCache, teachersCache, kpiCache] = [[], [], [], [], [], []];
  indicatorsCache = {};
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-page').classList.remove('hidden');
  const e = document.getElementById('login-email'); if (e) e.value = '';
  const p = document.getElementById('login-password'); if (p) p.value = '';
}

/* ─────────────────────────────────────────────────────────────
   §8  APPLY ROLE UI
   ───────────────────────────────────────────────────────────── */
function applyRoleUI() {
  if (!currentUser) return;
  const r = currentUser.role;
  const rl = {admin:'مدير',vice:'وكيل',teacher:'معلم'};
  const badge = document.getElementById('user-role-badge'); if (badge) badge.textContent = rl[r]||r;
 const nm = document.getElementById('header-user-name');
if (nm) {
  nm.textContent = currentUser.role === 'admin'
    ? (settingsCache?.principal_name || currentUser.name)
    : currentUser.name;
}
  const av = document.getElementById('header-avatar'); if (av) av.textContent = currentUser.name.charAt(0);

  const navAllowed = {
    admin  : ['dashboard','programs','plan','kpi','tasks','reports','teachers','calendar','stats','settings','users'],
    vice   : ['dashboard','programs','plan','kpi','tasks','reports','teachers','calendar','stats'],
    teacher: ['dashboard','programs','reports','teachers'],
  }[r] || [];

  document.querySelectorAll('.nav-item').forEach(el => {
    el.style.display = navAllowed.includes(el.dataset.section) ? 'flex' : 'none';
  });

  // زر إضافة برنامج
  const abp = document.getElementById('btn-add-program'); if (abp) abp.style.display = can('addProgram') ? '' : 'none';
  const abi = document.getElementById('btn-add-initiative'); if (abi) abi.style.display = can('addInitiative') ? '' : 'none';
  const abt = document.getElementById('btn-add-teacher'); if (abt) abt.style.display = can('addTeacher') ? '' : 'none';
}

/* ─────────────────────────────────────────────────────────────
   §9  LOAD ALL DATA
   ───────────────────────────────────────────────────────────── */
async function loadAllData(renderAfter = true) {
  showLoadingOverlay(true);
  try {
    await Promise.all([
      fetchPrograms(),
      fetchInitiatives(),
      fetchTasks(),
      fetchEvidences(),
      fetchTeachers(),
      fetchKPI(),
      loadSettings(),
    ]);

    if (renderAfter) renderSection(_activeSection);

  } catch (e) {
    console.error('[loadAllData]', e.message);
  } finally {
    showLoadingOverlay(false);
  }
}
/* ─────────────────────────────────────────────────────────────
   §10  NAVIGATION
   ───────────────────────────────────────────────────────────── */
let _activeSection = 'dashboard';

function navTo(name, el) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const sec = document.getElementById('section-' + name);
  if (sec) sec.classList.add('active');
  if (el)  el.classList.add('active');
  _activeSection = name;
  const titles = {
    dashboard:'لوحة التحكم', programs:'برامج الخطة التشغيلية',
    plan:'المبادرات', kpi:'مؤشرات الأداء', tasks:'إدارة المهام',
    reports:'التقارير والشواهد', teachers:'متابعة المعلمات',
    calendar:'التقويم الزمني', stats:'الإحصائيات',
    settings:'الإعدادات', users:'إدارة المستخدمين',
  };
  const ti = document.getElementById('section-title'); if (ti) ti.textContent = titles[name]||'';
  closeSidebar();
  if (name === 'users' && can('manageUsers')) { renderUsersSection(); return; }
  renderSection(name);
}
function showSection(name, el) { navTo(name, el); }

function renderSection(name) {
  ({
    dashboard:renderDashboard, programs:renderPrograms,
    plan:renderPlan, kpi:renderKPI, tasks:renderTasks,
    reports:renderReports, teachers:renderTeachers,
    calendar:renderCalendar, stats:renderStats,
    settings:loadSettingsForm,
  })[name]?.();
}

/* ─────────────────────────────────────────────────────────────
   §11  SIDEBAR
   ───────────────────────────────────────────────────────────── */
function toggleSidebar() {
  const s = document.getElementById('sidebar'); s.classList.toggle('open');
  const o = document.getElementById('sidebar-overlay'); if (o) o.classList.toggle('show');
}
function closeSidebar() {
  if (window.innerWidth > 768) return;
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('show');
}

/* ─────────────────────────────────────────────────────────────
   §12  STATUS HELPERS
   ───────────────────────────────────────────────────────────── */
function calcProgramStatus(p) {
  const today = new Date(); today.setHours(0,0,0,0);
  const s = p.start ? new Date(p.start) : null;
  const e = p.end   ? new Date(p.end)   : null;
  const pct = parseInt(p.progress) || 0;
  if (pct >= 100)          return 'done';
  if (!s || today < s)     return 'planning';
  if (e && today > e)      return 'late';
  return 'active';
}
const SL = {planning:'قيد التخطيط',active:'جارٍ التنفيذ',done:'منتهٍ',late:'متأخر'};
const SB = {planning:'badge-secondary',active:'badge-info',done:'badge-success',late:'badge-danger'};
const SI = {planning:'⏳',active:'▶️',done:'✅',late:'⚠️'};

function autoCalcProgStatus() {
  const f = {
    start   : document.getElementById('prog-start')?.value||'',
    end     : document.getElementById('prog-end')?.value||'',
    progress: parseInt(document.getElementById('prog-progress')?.value)||0,
  };
  const st = calcProgramStatus(f);
  const d = document.getElementById('prog-status-display'); if (d) d.value = SI[st]+' '+SL[st];
  const h = document.getElementById('prog-status');         if (h) h.value = st;
}

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('ar-SA',{year:'numeric',month:'short',day:'numeric'}); }
  catch { return d; }
}

/* ─────────────────────────────────────────────────────────────
   §13  SUPABASE: PROGRAMS
   ───────────────────────────────────────────────────────────── */
async function fetchPrograms() {
  if (!sb) {
    programsCache = lsLoad('programs_local',[]);
    indicatorsCache = {};
    programsCache.forEach(p => { indicatorsCache[p.id] = p.indicators||[]; });
    return;
  }
  try {
    const [pr, ir] = await Promise.all([
      sb.from('programs').select('*').order('created_at'),
      sb.from('program_indicators').select('*').order('created_at'),
    ]);
    if (pr.error) throw pr.error;
    if (ir.error) throw ir.error;
    indicatorsCache = {};
    (ir.data||[]).forEach(ind => {
      if (!indicatorsCache[ind.program_id]) indicatorsCache[ind.program_id] = [];
      indicatorsCache[ind.program_id].push(ind);
    });
    programsCache = (pr.data||[]).map(row => ({
      id       : row.id,
      name     : row.name||'',
      desc     : row.description||'',
      start    : row.start_date||'',
      end      : row.end_date||'',
      progress : row.progress||0,
      resp     : row.resp||'',
      target   : row.target_group||'',
      evidence : [],
      indicators: indicatorsCache[row.id]||[],
    }));
    lsSave('programs_local', programsCache);
  } catch (err) {
    console.error('[fetchPrograms]', err.message);
    showToast('تعذّر تحميل البرامج', 'error');
    programsCache = lsLoad('programs_local',[]);
  }
}

async function sbInsertProgram(p) {
  if (!sb) {
    p.id = 'L'+Date.now();
    const ls = lsLoad('programs_local',[]); ls.push(p); lsSave('programs_local', ls);
    return p;
  }
  const { data, error } = await sb.from('programs').insert({
    name:p.name, description:p.desc||null, resp:p.resp||null,
    target_group:p.target||null, start_date:p.start||null,
    end_date:p.end||null, progress:parseInt(p.progress)||0,
    status:calcProgramStatus(p),
  }).select().single();
  if (error) throw error;
  return { ...p, id:data.id };
}

async function sbUpdateProgram(p) {
  if (!sb) {
    const ls = lsLoad('programs_local',[]);
    const i = ls.findIndex(x => x.id === p.id);
    if (i !== -1) ls[i] = p;
    lsSave('programs_local', ls); return p;
  }
  const { error } = await sb.from('programs').update({
    name:p.name, description:p.desc||null, resp:p.resp||null,
    target_group:p.target||null, start_date:p.start||null,
    end_date:p.end||null, progress:parseInt(p.progress)||0,
    status:calcProgramStatus(p),
  }).eq('id', p.id);
  if (error) throw error;
  return p;
}

async function sbDeleteProgram(id) {
  if (!sb) {
    lsSave('programs_local', lsLoad('programs_local',[]).filter(p => p.id !== id));
    delete indicatorsCache[id]; return;
  }
  const { error } = await sb.from('programs').delete().eq('id', id);
  if (error) throw error;
  delete indicatorsCache[id];
}

/* ─────────────────────────────────────────────────────────────
   §14  SUPABASE: INDICATORS
   ───────────────────────────────────────────────────────────── */
async function syncProgress(progId) {
  const inds = indicatorsCache[progId]||[];
  const total = inds.length;
  const done  = inds.filter(i => i.is_completed).length;
  // النسبة الأساسية من المؤشرات المكتملة
  let progress = total > 0 ? Math.round((done/total)*100) : 0;
  // إذا لا توجد مؤشرات لكن تم ربط شواهد، نعطي تقدّماً مبدئياً حسب عدد الشواهد
  if (total === 0) {
    const evCount = evidencesCache.filter(e => e.program_id === progId).length;
    if (evCount > 0) progress = Math.min(100, evCount * 25);
  }
  const pIdx = programsCache.findIndex(p => p.id === progId);
  if (pIdx !== -1) { programsCache[pIdx].progress = progress; programsCache[pIdx].indicators = inds; }
  if (!sb) { lsSave('programs_local', programsCache); return; }
  const prog   = programsCache[pIdx] || {};
  const status = calcProgramStatus({...prog, progress});
  const { error } = await sb.from('programs').update({ progress, status }).eq('id', progId);
  if (error) console.error('[syncProgress]', error.message);
}

async function sbAddIndicator(progId, text) {
  if (!sb) {
    const ind = {id:'L'+Date.now(),program_id:progId,indicator_text:text,is_completed:false,created_at:new Date().toISOString()};
    if (!indicatorsCache[progId]) indicatorsCache[progId] = [];
    indicatorsCache[progId].push(ind);
    await syncProgress(progId); return ind;
  }
  const { data, error } = await sb.from('program_indicators')
    .insert({program_id:progId, indicator_text:text, is_completed:false})
    .select().single();
  if (error) throw error;
  if (!indicatorsCache[progId]) indicatorsCache[progId] = [];
  indicatorsCache[progId].push(data);
  await syncProgress(progId);
  return data;
}

async function sbToggleIndicator(progId, indId) {
  const pid = String(progId);
  const iid = String(indId);

  const list = indicatorsCache[progId] || indicatorsCache[pid] || [];
  const ind = list.find(i => String(i.id) === iid);

  if (!ind) {
    console.error('Indicator not found', progId, indId, indicatorsCache);
    return;
  }

  const nv = !(ind.is_completed === true || ind.is_completed === 'true');
  ind.is_completed = nv;

  if (sb) {
    const { error } = await sb
      .from('program_indicators')
      .update({ is_completed: nv })
      .eq('id', indId);

    if (error) {
      console.error('[sbToggleIndicator]', error.message);
      ind.is_completed = !nv;
      return;
    }
  }

  await syncProgress(progId);
  renderPrograms();
  viewProgramDetail(progId);
}

/* ─────────────────────────────────────────────────────────────
   §15  SUPABASE: INITIATIVES
   ───────────────────────────────────────────────────────────── */
async function fetchInitiatives() {
  if (!sb) { initiativesCache = lsLoad('initiatives',[]); return; }
  const { data, error } = await sb.from('initiatives').select('*').order('created_at');
  if (error) { console.error('[fetchInitiatives]', error.message); initiativesCache = lsLoad('initiatives',[]); return; }
  initiativesCache = (data||[]).map(r => ({
    id:r.id, goal:r.goal||'', name:r.name||'', desc:r.description||'',
    resp:r.resp||'', start:r.start_date||'', end:r.end_date||'',
    status:r.status||'لم تبدأ', progress:r.progress||0, link:r.link||'',
  }));
  lsSave('initiatives', initiativesCache);
}

async function sbInsertInitiative(ini) {
  if (!sb) {
    ini.id = 'L'+Date.now(); initiativesCache.push(ini); lsSave('initiatives', initiativesCache); return ini;
  }
  const { data, error } = await sb.from('initiatives').insert({
    goal:ini.goal, name:ini.name, description:ini.desc||null, resp:ini.resp||null,
    start_date:ini.start||null, end_date:ini.end||null,
    status:ini.status, progress:parseInt(ini.progress)||0, link:ini.link||null,
  }).select().single();
  if (error) throw error;
  return { ...ini, id:data.id };
}

async function sbUpdateInitiative(ini) {
  if (!sb) {
    const i = initiativesCache.findIndex(x => x.id === ini.id);
    if (i !== -1) initiativesCache[i] = ini;
    lsSave('initiatives', initiativesCache); return ini;
  }
  const { error } = await sb.from('initiatives').update({
    goal:ini.goal, name:ini.name, description:ini.desc||null, resp:ini.resp||null,
    start_date:ini.start||null, end_date:ini.end||null,
    status:ini.status, progress:parseInt(ini.progress)||0, link:ini.link||null,
  }).eq('id', ini.id);
  if (error) throw error;
  const i = initiativesCache.findIndex(x => x.id === ini.id);
  if (i !== -1) initiativesCache[i] = ini;
  return ini;
}

async function sbDeleteInitiative(id) {
  if (!sb) { initiativesCache = initiativesCache.filter(i => i.id !== id); lsSave('initiatives', initiativesCache); return; }
  const { error } = await sb.from('initiatives').delete().eq('id', id);
  if (error) throw error;
  initiativesCache = initiativesCache.filter(i => i.id !== id);
}

/* ─────────────────────────────────────────────────────────────
   §16  SUPABASE: TASKS
   ───────────────────────────────────────────────────────────── */
async function fetchTasks() {
  if (!sb) { tasksCache = lsLoad('tasks',[]); return; }
  const { data, error } = await sb.from('tasks').select('*').order('created_at');
  if (error) { console.error('[fetchTasks]', error.message); tasksCache = lsLoad('tasks',[]); return; }
  tasksCache = (data||[]).map(r => ({
    id:r.id, name:r.name||'', resp:r.resp||'', due:r.due_date||'',
    priority:r.priority||'medium', status:r.status||'pending', notes:r.notes||'',
  }));
  lsSave('tasks', tasksCache);
}

async function sbInsertTask(t) {
  if (!sb) {
    t.id = 'L'+Date.now(); tasksCache.push(t); lsSave('tasks', tasksCache); return t;
  }
  const { data, error } = await sb.from('tasks').insert({
    name:t.name, resp:t.resp||null, due_date:t.due||null,
    priority:t.priority, status:t.status, notes:t.notes||null,
  }).select().single();
  if (error) throw error;
  return { ...t, id:data.id };
}

async function sbUpdateTask(t) {
  if (!sb) {
    const i = tasksCache.findIndex(x => x.id === t.id);
    if (i !== -1) tasksCache[i] = t;
    lsSave('tasks', tasksCache); return t;
  }
  const { error } = await sb.from('tasks').update({
    name:t.name, resp:t.resp||null, due_date:t.due||null,
    priority:t.priority, status:t.status, notes:t.notes||null,
  }).eq('id', t.id);
  if (error) throw error;
  const i = tasksCache.findIndex(x => x.id === t.id);
  if (i !== -1) tasksCache[i] = t;
  return t;
}

async function sbDeleteTask(id) {
  if (!sb) { tasksCache = tasksCache.filter(t => t.id !== id); lsSave('tasks', tasksCache); return; }
  const { error } = await sb.from('tasks').delete().eq('id', id);
  if (error) throw error;
  tasksCache = tasksCache.filter(t => t.id !== id);
}

async function sbUpdateTaskStatus(id, status) {
  const t = tasksCache.find(x => x.id === id); if (!t) return;
  t.status = status;
  if (!sb) { lsSave('tasks', tasksCache); return; }
  const { error } = await sb.from('tasks').update({status}).eq('id', id);
  if (error) console.error('[sbUpdateTaskStatus]', error.message);
}

/* ─────────────────────────────────────────────────────────────
   §17  SUPABASE: EVIDENCES
   ───────────────────────────────────────────────────────────── */
async function fetchEvidences() {
  if (!sb) { evidencesCache = lsLoad('evidences',[]); syncEvidencesToPrograms(); return; }
  const { data, error } = await sb.from('evidences').select('*').order('created_at', {ascending:false});
  if (error) { console.error('[fetchEvidences]', error.message); evidencesCache = lsLoad('evidences',[]); syncEvidencesToPrograms(); return; }
  evidencesCache = (data||[]).map(r => ({
    id:r.id, title:r.title||'', type:r.type||'',
    program_id:r.program_id||null, initiative_label:r.initiative_label||'',
    person:r.person||'', date:r.upload_date||'',
    link:r.link||'', notes:r.notes||'', file_data:r.file_data||null,
  }));
  lsSave('evidences', evidencesCache);
  syncEvidencesToPrograms();
}

function syncEvidencesToPrograms() {
  programsCache.forEach(p => {
    p.evidence = evidencesCache.filter(e => e.program_id === p.id);
  });
}

async function sbInsertEvidence(ev) {
  if (!sb) {
    ev.id = 'L'+Date.now(); evidencesCache.unshift(ev); lsSave('evidences', evidencesCache); return ev;
  }
  const { data, error } = await sb.from('evidences').insert({
    title:ev.title, type:ev.type||null,
    program_id:ev.program_id||null, initiative_label:ev.initiative_label||null,
    person:ev.person||null, upload_date:ev.date||new Date().toISOString().split('T')[0],
    link:ev.link||null, notes:ev.notes||null, file_data:ev.file_data||null,
  }).select().single();
  if (error) throw error;
  return { ...ev, id:data.id };
}

async function sbDeleteEvidence(id) {
  if (!sb) { evidencesCache = evidencesCache.filter(e => e.id !== id); lsSave('evidences', evidencesCache); return; }
  const { error } = await sb.from('evidences').delete().eq('id', id);
  if (error) throw error;
  evidencesCache = evidencesCache.filter(e => e.id !== id);
}

/* ─────────────────────────────────────────────────────────────
   §18  SUPABASE: TEACHER FOLLOWUPS (مستقل عن users)
   ───────────────────────────────────────────────────────────── */
async function fetchTeachers() {
  if (!sb) { teachersCache = lsLoad('teachers',[]); if (!teachersCache.length) teachersCache = DEMO_TEACHERS_DATA; return; }
  const { data, error } = await sb.from('teacher_followups').select('*').order('created_at');
  if (error) { console.error('[fetchTeachers]', error.message); teachersCache = lsLoad('teachers',[]); return; }
  teachersCache = (data||[]).map(r => ({
    id:r.id, name:r.name||'', assigned:r.assigned_tasks||0,
    done:r.done_tasks||0, lastReport:r.last_report||'', notes:r.notes||'',
    driveLink:r.drive_link||'', createdBy:r.created_by||'',
  }));
  lsSave('teachers', teachersCache);
}

const DEMO_TEACHERS_DATA = [
  {id:'d1',name:'أ. نورة العتيبي',assigned:12,done:10,lastReport:'2024-12-15',notes:''},
  {id:'d2',name:'أ. هند القحطاني',assigned:8,done:5,lastReport:'2024-12-10',notes:''},
  {id:'d3',name:'أ. سلمى الزهراني',assigned:10,done:9,lastReport:'2024-12-20',notes:''},
  {id:'d4',name:'أ. ريم الحربي',assigned:6,done:6,lastReport:'2024-12-12',notes:''},
  {id:'d5',name:'أ. مها الشمري',assigned:7,done:6,lastReport:'2024-12-18',notes:''},
  {id:'d6',name:'أ. فاطمة الدوسري',assigned:9,done:8,lastReport:'2024-12-22',notes:''},
];

async function sbInsertTeacher(tf) {
  if (!sb) {
    tf.id = 'L'+Date.now(); teachersCache.push(tf); lsSave('teachers', teachersCache); return tf;
  }
  const { data, error } = await sb.from('teacher_followups').insert({
    name:tf.name, assigned_tasks:parseInt(tf.assigned)||0,
    done_tasks:parseInt(tf.done)||0, last_report:tf.lastReport||null, notes:tf.notes||null,
    drive_link:tf.driveLink||null, created_by:tf.createdBy||null,
  }).select().single();
  if (error) throw error;
  return { ...tf, id:data.id };
}

async function sbUpdateTeacher(tf) {
  if (!sb) {
    const i = teachersCache.findIndex(x => x.id === tf.id);
    if (i !== -1) teachersCache[i] = tf;
    lsSave('teachers', teachersCache); return tf;
  }
  const { error } = await sb.from('teacher_followups').update({
    name:tf.name, assigned_tasks:parseInt(tf.assigned)||0,
    done_tasks:parseInt(tf.done)||0, last_report:tf.lastReport||null, notes:tf.notes||null,
    drive_link:tf.driveLink||null,
  }).eq('id', tf.id);
  if (error) throw error;
  const i = teachersCache.findIndex(x => x.id === tf.id);
  if (i !== -1) teachersCache[i] = tf;
  return tf;
}

async function sbDeleteTeacher(id) {
  // حذف سجل المتابعة فقط — لا يمس جدول users أبداً
  if (!sb) { teachersCache = teachersCache.filter(t => t.id !== id); lsSave('teachers', teachersCache); return; }
  const { error } = await sb.from('teacher_followups').delete().eq('id', id);
  if (error) throw error;
  teachersCache = teachersCache.filter(t => t.id !== id);
}

/* ─────────────────────────────────────────────────────────────
   §19  KPI (LocalStorage فقط)
   ───────────────────────────────────────────────────────────── */
async function fetchKPI() {
  kpiCache = lsLoad('kpi',[]);
  if (!kpiCache.length) {
    kpiCache = [
      {id:'k1',name:'نسبة النجاح العامة',target:95,achieved:91,unit:'%'},
      {id:'k2',name:'نسبة الحضور اليومي',target:98,achieved:96.5,unit:'%'},
      {id:'k3',name:'عدد الاختبارات المنفذة',target:80,achieved:68,unit:'اختبار'},
      {id:'k4',name:'نسبة رضا أولياء الأمور',target:90,achieved:87,unit:'%'},
      {id:'k5',name:'عدد الزيارات الصفية',target:120,achieved:105,unit:'زيارة'},
      {id:'k6',name:'عدد الطالبات المستفيدات',target:50,achieved:43,unit:'طالبة'},
    ];
    lsSave('kpi', kpiCache);
  }
}

/* ─────────────────────────────────────────────────────────────
   §20  SETTINGS
   ───────────────────────────────────────────────────────────── */
const DEFAULT_SETTINGS = {schoolName:'مدرسة النور الابتدائية',year:'١٤٤٦ / ١٤٤٧هـ',principal:'أ. سارة العتيبي',region:'منطقة المدينة المنورة'};

async function loadSettings() {
  let s = {...DEFAULT_SETTINGS};
  if (sb) {
    const { data, error } = await sb.from('settings').select('*').eq('id',1).maybeSingle();
    if (error) { console.error('[loadSettings]', error.message); }
    if (data) s = {schoolName:data.school_name||s.schoolName, year:data.academic_year||s.year, principal:data.principal_name||s.principal, region:data.region||s.region};
  } else {
    s = lsLoad('settings', s);
  }
  lsSave('settings', s);
  applySettingsToUI(s);
}

function loadSettingsForm() {
  const s = lsLoad('settings', DEFAULT_SETTINGS);
  const sv = (id,v) => { const e=document.getElementById(id); if(e) e.value=v||''; };
  sv('setting-school',s.schoolName); sv('setting-year',s.year);
  sv('setting-principal',s.principal); sv('setting-region',s.region);
}

async function saveSettings() {
  if (!can('editSettings')) { showToast('ليس لديك صلاحية تعديل الإعدادات','error'); return; }
  const g = id => (document.getElementById(id)?.value||'');
  const s = {schoolName:g('setting-school'),year:g('setting-year'),principal:g('setting-principal'),region:g('setting-region')};
  lsSave('settings', s);
  applySettingsToUI(s);
  if (sb) {
    const { error } = await sb.from('settings').upsert({
      id:1, school_name:s.schoolName, academic_year:s.year,
      principal_name:s.principal, region:s.region, updated_at:new Date().toISOString(),
    });
    if (error) { console.error('[saveSettings]', error.message); showToast('تعذّر حفظ الإعدادات في Supabase','error'); return; }
  }
  if (_activeSection === 'dashboard') renderDashboard();
  showToast('تم حفظ الإعدادات ✅','success');
}

// تطبيق الإعدادات على كل عناصر الواجهة (الشريط الجانبي + الترويسة)
function applySettingsToUI(s) {
  const sn = document.getElementById('sidebar-school-name'); if (sn) sn.textContent = s.schoolName || '';
  const sy = document.getElementById('sidebar-year');        if (sy) sy.textContent = s.year || '';
  const ti = document.getElementById('login-school-title'); if (ti) ti.textContent = s.schoolName || 'منصة الخطة التشغيلية';
}

async function resetToDemo() {
  if (!confirm('إعادة تحميل البيانات؟')) return;
await loadAllData(false); renderSection(_activeSection); showToast('تم تحديث البيانات ✅','success');
}
function clearLocalCache() {
  if (!confirm('مسح الكاش المحلي؟')) return;
  ['programs_local','initiatives','tasks','evidences','teachers','kpi','settings']
    .forEach(k => lsDel(k));
  showToast('تم مسح الكاش ✅','warning');
}

/* ─────────────────────────────────────────────────────────────
   §21  PROGRAMS UI
   ───────────────────────────────────────────────────────────── */
function renderPrograms() {
  const fs = document.getElementById('prog-filter-status')?.value||'all';
  const sq = (document.getElementById('prog-search')?.value||'').toLowerCase();
  const cnt = {planning:0,active:0,done:0,late:0};
  programsCache.forEach(p => { const s=calcProgramStatus(p); cnt[s]=(cnt[s]||0)+1; });
  const avg = programsCache.length ? Math.round(programsCache.reduce((s,p)=>s+(p.progress||0),0)/programsCache.length) : 0;
  const stEl = document.getElementById('programs-stats');
  if (stEl) stEl.innerHTML = `
    <div class="stat-card"><span class="stat-icon">🗂️</span><span class="stat-number">${programsCache.length}</span><span class="stat-label">إجمالي البرامج</span></div>
    <div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${cnt.done}</span><span class="stat-label">برامج منتهية</span></div>
    <div class="stat-card"><span class="stat-icon">▶️</span><span class="stat-number">${cnt.active}</span><span class="stat-label">برامج جارية</span></div>
    <div class="stat-card red"><span class="stat-icon">⚠️</span><span class="stat-number">${cnt.late}</span><span class="stat-label">برامج متأخرة</span></div>
    <div class="stat-card gold"><span class="stat-icon">📊</span><span class="stat-number">${avg}%</span><span class="stat-label">متوسط الإنجاز</span></div>`;

  const abp = document.getElementById('btn-add-program');
  if (abp) abp.style.display = can('addProgram') ? '' : 'none';

  const filtered = programsCache.filter(p =>
    (fs==='all' || calcProgramStatus(p)===fs) &&
    (!sq || p.name.toLowerCase().includes(sq) || (p.resp||'').toLowerCase().includes(sq))
  );

  const grid = document.getElementById('programs-grid'); if (!grid) return;
  if (!filtered.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🗂️</div><p>لا توجد برامج</p><small>أضف برنامجاً جديداً أو غيّر الفلتر</small></div>';
    return;
  }
  grid.innerHTML = filtered.map(p => buildProgramCard(p)).join('');
}

function buildProgramCard(p) {
  const status = calcProgramStatus(p);
  const pct    = parseInt(p.progress)||0;
  const inds   = p.indicators || indicatorsCache[p.id] || [];
  const evs    = evidencesCache.filter(e => e.program_id === p.id);
  const clr    = pct>=90?'#27ae60':pct>=60?'#2e86c1':pct>=30?'#f39c12':'#e74c3c';
  const total  = inds.length;
  const done   = inds.filter(i => i.is_completed).length;

  const indsHtml = total
    ? inds.map(ind => {
        const d=ind.is_completed, tc=can('toggleIndicator'), dc=can('deleteIndicator');
        return `<div class="indicator-row" id="irow-${ind.id}">
          <button class="ind-toggle" ${tc?`onclick="handleToggle('${p.id}','${ind.id}')"`:'disabled'}
            title="${d?'إلغاء الإنجاز':'وضع علامة مكتمل'}">${d?'✅':'⬜'}</button>
          <span class="ind-text" style="${d?'text-decoration:line-through;color:var(--text-muted)':''}">${ind.indicator_text}</span>
          ${dc?`<button class="ind-delete" onclick="handleDelInd('${p.id}','${ind.id}')">✕</button>`:''}
        </div>`;
      }).join('')
    : '<div style="font-size:12px;color:var(--text-muted);padding:4px 0">لا توجد مؤشرات بعد</div>';

  const addIndHtml = can('addIndicator')
    ? `<div class="add-indicator-row">
        <input id="iinput-${p.id}" class="ind-input" type="text" placeholder="أضف مؤشر إنجاز…"
               onkeydown="if(event.key==='Enter')handleAddInd('${p.id}')"/>
        <button class="btn-sm btn-evidence" onclick="handleAddInd('${p.id}')">+</button>
      </div>` : '';

  const evHtml = evs.length
    ? evs.map(ev => {
        const icon = getEvIcon(ev.type);
        const href = ev.link ? `href="${ev.link}" target="_blank"` : '';
        const tag  = ev.link ? 'a' : 'span';
        return `<${tag} class="evidence-chip${ev.link?'':' no-link'}" ${href} title="${ev.person?('أضافتها: '+ev.person):''}">${icon} ${ev.title}</${tag}>`;
      }).join('')
    : '<span style="font-size:12px;color:var(--text-muted)">لا توجد شواهد بعد</span>';

  const editBtn  = can('editProgram')   ? `<button class="btn-sm btn-edit"    onclick="openProgramModal('${p.id}')">✏️ تعديل</button>`  : '';
  const delBtn   = can('deleteProgram') ? `<button class="btn-sm btn-delete"  onclick="deleteProgram('${p.id}')">🗑️ حذف</button>`     : '';

  return `
  <div class="program-card status-${status}" id="pcard-${p.id}">
    <div class="program-card-header">
      <div class="program-card-title">${p.name}</div>
      <span class="badge ${SB[status]}">${SI[status]} ${SL[status]}</span>
    </div>
    <div class="program-card-body">
      ${p.desc ? `<div class="program-card-desc">${p.desc}</div>` : ''}
      <div class="program-meta-grid">
        <div class="program-meta-item">👩‍🏫 <strong>${p.resp||'—'}</strong></div>
        <div class="program-meta-item">🎯 <strong>${p.target||'—'}</strong></div>
        <div class="program-meta-item">📅 <strong>${fmtDate(p.start)}</strong></div>
        <div class="program-meta-item">🏁 <strong>${fmtDate(p.end)}</strong></div>
      </div>
      <div class="program-progress-section">
        <div class="program-progress-label">
          <span id="plbl-${p.id}">نسبة الإنجاز${total?` (${done}/${total} مؤشر)`:''}</span>
          <span id="ppct-${p.id}" style="font-weight:800;color:${clr}">${pct}%</span>
        </div>
        <div class="progress-bar" style="height:10px">
          <div id="pbar-${p.id}" class="progress-fill"
               style="width:${pct}%;background:linear-gradient(90deg,${clr},${clr}cc)"></div>
        </div>
      </div>
      <div class="program-indicators">
        <div class="program-indicators-title">📌 مؤشرات الإنجاز</div>
        <div class="indicators-list" id="ilist-${p.id}">${indsHtml}</div>
        ${addIndHtml}
      </div>
      <div class="program-evidence-section">
        <div class="program-evidence-title">
          <span>📎 الشواهد (${evs.length})</span>
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

/* ─────────────────────────────────────────────────────────────
   §22  PROGRAM MODAL
   ───────────────────────────────────────────────────────────── */
function openProgramModal(id) {
  if (id  && !can('editProgram'))  { showToast('ليس لديك صلاحية تعديل البرامج','error'); return; }
  if (!id && !can('addProgram'))   { showToast('ليس لديك صلاحية إضافة برامج','error'); return; }
  ['prog-edit-id','prog-name','prog-resp','prog-desc','prog-target',
   'prog-start','prog-end','prog-progress','prog-status','prog-status-display'].forEach(fid => {
    const e = document.getElementById(fid); if (e) e.value='';
  });
  const ti = document.getElementById('program-modal-title');
  if (ti) ti.textContent = 'إضافة برنامج جديد';
  if (id) {
    const p = programsCache.find(x => x.id === id); if (!p) return;
    const sv = (fid,v) => { const e=document.getElementById(fid); if(e) e.value=v??''; };
    sv('prog-edit-id',p.id); sv('prog-name',p.name); sv('prog-resp',p.resp);
    sv('prog-desc',p.desc); sv('prog-target',p.target);
    sv('prog-start',p.start); sv('prog-end',p.end); sv('prog-progress',p.progress??0);
    if (ti) ti.textContent = 'تعديل البرنامج';
    autoCalcProgStatus();
  }
  openModal('program-modal');
}

async function saveProgram() {
  const editId = document.getElementById('prog-edit-id')?.value;
  if (editId  && !can('editProgram')) { showToast('ليس لديك صلاحية تعديل البرامج','error'); return; }
  if (!editId && !can('addProgram'))  { showToast('ليس لديك صلاحية إضافة برامج','error');   return; }
  const g = id => (document.getElementById(id)?.value||'');
  const name = g('prog-name').trim(); if (!name) { showToast('يرجى إدخال اسم البرنامج','error'); return; }
  const p = {
    id:editId||null, name, resp:g('prog-resp').trim(),
    desc:g('prog-desc').trim(), target:g('prog-target').trim(),
    start:g('prog-start'), end:g('prog-end'),
    progress:parseInt(g('prog-progress'))||0, evidence:[], indicators:[],
  };
  const btn = document.getElementById('prog-save-btn');
  if (btn) { btn.disabled=true; btn.textContent='جارٍ الحفظ…'; }
  try {
    let saved;
    if (editId) {
      const ex = programsCache.find(x => x.id === editId);
      p.evidence = ex?.evidence||[]; p.indicators = ex?.indicators||[];
      saved = await sbUpdateProgram(p);
      const i = programsCache.findIndex(x => x.id === saved.id);
      if (i !== -1) programsCache[i] = saved;
    } else {
      saved = await sbInsertProgram(p);
      saved.indicators = []; saved.evidence = [];
      programsCache.push(saved);
    }
    closeModal('program-modal');
    renderPrograms();
    showToast(editId?'تم تعديل البرنامج ✅':'تمت إضافة البرنامج ✅','success');
  } catch (err) {
    console.error('[saveProgram]', err.message);
    showToast('خطأ في الحفظ: '+err.message,'error');
  } finally {
    if (btn) { btn.disabled=false; btn.textContent='💾 حفظ البرنامج'; }
  }
}

async function deleteProgram(id) {
  if (!can('deleteProgram')) { showToast('ليس لديك صلاحية حذف البرامج','error'); return; }
  if (!confirm('حذف هذا البرنامج وجميع مؤشراته؟')) return;
  try {
    await sbDeleteProgram(id);
    programsCache = programsCache.filter(p => p.id !== id);
    evidencesCache = evidencesCache.filter(e => e.program_id !== id);
    renderPrograms();
    showToast('تم حذف البرنامج 🗑️','warning');
  } catch (err) { console.error('[deleteProgram]', err.message); showToast('خطأ في الحذف: '+err.message,'error'); }
}

/* ─────────────────────────────────────────────────────────────
   §23  PROGRAM DETAIL MODAL
   ───────────────────────────────────────────────────────────── */
function viewProgramDetail(id) {
  const p = programsCache.find(x => String(x.id) === String(id));
  if (!p) {
    showToast('لم يتم العثور على البرنامج رقم ' + id, 'error');
    return;
  }

  const status = calcProgramStatus(p);
  const pct = parseInt(p.progress) || 0;
  const clr = pct >= 90 ? '#27ae60' : pct >= 60 ? '#2e86c1' : pct >= 30 ? '#f39c12' : '#e74c3c';
  const inds = indicatorsCache[id] || p.indicators || [];
  const evs = evidencesCache.filter(e => String(e.program_id) === String(id));

  const ti = document.getElementById('detail-modal-title');
if (ti) ti.textContent = p.name;
  const indsHtml = inds.length
   ? inds.map(ind => `
  <div onclick="sbToggleIndicator('${p.id}','${ind.id}'); setTimeout(()=>viewProgramDetail('${p.id}'),300);"
       style="cursor:pointer;display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-light)">
    <span style="font-size:18px">${ind.is_completed ? '✅' : '⬜'}</span>
    <span style="font-size:13px;${ind.is_completed ? 'text-decoration:line-through;color:var(--text-muted)' : ''}">${ind.indicator_text}</span>
  </div>`).join('')
    : '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">لا توجد مؤشرات</p>';

  const evHtml = evs.length
    ? evs.map(ev => {
        const icon = getEvIcon(ev.type);
        const delBtn = can('deleteEvidence')
          ? `<button class="btn-sm btn-delete" onclick="handleDelEv('${ev.id}');closeModal('program-detail-modal');viewProgramDetail('${p.id}')">🗑️</button>`
          : '';
        return `<div class="evidence-detail-item">
          <div class="ev-det-icon">${icon}</div>
          <div class="ev-det-info">
            <div class="ev-det-title">${ev.title}</div>
            <div class="ev-det-meta">${ev.person?('👩‍🏫 أضافتها: '+ev.person):'—'}${ev.date?(' · '+fmtDate(ev.date)):''}${ev.type?(' · '+ev.type):''}</div>
            ${ev.notes?`<div class="ev-det-meta" style="font-style:italic">${ev.notes}</div>`:''}
          </div>
          <div class="ev-det-actions">
            ${ev.link?`<a href="${ev.link}" target="_blank" class="btn-sm btn-view">🔗 فتح الرابط</a>`:''}
            ${delBtn}
          </div>
        </div>`;
      }).join('')
    : '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">لا توجد شواهد مرتبطة. تُضاف الشواهد من صفحة «التقارير والشواهد».</p>';

const body = document.getElementById('program-detail-body');
if (!body) {
  showToast('program-detail-body غير موجود', 'error');
  return;
}
 
  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;padding:16px;background:var(--bg);border-radius:10px">
      <div style="flex:1">
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:5px">حالة التنفيذ</div>
        <span class="badge ${SB[status]}" style="font-size:13px">${SI[status]} ${SL[status]}</span>
      </div>
      <div style="text-align:center">
        <div style="font-size:28px;font-weight:800;color:${clr}">${pct}%</div>
        <div style="font-size:12px;color:var(--text-muted)">نسبة الإنجاز</div>
      </div>
    </div>
    <div style="margin-bottom:18px">
      <div class="progress-bar" style="height:12px;border-radius:6px">
        <div class="progress-fill" style="width:${pct}%;background:linear-gradient(90deg,${clr},${clr}cc)"></div>
      </div>
    </div>
    <div class="detail-section">
      <h4>📋 بيانات البرنامج</h4>
      <div class="detail-grid">
        <div class="detail-item"><div class="detail-item-label">المسؤول</div><div class="detail-item-value">${p.resp||'—'}</div></div>
        <div class="detail-item"><div class="detail-item-label">الفئة المستهدفة</div><div class="detail-item-value">${p.target||'—'}</div></div>
        <div class="detail-item"><div class="detail-item-label">تاريخ البدء</div><div class="detail-item-value">${fmtDate(p.start)}</div></div>
        <div class="detail-item"><div class="detail-item-label">تاريخ الانتهاء</div><div class="detail-item-value">${fmtDate(p.end)}</div></div>
      </div>
      ${p.desc?`<div style="margin-top:12px;padding:12px 14px;background:var(--bg);border-radius:8px;font-size:13px;line-height:1.7">${p.desc}</div>`:''}
    </div>
    <div class="detail-section">
      <h4>📌 مؤشرات الإنجاز (${inds.filter(i=>i.is_completed).length}/${inds.length})</h4>
      ${indsHtml}
    </div>
    <div class="detail-section">
      <h4 style="display:flex;justify-content:space-between;align-items:center">
        📎 الشواهد المرتبطة (${evs.length})
      </h4>
      <div class="evidence-list-detail">${evHtml}</div>
    </div>`;
  openModal('program-detail-modal');
}

/* ─────────────────────────────────────────────────────────────
   §24  INDICATORS HANDLERS
   ───────────────────────────────────────────────────────────── */
async function handleAddInd(progId) {
  if (!can('addIndicator')) { showToast('ليس لديك صلاحية إضافة مؤشرات','error'); return; }
  const inp = document.getElementById('iinput-'+progId); if (!inp) return;
  const txt = inp.value.trim(); if (!txt) { showToast('أدخل نص المؤشر أولاً','error'); return; }
  inp.disabled = true;
  try {
    await sbAddIndicator(progId, txt);
    inp.value = '';
    repaintCard(progId);
    showToast('تمت إضافة المؤشر ✅','success');
  } catch (err) { console.error('[handleAddInd]',err.message); showToast('خطأ: '+err.message,'error'); }
  finally { inp.disabled = false; inp.focus(); }
}

async function handleToggle(progId, indId) {
  if (currentUser.role === 'teacher') {
    const prog = programsCache.find(p => p.id === progId);
    if (prog?.resp && !prog.resp.includes(currentUser.name)) {
      showToast('يمكنك تحديث مؤشرات برامجك فقط','error'); return;
    }
  }
  try { await sbToggleIndicator(progId, indId); repaintCard(progId); }
  catch (err) { console.error('[handleToggle]',err.message); showToast('خطأ: '+err.message,'error'); }
}

async function handleDelInd(progId, indId) {
  if (!can('deleteIndicator')) { showToast('ليس لديك صلاحية حذف مؤشرات','error'); return; }
  if (!confirm('حذف هذا المؤشر؟')) return;
  try { await sbDeleteIndicator(progId, indId); repaintCard(progId); showToast('تم الحذف 🗑️','warning'); }
  catch (err) { console.error('[handleDelInd]',err.message); showToast('خطأ: '+err.message,'error'); }
}

function repaintCard(progId) {
  const p = programsCache.find(x => x.id === progId); if (!p) return;
  const inds = indicatorsCache[progId]||[]; p.indicators = inds;
  const pct  = parseInt(p.progress)||0;
  const total = inds.length, done = inds.filter(i=>i.is_completed).length;
  const clr  = pct>=90?'#27ae60':pct>=60?'#2e86c1':pct>=30?'#f39c12':'#e74c3c';
  const pctEl  = document.getElementById('ppct-'+progId);
  const barEl  = document.getElementById('pbar-'+progId);
  const lblEl  = document.getElementById('plbl-'+progId);
  if (pctEl) { pctEl.textContent = pct+'%'; pctEl.style.color = clr; }
  if (barEl) { barEl.style.width = pct+'%'; barEl.style.background = `linear-gradient(90deg,${clr},${clr}cc)`; }
  if (lblEl) lblEl.textContent = `نسبة الإنجاز${total?` (${done}/${total} مؤشر)`:''}`;
  const card = document.getElementById('pcard-'+progId);
  if (card) {
    card.className = 'program-card status-'+calcProgramStatus(p);
    const b = card.querySelector('.badge'); const s = calcProgramStatus(p);
    if (b) { b.className='badge '+SB[s]; b.textContent=SI[s]+' '+SL[s]; }
  }
  const listEl = document.getElementById('ilist-'+progId); if (!listEl) return;
  if (!inds.length) { listEl.innerHTML='<div style="font-size:12px;color:var(--text-muted);padding:4px 0">لا توجد مؤشرات بعد</div>'; return; }
  listEl.innerHTML = inds.map(ind => {
    const d=ind.is_completed, tc=can('toggleIndicator'), dc=can('deleteIndicator');
    return `<div class="indicator-row" id="irow-${ind.id}">
      <button class="ind-toggle" ${tc?`onclick="handleToggle('${progId}','${ind.id}')"`:'disabled'}
        title="${d?'إلغاء الإنجاز':'وضع علامة مكتمل'}">${d?'✅':'⬜'}</button>
      <span class="ind-text" style="${d?'text-decoration:line-through;color:var(--text-muted)':''}">${ind.indicator_text}</span>
      ${dc?`<button class="ind-delete" onclick="handleDelInd('${progId}','${ind.id}')">✕</button>`:''}
    </div>`;
  }).join('');
}

/* ─────────────────────────────────────────────────────────────
   §25  EVIDENCE MODAL
   ───────────────────────────────────────────────────────────── */
const getEvIcon = t => ({link:'🔗',file:'📎',image:'🖼️',pdf:'📄',word:'📝',excel:'📊'}[t]||'📎');
const getEvidenceIcon = getEvIcon;

function toggleEvidenceInput() {
  const type = document.getElementById('ev-type')?.value;
  document.getElementById('ev-link-group')?.classList.toggle('hidden', type!=='link');
  document.getElementById('ev-file-group')?.classList.toggle('hidden', type!=='file');
  document.getElementById('ev-image-group')?.classList.toggle('hidden',type!=='image');
  pendingFileData = null; pendingImageData = null;
  ['ev-file-preview','ev-image-preview'].forEach(id => {
    const el = document.getElementById(id); if(el){el.classList.add('hidden');el.innerHTML='';}
  });
}

function openEvidenceModal(progId, evId) {
  if (!can('addEvidence')) { showToast('ليس لديك صلاحية رفع الشواهد','error'); return; }
  pendingFileData = null; pendingImageData = null;
  document.getElementById('ev-program-id').value = progId;
  document.getElementById('ev-edit-id').value    = evId||'';
  const ti = document.getElementById('evidence-modal-title'); if(ti) ti.textContent = evId?'تعديل الشاهد':'إضافة شاهد';
  ['ev-title','ev-link','ev-person','ev-notes'].forEach(f => { const e=document.getElementById(f); if(e) e.value=''; });
  const te = document.getElementById('ev-type'); if(te) te.value='link';
  toggleEvidenceInput();
  openModal('evidence-modal');
}

function handleFileSelect(input) {
  const file = input.files[0]; if (!file) return;
  if (file.size>5*1024*1024) { showToast('الملف أكبر من 5 MB','error'); input.value=''; return; }
  const reader = new FileReader();
  reader.onload = e => {
    pendingFileData = {name:file.name,mimeType:file.type,base64:e.target.result};
    const prev = document.getElementById('ev-file-preview'); if(!prev) return;
    prev.classList.remove('hidden');
    prev.innerHTML = `<span style="font-size:20px">${getFileIcon(file.name)}</span>
      <span class="file-name">${file.name}</span>
      <span style="font-size:11px;color:var(--text-muted)">${(file.size/1024).toFixed(0)} KB</span>
      <span class="file-remove" onclick="pendingFileData=null;document.getElementById('ev-file-input').value='';this.parentElement.classList.add('hidden')">✕</span>`;
  };
  reader.readAsDataURL(file);
}

function handleImageSelect(input) {
  const file = input.files[0]; if (!file) return;
  if (file.size>5*1024*1024) { showToast('الصورة أكبر من 5 MB','error'); input.value=''; return; }
  const reader = new FileReader();
  reader.onload = e => {
    pendingImageData = {name:file.name,base64:e.target.result};
    const prev = document.getElementById('ev-image-preview'); if(!prev) return;
    prev.classList.remove('hidden');
    prev.innerHTML = `<img src="${e.target.result}" alt="${file.name}"/>`;
  };
  reader.readAsDataURL(file);
}

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ext==='pdf'?'📄':ext==='doc'||ext==='docx'?'📝':ext==='xls'||ext==='xlsx'?'📊':'📎';
}

async function saveEvidence() {
  if (!can('addEvidence')) { showToast('ليس لديك صلاحية رفع الشواهد','error'); return; }
  const g = id => (document.getElementById(id)?.value||'');
  const progId = g('ev-program-id');
  const title  = g('ev-title').trim(); if (!title) { showToast('يرجى إدخال عنوان الشاهد','error'); return; }
  const type   = g('ev-type');
  const ev = {
    id:null, title, type,
    program_id     : progId||null,
    initiative_label: '',
    person : g('ev-person').trim(),
    date   : new Date().toISOString().split('T')[0],
    link   : type==='link' ? g('ev-link').trim() : '',
    notes  : g('ev-notes').trim(),
    file_data: type==='file'?(pendingFileData?.base64||null):type==='image'?(pendingImageData?.base64||null):null,
  };
  const btn = document.querySelector('#evidence-modal .btn-primary');
  if (btn) { btn.disabled=true; btn.textContent='جارٍ الحفظ…'; }
  try {
    const saved = await sbInsertEvidence(ev);
    evidencesCache.unshift(saved);
    syncEvidencesToPrograms();
    if (saved.program_id) await syncProgress(saved.program_id);
    closeModal('evidence-modal');
    renderPrograms(); renderReports();
    showToast('تم حفظ الشاهد ✅','success');
  } catch (err) { console.error('[saveEvidence]',err.message); showToast('خطأ: '+err.message,'error'); }
  finally { if (btn) { btn.disabled=false; btn.textContent='📎 حفظ الشاهد'; } }
}

async function handleDelEv(evId) {
  if (!can('deleteEvidence')) { showToast('ليس لديك صلاحية حذف الشواهد','error'); return; }
  if (!confirm('حذف هذا الشاهد؟')) return;
  const target = evidencesCache.find(e => e.id === evId);
  const affectedProg = target?.program_id || null;
  try {
    await sbDeleteEvidence(evId);
    syncEvidencesToPrograms();
    if (affectedProg) await syncProgress(affectedProg);
    renderPrograms(); renderReports();
    showToast('تم حذف الشاهد 🗑️','warning');
  } catch (err) { console.error('[handleDelEv]',err.message); showToast('خطأ: '+err.message,'error'); }
}
function deleteEvidence(id) { handleDelEv(id); }

/* ─────────────────────────────────────────────────────────────
   §26  INITIATIVES SECTION
   ───────────────────────────────────────────────────────────── */
const GOAL_BADGE = {'تحسين التحصيل الدراسي':'badge-info','تعزيز الانضباط':'badge-warning','التنمية المهنية':'badge-purple','الشراكة المجتمعية':'badge-success','تعزيز الهوية الوطنية':'badge-secondary','متابعة الفاقد التعليمي':'badge-danger'};
const INI_STATUS_BADGE = {'منجزة':'badge-success','قيد التنفيذ':'badge-info','لم تبدأ':'badge-secondary','متأخرة':'badge-danger'};
const GOAL_MAP = {academic:'تحسين التحصيل الدراسي',discipline:'تعزيز الانضباط',professional:'التنمية المهنية',community:'الشراكة المجتمعية',identity:'تعزيز الهوية الوطنية'};

function filterPlan(v) { _planFilter=v; renderPlan(); }
function searchPlan(v) { _planSearch=v.toLowerCase(); renderPlan(); }

function renderPlan() {
  let data = [...initiativesCache];
  if (_planFilter!=='all'&&GOAL_MAP[_planFilter]) data=data.filter(i=>i.goal===GOAL_MAP[_planFilter]);
  if (_planSearch) data=data.filter(i=>(i.name+(i.goal||'')+(i.resp||'')+(i.desc||'')).toLowerCase().includes(_planSearch));
  const tbody = document.getElementById('plan-tbody'); if (!tbody) return;
  tbody.innerHTML = data.length
    ? data.map((ini,idx) => `
        <tr><td>${idx+1}</td>
          <td><span class="badge ${GOAL_BADGE[ini.goal]||'badge-secondary'}">${ini.goal||'—'}</span></td>
          <td style="font-weight:600">${ini.name}</td>
          <td>${ini.resp||'—'}</td>
          <td>${fmtDate(ini.start)}</td>
          <td>${fmtDate(ini.end)}</td>
          <td><span class="badge ${INI_STATUS_BADGE[ini.status]||'badge-secondary'}">${ini.status}</span></td>
          <td><div class="progress-wrap"><div class="progress-bar" style="min-width:70px"><div class="progress-fill" style="width:${ini.progress||0}%"></div></div><span class="progress-text">${ini.progress||0}%</span></div></td>
          <td>${ini.link?`<a href="${ini.link}" target="_blank" class="btn-sm btn-view">📎 عرض</a>`:'—'}</td>
          <td><div style="display:flex;gap:4px;flex-wrap:nowrap">
            ${can('editInitiative')?`<button class="btn-sm btn-edit" onclick="openInitiativeModal('${ini.id}')">✏️</button>`:''}
            ${can('deleteInitiative')?`<button class="btn-sm btn-delete" onclick="deleteInitiative('${ini.id}')">🗑️</button>`:''}
          </div></td>
        </tr>`).join('')
    : '<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-muted)">لا توجد مبادرات</td></tr>';
}

function openInitiativeModal(id) {
  if (id  && !can('editInitiative'))  { showToast('ليس لديك صلاحية تعديل المبادرات','error'); return; }
  if (!id && !can('addInitiative'))   { showToast('ليس لديك صلاحية إضافة مبادرات','error');   return; }
  const clr = fid => { const e=document.getElementById(fid); if(e) e.value=''; };
  ['ini-edit-id','ini-name','ini-desc','ini-resp','ini-start','ini-end','ini-link'].forEach(clr);
  const gEl=document.getElementById('ini-goal'); if(gEl) gEl.value='تحسين التحصيل الدراسي';
  const sEl=document.getElementById('ini-status'); if(sEl) sEl.value='لم تبدأ';
  const pEl=document.getElementById('ini-progress'); if(pEl) pEl.value='0';
  const ti=document.getElementById('ini-modal-title'); if(ti) ti.textContent='إضافة مبادرة جديدة';
  if (id) {
    const ini = initiativesCache.find(x => x.id === id); if (!ini) return;
    const sv = (fid,v) => { const e=document.getElementById(fid); if(e) e.value=v??''; };
    sv('ini-edit-id',ini.id); sv('ini-goal',ini.goal); sv('ini-name',ini.name);
    sv('ini-desc',ini.desc||''); sv('ini-resp',ini.resp||'');
    sv('ini-start',ini.start||''); sv('ini-end',ini.end||'');
    sv('ini-status',ini.status); sv('ini-progress',ini.progress||0); sv('ini-link',ini.link||'');
    if(ti) ti.textContent='تعديل المبادرة';
  }
  openModal('initiative-modal');
}

async function saveInitiative() {
  const editId = document.getElementById('ini-edit-id')?.value;
  if (editId  && !can('editInitiative'))  { showToast('ليس لديك صلاحية تعديل المبادرات','error'); return; }
  if (!editId && !can('addInitiative'))   { showToast('ليس لديك صلاحية إضافة مبادرات','error');   return; }
  const g = id => (document.getElementById(id)?.value||'');
  const name = g('ini-name').trim(); if (!name) { showToast('يرجى إدخال اسم المبادرة','error'); return; }
  const ini = {
    id:editId||null, goal:g('ini-goal'), name, desc:g('ini-desc').trim(),
    resp:g('ini-resp').trim(), start:g('ini-start'), end:g('ini-end'),
    status:g('ini-status'), progress:parseInt(g('ini-progress'))||0, link:g('ini-link').trim(),
  };
  const btn = document.getElementById('ini-save-btn');
  if (btn) { btn.disabled=true; btn.textContent='جارٍ الحفظ…'; }
  try {
    let saved;
    if (editId) {
      saved = await sbUpdateInitiative(ini);
      const i = initiativesCache.findIndex(x => x.id === saved.id);
      if (i !== -1) initiativesCache[i] = saved;
    } else {
      saved = await sbInsertInitiative(ini);
      initiativesCache.push(saved);
    }
    closeModal('initiative-modal'); renderPlan();
    showToast(editId?'تم تعديل المبادرة ✅':'تمت إضافة المبادرة ✅','success');
  } catch (err) { console.error('[saveInitiative]',err.message); showToast('خطأ: '+err.message,'error'); }
  finally { if(btn){ btn.disabled=false; btn.textContent='💾 حفظ المبادرة'; } }
}

async function deleteInitiative(id) {
  if (!can('deleteInitiative')) { showToast('ليس لديك صلاحية حذف المبادرات','error'); return; }
  if (!confirm('حذف هذه المبادرة؟')) return;
  try {
    await sbDeleteInitiative(id); renderPlan();
    showToast('تم الحذف 🗑️','warning');
  } catch (err) { console.error('[deleteInitiative]',err.message); showToast('خطأ: '+err.message,'error'); }
}

/* ─────────────────────────────────────────────────────────────
   §27  KPI SECTION
   ───────────────────────────────────────────────────────────── */
function renderKPI() {
  const kc = document.getElementById('kpi-cards');
  if (kc) kc.innerHTML = kpiCache.map(k => {
    const pct=k.target>0?Math.min(100,Math.round((k.achieved/k.target)*100)):0;
    const clr=pct>=90?'#27ae60':pct>=70?'#f39c12':'#e74c3c';
    const deg=Math.round(pct*3.6);
    return `<div class="kpi-card"><div class="kpi-card-name">${k.name}</div>
      <div class="kpi-circle" style="background:conic-gradient(${clr} ${deg}deg,#eaecee ${deg}deg)">
        <div class="kpi-circle-inner">${pct}%</div>
      </div>
      <div class="kpi-values">المستهدف: <strong>${k.target} ${k.unit}</strong> · المتحقق: <strong>${k.achieved} ${k.unit}</strong></div></div>`;
  }).join('');
  const kt = document.getElementById('kpi-tbody');
  if (kt) kt.innerHTML = kpiCache.map(k => {
    const pct=k.target>0?Math.min(100,Math.round((k.achieved/k.target)*100)):0;
    const bc=pct>=90?'badge-success':pct>=70?'badge-warning':'badge-danger';
    const bl=pct>=90?'ممتاز':pct>=70?'جيد':'يحتاج تحسين';
    return `<tr><td style="font-weight:600">${k.name}</td><td>${k.target} ${k.unit}</td><td>${k.achieved} ${k.unit}</td>
      <td><div class="progress-wrap"><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div><span class="progress-text">${pct}%</span></div></td>
      <td><span class="badge ${bc}">${bl}</span></td>
      <td><div style="display:flex;gap:4px"><button class="btn-sm btn-edit" onclick="openKpiModal('${k.id}')">✏️</button><button class="btn-sm btn-delete" onclick="deleteKPI('${k.id}')">🗑️</button></div></td></tr>`;
  }).join('');
  setTimeout(() => drawKPIBars(), 50);
}

function openKpiModal(id) {
  const ti=document.getElementById('kpi-modal-title'); if(ti) ti.textContent=id?'تعديل المؤشر':'إضافة مؤشر أداء';
  ['kpi-edit-id','kpi-name','kpi-target','kpi-achieved','kpi-unit'].forEach(fid=>{ const e=document.getElementById(fid); if(e) e.value=''; });
  if(id){ const k=kpiCache.find(x=>x.id===id); if(!k)return; const sv=(fid,v)=>{const e=document.getElementById(fid);if(e)e.value=v??'';}; sv('kpi-edit-id',k.id);sv('kpi-name',k.name);sv('kpi-target',k.target);sv('kpi-achieved',k.achieved);sv('kpi-unit',k.unit); }
  openModal('kpi-modal');
}

function saveKPI() {
  const g=id=>(document.getElementById(id)?.value||'');
  const editId=g('kpi-edit-id');
  const name=g('kpi-name').trim(); if(!name){showToast('يرجى إدخال اسم المؤشر','error');return;}
  const item={id:editId||'k'+Date.now(),name,target:parseFloat(g('kpi-target'))||0,achieved:parseFloat(g('kpi-achieved'))||0,unit:g('kpi-unit').trim()||'%'};
  if(editId){const i=kpiCache.findIndex(x=>x.id===editId);if(i!==-1)kpiCache[i]=item;} else kpiCache.push(item);
  lsSave('kpi',kpiCache); closeModal('kpi-modal'); renderKPI();
  showToast(editId?'تم التعديل ✅':'تمت الإضافة ✅','success');
}

function deleteKPI(id) {
  if(!confirm('حذف هذا المؤشر؟'))return;
  kpiCache=kpiCache.filter(k=>k.id!==id); lsSave('kpi',kpiCache);
  renderKPI(); showToast('تم الحذف 🗑️','warning');
}

function drawKPIBars() {
  const c=document.getElementById('kpi-chart'); if(!c||!kpiCache.length)return;
  const W=c.parentElement?.offsetWidth||700; c.width=W; c.height=300;
  const ctx=c.getContext('2d'); ctx.clearRect(0,0,W,300);
  const pL=20,pR=20,pT=20,pB=80,cW=W-pL-pR,cH=300-pT-pB,n=kpiCache.length,gap=cW/n,bW=Math.min(38,gap/2.5);
  for(let i=0;i<=5;i++){const y=pT+cH-(cH*i/5);ctx.strokeStyle='#eaecee';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pL,y);ctx.lineTo(W-pR,y);ctx.stroke();ctx.fillStyle='#aaa';ctx.font='11px Tajawal';ctx.textAlign='left';ctx.fillText((i*20)+'%',pL,y-3);}
  kpiCache.forEach((k,i)=>{const pct=k.target>0?Math.min(100,(k.achieved/k.target)*100):0,x=pL+i*gap+gap/2,bH=(pct/100)*cH;ctx.fillStyle='#dce8f5';ctx.fillRect(x-bW*.6,pT,bW*1.2,cH);const clr=pct>=90?'#27ae60':pct>=70?'#f39c12':'#e74c3c';ctx.fillStyle=clr;ctx.fillRect(x-bW/2,pT+cH-bH,bW,bH);ctx.fillStyle='#333';ctx.font='bold 11px Tajawal';ctx.textAlign='center';ctx.fillText(Math.round(pct)+'%',x,pT+cH-bH-5);const w=k.name.split(' ');ctx.fillStyle='#555';ctx.font='11px Tajawal';ctx.fillText(w.slice(0,2).join(' '),x,300-pB+16);if(w.length>2)ctx.fillText(w.slice(2).join(' '),x,300-pB+30);});
}

/* ─────────────────────────────────────────────────────────────
   §28  TASKS SECTION
   ───────────────────────────────────────────────────────────── */
function filterTasks(v) { _taskFilter=v; renderTasks(); }
function filterTasksPriority(v) { _taskPriFilter=v; renderTasks(); }

function renderTasks() {
  let tasks = [...tasksCache];
  if (currentUser?.role==='teacher') tasks=tasks.filter(t=>t.resp&&t.resp.includes(currentUser.name));
  if (_taskFilter==='late') tasks=tasks.filter(t=>t.status!=='done'&&t.due&&new Date(t.due)<new Date());
  else if (_taskFilter!=='all') tasks=tasks.filter(t=>t.status===_taskFilter);
  if (_taskPriFilter!=='all') tasks=tasks.filter(t=>t.priority===_taskPriFilter);
  const PL={high:'عالية',medium:'متوسطة',low:'منخفضة'};
  const SL2={pending:'معلقة',inprogress:'قيد التنفيذ',done:'منجزة'};
  const SBM={pending:'badge-warning',inprogress:'badge-info',done:'badge-success'};
  const grid=document.getElementById('tasks-grid'); if(!grid)return;
  grid.innerHTML=tasks.length?tasks.map(t=>{
    const late=t.status!=='done'&&t.due&&new Date(t.due)<new Date();
    return`<div class="task-card priority-${t.priority}">
      <div class="task-card-header"><div class="task-title">${t.name}</div><span class="badge ${late?'badge-danger':SBM[t.status]}">${late?'⚠️ متأخرة':SL2[t.status]}</span></div>
      <div class="task-meta"><span>👩‍🏫 ${t.resp||'—'}</span><span>📅 ${fmtDate(t.due)}</span><span>🔴 ${PL[t.priority]||t.priority}</span>${t.notes?`<span>📝 ${t.notes}</span>`:''}</div>
      <div class="task-actions">
        <select class="task-status-select" onchange="chgTaskStatus('${t.id}',this.value)">
          <option value="pending" ${t.status==='pending'?'selected':''}>معلقة</option>
          <option value="inprogress" ${t.status==='inprogress'?'selected':''}>قيد التنفيذ</option>
          <option value="done" ${t.status==='done'?'selected':''}>منجزة</option>
        </select>
        ${can('editTask')?`<button class="btn-sm btn-edit" onclick="openTaskModal('${t.id}')">✏️</button>`:''}
        ${can('deleteTask')?`<button class="btn-sm btn-delete" onclick="deleteTask('${t.id}')">🗑️</button>`:''}
      </div>
    </div>`;
  }).join(''):'<p style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px">لا توجد مهام</p>';
}

async function chgTaskStatus(id, status) {
  await sbUpdateTaskStatus(id, status);
  renderTasks(); renderDashboard();
  showToast('تم تحديث الحالة ✅','success');
}
function changeTaskStatus(id,s){ chgTaskStatus(id,s); }

function openTaskModal(id) {
  if (id  && !can('editTask')) { showToast('ليس لديك صلاحية تعديل المهام','error'); return; }
  if (!id && !can('addTask'))  { showToast('ليس لديك صلاحية إضافة مهام','error');   return; }
  const ti=document.getElementById('task-modal-title'); if(ti) ti.textContent=id?'تعديل المهمة':'إضافة مهمة جديدة';
  ['task-edit-id','task-name','task-resp','task-due','task-notes'].forEach(fid=>{const e=document.getElementById(fid);if(e)e.value='';});
  const pEl=document.getElementById('task-priority'); if(pEl) pEl.value='high';
  const sEl=document.getElementById('task-status');   if(sEl) sEl.value='pending';
  if (id) {
    const t=tasksCache.find(x=>x.id===id); if(!t)return;
    const sv=(fid,v)=>{const e=document.getElementById(fid);if(e)e.value=v??'';};
    sv('task-edit-id',t.id);sv('task-name',t.name);sv('task-resp',t.resp||'');sv('task-due',t.due||'');sv('task-priority',t.priority);sv('task-status',t.status);sv('task-notes',t.notes||'');
  }
  openModal('task-modal');
}

async function saveTask() {
  const editId=document.getElementById('task-edit-id')?.value;
  if (editId && !can('editTask')) { showToast('ليس لديك صلاحية تعديل المهام','error'); return; }
  if (!editId && !can('addTask')){ showToast('ليس لديك صلاحية إضافة مهام','error');   return; }
  const g=id=>(document.getElementById(id)?.value||'');
  const name=g('task-name').trim(); if(!name){showToast('يرجى إدخال اسم المهمة','error');return;}
  const t={id:editId||null,name,resp:g('task-resp').trim(),due:g('task-due'),priority:g('task-priority'),status:g('task-status'),notes:g('task-notes').trim()};
  const btn=document.getElementById('task-save-btn');
  if(btn){btn.disabled=true;btn.textContent='جارٍ الحفظ…';}
  try {
    let saved;
    if(editId){ saved=await sbUpdateTask(t); } else { saved=await sbInsertTask(t); tasksCache.push(saved); }
    closeModal('task-modal'); renderTasks();
    showToast(editId?'تم التعديل ✅':'تمت الإضافة ✅','success');
  } catch(err){ console.error('[saveTask]',err.message); showToast('خطأ: '+err.message,'error'); }
  finally{ if(btn){btn.disabled=false;btn.textContent='💾 حفظ المهمة';} }
}

async function deleteTask(id) {
  if(!can('deleteTask')){showToast('ليس لديك صلاحية حذف المهام','error');return;}
  if(!confirm('حذف هذه المهمة؟'))return;
  try{ await sbDeleteTask(id); renderTasks(); showToast('تم الحذف 🗑️','warning'); }
  catch(err){ console.error('[deleteTask]',err.message); showToast('خطأ: '+err.message,'error'); }
}

/* ─────────────────────────────────────────────────────────────
   §29  REPORTS SECTION
   ───────────────────────────────────────────────────────────── */
function openReportModal() {
  const sel=document.getElementById('rep-program-id');
  if(sel) sel.innerHTML='<option value="">— اختر البرنامج —</option>'+programsCache.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
  ['rep-edit-id','rep-title','rep-link','rep-notes'].forEach(f=>{const e=document.getElementById(f);if(e)e.value='';});
  // تعبئة اسم الرافعة تلقائياً بالمستخدم الحالي (المعلمة)
  const pe=document.getElementById('rep-person'); if(pe) pe.value=currentUser?.name||'';
  const rt=document.getElementById('rep-type'); if(rt) rt.value='صورة';
  openModal('report-modal');
}

function renderReports() {
  const TI={'صورة':'📷','PDF':'📄','Word':'📝','Excel':'📊','Google Drive':'☁️','YouTube':'🎥','رابط خارجي':'🔗'};
  const tbody=document.getElementById('reports-tbody'); if(!tbody)return;
  tbody.innerHTML=evidencesCache.length
    ? evidencesCache.map((r,i)=>{
        const pName=r.program_id?programsCache.find(p=>p.id===r.program_id)?.name||'—':'—';
        return`<tr><td>${i+1}</td><td style="font-weight:600">${r.title}</td>
          <td><span class="badge badge-info">${TI[r.type]||'📎'} ${r.type||'—'}</span></td>
          <td>${pName}</td><td>${r.person||'—'}</td><td>${fmtDate(r.date)}</td>
          <td>${r.link?`<a href="${r.link}" target="_blank" class="btn-sm btn-view">🔗 فتح</a>`:'—'}</td>
          <td>${can('deleteEvidence')?`<button class="btn-sm btn-delete" onclick="handleDelEv('${r.id}')">🗑️</button>`:''}</td></tr>`;
      }).join('')
    : '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">لا توجد شواهد</td></tr>';
}

async function saveReport() {
  const g=id=>(document.getElementById(id)?.value||'');
  const title=g('rep-title').trim(); if(!title){showToast('يرجى إدخال عنوان الشاهد','error');return;}
  const progId=g('rep-program-id');
  const person = g('rep-person').trim() || currentUser?.name || '';
  const ev={id:null,title,type:g('rep-type'),program_id:progId||null,initiative_label:'',person,date:new Date().toISOString().split('T')[0],link:g('rep-link').trim(),notes:g('rep-notes').trim(),file_data:null};
  const btn=document.getElementById('rep-save-btn');
  if(btn){btn.disabled=true;btn.textContent='جارٍ الرفع…';}
  try{
    const saved=await sbInsertEvidence(ev); evidencesCache.unshift(saved);
    syncEvidencesToPrograms();
    if (saved.program_id) await syncProgress(saved.program_id);
    closeModal('report-modal'); renderReports(); renderPrograms();
    showToast('تم رفع الشاهد ✅','success');
  }catch(err){console.error('[saveReport]',err.message);showToast('خطأ: '+err.message,'error');}
  finally{if(btn){btn.disabled=false;btn.textContent='📤 رفع الشاهد';}}
}

/* ─────────────────────────────────────────────────────────────
   §30  TEACHERS SECTION
   ───────────────────────────────────────────────────────────── */
function renderTeachers() {
  const sec = document.getElementById('section-teachers'); if (!sec) return;

  // ── واجهة المعلمة: إضافة رابط Google Drive فقط (بدون عرض/تعديل/حذف) ──
  if (currentUser?.role === 'teacher') {
    sec.innerHTML = `
      <div class="section-top"><h2>متابعة المعلمات — إضافة رابط Drive</h2></div>
      <div class="card" style="max-width:620px">
        <div class="card-header"><h3>📎 إرسال رابط Google Drive للقائدة</h3></div>
        <div style="padding:20px">
          <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px">
            أرسلي رابط مجلد أو ملف Google Drive الخاص بأعمالك. سيظهر للقائدة والوكيلة فقط،
            ولا يمكنك عرض أو تعديل الروابط بعد إرسالها.
          </p>
          <div class="form-group">
            <label>اسمك</label>
            <input type="text" id="tlink-name" value="${currentUser?.name||''}" readonly style="background:#f8f9fa"/>
          </div>
          <div class="form-group">
            <label>عنوان مختصر <span class="req">*</span></label>
            <input type="text" id="tlink-title" placeholder="مثال: شواهد برنامج القراءة"/>
          </div>
          <div class="form-group">
            <label>رابط Google Drive <span class="req">*</span></label>
            <input type="url" id="tlink-url" placeholder="https://drive.google.com/..."/>
          </div>
          <button class="btn-primary" id="tlink-btn" onclick="submitTeacherLink()" style="width:100%">📤 إرسال الرابط</button>
        </div>
      </div>`;
    return;
  }

  // ── واجهة المدير/الوكيل: جدول كامل + إدارة الروابط ──
  const visible = teachersCache.filter(t => t.name && !t.name.toLowerCase().includes('admin'));
  sec.innerHTML = `
    <div class="section-top">
      <h2>متابعة المعلمات</h2>
      ${can('addTeacher')?`<button class="btn-primary" id="btn-add-teacher" onclick="openTeacherModal()">+ إضافة سجل متابعة</button>`:''}
    </div>
    <div class="table-wrapper">
      <table class="data-table">
        <thead><tr>
          <th>اسم المعلمة</th><th>المهام المسندة</th><th>المهام المنجزة</th>
          <th>نسبة الإنجاز</th><th>رابط Drive</th><th>آخر تقرير</th><th>الملاحظات</th><th>إجراءات</th>
        </tr></thead>
        <tbody id="teachers-tbody"></tbody>
      </table>
    </div>`;

  const tbody = document.getElementById('teachers-tbody'); if (!tbody) return;
  tbody.innerHTML = visible.length ? visible.map(t => {
    const pct = t.assigned>0 ? Math.round((t.done/t.assigned)*100) : 0;
    const linkCell = t.driveLink
      ? `<a href="${t.driveLink}" target="_blank" class="btn-sm btn-view">🔗 فتح</a>${t.createdBy?`<div style="font-size:10px;color:var(--text-muted);margin-top:3px">${t.createdBy}</div>`:''}`
      : '<span style="color:#ccc">—</span>';
    return `<tr><td style="font-weight:700">${t.name}</td>
      <td style="text-align:center">${t.assigned}</td>
      <td style="text-align:center">${t.done}</td>
      <td><div class="progress-wrap"><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div><span class="progress-text">${pct}%</span></div></td>
      <td>${linkCell}</td>
      <td>${fmtDate(t.lastReport)}</td>
      <td style="font-size:13px">${t.notes||'<span style="color:#ccc">—</span>'}</td>
      <td><div style="display:flex;gap:4px">
        ${can('editTeacher')?`<button class="btn-sm btn-edit" onclick="openTeacherModal('${t.id}')">✏️</button>`:''}
        ${can('deleteTeacher')?`<button class="btn-sm btn-delete" onclick="deleteTeacher('${t.id}')">🗑️</button>`:''}
      </div></td></tr>`;
  }).join('') : '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">لا توجد سجلات متابعة</td></tr>';
}

// إرسال رابط Drive من حساب المعلمة (إضافة فقط)
async function submitTeacherLink() {
  if (!can('addTeacherLink')) { showToast('غير مسموح','error'); return; }
  const g = id => (document.getElementById(id)?.value||'').trim();
  const title = g('tlink-title'); const url = g('tlink-url');
  if (!title) { showToast('يرجى إدخال عنوان مختصر','error'); return; }
  if (!url)   { showToast('يرجى إدخال رابط Drive','error'); return; }
  const btn = document.getElementById('tlink-btn');
  if (btn) { btn.disabled=true; btn.textContent='جارٍ الإرسال…'; }
  try {
    const tf = {
      id:null, name:currentUser.name, assigned:0, done:0, lastReport:'',
      notes:title, driveLink:url, createdBy:currentUser.name,
    };
    const saved = await sbInsertTeacher(tf);
    teachersCache.push(saved);
    const ti=document.getElementById('tlink-title'); if(ti) ti.value='';
    const ur=document.getElementById('tlink-url');   if(ur) ur.value='';
    showToast('تم إرسال الرابط للقائدة ✅','success');
  } catch (err) { console.error('[submitTeacherLink]',err.message); showToast('خطأ: '+err.message,'error'); }
  finally { if (btn) { btn.disabled=false; btn.textContent='📤 إرسال الرابط'; } }
}

function openTeacherModal(id) {
  if(id  && !can('editTeacher')){showToast('ليس لديك صلاحية التعديل','error');return;}
  if(!id && !can('addTeacher')) {showToast('ليس لديك صلاحية الإضافة','error');return;}
  const ti=document.getElementById('teacher-modal-title'); if(ti) ti.textContent=id?'تعديل سجل المتابعة':'إضافة سجل متابعة معلمة';
  ['tf-edit-id','tf-name','tf-assigned','tf-done','tf-last-report','tf-notes','tf-link'].forEach(fid=>{const e=document.getElementById(fid);if(e)e.value='';});
  if(id){
    const tf=teachersCache.find(x=>x.id===id); if(!tf)return;
    const sv=(fid,v)=>{const e=document.getElementById(fid);if(e)e.value=v??'';};
    sv('tf-edit-id',tf.id);sv('tf-name',tf.name);sv('tf-assigned',tf.assigned||0);
    sv('tf-done',tf.done||0);sv('tf-last-report',tf.lastReport||'');sv('tf-notes',tf.notes||'');
    sv('tf-link',tf.driveLink||'');
  }
  openModal('teacher-modal');
}

async function saveTeacher() {
  const editId=document.getElementById('tf-edit-id')?.value;
  const g=id=>(document.getElementById(id)?.value||'');
  const name=g('tf-name').trim(); if(!name){showToast('يرجى إدخال اسم المعلمة','error');return;}
  const existing = editId ? teachersCache.find(x=>x.id===editId) : null;
  const tf={
    id:editId||null, name,
    assigned:parseInt(g('tf-assigned'))||0, done:parseInt(g('tf-done'))||0,
    lastReport:g('tf-last-report'), notes:g('tf-notes').trim(),
    driveLink:g('tf-link').trim(), createdBy:existing?.createdBy||currentUser?.name||'',
  };
  const btn=document.getElementById('tf-save-btn');
  if(btn){btn.disabled=true;btn.textContent='جارٍ الحفظ…';}
  try{
    let saved;
    if(editId){ saved=await sbUpdateTeacher(tf); const i=teachersCache.findIndex(x=>x.id===saved.id); if(i!==-1)teachersCache[i]=saved; }
    else{ saved=await sbInsertTeacher(tf); teachersCache.push(saved); }
    closeModal('teacher-modal'); renderTeachers();
    showToast(editId?'تم التعديل ✅':'تمت الإضافة ✅','success');
  }catch(err){console.error('[saveTeacher]',err.message);showToast('خطأ: '+err.message,'error');}
  finally{if(btn){btn.disabled=false;btn.textContent='💾 حفظ';}}
}

async function deleteTeacher(id) {
  if(!can('deleteTeacher')){showToast('ليس لديك صلاحية حذف سجلات المتابعة','error');return;}
  if(!confirm('حذف سجل المتابعة؟ (لن يُحذف حساب المعلمة)'))return;
  try{
    await sbDeleteTeacher(id);
    renderTeachers();
    showToast('تم حذف سجل المتابعة 🗑️','warning');
  }catch(err){console.error('[deleteTeacher]',err.message);showToast('خطأ: '+err.message,'error');}
}

// Legacy aliases
function openTeacherNote(id){ openTeacherModal(id); }
function saveTeacherNote(){ saveTeacher(); }

/* ─────────────────────────────────────────────────────────────
   §31  DASHBOARD
   ───────────────────────────────────────────────────────────── */
function renderDashboard() {
  // §11: إخفاء admin من الإحصائيات
  const visTeachers = teachersCache.filter(t => t.name && !t.name.toLowerCase().includes('admin'));
  const total  = programsCache.length;
  const done   = programsCache.filter(p => calcProgramStatus(p)==='done').length;
  const avg    = total ? Math.round(programsCache.reduce((s,p)=>s+(p.progress||0),0)/total) : 0;
  const lateT  = tasksCache.filter(t=>t.status!=='done'&&t.due&&new Date(t.due)<new Date()).length;
  const totalEv= evidencesCache.length;

  const dsEl = document.getElementById('dashboard-stats'); if (!dsEl) return;
  dsEl.innerHTML = `
    <div class="stat-card"><span class="stat-icon">🗂️</span><span class="stat-number">${total}</span><span class="stat-label">إجمالي البرامج</span></div>
    <div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${done}</span><span class="stat-label">برامج منتهية</span></div>
    <div class="stat-card gold"><span class="stat-icon">📊</span><span class="stat-number">${avg}%</span><span class="stat-label">متوسط الإنجاز</span></div>
    <div class="stat-card red"><span class="stat-icon">⏰</span><span class="stat-number">${lateT}</span><span class="stat-label">مهام متأخرة</span></div>
    <div class="stat-card purple"><span class="stat-icon">📎</span><span class="stat-number">${totalEv}</span><span class="stat-label">شواهد مرفوعة</span></div>
    <div class="stat-card teal"><span class="stat-icon">👩‍🏫</span><span class="stat-number">${visTeachers.length}</span><span class="stat-label">معلمات تحت المتابعة</span></div>`;

  const settings = lsLoad('settings', DEFAULT_SETTINGS);
  const gEl = document.getElementById('dash-greeting');
  if (gEl) gEl.textContent = `${settings.schoolName||'منصة الخطة التشغيلية'}`;
  const subEl = document.getElementById('dash-subtitle');
  if (subEl) subEl.textContent = `القائدة: ${settings.principal||'—'} · العام الدراسي ${settings.year||''}`;

  const upcoming = tasksCache.filter(t=>t.status!=='done').sort((a,b)=>new Date(a.due)-new Date(b.due)).slice(0,5);
  const upEl = document.getElementById('upcoming-tasks-list');
  if (upEl) upEl.innerHTML = upcoming.length
    ? '<div class="upcoming-list">'+upcoming.map(t=>{
        const late=t.due&&new Date(t.due)<new Date();
        return`<div class="upcoming-item"><div class="upcoming-dot ${t.priority}"></div><div class="upcoming-info"><div class="upcoming-name">${t.name}</div><div class="upcoming-due">${late?'⚠️ متأخرة — ':''}${fmtDate(t.due)} · ${t.resp||'—'}</div></div></div>`;
      }).join('')+'</div>'
    : '<p style="padding:16px;color:var(--text-muted);text-align:center">لا توجد مهام قادمة</p>';

  const ipEl = document.getElementById('initiatives-progress');
  if (ipEl) ipEl.innerHTML = '<div class="initiatives-progress-list">'+programsCache.map(p=>`
    <div class="ini-progress-item">
      <span class="ini-progress-name">${p.name}</span>
      <div class="ini-progress-bar"><div class="progress-bar"><div class="progress-fill" style="width:${p.progress||0}%"></div></div></div>
      <span class="progress-text">${p.progress||0}%</span>
    </div>`).join('')+'</div>';

  setTimeout(() => drawDashPie(), 60);
}

function drawDashPie() {
  const c=document.getElementById('initiatives-chart'); if(!c)return;
  const ctx=c.getContext('2d'),W=c.width,H=c.height; ctx.clearRect(0,0,W,H);
  const cnt={'منتهٍ':0,'جارٍ التنفيذ':0,'قيد التخطيط':0,'متأخر':0};
  programsCache.forEach(p=>{const s=calcProgramStatus(p);if(s==='done')cnt['منتهٍ']++;else if(s==='active')cnt['جارٍ التنفيذ']++;else if(s==='planning')cnt['قيد التخطيط']++;else cnt['متأخر']++;});
  const colors=['#27ae60','#2e86c1','#95a5a6','#e74c3c'],labels=Object.keys(cnt),values=Object.values(cnt),total=values.reduce((a,b)=>a+b,0);
  if(!total)return;
  const cx=W/2,cy=H/2-15,r=Math.min(W,H)/2-30;let sa=-Math.PI/2;
  values.forEach((v,i)=>{if(!v)return;const sl=(v/total)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,sa,sa+sl);ctx.closePath();ctx.fillStyle=colors[i];ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=2;ctx.stroke();const mid=sa+sl/2;ctx.fillStyle='white';ctx.font='bold 12px Tajawal';ctx.textAlign='center';ctx.fillText(v,cx+(r*.65)*Math.cos(mid),cy+(r*.65)*Math.sin(mid)+5);sa+=sl;});
  let li=0;labels.forEach((l,i)=>{if(!values[i])return;const x=10+(li%2)*(W/2),y=H-48+Math.floor(li/2)*20;ctx.fillStyle=colors[i];ctx.fillRect(x,y,12,12);ctx.fillStyle='#333';ctx.font='11px Tajawal';ctx.textAlign='right';ctx.fillText(l+' ('+values[i]+')',x+W/2-18,y+10);li++;});
}

/* ─────────────────────────────────────────────────────────────
   §32  CALENDAR
   ───────────────────────────────────────────────────────────── */
function prevMonth(){ calendarMonth--; if(calendarMonth<0){calendarMonth=11;calendarYear--;} renderCalendar(); }
function nextMonth(){ calendarMonth++; if(calendarMonth>11){calendarMonth=0;calendarYear++;} renderCalendar(); }

function renderCalendar() {
  const MN=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const lbl=document.getElementById('calendar-month-label'); if(lbl) lbl.textContent=MN[calendarMonth]+' '+calendarYear;
  const today=new Date(),fd=new Date(calendarYear,calendarMonth,1).getDay(),dm=new Date(calendarYear,calendarMonth+1,0).getDate();
  const ev={};
  tasksCache.forEach(t=>{if(!t.due)return;const d=new Date(t.due);if(d.getFullYear()===calendarYear&&d.getMonth()===calendarMonth){const day=d.getDate();if(!ev[day])ev[day]=[];ev[day].push({text:t.name,cls:t.status!=='done'&&d<today?'late-event':'task-event'});}});
  programsCache.forEach(p=>{if(p.end){const d=new Date(p.end);if(d.getFullYear()===calendarYear&&d.getMonth()===calendarMonth){const day=d.getDate();if(!ev[day])ev[day]=[];ev[day].push({text:'📋 '+p.name,cls:'ini-event'});}}});
  const DN=['أحد','اثنين','ثلاثاء','أربعاء','خميس','جمعة','سبت'];
  let html='<div class="calendar-grid"><div class="calendar-header-row">'+DN.map(d=>`<div class="calendar-day-name">${d}</div>`).join('')+'</div><div class="calendar-body">';
  let col=0; for(let i=0;i<fd;i++){html+='<div class="calendar-cell empty"></div>';col++;}
  for(let day=1;day<=dm;day++){const isT=today.getFullYear()===calendarYear&&today.getMonth()===calendarMonth&&today.getDate()===day;const de=ev[day]||[];html+=`<div class="calendar-cell${isT?' today':''}"><div class="calendar-date${isT?' today-num':''}">${day}</div>${de.slice(0,3).map(e=>`<div class="calendar-event ${e.cls}" title="${e.text}">${e.text}</div>`).join('')}${de.length>3?`<div style="font-size:9px;color:var(--text-muted)">+${de.length-3}</div>`:''}</div>`;col++;}
  const rem=(7-(col%7))%7; for(let i=0;i<rem;i++) html+='<div class="calendar-cell empty"></div>';
  html+='</div></div>';
  const ce=document.getElementById('calendar-container'); if(ce) ce.innerHTML=html;
}

/* ─────────────────────────────────────────────────────────────
   §33  STATS
   ───────────────────────────────────────────────────────────── */
function renderStats() {
  const avg=programsCache.length?Math.round(programsCache.reduce((s,p)=>s+(p.progress||0),0)/programsCache.length):0;
  const dt=tasksCache.filter(t=>t.status==='done').length;
  const lt=tasksCache.filter(t=>t.status!=='done'&&t.due&&new Date(t.due)<new Date()).length;
  const top=[...programsCache].sort((a,b)=>(b.progress||0)-(a.progress||0)).slice(0,3);
  const sc=document.getElementById('stats-cards'); if(sc) sc.innerHTML=`
    <div class="stat-card"><span class="stat-icon">📊</span><span class="stat-number">${avg}%</span><span class="stat-label">متوسط إنجاز البرامج</span></div>
    <div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${dt}</span><span class="stat-label">مهام منجزة</span></div>
    <div class="stat-card red"><span class="stat-icon">⚠️</span><span class="stat-number">${lt}</span><span class="stat-label">مهام متأخرة</span></div>
    <div class="stat-card purple"><span class="stat-icon">📎</span><span class="stat-number">${evidencesCache.length}</span><span class="stat-label">شواهد مرفوعة</span></div>
    <div class="stat-card gold"><span class="stat-icon">🎯</span><span class="stat-number">${kpiCache.length}</span><span class="stat-label">مؤشرات الأداء</span></div>
    <div class="stat-card teal"><span class="stat-icon">📋</span><span class="stat-number">${programsCache.filter(p=>calcProgramStatus(p)==='done').length}</span><span class="stat-label">برامج منتهية</span></div>`;
  const te=document.getElementById('top-initiatives');
  if(te) te.innerHTML=top.map((p,i)=>`<div class="top-initiative-item"><span>${['🥇','🥈','🥉'][i]} ${p.name}</span><span style="font-weight:700;color:var(--primary)">${p.progress}%</span></div>`).join('');
  setTimeout(()=>{drawStatsPie();drawCompare();},60);
}

function drawStatsPie() {
  const c=document.getElementById('tasks-pie-chart'); if(!c)return;
  const ctx=c.getContext('2d'),W=c.width,H=c.height; ctx.clearRect(0,0,W,H);
  const cnt={'منجزة':tasksCache.filter(t=>t.status==='done').length,'قيد التنفيذ':tasksCache.filter(t=>t.status==='inprogress').length,'معلقة':tasksCache.filter(t=>t.status==='pending').length,'متأخرة':tasksCache.filter(t=>t.status!=='done'&&t.due&&new Date(t.due)<new Date()).length};
  const colors=['#27ae60','#2e86c1','#f39c12','#e74c3c'],L=Object.keys(cnt),V=Object.values(cnt),T=V.reduce((a,b)=>a+b,0);
  if(!T)return; const cx=W/2,cy=H/2-20,r=Math.min(W,H)/2-40;let sa=-Math.PI/2;
  V.forEach((v,i)=>{if(!v)return;const sl=(v/T)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,sa,sa+sl);ctx.closePath();ctx.fillStyle=colors[i];ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=2;ctx.stroke();const mid=sa+sl/2;ctx.fillStyle='white';ctx.font='bold 12px Tajawal';ctx.textAlign='center';ctx.fillText(v,cx+(r*.65)*Math.cos(mid),cy+(r*.65)*Math.sin(mid)+5);sa+=sl;});
  const ly=H-28;L.forEach((l,i)=>{const x=(i%2)*(W/2)+10,y=ly-Math.floor(1-i/2)*18;ctx.fillStyle=colors[i];ctx.fillRect(x,y,11,11);ctx.fillStyle='#444';ctx.font='11px Tajawal';ctx.textAlign='right';ctx.fillText(l+' ('+V[i]+')',x+W/2-14,y+9);});
}

function drawCompare() {
  const c=document.getElementById('compare-chart'); if(!c||!programsCache.length)return;
  const W=c.parentElement?.offsetWidth||700; c.width=W; c.height=280;
  const ctx=c.getContext('2d'); ctx.clearRect(0,0,W,280);
  const pL=20,pR=20,pT=20,pB=70,cW=W-pL-pR,cH=280-pT-pB,n=Math.max(programsCache.length,1),gap=cW/n,bW=Math.min(32,gap/3);
  for(let i=0;i<=5;i++){const y=pT+cH-(cH*i/5);ctx.strokeStyle='#eaecee';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pL,y);ctx.lineTo(W-pR,y);ctx.stroke();ctx.fillStyle='#aaa';ctx.font='11px Tajawal';ctx.textAlign='left';ctx.fillText((i*20)+'%',pL,y-2);}
  programsCache.forEach((p,i)=>{const pct=p.progress||0,x=pL+i*gap+gap/2,bH=(pct/100)*cH;ctx.fillStyle='#dce8f5';ctx.fillRect(x-bW*1.1,pT,bW*2.2,cH);const clr=pct>=90?'#27ae60':pct>=60?'#2e86c1':pct>=30?'#f39c12':'#e74c3c';ctx.fillStyle=clr;ctx.fillRect(x-bW/2,pT+cH-bH,bW,bH);ctx.fillStyle='#333';ctx.font='bold 11px Tajawal';ctx.textAlign='center';ctx.fillText(pct+'%',x,pT+cH-bH-5);ctx.fillStyle='#666';ctx.font='11px Tajawal';ctx.fillText(p.name.length>7?p.name.slice(0,7)+'..':p.name,x,280-pB+16);});
}

/* ─────────────────────────────────────────────────────────────
   §34  USERS MANAGEMENT (admin only)
   ───────────────────────────────────────────────────────────── */
async function renderUsersSection() {
  if (!can('manageUsers')) return;
  const sec = document.getElementById('section-users'); if (!sec) return;
  let users = [];
  if (sb) {
    const {data,error} = await sb.from('users').select('id,name,email,role,created_at').order('created_at');
    if (error) { console.error('[fetchUsers]',error.message); }
    else users = data||[];
  } else { users = FALLBACK_USERS; }
  const RL={admin:'مدير',vice:'وكيل',teacher:'معلم'};
  const RB={admin:'badge-danger',vice:'badge-info',teacher:'badge-success'};
  sec.innerHTML = `
    <div class="section-top">
      <h2>إدارة المستخدمين</h2>
      <button class="btn-primary" onclick="openAddUserModal()">+ إضافة مستخدم</button>
    </div>
    <div class="table-wrapper"><table class="data-table">
      <thead><tr><th>#</th><th>الاسم</th><th>البريد الإلكتروني</th><th>الدور</th><th>تاريخ الإضافة</th><th>إجراءات</th></tr></thead>
      <tbody>
        ${users.map((u,i)=>`<tr><td>${i+1}</td><td style="font-weight:700">${u.name}</td>
          <td style="direction:ltr;text-align:right">${u.email}</td>
          <td><span class="badge ${RB[u.role]||'badge-secondary'}">${RL[u.role]||u.role}</span></td>
          <td>${fmtDate(u.created_at)}</td>
          <td><div style="display:flex;gap:6px;align-items:center">
            <select class="task-status-select" onchange="handleChgRole('${u.id}',this.value)">
              <option value="admin" ${u.role==='admin'?'selected':''}>مدير</option>
              <option value="vice" ${u.role==='vice'?'selected':''}>وكيل</option>
              <option value="teacher" ${u.role==='teacher'?'selected':''}>معلم</option>
            </select>
            ${u.id!==currentUser?.id
              ?`<button class="btn-sm btn-delete" onclick="handleDelUser('${u.id}','${u.name}')">🗑️</button>`
              :'<span style="font-size:12px;color:var(--text-muted)">أنت</span>'}
          </div></td></tr>`).join('')}
      </tbody>
    </table></div>
    <div id="add-user-modal" class="modal-overlay hidden"><div class="modal">
      <div class="modal-header"><h3>إضافة مستخدم جديد</h3><button onclick="closeModal('add-user-modal')" class="modal-close">✕</button></div>
      <div class="modal-body">
        <div class="form-group"><label>الاسم الكامل</label><input type="text" id="nu-name" placeholder="الاسم الكامل"/></div>
        <div class="form-group"><label>البريد الإلكتروني</label><input type="email" id="nu-email" placeholder="email@school.sa"/></div>
        <div class="form-group"><label>كلمة المرور</label><input type="password" id="nu-pass" placeholder="كلمة المرور"/></div>
        <div class="form-group"><label>الدور</label>
          <select id="nu-role"><option value="teacher">معلم</option><option value="vice">وكيل</option><option value="admin">مدير</option></select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-primary" onclick="handleAddUser()">💾 إضافة</button>
        <button class="btn-secondary" onclick="closeModal('add-user-modal')">إلغاء</button>
      </div>
    </div></div>`;
}

function openAddUserModal() { openModal('add-user-modal'); }

async function handleAddUser() {
  if (!sb) { showToast('Supabase غير متصل','error'); return; }
  const g = id => (document.getElementById(id)?.value||'').trim();
  const name=g('nu-name'), email=g('nu-email'), pass=g('nu-pass'), role=g('nu-role');
  if (!name||!email||!pass) { showToast('يرجى تعبئة جميع الحقول','error'); return; }
  try {
    const {error}=await sb.from('users').insert({name,email:email.toLowerCase(),password:pass,role});
    if(error) throw error;
    closeModal('add-user-modal');
    showToast('تمت إضافة المستخدم ✅','success');
    await renderUsersSection();
  } catch(err){ console.error('[handleAddUser]',err.message); showToast('خطأ: '+err.message,'error'); }
}

async function handleDelUser(id, name) {
  if (!confirm(`حذف المستخدم "${name}"؟`)) return;
  if (!sb) { showToast('Supabase غير متصل','error'); return; }
  try {
    const {error}=await sb.from('users').delete().eq('id',id);
    if(error) throw error;
    showToast('تم الحذف 🗑️','warning');
    await renderUsersSection();
  } catch(err){ console.error('[handleDelUser]',err.message); showToast('خطأ: '+err.message,'error'); }
}

async function handleChgRole(id, role) {
  if (!sb) { showToast('Supabase غير متصل','error'); return; }
  try {
    const {error}=await sb.from('users').update({role}).eq('id',id);
    if(error) throw error;
    showToast('تم تعديل الدور ✅','success');
  } catch(err){ console.error('[handleChgRole]',err.message); showToast('خطأ: '+err.message,'error'); }
}

/* ─────────────────────────────────────────────────────────────
   §35  ENTRY POINT
   ───────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  calendarMonth = new Date().getMonth();
  calendarYear  = new Date().getFullYear();
  // البيانات تُحمَّل بعد doLogin()
});
window.doLogin = doLogin; 
window.openAddUserModal = openAddUserModal;
window.handleAddUser = handleAddUser;
window.handleDelUser = handleDelUser;
window.handleChgRole = handleChgRole;
