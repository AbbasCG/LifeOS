import { useEffect, useState } from 'react'
import { ApiError, type RecordItem, type TaskSchedule } from './api'
import { accountZone, shiftDay, zonedParts } from './accountDay'
import { TASKS_CHANGED } from './quickAdd'
import { formatClock, formatClockRange } from './clock'

/**
 * When a task is booked in the calendar (the "session"), as opposed to when it is due. The server describes the earliest
 * active session of a task in `task.schedule`; everything here reads that and never looks at `due_at`.
 */

/** Fired after a session was created, moved or removed, so every calendar view reads the server again (see useCalendar). */
export const CALENDAR_CHANGED = 'lifeos:calendar-changed'
/** A booking changed: both the task lists and the calendar have to read the server again. */
export function notifyScheduleChanged() {
  window.dispatchEvent(new Event(TASKS_CHANGED))
  window.dispatchEvent(new Event(CALENDAR_CHANGED))
}

type Words = (en: string, ar: string, nl?: string) => string

/** The task's schedule when the server sent a usable one, else null (never booked, or an older server). */
export function scheduleOf(task: Pick<RecordItem, 'schedule'>): TaskSchedule | null {
  const s = task.schedule
  return s && typeof s === 'object' && typeof s.starts_at === 'string' && !Number.isNaN(Date.parse(s.starts_at)) && typeof s.session_id === 'number' ? s : null
}
export const sessionCount = (s: TaskSchedule) => Math.max(1, s.sessions || 1)
/** Booked in more than one block. */
export const isSplit = (s: TaskSchedule) => !!s.split || sessionCount(s) > 1

/** "3 sessions" / «3 جلسات» (Arabic has its own forms for two and for eleven and more). */
export function sessionsWord(n: number, t: Words) {
  return t(`${n} sessions`, n === 2 ? 'جلستان' : n >= 3 && n <= 10 ? `${n} جلسات` : `${n} جلسة`, `${n} sessies`)
}

/** One random key per user action: a retry of the same action carries it again, so the server answers with the same session. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => { const r = Math.floor(Math.random() * 16); return (ch === 'x' ? r : (r & 3) | 8).toString(16) })
}

/** Is this the server saying "that task is already booked"? */
export const isAlreadyScheduled = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 409 && e.code === 'task_already_scheduled'
export const isSeveralSessions = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 409 && e.code === 'task_has_several_sessions'
export const isNotScheduled = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 404 && e.code === 'task_not_scheduled'

const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' } }
/** The timezone times are shown in: the account's, else the browser's, always named explicitly. */
export const displayZone = () => accountZone() ?? browserZone()
/** Latin digits in Arabic too, so «09:00» reads the same everywhere and in the calendar's own times. */
const localeOf = (language: string) => language === 'ar' ? 'ar-u-nu-latn' : language === 'nl' ? 'nl-NL' : 'en'
// Clock times always come from the central 24-hour formatter (lib/clock.ts).

/** YYYY-MM-DD of an instant on the wall calendar of `zone`. */
export function dayIn(at: Date, zone = displayZone()): string {
  const p = zonedParts(at, zone), pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

export type SessionWhen = { day: 'today' | 'tomorrow' | 'date'; date: string; dayText: string; timeText: string; text: string }
/**
 * "Tomorrow 09:00": the day and time of an instant in the user's timezone. "Today" and "tomorrow" are decided on the
 * calendar date in that zone (not by counting 24 hours), so they are right around midnight and on the 23- and 25-hour
 * days when the clocks change.
 */
export function sessionWhen(iso: string, language: string, t: Words, now = new Date(), zone = displayZone()): SessionWhen {
  const at = new Date(iso), locale = localeOf(language), date = dayIn(at, zone), today = dayIn(now, zone)
  const time = formatClock(at, { language, timeZone: zone })
  const kind = date === today ? 'today' : date === shiftDay(today, 1) ? 'tomorrow' : 'date'
  const dayText = kind === 'today' ? t('Today', 'اليوم', 'Vandaag') : kind === 'tomorrow' ? t('Tomorrow', 'غدًا', 'Morgen')
    : new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: zone }).format(at)
  return { day: kind, date, dayText, timeText: time, text: `${dayText} ${time}` }
}

/** "09:00 – 09:30" for the whole session, in the user's timezone. */
export function sessionRange(startsAt: string, endsAt: string, language: string, zone = displayZone()): string {
  return formatClockRange(startsAt, endsAt, { language, timeZone: zone })
}
/** The long form for a tooltip or a screen reader: "Thursday 12 November 2026, 09:00 – 09:30". */
export function sessionFull(startsAt: string, endsAt: string, language: string, zone = displayZone()): string {
  return `${new Intl.DateTimeFormat(localeOf(language), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: zone }).format(new Date(startsAt))}, ${sessionRange(startsAt, endsAt, language, zone)}`
}

/** Arabic count words: 1 «دقيقة», 2 «دقيقتان», 3-10 «N دقائق», 11 and more «N دقيقة» (same split as sessionsWord). */
function arCount(n: number, one: string, two: string, few: string, many: string) { return n === 1 ? one : n === 2 ? two : n >= 3 && n <= 10 ? `${n} ${few}` : `${n} ${many}` }
/** "30 min", "1 h 30 min" / «30 دقيقة», «ساعة و30 دقيقة»: a length of time in words, never a clock time. */
export function durationWords(minutes: number, t: Words): string {
  const total = Math.max(0, Math.round(minutes)), h = Math.floor(total / 60), m = total % 60
  const ar = [h ? arCount(h, 'ساعة', 'ساعتان', 'ساعات', 'ساعة') : '', m || !h ? arCount(m, 'دقيقة', 'دقيقتان', 'دقائق', 'دقيقة') : ''].filter(Boolean).join(' و')
  return t(`${h ? `${h} h` : ''}${h && m ? ' ' : ''}${m || !h ? `${m} min` : ''}`, ar, `${h ? `${h} u` : ''}${h && m ? ' ' : ''}${m || !h ? `${m} min` : ''}`)
}

/** Wraps text that is placed inside a sentence of another direction (a time, a title) in Unicode isolates, so it keeps its own order. */
export const isolate = (text: string) => `\u2068${text}\u2069`

/** Where "View in calendar" goes: the calendar on the session's own day (in the user's timezone), with that session focused. */
export function calendarLink(startsAt: string, sessionId?: number | null, zone = displayZone()): string {
  return `/calendar?date=${dayIn(new Date(startsAt), zone)}${sessionId ? `&session=${sessionId}` : ''}`
}

/** A clock that ticks every minute, so "tomorrow" turns into "today" while the page stays open. */
export function useClock(everyMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), everyMs); return () => window.clearInterval(id) }, [everyMs])
  return now
}
