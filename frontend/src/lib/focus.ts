import { api } from './api'
export type FocusMode = 'pomodoro' | 'deep' | 'custom' | 'manual'
export type SessionKind = 'focus' | 'short_break' | 'long_break' | 'manual'
export type Interruption = { at: string; reason: string; note?: string | null; elapsed?: number }
export type FocusSessionRecord = {
  id: number; status: 'running' | 'paused' | 'completed' | 'cancelled'; kind: SessionKind; mode: FocusMode | null; cycle: number | null
  duration_seconds: number; elapsed_seconds: number; resumed_at: string | null; completed_at: string | null; started_at: string | null; created_at: string
  notes: string | null; interruptions: Interruption[] | null; task_id: number | null; project_id: number | null
  task?: { id: number; title: string } | null; project?: { id: number; title: string; color: string } | null
}
export type FocusInsightsData = {
  days: number; sessions: number; minutes: number; average_minutes: number; deep_minutes: number; completion_rate: number | null; planned_minutes: number; actual_minutes: number
  focus_days: number; consistency: number; streak_days: number; interruptions: number; interruptions_per_hour: number; distractions: { reason: string; count: number }[]
  best_hour: number | null; best_weekday: number | null; typical_minutes: number | null; by_hour: number[]; by_day: { date: string; minutes: number }[]
  by_project: { project_id: number | null; title: string | null; color: string | null; minutes: number }[]; tips: { en: string; ar: string }[]
}

export const POMODORO = { focus: 25, short: 5, long: 15, cyclesBeforeLong: 4 }
export const DEEP_MINUTES = 90

/** Seconds elapsed for a session right now (server time plus the running stretch). */
export function elapsedNow(session: Pick<FocusSessionRecord, 'status' | 'elapsed_seconds' | 'resumed_at' | 'duration_seconds'>, now: number): number {
  const running = session.status === 'running' && session.resumed_at ? Math.max(0, Math.floor((now - new Date(session.resumed_at).getTime()) / 1000)) : 0
  return Math.min(session.duration_seconds, session.elapsed_seconds + running)
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

/**
 * What a Pomodoro cycle suggests after a session ends: a break after focus (long every 4th cycle), then the next focus cycle.
 */
export function nextPomodoroStep(last: Pick<FocusSessionRecord, 'kind' | 'mode' | 'cycle' | 'status'> | undefined): { kind: SessionKind; minutes: number; cycle: number } | null {
  if (!last || last.status !== 'completed') return null
  if (last.kind === 'focus' && last.mode === 'pomodoro') {
    const cycle = last.cycle ?? 1
    return cycle % POMODORO.cyclesBeforeLong === 0 ? { kind: 'long_break', minutes: POMODORO.long, cycle } : { kind: 'short_break', minutes: POMODORO.short, cycle }
  }
  if (last.kind === 'short_break' || last.kind === 'long_break') {
    const cycle = last.kind === 'long_break' ? 1 : (last.cycle ?? 1) + 1
    return { kind: 'focus', minutes: POMODORO.focus, cycle }
  }
  return null
}

/** RFC 4122 v4 id; `crypto.randomUUID` only exists in secure contexts, so fall back to getRandomValues. */
export function newClientId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * Start a focus session right away (one tap from Today, Tasks or the calendar): a Pomodoro for the task, or plain
 * focus without one. If a session is already running, nothing new is started and the caller just opens Focus.
 */
export async function startFocus(taskId?: number | null, minutes = POMODORO.focus): Promise<'started' | 'already_running'> {
  try {
    await api('/api/focus-sessions', 'POST', { kind: 'focus', duration_seconds: minutes * 60, mode: 'pomodoro', cycle: 1, task_id: taskId ?? null, client_id: newClientId() })
    return 'started'
  } catch (e) {
    if (/active session/i.test((e as Error).message)) return 'already_running'
    throw e
  }
}
