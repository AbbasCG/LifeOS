import type { Confidence } from '../../lib/intelligence'

type T = (en: string, ar: string) => string

export const confidenceLabel = (c: Confidence, t: T) => ({ high: t('High confidence', 'ثقة عالية'), medium: t('Medium confidence', 'ثقة متوسطة'), low: t('Low confidence', 'ثقة منخفضة') })[c]

export const sourceLabel = (s: string, t: T) => ({
  tasks: t('Tasks', 'المهام'), calendar: t('Calendar', 'التقويم'), lifeos: 'LifeOS', google: 'Google', outlook: 'Outlook', ics: t('Subscription', 'اشتراك'),
  goals: t('Goals', 'الأهداف'), habits: t('Habits', 'العادات'), focus: t('Focus history', 'سجل التركيز'), checkins: t('Check-ins', 'تسجيلات الطاقة'),
  connected: t('Connected calendars', 'التقويمات المرتبطة'), planner: t('Planner', 'المخطط'),
} as Record<string, string>)[s] ?? s

export const reasonLabel = (r: string, t: T) => ({
  urgent: t('Urgent', 'عاجلة'), high: t('High priority', 'أولوية عالية'), in_progress: t('In progress', 'قيد التنفيذ'), overdue: t('Overdue', 'متأخرة'), due_today: t('Due today', 'مستحقة اليوم'),
  due_soon: t('Due soon', 'مستحقة قريباً'), goal: t('Serves a goal', 'تخدم هدفاً'), quick_win: t('Quick win', 'إنجاز سريع'), deadline_risk: t('May not fit', 'قد لا تتسع'), postponed: t('Often postponed', 'تتأجل كثيراً'),
} as Record<string, string>)[r] ?? r
