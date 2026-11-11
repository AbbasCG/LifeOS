import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { ToastContext, type Toast, type ToastApi } from '../../lib/toast'
import { useText } from '../../lib/i18n'

const icons = { success: CheckCircle2, error: AlertCircle, info: Info }
type Timer = { handle?: ReturnType<typeof setTimeout>; remaining: number; startedAt: number }
const topModal = () => { const all = document.querySelectorAll('dialog[open]'); return all.length ? all[all.length - 1] : null }

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useText()
  const [toasts, setToasts] = useState<Toast[]>([])
  // Content outside an open modal <dialog> is inert and hidden from assistive tech, so while one is open the
  // toasts (and their live regions) are rendered inside it. The region is position: fixed, so it stays at the viewport corner.
  const [host, setHost] = useState<HTMLElement | null>(null)
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
      const sibling = Array.from(el.querySelectorAll<HTMLElement>('.toast')).find(node => node !== own)?.querySelector<HTMLElement>('.icon-button')
      const back = returnTo.current?.isConnected ? returnTo.current : null
      ;(sibling ?? back)?.focus()
    }
    clearTimeout(timers.current.get(id)?.handle); timers.current.delete(id)
    setToasts(list => list.filter(item => item.id !== id))
  }, [])
  const start = useCallback((id: number, entry: Timer) => {
    entry.startedAt = Date.now(); entry.handle = setTimeout(() => dismiss(id), entry.remaining)
  }, [dismiss])
  const show = useCallback<ToastApi>((message, type = 'success', action) => {
    const id = nextId.current++
    setToasts(list => {
      // Drop timers of toasts that fall off the front of the list.
      list.slice(0, Math.max(0, list.length - 3)).forEach(old => { clearTimeout(timers.current.get(old.id)?.handle); timers.current.delete(old.id) })
      return [...list.slice(-3), { id, type, message, action }]
    })
    const entry: Timer = { remaining: type === 'error' ? 7000 : 4500, startedAt: 0 }
    timers.current.set(id, entry)
    if (!paused.current) start(id, entry)
  }, [start])
  // WCAG 2.2.1: reading time must not run out while the pointer or keyboard focus is on the toasts.
  const sync = useCallback(() => {
    const next = hover.current || focus.current
    if (next === paused.current) return
    paused.current = next
    timers.current.forEach((entry, id) => {
      if (next) { clearTimeout(entry.handle); entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt)) } else start(id, entry)
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
  // Follow the topmost open modal dialog.
  const hostRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const attach = () => {
      const dialog = topModal(), current = hostRef.current
      // A dialog removed from the page is closed on a detached node, which no observer sees, so also watch for removal.
      if (current?.isConnected && dialog && current.parentElement === dialog) return
      current?.remove()
      hostRef.current = dialog ? dialog.appendChild(document.createElement('div')) : null
      setHost(hostRef.current)
    }
    attach()
    const observer = new MutationObserver(attach)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] })
    return () => { observer.disconnect(); hostRef.current?.remove(); hostRef.current = null }
  }, [])
  // The region itself is the live region: it exists (empty) before the first message, on the page and inside any open dialog.
  const layer = <div ref={region} className="toast-region" role="status" aria-live="polite"
    onMouseEnter={() => { hover.current = true; sync() }} onMouseLeave={() => { hover.current = false; sync() }}
    onFocus={e => { if (!focus.current && !region.current?.contains(e.relatedTarget as Node | null)) returnTo.current = e.relatedTarget as HTMLElement | null; focus.current = true; sync() }}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { focus.current = false; sync() } }}>
    {toasts.map(toast => {
      const Icon = icons[toast.type]
      return <div key={toast.id} className={`toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : undefined}>
        <Icon size={18} aria-hidden="true" /><p>{toast.message}</p>
        {toast.action && <button className="toast-action" onClick={() => { toast.action!.onClick(); dismiss(toast.id) }}>{toast.action.label}</button>}
        <button className="icon-button" aria-label={t('Dismiss', 'إغلاق', 'Sluiten')} onClick={() => dismiss(toast.id)}><X size={15} /></button>
      </div>
    })}
  </div>
  return <ToastContext.Provider value={show}>
    {children}
    {host ? createPortal(layer, host) : layer}
  </ToastContext.Provider>
}
