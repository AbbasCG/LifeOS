import { accountDay, accountZone, shiftDay, zonedParts } from './accountDay'
import { formatDayText, formatDayTime, type ClockOptions } from './clock'
import { DEFAULT_DEADLINE_TIME, deadlineField, deadlineInstant, dueKeepingTime, nextWeekDay, weekEndDay, type When } from './quickAdd'

/**
 * Date-only deadlines. A task's `due_all_day` deadline has no time: the server stores the END of that day in the account zone (23:59),
 * so it is overdue only once the day has ended. The screens show the day alone, and every write that moves such a deadline sends
 * `due_date` ('YYYY-MM-DD'), never `due_at` (which would turn it into a timed deadline at 23:59).
 */
export type DueFields = { due_at?: string | null; due_all_day?: boolean; due_date?: string | null }

const DAY = /^\d{4}-\d{2}-\d{2}$/
/** True when an instant is 23:59:00 on the account's clock: how the server stores a date-only deadline. */
const atEndOfDay = (iso: string) => { const p = zonedParts(new Date(iso), accountZone()); return p.hour === 23 && p.minute === 59 && p.second === 0 }

/**
 * Whether a deadline is date-only. The task resource says so (`due_all_day`). Lists the server builds from tasks (Today, the briefing, the
 * weekly review, the timeline) carry only `due_at`; there a deadline at exactly 23:59:00 account time is read as date-only.
 */
export function isAllDay(x: DueFields | null | undefined): boolean {
  if (!x?.due_at || Number.isNaN(Date.parse(x.due_at))) return false
  return x.due_all_day ?? atEndOfDay(x.due_at)
}
/** The account-zone day ('YYYY-MM-DD') of a deadline: the server's `due_date` when it sent one. */
export const dueDay = (x: DueFields): string => x.due_date && DAY.test(x.due_date) ? x.due_date : x.due_at ? accountDay(new Date(x.due_at)) : ''

/** A deadline for a list or card: "Fri 14 Nov" when date-only, "Fri 14 Nov 17:00" when timed (24-hour). `style` as in formatDayTime. */
export function formatDue(x: DueFields, opts: ClockOptions = {}, style?: Intl.DateTimeFormatOptions): string {
  if (!x.due_at) return ''
  return isAllDay(x) ? formatDayText(x.due_at, opts, style) : formatDayTime(x.due_at, opts, style)
}

/** The day a quick choice means on the account calendar. */
function whenDay(when: Exclude<When, 'none'>, now: Date): string {
  const today = accountDay(now)
  return when === 'tomorrow' ? shiftDay(today, 1) : when === 'week' ? weekEndDay(today) : when === 'nextweek' ? nextWeekDay(now) : today
}

/** What to PATCH to put a deadline on a quick choice: a date-only deadline stays date-only (`due_date`), a timed one keeps its time of day. */
export function moveDue(when: When, task: DueFields, now = new Date()): { due_at: string | null } | { due_date: string } {
  if (when !== 'none' && isAllDay(task)) return { due_date: whenDay(when, now) }
  return { due_at: dueKeepingTime(when, task.due_at, now) }
}
/** What to PATCH to put a deadline back exactly as it was (Undo): date-only deadlines go back as `due_date` so the flag returns with them. */
export function restoreDue(task: DueFields): { due_at: string | null } | { due_date: string } {
  return isAllDay(task) ? { due_date: dueDay(task) } : { due_at: task.due_at ?? null }
}

/** The task dialog's deadline: the field value ('YYYY-MM-DDTHH:mm' on the account clock, '' for none) and whether it has no time. */
export type DueDraft = { field: string; noTime: boolean }
/** A saved task as the dialog opens it. A date-only deadline keeps 17:00 in the field, so switching the toggle off gives the usual default time. */
export function draftOf(task: DueFields): DueDraft {
  if (isAllDay(task)) return { field: `${dueDay(task)}T${DEFAULT_DEADLINE_TIME}`, noTime: true }
  return { field: deadlineField(task.due_at), noTime: false }
}
/**
 * What the dialog posts for the deadline. Nothing when it is as it opened (a new task has no opened state and always says); `{ due_date }` for a date-only deadline; `{ due_at }` for a
 * timed one (null clears). Only the field that changed is sent, so a save that did not touch the deadline cannot alter it.
 */
export function duePayload(now: DueDraft, opened: DueDraft | null): Record<string, string | null> {
  const day = now.field.slice(0, 10)
  if (!now.field || deadlineInstant(now.field) === null) return opened && !opened.field ? {} : { due_at: null }
  if (now.noTime) return opened?.noTime && opened.field.slice(0, 10) === day ? {} : { due_date: day }
  return opened && !opened.noTime && opened.field === now.field ? {} : { due_at: deadlineInstant(now.field) }
}
