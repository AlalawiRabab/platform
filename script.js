/* ================================================================
   SCHOOL OPERATIONAL PLAN — script.js  v6.0
   ================================================================
   جميع الجداول التشغيلية مرتبطة بـ Supabase فقط (مصدر الحقيقة).
   localStorage: جلسة supabase-js + KPI مؤقت + تنظيف مفاتيح قديمة — بلا fallback تشغيلي.
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

   -- ⑨ RLS — مهم: لا تستخدم allow_all في الإنتاج
   -- لا تنفّذ supabase-security.sql (نُقل إلى sql/legacy-disabled/*.sql.disabled).
   -- للمراجعة المعتمدة: phase_auth_foundation_review.sql ثم
   -- phase_rls_cutover_review.sql ثم phase_storage_private_review.sql.
   -- السياسة التالية للتجربة فقط (تسمح للجميع بكل شيء) — لا تستخدمها:
   -- DO $$ DECLARE t text;
   -- BEGIN
   --   FOREACH t IN ARRAY ARRAY['users','programs','program_indicators',
   --     'initiatives','tasks','evidences','teacher_followups','settings']
   --   LOOP
   --     EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
   --     EXECUTE format('DROP POLICY IF EXISTS allow_all ON %I', t);
   --     EXECUTE format('CREATE POLICY allow_all ON %I FOR ALL USING (true) WITH CHECK (true)', t);
   --   END LOOP;
   -- END $$;

   -- ⑩ إنشاء المستخدمين يتم عبر Supabase Auth فقط.
   -- لا تُدرج كلمات مرور داخل هذا الملف أو أي seed في المستودع.

   ================================================================ */

'use strict';

console.log('[script.js] BUILD=20260809-hijri2');

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
let activeSchoolYearId = null;
let schoolYearsCache = [];
let selectedSchoolYearId = null;
let calendarMode     = 'hijri'; // hijri | gregorian
let calendarMonth    = new Date().getMonth();
let calendarYear     = new Date().getFullYear();
let calendarHijriMonth = 1;
let calendarHijriYear  = 1447;
let pendingFileData  = null;
let pendingImageData = null;
let pendingEvidenceFile = null;
let _planFilter      = 'all';
let _planSearch      = '';
let _taskFilter      = 'all';
let _taskPriFilter   = 'all';
let _openProgramDetailId = null;

/* ─────────────────────────────────────────────────────────────
   §2  PERMISSIONS
   ───────────────────────────────────────────────────────────── */
const PERMS = {
  admin:{
    addProgram:true,editProgram:true,deleteProgram:true,
    addIndicator:true,deleteIndicator:true,toggleIndicator:true,
    addEvidence:true,editEvidence:true,deleteEvidence:true,
    addInitiative:true,editInitiative:true,deleteInitiative:true,
    addTask:true,editTask:true,deleteTask:true,
    addTeacher:true,editTeacher:true,deleteTeacher:true,
    viewTeacherLinks:true,addTeacherLink:true,
    editSettings:true,manageUsers:true,
  },
  // صلاحيات الوكيلة المعتمدة سابقاً في المشروع (بدون إدارة مستخدمين/حذف)
  vice:{
    addProgram:true,editProgram:true,deleteProgram:false,
    addIndicator:true,deleteIndicator:false,toggleIndicator:true,
    addEvidence:true,editEvidence:true,deleteEvidence:false,
    addInitiative:true,editInitiative:true,deleteInitiative:false,
    addTask:true,editTask:true,deleteTask:false,
    addTeacher:true,editTeacher:true,deleteTeacher:true,
    viewTeacherLinks:true,addTeacherLink:true,
    editSettings:false,manageUsers:false,
  },
  // المعلمة: مشاهدة + إرفاق شاهد فقط
  teacher:{
    addProgram:false,editProgram:false,deleteProgram:false,
    addIndicator:false,deleteIndicator:false,toggleIndicator:false,
    addEvidence:true,editEvidence:false,deleteEvidence:false,
    addInitiative:false,editInitiative:false,deleteInitiative:false,
    addTask:false,editTask:false,deleteTask:false,
    addTeacher:false,editTeacher:false,deleteTeacher:false,
    viewTeacherLinks:false,addTeacherLink:false,
    editSettings:false,manageUsers:false,
  },
};
const can = a => currentUser ? (PERMS[currentUser.role]?.[a] === true) : false;

const NAV_ALLOWED = {
  admin  : ['dashboard','programs','plan','kpi','tasks','reports','teachers','calendar','stats','settings','users'],
  vice   : ['dashboard','programs','plan','kpi','tasks','reports','teachers','calendar','stats'],
  teacher: ['dashboard','programs','reports'],
};

const ALLOWED_EVIDENCE_EXT = ['pdf','jpg','jpeg','png','doc','docx','xls','xlsx'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_INPUT_LEN = 500;
const VALID_ROLES = ['admin','vice','teacher'];
const EVIDENCE_BUCKET = 'evidences';
const SIGNED_URL_TTL_SEC = 3600;
const ALLOWED_EVIDENCE_MIME = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];
let _authListenerBound = false;
let _authHandling = false;
let _sessionBootstrapDone = false;
let _passwordRecoveryActive = false;

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const esc = escapeHtml;

function sanitizeUrl(url) {
  if (!url) return '';
  const raw = String(url).trim();
  if (/^(javascript|data|vbscript|file):/i.test(raw)) return '';
  try {
    const parsed = new URL(raw.startsWith('http') ? raw : 'https://' + raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.href;
  } catch { return ''; }
}

function safeLinkHtml(url, label, className) {
  const safe = sanitizeUrl(url);
  if (!safe) return '—';
  const cls = className ? ` class="${esc(className)}"` : '';
  return `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer"${cls}>${esc(label || 'فتح الرابط')}</a>`;
}

function validateFileExtension(name, allowed) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  return allowed.includes(ext);
}

function clampInput(str, max = MAX_INPUT_LEN) {
  return String(str || '').trim().slice(0, max);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidLoginId(id) {
  const v = String(id || '').trim();
  if (!v) return false;
  if (v.includes('@')) return isValidEmail(v);
  return /^[a-zA-Z0-9._-]{3,64}$/.test(v);
}

function isSectionAllowed(section) {
  if (!currentUser) return false;
  return (NAV_ALLOWED[currentUser.role] || []).includes(section);
}

function clearLegacySessionArtifacts() {
  try { sessionStorage.removeItem('sop_session'); } catch {}
  try { localStorage.removeItem('currentUser'); } catch {}
  try { sessionStorage.removeItem('currentUser'); } catch {}
}

function showAppShell() {
  document.getElementById('login-page')?.classList.add('hidden');
  document.getElementById('app')?.classList.remove('hidden');
}

function showLoginShell() {
  document.getElementById('app')?.classList.add('hidden');
  document.getElementById('login-page')?.classList.remove('hidden');
}

function clearLoginPasswordField() {
  const p = document.getElementById('login-password');
  if (p) p.value = '';
}

async function fetchProfileForAuthUser(authUser) {
  if (!sb || !authUser?.id) return null;
  const { data, error } = await sb
    .from('profiles')
    .select('id,name,username,role')
    .eq('id', authUser.id)
    .maybeSingle();
  if (error || !data || !VALID_ROLES.includes(data.role)) return null;
  return {
    id: data.id,
    name: data.name || data.username || 'مستخدم',
    username: data.username || null,
    email: authUser.email || '',
    role: data.role,
  };
}

async function denyAccessAndSignOut(message) {
  currentUser = null;
  _sessionBootstrapDone = false;
  _passwordRecoveryActive = false;
  clearLegacySessionArtifacts();
  try { if (sb) await sb.auth.signOut(); } catch {}
  showLoginShell();
  if (message) showToast(message, 'error');
}

function clearPasswordRecoveryFields() {
  const a = document.getElementById('pr-pass');
  const b = document.getElementById('pr-pass2');
  if (a) a.value = '';
  if (b) b.value = '';
}

function openPasswordRecoveryModal() {
  clearPasswordRecoveryFields();
  showLoginShell();
  openModal('password-recovery-modal');
}

function closePasswordRecoveryModal() {
  clearPasswordRecoveryFields();
  closeModal('password-recovery-modal');
}

/** رسائل خطأ من hash/query بعد فتح رابط الاستعادة */
function consumeAuthRedirectError() {
  try {
    const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
    const queryParams = new URLSearchParams(window.location.search || '');
    const err = hashParams.get('error') || queryParams.get('error');
    const descRaw = hashParams.get('error_description') || queryParams.get('error_description') || '';
    if (!err) return null;
    try {
      const path = window.location.pathname || '/index.html';
      window.history.replaceState({}, document.title, path);
    } catch {}
    const desc = decodeURIComponent(String(descRaw).replace(/\+/g, ' '));
    if (/expired|otp|invalid|token/i.test(desc) || err === 'access_denied') {
      return 'رابط استعادة كلمة المرور غير صالح أو منتهٍ. اطلب رابطاً جديداً من المسؤول.';
    }
    return 'تعذّر إكمال استعادة كلمة المرور. اطلب رابطاً جديداً من المسؤول.';
  } catch {
    return null;
  }
}

function isRecoveryRedirectInUrl() {
  try {
    const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
    const queryParams = new URLSearchParams(window.location.search || '');
    return hashParams.get('type') === 'recovery' || queryParams.get('type') === 'recovery';
  } catch {
    return false;
  }
}

function scrubAuthHashFromUrl() {
  try {
    if (!window.location.hash) return;
    const path = window.location.pathname || '/index.html';
    const search = window.location.search || '';
    window.history.replaceState({}, document.title, path + search);
  } catch {}
}

async function beginPasswordRecoveryFlow() {
  _passwordRecoveryActive = true;
  currentUser = null;
  _sessionBootstrapDone = false;
  clearLegacySessionArtifacts();
  showLoginShell();
  scrubAuthHashFromUrl();
  openPasswordRecoveryModal();
}

async function submitPasswordRecovery() {
  if (!_passwordRecoveryActive) {
    showToast('جلسة استعادة كلمة المرور غير صالحة أو منتهية. اطلب رابطاً جديداً.', 'error');
    closePasswordRecoveryModal();
    showLoginShell();
    return;
  }
  if (!sb) {
    showToast('تعذّر الاتصال بخدمة المصادقة', 'error');
    return;
  }

  const passEl = document.getElementById('pr-pass');
  const pass2El = document.getElementById('pr-pass2');
  const p1 = passEl ? String(passEl.value || '') : '';
  const p2 = pass2El ? String(pass2El.value || '') : '';

  if (p1.length < 8 || p1.length > 128) {
    showToast('كلمة المرور يجب أن تكون 8 أحرف على الأقل', 'error');
    clearPasswordRecoveryFields();
    return;
  }
  if (p1 !== p2) {
    showToast('كلمتا المرور غير متطابقتين', 'error');
    clearPasswordRecoveryFields();
    return;
  }

  const btn = document.getElementById('pr-save-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'جارٍ الحفظ…';
  }

  try {
    const { error } = await sb.auth.updateUser({ password: p1 });
    clearPasswordRecoveryFields();
    if (error) {
      _passwordRecoveryActive = false;
      closePasswordRecoveryModal();
      try { await sb.auth.signOut(); } catch {}
      showLoginShell();
      showToast('رابط استعادة كلمة المرور غير صالح أو منتهٍ. اطلب رابطاً جديداً من المسؤول.', 'error');
      return;
    }

    _passwordRecoveryActive = false;
    closePasswordRecoveryModal();
    currentUser = null;
    _sessionBootstrapDone = false;
    clearLegacySessionArtifacts();
    try { await sb.auth.signOut(); } catch {}
    showLoginShell();
    showToast('تم تعيين كلمة المرور بنجاح. يمكنك تسجيل الدخول الآن.', 'success');
  } catch {
    clearPasswordRecoveryFields();
    showToast('تعذّر تعيين كلمة المرور. حاول مرة أخرى أو اطلب رابطاً جديداً.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '💾 حفظ كلمة المرور';
    }
  }
}

async function cancelPasswordRecovery() {
  clearPasswordRecoveryFields();
  closePasswordRecoveryModal();
  _passwordRecoveryActive = false;
  currentUser = null;
  _sessionBootstrapDone = false;
  clearLegacySessionArtifacts();
  try { if (sb) await sb.auth.signOut(); } catch {}
  showLoginShell();
  showToast('تم إلغاء تعيين كلمة المرور', 'warning');
}

/** مسار واحد: profile → currentUser → الواجهة → البيانات */
async function bootstrapAuthenticatedSession(session) {
  if (_passwordRecoveryActive) return false;
  if (!session?.user) return false;
  if (_authHandling) return false;
  if (_sessionBootstrapDone && currentUser?.id === session.user.id) return true;

  _authHandling = true;
  try {
    const profile = await fetchProfileForAuthUser(session.user);
    if (!profile) {
      await denyAccessAndSignOut('تعذّر الدخول. تحقق من بيانات الاعتماد أو راجع المسؤول.');
      return false;
    }
    currentUser = profile;
    clearLegacySessionArtifacts();
    showAppShell();
    await loadSettings();
    await loadAllData(false);
    applyRoleUI();
    _sessionBootstrapDone = true;
    return true;
  } catch (err) {
    console.error('[bootstrapAuthenticatedSession]');
    await denyAccessAndSignOut('تعذّر تجهيز الجلسة. حاول مرة أخرى.');
    return false;
  } finally {
    _authHandling = false;
  }
}

async function handleSignedOut() {
  currentUser = null;
  _sessionBootstrapDone = false;
  clearLegacySessionArtifacts();
  [programsCache, initiativesCache, tasksCache, evidencesCache, teachersCache, kpiCache] = [[], [], [], [], [], []];
  indicatorsCache = {};
  settingsCache = {};
  activeSchoolYearId = null;
  selectedSchoolYearId = null;
  schoolYearsCache = [];
  if (!_passwordRecoveryActive) {
    closePasswordRecoveryModal();
  }
  showLoginShell();
}

async function handleAuthStateEvent(event, session) {
  if (event === 'SIGNED_OUT') {
    await handleSignedOut();
    return;
  }
  // جلسة استعادة فقط — لا تُفعَّل صلاحيات التطبيق / إدارة المستخدمين
  if (event === 'PASSWORD_RECOVERY') {
    await beginPasswordRecoveryFlow();
    return;
  }
  if (_passwordRecoveryActive) return;
  if (!session?.user) return;
  // TOKEN_REFRESHED: لا تعِد تحميل البيانات
  if (event === 'TOKEN_REFRESHED') return;
  // منع التكرار مع doLogin / getSession
  if (_authHandling) return;
  if (_sessionBootstrapDone && currentUser?.id === session.user.id) return;
  await bootstrapAuthenticatedSession(session);
}

function bindAuthStateListener() {
  if (!sb || _authListenerBound) return;
  _authListenerBound = true;
  sb.auth.onAuthStateChange((event, session) => {
    // callback خفيف — العمل غير المتزامن خارجاً
    queueMicrotask(() => {
      void handleAuthStateEvent(event, session);
    });
  });
}

function requireAuth(action) {
  if (!currentUser) {
    showToast('يجب تسجيل الدخول أولاً', 'error');
    return false;
  }
  if (action && !can(action)) {
    showToast('ليس لديك صلاحية لهذا الإجراء', 'error');
    return false;
  }
  return true;
}

/* ─────────────────────────────────────────────────────────────
   §3  LS HELPERS
   ─────────────────────────────────────────────────────────────
   مخصّصة حاليًا لـ KPI (مؤقت) وتنظيف مفاتيح localStorage القديمة.
   لا تُستخدم كمصدر حقيقة للبيانات التشغيلية (برامج/شواهد/…).
   ───────────────────────────────────────────────────────────── */
const SB_UNAVAILABLE_MSG = 'تعذّر الاتصال بـ Supabase';
const lsSave = (k,v) => { try{ localStorage.setItem('sop_'+k, JSON.stringify(v)); }catch{} };
const lsLoad = (k,d) => { try{ const v=localStorage.getItem('sop_'+k); return v?JSON.parse(v):d; }catch{ return d; } };
const lsDel  = k     => { try{ localStorage.removeItem('sop_'+k); }catch{} };
function requireSb() {
  if (!sb) throw new Error(SB_UNAVAILABLE_MSG);
}

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
  if (id === 'evidence-modal' || id === 'report-modal') {
    pendingFileData = null;
    pendingImageData = null;
    pendingEvidenceFile = null;
  }
  if (id === 'program-detail-modal') {
    _openProgramDetailId = null;
  }
  if (id === 'password-recovery-modal') {
    clearPasswordRecoveryFields();
  }
}

/* ─────────────────────────────────────────────────────────────
   §7  AUTH
   ───────────────────────────────────────────────────────────── */
async function doLogin() {
  const email = (document.getElementById('login-email')?.value || '').trim().toLowerCase();
  const pass  = (document.getElementById('login-password')?.value || '');

  if (!email || !pass) {
    showToast('يرجى إدخال البريد الإلكتروني وكلمة المرور', 'error');
    return;
  }
  if (!isValidEmail(email)) {
    showToast('صيغة البريد الإلكتروني غير صحيحة', 'error');
    return;
  }
  if (pass.length < 6 || pass.length > 128) {
    showToast('كلمة المرور غير صحيحة', 'error');
    return;
  }
  if (!sb) {
    showToast('تعذّر الاتصال بخدمة المصادقة', 'error');
    return;
  }

  const btn = document.getElementById('login-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'جارٍ التحقق…';
  }

  try {
    showLoadingOverlay?.(true);
    const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
    if (error || !data?.session) {
      showToast('تعذّر تسجيل الدخول. تحقق من البيانات وحاول مرة أخرى.', 'error');
      return;
    }
    const ok = await bootstrapAuthenticatedSession(data.session);
    if (!ok) return;
    showToast('تم تسجيل الدخول بنجاح', 'success');
  } catch (err) {
    console.error('[doLogin]');
    showToast('تعذّر تسجيل الدخول. حاول مرة أخرى.', 'error');
  } finally {
    clearLoginPasswordField();
    showLoadingOverlay?.(false);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'دخول إلى المنصة';
    }
  }
}
window.doLogin = doLogin;

async function doLogout() {
  _sessionBootstrapDone = false;
  currentUser = null;
  [programsCache, initiativesCache, tasksCache, evidencesCache, teachersCache, kpiCache] = [[], [], [], [], [], []];
  indicatorsCache = {};
  settingsCache = {};
  activeSchoolYearId = null;
  selectedSchoolYearId = null;
  schoolYearsCache = [];
  clearLegacySessionArtifacts();
  try { if (sb) await sb.auth.signOut(); } catch {}
  showLoginShell();
  const e = document.getElementById('login-email'); if (e) e.value = '';
  clearLoginPasswordField();
}
window.doLogout = doLogout;
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

  const navAllowed = NAV_ALLOWED[r] || [];

  document.querySelectorAll('.nav-item').forEach(el => {
    el.style.display = navAllowed.includes(el.dataset.section) ? 'flex' : 'none';
  });

  // زر إضافة برنامج
  const abp = document.getElementById('btn-add-program'); if (abp) abp.style.display = can('addProgram') ? '' : 'none';
  const abi = document.getElementById('btn-add-initiative'); if (abi) abi.style.display = can('addInitiative') ? '' : 'none';
  const abt = document.getElementById('btn-add-teacher'); if (abt) abt.style.display = can('addTeacher') ? '' : 'none';
  const abk = document.getElementById('btn-add-kpi'); if (abk) abk.style.display = isSectionAllowed('kpi') ? '' : 'none';
  document.querySelectorAll('#section-tasks .btn-primary, #section-reports .btn-primary').forEach(btn => {
    if (btn.getAttribute('onclick')?.includes('openTaskModal')) btn.style.display = can('addTask') ? '' : 'none';
    if (btn.getAttribute('onclick')?.includes('openReportModal')) btn.style.display = can('addEvidence') ? '' : 'none';
  });

  const syAdmin = document.getElementById('school-years-admin-wrap');
  if (syAdmin) syAdmin.style.display = r === 'admin' ? '' : 'none';

  applyYearWriteModeUI();
  if (r === 'admin') renderSchoolYearsAdmin();
}

/* ─────────────────────────────────────────────────────────────
   §9  LOAD ALL DATA
   ───────────────────────────────────────────────────────────── */
async function loadAllData(renderAfter = true) {
  if (!currentUser) return;
  showLoadingOverlay(true);
  try {
    await fetchSchoolYears();
    await fetchActiveSchoolYear();
    renderYearSelector();
    updateYearModeBanner();
    applyYearWriteModeUI();
    await fetchPrograms();
    await fetchIndicators();
    await fetchEvidences();
    if (isSectionAllowed('plan') || isSectionAllowed('tasks')) {
      await fetchTasks();
      await fetchInitiatives();
    } else {
      tasksCache = [];
      initiativesCache = [];
    }
    if (isSectionAllowed('teachers')) {
      await fetchTeachers();
    } else {
      teachersCache = [];
    }
    await fetchKPI();
    // settings تُحمَّل في bootstrapAuthenticatedSession بعد نجاح الجلسة فقط

    programsCache.forEach(p => {
      p.progress = calcProgramProgress(p.id);
    });

    if (renderAfter) renderSection(_activeSection);

  } catch (e) {
    console.error('[loadAllData]');
    showToast('تعذّر تحميل بعض البيانات', 'error');
  } finally {
    showLoadingOverlay(false);
  }
}
/* ─────────────────────────────────────────────────────────────
   §10  NAVIGATION
   ───────────────────────────────────────────────────────────── */
let _activeSection = 'dashboard';

