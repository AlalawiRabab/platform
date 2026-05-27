/* =======================================================================
   SCHOOL OPERATIONAL PLAN - script.js
   -----------------------------------------------------------------------
   التخزين: LocalStorage مؤقتاً
   للربط مع Supabase لاحقاً: ابحث عن التعليقات التي تبدأ بـ
   // [SUPABASE] لمعرفة أماكن الربط
   ======================================================================= */

// ===== GLOBAL STATE =====
let currentUser = null;
let currentRole = 'principal';
let calendarMonth = new Date().getMonth();
let calendarYear = new Date().getFullYear();

// Temp store for file uploads (base64 in memory)
// [SUPABASE] استبدل هذا بـ Supabase Storage upload عند الربط
let pendingFileData = null;   // { name, type, base64, mimeType }
let pendingImageData = null;  // { name, base64 }

// ===== DEMO DATA =====
const DEMO_INITIATIVES = [
  { id:1, goal:'تحسين التحصيل الدراسي', name:'تفعيل الاختبارات القصيرة', desc:'تطبيق اختبارات قصيرة أسبوعية لجميع المواد', resp:'أ. نورة العتيبي', start:'2024-09-01', end:'2025-05-30', status:'قيد التنفيذ', progress:75, link:'https://drive.google.com/example1' },
  { id:2, goal:'تحسين التحصيل الدراسي', name:'متابعة الفاقد التعليمي', desc:'رصد ومتابعة الطالبات ذوات الفاقد التعليمي', resp:'أ. هند القحطاني', start:'2024-09-15', end:'2025-05-15', status:'قيد التنفيذ', progress:60, link:'' },
  { id:3, goal:'تعزيز الانضباط', name:'برنامج الانضباط المدرسي', desc:'تطبيق برنامج شامل لتعزيز الانضباط المدرسي', resp:'أ. سلمى الزهراني', start:'2024-09-01', end:'2025-06-01', status:'قيد التنفيذ', progress:80, link:'' },
  { id:4, goal:'التنمية المهنية', name:'التنمية المهنية للمعلمات', desc:'تنفيذ برامج تدريبية لتطوير مهارات المعلمات', resp:'أ. ريم الحربي', start:'2024-10-01', end:'2025-04-30', status:'منجزة', progress:100, link:'' },
  { id:5, goal:'الشراكة المجتمعية', name:'تفعيل الشراكة المجتمعية', desc:'بناء شراكات مع مؤسسات المجتمع', resp:'أ. مها الشمري', start:'2024-11-01', end:'2025-03-31', status:'منجزة', progress:100, link:'' },
  { id:6, goal:'تعزيز الهوية الوطنية', name:'تعزيز الهوية الوطنية', desc:'فعاليات تعزز الانتماء الوطني ورؤية 2030', resp:'أ. فاطمة الدوسري', start:'2024-09-22', end:'2025-02-23', status:'منجزة', progress:100, link:'' },
  { id:7, goal:'تحسين التحصيل الدراسي', name:'التعلم التعاوني', desc:'تطبيق استراتيجيات التعلم التعاوني', resp:'أ. نورة العتيبي', start:'2024-10-15', end:'2025-05-15', status:'قيد التنفيذ', progress:55, link:'' },
  { id:8, goal:'متابعة الفاقد التعليمي', name:'حلقات الدعم الأكاديمي', desc:'تنظيم حلقات دعم أسبوعية للطالبات المتعثرات', resp:'أ. هند القحطاني', start:'2024-09-20', end:'2025-05-20', status:'قيد التنفيذ', progress:45, link:'' },
];

const DEMO_PROGRAMS = [
  {
    id:101, name:'برنامج تحسين التحصيل الدراسي', desc:'برنامج شامل لرفع مستوى التحصيل الدراسي من خلال استراتيجيات تدريسية متنوعة واختبارات دورية ومتابعة مستمرة للطالبات',
    resp:'أ. نورة العتيبي', target:'طالبات المراحل الدراسية كافة', start:'2024-09-01', end:'2025-05-30',
    progress:72, indicators:['تنفيذ 45 اختبار قصير في الفصل الأول','استفادة 280 طالبة من حلقات الدعم','رفع المعدل العام بنسبة 8%'],
    evidence:[]
  },
  {
    id:102, name:'برنامج التنمية المهنية للمعلمات', desc:'تطوير كفاءات المعلمات المهنية من خلال ورش تدريبية وزيارات صفية وتبادل خبرات مع المدارس الرائدة',
    resp:'أ. ريم الحربي', target:'جميع المعلمات (32 معلمة)', start:'2024-10-01', end:'2025-04-30',
    progress:100, indicators:['تنفيذ 6 ورش تدريبية','120 ساعة تدريبية إجمالية','اجتياز 30 معلمة للاختبارات التقييمية'],
    evidence:[
      { id:'e1', title:'تقرير الورشة الأولى', type:'link', link:'https://drive.google.com/example', person:'أ. ريم الحربي', date:'2024-11-10', notes:'تضمنت 15 معلمة' },
      { id:'e2', title:'صور الورشة التدريبية', type:'image', link:'', fileData:null, person:'أ. ريم الحربي', date:'2024-12-05', notes:'' }
    ]
  },
  {
    id:103, name:'برنامج الشراكة المجتمعية', desc:'تفعيل الشراكات مع المؤسسات المجتمعية والقطاع الخاص لدعم العملية التعليمية وتقديم الدعم للطالبات المحتاجات',
    resp:'أ. مها الشمري', target:'الطالبات وأسرهم والمجتمع المحلي', start:'2024-11-01', end:'2025-03-31',
    progress:100, indicators:['5 شراكات مع جهات مجتمعية','توفير 50 منحة دراسية','تنفيذ 3 فعاليات مجتمعية'],
    evidence:[]
  },
  {
    id:104, name:'برنامج الانضباط وتعزيز السلوك', desc:'تطبيق منهجية متكاملة لتعزيز الانضباط المدرسي وترسيخ القيم والأخلاق الحميدة لدى الطالبات',
    resp:'أ. سلمى الزهراني', target:'جميع طالبات المدرسة', start:'2024-09-01', end:'2025-06-01',
    progress:78, indicators:['تراجع حالات الغياب بنسبة 15%','انخفاض المخالفات السلوكية بنسبة 22%','تطبيق نظام الحوافز والمكافآت'],
    evidence:[]
  },
  {
    id:105, name:'برنامج تعزيز الهوية الوطنية', desc:'تنفيذ فعاليات وأنشطة تعزز الانتماء الوطني وقيم المواطنة ورؤية 2030 لدى الطالبات',
    resp:'أ. فاطمة الدوسري', target:'جميع الطالبات', start:'2024-09-22', end:'2025-02-23',
    progress:100, indicators:['إقامة 4 فعاليات وطنية','مشاركة 350 طالبة في الأنشطة','إنتاج مجلة وطنية'],
    evidence:[]
  },
];

const DEMO_TASKS = [
  { id:1, name:'إعداد جدول الاختبارات القصيرة', resp:'أ. نورة العتيبي', due:'2025-01-15', priority:'high', status:'done', notes:'تم الإعداد والاعتماد' },
  { id:2, name:'رصد نتائج الاختبارات التشخيصية', resp:'أ. هند القحطاني', due:'2025-01-20', priority:'high', status:'done', notes:'' },
  { id:3, name:'تنفيذ ورشة التعلم التعاوني', resp:'أ. ريم الحربي', due:'2025-02-10', priority:'medium', status:'inprogress', notes:'الورشة مقررة في الثامن' },
  { id:4, name:'إعداد تقرير الفاقد التعليمي', resp:'أ. هند القحطاني', due:'2025-02-28', priority:'high', status:'pending', notes:'' },
  { id:5, name:'تنظيم فعالية اليوم الوطني', resp:'أ. فاطمة الدوسري', due:'2024-09-22', priority:'high', status:'done', notes:'تم تنفيذها بنجاح' },
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
  { id:2, name:'أ. هند القحطاني', assigned:8, done:5, lastReport:'2024-12-10', notes:'' },
  { id:3, name:'أ. سلمى الزهراني', assigned:10, done:9, lastReport:'2024-12-20', notes:'' },
  { id:4, name:'أ. ريم الحربي', assigned:6, done:6, lastReport:'2024-12-12', notes:'' },
  { id:5, name:'أ. مها الشمري', assigned:7, done:6, lastReport:'2024-12-18', notes:'' },
  { id:6, name:'أ. فاطمة الدوسري', assigned:9, done:8, lastReport:'2024-12-22', notes:'' },
];

