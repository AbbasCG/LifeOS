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
export type RecordItem = { id: number; title: string; description?: string; status?: string; priority?: string; category_id?: number | null; project_id?: number | null; task_id?: number | null; due_at?: string | null; starts_at?: string; ends_at?: string; estimated_minutes?: number; actual_minutes?: number; completed_at?: string | null; color?: string; target?: number; progress?: number; recurrence?: string; entries?: { date: string }[]; [key: string]: unknown }
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
export type Analytics = {
  range: { days: number; from: string; to: string; timezone: string }
  totals: { completed: number; created: number; focus_minutes: number; sessions: number; average_session_minutes: number; on_time_rate: number | null; estimated_minutes: number; actual_minutes: number; estimate_ratio: number | null }
  comparison: Record<'completed' | 'focus_minutes', { previous: number; change: number | null }>
  series: { date: string; completed: number; created: number; focus_minutes: number }[]
  by_project: { project_id: number | null; title: string | null; color: string | null; completed: number; focus_minutes: number }[]
  by_priority: { priority: string; completed: number; open: number }[]
  focus_by_hour: { hour: number; minutes: number }[]
  focus_by_weekday: { weekday: number; minutes: number }[]
  habits: (HabitStat & { completions: number; expected: number; consistency: number })[]
  insights: Suggestion[]
}
export type InboxNotification = { id: number; title: string; kind: string; link: string | null; read_at: string | null; created_at: string }
export type AssistantReply = { provider: 'local' | 'openai' | string; intent: string; message: string; notice?: string; subtasks: { title: string; estimated_minutes: number }[]; tasks: { id: number; title: string; priority: string; estimated_minutes: number; due_at: string | null; reasons?: string[] }[]; suggestions: string[] }
export type Bilingual = { en: string; ar: string }
export type PlanItem = { key?: string; task_id: number; task_version?: string; title: string; priority: string; starts_at: string; ends_at: string; minutes: number; part?: number; parts?: number; manual?: boolean; reasons: string[]; explanation?: Bilingual }
export type PlanWarning = { task_id: number; title: string; priority: string; needed_minutes: number; due_at: string | null; reason: string; reason_ar: string; alternatives: (Bilingual & { type: string; task_id?: number })[] }
export type PlanDay = { date: string; work_day: boolean; capacity_minutes: number; fixed_minutes: number; existing_flexible_minutes: number; planned_minutes: number; free_minutes: number; load_percent: number; overloaded: boolean }
export type Plan = { id: number; status: 'pending' | 'accepted' | 'rejected'; starts_on: string | null; days: number; items: PlanItem[]; warnings: PlanWarning[]; summary: { days: PlanDay[]; totals: { planned_minutes: number; blocks: number; tasks_scheduled: number; tasks_unscheduled: number; unscheduled_minutes: number; capacity_minutes: number }; overload: (Bilingual & { date: string; load_percent: number; suggested_date: string | null })[] } | null; created_at: string; accepted_at: string | null }
export type MissedBlock = { event_id: number; task_id: number; title: string; starts_at: string; ends_at: string; minutes: number }
export type PlannedVsActual = { from: string; days: { date: string; planned_minutes: number; actual_minutes: number }[]; tasks: { task_id: number; title: string; status: string | null; planned_minutes: number; actual_minutes: number }[]; totals: { planned_minutes: number; actual_minutes: number; ratio: number | null; planned_tasks: number; completed_planned_tasks: number; completion_rate: number | null } }
export type ReviewDecision = 'done' | 'carry' | 'drop'
export type WeeklyReviewData = {
  week_start: string; week_end: string; timezone: string
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
