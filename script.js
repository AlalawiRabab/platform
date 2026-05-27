/* ===== SCHOOL OPERATIONAL PLAN - script.js ===== */

// ===== GLOBAL STATE =====
let currentUser = null;
let currentRole = 'principal';
let calendarMonth = new Date().getMonth();
let calendarYear = new Date().getFullYear();

// ===== DEMO DATA =====
const DEMO_INITIATIVES = [
  { id: 1, goal: 'تحسين التحصيل الدراسي', name: 'تفعيل الاختبارات القصيرة', desc: 'تطبيق اختبارات قصيرة أسبوعية لجميع المواد لقياس مستوى الطالبات', resp: 'أ. نورة العتيبي', start: '2024-09-01', end: '2025-05-30', status: 'قيد التنفيذ', progress: 75, link: 'https://drive.google.com/example1' },
  { id: 2, goal: 'تحسين التحصيل الدراسي', name: 'متابعة الفاقد التعليمي', desc: 'رصد ومتابعة الطالبات ذوات الفاقد التعليمي وتقديم الدعم المناسب', resp: 'أ. هند القحطاني', start: '2024-09-15', end: '2025-05-15', status: 'قيد التنفيذ', progress: 60, link: '' },
  { id: 3, goal: 'تعزيز الانضباط', name: 'برنامج الانضباط المدرسي', desc: 'تطبيق برنامج شامل لتعزيز الانضباط المدرسي وترسيخ قيم النظام', resp: 'أ. سلمى الزهراني', start: '2024-09-01', end: '2025-06-01', status: 'قيد التنفيذ', progress: 80, link: 'https://drive.google.com/example3' },
  { id: 4, goal: 'التنمية المهنية', name: 'التنمية المهنية للمعلمات', desc: 'تنفيذ برامج تدريبية لتطوير مهارات المعلمات في التقنية والتدريس', resp: 'أ. ريم الحربي', start: '2024-10-01', end: '2025-04-30', status: 'منجزة', progress: 100, link: 'https://drive.google.com/example4' },
  { id: 5, goal: 'الشراكة المجتمعية', name: 'تفعيل الشراكة المجتمعية', desc: 'بناء شراكات فعّالة مع مؤسسات المجتمع لدعم العملية التعليمية', resp: 'أ. مها الشمري', start: '2024-11-01', end: '2025-03-31', status: 'منجزة', progress: 100, link: '' },
  { id: 6, goal: 'تعزيز الهوية الوطنية', name: 'تعزيز الهوية الوطنية', desc: 'تنفيذ فعاليات وأنشطة تعزز الانتماء الوطني وقيم رؤية 2030', resp: 'أ. فاطمة الدوسري', start: '2024-09-22', end: '2025-02-23', status: 'منجزة', progress: 100, link: 'https://drive.google.com/example6' },
  { id: 7, goal: 'تحسين التحصيل الدراسي', name: 'التعلم التعاوني', desc: 'تطبيق استراتيجيات التعلم التعاوني في الفصول الدراسية', resp: 'أ. نورة العتيبي', start: '2024-10-15', end: '2025-05-15', status: 'قيد التنفيذ', progress: 55, link: '' },
  { id: 8, goal: 'متابعة الفاقد التعليمي', name: 'حلقات الدعم الأكاديمي', desc: 'تنظيم حلقات دعم أسبوعية للطالبات المتعثرات دراسياً', resp: 'أ. هند القحطاني', start: '2024-09-20', end: '2025-05-20', status: 'قيد التنفيذ', progress: 45, link: '' },
];

const DEMO_TASKS = [
  { id: 1, name: 'إعداد جدول الاختبارات القصيرة', resp: 'أ. نورة العتيبي', due: '2025-01-15', priority: 'high', status: 'done', notes: 'تم الإعداد والاعتماد من القيادة' },
  { id: 2, name: 'رصد نتائج الاختبارات التشخيصية', resp: 'أ. هند القحطاني', due: '2025-01-20', priority: 'high', status: 'done', notes: '' },
  { id: 3, name: 'تنفيذ ورشة التعلم التعاوني', resp: 'أ. ريم الحربي', due: '2025-02-10', priority: 'medium', status: 'inprogress', notes: 'الورشة مقررة في الثامن من فبراير' },
  { id: 4, name: 'إعداد تقرير الفاقد التعليمي', resp: 'أ. هند القحطاني', due: '2025-02-28', priority: 'high', status: 'pending', notes: '' },
  { id: 5, name: 'تنظيم فعالية اليوم الوطني', resp: 'أ. فاطمة الدوسري', due: '2024-09-22', priority: 'high', status: 'done', notes: 'تم تنفيذها بنجاح' },
  { id: 6, name: 'متابعة الطالبات المتعثرات', resp: 'أ. سلمى الزهراني', due: '2025-03-15', priority: 'medium', status: 'inprogress', notes: '' },
  { id: 7, name: 'تقرير الزيارات الصفية', resp: 'أ. مها الشمري', due: '2025-01-31', priority: 'low', status: 'done', notes: '' },
  { id: 8, name: 'إعداد خطة الأنشطة الفصلية', resp: 'أ. فاطمة الدوسري', due: '2025-03-01', priority: 'medium', status: 'pending', notes: '' },
];