const DEMO_SETTINGS = {
  schoolName:'مدرسة النور الابتدائية', year:'١٤٤٦ / ١٤٤٧هـ',
  principal:'أ. سارة العتيبي', region:'منطقة المدينة المنورة'
};

// ===== STORAGE HELPERS =====
// [SUPABASE] استبدل هذه الدوال بـ Supabase queries عند الربط
function save(key, data) { localStorage.setItem('sop_' + key, JSON.stringify(data)); }
function load(key, def) {
  try { const v = localStorage.getItem('sop_' + key); return v ? JSON.parse(v) : def; }
  catch { return def; }
}

// ===== INIT DATA =====
function initData() {
  if (!localStorage.getItem('sop_initiatives')) save('initiatives', DEMO_INITIATIVES);
  if (!localStorage.getItem('sop_programs')) save('programs', DEMO_PROGRAMS);
  if (!localStorage.getItem('sop_tasks')) save('tasks', DEMO_TASKS);
  if (!localStorage.getItem('sop_kpi')) save('kpi', DEMO_KPI);
  if (!localStorage.getItem('sop_reports')) save('reports', DEMO_REPORTS);
  if (!localStorage.getItem('sop_teachers')) save('teachers', DEMO_TEACHERS);
  if (!localStorage.getItem('sop_settings')) save('settings', DEMO_SETTINGS);
}

function resetToDemo() {
  if (!confirm('سيتم إعادة تحميل جميع البيانات التجريبية. هل أنت متأكدة؟')) return;
  save('initiatives', DEMO_INITIATIVES);
  save('programs', DEMO_PROGRAMS);
  save('tasks', DEMO_TASKS);
  save('kpi', DEMO_KPI);
  save('reports', DEMO_REPORTS);
  save('teachers', DEMO_TEACHERS);
  save('settings', DEMO_SETTINGS);
  loadSettings();
  refreshCurrentSection();
  showToast('تم إعادة تحميل البيانات التجريبية ✅', 'success');
}

function clearAllData() {
  if (!confirm('سيتم مسح جميع البيانات نهائياً. هل أنت متأكدة؟')) return;
  ['initiatives','programs','tasks','kpi','reports','teachers','settings']
    .forEach(k => localStorage.removeItem('sop_' + k));
  initData();
  loadSettings();
  refreshCurrentSection();
  showToast('تم مسح البيانات وإعادة التهيئة ✅', 'warning');
}

// ===== LOGIN =====
function selectRole(btn, role) {
  document.querySelectorAll('.role-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentRole = role;
}

function doLogin() {
  const user = document.getElementById('username').value.trim();
  const pass = document.getElementById('password').value.trim();
  if (!user || !pass) { showToast('يرجى إدخال اسم المستخدم وكلمة المرور', 'error'); return; }
  // [SUPABASE] استبدل هذا بـ supabase.auth.signInWithPassword({ email, password })
  const roleNames = { principal:'مديرة المدرسة', vice:'وكيلة', teacher:'معلمة', admin:'إدارية' };
  currentUser = { name: user, role: currentRole, roleName: roleNames[currentRole] };
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  applyRoleUI();
  loadSettings();
  showSection('dashboard', document.querySelector('.nav-item[data-section="dashboard"]'));
}

function doLogout() {
  currentUser = null;
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-page').classList.remove('hidden');
  document.getElementById('username').value = '';
  document.getElementById('password').value = '';
}

function applyRoleUI() {
  if (!currentUser) return;
  const role = currentUser.role;
  document.getElementById('user-role-badge').textContent = currentUser.roleName;
  document.getElementById('header-user-name').textContent = currentUser.name;
  document.querySelector('.avatar').textContent = currentUser.name.charAt(0);
  document.querySelectorAll('.nav-item').forEach(item => {
    const hasClass = item.classList.contains('nav-'+role) || item.dataset.section === 'dashboard';
    item.style.display = role === 'principal' ? 'flex' : (hasClass ? 'flex' : 'none');
  });
}

// ===== SETTINGS =====
function loadSettings() {
  const s = load('settings', DEMO_SETTINGS);
  document.getElementById('setting-school').value = s.schoolName || '';
  document.getElementById('setting-year').value = s.year || '';
  document.getElementById('setting-principal').value = s.principal || '';
  document.getElementById('setting-region').value = s.region || '';
  document.getElementById('sidebar-school-name').textContent = s.schoolName || 'مدرسة النور';
  document.getElementById('sidebar-year').textContent = s.year || '';
}

function saveSettings() {
  // [SUPABASE] احفظ في جدول school_settings
  const s = {
    schoolName: document.getElementById('setting-school').value,
    year: document.getElementById('setting-year').value,
    principal: document.getElementById('setting-principal').value,
    region: document.getElementById('setting-region').value
  };
  save('settings', s);
  document.getElementById('sidebar-school-name').textContent = s.schoolName;
  document.getElementById('sidebar-year').textContent = s.year;
  showToast('تم حفظ الإعدادات ✅', 'success');
}

// ===== NAVIGATION =====
let activeSection = 'dashboard';

function showSection(name, el) {
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
    calendar:'التقويم الزمني', stats:'الإحصائيات', settings:'الإعدادات'
  };
  document.getElementById('section-title').textContent = titles[name] || '';
  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.remove('open');
    const overlay = document.querySelector('.sidebar-overlay');
    if (overlay) overlay.classList.remove('show');
  }
  renderSection(name);
}

function refreshCurrentSection() { renderSection(activeSection); }

function renderSection(name) {
  switch(name) {
    case 'dashboard': renderDashboard(); break;
    case 'programs': renderPrograms(); break;
    case 'plan': renderPlan(); break;
    case 'kpi': renderKPI(); break;
    case 'tasks': renderTasks(); break;
    case 'reports': renderReports(); break;
    case 'teachers': renderTeachers(); break;
    case 'calendar': renderCalendar(); break;
    case 'stats': renderStats(); break;
  }
}

// ===== SIDEBAR TOGGLE =====
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

// ===== TOAST =====
let toastTimer = null;
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ===== MODALS =====
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  // Reset file data when evidence modal closes
  if (id === 'evidence-modal') { pendingFileData = null; pendingImageData = null; }
}

// =========================================================
// ===== PROGRAMS SECTION (NEW) =====
// =========================================================

// --- Status Calculation ---
function calcProgramStatus(prog) {
  const today = new Date(); today.setHours(0,0,0,0);
  const start = prog.start ? new Date(prog.start) : null;
  const end = prog.end ? new Date(prog.end) : null;
  const pct = parseInt(prog.progress) || 0;

  if (pct >= 100) return 'done';
  if (!start || today < start) return 'planning';
  if (end && today > end && pct < 100) return 'late';
  if (start && today >= start) return 'active';
  return 'planning';
}

function getStatusLabel(status) {
  const m = { planning:'قيد التخطيط', active:'جارٍ التنفيذ', done:'منتهٍ', late:'متأخر' };
  return m[status] || status;
}
function getStatusBadge(status) {
  const m = { planning:'badge-secondary', active:'badge-info', done:'badge-success', late:'badge-danger' };
  return m[status] || 'badge-secondary';
}
function getStatusIcon(status) {
  const m = { planning:'⏳', active:'▶️', done:'✅', late:'⚠️' };
  return m[status] || '📋';
}

// --- Auto calc status display in modal ---
function autoCalcProgStatus() {
  const start = document.getElementById('prog-start').value;
  const end = document.getElementById('prog-end').value;
  const pct = parseInt(document.getElementById('prog-progress').value) || 0;
  const fake = { start, end, progress: pct };
  const status = calcProgramStatus(fake);
  document.getElementById('prog-status').value = status;
  document.getElementById('prog-status-display').value = getStatusIcon(status) + ' ' + getStatusLabel(status);
}

