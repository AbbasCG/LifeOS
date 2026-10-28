import { lazy, type ComponentType } from 'react'

/**
 * A component loaded on first use (V25), to keep it out of the bundle every page loads.
 * If its file cannot be fetched (offline before it was ever cached), it renders nothing instead of breaking the page;
 * `preload` fetches it ahead of time so the service worker keeps it for offline use.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPart<P extends Record<string, any>>(load: () => Promise<ComponentType<P>>) {
  const Part = lazy(() => load().then(component => ({ default: component }), () => ({ default: (() => null) as ComponentType<P> })))
  return Object.assign(Part, { preload: () => { void load().catch(() => {}) } })
}

/** Runs once the browser is idle (or after a short delay where idle callbacks are missing). */
export function whenIdle(run: () => void) {
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 4000 })
  else setTimeout(run, 2000)
}