const DEMO_KPI = [
  { id: 1, name: 'نسبة النجاح العامة', target: 95, achieved: 91, unit: '%' },
  { id: 2, name: 'نسبة الحضور اليومي', target: 98, achieved: 96.5, unit: '%' },
  { id: 3, name: 'عدد الاختبارات القصيرة المنفذة', target: 80, achieved: 68, unit: 'اختبار' },
  { id: 4, name: 'نسبة رضا أولياء الأمور', target: 90, achieved: 87, unit: '%' },
  { id: 5, name: 'عدد الزيارات الصفية', target: 120, achieved: 105, unit: 'زيارة' },
  { id: 6, name: 'عدد الطالبات المستفيدات من الدعم', target: 50, achieved: 43, unit: 'طالبة' },
];

const DEMO_REPORTS = [
  { id: 1, title: 'نتائج الاختبارات القصيرة - الفصل الأول', type: 'PDF', initiative: 'تفعيل الاختبارات القصيرة', person: 'أ. نورة العتيبي', date: '2024-11-15', link: 'https://drive.google.com/example1', notes: '' },
  { id: 2, title: 'صور فعالية اليوم الوطني', type: 'صورة', initiative: 'تعزيز الهوية الوطنية', person: 'أ. فاطمة الدوسري', date: '2024-09-25', link: 'https://drive.google.com/example2', notes: '' },
  { id: 3, title: 'تقرير ورشة التنمية المهنية', type: 'Google Drive', initiative: 'التنمية المهنية للمعلمات', person: 'أ. ريم الحربي', date: '2024-12-10', link: 'https://drive.google.com/example3', notes: 'تضمنت الورشة 15 معلمة' },
  { id: 4, title: 'مقطع فيديو الشراكة المجتمعية', type: 'فيديو', initiative: 'تفعيل الشراكة المجتمعية', person: 'أ. مها الشمري', date: '2024-12-20', link: 'https://drive.google.com/example4', notes: '' },
];

const DEMO_TEACHERS = [
  { id: 1, name: 'أ. نورة العتيبي', assigned: 12, done: 10, lastReport: '2024-12-15', notes: '' },
  { id: 2, name: 'أ. هند القحطاني', assigned: 8, done: 5, lastReport: '2024-12-10', notes: '' },
  { id: 3, name: 'أ. سلمى الزهراني', assigned: 10, done: 9, lastReport: '2024-12-20', notes: '' },
  { id: 4, name: 'أ. ريم الحربي', assigned: 6, done: 6, lastReport: '2024-12-12', notes: '' },
  { id: 5, name: 'أ. مها الشمري', assigned: 7, done: 6, lastReport: '2024-12-18', notes: '' },
  { id: 6, name: 'أ. فاطمة الدوسري', assigned: 9, done: 8, lastReport: '2024-12-22', notes: '' },
];

const DEMO_SETTINGS = {
  schoolName: 'مدرسة النور الابتدائية',
  year: '١٤٤٦ / ١٤٤٧هـ',
  principal: 'أ. سارة العتيبي',
  region: 'منطقة المدينة المنورة'
};

// ===== STORAGE HELPERS =====
function save(key, data) { localStorage.setItem('sop_' + key, JSON.stringify(data)); }
function load(key, def) {
  try {
    const v = localStorage.getItem('sop_' + key);
    return v ? JSON.parse(v) : def;
  } catch { return def; }
}

// ===== INIT DATA =====
function initData() {
  if (!localStorage.getItem('sop_initiatives')) save('initiatives', DEMO_INITIATIVES);
  if (!localStorage.getItem('sop_tasks')) save('tasks', DEMO_TASKS);
  if (!localStorage.getItem('sop_kpi')) save('kpi', DEMO_KPI);
  if (!localStorage.getItem('sop_reports')) save('reports', DEMO_REPORTS);
  if (!localStorage.getItem('sop_teachers')) save('teachers', DEMO_TEACHERS);
  if (!localStorage.getItem('sop_settings')) save('settings', DEMO_SETTINGS);
}

