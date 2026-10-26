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
  const d = new Date(now)
  if (when === 'tomorrow') d.setDate(d.getDate() + 1)
  if (when === 'week') d.setDate(d.getDate() + (7 - d.getDay()) % 7)
  d.setHours(17, 0, 0, 0)
  return d.toISOString()
}
