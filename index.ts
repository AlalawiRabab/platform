import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User, Program, Evidence, Notification } from '@/types'
import { calculateCompletion } from '@/types'

interface AppState {
  // Auth
  user: User | null
  isAuthenticated: boolean
  login: (user: User) => void
  logout: () => void

  // UI
  sidebarOpen: boolean
  isDark: boolean
  toggleSidebar: () => void
  toggleDark: () => void

  // Programs
  programs: Program[]
  setPrograms: (programs: Program[]) => void
  addProgram: (program: Program) => void
  updateProgram: (id: string, updates: Partial<Program>) => void
  deleteProgram: (id: string) => void
  toggleStage: (programId: string, stage: keyof Program['stages']) => void

  // Evidence
  evidence: Evidence[]
  addEvidence: (ev: Evidence) => void
  setEvidence: (ev: Evidence[]) => void

  // Notifications
  notifications: Notification[]
  markRead: (id: string) => void
  markAllRead: () => void
  unreadCount: number
}

const DEMO_PROGRAMS: Program[] = [
  {
    id: '1', title: 'برنامج القرآن الكريم', description: 'تحفيظ جزء عم لجميع الطلاب',
    ownerId: 'u1', ownerName: 'عبدالرحمن السلمي', department: 'التربية الإسلامية',
    startDate: '2024-09-01', endDate: '2024-12-15', targetAudience: 'جميع الطلاب',
    kpis: 'حفظ جزء عم لجميع الطلاب بنسبة 90%',
    status: 'done', completion: 100,
    stages: { planning: true, announcement: true, execution: true, evidence: true, measurement: true },
    createdAt: '2024-09-01', updatedAt: '2024-12-01', evidenceCount: 5,
  },
  {
    id: '2', title: 'مبادرة القراءة الحرة', description: 'تعزيز ثقافة القراءة بين الطلاب',
    ownerId: 'u2', ownerName: 'نورة القحطاني', department: 'اللغة العربية',
    startDate: '2024-10-01', endDate: '2024-12-30', targetAudience: 'المرحلة المتوسطة',
    kpis: 'قراءة 10 كتب لكل طالب',
    status: 'done', completion: 95,
    stages: { planning: true, announcement: true, execution: true, evidence: true, measurement: false },
    createdAt: '2024-10-01', updatedAt: '2024-12-10', evidenceCount: 3,
  },
  {
    id: '3', title: 'أولمبياد الرياضيات', description: 'إعداد الطلاب للمشاركة في المسابقات الرياضية',
    ownerId: 'u3', ownerName: 'خالد السلمي', department: 'العلوم والرياضيات',
    startDate: '2024-11-01', endDate: '2025-01-20', targetAudience: 'المرحلة الثانوية',
    kpis: 'تأهيل 5 طلاب للمرحلة الإقليمية',
    status: 'progress', completion: 70,
    stages: { planning: true, announcement: true, execution: true, evidence: false, measurement: false },
    createdAt: '2024-11-01', updatedAt: '2024-12-20', evidenceCount: 1,
  },
  {
    id: '4', title: 'نادي البرمجة والتقنية', description: 'تطوير مهارات البرمجة لدى الطلاب',
    ownerId: 'u4', ownerName: 'سلطان الحربي', department: 'العلوم والرياضيات',
    startDate: '2024-10-15', endDate: '2024-12-01', targetAudience: 'طلاب الصف الثالث',
    kpis: 'تصميم 10 مشاريع طلابية',
    status: 'late', completion: 30,
    stages: { planning: true, announcement: false, execution: false, evidence: false, measurement: false },
    createdAt: '2024-10-15', updatedAt: '2024-12-05', evidenceCount: 0,
  },
  {
    id: '5', title: 'يوم التوجيه المهني', description: 'توجيه طلاب الصف الثالث نحو مساراتهم المهنية',
    ownerId: 'u5', ownerName: 'فيصل الدوسري', department: 'الإرشاد الطلابي',
    startDate: '2024-11-10', endDate: '2025-01-25', targetAudience: 'الصف الثالث الثانوي',
    kpis: 'توجيه 90% من طلاب الصف الثالث',
    status: 'progress', completion: 55,
    stages: { planning: true, announcement: true, execution: false, evidence: false, measurement: false },
    createdAt: '2024-11-10', updatedAt: '2024-12-18', evidenceCount: 2,
  },
  {
    id: '6', title: 'مسابقة الخط العربي', description: 'تنمية مهارة الخط العربي وتكريم المتميزين',
    ownerId: 'u2', ownerName: 'ريم المطيري', department: 'اللغة العربية',
    startDate: '2024-11-20', endDate: '2025-01-10', targetAudience: 'جميع المراحل',
    kpis: 'مشاركة 80 طالب في المسابقة',
    status: 'progress', completion: 60,
    stages: { planning: true, announcement: true, execution: true, evidence: false, measurement: false },
    createdAt: '2024-11-20', updatedAt: '2024-12-22', evidenceCount: 2,
  },
]

