import { useSyncExternalStore } from 'react'

/**
 * Whether the account still has its first-run setup ahead (`onboarding`) and how much navigation it shows (`uiMode`). Both arrive with the
 * settings (AppLayout reads them once; Settings and the setup update them when saved). Until then, and for anything unknown, the values every
 * account had before these settings existed apply: setup done, the full navigation. So an older account never sees a change.
 * `moreOpen` is this viewer's choice for the «More» part of the simple navigation, kept in this browser only.
 */
export type UiPrefs = { onboarding: 'pending' | 'done'; uiMode: 'simple' | 'full'; moreOpen: boolean }
const MORE_KEY = 'lifeos-nav-more'
const readMore = () => { try { return localStorage.getItem(MORE_KEY) === 'open' } catch { return false } }
let prefs: UiPrefs = { onboarding: 'done', uiMode: 'full', moreOpen: readMore() }
const listeners = new Set<() => void>()
const update = (next: UiPrefs) => {
  if (next.onboarding === prefs.onboarding && next.uiMode === prefs.uiMode && next.moreOpen === prefs.moreOpen) return
  prefs = next
  listeners.forEach(l => l())
}

/** Takes the settings as the server returns them; only the two fields it knows are read. */
export function setUiPrefs(p?: { onboarding?: unknown; ui_mode?: unknown } | null) {
  update({ ...prefs, onboarding: p?.onboarding === 'pending' ? 'pending' : 'done', uiMode: p?.ui_mode === 'simple' ? 'simple' : 'full' })
}
/** Opens or closes «More» in the simple navigation and remembers it for this viewer (when the browser lets us). */
export function setMoreOpen(open: boolean) {
  try { localStorage.setItem(MORE_KEY, open ? 'open' : 'closed') } catch { /* kept for this visit only */ }
  update({ ...prefs, moreOpen: open })
}
/** Shows every navigation item without remembering it (a tour pointing at an item inside «More»). */
export const revealNav = () => { if (prefs.uiMode === 'simple' && !prefs.moreOpen) update({ ...prefs, moreOpen: true }) }
export const uiPrefs = () => prefs
export const useUiPrefs = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, uiPrefs, uiPrefs)