function navTo(name, el) {
  if (!currentUser) {
    showToast('يجب تسجيل الدخول أولاً', 'error');
    return;
  }
  if (!isSectionAllowed(name)) {
    showToast('ليس لديك صلاحية الوصول لهذه الصفحة', 'error');
    return;
  }
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
    dashboard: renderDashboard,
    programs: renderPrograms,
    plan: renderPlan,
    kpi: renderKPI,
    tasks: renderTasks,
    reports: renderReports,
    teachers: renderTeachers,
    calendar: renderCalendar,
    stats: renderStats,
    settings: () => { loadSettings(); if (currentUser?.role === 'admin') renderSchoolYearsAdmin(); },
  }[name]?.());

  if (name === 'dashboard') {
    renderDashboard();
    setTimeout(() => drawDashPie(), 100);
  }
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
function calcProgramProgress(programId) {
  const inds = indicatorsCache[programId] || indicatorsCache[String(programId)] || [];
  if (!inds.length) return 0;

  const done = inds.filter(ind => {
    const completed = ind.is_completed === true || ind.is_completed === 'true' || ind.is_completed === 1;
    const hasEvidence = evidencesCache.some(ev =>
      String(ev.program_id) === String(programId) &&
      String(ev.indicator_id) === String(ind.id)
    );
    return completed && hasEvidence;
  }).length;

  return Math.round((done / inds.length) * 100);
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
  refreshHijriPreview('prog-start');
  refreshHijriPreview('prog-end');
}

function parseISODateOnly(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 12, 0, 0));
  }
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) {
    // ظهيرة UTC لتجنّب انزياح اليوم عند العرض بـ Asia/Riyadh
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  }
  return null;
}

function isoKeyFromParsedDate(d) {
  if (!d || isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toISODateKey(value) {
  if (value == null || value === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = parseISODateOnly(value);
  return d ? isoKeyFromParsedDate(d) : null;
}

function supportsIslamicUmalqura() {
  try {
    const sample = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
      timeZone: 'Asia/Riyadh',
      year: 'numeric', month: 'numeric', day: 'numeric'
    }).formatToParts(new Date(Date.UTC(2026, 7, 9, 12, 0, 0)));
    const year = sample.find(p => p.type === 'year')?.value || '';
    return /\d{3,4}/.test(year);
  } catch {
    return false;
  }
}

function getTodayISOInRiyadh() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value;
  const y = get('year');
  const m = get('month');
  const d = get('day');
  if (!y || !m || !d) return null;
  return `${y}-${m}-${d}`;
}

function getHijriPartsFromDate(date) {
  if (!date || isNaN(date.getTime())) return null;
  try {
    const map = {};
    new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
      timeZone: 'Asia/Riyadh',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    }).formatToParts(date).forEach(p => {
      if (p.type !== 'literal') map[p.type] = p.value;
    });
    const year = Number(String(map.year || '').replace(/[^\d]/g, ''));
    const month = Number(String(map.month || '').replace(/[^\d]/g, ''));
    const day = Number(String(map.day || '').replace(/[^\d]/g, ''));
    if (!year || !month || !day) return null;
    return { year, month, day };
  } catch {
    return null;
  }
}

function compareHijriParts(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

function findHijriDateUTC(hy, hm, hd) {
  if (!supportsIslamicUmalqura()) return null;
  const target = { year: hy, month: hm, day: hd };
  // تقريب ميلادي معروف: السنة الهجرية ≈ 0.970224× + 621.577
  const gApprox = Math.round(hy * 0.970224 + 621.577);
  let lo = Date.UTC(gApprox - 3, 0, 1, 12, 0, 0);
  let hi = Date.UTC(gApprox + 3, 11, 31, 12, 0, 0);

  // ضبط النطاق إن ابتعد التقريب
  for (let i = 0; i < 6; i++) {
    const probe = getHijriPartsFromDate(new Date(Math.floor((lo + hi) / 2)));
    if (!probe) break;
    if (probe.year < hy - 1) {
      lo += 180 * 86400000;
      hi += 180 * 86400000;
    } else if (probe.year > hy + 1) {
      lo -= 180 * 86400000;
      hi -= 180 * 86400000;
    } else break;
  }

  while (lo <= hi) {
    const midDate = new Date(Math.floor((lo + hi) / 2));
    const cand = new Date(Date.UTC(
      midDate.getUTCFullYear(),
      midDate.getUTCMonth(),
      midDate.getUTCDate(),
      12, 0, 0
    ));
    const p = getHijriPartsFromDate(cand);
    if (!p) return null;
    const cmp = compareHijriParts(p, target);
    if (cmp === 0) return cand;
    if (cmp < 0) lo = cand.getTime() + 86400000;
    else hi = cand.getTime() - 86400000;
  }
  return null;
}

function buildHijriMonthDays(hy, hm) {
  const start = findHijriDateUTC(hy, hm, 1);
  if (!start) return [];
  const days = [];
  let cur = new Date(start.getTime());
  for (let i = 0; i < 31; i++) {
    const hp = getHijriPartsFromDate(cur);
    if (!hp || hp.year !== hy || hp.month !== hm) break;
    days.push({
      hijriDay: hp.day,
      gregDay: cur.getUTCDate(),
      gregMonth: cur.getUTCMonth() + 1,
      gregYear: cur.getUTCFullYear(),
      isoKey: isoKeyFromParsedDate(cur),
      weekday: cur.getUTCDay(),
      date: new Date(cur.getTime()),
    });
    cur = new Date(cur.getTime() + 86400000);
  }
  return days;
}

function formatHijriMonthYearLabel(hy, hm) {
  const start = findHijriDateUTC(hy, hm, 1);
  if (!start) return `${hm}/${hy} هـ`;
  try {
    return new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', {
      month: 'long',
      year: 'numeric',
      timeZone: 'Asia/Riyadh'
    }).format(start);
  } catch {
    return `${hm}/${hy} هـ`;
  }
}

function initCalendarCursorFromToday() {
  const iso = getTodayISOInRiyadh();
  const d = parseISODateOnly(iso) || new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 12));
  calendarYear = d.getUTCFullYear();
  calendarMonth = d.getUTCMonth();
  const hp = getHijriPartsFromDate(d);
  if (hp) {
    calendarHijriYear = hp.year;
    calendarHijriMonth = hp.month;
  }
  if (!supportsIslamicUmalqura()) calendarMode = 'gregorian';
}

function formatGregorianDate(value) {
  const d = parseISODateOnly(value);
  if (!d) return '—';
  try {
    return d.toLocaleDateString('ar-SA', {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Riyadh'
    });
  } catch {
    return '—';
  }
}

function formatHijriDate(value) {
  const d = parseISODateOnly(value);
  if (!d) return '';
  try {
    return d.toLocaleDateString('ar-SA-u-ca-islamic-umalqura', {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Riyadh'
    });
  } catch {
    try {
      return d.toLocaleDateString('ar-SA-u-ca-islamic', {
        year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Riyadh'
      });
    } catch {
      return '';
    }
  }
}

function formatDualDate(value) {
  if (value == null || value === '') return '—';
  const g = formatGregorianDate(value);
  if (g === '—') return '—';
  const h = formatHijriDate(value);
  return h ? `${g} · ${h}` : g;
}

function fmtDate(d) {
  return formatDualDate(d);
}

/* ─────────────────────────────────────────────────────────────
   §12b  SUPABASE: SCHOOL YEAR
   ───────────────────────────────────────────────────────────── */
const NO_ACTIVE_YEAR_MSG = 'لا توجد سنة دراسية نشطة. يرجى تفعيل سنة دراسية أولاً.';
const YEAR_STATUS_AR = {
  draft: 'مسودة',
  active: 'نشط',
  frozen: 'مجمد',
  archived: 'مؤرشف',
};

function yearStatusLabel(status) {
  return YEAR_STATUS_AR[status] || status || '—';
}

async function fetchSchoolYears() {
  if (!sb) return schoolYearsCache;
  try {
    const { data, error } = await sb
      .from('school_years')
      .select('id,name,label_ar,status,is_active,is_archived,start_date,end_date,notes,hijri_year,created_at')
      .order('created_at');
    if (error) {
      console.error('[fetchSchoolYears]', error.message);
      return schoolYearsCache;
    }
    schoolYearsCache = Array.isArray(data) ? data : [];
    return schoolYearsCache;
  } catch (err) {
    console.error('[fetchSchoolYears] exception', err);
    return schoolYearsCache;
  }
}

async function fetchActiveSchoolYear() {
  if (!sb) return activeSchoolYearId;
  try {
    // 1) RPC المركزية إن وُجدت
    const rpc = await sb.rpc('get_active_school_year');
    if (!rpc.error) {
      const row = Array.isArray(rpc.data) ? rpc.data[0] : rpc.data;
      if (row?.id) {
        activeSchoolYearId = row.id;
        if (!selectedSchoolYearId) selectedSchoolYearId = row.id;
        console.log('[fetchActiveSchoolYear] via rpc =', activeSchoolYearId ? '(set)' : '(empty)');
        return activeSchoolYearId;
      }
    } else {
      console.warn('[fetchActiveSchoolYear] rpc:', rpc.error.message);
    }

    // 2) جدول school_years مباشرة
    const { data, error } = await sb
      .from('school_years')
      .select('id,name,is_active')
      .eq('is_active', true)
      .limit(1);
    if (error) {
      console.error('[fetchActiveSchoolYear]', error.message);
      return activeSchoolYearId;
    }
    const id = (Array.isArray(data) && data[0]?.id) ? data[0].id : null;
    if (id) {
      activeSchoolYearId = id;
      if (!selectedSchoolYearId) selectedSchoolYearId = id;
    }
    console.log('[fetchActiveSchoolYear] via table =', activeSchoolYearId ? '(set)' : '(empty)');
    return activeSchoolYearId;
  } catch (err) {
    console.error('[fetchActiveSchoolYear] exception', err);
    return activeSchoolYearId;
  }
}

async function requireActiveSchoolYearId() {
  // دائماً أعد الجلب قبل الكتابة لضمان قيمة حديثة
  const id = await fetchActiveSchoolYear();
  if (id == null || id === undefined || id === '') {
    throw new Error(NO_ACTIVE_YEAR_MSG);
  }
  activeSchoolYearId = id;
  return id;
}

function getSelectedSchoolYear() {
  if (!selectedSchoolYearId) return null;
  return schoolYearsCache.find(y => String(y.id) === String(selectedSchoolYearId)) || null;
}

function isSelectedYearWritable() {
  const y = getSelectedSchoolYear();
  return !!(y && y.status === 'active' && y.is_active);
}

function isYearReadOnlyMode() {
  const y = getSelectedSchoolYear();
  if (!y) return true;
  return !isSelectedYearWritable();
}

function assertYearWritable() {
  if (!isSelectedYearWritable()) {
    const msg = 'السنة المحددة للقراءة فقط. اختر السنة النشطة للتعديل.';
    showToast(msg, 'error');
    throw new Error('year_readonly');
  }
}

function arabicDbError(err) {
  if (!err) return 'تعذّر إتمام العملية';
  if (typeof err === 'string') {
    if (err === 'year_readonly') return 'السنة المحددة للقراءة فقط. اختر السنة النشطة للتعديل.';
    return err;
  }
  const msg = String(err.message || '');
  const code = String(err.code || '');
  const blob = `${msg} ${code}`.toLowerCase();
  if (msg === 'year_readonly' || blob.includes('year_readonly')) {
    return 'السنة المحددة للقراءة فقط. اختر السنة النشطة للتعديل.';
  }
  if (/forbidden|permission|rls|row-level|policy|42501|pgrst301|not allowed/.test(blob)) {
    return 'ليس لديك صلاحية لهذا الإجراء';
  }
  if (msg.includes(NO_ACTIVE_YEAR_MSG) || /لا يمكن الكتابة|سنة دراسية/.test(msg)) {
    return msg;
  }
  return msg || 'تعذّر إتمام العملية';
}

function yearScopedRows(cache, field = 'school_year_id') {
  const yearId = selectedSchoolYearId;
  if (yearId == null || yearId === '') return [];
  const list = Array.isArray(cache) ? cache : [];
  return list.filter(row => row && String(row[field]) === String(yearId));
}

async function requireWritableSchoolYearId() {
  await fetchSchoolYears();
  if (!selectedSchoolYearId && activeSchoolYearId) {
    selectedSchoolYearId = activeSchoolYearId;
  }
  const y = getSelectedSchoolYear();
  if (!y || y.status !== 'active' || !y.is_active) {
    throw new Error('لا يمكن الكتابة إلا على السنة الدراسية النشطة.');
  }
  return y.id;
}

function renderYearSelector() {
  const sel = document.getElementById('global-year-select');
  if (!sel) return;
  const cur = selectedSchoolYearId || activeSchoolYearId || '';
  if (!schoolYearsCache.length) {
    sel.innerHTML = '<option value="">لا توجد سنوات</option>';
    return;
  }
  sel.innerHTML = schoolYearsCache.map(y => {
    const label = y.label_ar || y.name || '—';
    const st = yearStatusLabel(y.status);
    const hijri = y.hijri_year ? ` · ${y.hijri_year}` : '';
    return `<option value="${esc(y.id)}" ${String(y.id) === String(cur) ? 'selected' : ''}>${esc(label)} (${esc(st)})${esc(hijri)}</option>`;
  }).join('');
}

function onYearSelected(id) {
  selectedSchoolYearId = id || null;
  updateYearModeBanner();
  if (currentUser) applyRoleUI();
  else applyYearWriteModeUI();
  renderYearSelector();
  if (currentUser?.role === 'admin') renderSchoolYearsAdmin();
  renderSection(_activeSection);
}
window.onYearSelected = onYearSelected;

function updateYearModeBanner() {
  const banner = document.getElementById('year-readonly-banner');
  if (!banner) return;
  const y = getSelectedSchoolYear();
  if (!y) {
    banner.classList.add('hidden');
    banner.textContent = '';
    return;
  }
  if (isSelectedYearWritable()) {
    banner.classList.add('hidden');
    banner.textContent = '';
    return;
  }
  const st = yearStatusLabel(y.status);
  const stKey = String(y.status || '');
  const modeHint = stKey === 'frozen' || stKey === 'archived'
    ? `للقراءة فقط — عام ${st}`
    : `للقراءة فقط — عام غير نشط (${st})`;
  banner.classList.remove('hidden');
  banner.textContent = `${modeHint} — «${y.label_ar || y.name || ''}». التعديل متاح على العام النشط فقط.`;
}

function applyYearWriteModeUI() {
  const ro = isYearReadOnlyMode();
  const setWriteControl = (el, allowedVisible) => {
    if (!el) return;
    if (ro) {
      el.style.display = 'none';
      el.disabled = true;
      return;
    }
    el.disabled = false;
    if (allowedVisible === true) el.style.display = '';
    else if (allowedVisible === false) el.style.display = 'none';
  };
  setWriteControl(document.getElementById('btn-add-program'), can('addProgram'));
  setWriteControl(document.getElementById('btn-add-initiative'), can('addInitiative'));
  setWriteControl(document.getElementById('btn-add-teacher'), can('addTeacher'));
  setWriteControl(document.getElementById('btn-add-kpi'), isSectionAllowed('kpi'));
  document.querySelectorAll('#section-tasks .btn-primary, #section-reports .btn-primary').forEach(btn => {
    const oc = btn.getAttribute('onclick') || '';
    if (oc.includes('openTaskModal')) setWriteControl(btn, can('addTask'));
    if (oc.includes('openReportModal')) setWriteControl(btn, can('addEvidence'));
  });
}

function bindHijriPreview(inputId, previewId) {
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
  if (!input || !preview) return;
  const update = () => {
    const v = input.value;
    if (!v) {
      preview.textContent = '';
      return;
    }
    const h = formatHijriDate(v);
    preview.textContent = h ? `الموافق هجريًا: ${h}` : '';
  };
  if (!input.dataset.hijriBound) {
    input.addEventListener('change', update);
    input.addEventListener('input', update);
    input.dataset.hijriBound = '1';
  }
  // خزّن آخر دالة تحديث لإعادة التشغيل بعد تعبئة القيمة برمجيًا
  input._hijriPreviewUpdate = update;
  update();
}

function refreshHijriPreview(inputId) {
  const input = document.getElementById(inputId);
  if (input && typeof input._hijriPreviewUpdate === 'function') {
    input._hijriPreviewUpdate();
    return;
  }
  const map = {
    'prog-start': 'prog-start-hijri',
    'prog-end': 'prog-end-hijri',
    'ini-start': 'ini-start-hijri',
    'ini-end': 'ini-end-hijri',
    'task-due': 'task-due-hijri',
    'tf-last-report': 'tf-last-report-hijri',
    'sy-start': 'sy-start-hijri',
    'sy-end': 'sy-end-hijri',
  };
  if (map[inputId]) bindHijriPreview(inputId, map[inputId]);
}

function bindAllHijriPreviews() {
  [
    ['prog-start', 'prog-start-hijri'],
    ['prog-end', 'prog-end-hijri'],
    ['ini-start', 'ini-start-hijri'],
    ['ini-end', 'ini-end-hijri'],
    ['task-due', 'task-due-hijri'],
    ['tf-last-report', 'tf-last-report-hijri'],
    ['sy-start', 'sy-start-hijri'],
    ['sy-end', 'sy-end-hijri'],
  ].forEach(([a, b]) => bindHijriPreview(a, b));
}

function formatYearDateCell(value) {
  if (value == null || value === '') return 'غير محدد';
  const dual = formatDualDate(value);
  return dual === '—' ? 'غير محدد' : dual;
}

function formatYearDateRange(y) {
  return `${formatYearDateCell(y?.start_date)} → ${formatYearDateCell(y?.end_date)}`;
}

function displayHijriYearForSchoolYear(y) {
  const stored = String(y?.hijri_year || y?.hijri_year_display || '').trim();
  if (stored) return stored;
  const start = y?.start_date ? getHijriPartsFromDate(parseISODateOnly(y.start_date)) : null;
  const end = y?.end_date ? getHijriPartsFromDate(parseISODateOnly(y.end_date)) : null;
  if (start && end) {
    return start.year === end.year ? String(start.year) : `${start.year}-${end.year}`;
  }
  if (start) return String(start.year);
  if (end) return String(end.year);
  return 'غير محدد';
}