function resetToDemo() {
  if (!confirm('سيتم إعادة تحميل جميع البيانات التجريبية. هل أنت متأكدة؟')) return;
  save('initiatives', DEMO_INITIATIVES);
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
  ['initiatives','tasks','kpi','reports','teachers','settings'].forEach(k => localStorage.removeItem('sop_' + k));
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

  const roleNames = { principal: 'مديرة المدرسة', vice: 'وكيلة', teacher: 'معلمة', admin: 'إدارية' };
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

  // Show/hide nav items based on role
  document.querySelectorAll('.nav-item').forEach(item => {
    const hasClass = item.classList.contains('nav-' + role) || item.dataset.section === 'dashboard';
    if (role === 'principal') {
      item.style.display = 'flex';
    } else {
      item.style.display = hasClass ? 'flex' : 'none';
    }
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
    dashboard: 'لوحة التحكم', plan: 'الخطة التشغيلية', kpi: 'مؤشرات الأداء',
    tasks: 'إدارة المهام', reports: 'التقارير والشواهد', teachers: 'متابعة المعلمات',
    calendar: 'التقويم الزمني', stats: 'الإحصائيات', settings: 'الإعدادات'
  };
  document.getElementById('section-title').textContent = titles[name] || '';

  // Close sidebar on mobile
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
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
  if (id === 'report-modal') populateReportInitiatives();
  if (id === 'initiative-modal') {
    document.getElementById('initiative-edit-id').value = '';
    ['ini-goal','ini-name','ini-desc','ini-resp','ini-start','ini-end','ini-link'].forEach(f => {
      const el = document.getElementById(f);
      if (el) el.value = '';
    });
    document.getElementById('ini-status').value = 'لم تبدأ';
    document.getElementById('ini-progress').value = '';
  }
  if (id === 'task-modal') {
    document.getElementById('task-edit-id').value = '';
    ['task-name','task-resp','task-due','task-notes'].forEach(f => {
      const el = document.getElementById(f);
      if (el) el.value = '';
    });
    document.getElementById('task-priority').value = 'high';
    document.getElementById('task-status').value = 'pending';
  }
}

function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

function populateReportInitiatives() {
  const ini = load('initiatives', []);
  const sel = document.getElementById('rep-initiative');
  sel.innerHTML = ini.map(i => `<option value="${i.name}">${i.name}</option>`).join('');
}

// ===== DASHBOARD =====
function renderDashboard() {
  const initiatives = load('initiatives', []);
  const tasks = load('tasks', []);
  const reports = load('reports', []);
  const kpi = load('kpi', []);

  const totalIni = initiatives.length;
  const completedIni = initiatives.filter(i => i.status === 'منجزة').length;
  const avgProgress = totalIni ? Math.round(initiatives.reduce((s,i) => s + (i.progress||0), 0) / totalIni) : 0;
  const lateTasks = tasks.filter(t => t.status !== 'done' && t.due && new Date(t.due) < new Date()).length;
  const doneTasks = tasks.filter(t => t.status === 'done').length;
  const avgKPI = kpi.length ? Math.round(kpi.reduce((s,k) => s + Math.min(100, Math.round((k.achieved/k.target)*100)), 0) / kpi.length) : 0;

  const statsEl = document.getElementById('dashboard-stats');
  statsEl.innerHTML = `
    <div class="stat-card"><span class="stat-icon">📋</span><span class="stat-number">${totalIni}</span><span class="stat-label">إجمالي المبادرات</span></div>
    <div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${completedIni}</span><span class="stat-label">مبادرات منجزة</span></div>
    <div class="stat-card gold"><span class="stat-icon">📊</span><span class="stat-number">${avgProgress}%</span><span class="stat-label">متوسط الإنجاز</span></div>
    <div class="stat-card red"><span class="stat-icon">⏰</span><span class="stat-number">${lateTasks}</span><span class="stat-label">مهام متأخرة</span></div>
    <div class="stat-card purple"><span class="stat-icon">📁</span><span class="stat-number">${reports.length}</span><span class="stat-label">تقارير مرفوعة</span></div>
    <div class="stat-card teal"><span class="stat-icon">🎯</span><span class="stat-number">${avgKPI}%</span><span class="stat-label">متوسط KPI</span></div>
  `;

  // Upcoming tasks
  const upcoming = tasks.filter(t => t.status !== 'done').sort((a,b) => new Date(a.due) - new Date(b.due)).slice(0,5);
  const upEl = document.getElementById('upcoming-tasks-list');
  if (upcoming.length === 0) {
    upEl.innerHTML = '<p style="padding:16px;color:var(--text-muted);text-align:center">لا توجد مهام قادمة</p>';
  } else {
    upEl.innerHTML = '<div class="upcoming-list">' + upcoming.map(t => {
      const isLate = t.due && new Date(t.due) < new Date();
      return `<div class="upcoming-item">
        <div class="upcoming-dot ${t.priority}"></div>
        <div class="upcoming-info">
          <div class="upcoming-name">${t.name}</div>
          <div class="upcoming-due">${isLate ? '⚠️ متأخرة — ' : ''}${formatDate(t.due)} · ${t.resp}</div>
        </div>
      </div>`;
    }).join('') + '</div>';
  }

  // Initiatives progress
  const progEl = document.getElementById('initiatives-progress');
  progEl.innerHTML = '<div class="initiatives-progress-list">' + initiatives.map(i => `
    <div class="ini-progress-item">
      <span class="ini-progress-name">${i.name}</span>
      <div class="ini-progress-bar">
        <div class="progress-bar"><div class="progress-fill" style="width:${i.progress||0}%"></div></div>
      </div>
      <span class="progress-text">${i.progress||0}%</span>
    </div>
  `).join('') + '</div>';

  // Chart - initiatives by status
  setTimeout(() => drawInitiativesChart(initiatives), 50);
}

function drawInitiativesChart(initiatives) {
  const canvas = document.getElementById('initiatives-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const counts = {
    'منجزة': initiatives.filter(i => i.status === 'منجزة').length,
    'قيد التنفيذ': initiatives.filter(i => i.status === 'قيد التنفيذ').length,
    'لم تبدأ': initiatives.filter(i => i.status === 'لم تبدأ').length,
    'متأخرة': initiatives.filter(i => i.status === 'متأخرة').length,
  };

  const colors = ['#27ae60','#2e86c1','#95a5a6','#e74c3c'];
  const labels = Object.keys(counts);
  const values = Object.values(counts);
  const total = values.reduce((a,b) => a+b, 0);
  if (total === 0) return;

  const cx = W/2, cy = H/2 - 15, r = Math.min(W,H)/2 - 30;
  let startAngle = -Math.PI / 2;

  values.forEach((v, i) => {
    if (v === 0) return;
    const slice = (v / total) * 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, startAngle + slice);
    ctx.closePath();
    ctx.fillStyle = colors[i];
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label
    const mid = startAngle + slice / 2;
    const lx = cx + (r * 0.65) * Math.cos(mid);
    const ly = cy + (r * 0.65) * Math.sin(mid);
    ctx.fillStyle = 'white';
    ctx.font = 'bold 13px Tajawal';
    ctx.textAlign = 'center';
    ctx.fillText(v, lx, ly + 5);

    startAngle += slice;
  });

  // Legend
  const legendY = H - 50;
  const legendX = 10;
  labels.forEach((l, i) => {
    if (values[i] === 0) return;
    const x = legendX + (i % 2) * (W/2);
    const y = legendY + Math.floor(i/2) * 22;
    ctx.fillStyle = colors[i];
    ctx.fillRect(x, y, 14, 14);
    ctx.fillStyle = '#333';
    ctx.font = '12px Tajawal';
    ctx.textAlign = 'right';
    ctx.fillText(l + ' (' + values[i] + ')', x + W/2 - 20, y + 11);
  });
}

