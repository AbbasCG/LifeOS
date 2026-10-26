import type { RecordItem } from './api'
import { localDate } from './hooks'

/** Ask the app shell to open the habit sheet (from Quick add, Today, a shortcut or a notification). */
export const HABIT_SHEET = 'lifeos:habit-sheet'
export const openHabitSheet = () => window.dispatchEvent(new Event(HABIT_SHEET))

export type QuickAction = { action: string; title: string; link: string }

/**
 * What this browser can do with notifications, detected rather than assumed:
 * notifications at all, and buttons on them (Chromium on desktop and Android; not Safari or Firefox at the time of
 * writing). Without buttons, tapping a notification still opens LifeOS on the right screen.
 */
export function notificationSupport() {
  const N = typeof Notification === 'undefined' ? null : (Notification as unknown as { permission: NotificationPermission; maxActions?: number })
  return {
    notifications: N !== null,
    permission: N?.permission ?? 'unsupported',
    buttons: !!N && typeof N.maxActions === 'number' && N.maxActions > 0,
  }
}

/**
 * Show a notification from the page. Prefers the service worker (required on Android, and the only way to get
 * buttons), falls back to a plain page notification. Buttons are in-app links handled by the service worker.
 */
export async function notify(title: string, options: { body?: string; tag?: string; link?: string; actions?: QuickAction[] } = {}) {
  const support = notificationSupport()
  if (!support.notifications || support.permission !== 'granted') return false
  const actions = support.buttons ? options.actions ?? [] : []
  const base = { body: options.body, tag: options.tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { link: options.link ?? '/', actions } }
  try {
    const registration = 'serviceWorker' in navigator ? await Promise.race([navigator.serviceWorker.ready, new Promise<null>(r => setTimeout(() => r(null), 1500))]) : null
    if (registration) {
      await registration.showNotification(title, { ...base, actions: actions.map(a => ({ action: a.action, title: a.title })) } as NotificationOptions)
      return true
    }
    new Notification(title, base)
    return true
  } catch { return false }
}

export type Habit = RecordItem & { recurrence?: string; current_streak?: number; entries?: { date: string }[] }

/** Monday of the week containing `date` (weekly habits count once per Monday-based week, like their streaks). */
function weekStart(date: string) {
  const d = new Date(`${date}T12:00`)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return localDate(d)
}
export const doneNow = (habit: Habit, today = localDate()) => (habit.entries ?? []).some(e => habit.recurrence === 'weekly' ? e.date >= weekStart(today) && e.date <= today : e.date === today)

export const HABITS_CHANGED = 'lifeos:habits-changed'
