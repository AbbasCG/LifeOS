import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { prefersReducedMotion } from './viewTransition'

/**
 * Close a <dialog> with a short exit animation: sets data-closing (CSS plays the ~140ms exit), waits for the dialog's own
 * animationend (or 200ms, 260ms once the exit has started, whichever comes first), then calls `onClose`, which unmounts it. With reduced motion, or a dialog that
 * is not open, `onClose` runs at once. Calling it again while closing does nothing. Closes started by the parent (saving, a route
 * change) unmount at once and are not animated.
 */
export function useAnimatedClose(ref: RefObject<HTMLDialogElement | null>, onClose: () => void) {
 const latest = useRef(onClose), cleanup = useRef<(() => void) | null>(null)
 useEffect(() => { latest.current = onClose })
 useEffect(() => () => cleanup.current?.(), [])
 return useCallback(() => {
  const dialog = ref.current
  if (cleanup.current) return
  // No exit when there is nothing to play it (reduced motion, or an engine without the Web Animations API, such as jsdom).
  if (!dialog || !dialog.open || prefersReducedMotion() || typeof dialog.getAnimations !== 'function') { latest.current(); return }
  // inert: during the exit nothing in the dialog can be clicked or focused again (no double submit).
  dialog.setAttribute('data-closing', ''); dialog.setAttribute('inert', '')
  const finish = () => {
   cleanup.current?.(); latest.current()
   // Normally the parent unmounts the dialog by now; if it chose to stay open, show it again.
   setTimeout(() => { if (dialog.isConnected) { dialog.removeAttribute('data-closing'); dialog.removeAttribute('inert') } }, 120)
  }
  const end = (e: AnimationEvent) => { const el = e.target as Element; if (el === dialog || el.parentElement === dialog) finish() }
  // The fallback covers a browser that never plays the exit; once the exit has really started, give it time to end on a slow frame.
  let timer = setTimeout(finish, 200)
  const begin = (e: AnimationEvent) => { const el = e.target as Element; if (el === dialog || el.parentElement === dialog) { clearTimeout(timer); timer = setTimeout(finish, 260) } }
  dialog.addEventListener('animationstart', begin); dialog.addEventListener('animationend', end)
  cleanup.current = () => { clearTimeout(timer); dialog.removeEventListener('animationstart', begin); dialog.removeEventListener('animationend', end); cleanup.current = null }
 }, [ref])
}