function renderSchoolYearsAdmin() {
  const root = document.getElementById('school-years-admin-root');
  if (!root) return;
  if (currentUser?.role !== 'admin') {
    root.innerHTML = '';
    return;
  }

  const rows = schoolYearsCache.length
    ? schoolYearsCache.map(y => {
        const st = y.status || (y.is_archived ? 'archived' : (y.is_active ? 'active' : 'draft'));
        const actions = [];
        actions.push(`<button class="btn-sm btn-edit" onclick="openSchoolYearEditForm('${esc(y.id)}')">✏️ تعديل</button>`);
        if (st === 'draft' || st === 'frozen') {
          actions.push(`<button class="btn-sm btn-view" onclick="adminActivateYear('${esc(y.id)}')">▶️ تفعيل</button>`);
        }
        if (st === 'active') {
          actions.push(`<button class="btn-sm btn-note" onclick="adminFreezeYear('${esc(y.id)}')">❄️ تجميد</button>`);
        }
        if (st === 'frozen') {
          actions.push(`<button class="btn-sm btn-delete" onclick="adminArchiveYear('${esc(y.id)}')">📦 أرشفة</button>`);
        }
        return `<tr>
          <td class="sy-name-cell" dir="ltr">${esc(y.name || '—')}</td>
          <td class="sy-label-cell">${esc(y.label_ar || '—')}</td>
          <td><span class="badge badge-info">${esc(yearStatusLabel(st))}</span></td>
          <td class="sy-hijri-cell" dir="ltr">${esc(displayHijriYearForSchoolYear(y))}</td>
          <td class="sy-dates-cell">${esc(formatYearDateRange(y))}</td>
          <td><div style="display:flex;gap:4px;flex-wrap:wrap">${actions.join('')}</div></td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted)">لا توجد سنوات دراسية بعد</td></tr>';

  root.innerHTML = `
    <div class="sy-admin-toolbar">
      <button class="btn-primary" onclick="openSchoolYearCreateForm()">+ إنشاء سنة دراسية</button>
    </div>
    <div id="sy-admin-form" class="sy-admin-form hidden"></div>
    <div class="table-wrap sy-admin-table-wrap">
      <table class="data-table sy-admin-table">
        <thead>
          <tr>
            <th>الاسم</th><th>التسمية</th><th>الحالة</th><th>هجري (عرض)</th><th>الفترة</th><th>إجراءات</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function openSchoolYearCreateForm() {
  const box = document.getElementById('sy-admin-form');
  if (!box) return;
  box.classList.remove('hidden');
  box.innerHTML = `
    <h4>إنشاء سنة دراسية (مسودة)</h4>
    <p class="field-hint">يُحفظ الاسم والتسمية كما تدخلان حرفيًا — بدون تصحيح تلقائي للأرقام.</p>
    <div class="form-group">
      <label>الاسم <span class="req">*</span></label>
      <input type="text" id="sy-name" class="sy-text-input" dir="ltr" autocomplete="off" placeholder="مثال: 1447-1448"/>
    </div>
    <div class="form-group">
      <label>التسمية العربية (label_ar)</label>
      <input type="text" id="sy-label" class="sy-text-input" autocomplete="off" placeholder="مثال: العام الدراسي 1447–1448هـ"/>
    </div>
    <div class="form-row">
      <div class="form-group"><label>تاريخ البدء (ميلادي ISO)</label><input type="date" id="sy-start"/><div class="hijri-preview" id="sy-start-hijri"></div></div>
      <div class="form-group"><label>تاريخ الانتهاء (ميلادي ISO)</label><input type="date" id="sy-end"/><div class="hijri-preview" id="sy-end-hijri"></div></div>
    </div>
    <div class="form-group"><label>عرض السنة الهجرية (اختياري — يُحفظ كما هو)</label><input type="text" id="sy-hijri" class="sy-text-input" dir="ltr" placeholder="مثال: 1447-1448"/></div>
    <div class="form-group"><label>ملاحظات</label><textarea id="sy-notes" placeholder="ملاحظات إدارية..."></textarea></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn-primary" onclick="adminCreateSchoolYear()">💾 حفظ المسودة</button>
      <button class="btn-secondary" onclick="document.getElementById('sy-admin-form')?.classList.add('hidden')">إلغاء</button>
    </div>`;
  bindHijriPreview('sy-start', 'sy-start-hijri');
  bindHijriPreview('sy-end', 'sy-end-hijri');
}

function openSchoolYearEditForm(yearId) {
  const y = schoolYearsCache.find(x => String(x.id) === String(yearId));
  if (!y) return;
  const box = document.getElementById('sy-admin-form');
  if (!box) return;
  box.classList.remove('hidden');
  const nameVal = y.name || '';
  const labelVal = y.label_ar || '';
  box.innerHTML = `
    <h4>تعديل بيانات السنة</h4>
    <input type="hidden" id="sy-edit-id" value="${esc(y.id)}"/>
    <div class="sy-current-values">
      <div><span class="sy-current-label">الاسم الحالي:</span> <code class="sy-code" dir="ltr">${esc(nameVal || '—')}</code></div>
      <div><span class="sy-current-label">التسمية الحالية:</span> <span>${esc(labelVal || '—')}</span></div>
    </div>
    <p class="field-hint">عدّل الحقول أدناه يدويًا إن لزم (مثل تصحيح 447-1448 إلى 1447-1448). لا يتم أي تصحيح تلقائي.</p>
    <div class="form-group">
      <label>الاسم (name) <span class="req">*</span></label>
      <input type="text" id="sy-name" class="sy-text-input" dir="ltr" autocomplete="off" value="${esc(nameVal)}"/>
    </div>
    <div class="form-group">
      <label>التسمية العربية (label_ar)</label>
      <input type="text" id="sy-label" class="sy-text-input" autocomplete="off" value="${esc(labelVal)}"/>
    </div>
    <div class="form-row">
      <div class="form-group"><label>تاريخ البدء (ميلادي ISO)</label><input type="date" id="sy-start" value="${esc(y.start_date || '')}"/><div class="hijri-preview" id="sy-start-hijri"></div></div>
      <div class="form-group"><label>تاريخ الانتهاء (ميلادي ISO)</label><input type="date" id="sy-end" value="${esc(y.end_date || '')}"/><div class="hijri-preview" id="sy-end-hijri"></div></div>
    </div>
    <div class="form-group"><label>ملاحظات</label><textarea id="sy-notes">${esc(y.notes || '')}</textarea></div>
    <p class="field-hint">تعديل البيانات الوصفية فقط — تغيير الحالة عبر أزرار التفعيل/التجميد/الأرشفة.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn-primary" onclick="adminUpdateSchoolYearMeta()">💾 حفظ التعديل</button>
      <button class="btn-secondary" onclick="document.getElementById('sy-admin-form')?.classList.add('hidden')">إلغاء</button>
    </div>`;
  bindHijriPreview('sy-start', 'sy-start-hijri');
  bindHijriPreview('sy-end', 'sy-end-hijri');
}

async function refreshYearsAfterAdminAction() {
  await fetchSchoolYears();
  await fetchActiveSchoolYear();
  renderYearSelector();
  updateYearModeBanner();
  applyYearWriteModeUI();
  renderSchoolYearsAdmin();
  renderSection(_activeSection);
}

async function adminCreateSchoolYear() {
  if (currentUser?.role !== 'admin') { showToast('للإدارة فقط', 'error'); return; }
  const name = (document.getElementById('sy-name')?.value || '').trim();
  if (!name) { showToast('يرجى إدخال اسم السنة', 'error'); return; }
  const label = (document.getElementById('sy-label')?.value || '').trim() || null;
  const start = document.getElementById('sy-start')?.value || null;
  const end = document.getElementById('sy-end')?.value || null;
  const notes = (document.getElementById('sy-notes')?.value || '').trim() || null;
  const hijri = (document.getElementById('sy-hijri')?.value || '').trim() || null;
  try {
    const { error } = await sb.rpc('create_school_year', {
      p_name: name,
      p_label_ar: label,
      p_start_date: start || null,
      p_end_date: end || null,
      p_notes: notes,
      p_hijri_year_display: hijri,
    });
    if (error) throw error;
    showToast('تم إنشاء السنة كمسودة ✅', 'success');
    await refreshYearsAfterAdminAction();
  } catch (err) {
    console.error('[adminCreateSchoolYear]', err);
    showToast(arabicDbError(err), 'error');
  }
}

async function adminUpdateSchoolYearMeta() {
  if (currentUser?.role !== 'admin') { showToast('للإدارة فقط', 'error'); return; }
  const id = document.getElementById('sy-edit-id')?.value;
  const name = (document.getElementById('sy-name')?.value || '').trim();
  if (!id || !name) { showToast('يرجى إدخال اسم السنة', 'error'); return; }
  const label = (document.getElementById('sy-label')?.value || '').trim() || null;
  const start = document.getElementById('sy-start')?.value || null;
  const end = document.getElementById('sy-end')?.value || null;
  const notes = (document.getElementById('sy-notes')?.value || '').trim() || null;
  try {
    const { error } = await sb.rpc('update_school_year_meta', {
      p_year_id: id,
      p_name: name,
      p_label_ar: label,
      p_start_date: start || null,
      p_end_date: end || null,
      p_notes: notes,
    });
    if (error) throw error;
    showToast('تم تحديث بيانات السنة ✅', 'success');
    await refreshYearsAfterAdminAction();
  } catch (err) {
    console.error('[adminUpdateSchoolYearMeta]', err);
    showToast(arabicDbError(err), 'error');
  }
}

async function adminActivateYear(yearId) {
  if (currentUser?.role !== 'admin') { showToast('للإدارة فقط', 'error'); return; }
  const otherActive = schoolYearsCache.find(y => y.is_active && String(y.id) !== String(yearId));
  let freezeCurrent = false;
  if (otherActive) {
    if (!confirm(`يوجد سنة نشطة أخرى («${otherActive.label_ar || otherActive.name}»). هل تريد تجميدها ثم تفعيل هذه السنة؟`)) return;
    freezeCurrent = true;
  } else if (!confirm('تفعيل هذه السنة الدراسية؟')) {
    return;
  }
  try {
    const { error } = await sb.rpc('activate_school_year', {
      p_year_id: yearId,
      p_freeze_current: freezeCurrent,
    });
    if (error) throw error;
    selectedSchoolYearId = yearId;
    showToast('تم تفعيل السنة الدراسية ✅', 'success');
    await refreshYearsAfterAdminAction();
  } catch (err) {
    console.error('[adminActivateYear]', err);
    showToast(arabicDbError(err), 'error');
  }
}

async function adminFreezeYear(yearId) {
  if (currentUser?.role !== 'admin') { showToast('للإدارة فقط', 'error'); return; }
  if (!confirm('تجميد السنة النشطة؟ لن يُسمح بالتعديل بعدها حتى إعادة التفعيل.')) return;
  try {
    const { error } = await sb.rpc('freeze_school_year', { p_year_id: yearId });
    if (error) throw error;
    showToast('تم تجميد السنة ❄️', 'warning');
    await refreshYearsAfterAdminAction();
  } catch (err) {
    console.error('[adminFreezeYear]', err);
    showToast(arabicDbError(err), 'error');
  }
}

async function adminArchiveYear(yearId) {
  if (currentUser?.role !== 'admin') { showToast('للإدارة فقط', 'error'); return; }
  if (!confirm('أرشفة هذه السنة المجمّدة؟ هذا إجراء للسنوات المنتهية.')) return;
  try {
    const { error } = await sb.rpc('archive_school_year', { p_year_id: yearId });
    if (error) throw error;
    showToast('تم أرشفة السنة 📦', 'warning');
    await refreshYearsAfterAdminAction();
  } catch (err) {
    console.error('[adminArchiveYear]', err);
    showToast(arabicDbError(err), 'error');
  }
}

window.fetchSchoolYears = fetchSchoolYears;
window.fetchActiveSchoolYear = fetchActiveSchoolYear;
window.requireActiveSchoolYearId = requireActiveSchoolYearId;
window.requireWritableSchoolYearId = requireWritableSchoolYearId;
window.renderSchoolYearsAdmin = renderSchoolYearsAdmin;
window.openSchoolYearCreateForm = openSchoolYearCreateForm;
window.openSchoolYearEditForm = openSchoolYearEditForm;
window.adminCreateSchoolYear = adminCreateSchoolYear;
window.adminUpdateSchoolYearMeta = adminUpdateSchoolYearMeta;
window.adminActivateYear = adminActivateYear;
window.adminFreezeYear = adminFreezeYear;
window.adminArchiveYear = adminArchiveYear;
window.formatGregorianDate = formatGregorianDate;
window.formatHijriDate = formatHijriDate;
window.formatDualDate = formatDualDate;
window.parseISODateOnly = parseISODateOnly;
window.refreshHijriPreview = refreshHijriPreview;
window.supportsIslamicUmalqura = supportsIslamicUmalqura;

/* ─────────────────────────────────────────────────────────────
   §13  SUPABASE: PROGRAMS
   ───────────────────────────────────────────────────────────── */
async function fetchPrograms() {
  if (!sb) {
    console.error('[fetchPrograms]', SB_UNAVAILABLE_MSG);
    showToast(SB_UNAVAILABLE_MSG, 'error');
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
  programsCache = (pr.data || []).map(row => ({
  id: row.id,
  name: row.name || '',
  desc: row.description || '',
  start: row.start_date || '',
  end: row.end_date || '',
  progress: calcProgramProgress(row.id),
  resp: row.resp || '',
  target: row.target_group || '',
  evidence: [],
  indicators: indicatorsCache[row.id] || indicatorsCache[String(row.id)] || [],
  school_year_id: row.school_year_id || null,
}));
    syncEvidencesToPrograms();
  } catch (err) {
    console.error('[fetchPrograms]', err.message);
    showToast('تعذّر تحميل البرامج', 'error');
    // الإبقاء على كاش الجلسة في الذاكرة فقط — بلا localStorage
  }
}

async function sbInsertProgram(p) {
  requireSb();

  // جلب السنة القابلة للكتابة (المحددة إن كانت نشطة) قبل الإدراج
  const yearId = await requireWritableSchoolYearId();
  if (yearId == null || yearId === undefined || yearId === '') {
    throw new Error(NO_ACTIVE_YEAR_MSG);
  }

  const payload = {
    name: p.name,
    description: p.desc || null,
    resp: p.resp || null,
    target_group: p.target || null,
    start_date: p.start || null,
    end_date: p.end || null,
    progress: parseInt(p.progress) || 0,
    status: calcProgramStatus(p),
    school_year_id: yearId,
    created_by: currentUser?.id || null,
  };

  if (payload.school_year_id == null || payload.school_year_id === undefined) {
    console.error('[sbInsertProgram] blocked: school_year_id missing');
    throw new Error(NO_ACTIVE_YEAR_MSG);
  }

  const { data, error } = await sb.from('programs').insert(payload).select().single();
  if (error) {
    console.error('[sbInsertProgram] supabase error', error.message || error);
    throw error;
  }
  return { ...p, id: data.id, school_year_id: data.school_year_id || yearId };
}

async function sbUpdateProgram(p) {
  requireSb();
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
  requireSb();
  const { error } = await sb.from('programs').delete().eq('id', id);
  if (error) throw error;
  delete indicatorsCache[id];
}

/* ─────────────────────────────────────────────────────────────
   §14  SUPABASE: INDICATORS
   ───────────────────────────────────────────────────────────── */
async function syncProgress(progId) {
  if (!progId) return;

  const inds = indicatorsCache[progId] || indicatorsCache[String(progId)] || [];
  const total = inds.length;

  const done = inds.filter(ind => {
    const completed = ind.is_completed === true || ind.is_completed === 'true';

    const hasEvidence = evidencesCache.some(ev =>
      String(ev.program_id) === String(progId) &&
      String(ev.indicator_id) === String(ind.id)
    );

    return completed && hasEvidence;
  }).length;

  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  const pIdx = programsCache.findIndex(p => String(p.id) === String(progId));
  if (pIdx !== -1) {
    programsCache[pIdx].progress = progress;
  }

  if (sb) {
    const { error } = await sb
      .from('programs')
      .update({ progress })
      .eq('id', progId);

    if (error) console.error('[syncProgress]', error.message);
  }

  renderPrograms();
   renderDashboard();
   drawDashPie();
}
async function sbAddIndicator(progId, text) {
  requireSb();
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
  if (!requireAuth('toggleIndicator')) return;
  requireSb();
  const pid = String(progId);
  const iid = String(indId);

  const list = indicatorsCache[progId] || indicatorsCache[pid] || [];
  const ind = list.find(i => String(i.id) === iid);

  if (!ind) {
    console.error('Indicator not found', progId, indId, indicatorsCache);
    return;
  }

  if (currentUser?.role === 'teacher') {
    const prog = programsCache.find(p => String(p.id) === String(progId));
    if (prog?.resp && prog.resp !== currentUser.name) {
      showToast('لا يمكنك تعديل مؤشرات برنامج ليس مرتبطًا بك', 'error');
      return;
    }
  }

  const nv = !(ind.is_completed === true || ind.is_completed === 'true');
  ind.is_completed = nv;

  const { error } = await sb
    .from('program_indicators')
    .update({ is_completed: nv })
    .eq('id', indId);

  if (error) {
    console.error('[sbToggleIndicator]', error.message);
    ind.is_completed = !nv;
    showToast(arabicDbError(error), 'error');
    return;
  }

  await syncProgress(progId);
  renderPrograms();
  viewProgramDetail(progId);
}

async function handleDelInd(progId, indId) {
  if (!requireAuth('deleteIndicator')) return;
  try { assertYearWritable(); } catch { return; }
  if (!confirm('حذف هذا المؤشر؟')) return;
  try {
    requireSb();
    const { error } = await sb.from('program_indicators').delete().eq('id', indId);
    if (error) throw error;
    if (indicatorsCache[progId]) {
      indicatorsCache[progId] = indicatorsCache[progId].filter(i => String(i.id) !== String(indId));
    }
    await syncProgress(progId);
    renderPrograms();
    showToast('تم حذف المؤشر 🗑️', 'warning');
  } catch (err) {
    console.error('[handleDelInd]', err.message);
    showToast(arabicDbError(err), 'error');
  }
}
window.handleDelInd = handleDelInd;
window.sbToggleIndicator = sbToggleIndicator;

/* ─────────────────────────────────────────────────────────────
   §15  SUPABASE: INITIATIVES
   ───────────────────────────────────────────────────────────── */
async function fetchInitiatives() {
  if (!sb) {
    console.error('[fetchInitiatives]', SB_UNAVAILABLE_MSG);
    showToast(SB_UNAVAILABLE_MSG, 'error');
    return;
  }
  const { data, error } = await sb.from('initiatives').select('*').order('created_at');
  if (error) {
    console.error('[fetchInitiatives]', error.message);
    showToast('تعذّر تحميل المبادرات', 'error');
    return;
  }
  initiativesCache = (data||[]).map(r => ({
    id:r.id, goal:r.goal||'', name:r.name||'', desc:r.description||'',
    resp:r.resp||'', start:r.start_date||'', end:r.end_date||'',
    status:r.status||'لم تبدأ', progress:r.progress||0, link:r.link||'',
    school_year_id: r.school_year_id || null,
  }));
}

async function sbInsertInitiative(ini) {
  requireSb();
  const schoolYearId = await requireWritableSchoolYearId();
  const { data, error } = await sb.from('initiatives').insert({
    goal:ini.goal, name:ini.name, description:ini.desc||null, resp:ini.resp||null,
    start_date:ini.start||null, end_date:ini.end||null,
    status:ini.status, progress:parseInt(ini.progress)||0, link:ini.link||null,
    school_year_id: schoolYearId,
  }).select().single();
  if (error) throw error;
  return { ...ini, id:data.id, school_year_id: schoolYearId };
}

async function sbUpdateInitiative(ini) {
  requireSb();
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
  requireSb();
  const { error } = await sb.from('initiatives').delete().eq('id', id);
  if (error) throw error;
  initiativesCache = initiativesCache.filter(i => i.id !== id);
}

/* ─────────────────────────────────────────────────────────────
   §16  SUPABASE: TASKS
   ───────────────────────────────────────────────────────────── */
async function fetchTasks() {
  if (!sb) {
    console.error('[fetchTasks]', SB_UNAVAILABLE_MSG);
    showToast(SB_UNAVAILABLE_MSG, 'error');
    return;
  }
  const { data, error } = await sb.from('tasks').select('*').order('created_at');
  if (error) {
    console.error('[fetchTasks]', error.message);
    showToast('تعذّر تحميل المهام', 'error');
    return;
  }
  tasksCache = (data||[]).map(r => ({
    id:r.id, name:r.name||'', resp:r.resp||'', due:r.due_date||'',
    priority:r.priority||'medium', status:r.status||'pending', notes:r.notes||'',
    school_year_id: r.school_year_id || null,
  }));
}

async function sbInsertTask(t) {
  requireSb();
  const schoolYearId = await requireWritableSchoolYearId();
  const { data, error } = await sb.from('tasks').insert({
    name:t.name, resp:t.resp||null, due_date:t.due||null,
    priority:t.priority, status:t.status, notes:t.notes||null,
    school_year_id: schoolYearId,
  }).select().single();
  if (error) throw error;
  return { ...t, id:data.id, school_year_id: schoolYearId };
}

async function sbUpdateTask(t) {
  requireSb();
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
  requireSb();
  const { error } = await sb.from('tasks').delete().eq('id', id);
  if (error) throw error;
  tasksCache = tasksCache.filter(t => t.id !== id);
}

async function sbUpdateTaskStatus(id, status) {
  requireSb();
  const t = tasksCache.find(x => x.id === id); if (!t) return;
  const prev = t.status;
  t.status = status;
  const { error } = await sb.from('tasks').update({status}).eq('id', id);
  if (error) {
    t.status = prev;
    console.error('[sbUpdateTaskStatus]', error.message);
    throw error;
  }
}

/* ─────────────────────────────────────────────────────────────
   §17  SUPABASE: EVIDENCES
   ───────────────────────────────────────────────────────────── */

/** تحويل موحّد لسجل evidences من Supabase → نموذج الواجهة */
function mapEvidenceRow(r) {
  if (!r || typeof r !== 'object') return null;
  const programId = r.program_id != null ? r.program_id : (r.programId != null ? r.programId : null);
  const indicatorId = r.indicator_id != null && r.indicator_id !== ''
    ? r.indicator_id
    : (r.indicatorId != null && r.indicatorId !== '' ? r.indicatorId : null);
  const schoolYearId = r.school_year_id != null ? r.school_year_id : (r.schoolYearId != null ? r.schoolYearId : null);
  const fileUrl = r.file_url != null && r.file_url !== ''
    ? r.file_url
    : (r.fileUrl != null && r.fileUrl !== '' ? r.fileUrl : null);
  const fileName = r.file_name != null && r.file_name !== ''
    ? r.file_name
    : (r.fileName != null && r.fileName !== '' ? r.fileName : null);
  const fileSize = r.file_size != null ? r.file_size : (r.fileSize != null ? r.fileSize : null);
  const driveLink = (r.link || r.evidence_link || r.evidenceLink || '') || '';
  const uploadDate = r.upload_date || r.date || (r.created_at ? String(r.created_at).slice(0, 10) : '');
  return {
    id: r.id,
    title: r.title || '',
    type: r.type || '',
    program_id: programId,
    indicator_id: indicatorId,
    initiative_label: r.initiative_label || '',
    person: r.person || '',
    date: uploadDate,
    link: driveLink,
    evidence_link: driveLink,
    notes: r.notes || '',
    file_data: r.file_data || null,
    file_url: fileUrl,
    file_name: fileName,
    file_size: fileSize,
    school_year_id: schoolYearId,
    created_by: r.created_by || null,
    created_at: r.created_at || null,
  };
}

function evidenceDriveLink(ev) {
  return sanitizeUrl(ev?.link || ev?.evidence_link || '');
}

function evidenceHasViewTarget(ev) {
  return !!(ev?.file_url || evidenceDriveLink(ev));
}

function buildEvidenceItemHtml(ev, opts = {}) {
  const showDelete = opts.showDelete && can('deleteEvidence');
  const delBtn = showDelete
    ? `<button class="btn-sm btn-delete" onclick="handleDelEv('${esc(ev.id)}');closeModal('program-detail-modal');viewProgramDetail('${esc(opts.programId)}')">🗑️</button>`
    : '';
  const metaBits = [
    ev.person ? ('👩‍🏫 أضافتها: ' + esc(ev.person)) : '',
    ev.date ? esc(fmtDate(ev.date)) : '',
    ev.type ? esc(ev.type) : '',
    ev.file_name ? esc(ev.file_name) : '',
  ].filter(Boolean);
  return `<div class="evidence-detail-item">
    <div class="ev-det-icon">${getEvIcon(ev.type || ev.file_name)}</div>
    <div class="ev-det-info">
      <div class="ev-det-title">${esc(ev.title || ev.file_name || 'شاهد')}</div>
      <div class="ev-det-meta">${metaBits.length ? metaBits.join(' · ') : '—'}</div>
      ${ev.notes ? `<div class="ev-det-meta" style="font-style:italic">${esc(ev.notes)}</div>` : ''}
    </div>
    <div class="ev-det-actions">
      ${evidenceViewButtonHtml(ev)}
      ${delBtn}
    </div>
  </div>`;
}

async function fetchEvidences() {
  if (!sb) {
    console.error('[fetchEvidences]', SB_UNAVAILABLE_MSG);
    showToast(SB_UNAVAILABLE_MSG, 'error');
    return;
  }

  let data = null;
  let error = null;
  ({ data, error } = await sb
    .from('evidences')
    .select('*')
    .order('created_at', { ascending: false }));

  // إن فشل الترتيب على created_at جرّب بدون ترتيب بدل مسح كاش الجلسة
  if (error) {
    console.warn('[fetchEvidences] retry without created_at order');
    ({ data, error } = await sb.from('evidences').select('*'));
  }

  if (error) {
    console.error('[fetchEvidences]');
    showToast('تعذّر تحميل الشواهد', 'error');
    // الإبقاء على كاش الجلسة في الذاكرة فقط — بلا localStorage
    return;
  }

  evidencesCache = (data || []).map(mapEvidenceRow).filter(Boolean);
  syncEvidencesToPrograms();
}

function syncEvidencesToPrograms() {
  programsCache.forEach(p => {
    p.evidence = evidencesCache.filter(e =>
      String(e.program_id) === String(p.id)
    );
  });
}

async function refreshEvidenceViews(preferredProgramId) {
  await fetchEvidences();
  await fetchIndicators();
  syncEvidencesToPrograms();
  programsCache.forEach(p => {
    p.progress = calcProgramProgress(p.id);
  });
  renderReports();
  renderPrograms();
  if (typeof renderDashboard === 'function') renderDashboard();
  const detailId = preferredProgramId || _openProgramDetailId;
  const detailModal = document.getElementById('program-detail-modal');
  const detailOpen = detailModal && !detailModal.classList.contains('hidden');
  if (detailOpen && detailId != null && detailId !== '') {
    viewProgramDetail(detailId);
  }
}

async function sbInsertEvidence(ev) {
  requireSb();

  const schoolYearId = ev.school_year_id || await requireWritableSchoolYearId();
  if (!schoolYearId) throw new Error(NO_ACTIVE_YEAR_MSG);

  const row = {
    title: ev.title,
    type: ev.type || null,
    program_id: ev.program_id || null,
    indicator_id: ev.indicator_id || null,
    person: ev.person || null,
    notes: ev.notes || null,
    school_year_id: schoolYearId,
    link: ev.link || null,
    file_url: ev.file_url || null,
    file_name: ev.file_name || null,
    file_size: ev.file_size != null ? ev.file_size : null,
    upload_date: ev.date || new Date().toISOString().split('T')[0],
    created_by: currentUser?.id || null,
  };

  const { data, error } = await sb.from('evidences').insert(row).select('*').single();
  if (error) throw error;
  const mapped = mapEvidenceRow(data);
  if (!mapped) throw new Error('تعذّر حفظ الشاهد');
  return mapped;
}

async function sbDeleteEvidence(id, evidenceRow) {
  requireSb();
  const ev = evidenceRow || evidencesCache.find(e => String(e.id) === String(id)) || null;
  // مسار Storage فقط من file_url المخزّن — لا من file_name المعروض
  const storagePath = extractEvidenceStoragePath(ev?.file_url);

  // ترتيب: Storage أولاً ثم DB.
  // إن فشل التخزين لا نمس السجل (لا فقدان لبيانات الشاهد في الواجهة/القاعدة).
  // روابط Drive/الخارجية: بلا مسار bucket → حذف السجل فقط.
  if (storagePath) {
    const key = String(storagePath).replace(/^\/+/, '').replace(/^evidences\//, '');
    if (!key || key.includes('..')) {
      throw new Error('مسار ملف الشاهد غير صالح');
    }
    const { error: rmErr } = await sb.storage.from(EVIDENCE_BUCKET).remove([key]);
    if (rmErr) {
      console.error('[sbDeleteEvidence] storage', rmErr.message || rmErr);
      throw new Error('تعذّر حذف ملف الشاهد من التخزين. لم يُحذف السجل.');
    }
  }

  const { error } = await sb.from('evidences').delete().eq('id', id);
  if (error) {
    console.error('[sbDeleteEvidence] db', error.message || error);
    if (storagePath) {
      throw new Error('تم حذف الملف من التخزين لكن تعذّر حذف سجل الشاهد. أعد المحاولة.');
    }
    throw error;
  }

  evidencesCache = evidencesCache.filter(e => String(e.id) !== String(id));
  syncEvidencesToPrograms();
}

/* ─────────────────────────────────────────────────────────────
   §18  SUPABASE: TEACHER FOLLOWUPS (مستقل عن users)
   ───────────────────────────────────────────────────────────── */
async function fetchTeachers() {
  if (!sb) {
    console.error('[fetchTeachers]', SB_UNAVAILABLE_MSG);
    showToast(SB_UNAVAILABLE_MSG, 'error');
    return;
  }
  const { data, error } = await sb.from('teacher_followups').select('*').order('created_at');
  if (error) {
    console.error('[fetchTeachers]', error.message);
    showToast('تعذّر تحميل متابعة المعلمات', 'error');
    return;
  }
  teachersCache = (data||[]).map(r => ({
    id:r.id, name:r.name||'', assigned:r.assigned_tasks||0,
    done:r.done_tasks||0, lastReport:r.last_report||'', notes:r.notes||'',
    driveLink:r.drive_link||'', createdBy:r.created_by||'',
    school_year_id: r.school_year_id || null,
  }));
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
  requireSb();
  const schoolYearId = await requireWritableSchoolYearId();
  const { data, error } = await sb.from('teacher_followups').insert({
    name:tf.name, assigned_tasks:parseInt(tf.assigned)||0,
    done_tasks:parseInt(tf.done)||0, last_report:tf.lastReport||null, notes:tf.notes||null,
    drive_link:tf.driveLink||null, created_by:tf.createdBy||null,
    owner_id: currentUser?.id || null,
    school_year_id: schoolYearId,
  }).select().single();
  if (error) throw error;
  return { ...tf, id:data.id, school_year_id: schoolYearId };
}

async function sbUpdateTeacher(tf) {
  requireSb();
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
  requireSb();
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
const DEFAULT_SETTINGS = {schoolName:'مدرسة 127 الابتدائية',year:'١٤٤٦ / ١٤٤٧هـ',principal:'أ. ليلى الحربي',region:'منطقة المدينة المنورة'};

async function loadSettings() {
  let s = {...DEFAULT_SETTINGS};

  if (!sb) {
    console.error('[loadSettings]', SB_UNAVAILABLE_MSG);
    showToast(SB_UNAVAILABLE_MSG, 'error');
  } else {
    const { data, error } = await sb
      .from('settings')
      .select('*')
      .eq('id',1)
      .maybeSingle();

    if (error) {
      console.error('[loadSettings]', error.message);
      showToast('تعذّر تحميل الإعدادات', 'error');
      // الإبقاء على settingsCache في الذاكرة إن وُجد؛ وإلا قيم افتراضية للعرض فقط
      if (settingsCache && (settingsCache.school_name || settingsCache.principal_name)) {
        s = {
          schoolName: settingsCache.school_name || s.schoolName,
          year: settingsCache.academic_year || s.year,
          principal: settingsCache.principal_name || s.principal,
          region: settingsCache.region || s.region
        };
      }
    } else if (data) {
      s = {
        schoolName: data.school_name || s.schoolName,
        year: data.academic_year || s.year,
        principal: data.principal_name || s.principal,
        region: data.region || s.region
      };
    }
  }

  settingsCache = {
    principal_name: s.principal,
    school_name: s.schoolName,
    academic_year: s.year,
    region: s.region
  };

  applySettingsToUI(s);

  if (currentUser) applyRoleUI();
}
async function saveSettings() {
  if (!can('editSettings')) { showToast('ليس لديك صلاحية تعديل الإعدادات','error'); return; }
  if (!sb) { showToast(SB_UNAVAILABLE_MSG, 'error'); return; }
  const g = id => (document.getElementById(id)?.value||'');
  const s = {schoolName:g('setting-school'),year:g('setting-year'),principal:g('setting-principal'),region:g('setting-region')};

  const { error } = await sb.from('settings').upsert({
    id:1, school_name:s.schoolName, academic_year:s.year,
    principal_name:s.principal, region:s.region, updated_at:new Date().toISOString(),
  });
  if (error) {
    console.error('[saveSettings]', error.message);
    showToast('تعذّر حفظ الإعدادات في Supabase','error');
    return;
  }

  settingsCache = {
    principal_name: s.principal,
    school_name: s.schoolName,
    academic_year: s.year,
    region: s.region
  };
  applySettingsToUI(s);
  applyRoleUI();
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
  if (!currentUser) { showToast('يجب تسجيل الدخول أولاً', 'error'); return; }
  if (!confirm('إعادة تحميل البيانات؟')) return;
await loadAllData(false);
renderSection(_activeSection);
renderPrograms();
renderDashboard();
drawDashPie(); showToast('تم تحديث البيانات ✅','success');
}
function clearLocalCache() {
  if (!confirm('مسح الكاش المحلي؟')) return;
  // تنظيف مفاتيح قديمة + KPI المحلي فقط — ليست مصدر حقيقة تشغيلية
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
  const yearPrograms = yearScopedRows(programsCache);
  const cnt = {planning:0,active:0,done:0,late:0};
  yearPrograms.forEach(p => {
    p.progress = calcProgramProgress(p.id);
  });
  yearPrograms.forEach(p => { const s=calcProgramStatus(p); cnt[s]=(cnt[s]||0)+1; });
  const avg = yearPrograms.length ? Math.round(yearPrograms.reduce((s,p)=>s+(p.progress||0),0)/yearPrograms.length) : 0;
  const stEl = document.getElementById('programs-stats');
  if (stEl) stEl.innerHTML = `
    <div class="stat-card"><span class="stat-icon">🗂️</span><span class="stat-number">${yearPrograms.length}</span><span class="stat-label">إجمالي البرامج</span></div>
    <div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${cnt.done}</span><span class="stat-label">برامج منتهية</span></div>
    <div class="stat-card"><span class="stat-icon">▶️</span><span class="stat-number">${cnt.active}</span><span class="stat-label">برامج جارية</span></div>
    <div class="stat-card red"><span class="stat-icon">⚠️</span><span class="stat-number">${cnt.late}</span><span class="stat-label">برامج متأخرة</span></div>
    <div class="stat-card gold"><span class="stat-icon">📊</span><span class="stat-number">${avg}%</span><span class="stat-label">متوسط الإنجاز</span></div>`;

  const abp = document.getElementById('btn-add-program');
  if (abp) abp.style.display = (can('addProgram') && !isYearReadOnlyMode()) ? '' : 'none';

  const filtered = yearPrograms.filter(p =>
    (fs==='all' || calcProgramStatus(p)===fs) &&
    (!sq || p.name.toLowerCase().includes(sq) || (p.resp||'').toLowerCase().includes(sq))
  );

  const grid = document.getElementById('programs-grid'); if (!grid) return;
  if (!filtered.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🗂️</div><p>لا توجد برامج</p><small>أضف برنامجاً جديداً أو غيّر الفلتر / السنة</small></div>';
    return;
  }
  grid.innerHTML = filtered.map(p => buildProgramCard(p)).join('');
}
async function updateProgramProgress(programId) {
  if (!programId) return;

  const pct = calcProgramProgress(programId);

  if (!sb) return pct;

  const { error } = await sb
    .from('programs')
    .update({ progress: pct })
    .eq('id', programId);

  if (error) {
    console.error('[updateProgramProgress]');
    return;
  }

  const prog = programsCache.find(p => String(p.id) === String(programId));
  if (prog) prog.progress = pct;

  return pct;
}
function buildProgramCard(p) {
  const status = calcProgramStatus(p);
 const pct = calcProgramProgress(p.id);
  const inds   = p.indicators || indicatorsCache[p.id] || indicatorsCache[String(p.id)] || [];

  /* ألوان الهوية الجديدة بدل الأخضر */
  const clr =
    pct >= 90 ? '#2F5F8F' :   // أزرق رئيسي
    pct >= 60 ? '#7C83FD' :   // موف
    pct >= 30 ? '#F3A6C8' :   // وردي
                '#C9D9EA';    // أزرق فاتح

  const total = inds.length;

  const done = inds.filter(ind => {
    const completed = ind.is_completed === true || ind.is_completed === 'true';
    const hasEvidence = evidencesCache.some(ev =>
      String(ev.program_id) === String(p.id) &&
      String(ev.indicator_id) === String(ind.id)
    );
    return completed && hasEvidence;
  }).length;

  const indsHtml = total
    ? inds.map(ind => {
        const d = ind.is_completed === true || ind.is_completed === 'true';

        return `
          <div class="indicator-row" id="irow-${ind.id}">
            <button class="ind-toggle" ${can('toggleIndicator') && !isYearReadOnlyMode() ? `onclick="handleToggle('${p.id}','${ind.id}')"` : ''}
              title="${d ? 'إلغاء الإنجاز' : 'وضع علامة مكتمل'}">${d ? '✅' : '⬜'}</button>

            <span class="ind-text" style="${d ? 'text-decoration:line-through;color:var(--text-muted)' : ''}">
              ${esc(ind.indicator_text)}
            </span>

            ${can('deleteIndicator') && !isYearReadOnlyMode() ? `<button class="ind-delete" onclick="handleDelInd('${p.id}','${ind.id}')">×</button>` : ''}
          </div>
        `;
      }).join('')
    : '<div style="font-size:12px;color:var(--text-muted);padding:4px 0">لا توجد مؤشرات بعد</div>';

  const addIndHtml = can('addIndicator') && !isYearReadOnlyMode()
    ? `<div class="add-indicator-row">
        <input id="iinput-${p.id}" class="ind-input" type="text" placeholder="أضف مؤشر إنجاز…"
               onkeydown="if(event.key==='Enter')handleAddInd('${p.id}')"/>
        <button class="btn-sm btn-evidence" onclick="handleAddInd('${p.id}')">+</button>
      </div>`
    : '';

 const editBtn = can('editProgram') && !isYearReadOnlyMode()
  ? `<button class="btn-sm btn-edit" onclick="event.stopPropagation(); openProgramModal('${p.id}')">✏️ تعديل</button>`
  : '';

 const delBtn = can('deleteProgram') && !isYearReadOnlyMode()
  ? `<button class="btn-sm btn-delete" onclick="event.stopPropagation(); deleteProgram('${p.id}')">🗑️ حذف</button>`
  : '';

  return `
  <div class="program-card status-${esc(status)}" id="pcard-${esc(p.id)}">
    <div class="program-card-header">
      <div class="program-card-title">${esc(p.name)}</div>
      <span class="badge ${SB[status]}">${SI[status]} ${SL[status]}</span>
    </div>

    <div class="program-card-body">
      ${p.desc ? `<div class="program-card-desc">${esc(p.desc)}</div>` : ''}

      <div class="program-meta-grid">
        <div class="program-meta-item">👩‍🏫 <strong>${esc(p.resp || '—')}</strong></div>
        <div class="program-meta-item">🎯 <strong>${esc(p.target || '—')}</strong></div>
        <div class="program-meta-item">📅 <strong>${fmtDate(p.start)}</strong></div>
        <div class="program-meta-item">🏁 <strong>${fmtDate(p.end)}</strong></div>
      </div>

      <div class="program-progress-section">
        <div class="program-progress-label">
          <span id="plbl-${p.id}">نسبة الإنجاز${total ? ` (${done}/${total} مؤشر)` : ''}</span>
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
    </div>

    <div class="program-card-actions">
      <button class="btn-sm btn-detail" onclick="event.stopPropagation(); viewProgramDetail('${p.id}')">👁️ التفاصيل</button>
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
  try { assertYearWritable(); } catch { return; }
  ['prog-edit-id','prog-name','prog-resp','prog-desc','prog-target',
   'prog-start','prog-end','prog-progress','prog-status','prog-status-display'].forEach(fid => {
    const e = document.getElementById(fid); if (e) e.value='';
  });
  const ti = document.getElementById('program-modal-title');
  if (ti) ti.textContent = 'إضافة برنامج جديد';
  if (id) {
   const p = programsCache.find(x => String(x.id) === String(id)); if (!p) {
  showToast('لم يتم العثور على البرنامج','error');
  return;
}
    const sv = (fid,v) => { const e=document.getElementById(fid); if(e) e.value=v??''; };
    sv('prog-edit-id',p.id); sv('prog-name',p.name); sv('prog-resp',p.resp);
    sv('prog-desc',p.desc); sv('prog-target',p.target);
    sv('prog-start',p.start); sv('prog-end',p.end); sv('prog-progress',p.progress??0);
    if (ti) ti.textContent = 'تعديل البرنامج';
    autoCalcProgStatus();
  }
  refreshHijriPreview('prog-start');
  refreshHijriPreview('prog-end');
  openModal('program-modal');
}
function calcProgramStatus(p) {
  const today = new Date();
  today.setHours(0,0,0,0);

  const s = p.start ? parseISODateOnly(p.start) : null;
  const e = p.end ? parseISODateOnly(p.end) : null;
  const pct = p.id ? calcProgramProgress(p.id) : (parseInt(p.progress) || 0);

  if (pct >= 100) return 'done';
  if (!s || today < s) return 'planning';
  if (e && today > e) return 'late';

  return 'active';
}
window.calcProgramStatus = calcProgramStatus;
async function saveProgram() {
  if (!requireAuth(document.getElementById('prog-edit-id')?.value ? 'editProgram' : 'addProgram')) return;
  try { assertYearWritable(); } catch { return; }
  const editId = document.getElementById('prog-edit-id')?.value;
  if (editId  && !can('editProgram')) { showToast('ليس لديك صلاحية تعديل البرامج','error'); return; }
  if (!editId && !can('addProgram'))  { showToast('ليس لديك صلاحية إضافة برامج','error');   return; }
  const g = id => (document.getElementById(id)?.value||'');
  const name = clampInput(g('prog-name')); if (!name) { showToast('يرجى إدخال اسم البرنامج','error'); return; }
  const p = {
    id:editId||null, name, resp:clampInput(g('prog-resp')),
    desc:clampInput(g('prog-desc'), 1000), target:clampInput(g('prog-target')),
    start:g('prog-start'), end:g('prog-end'),
    progress:Math.min(100, Math.max(0, parseInt(g('prog-progress'))||0)), evidence:[], indicators:[],
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
      const yearId = await requireWritableSchoolYearId();
      if (yearId == null || yearId === undefined) {
        showToast(NO_ACTIVE_YEAR_MSG, 'error');
        return;
      }
      p.school_year_id = yearId;
      saved = await sbInsertProgram(p);
      saved.indicators = []; saved.evidence = [];
      programsCache.push(saved);
    }
    closeModal('program-modal');
    renderPrograms();
    showToast(editId?'تم تعديل البرنامج ✅':'تمت إضافة البرنامج ✅','success');
  } catch (err) {
    console.error('[saveProgram]', err.message || err);
    showToast(arabicDbError(err), 'error');
  } finally {
    if (btn) { btn.disabled=false; btn.textContent='💾 حفظ البرنامج'; }
  }
}
window.saveProgram = saveProgram;
window.sbInsertProgram = sbInsertProgram;

async function deleteProgram(id) {
  if (!can('deleteProgram')) { showToast('ليس لديك صلاحية حذف البرامج','error'); return; }
  try { assertYearWritable(); } catch { return; }
  if (!confirm('حذف هذا البرنامج وجميع مؤشراته؟')) return;
  try {
    await sbDeleteProgram(id);
    programsCache = programsCache.filter(p => p.id !== id);
    evidencesCache = evidencesCache.filter(e => e.program_id !== id);
    renderPrograms();
    showToast('تم حذف البرنامج 🗑️','warning');
  } catch (err) { console.error('[deleteProgram]', err.message); showToast(arabicDbError(err),'error'); }
}

/* ─────────────────────────────────────────────────────────────
   §23  PROGRAM DETAIL MODAL
   ───────────────────────────────────────────────────────────── */
function viewProgramDetail(id) {
  const p = programsCache.find(x => String(x.id) === String(id));
  if (!p) {
    showToast('لم يتم العثور على البرنامج', 'error');
    return;
  }

  _openProgramDetailId = p.id;

  const status = calcProgramStatus(p);
  const pct = parseInt(p.progress) || calcProgramProgress(p.id) || 0;
  const clr = pct >= 90 ? '#27ae60' : pct >= 60 ? '#2e86c1' : pct >= 30 ? '#f39c12' : '#e74c3c';
  const inds = indicatorsCache[id] || indicatorsCache[String(id)] || p.indicators || [];
  // كل شواهد البرنامج — من cache الموثوق أو من p.evidence
  const fromCache = evidencesCache.filter(e => String(e.program_id) === String(id));
  const fromProg = Array.isArray(p.evidence) ? p.evidence.filter(e => String(e.program_id) === String(id) || e.program_id == null) : [];
  const byId = new Map();
  [...fromCache, ...fromProg].forEach(ev => {
    if (ev && ev.id != null) byId.set(String(ev.id), ev);
  });
  const evs = Array.from(byId.values());

  const indicatorIdSet = new Set(inds.map(ind => String(ind.id)));
  const generalEvs = evs.filter(ev => {
    if (ev.indicator_id == null || ev.indicator_id === '') return true;
    return !indicatorIdSet.has(String(ev.indicator_id));
  });

  console.info('[UI] evidencesCache=', evidencesCache.length,
    'program', String(id), 'evs=', evs.length,
    'indicators=', inds.length, 'general=', generalEvs.length);

  const ti = document.getElementById('detail-modal-title');
  if (ti) ti.textContent = p.name;

  const indicatorsBlock = inds.length
    ? inds.map(ind => {
        const linked = evs.filter(ev =>
          ev.indicator_id != null &&
          ev.indicator_id !== '' &&
          String(ev.indicator_id) === String(ind.id)
        );
        return `
      <div class="indicator-detail-box">
        <div style="font-weight:700;margin-bottom:8px">
          ${esc(ind.indicator_text || ind.text || ind.name || ind.id)}
          ${ind.is_completed === true || ind.is_completed === 'true' ? ' ✅' : ' ◻️'}
        </div>
        <div class="evidence-list-detail" style="display:flex;flex-direction:column;gap:8px">
          ${linked.length
            ? linked.map(ev => buildEvidenceItemHtml(ev, { showDelete: true, programId: p.id })).join('')
            : `<div style="color:#888;font-size:13px">لا توجد شواهد مرتبطة بهذا المؤشر</div>`
          }
        </div>
      </div>`;
      }).join('')
    : '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">لا توجد مؤشرات</p>';

  const generalBlock = `
    <div class="detail-section">
      <h4>📎 شواهد عامة للبرنامج</h4>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${generalEvs.length
          ? generalEvs.map(ev => buildEvidenceItemHtml(ev, { showDelete: true, programId: p.id })).join('')
          : '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">لا توجد شواهد عامة (بدون مؤشر أو غير مطابقة لمؤشر حالي).</p>'
        }
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:8px">إجمالي شواهد البرنامج المعروضة: ${evs.length}</div>
    </div>`;

  const body = document.getElementById('program-detail-body');
  if (!body) {
    showToast('تعذّر عرض التفاصيل', 'error');
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
        <div class="detail-item"><div class="detail-item-label">المسؤول</div><div class="detail-item-value">${esc(p.resp || '—')}</div></div>
        <div class="detail-item"><div class="detail-item-label">الفئة المستهدفة</div><div class="detail-item-value">${esc(p.target || '—')}</div></div>
        <div class="detail-item"><div class="detail-item-label">تاريخ البدء</div><div class="detail-item-value">${esc(fmtDate(p.start))}</div></div>
        <div class="detail-item"><div class="detail-item-label">تاريخ الانتهاء</div><div class="detail-item-value">${esc(fmtDate(p.end))}</div></div>
      </div>
      ${p.desc ? `<div style="margin-top:12px;padding:12px 14px;background:var(--bg);border-radius:8px;font-size:13px;line-height:1.7">${esc(p.desc)}</div>` : ''}
    </div>
    <div class="detail-section">
      <h4>📌 المؤشرات مع الشواهد المرتبطة</h4>
      ${indicatorsBlock}
    </div>
    ${generalBlock}
  `;
  console.info('[UI] program detail rendered items=', evs.length);
  openModal('program-detail-modal');
}

/* ─────────────────────────────────────────────────────────────
   §24  INDICATORS HANDLERS
   ───────────────────────────────────────────────────────────── */
async function handleAddInd(progId) {
  if (!can('addIndicator')) { showToast('ليس لديك صلاحية إضافة مؤشرات','error'); return; }
  try { assertYearWritable(); } catch { return; }
  const inp = document.getElementById('iinput-'+progId); if (!inp) return;
  const txt = clampInput(inp.value); if (!txt) { showToast('أدخل نص المؤشر أولاً','error'); return; }
  inp.disabled = true;
  try {
    await sbAddIndicator(progId, txt);
    inp.value = '';
    repaintCard(progId);
    showToast('تمت إضافة المؤشر ✅','success');
  } catch (err) { console.error('[handleAddInd]',err.message); showToast(arabicDbError(err),'error'); }
  finally { inp.disabled = false; inp.focus(); }
}

async function handleToggle(progId, indId) {
  if (!requireAuth('toggleIndicator')) return;
  try { assertYearWritable(); } catch { return; }
  if (currentUser?.role === 'teacher') {
    const prog = programsCache.find(p => String(p.id) === String(progId));

    if (prog?.resp && prog.resp !== currentUser.name) {
      showToast('لا يمكنك تعديل مؤشرات برنامج ليس مرتبطًا بك', 'error');
      return;
    }
  }

  try {
    const ind = (indicatorsCache[progId] || []).find(
      i => String(i.id) === String(indId)
    );

    if (!ind) {
      showToast('لم يتم العثور على المؤشر', 'error');
      return;
    }

    const newValue = !(ind.is_completed === true || ind.is_completed === 'true' || ind.is_completed === 1);

    const { error } = await sb
      .from('program_indicators')
      .update({ is_completed: newValue })
      .eq('id', indId);

    if (error) throw error;

    await fetchIndicators();
    await fetchEvidences();

    if (typeof syncProgress === 'function') {
      await syncProgress(progId);
    }

    renderPrograms();
    renderDashboard();

    showToast(newValue ? 'تم إنجاز المؤشر ✅' : 'تم إلغاء إنجاز المؤشر', 'success');

  } catch (err) {
    console.error('[handleToggle]', err.message);
    showToast(arabicDbError(err), 'error');
  }
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
if (barEl) {
  barEl.style.width = pct + '%';
  barEl.style.background = clr;
}
 if (lblEl) {
  lblEl.textContent = total
    ? 'نسبة الإنجاز (' + done + '/' + total + ' مؤشر)'
    : 'نسبة الإنجاز';
}
  const card = document.getElementById('pcard-'+progId);
  if (card) {
    card.className = 'program-card status-'+calcProgramStatus(p);
    const b = card.querySelector('.badge'); const s = calcProgramStatus(p);
    if (b) { b.className='badge '+SB[s]; b.textContent=SI[s]+' '+SL[s]; }
  }
  const listEl = document.getElementById('ilist-'+progId); if (!listEl) return;
  if (!inds.length) { listEl.innerHTML='<div style="font-size:12px;color:var(--text-muted);padding:4px 0">لا توجد مؤشرات بعد</div>'; return; }
 listEl.innerHTML = inds.map(ind =>
  '<div class="indicator-row">' +
  '<span>' + esc(ind.indicator_text || ind.text || '') + '</span>' +
  '</div>'
).join('');
}

/* ─────────────────────────────────────────────────────────────
   §25  EVIDENCE MODAL
   ───────────────────────────────────────────────────────────── */
const getEvIcon = t => {
  const key = String(t || '').toLowerCase();
  if (key.includes('drive') || key.includes('رابط')) return '☁️';
  if (key.includes('pdf')) return '📄';
  if (key.includes('word') || key.includes('doc')) return '📝';
  if (key.includes('excel') || key.includes('xls')) return '📊';
  if (key.includes('صورة') || key.includes('image') || key.includes('jpg') || key.includes('png')) return '🖼️';
  if (key.includes('file') || key.includes('ملف')) return '📎';
  return '📎';
};
const getEvidenceIcon = getEvIcon;

function getEvidenceSource(prefix) {
  const checked = document.querySelector(`input[name="${prefix}-source"]:checked`);
  return checked?.value || 'file';
}

function toggleEvidenceSource(prefix) {
  const source = getEvidenceSource(prefix);
  const fileGroup = document.getElementById(`${prefix}-file-group`);
  const linkGroup = document.getElementById(`${prefix}-link-group`);
  if (fileGroup) fileGroup.classList.toggle('hidden', source !== 'file');
  if (linkGroup) linkGroup.classList.toggle('hidden', source !== 'drive');
  if (source !== 'file') {
    pendingEvidenceFile = null;
    const input = document.getElementById(`${prefix}-file-input`);
    if (input) input.value = '';
    const prev = document.getElementById(`${prefix}-file-preview`);
    if (prev) { prev.classList.add('hidden'); prev.innerHTML = ''; }
  }
  if (source !== 'drive') {
    const link = document.getElementById(`${prefix}-link`);
    if (link) link.value = '';
  }
}

function evidenceTypeFromFileName(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'PDF';
  if (ext === 'doc' || ext === 'docx') return 'Word';
  if (ext === 'xls' || ext === 'xlsx') return 'Excel';
  if (['jpg','jpeg','png'].includes(ext)) return 'صورة';
  return 'ملف';
}

/** امتداد مسموح فقط من اسم الملف الأصلي (للتخزين والعرض). */
function getAllowedEvidenceExtension(fileName) {
  const ext = (String(fileName || '').split('.').pop() || '').toLowerCase();
  return ALLOWED_EVIDENCE_EXT.includes(ext) ? ext : null;
}

/**
 * مفتاح Storage آمن وفريد:
 * {auth.uid()}/{timestamp}-{random}.{ext}
 * بلا اسم عربي أو اسم مستخدم داخل المسار.
 */
function buildEvidenceStorageObjectKey(userId, fileName) {
  const uid = String(userId || '').trim();
  if (!uid) throw new Error('يجب تسجيل الدخول أولاً');
  const ext = getAllowedEvidenceExtension(fileName);
  if (!ext) throw new Error('نوع الملف غير مسموح');
  let rand = '';
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      rand = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    }
  } catch {}
  if (!rand) rand = Math.random().toString(36).slice(2, 14);
  return `${uid}/${Date.now()}-${rand}.${ext}`;
}

async function removeUploadedEvidenceObject(path) {
  if (!sb || !path) return;
  try {
    const key = String(path).replace(/^\/+/, '').replace(/^evidences\//, '');
    if (!key || key.includes('..')) return;
    await sb.storage.from(EVIDENCE_BUCKET).remove([key]);
  } catch {
    /* تنظيف أفضل جهد — لا تُفشِل واجهة المستخدم بسبب الحذف */
  }
}

function handleEvidenceFileSelect(input, prefix) {
  const file = input.files?.[0];
  if (!file) {
    pendingEvidenceFile = null;
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    showToast('الملف أكبر من 10MB','error');
    input.value = '';
    pendingEvidenceFile = null;
    return;
  }
  if (!validateFileExtension(file.name, ALLOWED_EVIDENCE_EXT)) {
    showToast('نوع الملف غير مسموح. المسموح: PDF, JPG, JPEG, PNG, DOC, DOCX, XLS, XLSX','error');
    input.value = '';
    pendingEvidenceFile = null;
    return;
  }
  if (file.type && !ALLOWED_EVIDENCE_MIME.includes(file.type)) {
    showToast('نوع الملف غير مسموح','error');
    input.value = '';
    pendingEvidenceFile = null;
    return;
  }
  pendingEvidenceFile = file;
  const prev = document.getElementById(`${prefix}-file-preview`);
  if (!prev) return;
  prev.classList.remove('hidden');
  prev.innerHTML = `<span style="font-size:20px">${getFileIcon(file.name)}</span>
    <span class="file-name">${esc(file.name)}</span>
    <span style="font-size:11px;color:var(--text-muted)">${(file.size/1024).toFixed(0)} KB</span>
    <span class="file-remove" onclick="clearEvidenceFile('${prefix}')">✕</span>`;
}

function clearEvidenceFile(prefix) {
  pendingEvidenceFile = null;
  const input = document.getElementById(`${prefix}-file-input`);
  if (input) input.value = '';
  const prev = document.getElementById(`${prefix}-file-preview`);
  if (prev) { prev.classList.add('hidden'); prev.innerHTML = ''; }
}

async function uploadEvidenceToStorage(file, meta) {
  if (!sb) throw new Error('Supabase غير متصل');
  if (!currentUser?.id) throw new Error('يجب تسجيل الدخول أولاً');
  if (file.size > MAX_FILE_SIZE) throw new Error('الملف أكبر من 10MB');
  if (!validateFileExtension(file.name, ALLOWED_EVIDENCE_EXT)) {
    throw new Error('نوع الملف غير مسموح');
  }
  if (file.type && !ALLOWED_EVIDENCE_MIME.includes(file.type)) {
    throw new Error('نوع الملف غير مسموح');
  }

  // مفتاح ASCII آمن فقط — الاسم العربي يبقى في file_name للعرض
  const path = buildEvidenceStorageObjectKey(currentUser.id, file.name);

  const { error: upErr } = await sb.storage
    .from(EVIDENCE_BUCKET)
    .upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || undefined,
    });
  if (upErr) throw new Error('تعذّر رفع الملف');

  // مسار الكائن فقط — بدون getPublicUrl
  return {
    path,
    file_url: path,
    file_name: file.name,
    file_size: file.size,
  };
}

function extractEvidenceStoragePath(fileUrl) {
  if (!fileUrl) return null;
  const raw = String(fileUrl).trim();
  if (!raw) return null;
  // مسار نسبي داخل الـ bucket
  if (!/^https?:\/\//i.test(raw)) {
    return raw.replace(/^\/+/, '').replace(/^evidences\//, '');
  }
  try {
    const u = new URL(raw);
    const markers = [
      `/storage/v1/object/public/${EVIDENCE_BUCKET}/`,
      `/storage/v1/object/sign/${EVIDENCE_BUCKET}/`,
      `/storage/v1/object/authenticated/${EVIDENCE_BUCKET}/`,
    ];
    for (const m of markers) {
      const idx = u.pathname.indexOf(m);
      if (idx !== -1) return decodeURIComponent(u.pathname.slice(idx + m.length));
    }
  } catch {}
  return null;
}

async function resolveEvidenceViewUrl(ev) {
  if (!ev) return '';
  const drive = evidenceDriveLink(ev);
  const rawFile = ev.file_url != null ? String(ev.file_url).trim() : '';
  const storagePath = extractEvidenceStoragePath(rawFile);
  // ملف Storage: Signed URL فقط (لا تستخدم المسار النسبي كرابط عام)
  if (storagePath && sb && !/^https?:\/\//i.test(storagePath)) {
    const { data, error } = await sb.storage
      .from(EVIDENCE_BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SEC);
    if (!error && data?.signedUrl) return data.signedUrl;
  }
  // رابط http قديم محفوظ في file_url
  if (/^https?:\/\//i.test(rawFile)) {
    const safe = sanitizeUrl(rawFile);
    if (safe) return safe;
  }
  // Google Drive / رابط خارجي
  return drive;
}

function evidenceViewButtonHtml(ev) {
  if (!evidenceHasViewTarget(ev)) return '—';
  const id = esc(ev.id);
  const label = evidenceDriveLink(ev) && !ev.file_url ? 'فتح الرابط' : 'عرض الملف';
  return `<button type="button" class="btn-sm btn-view evidence-view-btn" onclick="openEvidenceFile('${id}')">${label}</button>`;
}

async function openEvidenceFile(evId) {
  if (!requireAuth()) return;
  const ev = evidencesCache.find(e => String(e.id) === String(evId));
  if (!ev) { showToast('الملف غير موجود', 'error'); return; }
  try {
    const url = await resolveEvidenceViewUrl(ev);
    if (!url) { showToast('تعذّر فتح الملف', 'error'); return; }
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (err) {
    console.error('[openEvidenceFile]');
    showToast('تعذّر فتح الملف', 'error');
  }
}
window.openEvidenceFile = openEvidenceFile;

function fillEvidenceIndicators(progId) {
  const sel = document.getElementById('ev-indicator-id');
  if (!sel) return;

  sel.innerHTML = '<option value="">اختر المؤشر</option>';

  const allIndicators = Array.isArray(indicatorsCache)
    ? indicatorsCache
    : Object.values(indicatorsCache || {}).flat();

  const relatedIndicators = allIndicators.filter(ind =>
    String(ind.program_id) === String(progId)
  );

  relatedIndicators.forEach(ind => {
    sel.innerHTML += '<option value="' + esc(ind.id) + '">' + esc(ind.indicator_text || ind.text || ind.id) + '</option>';
  });
}

function openEvidenceModal(progId, evId) {
  if (!can('addEvidence')) {
    showToast('ليس لديك صلاحية رفع الشواهد','error');
    return;
  }
  if (!evId) {
    try { assertYearWritable(); } catch { return; }
  }

  pendingEvidenceFile = null;
  pendingFileData = null;
  pendingImageData = null;

  const evProg = document.getElementById('ev-program-id');
  if (evProg) evProg.value = progId || '';

  const evEdit = document.getElementById('ev-edit-id');
  if (evEdit) evEdit.value = evId || '';

  const ps = document.getElementById('ev-program-select');
  if (ps) {
    ps.innerHTML = '<option value="">اختر البرنامج</option>';
    yearScopedRows(programsCache).forEach(p => {
      ps.innerHTML += `<option value="${esc(p.id)}">${esc(p.name)}</option>`;
    });
    ps.value = progId || '';
    ps.onchange = function () {
      const evProg2 = document.getElementById('ev-program-id');
      if (evProg2) evProg2.value = this.value;
      fillEvidenceIndicators(this.value);
    };
  }

  fillEvidenceIndicators(progId);

  const ti = document.getElementById('evidence-modal-title');
  if (ti) ti.textContent = evId ? 'تعديل شاهد' : 'إضافة شاهد';

  ['ev-title','ev-link','ev-person','ev-notes'].forEach(f => {
    const e = document.getElementById(f);
    if (e) e.value = '';
  });
  clearEvidenceFile('ev');

  const fileRadio = document.querySelector('input[name="ev-source"][value="file"]');
  if (fileRadio) fileRadio.checked = true;
  toggleEvidenceSource('ev');
  openModal('evidence-modal');
}

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ext==='pdf'?'📄':ext==='doc'||ext==='docx'?'📝':ext==='xls'||ext==='xlsx'?'📊':['jpg','jpeg','png'].includes(ext)?'🖼️':'📎';
}

async function saveEvidence() {
  if (!can('addEvidence')) { showToast('ليس لديك صلاحية رفع الشواهد','error'); return; }
  try { assertYearWritable(); } catch { return; }
  const g = id => (document.getElementById(id)?.value||'');
  const progId = g('ev-program-id') || g('ev-program-select');
  const indicatorId = g('ev-indicator-id');
  if (!indicatorId) {
    showToast('يرجى اختيار المؤشر المرتبط بالشاهد','error');
    return;
  }
  const title = clampInput(g('ev-title'));
  if (!title) { showToast('يرجى إدخال عنوان الشاهد','error'); return; }

  const source = getEvidenceSource('ev');
  let link = null;
  let fileMeta = null;
  let type = 'ملف';

  if (source === 'drive') {
    const rawLink = g('ev-link').trim();
    const safeLink = rawLink ? sanitizeUrl(rawLink) : '';
    if (!safeLink) {
      showToast('يرجى إدخال رابط Google Drive صالح','error');
      return;
    }
    link = safeLink;
    type = 'Google Drive';
  } else {
    if (!pendingEvidenceFile) {
      showToast('يرجى اختيار ملف واحد على الأقل من الجهاز','error');
      return;
    }
    type = evidenceTypeFromFileName(pendingEvidenceFile.name);
  }

  const btn = document.getElementById('ev-save-btn') || document.querySelector('#evidence-modal .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = source === 'file' ? 'جاري رفع الملف...' : 'جارٍ الحفظ…'; }

  try {
    const schoolYearId = await requireWritableSchoolYearId();
    if (source === 'file') {
      showToast('جاري رفع الملف...','info');
      fileMeta = await uploadEvidenceToStorage(pendingEvidenceFile, {
        schoolYearId,
        programId: progId || 'general',
        indicatorId: indicatorId || 'general',
      });
    }

    const ev = {
      id: null,
      title,
      type,
      program_id: progId || null,
      indicator_id: indicatorId,
      person: clampInput(g('ev-person')),
      date: new Date().toISOString().split('T')[0],
      link,
      notes: clampInput(g('ev-notes'), 1000),
      school_year_id: schoolYearId,
      file_url: fileMeta?.file_url || null,
      file_name: fileMeta?.file_name || null,
      file_size: fileMeta?.file_size ?? null,
    };

    const saved = await sbInsertEvidence(ev);
    // لا تغيّر is_completed للمعلمة؛ فقط admin/vice عبر toggleIndicator
    if (indicatorId && can('toggleIndicator')) {
      const list = indicatorsCache[progId] || indicatorsCache[String(progId)] || [];
      const ind = list.find(i => String(i.id) === String(indicatorId));
      if (ind) ind.is_completed = true;
      if (sb && ind) {
        await sb.from('program_indicators').update({ is_completed: true }).eq('id', indicatorId);
      }
    }
    pendingEvidenceFile = null;
    closeModal('evidence-modal');
    // المصدر الموثوق بعد الحفظ: إعادة الجلب ثم الرندر
    await refreshEvidenceViews(saved.program_id || progId);
    showToast('تم رفع الشاهد وحفظه بنجاح.','success');
  } catch (err) {
    if (fileMeta?.path) await removeUploadedEvidenceObject(fileMeta.path);
    console.error('[saveEvidence]');
    showToast(arabicDbError(err) || 'تعذّر حفظ الشاهد', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📎 حفظ الشاهد'; }
  }
}
window.toggleEvidenceSource = toggleEvidenceSource;
window.handleEvidenceFileSelect = handleEvidenceFileSelect;
window.clearEvidenceFile = clearEvidenceFile;
window.saveEvidence = saveEvidence;
window.openEvidenceModal = openEvidenceModal;

async function fetchIndicators() {
  if (!sb) return;

  const { data, error } = await sb
    .from('program_indicators')
    .select('*');

  if (error) {
    console.error('[fetchIndicators]');
    return;
  }

  indicatorsCache = {};

  (data || []).forEach(ind => {
    const pid = ind.program_id;
    if (pid == null) return;
    if (!indicatorsCache[pid]) indicatorsCache[pid] = [];
    indicatorsCache[pid].push(ind);
  });

  programsCache.forEach(p => {
    p.indicators = indicatorsCache[p.id] || indicatorsCache[String(p.id)] || [];
  });
}

async function handleDelEv(evId) {
  if (!can('deleteEvidence')) {
    showToast('ليس لديك صلاحية حذف الشواهد', 'error');
    return;
  }
  try { assertYearWritable(); } catch { return; }

  if (!confirm('حذف هذا الشاهد؟')) return;

  const target = evidencesCache.find(e => String(e.id) === String(evId));
  const affectedProg = target?.program_id || null;

  try {
    await sbDeleteEvidence(evId, target);
    await refreshEvidenceViews(affectedProg);
    showToast('تم حذف الشاهد 🗑️', 'warning');
  } catch (err) {
    console.error('[handleDelEv]');
    showToast(arabicDbError(err) || 'تعذّر حذف الشاهد', 'error');
  }
}

function deleteEvidence(id) {
  handleDelEv(id);
}
/* ─────────────────────────────────────────────────────────────
   §26  INITIATIVES SECTION
   ───────────────────────────────────────────────────────────── */
const GOAL_BADGE = {'تحسين التحصيل الدراسي':'badge-info','تعزيز الانضباط':'badge-warning','التنمية المهنية':'badge-purple','الشراكة المجتمعية':'badge-success','تعزيز الهوية الوطنية':'badge-secondary','متابعة الفاقد التعليمي':'badge-danger'};
const INI_STATUS_BADGE = {'منجزة':'badge-success','قيد التنفيذ':'badge-info','لم تبدأ':'badge-secondary','متأخرة':'badge-danger'};
const GOAL_MAP = {academic:'تحسين التحصيل الدراسي',discipline:'تعزيز الانضباط',professional:'التنمية المهنية',community:'الشراكة المجتمعية',identity:'تعزيز الهوية الوطنية'};

function filterPlan(v) { _planFilter=v; renderPlan(); }
function searchPlan(v) { _planSearch=v.toLowerCase(); renderPlan(); }

function renderPlan() {
  let data = yearScopedRows(initiativesCache);
  if (_planFilter!=='all'&&GOAL_MAP[_planFilter]) data=data.filter(i=>i.goal===GOAL_MAP[_planFilter]);
  if (_planSearch) data=data.filter(i=>(i.name+(i.goal||'')+(i.resp||'')+(i.desc||'')).toLowerCase().includes(_planSearch));
  const tbody = document.getElementById('plan-tbody'); if (!tbody) return;
  const canWrite = !isYearReadOnlyMode();
  tbody.innerHTML = data.length
    ? data.map((ini,idx) => `
        <tr><td>${idx+1}</td>
          <td><span class="badge ${GOAL_BADGE[ini.goal]||'badge-secondary'}">${esc(ini.goal||'—')}</span></td>
          <td style="font-weight:600">${esc(ini.name)}</td>
          <td>${esc(ini.resp||'—')}</td>
          <td>${esc(fmtDate(ini.start))}</td>
          <td>${esc(fmtDate(ini.end))}</td>
          <td><span class="badge ${INI_STATUS_BADGE[ini.status]||'badge-secondary'}">${esc(ini.status)}</span></td>
          <td><div class="progress-wrap"><div class="progress-bar" style="min-width:70px"><div class="progress-fill" style="width:${ini.progress||0}%"></div></div><span class="progress-text">${ini.progress||0}%</span></div></td>
          <td>${ini.link ? safeLinkHtml(ini.link, '📎 عرض', 'btn-sm btn-view') : '—'}</td>
          <td><div style="display:flex;gap:4px;flex-wrap:nowrap">
            ${canWrite && can('editInitiative')?`<button class="btn-sm btn-edit" onclick="openInitiativeModal('${ini.id}')">✏️</button>`:''}
            ${canWrite && can('deleteInitiative')?`<button class="btn-sm btn-delete" onclick="deleteInitiative('${ini.id}')">🗑️</button>`:''}
          </div></td>
        </tr>`).join('')
    : '<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-muted)">لا توجد مبادرات</td></tr>';
}

function openInitiativeModal(id) {
  if (id  && !can('editInitiative'))  { showToast('ليس لديك صلاحية تعديل المبادرات','error'); return; }
  if (!id && !can('addInitiative'))   { showToast('ليس لديك صلاحية إضافة مبادرات','error');   return; }
  try { assertYearWritable(); } catch { return; }
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
  refreshHijriPreview('ini-start');
  refreshHijriPreview('ini-end');
  openModal('initiative-modal');
}

async function saveInitiative() {
  try { assertYearWritable(); } catch { return; }
  const editId = document.getElementById('ini-edit-id')?.value;
  if (editId  && !can('editInitiative'))  { showToast('ليس لديك صلاحية تعديل المبادرات','error'); return; }
  if (!editId && !can('addInitiative'))   { showToast('ليس لديك صلاحية إضافة مبادرات','error');   return; }
  const g = id => (document.getElementById(id)?.value||'');
  const name = clampInput(g('ini-name')); if (!name) { showToast('يرجى إدخال اسم المبادرة','error'); return; }
  const iniLink = clampInput(g('ini-link'));
  const safeIniLink = iniLink ? sanitizeUrl(iniLink) : '';
  if (iniLink && !safeIniLink) { showToast('رابط الدليل غير صالح','error'); return; }
  const ini = {
    id:editId||null, goal:g('ini-goal'), name, desc:clampInput(g('ini-desc'), 1000),
    resp:clampInput(g('ini-resp')), start:g('ini-start'), end:g('ini-end'),
    status:g('ini-status'), progress:Math.min(100, Math.max(0, parseInt(g('ini-progress'))||0)), link:safeIniLink,
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
  } catch (err) { console.error('[saveInitiative]',err.message); showToast(arabicDbError(err),'error'); }
  finally { if(btn){ btn.disabled=false; btn.textContent='💾 حفظ المبادرة'; } }
}

async function deleteInitiative(id) {
  if (!can('deleteInitiative')) { showToast('ليس لديك صلاحية حذف المبادرات','error'); return; }
  try { assertYearWritable(); } catch { return; }
  if (!confirm('حذف هذه المبادرة؟')) return;
  try {
    await sbDeleteInitiative(id); renderPlan();
    showToast('تم الحذف 🗑️','warning');
  } catch (err) { console.error('[deleteInitiative]',err.message); showToast(arabicDbError(err),'error'); }
}

/* ─────────────────────────────────────────────────────────────
   §27  KPI SECTION
   ───────────────────────────────────────────────────────────── */
function getAllIndicators() {
  if (Array.isArray(indicatorsCache)) return indicatorsCache;
  return Object.values(indicatorsCache || {}).flat();
}

function calcSchoolKPI() {
  const programs = programsCache || [];
  const indicators = getAllIndicators();
  const evidences = evidencesCache || [];
  const tasks = tasksCache || [];
  const initiatives = initiativesCache || [];

  const avgProgress = programs.length
    ? Math.round(programs.reduce((s, p) => s + (Number(p.progress) || 0), 0) / programs.length)
    : 0;

  const completedPrograms = programs.filter(p => (Number(p.progress) || 0) >= 100).length;
  const programsRate = programs.length ? Math.round((completedPrograms / programs.length) * 100) : 0;

  const completedIndicators = indicators.filter(i => i.is_completed === true).length;
  const indicatorsRate = indicators.length ? Math.round((completedIndicators / indicators.length) * 100) : 0;

  const indicatorsWithEvidence = indicators.filter(ind =>
    evidences.some(ev =>
      String(ev.program_id) === String(ind.program_id) &&
      String(ev.indicator_id) === String(ind.id)
    )
  ).length;

  const evidenceRate = indicators.length ? Math.round((indicatorsWithEvidence / indicators.length) * 100) : 0;

  const doneTasks = tasks.filter(t => t.status === 'done' || t.status === 'completed').length;
  const tasksRate = tasks.length ? Math.round((doneTasks / tasks.length) * 100) : 0;

  const doneInitiatives = initiatives.filter(i => i.status === 'done' || i.status === 'completed').length;
  const initiativesRate = initiatives.length ? Math.round((doneInitiatives / initiatives.length) * 100) : 0;

  return [
    { name: 'متوسط إنجاز برامج المدرسة', pct: avgProgress, details: `${programs.length} برنامج` },
    { name: 'البرامج المكتملة', pct: programsRate, details: `${completedPrograms} من ${programs.length}` },
    { name: 'تحقق مؤشرات البرامج', pct: indicatorsRate, details: `${completedIndicators} من ${indicators.length}` },
    { name: 'المؤشرات المدعومة بشواهد', pct: evidenceRate, details: `${indicatorsWithEvidence} من ${indicators.length}` },
    { name: 'إنجاز المهام المدرسية', pct: tasksRate, details: `${doneTasks} من ${tasks.length}` },
    { name: 'تنفيذ المبادرات', pct: initiativesRate, details: `${doneInitiatives} من ${initiatives.length}` },
  ];
}

function renderKPI() {
  const data = calcSchoolKPI();

  const kc = document.getElementById('kpi-cards');
  if (kc) kc.innerHTML = data.map(k => {
    const clr = k.pct >= 90 ? '#27ae60' : k.pct >= 70 ? '#f39c12' : '#e74c3c';
    const deg = Math.round(k.pct * 3.6);

    return `
      <div class="kpi-card">
        <div class="kpi-card-name">${k.name}</div>
        <div class="kpi-circle" style="background: conic-gradient(${clr} ${deg}deg,#eaecee 0deg)">
          <div class="kpi-circle-inner">${k.pct}%</div>
        </div>
        <div class="kpi-values">${k.details}</div>
      </div>
    `;
  }).join('');

  const kt = document.getElementById('kpi-tbody');
  if (kt) kt.innerHTML = data.map(k => {
    const bc = k.pct >= 90 ? 'badge-success' : k.pct >= 70 ? 'badge-warning' : 'badge-danger';
    const bl = k.pct >= 90 ? 'ممتاز' : k.pct >= 70 ? 'يحتاج تحسين' : 'منخفض';

    return `
      <tr>
        <td style="font-weight:600">${k.name}</td>
        <td>${k.details}</td>
        <td>
          <div class="progress-wrap">
            <div class="progress-bar">
              <div class="progress-fill" style="width:${k.pct}%"></div>
            </div>
          </div>
        </td>
        <td><span class="badge ${bc}">${bl}</span></td>
        <td>مرتبط تلقائيًا بالبرامج</td>
      </tr>
    `;
  }).join('');
  
}
function openKpiModal(id) {
  if (!requireAuth()) return;
  if (!isSectionAllowed('kpi')) { showToast('ليس لديك صلاحية الوصول لمؤشرات الأداء', 'error'); return; }
  const ti=document.getElementById('kpi-modal-title'); if(ti) ti.textContent=id?'تعديل المؤشر':'إضافة مؤشر أداء';
  ['kpi-edit-id','kpi-name','kpi-target','kpi-achieved','kpi-unit'].forEach(fid=>{ const e=document.getElementById(fid); if(e) e.value=''; });
  if(id){ const k=kpiCache.find(x=>x.id===id); if(!k)return; const sv=(fid,v)=>{const e=document.getElementById(fid);if(e)e.value=v??'';}; sv('kpi-edit-id',k.id);sv('kpi-name',k.name);sv('kpi-target',k.target);sv('kpi-achieved',k.achieved);sv('kpi-unit',k.unit); }
  openModal('kpi-modal');
}

async function saveKPI() {
  if (!requireAuth()) return;
  if (!isSectionAllowed('kpi')) { showToast('ليس لديك صلاحية تعديل مؤشرات الأداء', 'error'); return; }
  const g=id=>(document.getElementById(id)?.value||'');
  const editId=g('kpi-edit-id');
  const name=clampInput(g('kpi-name')); if(!name){showToast('يرجى إدخال اسم المؤشر','error');return;}
  const item={id:editId||'k'+Date.now(),name,target:parseFloat(g('kpi-target'))||0,achieved:parseFloat(g('kpi-achieved'))||0,unit:g('kpi-unit').trim()||'%'};
  if(editId){const i=kpiCache.findIndex(x=>x.id===editId);if(i!==-1)kpiCache[i]=item;} else kpiCache.push(item);
  lsSave('kpi',kpiCache); closeModal('kpi-modal'); await refreshAll();
  showToast(editId?'تم التعديل ✅':'تمت الإضافة ✅','success');
}

function deleteKPI(id) {
  if (!requireAuth()) return;
  if (!isSectionAllowed('kpi')) { showToast('ليس لديك صلاحية حذف مؤشرات الأداء', 'error'); return; }
  if(!confirm('حذف هذا المؤشر؟'))return;
  kpiCache=kpiCache.filter(k=>k.id!==id); lsSave('kpi',kpiCache);
  renderKPI(); showToast('تم الحذف 🗑️','warning');
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = String(text).split(' ');
  let line = '';

  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && n > 0) {
      ctx.fillText(line, x, y);
      line = words[n] + ' ';
      y += lineHeight;
    } else {
      line = testLine;
    }
  }

  ctx.fillText(line, x, y);
}
/* ─────────────────────────────────────────────────────────────
   §28  TASKS SECTION
   ───────────────────────────────────────────────────────────── */
function filterTasks(v) { _taskFilter=v; renderTasks(); }
function filterTasksPriority(v) { _taskPriFilter=v; renderTasks(); }

function renderTasks() {
  let tasks = yearScopedRows(tasksCache);
  const today = new Date(); today.setHours(0,0,0,0);
  const canWrite = !isYearReadOnlyMode();

  if (currentUser?.role === 'teacher') {
    tasks = tasks.filter(t => t.resp && t.resp.includes(currentUser.name));
  }

  if (_taskFilter === 'late') {
    tasks = tasks.filter(t => {
      const due = t.due ? parseISODateOnly(t.due) : null;
      return t.status !== 'done' && due && due < today;
    });
  } else if (_taskFilter !== 'all') {
    tasks = tasks.filter(t => t.status === _taskFilter);
  }

  if (_taskPriFilter !== 'all') {
    tasks = tasks.filter(t => t.priority === _taskPriFilter);
  }

  const PL = { high:'عالية', medium:'متوسطة', low:'منخفضة' };
  const SL2 = { pending:'معلقة', inprogress:'قيد التنفيذ', done:'منجزة' };
  const SBM = { pending:'badge-warning', inprogress:'badge-info', done:'badge-success' };

  const grid = document.getElementById('tasks-grid');
  if (!grid) return;

  if (!tasks.length) {
    grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px">لا توجد مهام</p>';
    return;
  }

  grid.innerHTML = tasks.map(t => {
    const due = t.due ? parseISODateOnly(t.due) : null;
    const late = t.status !== 'done' && due && due < today;

    return `
      <div class="task-card priority-${t.priority}">
        <div class="task-card-header">
          <div class="task-title">${esc(t.name)}</div>
          <span class="badge ${late ? 'badge-danger' : SBM[t.status]}">
            ${late ? '⚠️ متأخرة' : SL2[t.status]}
          </span>
        </div>

        <div class="task-meta">
          <span>👩‍🏫 ${esc(t.resp || '—')}</span>
          <span>📅 ${esc(fmtDate(t.due))}</span>
          <span>🔴 ${esc(PL[t.priority] || t.priority)}</span>
          ${t.notes ? `<span>📝 ${esc(t.notes)}</span>` : ''}
        </div>

        <div class="task-actions">
          ${canWrite && can('editTask') ? `<select class="task-status-select" onchange="chgTaskStatus('${esc(t.id)}', this.value)">
            <option value="pending" ${t.status === 'pending' ? 'selected' : ''}>معلقة</option>
            <option value="inprogress" ${t.status === 'inprogress' ? 'selected' : ''}>قيد التنفيذ</option>
            <option value="done" ${t.status === 'done' ? 'selected' : ''}>منجزة</option>
          </select>` : `<span class="badge ${SBM[t.status]}">${SL2[t.status]}</span>`}
          ${canWrite && can('editTask') ? `<button class="btn-sm btn-edit" onclick="openTaskModal('${esc(t.id)}')">✏️</button>` : ''}
          ${canWrite && can('deleteTask') ? `<button class="btn-sm btn-delete" onclick="deleteTask('${esc(t.id)}')">🗑️</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function chgTaskStatus(id, status) {
  if (!requireAuth('editTask')) return;
  try { assertYearWritable(); } catch { return; }
  if (!['pending','inprogress','done'].includes(status)) {
    showToast('حالة غير صالحة','error');
    return;
  }
  try {
    await sbUpdateTaskStatus(id, status);
    renderTasks(); renderDashboard();
    showToast('تم تحديث الحالة ✅','success');
  } catch (err) {
    // إعادة رسم الواجهة بعد إرجاع tasksCache للحالة السابقة داخل sbUpdateTaskStatus
    renderTasks();
    renderDashboard();
    showToast(arabicDbError(err), 'error');
  }
}
function changeTaskStatus(id,s){ chgTaskStatus(id,s); }

function openTaskModal(id) {
  if (id  && !can('editTask')) { showToast('ليس لديك صلاحية تعديل المهام','error'); return; }
  if (!id && !can('addTask'))  { showToast('ليس لديك صلاحية إضافة مهام','error');   return; }
  try { assertYearWritable(); } catch { return; }
  const ti=document.getElementById('task-modal-title'); if(ti) ti.textContent=id?'تعديل المهمة':'إضافة مهمة جديدة';
  ['task-edit-id','task-name','task-resp','task-due','task-notes'].forEach(fid=>{const e=document.getElementById(fid);if(e)e.value='';});
  const pEl=document.getElementById('task-priority'); if(pEl) pEl.value='high';
  const sEl=document.getElementById('task-status');   if(sEl) sEl.value='pending';
  if (id) {
    const t=tasksCache.find(x=>x.id===id); if(!t)return;
    const sv=(fid,v)=>{const e=document.getElementById(fid);if(e)e.value=v??'';};
    sv('task-edit-id',t.id);sv('task-name',t.name);sv('task-resp',t.resp||'');sv('task-due',t.due||'');sv('task-priority',t.priority);sv('task-status',t.status);sv('task-notes',t.notes||'');
  }
  refreshHijriPreview('task-due');
  openModal('task-modal');
}

async function saveTask() {
  try { assertYearWritable(); } catch { return; }
  const editId=document.getElementById('task-edit-id')?.value;
  if (editId && !can('editTask')) { showToast('ليس لديك صلاحية تعديل المهام','error'); return; }
  if (!editId && !can('addTask')){ showToast('ليس لديك صلاحية إضافة مهام','error');   return; }
  const g=id=>(document.getElementById(id)?.value||'');
  const name=clampInput(g('task-name')); if(!name){showToast('يرجى إدخال اسم المهمة','error');return;}
  const pri=g('task-priority'); const st=g('task-status');
  const t={
    id:editId||null,
    name,
    resp:clampInput(g('task-resp')),
    due:g('task-due'),
    priority:['high','medium','low'].includes(pri)?pri:'medium',
    status:['pending','inprogress','done'].includes(st)?st:'pending',
    notes:clampInput(g('task-notes'),1000)
  };
  const btn=document.getElementById('task-save-btn');
  if(btn){btn.disabled=true;btn.textContent='جارٍ الحفظ…';}
  try {
    let saved;
    if(editId){ saved=await sbUpdateTask(t); } else { saved=await sbInsertTask(t); tasksCache.push(saved); }
    closeModal('task-modal'); renderTasks();
    showToast(editId?'تم التعديل ✅':'تمت الإضافة ✅','success');
  } catch(err){ console.error('[saveTask]',err.message); showToast(arabicDbError(err),'error'); }
  finally{ if(btn){btn.disabled=false;btn.textContent='💾 حفظ المهمة';} }
}

async function deleteTask(id) {
  if(!can('deleteTask')){showToast('ليس لديك صلاحية حذف المهام','error');return;}
  try { assertYearWritable(); } catch { return; }
  if(!confirm('حذف هذه المهمة؟'))return;
  try{ await sbDeleteTask(id); renderTasks(); showToast('تم الحذف 🗑️','warning'); }
  catch(err){ console.error('[deleteTask]',err.message); showToast(arabicDbError(err),'error'); }
}

/* ─────────────────────────────────────────────────────────────
   §29  REPORTS SECTION
   ───────────────────────────────────────────────────────────── */
function openReportModal() {
  if (!requireAuth('addEvidence')) return;
  try { assertYearWritable(); } catch { return; }
  pendingEvidenceFile = null;
  const sel = document.getElementById('rep-program-id');
  const yearPrograms = yearScopedRows(programsCache);

  if (sel) {
    sel.innerHTML = '<option value="">— اختر البرنامج —</option>' +
      yearPrograms.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');

    sel.onchange = function () {
      fillReportIndicators(this.value);
    };
  }

  const indSel = document.getElementById('rep-indicator-id');
  if (indSel) {
    indSel.innerHTML = '<option value="">اختر المؤشر</option>';
  }

  ['rep-edit-id','rep-title','rep-link','rep-notes'].forEach(f => {
    const e = document.getElementById(f);
    if (e) e.value = '';
  });
  clearEvidenceFile('rep');

  const pe = document.getElementById('rep-person');
  if (pe) pe.value = currentUser?.name || '';

  const fileRadio = document.querySelector('input[name="rep-source"][value="file"]');
  if (fileRadio) fileRadio.checked = true;
  toggleEvidenceSource('rep');

  openModal('report-modal');
}
function fillReportIndicators(progId) {
  const sel = document.getElementById('rep-indicator-id');
  if (!sel) return;

  sel.innerHTML = '<option value="">اختر المؤشر</option>';

  const allIndicators = Object.values(indicatorsCache).flat();

  const list = allIndicators.filter(ind =>
    String(ind.program_id) === String(progId)
  );

  list.forEach(ind => {
    sel.innerHTML += `<option value="${esc(ind.id)}">${esc(ind.indicator_text)}</option>`;
  });
}
function renderReports() {
  const TI={'صورة':'📷','PDF':'📄','Word':'📝','Excel':'📊','Google Drive':'☁️','ملف':'📎','YouTube':'🎥','رابط خارجي':'🔗'};
  const tbody=document.getElementById('reports-tbody'); if(!tbody)return;

  const rows = yearScopedRows(evidencesCache);
  const yearPrograms = yearScopedRows(programsCache);
  const canWrite = !isYearReadOnlyMode();

  console.info('[UI] renderReports evidencesCache=', evidencesCache.length,
    'selectedYear=', selectedSchoolYearId ? '(set)' : '(none)', 'rendered=', rows.length);

  tbody.innerHTML = rows.length
    ? rows.map((r,i)=>{
        const title = r.title || r.file_name || 'شاهد';
        const typeLabel = r.type || (r.file_name ? evidenceTypeFromFileName(r.file_name) : '—');
        const pName = r.program_id != null
          ? (yearPrograms.find(p => String(p.id) === String(r.program_id))?.name
            || programsCache.find(p => String(p.id) === String(r.program_id))?.name || '—')
          : '—';
        return`<tr><td>${i+1}</td><td style="font-weight:600">${esc(title)}</td>
          <td><span class="badge badge-info">${TI[typeLabel]||getEvIcon(typeLabel||r.file_name)} ${esc(typeLabel||'—')}</span></td>
          <td>${esc(pName)}</td><td>${esc(r.person||'—')}</td><td>${esc(fmtDate(r.date || r.created_at))}</td>
          <td>${evidenceViewButtonHtml(r)}</td>
          <td>${canWrite && can('deleteEvidence')?`<button class="btn-sm btn-delete" onclick="handleDelEv('${esc(r.id)}')">🗑️</button>`:''}</td></tr>`;
      }).join('')
    : '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">لا توجد شواهد</td></tr>';
}

async function saveReport() {
  if (!requireAuth('addEvidence')) return;
  try { assertYearWritable(); } catch { return; }
  const g = id => (document.getElementById(id)?.value || '');
  const title = clampInput(g('rep-title'));
  if (!title) { showToast('يرجى إدخال عنوان الشاهد','error'); return; }

  const progId = g('rep-program-id');
  const indicatorId = g('rep-indicator-id');
  const person = clampInput(g('rep-person')) || currentUser?.name || '';
  const source = getEvidenceSource('rep');

  let link = null;
  let fileMeta = null;
  let type = 'ملف';

  if (source === 'drive') {
    const rawLink = g('rep-link').trim();
    const safeLink = rawLink ? sanitizeUrl(rawLink) : '';
    if (!safeLink) {
      showToast('يرجى إدخال رابط Google Drive صالح','error');
      return;
    }
    link = safeLink;
    type = 'Google Drive';
  } else {
    if (!pendingEvidenceFile) {
      showToast('يرجى اختيار ملف واحد على الأقل من الجهاز','error');
      return;
    }
    type = evidenceTypeFromFileName(pendingEvidenceFile.name);
  }

  const btn = document.getElementById('rep-save-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = source === 'file' ? 'جاري رفع الملف...' : 'جارٍ الحفظ…';
  }

  try {
    const schoolYearId = await requireWritableSchoolYearId();
    if (source === 'file') {
      showToast('جاري رفع الملف...','info');
      fileMeta = await uploadEvidenceToStorage(pendingEvidenceFile, {
        schoolYearId,
        programId: progId || 'general',
        indicatorId: indicatorId || 'general',
      });
    }

    const ev = {
      id: null,
      title,
      type,
      program_id: progId || null,
      indicator_id: indicatorId || null,
      person,
      date: new Date().toISOString().split('T')[0],
      link,
      notes: clampInput(g('rep-notes'), 1000),
      school_year_id: schoolYearId,
      file_url: fileMeta?.file_url || null,
      file_name: fileMeta?.file_name || null,
      file_size: fileMeta?.file_size ?? null,
    };

    const saved = await sbInsertEvidence(ev);
    pendingEvidenceFile = null;
    closeModal('report-modal');
    await refreshEvidenceViews(saved.program_id || progId);
    showToast('تم رفع الشاهد وحفظه بنجاح.','success');
  } catch (err) {
    if (fileMeta?.path) await removeUploadedEvidenceObject(fileMeta.path);
    console.error('[saveReport]');
    showToast(arabicDbError(err) || 'تعذّر حفظ الشاهد', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📤 رفع الشاهد'; }
  }
}
window.openReportModal = openReportModal;
window.saveReport = saveReport;

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
            <input type="text" id="tlink-name" value="${esc(currentUser?.name||'')}" readonly style="background:#f8f9fa"/>
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
  const canWrite = !isYearReadOnlyMode();
  const visible = yearScopedRows(teachersCache).filter(t => t.name && !t.name.toLowerCase().includes('admin'));
  sec.innerHTML = `
    <div class="section-top">
      <h2>متابعة المعلمات</h2>
      ${canWrite && can('addTeacher')?`<button class="btn-primary" id="btn-add-teacher" onclick="openTeacherModal()">+ إضافة سجل متابعة</button>`:''}
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
      ? `${safeLinkHtml(t.driveLink, '🔗 فتح', 'btn-sm btn-view')}${t.createdBy ? `<div style="font-size:10px;color:var(--text-muted);margin-top:3px">${esc(t.createdBy)}</div>` : ''}`
      : '<span style="color:#ccc">—</span>';
    return `<tr><td style="font-weight:700">${esc(t.name)}</td>
      <td style="text-align:center">${t.assigned}</td>
      <td style="text-align:center">${t.done}</td>
      <td><div class="progress-wrap"><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div><span class="progress-text">${pct}%</span></div></td>
      <td>${linkCell}</td>
      <td>${esc(fmtDate(t.lastReport))}</td>
      <td style="font-size:13px">${t.notes ? esc(t.notes) : '<span style="color:#ccc">—</span>'}</td>
      <td><div style="display:flex;gap:4px">
        ${canWrite && can('editTeacher')?`<button class="btn-sm btn-edit" onclick="openTeacherModal('${t.id}')">✏️</button>`:''}
        ${canWrite && can('deleteTeacher')?`<button class="btn-sm btn-delete" onclick="deleteTeacher('${t.id}')">🗑️</button>`:''}
      </div></td></tr>`;
  }).join('') : '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">لا توجد سجلات متابعة</td></tr>';
}

// إرسال رابط Drive من حساب المعلمة (إضافة فقط)
async function submitTeacherLink() {
  if (!requireAuth('addTeacherLink')) return;
  try { assertYearWritable(); } catch { return; }
  const g = id => (document.getElementById(id)?.value||'').trim();
  const title = clampInput(g('tlink-title'));
  const url = g('tlink-url');
  const safeUrl = sanitizeUrl(url);
  if (!title) { showToast('يرجى إدخال عنوان مختصر','error'); return; }
  if (!url || !safeUrl) { showToast('يرجى إدخال رابط Drive صالح (https)','error'); return; }
  const btn = document.getElementById('tlink-btn');
  if (btn) { btn.disabled=true; btn.textContent='جارٍ الإرسال…'; }
  try {
    const tf = {
      id:null, name:currentUser.name, assigned:0, done:0, lastReport:'',
      notes:title, driveLink:safeUrl, createdBy:currentUser.name,
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
  try { assertYearWritable(); } catch { return; }
  const ti=document.getElementById('teacher-modal-title'); if(ti) ti.textContent=id?'تعديل سجل المتابعة':'إضافة سجل متابعة معلمة';
  ['tf-edit-id','tf-name','tf-assigned','tf-done','tf-last-report','tf-notes','tf-link'].forEach(fid=>{const e=document.getElementById(fid);if(e)e.value='';});
  if(id){
    const tf=teachersCache.find(x=>x.id===id); if(!tf)return;
    const sv=(fid,v)=>{const e=document.getElementById(fid);if(e)e.value=v??'';};
    sv('tf-edit-id',tf.id);sv('tf-name',tf.name);sv('tf-assigned',tf.assigned||0);
    sv('tf-done',tf.done||0);sv('tf-last-report',tf.lastReport||'');sv('tf-notes',tf.notes||'');
    sv('tf-link',tf.driveLink||'');
  }
  refreshHijriPreview('tf-last-report');
  openModal('teacher-modal');
}

async function saveTeacher() {
  try { assertYearWritable(); } catch { return; }
  const editId=document.getElementById('tf-edit-id')?.value;
  if (editId && !requireAuth('editTeacher')) return;
  if (!editId && !requireAuth('addTeacher')) return;
  const g=id=>(document.getElementById(id)?.value||'');
  const name=clampInput(g('tf-name')); if(!name){showToast('يرجى إدخال اسم المعلمة','error');return;}
  const existing = editId ? teachersCache.find(x=>x.id===editId) : null;
  const tfLink = clampInput(g('tf-link'));
  const safeTfLink = tfLink ? sanitizeUrl(tfLink) : '';
  if (tfLink && !safeTfLink) { showToast('رابط Drive غير صالح','error'); return; }
  const tf={
    id:editId||null, name,
    assigned:Math.max(0, parseInt(g('tf-assigned'))||0), done:Math.max(0, parseInt(g('tf-done'))||0),
    lastReport:g('tf-last-report'), notes:clampInput(g('tf-notes'), 1000),
    driveLink:safeTfLink, createdBy:existing?.createdBy||currentUser?.name||'',
  };
  const btn=document.getElementById('tf-save-btn');
  if(btn){btn.disabled=true;btn.textContent='جارٍ الحفظ…';}
  try{
    let saved;
    if(editId){ saved=await sbUpdateTeacher(tf); const i=teachersCache.findIndex(x=>x.id===saved.id); if(i!==-1)teachersCache[i]=saved; }
    else{ saved=await sbInsertTeacher(tf); teachersCache.push(saved); }
    closeModal('teacher-modal'); renderTeachers();
    showToast(editId?'تم التعديل ✅':'تمت الإضافة ✅','success');
  }catch(err){console.error('[saveTeacher]',err.message);showToast(arabicDbError(err),'error');}
  finally{if(btn){btn.disabled=false;btn.textContent='💾 حفظ';}}
}

async function deleteTeacher(id) {
  if(!can('deleteTeacher')){showToast('ليس لديك صلاحية حذف سجلات المتابعة','error');return;}
  try { assertYearWritable(); } catch { return; }
  if(!confirm('حذف سجل المتابعة؟ (لن يُحذف حساب المعلمة)'))return;
  try{
    await sbDeleteTeacher(id);
    renderTeachers();
    showToast('تم حذف سجل المتابعة 🗑️','warning');
  }catch(err){console.error('[deleteTeacher]',err.message);showToast(arabicDbError(err),'error');}
}

// Legacy aliases
function openTeacherNote(id){ openTeacherModal(id); }
function saveTeacherNote(){ saveTeacher(); }

/* ─────────────────────────────────────────────────────────────
   §31  DASHBOARD
   ───────────────────────────────────────────────────────────── */
function renderDashboard() {
  // §11: إخفاء admin من الإحصائيات
  const yearPrograms = yearScopedRows(programsCache);
  const yearTasks = yearScopedRows(tasksCache);
  const yearEvs = yearScopedRows(evidencesCache);
  const visTeachers = yearScopedRows(teachersCache).filter(t => t.name && !t.name.toLowerCase().includes('admin'));
  const today = new Date(); today.setHours(0,0,0,0);
  const total  = yearPrograms.length;
  const done   = yearPrograms.filter(p => calcProgramStatus(p)==='done').length;
  const avg = total
  ? Math.round(
      yearPrograms.reduce((s,p)=>s+calcProgramProgress(p.id),0)/total
    )
  : 0;
  const lateT  = yearTasks.filter(t=>{
    const due = t.due ? parseISODateOnly(t.due) : null;
    return t.status!=='done' && due && due < today;
  }).length;
  const totalEv= yearEvs.length;

  const dsEl = document.getElementById('dashboard-stats'); if (!dsEl) return;
  dsEl.innerHTML = `
    <div class="stat-card"><span class="stat-icon">🗂️</span><span class="stat-number">${total}</span><span class="stat-label">إجمالي البرامج</span></div>
    <div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${done}</span><span class="stat-label">برامج منتهية</span></div>
    <div class="stat-card gold"><span class="stat-icon">📊</span><span class="stat-number">${avg}%</span><span class="stat-label">متوسط الإنجاز</span></div>
    <div class="stat-card red"><span class="stat-icon">⏰</span><span class="stat-number">${lateT}</span><span class="stat-label">مهام متأخرة</span></div>
    <div class="stat-card purple"><span class="stat-icon">📎</span><span class="stat-number">${totalEv}</span><span class="stat-label">شواهد مرفوعة</span></div>
    <div class="stat-card teal"><span class="stat-icon">👩‍🏫</span><span class="stat-number">${visTeachers.length}</span><span class="stat-label">معلمات تحت المتابعة</span></div>`;

  const settings = {
    schoolName: settingsCache.school_name || DEFAULT_SETTINGS.schoolName,
    year: settingsCache.academic_year || DEFAULT_SETTINGS.year,
    principal: settingsCache.principal_name || DEFAULT_SETTINGS.principal,
    region: settingsCache.region || DEFAULT_SETTINGS.region,
  };
  const gEl = document.getElementById('dash-greeting');
  if (gEl) gEl.textContent = `${settings.schoolName||'منصة الخطة التشغيلية'}`;
  const subEl = document.getElementById('dash-subtitle');
  const y = getSelectedSchoolYear();
  const yearLabel = y ? (y.label_ar || y.name || settings.year || '') : (settings.year || '');
  if (subEl) subEl.textContent = `القائدة: ${settings.principal||'—'} · العام الدراسي ${yearLabel}`;

  const upcoming = yearTasks.filter(t=>t.status!=='done').sort((a,b)=>{
    const da = parseISODateOnly(a.due) || new Date(0);
    const db = parseISODateOnly(b.due) || new Date(0);
    return da - db;
  }).slice(0,5);
  const upEl = document.getElementById('upcoming-tasks-list');
  if (upEl) upEl.innerHTML = upcoming.length
    ? '<div class="upcoming-list">'+upcoming.map(t=>{
        const due = t.due ? parseISODateOnly(t.due) : null;
        const late = due && due < today;
        return`<div class="upcoming-item"><div class="upcoming-dot ${esc(t.priority)}"></div><div class="upcoming-info"><div class="upcoming-name">${esc(t.name)}</div><div class="upcoming-due">${late?'⚠️ متأخرة — ':''}${esc(fmtDate(t.due))} · ${esc(t.resp||'—')}</div></div></div>`;
      }).join('')+'</div>'
    : '<p style="padding:16px;color:var(--text-muted);text-align:center">لا توجد مهام قادمة</p>';

  const ipEl = document.getElementById('initiatives-progress');
  if (ipEl) ipEl.innerHTML = '<div class="initiatives-progress-list">'+yearPrograms.map(p=>`
    <div class="ini-progress-item">
      <span class="ini-progress-name">${esc(p.name)}</span>
      <div class="ini-progress-bar"><div class="progress-bar"><div class="progress-fill" style="width:${p.progress||0}%"></div></div></div>
      <span class="progress-text">${p.progress||0}%</span>
    </div>`).join('')+'</div>';

  setTimeout(() => drawDashPie(), 60);
}
function drawDashPie() {
  const c=document.getElementById('initiatives-chart'); if(!c)return;
  const ctx=c.getContext('2d'),W=c.width,H=c.height; ctx.clearRect(0,0,W,H);
  const yearPrograms = yearScopedRows(programsCache);
  const cnt={'منتهٍ':0,'جارٍ التنفيذ':0,'قيد التخطيط':0,'متأخر':0};
  yearPrograms.forEach(p=>{const s=calcProgramStatus(p);if(s==='done')cnt['منتهٍ']++;else if(s==='active')cnt['جارٍ التنفيذ']++;else if(s==='planning')cnt['قيد التخطيط']++;else cnt['متأخر']++;});
  const colors=['#27ae60','#2e86c1','#95a5a6','#e74c3c'],labels=Object.keys(cnt),values=Object.values(cnt),total=values.reduce((a,b)=>a+b,0);
  if(!total)return;
  const cx=W/2,cy=H/2-15,r=Math.min(W,H)/2-30;let sa=-Math.PI/2;
  values.forEach((v,i)=>{if(!v)return;const sl=(v/total)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,sa,sa+sl);ctx.closePath();ctx.fillStyle=colors[i];ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=2;ctx.stroke();const mid=sa+sl/2;ctx.fillStyle='white';ctx.font='bold 12px Tajawal';ctx.textAlign='center';ctx.fillText(v,cx+(r*.65)*Math.cos(mid),cy+(r*.65)*Math.sin(mid)+5);sa+=sl;});
  let li=0;labels.forEach((l,i)=>{if(!values[i])return;const x=10+(li%2)*(W/2),y=H-48+Math.floor(li/2)*20;ctx.fillStyle=colors[i];ctx.fillRect(x,y,12,12);ctx.fillStyle='#333';ctx.font='11px Tajawal';ctx.textAlign='right';ctx.fillText(l+' ('+values[i]+')',x+W/2-18,y+10);li++;});
}

/* ─────────────────────────────────────────────────────────────
   §32  CALENDAR
   ───────────────────────────────────────────────────────────── */
function setCalendarMode(mode) {
  if (mode !== 'hijri' && mode !== 'gregorian') return;
  if (mode === 'hijri' && !supportsIslamicUmalqura()) {
    showToast('المتصفح لا يدعم التقويم الهجري أم القرى عبر Intl', 'error');
    calendarMode = 'gregorian';
  } else {
    calendarMode = mode;
  }
  // مزامنة المؤشر بين الوضعين حول «اليوم» إن أمكن، وإلا أبقِ المؤشر الحالي
  syncCalendarCursorAcrossModes();
  renderCalendar();
}

function syncCalendarCursorAcrossModes() {
  if (calendarMode === 'hijri') {
    const anchor = new Date(Date.UTC(calendarYear, calendarMonth, 15, 12, 0, 0));
    const hp = getHijriPartsFromDate(anchor);
    if (hp) {
      calendarHijriYear = hp.year;
      calendarHijriMonth = hp.month;
    }
  } else {
    const start = findHijriDateUTC(calendarHijriYear, calendarHijriMonth, 1);
    if (start) {
      calendarYear = start.getUTCFullYear();
      calendarMonth = start.getUTCMonth();
    }
  }
}

function prevMonth() {
  if (calendarMode === 'hijri') {
    calendarHijriMonth -= 1;
    if (calendarHijriMonth < 1) {
      calendarHijriMonth = 12;
      calendarHijriYear -= 1;
    }
  } else {
    calendarMonth--;
    if (calendarMonth < 0) {
      calendarMonth = 11;
      calendarYear--;
    }
  }
  renderCalendar();
}

function nextMonth() {
  if (calendarMode === 'hijri') {
    calendarHijriMonth += 1;
    if (calendarHijriMonth > 12) {
      calendarHijriMonth = 1;
      calendarHijriYear += 1;
    }
  } else {
    calendarMonth++;
    if (calendarMonth > 11) {
      calendarMonth = 0;
      calendarYear++;
    }
  }
  renderCalendar();
}

function goToToday() {
  initCalendarCursorFromToday();
  renderCalendar();
}

function collectCalendarEventsByISO() {
  const todayIso = getTodayISOInRiyadh();
  const todayDate = parseISODateOnly(todayIso);
  const map = {};
  const push = (iso, item) => {
    if (!iso) return;
    if (!map[iso]) map[iso] = [];
    map[iso].push(item);
  };

  yearScopedRows(tasksCache).forEach(t => {
    const iso = toISODateKey(t.due);
    if (!iso) return;
    const d = parseISODateOnly(iso);
    const late = t.status !== 'done' && todayDate && d && d < todayDate;
    push(iso, { text: t.name, cls: late ? 'late-event' : 'task-event' });
  });

  yearScopedRows(programsCache).forEach(p => {
    const iso = toISODateKey(p.end);
    if (!iso) return;
    push(iso, { text: '📋 ' + p.name, cls: 'ini-event' });
  });

  yearScopedRows(initiativesCache).forEach(ini => {
    const isoEnd = toISODateKey(ini.end);
    if (isoEnd) push(isoEnd, { text: '🎯 ' + ini.name, cls: 'ini-event' });
    const isoStart = toISODateKey(ini.start);
    if (isoStart && isoStart !== isoEnd) {
      push(isoStart, { text: '🎯 بداية: ' + ini.name, cls: 'ini-event' });
    }
  });

  return map;
}

function renderCalendarCell(opts) {
  const { primaryNum, secondaryNum, isToday, events } = opts;
  const de = events || [];
  const secondary = secondaryNum != null
    ? `<span class="calendar-subdate">${secondaryNum}</span>`
    : '';
  return `<div class="calendar-cell${isToday ? ' today' : ''}">
    <div class="calendar-date-row">
      <div class="calendar-date${isToday ? ' today-num' : ''}">${primaryNum}</div>
      ${secondary}
    </div>
    ${de.slice(0, 3).map(e => `<div class="calendar-event ${esc(e.cls)}" title="${esc(e.text)}">${esc(e.text)}</div>`).join('')}
    ${de.length > 3 ? `<div style="font-size:9px;color:var(--text-muted)">+${de.length - 3}</div>` : ''}
  </div>`;
}

function updateCalendarModeButtons() {
  const hijriBtn = document.getElementById('cal-mode-hijri');
  const gregBtn = document.getElementById('cal-mode-greg');
  if (hijriBtn) hijriBtn.classList.toggle('active', calendarMode === 'hijri');
  if (gregBtn) gregBtn.classList.toggle('active', calendarMode === 'gregorian');
}

function renderCalendar() {
  updateCalendarModeButtons();
  const lbl = document.getElementById('calendar-month-label');
  const DN = ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];
  const eventsByIso = collectCalendarEventsByISO();
  const todayIso = getTodayISOInRiyadh();
  let html = '<div class="calendar-grid"><div class="calendar-header-row">' +
    DN.map(d => `<div class="calendar-day-name">${d}</div>`).join('') +
    '</div><div class="calendar-body">';

  if (calendarMode === 'hijri' && supportsIslamicUmalqura()) {
    if (lbl) lbl.textContent = formatHijriMonthYearLabel(calendarHijriYear, calendarHijriMonth);
    const days = buildHijriMonthDays(calendarHijriYear, calendarHijriMonth);
    if (!days.length) {
      if (lbl) lbl.textContent = 'تعذّر بناء الشهر الهجري';
      const ce = document.getElementById('calendar-container');
      if (ce) ce.innerHTML = '<p class="field-hint" style="padding:20px">تعذّر بناء شبكة الشهر الهجري عبر Intl في هذا المتصفح.</p>';
      return;
    }
    let col = 0;
    for (let i = 0; i < days[0].weekday; i++) {
      html += '<div class="calendar-cell empty"></div>';
      col++;
    }
    days.forEach(day => {
      html += renderCalendarCell({
        primaryNum: day.hijriDay,
        secondaryNum: day.gregDay,
        isToday: day.isoKey === todayIso,
        events: eventsByIso[day.isoKey] || [],
      });
      col++;
    });
    const rem = (7 - (col % 7)) % 7;
    for (let i = 0; i < rem; i++) html += '<div class="calendar-cell empty"></div>';
  } else {
    const MN = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    if (lbl) lbl.textContent = MN[calendarMonth] + ' ' + calendarYear;
    const fd = new Date(Date.UTC(calendarYear, calendarMonth, 1, 12, 0, 0)).getUTCDay();
    const dm = new Date(Date.UTC(calendarYear, calendarMonth + 1, 0, 12, 0, 0)).getUTCDate();
    let col = 0;
    for (let i = 0; i < fd; i++) {
      html += '<div class="calendar-cell empty"></div>';
      col++;
    }
    for (let day = 1; day <= dm; day++) {
      const isoKey = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const dObj = parseISODateOnly(isoKey);
      const hp = dObj ? getHijriPartsFromDate(dObj) : null;
      html += renderCalendarCell({
        primaryNum: day,
        secondaryNum: hp ? hp.day : null,
        isToday: isoKey === todayIso,
        events: eventsByIso[isoKey] || [],
      });
      col++;
    }
    const rem = (7 - (col % 7)) % 7;
    for (let i = 0; i < rem; i++) html += '<div class="calendar-cell empty"></div>';
  }

  html += '</div></div>';
  const ce = document.getElementById('calendar-container');
  if (ce) ce.innerHTML = html;
}

window.setCalendarMode = setCalendarMode;
window.goToToday = goToToday;
window.prevMonth = prevMonth;
window.nextMonth = nextMonth;

/* ─────────────────────────────────────────────────────────────
   §33  STATS
   ───────────────────────────────────────────────────────────── */
function renderStats() {
  const yearPrograms = yearScopedRows(programsCache);
  const yearTasks = yearScopedRows(tasksCache);
  const yearEvs = yearScopedRows(evidencesCache);
  const today = new Date(); today.setHours(0,0,0,0);
  const avg=yearPrograms.length?Math.round(yearPrograms.reduce((s,p)=>s+(p.progress||0),0)/yearPrograms.length):0;
  const dt=yearTasks.filter(t=>t.status==='done').length;
  const lt=yearTasks.filter(t=>{
    const due = t.due ? parseISODateOnly(t.due) : null;
    return t.status!=='done' && due && due < today;
  }).length;
  const top=[...yearPrograms].sort((a,b)=>(b.progress||0)-(a.progress||0)).slice(0,3);
  const sc=document.getElementById('stats-cards'); if(sc) sc.innerHTML=`
    <div class="stat-card"><span class="stat-icon">📊</span><span class="stat-number">${avg}%</span><span class="stat-label">متوسط إنجاز البرامج</span></div>
    <div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${dt}</span><span class="stat-label">مهام منجزة</span></div>
    <div class="stat-card red"><span class="stat-icon">⚠️</span><span class="stat-number">${lt}</span><span class="stat-label">مهام متأخرة</span></div>
    <div class="stat-card purple"><span class="stat-icon">📎</span><span class="stat-number">${yearEvs.length}</span><span class="stat-label">شواهد مرفوعة</span></div>
    <div class="stat-card gold"><span class="stat-icon">🎯</span><span class="stat-number">${kpiCache.length}</span><span class="stat-label">مؤشرات الأداء</span></div>
    <div class="stat-card teal"><span class="stat-icon">📋</span><span class="stat-number">${yearPrograms.filter(p=>calcProgramStatus(p)==='done').length}</span><span class="stat-label">برامج منتهية</span></div>`;
  const te=document.getElementById('top-initiatives');
  if(te) te.innerHTML=top.map((p,i)=>`<div class="top-initiative-item"><span>${['🥇','🥈','🥉'][i]} ${esc(p.name)}</span><span style="font-weight:700;color:var(--primary)">${p.progress}%</span></div>`).join('');
  setTimeout(()=>{drawStatsPie();drawCompare();},60);
}

function drawStatsPie() {
  const c=document.getElementById('tasks-pie-chart'); if(!c)return;
  const ctx=c.getContext('2d'),W=c.width,H=c.height; ctx.clearRect(0,0,W,H);
  const yearTasks = yearScopedRows(tasksCache);
  const today = new Date(); today.setHours(0,0,0,0);
  const cnt={'منجزة':yearTasks.filter(t=>t.status==='done').length,'قيد التنفيذ':yearTasks.filter(t=>t.status==='inprogress').length,'معلقة':yearTasks.filter(t=>t.status==='pending').length,'متأخرة':yearTasks.filter(t=>{
    const due = t.due ? parseISODateOnly(t.due) : null;
    return t.status!=='done' && due && due < today;
  }).length};
  const colors=['#27ae60','#2e86c1','#f39c12','#e74c3c'],L=Object.keys(cnt),V=Object.values(cnt),T=V.reduce((a,b)=>a+b,0);
  if(!T)return; const cx=W/2,cy=H/2-20,r=Math.min(W,H)/2-40;let sa=-Math.PI/2;
  V.forEach((v,i)=>{if(!v)return;const sl=(v/T)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,sa,sa+sl);ctx.closePath();ctx.fillStyle=colors[i];ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=2;ctx.stroke();const mid=sa+sl/2;ctx.fillStyle='white';ctx.font='bold 12px Tajawal';ctx.textAlign='center';ctx.fillText(v,cx+(r*.65)*Math.cos(mid),cy+(r*.65)*Math.sin(mid)+5);sa+=sl;});
  const ly=H-28;L.forEach((l,i)=>{const x=(i%2)*(W/2)+10,y=ly-Math.floor(1-i/2)*18;ctx.fillStyle=colors[i];ctx.fillRect(x,y,11,11);ctx.fillStyle='#444';ctx.font='11px Tajawal';ctx.textAlign='right';ctx.fillText(l+' ('+V[i]+')',x+W/2-14,y+9);});
}

function drawCompare() {
  const yearPrograms = yearScopedRows(programsCache);
  const c=document.getElementById('compare-chart'); if(!c||!yearPrograms.length)return;
  const W=c.parentElement?.offsetWidth||700; c.width=W; c.height=280;
  const ctx=c.getContext('2d'); ctx.clearRect(0,0,W,280);
  const pL=20,pR=20,pT=20,pB=70,cW=W-pL-pR,cH=280-pT-pB,n=Math.max(yearPrograms.length,1),gap=cW/n,bW=Math.min(32,gap/3);
  for(let i=0;i<=5;i++){const y=pT+cH-(cH*i/5);ctx.strokeStyle='#eaecee';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pL,y);ctx.lineTo(W-pR,y);ctx.stroke();ctx.fillStyle='#aaa';ctx.font='11px Tajawal';ctx.textAlign='left';ctx.fillText((i*20)+'%',pL,y-2);}
  yearPrograms.forEach((p,i)=>{const pct=p.progress||0,x=pL+i*gap+gap/2,bH=(pct/100)*cH;ctx.fillStyle='#dce8f5';ctx.fillRect(x-bW*1.1,pT,bW*2.2,cH);const clr=pct>=90?'#27ae60':pct>=60?'#2e86c1':pct>=30?'#f39c12':'#e74c3c';ctx.fillStyle=clr;ctx.fillRect(x-bW/2,pT+cH-bH,bW,bH);ctx.fillStyle='#333';ctx.font='bold 11px Tajawal';ctx.textAlign='center';ctx.fillText(pct+'%',x,pT+cH-bH-5);ctx.fillStyle='#666';ctx.font='11px Tajawal';ctx.fillText(p.name.length>7?p.name.slice(0,7)+'..':p.name,x,280-pB+16);});
}

/* ─────────────────────────────────────────────────────────────
   §34  USERS MANAGEMENT (admin only)
   ───────────────────────────────────────────────────────────── */
function adminUsersErrorMessage(code) {
  const c = String(code || '');
  if (c === 'forbidden') return 'ليس لديك صلاحية لهذا الإجراء';
  if (c === 'unauthorized') return 'الجلسة غير صالحة. سجّل الدخول مرة أخرى';
  if (c === 'invalid_payload') return 'البيانات المدخلة غير صحيحة';
  if (c === 'username_taken') return 'اسم المستخدم مستخدم مسبقاً';
  if (c === 'method_not_allowed') return 'الطلب غير مسموح';
  if (c === 'operation_failed') return 'تعذّر إتمام العملية. حاول مرة أخرى';
  return 'تعذّر إتمام العملية';
}

async function invokeAdminUsers(body) {
  if (!sb) throw new Error('operation_failed');
  const { data, error } = await sb.functions.invoke('admin-users', { body });
  if (data?.error) throw new Error(data.error);
  if (error) {
    try {
      if (error.context && typeof error.context.json === 'function') {
        const payload = await error.context.json();
        if (payload?.error) throw new Error(payload.error);
      }
    } catch (inner) {
      if (inner && inner.message && !String(inner.message).includes('Failed to execute')) {
        throw inner;
      }
    }
    throw new Error('operation_failed');
  }
  return data;
}

async function renderUsersSection() {
  if (!can('manageUsers')) return;
  const sec = document.getElementById('section-users'); if (!sec) return;
  let users = [];
  if (sb) {
    try {
      const data = await invokeAdminUsers({ action: 'list', page: 1, per_page: 50 });
      users = data?.users || [];
    } catch (err) {
      console.error('[fetchUsers]');
      showToast(adminUsersErrorMessage(err && err.message), 'error');
      users = [];
    }
  } else {
    users = [];
    showToast('تعذّر تحميل المستخدمين: الاتصال بـ Supabase مطلوب', 'error');
  }
  const RL={admin:'مدير',vice:'وكيل',teacher:'معلم'};
  const RB={admin:'badge-danger',vice:'badge-info',teacher:'badge-success'};
  sec.innerHTML = `
    <div class="section-top">
      <h2>إدارة المستخدمين</h2>
      <button class="btn-primary" onclick="openAddUserModal()">+ إضافة مستخدم</button>
    </div>
    <div class="table-wrapper"><table class="data-table">
      <thead><tr><th>#</th><th>الاسم</th><th>البريد</th><th>اسم المستخدم</th><th>الدور</th><th>تاريخ الإضافة</th><th>إجراءات</th></tr></thead>
      <tbody>
        ${users.map((u,i)=>`<tr><td>${i+1}</td><td style="font-weight:700">${esc(u.name)}</td>
          <td style="direction:ltr;text-align:right">${esc(u.email || '—')}</td>
          <td style="direction:ltr;text-align:right">${esc(u.username || '—')}</td>
          <td><span class="badge ${RB[u.role]||'badge-secondary'}">${esc(RL[u.role]||u.role)}</span></td>
          <td>${esc(fmtDate(u.created_at))}</td>
          <td><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <select class="task-status-select" onchange="handleChgRole('${esc(u.id)}',this.value)">
              <option value="admin" ${u.role==='admin'?'selected':''}>مدير</option>
              <option value="vice" ${u.role==='vice'?'selected':''}>وكيل</option>
              <option value="teacher" ${u.role==='teacher'?'selected':''}>معلم</option>
            </select>
            <button class="btn-sm btn-edit" title="تعديل الاسم واسم المستخدم"
              data-id="${esc(u.id)}" data-name="${esc(u.name||'')}" data-username="${esc(u.username||'')}"
              onclick="openEditUserModalFromBtn(this)">✏️</button>
            <button class="btn-sm btn-view" title="إرسال رابط إعادة تعيين كلمة المرور"
              data-id="${esc(u.id)}"
              onclick="handleSendPasswordReset(this.dataset.id)">🔑</button>
            ${u.id!==currentUser?.id
              ?`<button class="btn-sm btn-delete" onclick="handleDelUser('${esc(u.id)}')">🗑️</button>`
              :'<span style="font-size:12px;color:var(--text-muted)">أنت</span>'}
          </div></td></tr>`).join('')}
      </tbody>
    </table></div>
    <div id="add-user-modal" class="modal-overlay hidden"><div class="modal">
      <div class="modal-header"><h3>إضافة مستخدم جديد</h3><button onclick="closeModal('add-user-modal')" class="modal-close">✕</button></div>
      <div class="modal-body">
        <div class="form-group"><label>الاسم الكامل</label><input type="text" id="nu-name" placeholder="الاسم الكامل"/></div>
        <div class="form-group"><label>البريد الإلكتروني</label><input type="email" id="nu-email" placeholder="email@school.sa"/></div>
        <div class="form-group"><label>اسم المستخدم</label><input type="text" id="nu-username" placeholder="اسم عرض فريد"/></div>
        <div class="form-group"><label>كلمة المرور الأولية</label><input type="password" id="nu-pass" placeholder="8 أحرف على الأقل (حرف ورقم)" autocomplete="new-password"/></div>
        <div class="form-group"><label>الدور</label>
          <select id="nu-role"><option value="teacher">معلم</option><option value="vice">وكيل</option><option value="admin">مدير</option></select>
        </div>
        <p style="font-size:12px;color:var(--text-muted)">بعد الإنشاء يمكن إرسال رابط إعادة تعيين كلمة المرور للمستخدم.</p>
      </div>
      <div class="modal-footer">
        <button class="btn-primary" onclick="handleAddUser()">💾 إضافة</button>
        <button class="btn-secondary" onclick="closeModal('add-user-modal')">إلغاء</button>
      </div>
    </div></div>
    <div id="edit-user-modal" class="modal-overlay hidden"><div class="modal">
      <div class="modal-header"><h3>تعديل بيانات المستخدم</h3><button onclick="closeModal('edit-user-modal')" class="modal-close">✕</button></div>
      <div class="modal-body">
        <input type="hidden" id="eu-id"/>
        <div class="form-group"><label>الاسم الكامل</label><input type="text" id="eu-name" placeholder="الاسم الكامل"/></div>
        <div class="form-group"><label>اسم المستخدم</label><input type="text" id="eu-username" placeholder="اسم مستخدم فريد"/></div>
        <p style="font-size:12px;color:var(--text-muted)">لا يمكن تعديل البريد أو كلمة المرور من هنا. استخدم إرسال رابط الاستعادة لكلمة المرور.</p>
      </div>
      <div class="modal-footer">
        <button class="btn-primary" onclick="handleUpdateUser()">💾 حفظ</button>
        <button class="btn-secondary" onclick="closeModal('edit-user-modal')">إلغاء</button>
      </div>
    </div></div>`;
}

function openAddUserModal() {
  if (!requireAuth('manageUsers')) return;
  openModal('add-user-modal');
}

function openEditUserModalFromBtn(btn) {
  if (!btn) return;
  openEditUserModal(btn.dataset.id || '', btn.dataset.name || '', btn.dataset.username || '');
}

function openEditUserModal(id, name, username) {
  if (!requireAuth('manageUsers')) return;
  const idEl = document.getElementById('eu-id');
  const nameEl = document.getElementById('eu-name');
  const userEl = document.getElementById('eu-username');
  if (idEl) idEl.value = id || '';
  if (nameEl) nameEl.value = name || '';
  if (userEl) userEl.value = username || '';
  openModal('edit-user-modal');
}

async function handleUpdateUser() {
  if (!requireAuth('manageUsers')) return;
  if (!sb) { showToast('تعذّر الاتصال','error'); return; }
  const id = (document.getElementById('eu-id')?.value || '').trim();
  const name = clampInput(document.getElementById('eu-name')?.value || '');
  const username = clampInput(document.getElementById('eu-username')?.value || '');
  if (!id || !name || !username) {
    showToast('يرجى إدخال الاسم واسم المستخدم','error');
    return;
  }
  if (username.length < 3) {
    showToast('اسم المستخدم يجب أن يكون 3 أحرف على الأقل','error');
    return;
  }
  try {
    await invokeAdminUsers({ action: 'update', target_id: id, name, username });
    closeModal('edit-user-modal');
    showToast('تم تحديث بيانات المستخدم بنجاح','success');
    await renderUsersSection();
  } catch (err) {
    console.error('[handleUpdateUser]');
    showToast(adminUsersErrorMessage(err && err.message), 'error');
  }
}

/** رابط صفحة كامل بدون query/hash لمسار استعادة كلمة المرور */
function passwordResetRedirectUrl() {
  try {
    const origin = window.location.origin;
    let path = window.location.pathname || '/';
    if (path.endsWith('/')) path = `${path}index.html`;
    else if (!/\.html?$/i.test(path)) path = `${path}/index.html`;
    return `${origin}${path}`;
  } catch {
    return '';
  }
}

async function handleSendPasswordReset(id) {
  if (!requireAuth('manageUsers')) return;
  if (!sb) { showToast('تعذّر الاتصال','error'); return; }
  if (!id) return;
  if (!confirm('إرسال رسالة إعادة تعيين كلمة المرور إلى بريد هذا المستخدم؟')) return;
  const redirectTo = passwordResetRedirectUrl();
  if (!redirectTo) {
    showToast('تعذّر تحديد رابط الاستعادة','error');
    return;
  }
  try {
    await invokeAdminUsers({
      action: 'send_password_reset',
      target_id: id,
      redirect_to: redirectTo,
    });
    showToast('تم إرسال رسالة إعادة التعيين إن كان البريد صالحاً','success');
  } catch (err) {
    console.error('[handleSendPasswordReset]');
    showToast(adminUsersErrorMessage(err && err.message), 'error');
  }
}

async function handleAddUser() {
  if (!requireAuth('manageUsers')) return;
  if (!sb) { showToast('تعذّر الاتصال','error'); return; }
  const g = id => (document.getElementById(id)?.value||'').trim();
  const name=clampInput(g('nu-name'));
  const email=g('nu-email').toLowerCase();
  const username=clampInput(g('nu-username'));
  const pass=g('nu-pass');
  const role=g('nu-role');
  if (!name||!email||!pass||!username) { showToast('يرجى تعبئة جميع الحقول بما فيها اسم المستخدم','error'); return; }
  if (!isValidEmail(email)) { showToast('صيغة البريد غير صحيحة','error'); return; }
  if (pass.length < 8 || pass.length > 128) { showToast('كلمة المرور يجب أن تكون بين 8 و 128 حرفاً','error'); return; }
  if (!VALID_ROLES.includes(role)) { showToast('دور غير صالح','error'); return; }
  try {
    await invokeAdminUsers({
      action: 'create',
      email,
      password: pass,
      name,
      username,
      role,
    });
    closeModal('add-user-modal');
    showToast('تمت إضافة المستخدم بنجاح','success');
    await renderUsersSection();
  } catch(err){
    console.error('[handleAddUser]');
    showToast(adminUsersErrorMessage(err && err.message),'error');
  }
}

async function handleDelUser(id) {
  if (!requireAuth('manageUsers')) return;
  if (id === currentUser?.id) { showToast('لا يمكنك حذف حسابك الحالي','error'); return; }
  if (!confirm('حذف هذا المستخدم نهائياً؟')) return;
  if (!sb) { showToast('تعذّر الاتصال','error'); return; }
  try {
    await invokeAdminUsers({ action: 'delete', target_id: id });
    showToast('تم حذف المستخدم','warning');
    await renderUsersSection();
  } catch(err){
    console.error('[handleDelUser]');
    showToast(adminUsersErrorMessage(err && err.message),'error');
  }
}

async function handleChgRole(id, role) {
  if (!requireAuth('manageUsers')) return;
  if (!VALID_ROLES.includes(role)) { showToast('دور غير صالح','error'); return; }
  if (id === currentUser?.id) {
    showToast('لا يمكنك تغيير دورك الحالي','error');
    await renderUsersSection();
    return;
  }
  if (!sb) { showToast('تعذّر الاتصال','error'); return; }
  try {
    await invokeAdminUsers({ action: 'change_role', target_id: id, role });
    showToast('تم تعديل الدور بنجاح','success');
  } catch(err){
    console.error('[handleChgRole]');
    showToast(adminUsersErrorMessage(err && err.message),'error');
    await renderUsersSection();
  }
}

/* ─────────────────────────────────────────────────────────────
   §35  ENTRY POINT
   ───────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  initCalendarCursorFromToday();
  bindAllHijriPreviews();

  bindAuthStateListener();
  showLoginShell();

  if (!sb) {
    showToast('تعذّر الاتصال بخدمة المصادقة', 'error');
    return;
  }

  clearLegacySessionArtifacts();

  const redirectErr = consumeAuthRedirectError();
  if (redirectErr) {
    showLoginShell();
    showToast(redirectErr, 'error');
    return;
  }

  // رابط استعادة: لا تمنح دخول التطبيق / إدارة المستخدمين
  if (isRecoveryRedirectInUrl()) {
    _passwordRecoveryActive = true;
    showLoginShell();
    try { await sb.auth.getSession(); } catch {}
    openPasswordRecoveryModal();
    return;
  }

  const { data, error } = await sb.auth.getSession();
  if (_passwordRecoveryActive) {
    showLoginShell();
    openPasswordRecoveryModal();
    return;
  }
  if (error || !data?.session) {
    showLoginShell();
    return;
  }

  const ok = await bootstrapAuthenticatedSession(data.session);
  if (!ok) {
    showLoginShell();
    return;
  }
  renderSection(_activeSection || 'dashboard');
  renderDashboard();
  renderPrograms();
  renderReports();
  drawDashPie();
});
window.doLogin = doLogin;
window.openAddUserModal = openAddUserModal;
window.openEditUserModalFromBtn = openEditUserModalFromBtn;
window.handleUpdateUser = handleUpdateUser;
window.handleSendPasswordReset = handleSendPasswordReset;
window.handleAddUser = handleAddUser;
window.handleDelUser = handleDelUser;
window.handleChgRole = handleChgRole;
window.submitPasswordRecovery = submitPasswordRecovery;
window.cancelPasswordRecovery = cancelPasswordRecovery;
window.doLogout = doLogout;
