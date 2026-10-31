import { useEffect, useId, useRef, type ReactNode } from 'react'
import { useText } from '../../lib/i18n'
export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
 const ref = useRef<HTMLDialogElement>(null); const t = useText(); const titleId = useId()
 useEffect(() => { const dialog = ref.current; const previous = document.activeElement as HTMLElement; dialog?.showModal(); dialog?.querySelector<HTMLElement>('[data-autofocus]')?.focus(); return () => { dialog?.close(); previous?.focus() } }, [])
 return <dialog ref={ref} onCancel={onClose} className="os-dialog" aria-labelledby={titleId}><header className="row"><h2 id={titleId}>{title}</h2><button type="button" className="quiet" onClick={onClose} aria-label={t('Close', 'إغلاق')}>×</button></header>{children}</dialog>
}
export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div> }
export function ErrorMessage({ error }: { error: string }) { return error ? <p role="alert" className="error">{error}</p> : null }
export function Skeleton({ lines, height }: { lines?: number; height?: number }) {
 if (lines) return <div className="skeleton-lines" aria-hidden="true">{Array.from({ length: lines }, (_, i) => <div key={i} className="skeleton" style={{ height: 18, width: `${92 - i * 14}%` }} />)}</div>
 return <div className="skeleton" aria-hidden="true" style={{ height: height || 80 }} />
}
export function Drawer({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
 const ref = useRef<HTMLDialogElement>(null); const t = useText()
 useEffect(() => { const dialog = ref.current; const previous = document.activeElement as HTMLElement; dialog?.showModal(); dialog?.querySelector<HTMLElement>('[data-autofocus]')?.focus(); return () => { dialog?.close(); previous?.focus() } }, [])
 return <dialog ref={ref} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose() }} className="os-drawer"><div className="drawer-inner"><header className="row"><h2>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label={t('Close', 'إغلاق')}>×</button></header><div className="drawer-body">{children}</div>{footer && <footer className="drawer-footer">{footer}</footer>}</div></dialog>
}
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
 return <div className="empty-state">{icon && <span className="empty-icon" aria-hidden="true">{icon}</span>}<h3>{title}</h3>{children && <p className="muted">{children}</p>}{action}</div>
}