// ===== PLAN SECTION =====
let planFilter = 'all';
let planSearch = '';

function filterPlan(val) { planFilter = val; renderPlan(); }
function searchPlan(val) { planSearch = val.toLowerCase(); renderPlan(); }

function renderPlan() {
  let data = load('initiatives', []);
  if (planFilter !== 'all') {
    const map = { academic: 'تحسين التحصيل الدراسي', discipline: 'تعزيز الانضباط', professional: 'التنمية المهنية', community: 'الشراكة المجتمعية', identity: 'تعزيز الهوية الوطنية' };
    if (map[planFilter]) data = data.filter(i => i.goal === map[planFilter]);
  }
  if (planSearch) data = data.filter(i => (i.name+i.goal+i.resp+i.desc).toLowerCase().includes(planSearch));

  const tbody = document.getElementById('plan-tbody');
  if (data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-muted)">لا توجد بيانات</td></tr>';
    return;
  }
  tbody.innerHTML = data.map((ini, idx) => `
    <tr>
      <td>${idx+1}</td>
      <td><span class="badge ${goalBadge(ini.goal)}">${ini.goal}</span></td>
      <td style="font-weight:600">${ini.name}</td>
      <td>${ini.resp}</td>
      <td>${formatDate(ini.start)}</td>
      <td>${formatDate(ini.end)}</td>
      <td><span class="badge ${statusBadge(ini.status)}">${ini.status}</span></td>
      <td>
        <div class="progress-wrap">
          <div class="progress-bar" style="min-width:70px"><div class="progress-fill" style="width:${ini.progress||0}%"></div></div>
          <span class="progress-text">${ini.progress||0}%</span>
        </div>
      </td>
      <td>${ini.link ? `<a href="${ini.link}" target="_blank" class="btn-sm btn-view">📎 عرض</a>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>
        <div style="display:flex;gap:4px">
          <button class="btn-sm btn-edit" onclick="editInitiative(${ini.id})">✏️</button>
          <button class="btn-sm btn-delete" onclick="deleteInitiative(${ini.id})">🗑️</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function goalBadge(goal) {
  const m = { 'تحسين التحصيل الدراسي': 'badge-info', 'تعزيز الانضباط': 'badge-warning', 'التنمية المهنية': 'badge-purple', 'الشراكة المجتمعية': 'badge-success', 'تعزيز الهوية الوطنية': 'badge-secondary', 'متابعة الفاقد التعليمي': 'badge-danger' };
  return m[goal] || 'badge-secondary';
}

function statusBadge(status) {
  const m = { 'منجزة': 'badge-success', 'قيد التنفيذ': 'badge-info', 'لم تبدأ': 'badge-secondary', 'متأخرة': 'badge-danger' };
  return m[status] || 'badge-secondary';
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
    progress: parseInt(document.getElementById('ini-progress').value) || 0,
    link: document.getElementById('ini-link').value.trim(),
  };
  if (!ini.name) { showToast('يرجى إدخال اسم المبادرة', 'error'); return; }
  let data = load('initiatives', []);
  if (editId) {
    const idx = data.findIndex(i => i.id === ini.id);
    if (idx !== -1) data[idx] = ini;
  } else {
    data.push(ini);
  }
  save('initiatives', data);
  closeModal('initiative-modal');
  renderPlan();
  showToast(editId ? 'تم تعديل المبادرة ✅' : 'تمت إضافة المبادرة ✅', 'success');
}

function editInitiative(id) {
  const data = load('initiatives', []);
  const ini = data.find(i => i.id === id);
  if (!ini) return;
  document.getElementById('initiative-edit-id').value = ini.id;
  document.getElementById('ini-goal').value = ini.goal;
  document.getElementById('ini-name').value = ini.name;
  document.getElementById('ini-desc').value = ini.desc || '';
  document.getElementById('ini-resp').value = ini.resp;
  document.getElementById('ini-start').value = ini.start;
  document.getElementById('ini-end').value = ini.end;
  document.getElementById('ini-status').value = ini.status;
  document.getElementById('ini-progress').value = ini.progress || 0;
  document.getElementById('ini-link').value = ini.link || '';
  document.getElementById('initiative-modal').classList.remove('hidden');
}

function deleteInitiative(id) {
  if (!confirm('هل تريدين حذف هذه المبادرة؟')) return;
  let data = load('initiatives', []);
  data = data.filter(i => i.id !== id);
  save('initiatives', data);
  renderPlan();
  showToast('تم حذف المبادرة 🗑️', 'warning');
}

