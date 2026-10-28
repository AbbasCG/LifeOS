import { accountDay, accountInstant, shiftDay, weekdayOf } from './accountDay'

/** Ask the app shell to open Quick Add (from the topbar, the bottom bar, a shortcut or an empty state). */
export const QUICK_ADD = 'lifeos:quick-add'
/** Fired after Quick Add saved a task, so lists and Today can refresh. */
export const TASKS_CHANGED = 'lifeos:tasks-changed'
export const openQuickAdd = () => window.dispatchEvent(new Event(QUICK_ADD))

export type When = 'today' | 'tomorrow' | 'week' | 'none'
export type Priority = 'urgent' | 'high' | 'medium' | 'low'

/** Due date for a quick choice: 17:00 today or tomorrow, or Sunday 17:00 for "this week". */
export function dueFor(when: When, now = new Date()): string | null {
  if (when === 'none') return null
  // "Today" is the account's today, and 17:00 is the account's wall clock (V27), matching how the server buckets days.
  const today = accountDay(now)
  const day = when === 'tomorrow' ? shiftDay(today, 1) : when === 'week' ? shiftDay(today, (7 - weekdayOf(today)) % 7) : today
  return accountInstant(day, 17)
}
