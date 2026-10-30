import { accountDay, accountInstant, shiftDay, weekdayOf } from './accountDay'

/** Ask the app shell to open Quick Add (from the topbar, the bottom bar, a shortcut or an empty state). */
export const QUICK_ADD = 'lifeos:quick-add'
/** Fired after Quick Add saved a task, so lists and Today can refresh. */
export const TASKS_CHANGED = 'lifeos:tasks-changed'
export const openQuickAdd = () => window.dispatchEvent(new Event(QUICK_ADD))

export type When = 'today' | 'tomorrow' | 'week' | 'nextweek' | 'none'
export type Priority = 'urgent' | 'high' | 'medium' | 'low'

/** Due date for a quick choice: 17:00 today (23:00 once 17:00 has passed) or 17:00 tomorrow, Sunday 17:00 for "this week", or the coming Monday 17:00. */
export function dueFor(when: When, now = new Date()): string | null {
  if (when === 'none') return null
  // "Today" is the account's today, and 17:00 is the account's wall clock (V27), matching how the server buckets days.
  const today = accountDay(now)
  const day = when === 'tomorrow' ? shiftDay(today, 1)
    : when === 'week' ? shiftDay(today, (7 - weekdayOf(today)) % 7)
    : when === 'nextweek' ? shiftDay(today, ((8 - weekdayOf(today)) % 7) || 7)   // the coming Monday
    : today
  // After 17:00, "today" means tonight (23:00) rather than a deadline that has already passed.
  if (when === 'today' && Date.parse(accountInstant(day, 17)) <= now.getTime()) return accountInstant(day, 23)
  return accountInstant(day, 17)
}