// ===== KPI SECTION =====
function renderKPI() {
  const kpi = load('kpi', []);
  const cardsEl = document.getElementById('kpi-cards');
  cardsEl.innerHTML = kpi.map(k => {
    const pct = k.target > 0 ? Math.min(100, Math.round((k.achieved / k.target) * 100)) : 0;
    const color = pct >= 90 ? '#27ae60' : pct >= 70 ? '#f39c12' : '#e74c3c';
    const deg = Math.round(pct * 3.6);
    return `
      <div class="kpi-card">
        <div class="kpi-card-name">${k.name}</div>
        <div class="kpi-circle" style="background: conic-gradient(${color} ${deg}deg, #eaecee ${deg}deg)">
          <div class="kpi-circle-inner">${pct}%</div>
        </div>
        <div class="kpi-values">المستهدف: <strong>${k.target} ${k.unit}</strong> · المتحقق: <strong>${k.achieved} ${k.unit}</strong></div>
      </div>
    `;
  }).join('');

  const tbody = document.getElementById('kpi-tbody');
  tbody.innerHTML = kpi.map(k => {
    const pct = k.target > 0 ? Math.min(100, Math.round((k.achieved / k.target) * 100)) : 0;
    let statusBadgeClass = pct >= 90 ? 'badge-success' : pct >= 70 ? 'badge-warning' : 'badge-danger';
    let statusLabel = pct >= 90 ? 'ممتاز' : pct >= 70 ? 'جيد' : 'يحتاج تحسين';
    return `<tr>
      <td style="font-weight:600">${k.name}</td>
      <td>${k.target} ${k.unit}</td>
      <td>${k.achieved} ${k.unit}</td>
      <td>
        <div class="progress-wrap">
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          <span class="progress-text">${pct}%</span>
        </div>
      </td>
      <td><span class="badge ${statusBadgeClass}">${statusLabel}</span></td>
    </tr>`;
  }).join('');

  setTimeout(() => drawKPIChart(kpi), 50);
}

function saveKPI() {
  const kpiItem = {
    id: Date.now(),
    name: document.getElementById('kpi-name').value.trim(),
    target: parseFloat(document.getElementById('kpi-target').value) || 0,
    achieved: parseFloat(document.getElementById('kpi-achieved').value) || 0,
    unit: document.getElementById('kpi-unit').value.trim() || '%'
  };
  if (!kpiItem.name) { showToast('يرجى إدخال اسم المؤشر', 'error'); return; }
  let data = load('kpi', []);
  data.push(kpiItem);
  save('kpi', data);
  closeModal('kpi-modal');
  renderKPI();
  showToast('تم إضافة المؤشر ✅', 'success');
}

