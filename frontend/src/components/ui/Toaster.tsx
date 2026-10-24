import { useCallback, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { ToastContext, type Toast, type ToastApi } from '../../lib/toast'
import { useText } from '../../lib/i18n'

const icons = { success: CheckCircle2, error: AlertCircle, info: Info }

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useText()
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)
  const dismiss = useCallback((id: number) => setToasts(list => list.filter(item => item.id !== id)), [])
  const show = useCallback<ToastApi>((message, type = 'success', action) => {
    const id = nextId.current++
    setToasts(list => [...list.slice(-3), { id, type, message, action }])
    setTimeout(() => dismiss(id), type === 'error' ? 7000 : 4500)
  }, [dismiss])
  return <ToastContext.Provider value={show}>
    {children}
    <div className="toast-region" role="status" aria-live="polite">
      {toasts.map(toast => {
        const Icon = icons[toast.type]
        return <div key={toast.id} className={`toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : undefined}>
          <Icon size={18} aria-hidden="true" /><p>{toast.message}</p>
          {toast.action && <button className="toast-action" onClick={() => { toast.action!.onClick(); dismiss(toast.id) }}>{toast.action.label}</button>}
          <button className="icon-button" aria-label={t('Dismiss', 'إغلاق')} onClick={() => dismiss(toast.id)}><X size={15} /></button>
        </div>
      })}
    </div>
  </ToastContext.Provider>
}