// --- Open/close program modal ---
function openProgramModal(id) {
  pendingFileData = null; pendingImageData = null;
  document.getElementById('prog-edit-id').value = '';
  document.getElementById('program-modal-title').textContent = 'إضافة برنامج جديد';
  ['prog-name','prog-resp','prog-desc','prog-target','prog-start','prog-end','prog-indicators'].forEach(f => {
    const el = document.getElementById(f); if (el) el.value = '';
  });
  document.getElementById('prog-progress').value = '';
  document.getElementById('prog-status').value = '';
  document.getElementById('prog-status-display').value = '';
  if (id) {
    // Edit mode
    const progs = load('programs', []);
    const p = progs.find(x => x.id === id);
    if (!p) return;
    document.getElementById('prog-edit-id').value = p.id;
    document.getElementById('program-modal-title').textContent = 'تعديل البرنامج';
    document.getElementById('prog-name').value = p.name || '';
    document.getElementById('prog-resp').value = p.resp || '';
    document.getElementById('prog-desc').value = p.desc || '';
    document.getElementById('prog-target').value = p.target || '';
    document.getElementById('prog-start').value = p.start || '';
    document.getElementById('prog-end').value = p.end || '';
    document.getElementById('prog-progress').value = p.progress || 0;
    document.getElementById('prog-indicators').value = (p.indicators || []).join('\n');
    autoCalcProgStatus();
  }
  openModal('program-modal');
}

// --- Save program ---
function saveProgram() {
  const name = document.getElementById('prog-name').value.trim();
  const resp = document.getElementById('prog-resp').value.trim();
  if (!name) { showToast('يرجى إدخال اسم البرنامج', 'error'); return; }
  if (!resp) { showToast('يرجى إدخال اسم المسؤولة', 'error'); return; }

  const editId = document.getElementById('prog-edit-id').value;
  const indicatorsRaw = document.getElementById('prog-indicators').value.trim();
  const indicators = indicatorsRaw ? indicatorsRaw.split('\n').map(l=>l.trim()).filter(Boolean) : [];

  const start = document.getElementById('prog-start').value;
  const end = document.getElementById('prog-end').value;
  const pct = parseInt(document.getElementById('prog-progress').value) || 0;

  const prog = {
    id: editId ? parseInt(editId) : Date.now(),
    name, resp,
    desc: document.getElementById('prog-desc').value.trim(),
    target: document.getElementById('prog-target').value.trim(),
    start, end, progress: pct, indicators,
    evidence: []
  };

  // [SUPABASE] insert/update جدول programs
  let data = load('programs', []);
  if (editId) {
    const idx = data.findIndex(p => p.id === prog.id);
    if (idx !== -1) {
      prog.evidence = data[idx].evidence || []; // preserve evidence
      data[idx] = prog;
    }
  } else {
    data.push(prog);
  }
  save('programs', data);
  closeModal('program-modal');
  renderPrograms();
  showToast(editId ? 'تم تعديل البرنامج ✅' : 'تمت إضافة البرنامج ✅', 'success');
}

// --- Delete program ---
function deleteProgram(id) {
  if (!confirm('هل تريدين حذف هذا البرنامج وجميع شواهده؟')) return;
  // [SUPABASE] delete from programs where id = id
  let data = load('programs', []);
  data = data.filter(p => p.id !== id);
  save('programs', data);
  renderPrograms();
  showToast('تم حذف البرنامج 🗑️', 'warning');
}

// --- Render programs ---
function renderPrograms() {
  const programs = load('programs', []);
  const filterStatus = document.getElementById('prog-filter-status')?.value || 'all';
  const searchVal = (document.getElementById('prog-search')?.value || '').toLowerCase();

  // Compute stats
  const total = programs.length;
  const counts = { planning:0, active:0, done:0, late:0 };
  programs.forEach(p => { const s = calcProgramStatus(p); counts[s] = (counts[s]||0)+1; });
  const avgPct = total ? Math.round(programs.reduce((s,p) => s+(parseInt(p.progress)||0),0)/total) : 0;

  const statsEl = document.getElementById('programs-stats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="stat-card"><span class="stat-icon">🗂️</span><span class="stat-number">${total}</span><span class="stat-label">إجمالي البرامج</span></div>
      <div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${counts.done}</span><span class="stat-label">برامج منتهية</span></div>
      <div class="stat-card"><span class="stat-icon">▶️</span><span class="stat-number">${counts.active}</span><span class="stat-label">برامج جارية</span></div>
      <div class="stat-card red"><span class="stat-icon">⚠️</span><span class="stat-number">${counts.late}</span><span class="stat-label">برامج متأخرة</span></div>
      <div class="stat-card gold"><span class="stat-icon">📊</span><span class="stat-number">${avgPct}%</span><span class="stat-label">متوسط الإنجاز</span></div>
    `;
  }

  // Filter
  let filtered = programs.filter(p => {
    const status = calcProgramStatus(p);
    const matchStatus = filterStatus === 'all' || status === filterStatus;
    const matchSearch = !searchVal || p.name.toLowerCase().includes(searchVal) || (p.resp||'').toLowerCase().includes(searchVal);
    return matchStatus && matchSearch;
  });

  const grid = document.getElementById('programs-grid');
  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🗂️</div><p>لا توجد برامج مطابقة</p><small>جربي تغيير الفلتر أو إضافة برنامج جديد</small></div>`;
    return;
  }

  grid.innerHTML = filtered.map(p => renderProgramCard(p)).join('');
}

