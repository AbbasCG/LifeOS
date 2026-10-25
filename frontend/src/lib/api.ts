import type { WeeklyIntelligenceData } from './intelligence'
export class ApiError extends Error {
  status: number
  errors: Record<string, string[]>
  constructor(status: number, message: string, errors: Record<string, string[]> = {}) { super(message); this.status = status; this.errors = errors }
}
const base = import.meta.env.VITE_API_BASE_URL || ''
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = document.cookie.split('; ').find(v => v.startsWith('XSRF-TOKEN='))?.split('=').slice(1).join('=')
  let response: Response
  try {
    response = await fetch(`${base}${path}`, { method, credentials: 'include', headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-XSRF-TOKEN': decodeURIComponent(token) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    const ar = typeof document !== 'undefined' && document.documentElement.lang === 'ar'
    const offline = typeof navigator !== 'undefined' && !navigator.onLine
    throw new ApiError(0, offline ? (ar ? 'أنت غير متصل. أعد الاتصال لتحميل التغييرات أو حفظها.' : 'You are offline. Reconnect to load or save changes.') : (ar ? 'تعذر الوصول إلى LifeOS. تحقق من اتصالك وحاول مجدداً.' : 'Could not reach LifeOS. Check your connection and try again.'))
  }
  const data = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(response.status, data?.message || `Request failed (${response.status})`, data?.errors)
  return data as T
}
export async function csrf() { await api('/sanctum/csrf-cookie') }
export type RecordItem = { id: number; title: string; description?: string; status?: string; priority?: string; category_id?: number | null; project_id?: number | null; goal_id?: number | null; area?: string | null; task_id?: number | null; due_at?: string | null; starts_at?: string; ends_at?: string; estimated_minutes?: number; actual_minutes?: number; completed_at?: string | null; color?: string; target?: number; progress?: number; recurrence?: string; entries?: { date: string }[]; [key: string]: unknown }
export type Page<T> = { data: T[]; current_page: number; last_page: number; total: number }
export type Suggestion = { type: 'info' | 'warning' | 'positive'; en: string; ar: string; action?: string | null }
export type HabitStat = { id: number; title: string; color: string; recurrence: string; routine?: string | null; current_streak: number; longest_streak: number; done_today: boolean; done_this_period: boolean; at_risk?: boolean }
export type Briefing = {
  date: string; timezone: string; period: 'morning' | 'afternoon' | 'evening'
  stats: { completed_today: number; focus_minutes_today: number; open_tasks: number; overdue_tasks: number; available_minutes: number; booked_minutes: number; load_percent: number }
  focus: { id: number; title: string; priority: string; status: string; estimated_minutes: number; due_at: string | null; score: number; reasons: string[] }[]
  agenda: { id: number; title: string; kind: string; task_id: number | null; starts_at: string; ends_at: string }[]
  next_event: { id: number; title: string; starts_at: string } | null
  habits: HabitStat[]
  goals: { id: number; title: string; color: string; progress: number; target: number; percent: number; due_at: string | null }[]
  suggestions: Suggestion[]
}
export type PeriodMetrics = { completed: number; focus_minutes: number }
export type PeriodComparison = { from: string; previous_from: string; current: PeriodMetrics; previous: PeriodMetrics; change: Record<keyof PeriodMetrics, number | null>; small_base: Record<keyof PeriodMetrics, boolean> }
export type Analytics = {
  range: { days: number; from: string; to: string; timezone: string; previous_from?: string; previous_to?: string; custom?: boolean }
  project?: { id: number; title: string; color: string } | null
  totals: { completed: number; created: number; focus_minutes: number; sessions: number; average_session_minutes: number; on_time_rate: number | null; estimated_minutes: number; actual_minutes: number; estimate_ratio: number | null }
  comparison: Record<'completed' | 'focus_minutes', { previous: number; change: number | null; small_base?: boolean }>
  energy?: { enabled: boolean; checked_in_days: number; reliable: boolean; min_days_per_group?: number; groups: { level: 'low' | 'medium' | 'high'; days: number; avg_focus_minutes: number | null; avg_completed: number | null; reliable: boolean }[]; days: { date: string; energy: number; focus_minutes: number; completed: number }[] }
  consistency?: { days: number; focus_days: number; percent: number; longest_streak: number; current_streak: number; weekly_variation: number | null; weeks: { start: string; focus_minutes: number; completed: number; days: number }[] }
  workload?: { by_area: { area: 'work' | 'study' | 'personal'; completed: number; focus_minutes: number; share: number }[]; completed_by_weekday: { weekday: number; completed: number }[]; due_next_7_days: { tasks: number; overdue: number; remaining_minutes: number } }
  goals?: { id: number; title: string; color: string; percent: number; expected_percent: number | null; status: string; days_left: number | null; trend: 'up' | 'down' | 'flat' }[]
  periods?: Record<'week' | 'month', PeriodComparison>
  series: { date: string; completed: number; created: number; focus_minutes: number }[]
  by_project: { project_id: number | null; title: string | null; color: string | null; completed: number; focus_minutes: number }[]
  by_priority: { priority: string; completed: number; open: number }[]
  focus_by_hour: { hour: number; minutes: number }[]
  focus_by_weekday: { weekday: number; minutes: number }[]
  habits: (HabitStat & { completions: number; expected: number; consistency: number })[]
  insights: Suggestion[]
}
export type InboxNotification = { id: number; title: string; body?: string | null; kind: string; category?: string; link: string | null; push_status?: string | null; push_error?: string | null; read_at: string | null; created_at: string }
export type CopilotItem = { type: 'project' | 'goal' | 'overlap' | 'overload' | 'deadline' | 'link' | string; id?: number; title: string; detail: string; status?: string; status_label?: string; link?: string }
export type AssistantReply = { provider: 'local' | 'openai' | string; intent: string; message: string; notice?: string; items?: CopilotItem[]; subtasks: { title: string; estimated_minutes: number }[]; tasks: { id: number; title: string; priority: string; estimated_minutes: number; due_at: string | null; reasons?: string[] }[]; suggestions: string[]; proposal?: AssistantProposal | null }
export type AssistantAction = { id: string; type: 'create_event' | 'move_event' | 'create_task' | 'reschedule_task'; title: string; starts_at?: string; ends_at?: string; minutes: number; task_id?: number | null; event_id?: number; from_starts_at?: string; from_ends_at?: string; goal_id?: number; priority?: string; estimated_minutes?: number; due_at?: string; from_due_at?: string; reason?: string; conflicts?: { title: string; source_label: string; starts_at: string; ends_at: string; minutes: number }[] }
export type AssistantProposal = { id: string; kind: 'schedule' | 'rebalance' | string; provider: string; status: 'pending' | 'applied' | 'dismissed' | 'expired' | 'undone'; summary: string; explanation: string[]; actions: AssistantAction[]; results: { action_id: string; type: string; event_id?: number; task_id?: number; undo?: { done: boolean; reason?: string } }[] | null; expires_at: string; applied_at: string | null; undo_until?: string | null }
export type AssistantStatus = { active: { provider: string; label: string; model: string | null }; selected: string; external_allowed: boolean; providers: { provider: string; label: string; configured: boolean; selected: boolean; model: string }[] }
export type Bilingual = { en: string; ar: string }
export type PlanItem = { key?: string; task_id: number; task_version?: string; title: string; priority: string; starts_at: string; ends_at: string; minutes: number; part?: number; parts?: number; manual?: boolean; reasons: string[]; explanation?: Bilingual }
export type PlanWarning = { task_id: number; title: string; priority: string; needed_minutes: number; due_at: string | null; reason: string; reason_ar: string; alternatives: (Bilingual & { type: string; task_id?: number })[] }
export type PlanDay = { date: string; work_day: boolean; capacity_minutes: number; fixed_minutes: number; existing_flexible_minutes: number; planned_minutes: number; free_minutes: number; load_percent: number; overloaded: boolean }
export type Plan = { id: number; status: 'pending' | 'accepted' | 'rejected'; starts_on: string | null; days: number; items: PlanItem[]; warnings: PlanWarning[]; summary: { days: PlanDay[]; totals: { planned_minutes: number; blocks: number; tasks_scheduled: number; tasks_unscheduled: number; unscheduled_minutes: number; capacity_minutes: number }; overload: (Bilingual & { date: string; load_percent: number; suggested_date: string | null })[] } | null; created_at: string; accepted_at: string | null }
export type MissedBlock = { event_id: number; task_id: number; title: string; starts_at: string; ends_at: string; minutes: number }
export type PlannedVsActual = { from: string; days: { date: string; planned_minutes: number; actual_minutes: number }[]; tasks: { task_id: number; title: string; status: string | null; planned_minutes: number; actual_minutes: number }[]; totals: { planned_minutes: number; actual_minutes: number; ratio: number | null; planned_tasks: number; completed_planned_tasks: number; completion_rate: number | null } }
export type ReviewDecision = 'done' | 'carry' | 'drop'
export type WeeklyReviewData = {
  week_start: string; week_end: string; timezone: string; intelligence?: WeeklyIntelligenceData
  metrics: { completed: number; unfinished: number; focus_minutes: number; previous_focus_minutes: number; focus_change: number | null; on_time_rate: number | null; habit_consistency: number | null; estimate_overruns: number }
  completed: { id: number; title: string; priority: string; completed_at: string | null; estimated_minutes: number; actual_minutes: number }[]
  unfinished: { id: number; title: string; priority: string; status: string; due_at: string | null; overdue: boolean; estimated_minutes: number }[]
  focus_by_day: { date: string; minutes: number }[]
  planned_vs_actual: PlannedVsActual
  goals: { id: number; title: string; color: string; progress: number; target: number; percent: number; due_at: string | null }[]
  habits: (HabitStat & { completions: number; expected: number; consistency: number })[]
  achievements: (Bilingual & { key: string })[]
  improvements: (Bilingual & { key: string })[]
  suggested_priorities: { id: number; title: string; priority: string; estimated_minutes: number; due_at: string | null; reasons: string[] }[]
  review: { status: 'new' | 'draft' | 'completed'; reflection: { wins: string; challenges: string; lessons: string; rating: number | null }; decisions: Record<string, ReviewDecision>; priorities: number[]; completed_at: string | null }
  applied?: Record<ReviewDecision, number>
}
export type Availability = { work_start: string; work_end: string; days: { date: string; work_day: boolean; free_minutes: number; slots: { starts_at: string; ends_at: string; minutes: number }[] }[] }
export type Recurrence = { freq: 'daily' | 'weekly' | 'monthly' | 'yearly'; interval?: number; by_weekday?: number[]; count?: number; until?: string }
export type CalendarOccurrence = { id: string; event_id: number | null; source: 'lifeos' | 'google' | 'outlook' | string; title: string; description?: string | null; kind: 'fixed' | 'flexible' | string; task_id?: number | null; starts_at: string; ends_at: string; recurring: boolean; occurrence_start: string | null; is_exception?: boolean; recurrence?: Recurrence | null; timezone?: string | null; remind_minutes?: number | null; editable: boolean; account_label?: string | null }

export type Checkin = { date: string; energy: number | null; mood: number | null; stress: number | null; workload: number | null; sleep_minutes: number | null; reflection: string | null; updated_at?: string | null }
export type CheckinFinding = { key: string; type: 'positive' | 'warning' | 'neutral'; en: string; ar: string; groups: { label: string; days: number; average: number }[] }
export type CheckinInsights = { enabled: boolean; days: number; checked_in_days: number; averages: Record<'energy' | 'mood' | 'stress' | 'workload' | 'sleep_minutes', number | null>; trend: Record<'energy' | 'workload', { last_7: number | null; previous_7: number | null }>; findings: CheckinFinding[]; series: { date: string; energy: number | null; mood: number | null; stress: number | null; workload: number | null; sleep_minutes: number | null; focus_minutes: number; completed: number; checked_in: boolean }[]; note: { en: string; ar: string } }

export type Bi = { en: string; ar: string }
export type DayPlanItem = PlanItem & { area?: 'work' | 'study' | 'personal'; estimate_factor?: number }
export type DayPlanAlternative = { key: 'balanced' | 'deep' | 'light' | 'deadlines'; title: Bi; description: Bi; items: DayPlanItem[]; warnings: PlanWarning[]; breaks: (Bi & { at: string; minutes: number })[]; metrics: { planned_minutes: number; tasks: number; switches: number; load_percent: number; unscheduled_must_do: number }; explanation: Bi[] }
export type DayPlan = {
  date: string; timezone: string; replan: boolean; interruption?: { busy_until: string | null; lost_minutes: number }; energy: number | null; estimate_ratio: number; recommended: DayPlanAlternative['key']
  budget: { window_minutes: number; committed_minutes: number; free_minutes: number; capacity_minutes: number; must_do_minutes: number; buffer_minutes: number }
  boundaries: Record<string, { start: string; end: string }>; peak: { start: string; end: string; source: 'history' | 'settings' } | null
  commitments: { title: string; kind: string; source: string; recurring: boolean; starts_at: string; ends_at: string }[]
  overload: (Bi & { flexible_events: { event_id: number; title: string; starts_at: string }[] }) | null
  recovery: { task_id: number; title: string; missed_at: string }[]; explanation: Bi[]; alternatives: DayPlanAlternative[]
}

export type TodayData = {
  date: string; period: 'morning' | 'afternoon' | 'evening'; briefing: Bi[]; reflection_prompt: Bi | null
  energy: { checkin: Checkin | null; enabled: boolean; energy: number | null; workload: number | null; load_percent: number; level: 'light' | 'moderate' | 'heavy' }
  day_start?: string
  timezone?: string
  timeline: { id: string; title: string; starts_at: string; ends_at: string; kind: string; source: string; all_day: boolean }[]
  windows?: Record<string, { start: string; end: string }>
  focus_time: { free_minutes: number; slots: { area: string; starts_at: string; ends_at: string; minutes: number }[]; peak: { start: string; end: string } | null; next_task: { id: number; title: string } | null }
  deadlines: { id: number; title: string; priority: string | null; due_at: string; type: 'task' | 'project' | 'goal' | 'external'; source?: string; url?: string | null; bucket: 'overdue' | 'today' | 'tomorrow' | 'week' }[]
  progress: { tasks: { done: number; target: number }; focus: { done: number; target: number }; habits: { done: number; target: number }; overall: number }
}
