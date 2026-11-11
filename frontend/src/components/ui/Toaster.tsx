import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { ToastContext, type Toast, type ToastApi } from '../../lib/toast'
import { useText } from '../../lib/i18n'
import { prefersReducedMotion } from '../../lib/viewTransition'

const icons = { success: CheckCircle2, error: AlertCircle, info: Info }
type Timer = { handle?: ReturnType<typeof setTimeout>; remaining: number; startedAt: number; ms: number }
type Item = Toast & { ms: number; leaving?: boolean }
const LEAVE_MS = 160
// A non-modal dialog (show()) keeps the page interactive, so only modal ones host the region. Without :modal support every open dialog counts.
const isModal = (dialog: Element) => { try { return !CSS.supports('selector(:modal)') || dialog.matches(':modal') } catch { return true } }
/** Playing animations by element + name, so moving the region to another parent (which restarts CSS animations) can put them back. */
const playing = (root: Element) => {
  try { return root.getAnimations({ subtree: true }).map(a => ({ node: (a.effect as KeyframeEffect | null)?.target, name: (a as CSSAnimation).animationName, time: a.currentTime })) } catch { return [] }
}
const resume = (root: Element, saved: ReturnType<typeof playing>) => {
  // Re-inserting a node restarts its CSS animations. Put the running ones back where they were; any other (an enter that had already
  // finished) is a replay of something the person has seen, so it jumps to its end before it can paint.
  try {
    root.getAnimations({ subtree: true }).forEach(a => {
      const was = saved.find(s => s.node === (a.effect as KeyframeEffect | null)?.target && s.name === (a as CSSAnimation).animationName)
      if (was && was.time !== null) a.currentTime = was.time; else a.finish()
    })
  } catch { /* animations are decoration */ }
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useText()
  const [toasts, setToasts] = useState<Item[]>([])
  // Content outside an open modal <dialog> is inert and hidden from assistive tech, so while one is open the
  // toast region (a live region) is moved inside the most recently opened one. The region is position: fixed, so it stays at the
  // viewport corner. One container element is created once and only moved: React keeps rendering into it, so no toast remounts.
  const [container] = useState(() => typeof document === 'undefined' ? null : document.createElement('div'))
  const [pausedUi, setPausedUi] = useState(false)
  const nextId = useRef(1)
  const region = useRef<HTMLDivElement>(null)
  const timers = useRef(new Map<number, Timer>())
  const paused = useRef(false)
  const hover = useRef(false), focus = useRef(false)
  const returnTo = useRef<HTMLElement | null>(null)
  const dismiss = useCallback((id: number) => {
    const el = region.current
    if (el?.contains(document.activeElement)) {
      // Never drop focus to <body>: go to another toast's dismiss button, else back to where the person was.
      const own = (document.activeElement as HTMLElement).closest('.toast')
      const sibling = Array.from(el.querySelectorAll<HTMLElement>('.toast:not([data-leaving])')).find(node => node !== own)?.querySelector<HTMLElement>('.icon-button')
      const back = returnTo.current?.isConnected ? returnTo.current : null
      ;(sibling ?? back)?.focus()
    }
    clearTimeout(timers.current.get(id)?.handle); timers.current.delete(id)
    const remove = () => setToasts(list => list.filter(item => item.id !== id))
    // Fade out first (CSS plays the exit on data-leaving); JS owns the removal, never animationend. Reduced motion removes at once.
    if (prefersReducedMotion()) { remove(); return }
    setToasts(list => list.map(item => item.id === id ? { ...item, leaving: true } : item))
    setTimeout(remove, LEAVE_MS)
  }, [])
  const start = useCallback((id: number, entry: Timer) => {
    entry.startedAt = Date.now(); entry.handle = setTimeout(() => dismiss(id), entry.remaining)
  }, [dismiss])
  const show = useCallback<ToastApi>((message, type = 'success', action) => {
    const id = nextId.current++, ms = type === 'error' ? 7000 : 4500
    setToasts(list => {
      // Drop timers of toasts that fall off the front of the list.
      list.slice(0, Math.max(0, list.length - 3)).forEach(old => { clearTimeout(timers.current.get(old.id)?.handle); timers.current.delete(old.id) })
      return [...list.slice(-3), { id, type, message, action, ms }]
    })
    // A toast with an action (Undo, Reload) waits until it is used or dismissed: a keyboard user cannot reach it in 4.5 s (WCAG 2.2.1).
    if (action) return
    const entry: Timer = { remaining: ms, startedAt: 0, ms }
    timers.current.set(id, entry)
    if (!paused.current) start(id, entry)
  }, [start])
  // WCAG 2.2.1: reading time must not run out while the pointer or keyboard focus is on the toasts.
  const sync = useCallback(() => {
    const next = hover.current || focus.current
    if (next === paused.current) return
    paused.current = next; setPausedUi(next)
    timers.current.forEach((entry, id) => {
      if (next) { clearTimeout(entry.handle); entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt)) } else start(id, entry)
      // The timer is the truth: put the progress bar exactly where the remaining time says (a slow first frame can leave it behind).
      try { region.current?.querySelector(`[data-toast="${id}"] .toast-bar`)?.getAnimations().forEach(a => { a.currentTime = entry.ms - entry.remaining }) } catch { /* decoration only */ }
    })
  }, [start])
  useEffect(() => { const map = timers.current; return () => map.forEach(entry => clearTimeout(entry.handle)) }, [])
  // A toast node that unmounts while focused or hovered fires no blur / mouseleave, so re-read the real state after every change.
  useEffect(() => {
    const el = region.current
    focus.current = !!el?.contains(document.activeElement)
    try { hover.current = !!el?.matches(':hover') } catch { hover.current = false }
    sync()
  }, [toasts, sync])
  // Follow the most recently opened modal dialog that is still open and not on its way out (not DOM order: a dialog opened later may sit earlier in the page).
  useEffect(() => {
    if (!container) return
    const opened: Element[] = []
    const place = () => {
      const open = Array.from(document.querySelectorAll('dialog[open]:not([data-closing])')).filter(isModal)
      for (let i = opened.length - 1; i >= 0; i--) if (!open.includes(opened[i])) opened.splice(i, 1)
      open.forEach(dialog => { if (!opened.includes(dialog)) opened.push(dialog) })
      const target = opened[opened.length - 1] ?? document.body
      if (container.parentNode === target) return
      const saved = playing(container)
      target.appendChild(container)
      resume(container, saved)
    }
    place()
    // A dialog removed from the page closes on a detached node, which fires no `open` change, so also watch for removal.
    const observer = new MutationObserver(records => { if (!records.every(record => container.contains(record.target))) place() })
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'data-closing'] })
    return () => { observer.disconnect(); container.remove() }
  }, [container])
  // The region itself is the live region: it exists (empty) before the first message, on the page and inside any open dialog.
  const layer = <div ref={region} className="toast-region" role="status" aria-live="polite" data-paused={pausedUi || undefined}
    onMouseEnter={() => { hover.current = true; sync() }} onMouseLeave={() => { hover.current = false; sync() }}
    onFocus={e => { if (!focus.current && !region.current?.contains(e.relatedTarget as Node | null)) returnTo.current = e.relatedTarget as HTMLElement | null; focus.current = true; sync() }}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { focus.current = false; sync() } }}>
    {toasts.map(toast => {
      const Icon = icons[toast.type]
      return <div key={toast.id} className={`toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : undefined} data-toast={toast.id} data-leaving={toast.leaving || undefined}>
        <Icon size={18} aria-hidden="true" /><p>{toast.message}</p>
        {toast.action && <button className="toast-action" onClick={() => { toast.action!.onClick(); dismiss(toast.id) }}>{toast.action.label}</button>}
        <button className="icon-button" aria-label={t('Dismiss', 'إغلاق', 'Sluiten')} onClick={() => dismiss(toast.id)}><X size={15} /></button>
        {!toast.action && <span className="toast-bar" aria-hidden="true" style={{ '--ms': `${toast.ms}ms` } as CSSProperties} />}
      </div>
    })}
  </div>
  return <ToastContext.Provider value={show}>
    {children}
    {container && createPortal(layer, container)}
  </ToastContext.Provider>
}