function renderProgramCard(p) {
  const status = calcProgramStatus(p);
  const statusLabel = getStatusLabel(status);
  const statusBadgeClass = getStatusBadge(status);
  const pct = parseInt(p.progress) || 0;
  const evidence = p.evidence || [];

  const progressColor = pct >= 90 ? '#27ae60' : pct >= 60 ? '#2e86c1' : pct >= 30 ? '#f39c12' : '#e74c3c';

  const indicatorsHtml = (p.indicators || []).slice(0,3).map(ind =>
    `<div class="program-indicator-item">${ind}</div>`
  ).join('');

  const evidenceHtml = evidence.length ? evidence.map(ev => {
    const icon = getEvidenceIcon(ev.type);
    const href = ev.link ? `href="${ev.link}" target="_blank"` : '';
    const tag = ev.link ? 'a' : 'span';
    return `<${tag} class="evidence-chip${ev.link ? '' : ' no-link'}" ${href}>
      ${icon} ${ev.title}
      <span class="ev-delete" onclick="event.preventDefault();event.stopPropagation();deleteEvidence(${p.id},'${ev.id}')" title="حذف">✕</span>
    </${tag}>`;
  }).join('') : '<span style="font-size:12px;color:var(--text-muted)">لا توجد شواهد بعد</span>';

  return `
  <div class="program-card status-${status}">
    <div class="program-card-header">
      <div class="program-card-title">${p.name}</div>
      <div class="program-card-status"><span class="badge ${statusBadgeClass}">${getStatusIcon(status)} ${statusLabel}</span></div>
    </div>
    <div class="program-card-body">
      ${p.desc ? `<div class="program-card-desc">${p.desc}</div>` : ''}
      <div class="program-meta-grid">
        <div class="program-meta-item">👩‍🏫 <strong>${p.resp || '—'}</strong></div>
        <div class="program-meta-item">🎯 <strong>${p.target || '—'}</strong></div>
        <div class="program-meta-item">📅 <strong>${formatDate(p.start)}</strong></div>
        <div class="program-meta-item">🏁 <strong>${formatDate(p.end)}</strong></div>
      </div>

      <div class="program-progress-section">
        <div class="program-progress-label">
          <span>نسبة الإنجاز</span>
          <span>${pct}%</span>
        </div>
        <div class="progress-bar" style="height:10px">
          <div class="progress-fill" style="width:${pct}%;background:linear-gradient(90deg,${progressColor},${progressColor}cc)"></div>
        </div>
      </div>

      ${indicatorsHtml ? `
      <div class="program-indicators">
        <div class="program-indicators-title">📌 مؤشرات الإنجاز</div>
        ${indicatorsHtml}
        ${(p.indicators||[]).length > 3 ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px">+${(p.indicators||[]).length-3} مؤشرات أخرى</div>` : ''}
      </div>` : ''}

      <div class="program-evidence-section">
        <div class="program-evidence-title">
          <span>📎 الشواهد (${evidence.length})</span>
          <button class="btn-sm btn-evidence" onclick="openEvidenceModal(${p.id})">+ إضافة شاهد</button>
        </div>
        <div class="evidence-chips">${evidenceHtml}</div>
      </div>
    </div>
    <div class="program-card-actions">
      <button class="btn-sm btn-detail" onclick="viewProgramDetail(${p.id})">👁️ التفاصيل</button>
      <button class="btn-sm btn-edit" onclick="openProgramModal(${p.id})">✏️ تعديل</button>
      <button class="btn-sm btn-delete" onclick="deleteProgram(${p.id})">🗑️ حذف</button>
    </div>
  </div>`;
}

// --- Program Detail Modal ---
function viewProgramDetail(id) {
  const progs = load('programs', []);
  const p = progs.find(x => x.id === id);
  if (!p) return;
  const status = calcProgramStatus(p);
  const pct = parseInt(p.progress) || 0;

  document.getElementById('detail-modal-title').textContent = p.name;

  const evidence = p.evidence || [];
  const evHtml = evidence.length ? evidence.map(ev => {
    const icon = getEvidenceIcon(ev.type);
    return `<div class="evidence-detail-item">
      <div class="ev-det-icon">${icon}</div>
      <div class="ev-det-info">
        <div class="ev-det-title">${ev.title}</div>
        <div class="ev-det-meta">${ev.person || ''} · ${formatDate(ev.date)} · ${getEvidenceTypeLabel(ev.type)}</div>
        ${ev.notes ? `<div class="ev-det-meta" style="margin-top:3px;font-style:italic">${ev.notes}</div>` : ''}
      </div>
      <div class="ev-det-actions">
        ${ev.link ? `<a href="${ev.link}" target="_blank" class="btn-sm btn-view">🔗 فتح</a>` : ''}
        ${ev.type === 'image' && ev.fileData ? `<button class="btn-sm btn-view" onclick="viewImage('${ev.fileData}')">🖼️ عرض</button>` : ''}
        <button class="btn-sm btn-delete" onclick="deleteEvidence(${p.id},'${ev.id}');closeModal('program-detail-modal');viewProgramDetail(${p.id})">🗑️</button>
      </div>
    </div>`;
  }).join('') : '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">لا توجد شواهد مرفوعة</p>';

  const indicatorsHtml = (p.indicators||[]).map(ind =>
    `<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-light);font-size:13px">
      <span style="color:var(--accent);font-weight:700">✓</span> ${ind}
    </div>`
  ).join('');

  const progressColor = pct >= 90 ? '#27ae60' : pct >= 60 ? '#2e86c1' : pct >= 30 ? '#f39c12' : '#e74c3c';

  document.getElementById('program-detail-body').innerHTML = `
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
        <div class="detail-item"><div class="detail-item-label">المسؤولة</div><div class="detail-item-value">${p.resp||'—'}</div></div>
        <div class="detail-item"><div class="detail-item-label">الفئة المستهدفة</div><div class="detail-item-value">${p.target||'—'}</div></div>
        <div class="detail-item"><div class="detail-item-label">تاريخ البدء</div><div class="detail-item-value">${formatDate(p.start)}</div></div>
        <div class="detail-item"><div class="detail-item-label">تاريخ الانتهاء</div><div class="detail-item-value">${formatDate(p.end)}</div></div>
      </div>
      ${p.desc ? `<div style="margin-top:12px;padding:12px 14px;background:var(--bg);border-radius:8px;font-size:13px;line-height:1.7;color:var(--text-main)">${p.desc}</div>` : ''}
    </div>

    ${indicatorsHtml ? `<div class="detail-section"><h4>📌 مؤشرات الإنجاز</h4>${indicatorsHtml}</div>` : ''}

    <div class="detail-section">
      <h4 style="display:flex;justify-content:space-between;align-items:center">
        📎 الشواهد والتقارير (${evidence.length})
        <button class="btn-primary" style="font-size:12px;padding:6px 14px" onclick="openEvidenceModal(${p.id});closeModal('program-detail-modal')">+ إضافة شاهد</button>
      </h4>
      <div class="evidence-list-detail">${evHtml}</div>
    </div>
  `;
  openModal('program-detail-modal');
}

function viewImage(base64) {
  const w = window.open('');
  w.document.write(`<img src="${base64}" style="max-width:100%;height:auto">`);
}

// =========================================================
// ===== EVIDENCE (WITNESSES) =====
// =========================================================

function getEvidenceIcon(type) {
  const m = { link:'🔗', file:'📎', image:'🖼️', pdf:'📄', word:'📝', excel:'📊' };
  return m[type] || '📎';
}

function getEvidenceTypeLabel(type) {
  const m = { link:'رابط خارجي', file:'ملف', image:'صورة', pdf:'PDF', word:'Word', excel:'Excel' };
  return m[type] || type;
}

function toggleEvidenceInput() {
  const type = document.getElementById('ev-type').value;
  document.getElementById('ev-link-group').classList.toggle('hidden', type !== 'link');
  document.getElementById('ev-file-group').classList.toggle('hidden', type !== 'file');
  document.getElementById('ev-image-group').classList.toggle('hidden', type !== 'image');
  pendingFileData = null;
  pendingImageData = null;
  document.getElementById('ev-file-preview').classList.add('hidden');
  document.getElementById('ev-image-preview').classList.add('hidden');
  document.getElementById('ev-image-preview').innerHTML = '';
  document.getElementById('ev-file-preview').innerHTML = '';
}

function openEvidenceModal(programId, evidenceId) {
  pendingFileData = null;
  pendingImageData = null;
  document.getElementById('ev-program-id').value = programId;
  document.getElementById('ev-edit-id').value = evidenceId || '';
  document.getElementById('evidence-modal-title').textContent = evidenceId ? 'تعديل الشاهد' : 'إضافة شاهد';
  document.getElementById('ev-title').value = '';
  document.getElementById('ev-type').value = 'link';
  document.getElementById('ev-link').value = '';
  document.getElementById('ev-person').value = '';
  document.getElementById('ev-notes').value = '';

  // Reset toggles
  document.getElementById('ev-file-preview').classList.add('hidden');
  document.getElementById('ev-image-preview').classList.add('hidden');
  document.getElementById('ev-image-preview').innerHTML = '';
  document.getElementById('ev-file-preview').innerHTML = '';

  if (evidenceId) {
    const progs = load('programs', []);
    const p = progs.find(x => x.id === programId);
    const ev = (p?.evidence || []).find(e => e.id === evidenceId);
    if (ev) {
      document.getElementById('ev-title').value = ev.title || '';
      document.getElementById('ev-type').value = ev.type || 'link';
      document.getElementById('ev-link').value = ev.link || '';
      document.getElementById('ev-person').value = ev.person || '';
      document.getElementById('ev-notes').value = ev.notes || '';
    }
  }

  toggleEvidenceInput();
  openModal('evidence-modal');
}

// --- File handling (base64 stored in localStorage) ---
// [SUPABASE] استبدل هذا بـ supabase.storage.from('evidences').upload()
function handleFileSelect(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast('حجم الملف يجب أن لا يتجاوز 5 MB', 'error'); input.value=''; return; }
  const reader = new FileReader();
  reader.onload = e => {
    pendingFileData = { name: file.name, mimeType: file.type, base64: e.target.result };
    const prev = document.getElementById('ev-file-preview');
    prev.classList.remove('hidden');
    prev.innerHTML = `
      <span style="font-size:20px">${getFileIcon(file.name)}</span>
      <span class="file-name">${file.name}</span>
      <span style="font-size:11px;color:var(--text-muted)">${(file.size/1024).toFixed(0)} KB</span>
      <span class="file-remove" onclick="pendingFileData=null;document.getElementById('ev-file-input').value='';document.getElementById('ev-file-preview').classList.add('hidden')">✕</span>
    `;
  };
  reader.readAsDataURL(file);
}

function handleImageSelect(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast('حجم الصورة يجب أن لا يتجاوز 5 MB', 'error'); input.value=''; return; }
  const reader = new FileReader();
  reader.onload = e => {
    pendingImageData = { name: file.name, base64: e.target.result };
    const prev = document.getElementById('ev-image-preview');
    prev.classList.remove('hidden');
    prev.innerHTML = `<img src="${e.target.result}" alt="${file.name}" />`;
  };
  reader.readAsDataURL(file);
}

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'pdf') return '📄';
  if (ext === 'doc' || ext === 'docx') return '📝';
  if (ext === 'xls' || ext === 'xlsx') return '📊';
  return '📎';
}

