import { useEffect, useRef, type ReactNode } from 'react'
import { useText } from '../../lib/i18n'
export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
 const ref = useRef<HTMLDialogElement>(null); const t = useText()
 useEffect(() => { const dialog = ref.current; const previous = document.activeElement as HTMLElement; dialog?.showModal(); return () => { dialog?.close(); previous?.focus() } }, [])
 return <dialog ref={ref} onCancel={onClose} className="os-dialog"><header className="row"><h2>{title}</h2><button type="button" className="quiet" onClick={onClose} aria-label={t('Close', 'إغلاق')}>×</button></header>{children}</dialog>
}
export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div> }
export function ErrorMessage({ error }: { error: string }) { return error ? <p role="alert" className="error">{error}</p> : null }
export function Skeleton({ lines, height }: { lines?: number; height?: number }) {
 if (lines) return <div className="skeleton-lines" aria-hidden="true">{Array.from({ length: lines }, (_, i) => <div key={i} className="skeleton" style={{ height: 18, width: `${92 - i * 14}%` }} />)}</div>
 return <div className="skeleton" aria-hidden="true" style={{ height: height || 80 }} />
}
