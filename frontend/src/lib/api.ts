export class ApiError extends Error {
  status: number
  errors: Record<string, string[]>
  constructor(status: number, message: string, errors: Record<string, string[]> = {}) { super(message); this.status = status; this.errors = errors }
}
const base = import.meta.env.VITE_API_BASE_URL || ''
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = document.cookie.split('; ').find(v => v.startsWith('XSRF-TOKEN='))?.split('=').slice(1).join('=')
  const response = await fetch(`${base}${path}`, { method, credentials: 'include', headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-XSRF-TOKEN': decodeURIComponent(token) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
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