// --- Save evidence ---
function saveEvidence() {
  const progId = parseInt(document.getElementById('ev-program-id').value);
  const editId = document.getElementById('ev-edit-id').value;
  const title = document.getElementById('ev-title').value.trim();
  const type = document.getElementById('ev-type').value;

  if (!title) { showToast('يرجى إدخال عنوان الشاهد', 'error'); return; }

  // [SUPABASE] insert/update جدول evidences مع upload للملفات
  const evidence = {
    id: editId || ('ev_' + Date.now()),
    title,
    type,
    link: type === 'link' ? (document.getElementById('ev-link').value.trim() || '') : '',
    fileData: type === 'file' ? (pendingFileData ? pendingFileData.base64 : null) : null,
    fileName: type === 'file' ? (pendingFileData ? pendingFileData.name : null) : null,
    imageData: type === 'image' ? (pendingImageData ? pendingImageData.base64 : null) : null,
    imageName: type === 'image' ? (pendingImageData ? pendingImageData.name : null) : null,
    person: document.getElementById('ev-person').value.trim(),
    date: new Date().toISOString().split('T')[0],
    notes: document.getElementById('ev-notes').value.trim(),
  };

  let progs = load('programs', []);
  const pIdx = progs.findIndex(p => p.id === progId);
  if (pIdx === -1) { showToast('البرنامج غير موجود', 'error'); return; }
  if (!progs[pIdx].evidence) progs[pIdx].evidence = [];

  if (editId) {
    const eIdx = progs[pIdx].evidence.findIndex(e => e.id === editId);
    if (eIdx !== -1) progs[pIdx].evidence[eIdx] = evidence;
    else progs[pIdx].evidence.push(evidence);
  } else {
    progs[pIdx].evidence.push(evidence);
  }

  save('programs', progs);
  closeModal('evidence-modal');
  renderPrograms();
  showToast('تم حفظ الشاهد ✅', 'success');
}

// --- Delete evidence ---
function deleteEvidence(progId, evId) {
  if (!confirm('هل تريدين حذف هذا الشاهد؟')) return;
  // [SUPABASE] delete from evidences where id = evId
  let progs = load('programs', []);
  const pIdx = progs.findIndex(p => p.id === progId);
  if (pIdx === -1) return;
  progs[pIdx].evidence = (progs[pIdx].evidence||[]).filter(e => e.id !== evId);
  save('programs', progs);
  renderPrograms();
  showToast('تم حذف الشاهد 🗑️', 'warning');
}

// =========================================================
// ===== DASHBOARD =====
// =========================================================
function renderDashboard() {
  const programs = load('programs', []);
  const initiatives = load('initiatives', []);
  const tasks = load('tasks', []);
  const reports = load('reports', []);
  const kpi = load('kpi', []);

  const allItems = [...programs, ...initiatives];
  const totalProg = programs.length;
  const doneProg = programs.filter(p => calcProgramStatus(p) === 'done').length;
  const avgPct = totalProg ? Math.round(programs.reduce((s,p)=>s+(p.progress||0),0)/totalProg) : 0;
  const lateTasks = tasks.filter(t => t.status !== 'done' && t.due && new Date(t.due) < new Date()).length;
  const avgKPI = kpi.length ? Math.round(kpi.reduce((s,k)=>s+Math.min(100,Math.round((k.achieved/k.target)*100)),0)/kpi.length) : 0;
  const totalEv = programs.reduce((s,p) => s+(p.evidence||[]).length, 0) + reports.length;

  document.getElementById('dashboard-stats').innerHTML = `
    <div class="stat-card"><span class="stat-icon">🗂️</span><span class="stat-number">${totalProg}</span><span class="stat-label">إجمالي البرامج</span></div>
    <div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${doneProg}</span><span class="stat-label">برامج منتهية</span></div>
    <div class="stat-card gold"><span class="stat-icon">📊</span><span class="stat-number">${avgPct}%</span><span class="stat-label">متوسط الإنجاز</span></div>
    <div class="stat-card red"><span class="stat-icon">⏰</span><span class="stat-number">${lateTasks}</span><span class="stat-label">مهام متأخرة</span></div>
    <div class="stat-card purple"><span class="stat-icon">📎</span><span class="stat-number">${totalEv}</span><span class="stat-label">شواهد مرفوعة</span></div>
    <div class="stat-card teal"><span class="stat-icon">🎯</span><span class="stat-number">${avgKPI}%</span><span class="stat-label">متوسط KPI</span></div>
  `;

  // Upcoming tasks
  const upcoming = tasks.filter(t => t.status !== 'done').sort((a,b) => new Date(a.due)-new Date(b.due)).slice(0,5);
  const upEl = document.getElementById('upcoming-tasks-list');
  upEl.innerHTML = upcoming.length ? '<div class="upcoming-list">' + upcoming.map(t => {
    const isLate = t.due && new Date(t.due) < new Date();
    return `<div class="upcoming-item"><div class="upcoming-dot ${t.priority}"></div><div class="upcoming-info"><div class="upcoming-name">${t.name}</div><div class="upcoming-due">${isLate?'⚠️ متأخرة — ':''}${formatDate(t.due)} · ${t.resp}</div></div></div>`;
  }).join('') + '</div>' : '<p style="padding:16px;color:var(--text-muted);text-align:center">لا توجد مهام قادمة</p>';

  // Programs progress
  document.getElementById('initiatives-progress').innerHTML = '<div class="initiatives-progress-list">' + programs.map(p => {
    const pct = p.progress || 0;
    return `<div class="ini-progress-item"><span class="ini-progress-name">${p.name}</span><div class="ini-progress-bar"><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div></div><span class="progress-text">${pct}%</span></div>`;
  }).join('') + '</div>';

  setTimeout(() => drawInitiativesChart(programs), 50);
}

