import { useEffect, useState } from 'react'

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

/** The browser's deferred install prompt, when the app is installable and not yet installed. */
export function useInstallPrompt() {
  const [event, setEvent] = useState<InstallEvent | null>(null)
  const [installed, setInstalled] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches)
  useEffect(() => {
    const capture = (e: Event) => { e.preventDefault(); setEvent(e as InstallEvent) }
    const done = () => { setInstalled(true); setEvent(null) }
    window.addEventListener('beforeinstallprompt', capture); window.addEventListener('appinstalled', done)
    return () => { window.removeEventListener('beforeinstallprompt', capture); window.removeEventListener('appinstalled', done) }
  }, [])
  return { canInstall: !!event && !installed, installed, install: async () => { if (!event) return false; await event.prompt(); const choice = await event.userChoice; setEvent(null); return choice.outcome === 'accepted' } }
}
