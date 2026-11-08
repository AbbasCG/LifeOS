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

export type Release = { key: string; date: string; revision: number; importance: 'normal' | 'important'; title: string; summary: string; items: DiscoveryItem[] }
export type HistoryRelease = Release & { seen: boolean; helpful: boolean | null }
export type Bootstrap = { announcement: Release | null; update_required: boolean; counts: { unseen_updates: number }; preferences: { hints_enabled: boolean } }
export type StateAction = 'seen' | 'snoozed' | 'dismissed' | 'helpful' | 'unhelpful'

/** An installed app or a phone-sized screen is "mobile"; this only chooses which announcements are meant for this screen. */
export function surface(): Surface {
  return isInstalledApp() || window.matchMedia?.('(max-width: 700px)').matches ? 'mobile' : 'web'
}

export const discoveryQuery = () => `surface=${surface()}&client=${DISCOVERY_CLIENT}`

export const loadBootstrap = () => api<{ data: Bootstrap }>(`/api/discovery/bootstrap?${discoveryQuery()}`).then(r => r.data)
export const releasesPath = () => `/api/discovery/releases?${discoveryQuery()}`
export const recordState = (type: 'release' | 'feature' | 'tour' | 'hint', key: string, action: StateAction | 'started' | 'completed' | 'skipped') =>
  api(`/api/discovery/states/${type}/${key}`, 'PUT', { action, surface: surface() })
export const tryFeature = (id: string) =>
  api<{ data: { available: boolean; reason: string | null; route: string | null; tour: string | null } }>(`/api/discovery/features/${id}/try?${discoveryQuery()}`, 'POST').then(r => r.data)

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