function drawInitiativesChart(programs) {
  const canvas = document.getElementById('initiatives-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const counts = { 'منتهٍ':0, 'جارٍ التنفيذ':0, 'قيد التخطيط':0, 'متأخر':0 };
  programs.forEach(p => {
    const s = calcProgramStatus(p);
    if (s==='done') counts['منتهٍ']++;
    else if (s==='active') counts['جارٍ التنفيذ']++;
    else if (s==='planning') counts['قيد التخطيط']++;
    else if (s==='late') counts['متأخر']++;
  });

  const colors = ['#27ae60','#2e86c1','#95a5a6','#e74c3c'];
  const labels = Object.keys(counts);
  const values = Object.values(counts);
  const total = values.reduce((a,b)=>a+b,0);
  if (total === 0) return;

  const cx = W/2, cy = H/2-15, r = Math.min(W,H)/2-30;
  let startAngle = -Math.PI/2;

  values.forEach((v,i) => {
    if (v === 0) return;
    const slice = (v/total)*2*Math.PI;
    ctx.beginPath(); ctx.moveTo(cx,cy);
    ctx.arc(cx,cy,r,startAngle,startAngle+slice); ctx.closePath();
    ctx.fillStyle = colors[i]; ctx.fill();
    ctx.strokeStyle = 'white'; ctx.lineWidth = 2; ctx.stroke();
    const mid = startAngle+slice/2;
    ctx.fillStyle='white'; ctx.font='bold 12px Tajawal'; ctx.textAlign='center';
    ctx.fillText(v, cx+(r*0.65)*Math.cos(mid), cy+(r*0.65)*Math.sin(mid)+5);
    startAngle += slice;
  });

  let li = 0;
  labels.forEach((l,i) => {
    if (values[i]===0) return;
    const x = 10 + (li%2)*(W/2); const y = H-48+Math.floor(li/2)*20;
    ctx.fillStyle=colors[i]; ctx.fillRect(x,y,12,12);
    ctx.fillStyle='#333'; ctx.font='11px Tajawal'; ctx.textAlign='right';
    ctx.fillText(l+' ('+values[i]+')', x+W/2-18, y+10);
    li++;
  });
}

// =========================================================
// ===== PLAN (INITIATIVES) =====
// =========================================================
let planFilter = 'all', planSearch = '';

function filterPlan(val) { planFilter = val; renderPlan(); }
function searchPlan(val) { planSearch = val.toLowerCase(); renderPlan(); }

function renderPlan() {
  let data = load('initiatives', []);
  if (planFilter !== 'all') {
    const map = { academic:'تحسين التحصيل الدراسي', discipline:'تعزيز الانضباط', professional:'التنمية المهنية', community:'الشراكة المجتمعية', identity:'تعزيز الهوية الوطنية' };
    if (map[planFilter]) data = data.filter(i => i.goal === map[planFilter]);
  }
  if (planSearch) data = data.filter(i => (i.name+i.goal+i.resp+i.desc).toLowerCase().includes(planSearch));

  const tbody = document.getElementById('plan-tbody');
  tbody.innerHTML = data.length ? data.map((ini, idx) => `
    <tr>
      <td>${idx+1}</td>
      <td><span class="badge ${goalBadge(ini.goal)}">${ini.goal}</span></td>
      <td style="font-weight:600">${ini.name}</td>
      <td>${ini.resp}</td>
      <td>${formatDate(ini.start)}</td>
      <td>${formatDate(ini.end)}</td>
      <td><span class="badge ${statusBadge(ini.status)}">${ini.status}</span></td>
      <td><div class="progress-wrap"><div class="progress-bar" style="min-width:70px"><div class="progress-fill" style="width:${ini.progress||0}%"></div></div><span class="progress-text">${ini.progress||0}%</span></div></td>
      <td>${ini.link?`<a href="${ini.link}" target="_blank" class="btn-sm btn-view">📎 عرض</a>`:'<span style="color:var(--text-muted)">—</span>'}</td>
      <td><div style="display:flex;gap:4px"><button class="btn-sm btn-edit" onclick="editInitiative(${ini.id})">✏️</button><button class="btn-sm btn-delete" onclick="deleteInitiative(${ini.id})">🗑️</button></div></td>
    </tr>
  `).join('') : '<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-muted)">لا توجد بيانات</td></tr>';
}

function goalBadge(goal) {
  const m={'تحسين التحصيل الدراسي':'badge-info','تعزيز الانضباط':'badge-warning','التنمية المهنية':'badge-purple','الشراكة المجتمعية':'badge-success','تعزيز الهوية الوطنية':'badge-secondary','متابعة الفاقد التعليمي':'badge-danger'};
  return m[goal]||'badge-secondary';
}
function statusBadge(status) {
  const m={'منجزة':'badge-success','قيد التنفيذ':'badge-info','لم تبدأ':'badge-secondary','متأخرة':'badge-danger'};
  return m[status]||'badge-secondary';
}

function saveInitiative() {
  const editId = document.getElementById('initiative-edit-id').value;
  const ini = {
    id: editId ? parseInt(editId) : Date.now(),
    goal: document.getElementById('ini-goal').value,
    name: document.getElementById('ini-name').value.trim(),
    desc: document.getElementById('ini-desc').value.trim(),
    resp: document.getElementById('ini-resp').value.trim(),
    start: document.getElementById('ini-start').value,
    end: document.getElementById('ini-end').value,
    status: document.getElementById('ini-status').value,
    progress: parseInt(document.getElementById('ini-progress').value)||0,
    link: document.getElementById('ini-link').value.trim(),
  };
  if (!ini.name) { showToast('يرجى إدخال اسم المبادرة','error'); return; }
  // [SUPABASE] insert/update جدول initiatives
  let data = load('initiatives',[]);
  if (editId) { const idx=data.findIndex(i=>i.id===ini.id); if(idx!==-1) data[idx]=ini; }
  else data.push(ini);
  save('initiatives',data);
  closeModal('initiative-modal');
  renderPlan();
  showToast(editId?'تم تعديل المبادرة ✅':'تمت إضافة المبادرة ✅','success');
}

function editInitiative(id) {
  const data = load('initiatives',[]);
  const ini = data.find(i=>i.id===id); if(!ini) return;
  document.getElementById('initiative-edit-id').value=ini.id;
  document.getElementById('ini-goal').value=ini.goal;
  document.getElementById('ini-name').value=ini.name;
  document.getElementById('ini-desc').value=ini.desc||'';
  document.getElementById('ini-resp').value=ini.resp;
  document.getElementById('ini-start').value=ini.start;
  document.getElementById('ini-end').value=ini.end;
  document.getElementById('ini-status').value=ini.status;
  document.getElementById('ini-progress').value=ini.progress||0;
  document.getElementById('ini-link').value=ini.link||'';
  openModal('initiative-modal');
}

function deleteInitiative(id) {
  if(!confirm('هل تريدين حذف هذه المبادرة؟')) return;
  let data=load('initiatives',[]); data=data.filter(i=>i.id!==id);
  save('initiatives',data); renderPlan();
  showToast('تم حذف المبادرة 🗑️','warning');
}

// =========================================================
// ===== KPI =====
// =========================================================
function renderKPI() {
  const kpi = load('kpi',[]);
  document.getElementById('kpi-cards').innerHTML = kpi.map(k => {
    const pct = k.target>0 ? Math.min(100,Math.round((k.achieved/k.target)*100)) : 0;
    const color = pct>=90?'#27ae60':pct>=70?'#f39c12':'#e74c3c';
    const deg = Math.round(pct*3.6);
    return `<div class="kpi-card">
      <div class="kpi-card-name">${k.name}</div>
      <div class="kpi-circle" style="background:conic-gradient(${color} ${deg}deg,#eaecee ${deg}deg)">
        <div class="kpi-circle-inner">${pct}%</div>
      </div>
      <div class="kpi-values">المستهدف: <strong>${k.target} ${k.unit}</strong> · المتحقق: <strong>${k.achieved} ${k.unit}</strong></div>
    </div>`;
  }).join('');

  document.getElementById('kpi-tbody').innerHTML = kpi.map(k => {
    const pct = k.target>0 ? Math.min(100,Math.round((k.achieved/k.target)*100)) : 0;
    const bc = pct>=90?'badge-success':pct>=70?'badge-warning':'badge-danger';
    const bl = pct>=90?'ممتاز':pct>=70?'جيد':'يحتاج تحسين';
    return `<tr><td style="font-weight:600">${k.name}</td><td>${k.target} ${k.unit}</td><td>${k.achieved} ${k.unit}</td>
      <td><div class="progress-wrap"><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div><span class="progress-text">${pct}%</span></div></td>
      <td><span class="badge ${bc}">${bl}</span></td></tr>`;
  }).join('');

  setTimeout(() => drawKPIChart(kpi), 50);
}

function saveKPI() {
  const item = { id:Date.now(), name:document.getElementById('kpi-name').value.trim(), target:parseFloat(document.getElementById('kpi-target').value)||0, achieved:parseFloat(document.getElementById('kpi-achieved').value)||0, unit:document.getElementById('kpi-unit').value.trim()||'%' };
  if (!item.name) { showToast('يرجى إدخال اسم المؤشر','error'); return; }
  let data=load('kpi',[]); data.push(item); save('kpi',data);
  closeModal('kpi-modal'); renderKPI();
  showToast('تم إضافة المؤشر ✅','success');
}

function drawKPIChart(kpi) {
  const canvas = document.getElementById('kpi-chart'); if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth||700; canvas.width=W; const H=300;
  ctx.clearRect(0,0,W,H);
  const padL=20,padR=20,padT=20,padB=80,chartW=W-padL-padR,chartH=H-padT-padB;
  const barW=Math.min(38,chartW/kpi.length/2.5), gap=chartW/kpi.length;
  for(let i=0;i<=5;i++){const y=padT+chartH-(chartH*i/5);ctx.strokeStyle='#eaecee';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(W-padR,y);ctx.stroke();ctx.fillStyle='#aaa';ctx.font='11px Tajawal';ctx.textAlign='left';ctx.fillText((i*20)+'%',padL,y-3);}
  kpi.forEach((k,i)=>{
    const pct=k.target>0?Math.min(100,(k.achieved/k.target)*100):0;
    const x=padL+i*gap+gap/2, barH=(pct/100)*chartH;
    ctx.fillStyle='#dce8f5'; ctx.fillRect(x-barW*0.6,padT,barW*1.2,chartH);
    const color=pct>=90?'#27ae60':pct>=70?'#f39c12':'#e74c3c';
    ctx.fillStyle=color; ctx.fillRect(x-barW/2,padT+chartH-barH,barW,barH);
    ctx.fillStyle='#333';ctx.font='bold 11px Tajawal';ctx.textAlign='center';ctx.fillText(Math.round(pct)+'%',x,padT+chartH-barH-5);
    const words=k.name.split(' ');
    ctx.fillStyle='#555';ctx.font='11px Tajawal';
    ctx.fillText(words.slice(0,2).join(' '),x,H-padB+16);
    if(words.length>2)ctx.fillText(words.slice(2).join(' '),x,H-padB+30);
  });
}

// =========================================================
// ===== TASKS =====
// =========================================================
let taskFilter='all', taskPriorityFilter='all';
function filterTasks(val){taskFilter=val;renderTasks();}
function filterTasksPriority(val){taskPriorityFilter=val;renderTasks();}

function renderTasks() {
  let tasks = load('tasks',[]);
  if(currentUser&&currentUser.role==='teacher') tasks=tasks.filter(t=>t.resp.includes(currentUser.name));
  if(taskFilter==='late') tasks=tasks.filter(t=>t.status!=='done'&&t.due&&new Date(t.due)<new Date());
  else if(taskFilter!=='all') tasks=tasks.filter(t=>t.status===taskFilter);
  if(taskPriorityFilter!=='all') tasks=tasks.filter(t=>t.priority===taskPriorityFilter);

  const pL={high:'عالية',medium:'متوسطة',low:'منخفضة'};
  const sL={pending:'معلقة',inprogress:'قيد التنفيذ',done:'منجزة'};
  const sBM={pending:'badge-warning',inprogress:'badge-info',done:'badge-success'};
  const grid=document.getElementById('tasks-grid');
  grid.innerHTML=tasks.length?tasks.map(t=>{
    const isLate=t.status!=='done'&&t.due&&new Date(t.due)<new Date();
    return `<div class="task-card priority-${t.priority}">
      <div class="task-card-header"><div class="task-title">${t.name}</div><span class="badge ${isLate?'badge-danger':sBM[t.status]}">${isLate?'⚠️ متأخرة':sL[t.status]}</span></div>
      <div class="task-meta"><span>👩‍🏫 ${t.resp}</span><span>📅 ${formatDate(t.due)}</span><span>🔴 ${pL[t.priority]}</span>${t.notes?`<span>📝 ${t.notes}</span>`:''}</div>
      <div class="task-actions">
        <select class="task-status-select" onchange="changeTaskStatus(${t.id},this.value)">
          <option value="pending" ${t.status==='pending'?'selected':''}>معلقة</option>
          <option value="inprogress" ${t.status==='inprogress'?'selected':''}>قيد التنفيذ</option>
          <option value="done" ${t.status==='done'?'selected':''}>منجزة</option>
        </select>
        <button class="btn-sm btn-edit" onclick="editTask(${t.id})">✏️</button>
        <button class="btn-sm btn-delete" onclick="deleteTask(${t.id})">🗑️</button>
      </div>
    </div>`;
  }).join(''):'<p style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px">لا توجد مهام</p>';
}

function changeTaskStatus(id,status){let tasks=load('tasks',[]);const idx=tasks.findIndex(t=>t.id===id);if(idx!==-1){tasks[idx].status=status;save('tasks',tasks);}showToast('تم تحديث الحالة ✅','success');}

function saveTask(){
  const editId=document.getElementById('task-edit-id').value;
  const task={id:editId?parseInt(editId):Date.now(),name:document.getElementById('task-name').value.trim(),resp:document.getElementById('task-resp').value.trim(),due:document.getElementById('task-due').value,priority:document.getElementById('task-priority').value,status:document.getElementById('task-status').value,notes:document.getElementById('task-notes').value.trim()};
  if(!task.name){showToast('يرجى إدخال اسم المهمة','error');return;}
  let data=load('tasks',[]);
  if(editId){const idx=data.findIndex(t=>t.id===task.id);if(idx!==-1)data[idx]=task;}else data.push(task);
  save('tasks',data);closeModal('task-modal');renderTasks();
  showToast(editId?'تم تعديل المهمة ✅':'تمت إضافة المهمة ✅','success');
}

function editTask(id){
  const tasks=load('tasks',[]);const t=tasks.find(t=>t.id===id);if(!t)return;
  document.getElementById('task-edit-id').value=t.id;
  document.getElementById('task-name').value=t.name;
  document.getElementById('task-resp').value=t.resp;
  document.getElementById('task-due').value=t.due||'';
  document.getElementById('task-priority').value=t.priority;
  document.getElementById('task-status').value=t.status;
  document.getElementById('task-notes').value=t.notes||'';
  openModal('task-modal');
}

function deleteTask(id){if(!confirm('هل تريدين حذف هذه المهمة؟'))return;let tasks=load('tasks',[]);tasks=tasks.filter(t=>t.id!==id);save('tasks',tasks);renderTasks();showToast('تم حذف المهمة 🗑️','warning');}

// =========================================================
// ===== REPORTS =====
// =========================================================
function openReportModal() {
  const progs = load('programs',[]);
  const inis = load('initiatives',[]);
  const sel = document.getElementById('rep-initiative');
  sel.innerHTML = [
    ...progs.map(p=>`<option value="${p.name}">📋 ${p.name}</option>`),
    ...inis.map(i=>`<option value="${i.name}">📌 ${i.name}</option>`)
  ].join('');
  ['rep-title','rep-person','rep-link','rep-notes'].forEach(f=>{const el=document.getElementById(f);if(el)el.value='';});
  openModal('report-modal');
}

function renderReports() {
  const reports=load('reports',[]);
  const typeIcon={'صورة':'📷','PDF':'📄','Word':'📝','Excel':'📊','Google Drive':'☁️','YouTube':'🎥','رابط خارجي':'🔗'};
  const tbody=document.getElementById('reports-tbody');
  tbody.innerHTML=reports.length?reports.map((r,idx)=>`
    <tr>
      <td>${idx+1}</td>
      <td style="font-weight:600">${r.title}</td>
      <td><span class="badge badge-info">${typeIcon[r.type]||'📎'} ${r.type}</span></td>
      <td>${r.initiative}</td>
      <td>${r.person}</td>
      <td>${formatDate(r.date)}</td>
      <td>${r.link?`<a href="${r.link}" target="_blank" class="btn-sm btn-view">🔗 فتح</a>`:'—'}</td>
      <td><button class="btn-sm btn-delete" onclick="deleteReport(${r.id})">🗑️</button></td>
    </tr>
  `).join(''):'<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">لا توجد شواهد مرفوعة</td></tr>';
}

function saveReport(){
  const report={id:Date.now(),title:document.getElementById('rep-title').value.trim(),type:document.getElementById('rep-type').value,initiative:document.getElementById('rep-initiative').value,person:document.getElementById('rep-person').value.trim(),date:new Date().toISOString().split('T')[0],link:document.getElementById('rep-link').value.trim(),notes:document.getElementById('rep-notes').value.trim()};
  if(!report.title){showToast('يرجى إدخال عنوان الشاهد','error');return;}
  let data=load('reports',[]);data.push(report);save('reports',data);
  closeModal('report-modal');renderReports();
  showToast('تم رفع الشاهد ✅','success');
}

function deleteReport(id){if(!confirm('هل تريدين حذف هذا الشاهد؟'))return;let data=load('reports',[]);data=data.filter(r=>r.id!==id);save('reports',data);renderReports();showToast('تم حذف الشاهد 🗑️','warning');}

// =========================================================
// ===== TEACHERS =====
// =========================================================
function renderTeachers(){
  const teachers=load('teachers',[]);
  document.getElementById('teachers-tbody').innerHTML=teachers.map(t=>{
    const pct=t.assigned>0?Math.round((t.done/t.assigned)*100):0;
    const bc=pct>=90?'badge-success':pct>=70?'badge-warning':'badge-danger';
    return `<tr>
      <td style="font-weight:700">${t.name}</td>
      <td style="text-align:center">${t.assigned}</td>
      <td style="text-align:center">${t.done}</td>
      <td><div class="progress-wrap"><div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div><span class="progress-text">${pct}%</span></div></td>
      <td>${formatDate(t.lastReport)}</td>
      <td style="font-size:13px">${t.notes||'<span style="color:#ccc">—</span>'}</td>
      <td><button class="btn-sm btn-note" onclick="openTeacherNote(${t.id})">📝 ملاحظة</button></td>
    </tr>`;
  }).join('');
}

function openTeacherNote(id){
  const teachers=load('teachers',[]);const t=teachers.find(t=>t.id===id);if(!t)return;
  document.getElementById('teacher-note-id').value=id;
  document.getElementById('teacher-note-text').value=t.notes||'';
  openModal('teacher-note-modal');
}

function saveTeacherNote(){
  const id=parseInt(document.getElementById('teacher-note-id').value);
  const note=document.getElementById('teacher-note-text').value.trim();
  let teachers=load('teachers',[]);
  const idx=teachers.findIndex(t=>t.id===id);
  if(idx!==-1){teachers[idx].notes=note;save('teachers',teachers);}
  closeModal('teacher-note-modal');renderTeachers();
  showToast('تم حفظ الملاحظة ✅','success');
}

// =========================================================
// ===== CALENDAR =====
// =========================================================
function prevMonth(){calendarMonth--;if(calendarMonth<0){calendarMonth=11;calendarYear--;}renderCalendar();}
function nextMonth(){calendarMonth++;if(calendarMonth>11){calendarMonth=0;calendarYear++;}renderCalendar();}

function renderCalendar(){
  const monthNames=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  document.getElementById('calendar-month-label').textContent=monthNames[calendarMonth]+' '+calendarYear;
  const tasks=load('tasks',[]);
  const programs=load('programs',[]);
  const today=new Date();
  const firstDay=new Date(calendarYear,calendarMonth,1).getDay();
  const daysInMonth=new Date(calendarYear,calendarMonth+1,0).getDate();
  const events={};

  tasks.forEach(t=>{
    if(!t.due)return;
    const d=new Date(t.due);
    if(d.getFullYear()===calendarYear&&d.getMonth()===calendarMonth){
      const day=d.getDate();
      if(!events[day])events[day]=[];
      events[day].push({text:t.name,cls:t.status!=='done'&&d<today?'late-event':'task-event'});
    }
  });

  programs.forEach(p=>{
    if(p.end){
      const d=new Date(p.end);
      if(d.getFullYear()===calendarYear&&d.getMonth()===calendarMonth){
        const day=d.getDate();
        if(!events[day])events[day]=[];
        events[day].push({text:'📋 '+p.name,cls:'ini-event'});
      }
    }
  });

  const dayNames=['أحد','اثنين','ثلاثاء','أربعاء','خميس','جمعة','سبت'];
  let html='<div class="calendar-grid"><div class="calendar-header-row">'+dayNames.map(d=>`<div class="calendar-day-name">${d}</div>`).join('')+'</div><div class="calendar-body">';
  let col=0;
  for(let i=0;i<firstDay;i++){html+='<div class="calendar-cell empty"></div>';col++;}
  for(let day=1;day<=daysInMonth;day++){
    const isToday=today.getFullYear()===calendarYear&&today.getMonth()===calendarMonth&&today.getDate()===day;
    const dayEvents=events[day]||[];
    html+=`<div class="calendar-cell${isToday?' today':''}"><div class="calendar-date${isToday?' today-num':''}">${day}</div>${dayEvents.slice(0,3).map(e=>`<div class="calendar-event ${e.cls}" title="${e.text}">${e.text}</div>`).join('')}${dayEvents.length>3?`<div style="font-size:10px;color:var(--text-muted)">+${dayEvents.length-3}</div>`:''}</div>`;
    col++;
  }
  const rem=(7-(col%7))%7;
  for(let i=0;i<rem;i++)html+='<div class="calendar-cell empty"></div>';
  html+='</div></div>';
  document.getElementById('calendar-container').innerHTML=html;
}

// =========================================================
// ===== STATS =====
// =========================================================
function renderStats(){
  const programs=load('programs',[]);
  const tasks=load('tasks',[]);
  const reports=load('reports',[]);
  const kpi=load('kpi',[]);
  const avgPct=programs.length?Math.round(programs.reduce((s,p)=>s+(p.progress||0),0)/programs.length):0;
  const doneTasks=tasks.filter(t=>t.status==='done').length;
  const lateTasks=tasks.filter(t=>t.status!=='done'&&t.due&&new Date(t.due)<new Date()).length;
  const topProgs=[...programs].sort((a,b)=>(b.progress||0)-(a.progress||0)).slice(0,3);
  const totalEv=programs.reduce((s,p)=>s+(p.evidence||[]).length,0);

  document.getElementById('stats-cards').innerHTML=`
    <div class="stat-card"><span class="stat-icon">📊</span><span class="stat-number">${avgPct}%</span><span class="stat-label">متوسط إنجاز البرامج</span></div>
    <div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${doneTasks}</span><span class="stat-label">مهام منجزة</span></div>
    <div class="stat-card red"><span class="stat-icon">⚠️</span><span class="stat-number">${lateTasks}</span><span class="stat-label">مهام متأخرة</span></div>
    <div class="stat-card purple"><span class="stat-icon">📎</span><span class="stat-number">${reports.length+totalEv}</span><span class="stat-label">شواهد مرفوعة</span></div>
    <div class="stat-card gold"><span class="stat-icon">🎯</span><span class="stat-number">${kpi.length}</span><span class="stat-label">مؤشرات الأداء</span></div>
    <div class="stat-card teal"><span class="stat-icon">📋</span><span class="stat-number">${programs.filter(p=>calcProgramStatus(p)==='done').length}</span><span class="stat-label">برامج منتهية</span></div>
  `;

  document.getElementById('top-initiatives').innerHTML=topProgs.map((p,idx)=>`
    <div class="top-initiative-item"><span>${['🥇','🥈','🥉'][idx]} ${p.name}</span><span style="font-weight:700;color:var(--primary)">${p.progress}%</span></div>
  `).join('');

  setTimeout(()=>{drawTasksPieChart(tasks);drawCompareChart(programs);},50);
}

function drawTasksPieChart(tasks){
  const canvas=document.getElementById('tasks-pie-chart');if(!canvas)return;
  const ctx=canvas.getContext('2d');const W=canvas.width,H=canvas.height;ctx.clearRect(0,0,W,H);
  const counts={'منجزة':tasks.filter(t=>t.status==='done').length,'قيد التنفيذ':tasks.filter(t=>t.status==='inprogress').length,'معلقة':tasks.filter(t=>t.status==='pending').length,'متأخرة':tasks.filter(t=>t.status!=='done'&&t.due&&new Date(t.due)<new Date()).length};
  const colors=['#27ae60','#2e86c1','#f39c12','#e74c3c'],labels=Object.keys(counts),values=Object.values(counts),total=values.reduce((a,b)=>a+b,0);
  if(!total)return;
  const cx=W/2,cy=H/2-20,r=Math.min(W,H)/2-40;let startAngle=-Math.PI/2;
  values.forEach((v,i)=>{
    if(!v)return;
    const slice=(v/total)*2*Math.PI;
    ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,startAngle,startAngle+slice);ctx.closePath();
    ctx.fillStyle=colors[i];ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=2;ctx.stroke();
    const mid=startAngle+slice/2;ctx.fillStyle='white';ctx.font='bold 12px Tajawal';ctx.textAlign='center';ctx.fillText(v,cx+(r*0.65)*Math.cos(mid),cy+(r*0.65)*Math.sin(mid)+5);
    startAngle+=slice;
  });
  const legendY=H-28;
  labels.forEach((l,i)=>{
    const x=(i%2)*(W/2)+10,y=legendY-Math.floor(1-i/2)*18;
    ctx.fillStyle=colors[i];ctx.fillRect(x,y,11,11);
    ctx.fillStyle='#444';ctx.font='11px Tajawal';ctx.textAlign='right';
    ctx.fillText(l+' ('+values[i]+')',x+W/2-14,y+9);
  });
}

