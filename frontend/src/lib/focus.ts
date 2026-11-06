import { api } from './api'
export type FocusMode = 'pomodoro' | 'deep' | 'custom' | 'manual'
export type SessionKind = 'focus' | 'short_break' | 'long_break' | 'manual'
export type Interruption = { at: string; reason: string; note?: string | null; elapsed?: number }
export type FocusSessionRecord = {
  id: number; status: 'running' | 'paused' | 'completed' | 'cancelled'; kind: SessionKind; mode: FocusMode | null; cycle: number | null
  duration_seconds: number; elapsed_seconds: number; resumed_at: string | null; completed_at: string | null; started_at: string | null; created_at: string
  /** The server's clock when it sent this record; with `skew_ms` it keeps the countdown right even if the device clock is off. */
  server_time?: string; skew_ms?: number
  /** Worked seconds and seconds past the planned end on the server's clock when this record was sent (immune to this device's clock and to the database's time zone). */
  elapsed_now_seconds?: number; overdue_seconds?: number
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
/** A timestamp from the server as milliseconds, or null when it cannot be read (some browsers reject microseconds). */
export function parseStamp(value: string | null | undefined): number | null {
  if (!value) return null
  const direct = new Date(value).getTime()
  if (Number.isFinite(direct)) return direct
  const trimmed = new Date(value.replace(/(\.\d{3})\d+/, '$1')).getTime()
  return Number.isFinite(trimmed) ? trimmed : null
}

/** Remember how far this device's clock is from the server's at the moment the record arrived. */
export const stampSession = (session: FocusSessionRecord): FocusSessionRecord => {
  const server = parseStamp(session.server_time)
  return server === null ? session : { ...session, skew_ms: server - Date.now() }
}

type Timed = Pick<FocusSessionRecord, 'status' | 'elapsed_seconds' | 'resumed_at' | 'duration_seconds'> & { skew_ms?: number; server_time?: string; elapsed_now_seconds?: number; overdue_seconds?: number }

/** Seconds that have passed on the server's clock since the record was sent (0 when it carries no server time). */
const sinceSent = (session: Timed, now: number): number => {
  const sent = parseStamp(session.server_time)
  return sent === null ? 0 : Math.max(0, Math.floor((now + (session.skew_ms ?? 0) - sent) / 1000))
}
const hasServerElapsed = (session: Timed) => typeof session.elapsed_now_seconds === 'number' && Number.isFinite(session.elapsed_now_seconds) && parseStamp(session.server_time) !== null

/**
 * Seconds of the session used so far. The server says how much was worked when it sent the record; this adds the seconds since (counted on the
 * server's clock, so a wrong device clock does not matter). Only when the record has no such figure does it fall back to `resumed_at`. An
 * unreadable time counts as "just started" so a session can never finish by accident.
 */
export function elapsedNow(session: Timed, now: number): number {
  if (session.status !== 'running') return Math.max(0, Math.min(session.duration_seconds, session.elapsed_seconds || 0))
  if (hasServerElapsed(session)) return Math.max(0, Math.min(session.duration_seconds, session.elapsed_now_seconds! + sinceSent(session, now)))
  const since = parseStamp(session.resumed_at)
  const running = since === null ? 0 : Math.max(0, Math.floor((now + (session.skew_ms ?? 0) - since) / 1000))
  const total = (session.elapsed_seconds || 0) + running
  return Math.max(0, Math.min(session.duration_seconds, Number.isFinite(total) ? total : 0))
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s <= 3600) return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

/** The states a focus session can be in, as the page shows them: nothing running yet, or the status the server reports. */
export type FocusPhase = 'idle' | 'running' | 'paused' | 'completed' | 'cancelled'
export const phaseOf = (session?: Pick<FocusSessionRecord, 'status'> | null): FocusPhase => session ? session.status : 'idle'

/** A running session that ended longer ago than this was not being watched: the page asks instead of finishing it. */
export const AWAY_SECONDS = 120

/** How many seconds past the planned end a running session is, by the server's clock (0 while time is left or when it is not running). */
export function overdueSeconds(session: Timed, now: number): number {
  if (session.status !== 'running') return 0
  if (hasServerElapsed(session) && typeof session.overdue_seconds === 'number') {
    const left = Math.max(0, session.duration_seconds - session.elapsed_now_seconds!)
    return Math.max(0, session.overdue_seconds + (left > 0 ? Math.max(0, sinceSent(session, now) - left) : sinceSent(session, now)))
  }
  const since = parseStamp(session.resumed_at)
  const running = since === null ? 0 : Math.max(0, Math.floor((now + (session.skew_ms ?? 0) - since) / 1000))
  const total = (session.elapsed_seconds || 0) + running
  return Number.isFinite(total) ? Math.max(0, total - session.duration_seconds) : 0
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
export async function startFocus(taskId?: number | null, minutes = POMODORO.focus, kind: SessionKind = 'focus'): Promise<'started' | 'already_running'> {
  try {
    await api('/api/focus-sessions', 'POST', { kind, duration_seconds: minutes * 60, mode: 'pomodoro', cycle: 1, task_id: kind === 'focus' ? taskId ?? null : null, client_id: newClientId() })
    return 'started'
  } catch (e) {
    if (/active session/i.test((e as Error).message)) return 'already_running'
    throw e
  }
}