function drawKPIChart(kpi) {
  const canvas = document.getElementById('kpi-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 700;
  canvas.width = W;
  const H = 300;
  ctx.clearRect(0, 0, W, H);

  const padL = 20, padR = 20, padT = 20, padB = 80;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const barW = Math.min(40, chartW / kpi.length / 2.5);
  const gap = chartW / kpi.length;

  // Grid lines
  for (let i = 0; i <= 5; i++) {
    const y = padT + chartH - (chartH * i / 5);
    ctx.strokeStyle = '#eaecee';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillStyle = '#aaa';
    ctx.font = '11px Tajawal';
    ctx.textAlign = 'left';
    ctx.fillText((i * 20) + '%', padL, y - 3);
  }

  kpi.forEach((k, i) => {
    const pct = k.target > 0 ? Math.min(100, (k.achieved / k.target) * 100) : 0;
    const targetPct = 100;
    const x = padL + i * gap + gap / 2;
    const barH = (pct / 100) * chartH;
    const targetH = chartH;

    // Target bar (light)
    ctx.fillStyle = '#dce8f5';
    ctx.fillRect(x - barW * 0.6, padT, barW * 1.2, targetH);

    // Achieved bar
    const color = pct >= 90 ? '#27ae60' : pct >= 70 ? '#f39c12' : '#e74c3c';
    ctx.fillStyle = color;
    ctx.fillRect(x - barW / 2, padT + chartH - barH, barW, barH);

    // Label
    ctx.fillStyle = '#555';
    ctx.font = '11px Tajawal';
    ctx.textAlign = 'center';
    const words = k.name.split(' ');
    const line1 = words.slice(0, 2).join(' ');
    const line2 = words.slice(2).join(' ');
    ctx.fillText(line1, x, H - padB + 16);
    if (line2) ctx.fillText(line2, x, H - padB + 30);

    ctx.fillStyle = '#333';
    ctx.font = 'bold 12px Tajawal';
    ctx.fillText(Math.round(pct) + '%', x, padT + chartH - barH - 5);
  });
}

// ===== TASKS =====
let taskFilter = 'all';
let taskPriorityFilter = 'all';

function filterTasks(val) { taskFilter = val; renderTasks(); }
function filterTasksPriority(val) { taskPriorityFilter = val; renderTasks(); }

function renderTasks() {
  let tasks = load('tasks', []);

  // Role filter - teacher sees only their tasks
  if (currentUser && currentUser.role === 'teacher') {
    tasks = tasks.filter(t => t.resp.includes(currentUser.name));
  }

  if (taskFilter !== 'all') {
    if (taskFilter === 'late') {
      tasks = tasks.filter(t => t.status !== 'done' && t.due && new Date(t.due) < new Date());
    } else {
      tasks = tasks.filter(t => t.status === taskFilter);
    }
  }
  if (taskPriorityFilter !== 'all') tasks = tasks.filter(t => t.priority === taskPriorityFilter);

  const grid = document.getElementById('tasks-grid');
  if (tasks.length === 0) {
    grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px">لا توجد مهام</p>';
    return;
  }

  const priorityLabel = { high: 'عالية', medium: 'متوسطة', low: 'منخفضة' };
  const statusLabel = { pending: 'معلقة', inprogress: 'قيد التنفيذ', done: 'منجزة' };
  const statusBadgeMap = { pending: 'badge-warning', inprogress: 'badge-info', done: 'badge-success' };

  grid.innerHTML = tasks.map(t => {
    const isLate = t.status !== 'done' && t.due && new Date(t.due) < new Date();
    return `
      <div class="task-card priority-${t.priority}">
        <div class="task-card-header">
          <div class="task-title">${t.name}</div>
          <span class="badge ${isLate ? 'badge-danger' : statusBadgeMap[t.status]}">${isLate ? '⚠️ متأخرة' : statusLabel[t.status]}</span>
        </div>
        <div class="task-meta">
          <span>👩‍🏫 ${t.resp}</span>
          <span>📅 ${formatDate(t.due)}</span>
          <span>🔴 الأولوية: ${priorityLabel[t.priority]}</span>
          ${t.notes ? `<span>📝 ${t.notes}</span>` : ''}
        </div>
        <div class="task-actions">
          <select class="task-status-select" onchange="changeTaskStatus(${t.id}, this.value)">
            <option value="pending" ${t.status==='pending'?'selected':''}>معلقة</option>
            <option value="inprogress" ${t.status==='inprogress'?'selected':''}>قيد التنفيذ</option>
            <option value="done" ${t.status==='done'?'selected':''}>منجزة</option>
          </select>
          <button class="btn-sm btn-edit" onclick="editTask(${t.id})">✏️</button>
          <button class="btn-sm btn-delete" onclick="deleteTask(${t.id})">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

function changeTaskStatus(id, status) {
  let tasks = load('tasks', []);
  const idx = tasks.findIndex(t => t.id === id);
  if (idx !== -1) { tasks[idx].status = status; save('tasks', tasks); }
  showToast('تم تحديث حالة المهمة ✅', 'success');
}

function saveTask() {
  const editId = document.getElementById('task-edit-id').value;
  const task = {
    id: editId ? parseInt(editId) : Date.now(),
    name: document.getElementById('task-name').value.trim(),
    resp: document.getElementById('task-resp').value.trim(),
    due: document.getElementById('task-due').value,
    priority: document.getElementById('task-priority').value,
    status: document.getElementById('task-status').value,
    notes: document.getElementById('task-notes').value.trim(),
  };
  if (!task.name) { showToast('يرجى إدخال اسم المهمة', 'error'); return; }
  let data = load('tasks', []);
  if (editId) {
    const idx = data.findIndex(t => t.id === task.id);
    if (idx !== -1) data[idx] = task;
  } else {
    data.push(task);
  }
  save('tasks', data);
  closeModal('task-modal');
  renderTasks();
  showToast(editId ? 'تم تعديل المهمة ✅' : 'تمت إضافة المهمة ✅', 'success');
}

function editTask(id) {
  const tasks = load('tasks', []);
  const t = tasks.find(t => t.id === id);
  if (!t) return;
  document.getElementById('task-edit-id').value = t.id;
  document.getElementById('task-name').value = t.name;
  document.getElementById('task-resp').value = t.resp;
  document.getElementById('task-due').value = t.due || '';
  document.getElementById('task-priority').value = t.priority;
  document.getElementById('task-status').value = t.status;
  document.getElementById('task-notes').value = t.notes || '';
  document.getElementById('task-modal').classList.remove('hidden');
}

function deleteTask(id) {
  if (!confirm('هل تريدين حذف هذه المهمة؟')) return;
  let tasks = load('tasks', []);
  tasks = tasks.filter(t => t.id !== id);
  save('tasks', tasks);
  renderTasks();
  showToast('تم حذف المهمة 🗑️', 'warning');
}

// ===== REPORTS =====
function renderReports() {
  const reports = load('reports', []);
  const tbody = document.getElementById('reports-tbody');
  const typeIcon = { 'صورة': '📷', 'PDF': '📄', 'Google Drive': '☁️', 'فيديو': '🎥' };

  if (reports.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text-muted)">لا توجد شواهد مرفوعة</td></tr>';
    return;
  }

  tbody.innerHTML = reports.map((r, idx) => `
    <tr>
      <td>${idx+1}</td>
      <td style="font-weight:600">${r.title}</td>
      <td><span class="badge badge-info">${typeIcon[r.type] || '📎'} ${r.type}</span></td>
      <td>${r.initiative}</td>
      <td>${r.person}</td>
      <td>${formatDate(r.date)}</td>
      <td>${r.link ? `<a href="${r.link}" target="_blank" class="btn-sm btn-view">🔗 فتح</a>` : '—'}</td>
      <td>
        <button class="btn-sm btn-delete" onclick="deleteReport(${r.id})">🗑️</button>
      </td>
    </tr>
  `).join('');
}

function saveReport() {
  const report = {
    id: Date.now(),
    title: document.getElementById('rep-title').value.trim(),
    type: document.getElementById('rep-type').value,
    initiative: document.getElementById('rep-initiative').value,
    person: document.getElementById('rep-person').value.trim(),
    date: new Date().toISOString().split('T')[0],
    link: document.getElementById('rep-link').value.trim(),
    notes: document.getElementById('rep-notes').value.trim(),
  };
  if (!report.title) { showToast('يرجى إدخال عنوان الشاهد', 'error'); return; }
  let data = load('reports', []);
  data.push(report);
  save('reports', data);
  closeModal('report-modal');
  renderReports();
  showToast('تم رفع الشاهد بنجاح ✅', 'success');
}

function deleteReport(id) {
  if (!confirm('هل تريدين حذف هذا الشاهد؟')) return;
  let data = load('reports', []);
  data = data.filter(r => r.id !== id);
  save('reports', data);
  renderReports();
  showToast('تم حذف الشاهد 🗑️', 'warning');
}

// ===== TEACHERS =====
function renderTeachers() {
  const teachers = load('teachers', []);
  const tbody = document.getElementById('teachers-tbody');

  tbody.innerHTML = teachers.map(t => {
    const pct = t.assigned > 0 ? Math.round((t.done / t.assigned) * 100) : 0;
    const pctBadge = pct >= 90 ? 'badge-success' : pct >= 70 ? 'badge-warning' : 'badge-danger';
    return `<tr>
      <td style="font-weight:700">${t.name}</td>
      <td style="text-align:center">${t.assigned}</td>
      <td style="text-align:center">${t.done}</td>
      <td>
        <div class="progress-wrap">
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          <span class="progress-text">${pct}%</span>
        </div>
      </td>
      <td>${formatDate(t.lastReport)}</td>
      <td style="color:var(--text-muted);font-size:13px">${t.notes || '<span style="color:#ccc">لا توجد ملاحظات</span>'}</td>
      <td>
        <button class="btn-sm btn-note" onclick="openTeacherNote(${t.id})">📝 ملاحظة</button>
      </td>
    </tr>`;
  }).join('');
}

function openTeacherNote(id) {
  const teachers = load('teachers', []);
  const t = teachers.find(t => t.id === id);
  if (!t) return;
  document.getElementById('teacher-note-id').value = id;
  document.getElementById('teacher-note-text').value = t.notes || '';
  document.getElementById('teacher-note-modal').classList.remove('hidden');
}

function saveTeacherNote() {
  const id = parseInt(document.getElementById('teacher-note-id').value);
  const note = document.getElementById('teacher-note-text').value.trim();
  let teachers = load('teachers', []);
  const idx = teachers.findIndex(t => t.id === id);
  if (idx !== -1) { teachers[idx].notes = note; save('teachers', teachers); }
  closeModal('teacher-note-modal');
  renderTeachers();
  showToast('تم حفظ الملاحظة ✅', 'success');
}

// ===== CALENDAR =====
function prevMonth() {
  calendarMonth--;
  if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
  renderCalendar();
}
function nextMonth() {
  calendarMonth++;
  if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
  renderCalendar();
}

function renderCalendar() {
  const monthNames = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  document.getElementById('calendar-month-label').textContent = monthNames[calendarMonth] + ' ' + calendarYear;

  const tasks = load('tasks', []);
  const initiatives = load('initiatives', []);
  const today = new Date();

  const firstDay = new Date(calendarYear, calendarMonth, 1).getDay();
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();

  // Map events by day
  const events = {};
  tasks.forEach(t => {
    if (!t.due) return;
    const d = new Date(t.due);
    if (d.getFullYear() === calendarYear && d.getMonth() === calendarMonth) {
      const day = d.getDate();
      if (!events[day]) events[day] = [];
      const isLate = t.status !== 'done' && d < today;
      events[day].push({ text: t.name, cls: isLate ? 'late-event' : 'task-event' });
    }
  });
  initiatives.forEach(i => {
    if (i.end) {
      const d = new Date(i.end);
      if (d.getFullYear() === calendarYear && d.getMonth() === calendarMonth) {
        const day = d.getDate();
        if (!events[day]) events[day] = [];
        events[day].push({ text: '📋 ' + i.name, cls: 'ini-event' });
      }
    }
  });

  const dayNames = ['أحد','اثنين','ثلاثاء','أربعاء','خميس','جمعة','سبت'];
  let html = '<div class="calendar-grid">';
  html += '<div class="calendar-header-row">' + dayNames.map(d => `<div class="calendar-day-name">${d}</div>`).join('') + '</div>';
  html += '<div class="calendar-body">';

  let col = 0;
  for (let i = 0; i < firstDay; i++) {
    html += '<div class="calendar-cell empty"></div>';
    col++;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = today.getFullYear() === calendarYear && today.getMonth() === calendarMonth && today.getDate() === day;
    const dayEvents = events[day] || [];
    html += `<div class="calendar-cell ${isToday ? 'today' : ''}">
      <div class="calendar-date ${isToday ? 'today-num' : ''}">${day}</div>
      ${dayEvents.slice(0,3).map(e => `<div class="calendar-event ${e.cls}" title="${e.text}">${e.text}</div>`).join('')}
      ${dayEvents.length > 3 ? `<div style="font-size:10px;color:var(--text-muted)">+${dayEvents.length-3} أكثر</div>` : ''}
    </div>`;
    col++;
    if (col % 7 === 0 && day < daysInMonth) html += '';
  }

  // Fill remaining cells
  const remaining = (7 - (col % 7)) % 7;
  for (let i = 0; i < remaining; i++) html += '<div class="calendar-cell empty"></div>';

  html += '</div></div>';
  document.getElementById('calendar-container').innerHTML = html;
}

// ===== STATS =====
function renderStats() {
  const initiatives = load('initiatives', []);
  const tasks = load('tasks', []);
  const reports = load('reports', []);
  const kpi = load('kpi', []);

  const avgProgress = initiatives.length ? Math.round(initiatives.reduce((s,i) => s+(i.progress||0),0)/initiatives.length) : 0;
  const doneTasks = tasks.filter(t => t.status === 'done').length;
  const lateTasks = tasks.filter(t => t.status !== 'done' && t.due && new Date(t.due) < new Date()).length;
  const topIni = [...initiatives].sort((a,b) => (b.progress||0)-(a.progress||0)).slice(0,3);

  const statsEl = document.getElementById('stats-cards');
  statsEl.innerHTML = `
    <div class="stat-card"><span class="stat-icon">📊</span><span class="stat-number">${avgProgress}%</span><span class="stat-label">متوسط إنجاز المبادرات</span></div>
    <div class="stat-card green"><span class="stat-icon">✅</span><span class="stat-number">${doneTasks}</span><span class="stat-label">مهام منجزة</span></div>
    <div class="stat-card red"><span class="stat-icon">⚠️</span><span class="stat-number">${lateTasks}</span><span class="stat-label">مهام متأخرة</span></div>
    <div class="stat-card purple"><span class="stat-icon">📁</span><span class="stat-number">${reports.length}</span><span class="stat-label">شواهد مرفوعة</span></div>
    <div class="stat-card gold"><span class="stat-icon">🎯</span><span class="stat-number">${kpi.length}</span><span class="stat-label">مؤشرات الأداء</span></div>
    <div class="stat-card teal"><span class="stat-icon">📋</span><span class="stat-number">${initiatives.filter(i=>i.status==='منجزة').length}</span><span class="stat-label">مبادرات منجزة</span></div>
  `;

  const topEl = document.getElementById('top-initiatives');
  topEl.innerHTML = topIni.map((i, idx) => `
    <div class="top-initiative-item">
      <span>${['🥇','🥈','🥉'][idx]} ${i.name}</span>
      <span style="font-weight:700;color:var(--primary)">${i.progress}%</span>
    </div>
  `).join('');

  setTimeout(() => {
    drawTasksPieChart(tasks);
    drawCompareChart(initiatives);
  }, 50);
}

function drawTasksPieChart(tasks) {
  const canvas = document.getElementById('tasks-pie-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const counts = {
    'منجزة': tasks.filter(t => t.status === 'done').length,
    'قيد التنفيذ': tasks.filter(t => t.status === 'inprogress').length,
    'معلقة': tasks.filter(t => t.status === 'pending').length,
    'متأخرة': tasks.filter(t => t.status !== 'done' && t.due && new Date(t.due) < new Date()).length,
  };

  const colors = ['#27ae60','#2e86c1','#f39c12','#e74c3c'];
  const labels = Object.keys(counts);
  const values = Object.values(counts);
  const total = values.reduce((a,b) => a+b, 0);
  if (total === 0) return;

  const cx = W/2, cy = H/2 - 20, r = Math.min(W,H)/2 - 40;
  let startAngle = -Math.PI / 2;

  values.forEach((v, i) => {
    if (v === 0) return;
    const slice = (v / total) * 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, startAngle + slice);
    ctx.closePath();
    ctx.fillStyle = colors[i];
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.stroke();

    const mid = startAngle + slice / 2;
    const lx = cx + (r * 0.65) * Math.cos(mid);
    const ly = cy + (r * 0.65) * Math.sin(mid);
    if (v > 0) {
      ctx.fillStyle = 'white';
      ctx.font = 'bold 13px Tajawal';
      ctx.textAlign = 'center';
      ctx.fillText(v, lx, ly + 5);
    }
    startAngle += slice;
  });

  // Legend
  const legendY = H - 30;
  labels.forEach((l, i) => {
    const x = (i % 2) * (W / 2) + 10;
    const y = legendY - Math.floor(1 - i/2) * 18;
    ctx.fillStyle = colors[i];
    ctx.fillRect(x, y, 12, 12);
    ctx.fillStyle = '#444';
    ctx.font = '12px Tajawal';
    ctx.textAlign = 'right';
    ctx.fillText(l + ' (' + values[i] + ')', x + W/2 - 14, y + 10);
  });
}

function drawCompareChart(initiatives) {
  const canvas = document.getElementById('compare-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 700;
  canvas.width = W;
  const H = 280;
  ctx.clearRect(0, 0, W, H);

  const padL = 20, padR = 20, padT = 20, padB = 70;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const barW = Math.min(35, chartW / initiatives.length / 3);
  const gap = chartW / initiatives.length;

  // Grid
  for (let i = 0; i <= 5; i++) {
    const y = padT + chartH - (chartH * i / 5);
    ctx.strokeStyle = '#eaecee';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillStyle = '#aaa';
    ctx.font = '11px Tajawal';
    ctx.textAlign = 'left';
    ctx.fillText((i*20)+'%', padL, y - 2);
  }

  initiatives.forEach((ini, i) => {
    const pct = ini.progress || 0;
    const x = padL + i * gap + gap / 2;
    const barH = (pct / 100) * chartH;

    ctx.fillStyle = '#dce8f5';
    ctx.fillRect(x - barW * 1.1, padT, barW * 2.2, chartH);

    const color = pct >= 90 ? '#27ae60' : pct >= 60 ? '#2e86c1' : pct >= 30 ? '#f39c12' : '#e74c3c';
    ctx.fillStyle = color;
    ctx.fillRect(x - barW / 2, padT + chartH - barH, barW, barH);

    ctx.fillStyle = '#333';
    ctx.font = 'bold 11px Tajawal';
    ctx.textAlign = 'center';
    ctx.fillText(pct + '%', x, padT + chartH - barH - 5);

    ctx.fillStyle = '#666';
    ctx.font = '11px Tajawal';
    const short = ini.name.length > 8 ? ini.name.substring(0, 8) + '..' : ini.name;
    ctx.fillText(short, x, H - padB + 16);
  });
}

// ===== HELPERS =====
function formatDate(d) {
  if (!d) return '—';
  try {
    const date = new Date(d);
    return date.toLocaleDateString('ar-SA', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return d; }
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  initData();
  calendarMonth = new Date().getMonth();
  calendarYear = new Date().getFullYear();
});