function drawCompareChart(programs){
  const canvas=document.getElementById('compare-chart');if(!canvas)return;
  const ctx=canvas.getContext('2d');const W=canvas.offsetWidth||700;canvas.width=W;const H=280;ctx.clearRect(0,0,W,H);
  const padL=20,padR=20,padT=20,padB=70,chartW=W-padL-padR,chartH=H-padT-padB;
  const barW=Math.min(32,chartW/programs.length/3),gap=chartW/programs.length;
  for(let i=0;i<=5;i++){const y=padT+chartH-(chartH*i/5);ctx.strokeStyle='#eaecee';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(W-padR,y);ctx.stroke();ctx.fillStyle='#aaa';ctx.font='11px Tajawal';ctx.textAlign='left';ctx.fillText((i*20)+'%',padL,y-2);}
  programs.forEach((p,i)=>{
    const pct=p.progress||0,x=padL+i*gap+gap/2,barH=(pct/100)*chartH;
    ctx.fillStyle='#dce8f5';ctx.fillRect(x-barW*1.1,padT,barW*2.2,chartH);
    const color=pct>=90?'#27ae60':pct>=60?'#2e86c1':pct>=30?'#f39c12':'#e74c3c';
    ctx.fillStyle=color;ctx.fillRect(x-barW/2,padT+chartH-barH,barW,barH);
    ctx.fillStyle='#333';ctx.font='bold 11px Tajawal';ctx.textAlign='center';ctx.fillText(pct+'%',x,padT+chartH-barH-5);
    ctx.fillStyle='#666';ctx.font='11px Tajawal';
    const short=p.name.length>7?p.name.substring(0,7)+'..':p.name;
    ctx.fillText(short,x,H-padB+16);
  });
}

// ===== HELPERS =====
function formatDate(d){
  if(!d)return'—';
  try{return new Date(d).toLocaleDateString('ar-SA',{year:'numeric',month:'short',day:'numeric'});}catch{return d;}
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded',()=>{
  initData();
  calendarMonth=new Date().getMonth();
  calendarYear=new Date().getFullYear();
});
