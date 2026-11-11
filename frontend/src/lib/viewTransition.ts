/** Motion helpers shared by the dialogs, toasts and Settings tabs. */

/** True when the person asked the system for less motion. Read at call time, so a change applies at once. */
export function prefersReducedMotion(): boolean {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/**
 * Run `update` (it must change the DOM synchronously, e.g. inside flushSync) inside a same-document View Transition.
 * Without document.startViewTransition, or with reduced motion, `update` just runs. Only `settings-pane` and the tab
 * indicator are named in CSS, never the root, so the rest of the page stays live.
 */
export function withTransition(update: () => void): void {
  const start = (document as Document & { startViewTransition?: (callback: () => void) => unknown }).startViewTransition
  if (typeof start !== 'function' || prefersReducedMotion()) { update(); return }
  try { start.call(document, update) } catch { update() }
}
