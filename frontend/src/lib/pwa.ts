import { useEffect, useState, useSyncExternalStore } from 'react'

declare const __BUILD_ID__: string

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

/**
 * Register the service worker in production builds. `onUpdate` receives a function that activates
 * the waiting worker; the page reloads only after the user chose to update.
 */
export function registerServiceWorker(onUpdate: (apply: () => void) => void) {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  let updating = false
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating) location.reload() })
  const register = async () => {
    try {
      const registration = await navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(__BUILD_ID__)}`, { scope: '/' })
      const offer = (worker: ServiceWorker) => onUpdate(() => { updating = true; worker.postMessage({ type: 'SKIP_WAITING' }) })
      if (registration.waiting && navigator.serviceWorker.controller) offer(registration.waiting)
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing
        worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker) })
      })
      setInterval(() => void registration.update().catch(() => {}), 60 * 60 * 1000)
    } catch { /* The app works without a service worker. */ }
  }
  if (document.readyState === 'complete') void register(); else window.addEventListener('load', () => void register(), { once: true })
}

export function useOnline() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine)
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false)
    window.addEventListener('online', up); window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])
  return online
}

// The browser offers the install prompt once, early, so it is captured here when this file loads and handed to whichever
// screen asks (Settings, the Today banner, the menu), however late it mounts.
let deferred: InstallEvent | null = null, installedNow = false, version = 0
const listeners = new Set<() => void>()
const changed = () => { version++; listeners.forEach(l => l()) }
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e as InstallEvent; changed() })
  window.addEventListener('appinstalled', () => { deferred = null; installedNow = true; changed() })
}
/** Forgets what was offered or installed; for tests, which share one page. */
export function resetInstallState() { deferred = null; installedNow = false; changed() }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** Running as an installed app (home-screen icon) rather than in a browser tab. */
export const isInstalledApp = () => typeof window !== 'undefined' && (installedNow || !!window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true)
/** iPhone and iPad: Safari has no install prompt; the app is added from the Share sheet instead. */
export const isAppleTouch = () => typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

/**
 * What can be done to install LifeOS from this browser:
 * - `canInstall`: the browser handed over its install prompt (Chrome and Edge on Android and desktop): one tap installs.
 * - `apple`: iPhone or iPad, where the user adds it from the Share sheet (steps are shown).
 * - neither: the browser may still offer "Install app" or "Add to Home screen" in its own menu; nothing is promised.
 */
export function useInstallPrompt() {
  useSyncExternalStore(subscribe, () => version, () => 0)
  const installed = isInstalledApp()
  return {
    installed,
    canInstall: !!deferred && !installed,
    apple: isAppleTouch() && !installed,
    install: async () => {
      const event = deferred
      if (!event) return false
      await event.prompt()
      const choice = await event.userChoice
      deferred = null; changed()
      return choice.outcome === 'accepted'
    },
  }
}