const DEMO_NOTIFICATIONS: Notification[] = [
  { id: 'n1', userId: 'u1', title: 'برنامج متأخر', message: 'نادي البرمجة والتقنية تأخر 3 أيام عن الموعد المحدد', type: 'danger', isRead: false, createdAt: '2024-12-20' },
  { id: 'n2', userId: 'u1', title: 'اقتراب موعد تسليم', message: 'تقرير الأنشطة الشهرية — يتبقى يومان', type: 'warning', isRead: false, createdAt: '2024-12-19' },
  { id: 'n3', userId: 'u1', title: 'تذكير برفع الأدلة', message: 'برنامج الشراكة المجتمعية — باقي 5 أيام', type: 'warning', isRead: false, createdAt: '2024-12-18' },
  { id: 'n4', userId: 'u1', title: 'تمت الموافقة على البرنامج', message: 'برنامج القرآن الكريم وصل لنسبة 100%', type: 'success', isRead: true, createdAt: '2024-12-15' },
  { id: 'n5', userId: 'u1', title: 'دليل جديد مرفوع', message: 'المعلمة نورة القحطاني رفعت دليلاً لمبادرة القراءة', type: 'success', isRead: true, createdAt: '2024-12-14' },
]

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      login: (user) => set({ user, isAuthenticated: true }),
      logout: () => set({ user: null, isAuthenticated: false }),

      sidebarOpen: true,
      isDark: false,
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleDark: () => set((s) => ({ isDark: !s.isDark })),

      programs: DEMO_PROGRAMS,
      setPrograms: (programs) => set({ programs }),
      addProgram: (program) => set((s) => ({ programs: [program, ...s.programs] })),
      updateProgram: (id, updates) =>
        set((s) => ({
          programs: s.programs.map((p) =>
            p.id === id ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p
          ),
        })),
      deleteProgram: (id) => set((s) => ({ programs: s.programs.filter((p) => p.id !== id) })),
      toggleStage: (programId, stage) =>
        set((s) => ({
          programs: s.programs.map((p) => {
            if (p.id !== programId) return p
            const newStages = { ...p.stages, [stage]: !p.stages[stage] }
            return {
              ...p,
              stages: newStages,
              completion: calculateCompletion(newStages),
              updatedAt: new Date().toISOString(),
            }
          }),
        })),

      evidence: [],
      addEvidence: (ev) => set((s) => ({ evidence: [ev, ...s.evidence] })),
      setEvidence: (ev) => set({ evidence: ev }),

      notifications: DEMO_NOTIFICATIONS,
      markRead: (id) =>
        set((s) => ({
          notifications: s.notifications.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
        })),
      markAllRead: () =>
        set((s) => ({
          notifications: s.notifications.map((n) => ({ ...n, isRead: true })),
        })),
      get unreadCount() {
        return get().notifications.filter((n) => !n.isRead).length
      },
    }),
    { name: 'school-ops-store', partialize: (s) => ({ user: s.user, isAuthenticated: s.isAuthenticated, programs: s.programs, isDark: s.isDark }) }
  )
)
