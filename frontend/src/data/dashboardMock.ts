
import type {
  DashboardTask,
  TimelineEvent,
  WeeklyDay,
} from '../types/dashboard'

export const initialTasks: DashboardTask[] = [
  {
    id: 1,
    title: {
      ar: 'تطوير واجهة LifeOS',
      en: 'Develop LifeOS interface',
    },
    category: {
      ar: 'المشاريع',
      en: 'Projects',
    },
    completed: false,
    priority: 'high',
    estimatedMinutes: 90,
  },
  {
    id: 2,
    title: {
      ar: 'مراجعة المواد الدراسية',
      en: 'Review study materials',
    },
    category: {
      ar: 'الدراسة',
      en: 'Study',
    },
    completed: false,
    priority: 'medium',
    estimatedMinutes: 45,
  },
  {
    id: 3,
    title: {
      ar: 'ممارسة الرياضة',
      en: 'Exercise',
    },
    category: {
      ar: 'الصحة',
      en: 'Health',
    },
    completed: false,
    priority: 'low',
    estimatedMinutes: 30,
  },
]

export const timelineEvents: TimelineEvent[] = [
  {
    id: 1,
    time: '09:00',
    title: {
      ar: 'بداية العمل',
      en: 'Start work',
    },
    type: 'fixed',
  },
  {
    id: 2,
    time: '13:00',
    title: {
      ar: 'استراحة الغداء',
      en: 'Lunch break',
    },
    type: 'fixed',
  },
  {
    id: 3,
    time: '17:30',
    title: {
      ar: 'جلسة تطوير المشروع',
      en: 'Project development session',
    },
    type: 'flexible',
  },
]

export const weeklyProgress: WeeklyDay[] = [
  { day: 'Mon', minutes: 110 },
  { day: 'Tue', minutes: 165 },
  { day: 'Wed', minutes: 95 },
  { day: 'Thu', minutes: 210 },
  { day: 'Fri', minutes: 145 },
  { day: 'Sat', minutes: 80 },
  { day: 'Sun', minutes: 130 },
]
