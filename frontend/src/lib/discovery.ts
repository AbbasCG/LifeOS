import { api } from './api'
import { isInstalledApp } from './pwa'

/**
 * Product updates and feature discovery (Product Experience 2.0). The server decides what a person may see; this file
 * only asks and reports back.
 *
 * DISCOVERY_CLIENT is raised, in the pull request that ships a new screen, to the number the content files name for that
 * feature (`client_version`). A tab opened before the update then sends a smaller number and is told to reload instead of
 * being offered a "Try now" for a screen it does not have.
 */
export const DISCOVERY_CLIENT = 1

export type Surface = 'web' | 'mobile'
export type ItemType = 'new' | 'improved' | 'fixed' | 'important'

export type DiscoveryItem = {
  type: ItemType
  title: string
  body: string
  feature: string | null
  can_try: boolean
  unavailable_reason: string | null
  tour: string | null
  tried: boolean
  is_new: boolean
  link: string | null
  image?: { src: string; alt: string }
  video?: { src: string; poster: string; captions?: string; label: string }
}

export type CatalogueFeature = {
  id: string; category: string; name: string; description: string; route: string; release: string; date: string
  can_try: boolean; unavailable_reason: 'setup_needed' | 'platform' | 'update_required' | string | null
  /** The tour of this feature (also after it was finished, so it can be watched again); null when there is none or the feature cannot be tried. */
  tour: string | null; tour_done: boolean; tried: boolean; is_new: boolean
  image?: { src: string; alt: string }
}
export type Release = { key: string; date: string; revision: number; importance: 'normal' | 'important'; title: string; summary: string; items: DiscoveryItem[] }
export type HistoryRelease = Release & { seen: boolean; helpful: boolean | null }
export type Bootstrap = { announcement: Release | null; update_required: boolean; counts: { unseen_updates: number }; preferences: { hints_enabled: boolean } }
export type NewFeature = { id: string; route: string; name: string }
export type Hint = { id: string; feature: string; target: string; route: string; text: string }
export type Guide = { new: NewFeature[]; hints: Hint[] }
export type TourStep = { target: string; route: string | null; reveal: 'sidebar' | null; placement: 'auto' | 'top' | 'bottom' | 'start' | 'end'; optional: boolean; title: string; body: string }
export type Tour = { id: string; version: number; title: string; steps: TourStep[]; state: { step_index: number; completed: boolean; skipped: boolean } }
export type StateAction = 'seen' | 'snoozed' | 'dismissed' | 'helpful' | 'unhelpful'

/** An installed app or a phone-sized screen is "mobile"; this only chooses which announcements are meant for this screen. */
export function surface(): Surface {
  return isInstalledApp() || window.matchMedia?.('(max-width: 700px)').matches ? 'mobile' : 'web'
}

export const discoveryQuery = () => `surface=${surface()}&client=${DISCOVERY_CLIENT}`

export const featuresPath = () => `/api/discovery/features?${discoveryQuery()}`
export const loadBootstrap = () => api<{ data: Bootstrap }>(`/api/discovery/bootstrap?${discoveryQuery()}`).then(r => r.data)
export const releasesPath = () => `/api/discovery/releases?${discoveryQuery()}`
export const recordState = (type: 'release' | 'feature' | 'tour' | 'hint', key: string, action: StateAction | 'started' | 'completed' | 'skipped' | 'step', stepIndex?: number) =>
  api(`/api/discovery/states/${type}/${key}`, 'PUT', { action, surface: surface(), ...(stepIndex === undefined ? {} : { step_index: stepIndex }) })
export const tryFeature = (id: string) =>
  api<{ data: { available: boolean; reason: string | null; route: string | null; tour: string | null } }>(`/api/discovery/features/${id}/try?${discoveryQuery()}`, 'POST').then(r => r.data)

export const loadTour = (id: string) => api<{ data: Tour }>(`/api/discovery/tours/${id}`).then(r => r.data)
/** Starts a tour from anywhere (a "Try now" button, the update history). The tour host listens for it. */
export const START_TOUR = 'lifeos:start-tour'
export const startTour = (id: string) => window.dispatchEvent(new CustomEvent(START_TOUR, { detail: { id } }))
export const loadGuide = () => api<{ data: Guide }>(`/api/discovery/guide?${discoveryQuery()}`).then(r => r.data)
export const setHintsEnabled = (enabled: boolean) => api('/api/settings', 'PUT', { discovery: { hints_enabled: enabled } })

// ---- "New" badges: the features this person has not tried yet, shared by the menu and the hint host ----
let newFeatures: NewFeature[] = []
const listeners = new Set<() => void>()
export const setNewFeatures = (list: NewFeature[]) => { newFeatures = list; listeners.forEach(l => l()) }
export const subscribeNew = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const getNewFeatures = () => newFeatures
/** The path of a content route ("/tasks?add=task" is "/tasks"). */
export const routePath = (route: string) => route.split(/[?#]/)[0]

const HINT_SHOWN = 'lifeos-discovery-hint'
/** One hint per browser session, like announcements: a second one waits for the next visit. */
export const hintShownThisSession = () => { try { return sessionStorage.getItem(HINT_SHOWN) === '1' } catch { return false } }
export const markHintShown = () => { try { sessionStorage.setItem(HINT_SHOWN, '1') } catch { /* the server's record still prevents a repeat */ } }

const SHOWN = 'lifeos-discovery-shown'
/** One announcement per visit: once something was shown in this browser session, nothing else interrupts. */
export const shownThisSession = () => { try { return sessionStorage.getItem(SHOWN) === '1' } catch { return false } }
export const markShown = () => { try { sessionStorage.setItem(SHOWN, '1') } catch { /* without storage the server's own record still prevents a repeat */ } }

/**
 * Whether now is a good moment to put something in front of the person: the page is in front, they are online, they are not
 * typing, no dialog or sheet is open and no focus session fills the screen. Anything shown without asking waits for this.
 */
export function calmMoment(): boolean {
  if (document.visibilityState !== 'visible' || navigator.onLine === false) return false
  const active = document.activeElement as HTMLElement | null
  if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.getAttribute('role') === 'textbox')) return false
  return !document.querySelector('dialog[open], .focus-immersive')
}

/** The element a hint points at: marked in the screen with data-hint (or data-tour, shared with tours) and actually visible. */
export function hintTarget(target: string): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(`[data-hint="${target}"], [data-tour="${target}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 ? el : null
}
