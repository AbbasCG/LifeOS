import { useSyncExternalStore } from 'react'

/**
 * What swiping a task row does, like the swipe actions in an email app: one action for a swipe to the right and one for a
 * swipe to the left, chosen in Settings. Kept on this device (a gesture belongs to the phone in your hand), nothing is sent
 * anywhere. Deleting only ever asks first; a snooze moves the due date and offers Undo.
 */
export type SwipeAction = 'complete' | 'tomorrow' | 'nextweek' | 'focus' | 'delete' | 'none'
export const SWIPE_ACTIONS: SwipeAction[] = ['complete', 'tomorrow', 'nextweek', 'focus', 'delete', 'none']
export type SwipeSides = { right: SwipeAction; left: SwipeAction }
export const DEFAULT_SWIPE: SwipeSides = { right: 'complete', left: 'tomorrow' }

const KEY = 'lifeos-swipe-actions'
const known = (v: unknown): v is SwipeAction => SWIPE_ACTIONS.includes(v as SwipeAction)

/** A saved choice made safe: anything unknown falls back to the default for that side. */
export function normalizeSwipe(raw: unknown): SwipeSides {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof SwipeSides, unknown>>
  return { right: known(o.right) ? o.right : DEFAULT_SWIPE.right, left: known(o.left) ? o.left : DEFAULT_SWIPE.left }
}

let cachedText: string | null | undefined, cached: SwipeSides = DEFAULT_SWIPE
const listeners = new Set<() => void>()
function read(): SwipeSides {
  let text: string | null = null
  try { text = localStorage.getItem(KEY) } catch { /* storage unavailable: the defaults apply */ }
  if (text !== cachedText) {
    cachedText = text
    try { cached = text ? normalizeSwipe(JSON.parse(text)) : DEFAULT_SWIPE } catch { cached = DEFAULT_SWIPE }
  }
  return cached
}
function write(next: SwipeSides | null) {
  try { if (next) localStorage.setItem(KEY, JSON.stringify(next)); else localStorage.removeItem(KEY) } catch { /* kept for this visit only */ }
  listeners.forEach(l => l())
}
export const setSwipeAction = (side: keyof SwipeSides, action: SwipeAction) => write({ ...read(), [side]: action })
export const resetSwipe = () => write(null)
const subscribe = (l: () => void) => { listeners.add(l); window.addEventListener('storage', l); return () => { listeners.delete(l); window.removeEventListener('storage', l) } }
export const useSwipeActions = (): SwipeSides => useSyncExternalStore(subscribe, read, () => DEFAULT_SWIPE)

/** The words for each action: a short one for the revealed edge, a full one for Settings. */
export function swipeWords(t: (en: string, ar: string) => string): Record<SwipeAction, { short: string; full: string }> {
  return {
    complete: { short: t('Done', 'تم'), full: t('Complete', 'إنجاز') },
    tomorrow: { short: t('Tomorrow', 'غداً'), full: t('Snooze to tomorrow', 'تأجيل إلى الغد') },
    nextweek: { short: t('Next week', 'الأسبوع القادم'), full: t('Snooze to next week', 'تأجيل إلى الأسبوع القادم') },
    focus: { short: t('Focus', 'تركيز'), full: t('Start focus', 'بدء التركيز') },
    delete: { short: t('Delete', 'حذف'), full: t('Delete (asks first)', 'حذف (يسأل أولاً)') },
    none: { short: '', full: t('Nothing', 'لا شيء') },
  }
}
export const swipeTone = (a: SwipeAction): 'success' | 'primary' | 'warning' | 'danger' | '' => ({ complete: 'success', tomorrow: 'warning', nextweek: 'warning', focus: 'primary', delete: 'danger', none: '' } as const)[a]
