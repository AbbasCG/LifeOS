import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { m } from 'motion/react'
import { AlertTriangle, ArrowDown, ArrowUp, CalendarClock, CheckSquare, ChevronDown, Flame, Minus, Target, Users, X, Zap, type LucideIcon } from 'lucide-react'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'

/**
 * LifeOS visual language (V20): small, reusable pieces that let a screen be read at a glance — rings and numbers
 * instead of sentences, an icon plus a word for every status (never color alone), one obvious action.
 */

/** A progress ring with the value in the middle. The label is spoken; the ring itself is decoration. */
export function ProgressRing({ value, max = 100, size = 64, stroke = 7, tone = 'primary', label, children }: { value: number; max?: number; size?: number; stroke?: number; tone?: 'primary' | 'success' | 'warning' | 'danger' | 'accent'; label: string; children?: ReactNode }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  return <span className={`vring tone-${tone}`} style={{ width: size, height: size }} role="img" aria-label={label}>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
      <m.circle className="ring-value" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={c}
        initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - ratio) }} transition={{ type: 'spring', stiffness: 120, damping: 22 }} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
    {children !== undefined && <span className="ring-center" aria-hidden="true">{children}</span>}
  </span>
}

/** A ring with a short caption: the glanceable stat used on Today, Goals and Analytics. */
export function RingStat({ value, max, display, caption, tone, to }: { value: number; max: number; display: ReactNode; caption: string; tone?: 'primary' | 'success' | 'warning' | 'danger' | 'accent'; to?: string }) {
  const body = <><ProgressRing value={value} max={max} size={58} stroke={6} tone={tone} label={`${caption}: ${typeof display === 'string' || typeof display === 'number' ? display : `${value}/${max}`}`}><strong>{display}</strong></ProgressRing><small>{caption}</small></>
  return to ? <Link className="ring-stat" to={to}>{body}</Link> : <div className="ring-stat">{body}</div>
}

const PRIORITY: Record<string, { icon: LucideIcon; en: string; ar: string }> = {
  urgent: { icon: Flame, en: 'Urgent', ar: 'عاجل' }, high: { icon: ArrowUp, en: 'High', ar: 'عالية' }, medium: { icon: Minus, en: 'Medium', ar: 'متوسطة' }, low: { icon: ArrowDown, en: 'Low', ar: 'منخفضة' },
}

/** Priority as icon + color, with the word for screen readers (or shown when `labelled`). */
export function PriorityMark({ priority, labelled = false }: { priority?: string | null; labelled?: boolean }) {
  const t = useText(), p = PRIORITY[priority ?? ''] ?? PRIORITY.medium
  const Icon = p.icon
  return <span className={`prio prio-${priority ?? 'medium'}`} title={t(p.en, p.ar)}><Icon size={13} aria-hidden="true" />{labelled ? <span>{t(p.en, p.ar)}</span> : <span className="sr-only">{t(p.en, p.ar)}</span>}</span>
}

/** A deadline as a short relative chip: "Today 14:00", "Tomorrow", "Tue", "3d late" (late is red with an icon). */
export function DueChip({ due, done = false }: { due?: string | null; done?: boolean }) {
  const t = useText(), { language } = useLanguage()
  if (!due) return null
  const d = new Date(due), now = new Date()
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(d) - day(now)) / 86400000)
  const late = !done && d.getTime() < now.getTime()
  const time = d.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
  const text = late && diff < 0 ? t(`${-diff}d late`, `متأخرة ${-diff} يوم`)
    : diff === 0 ? (d.getHours() || d.getMinutes() ? `${t('Today', 'اليوم')} ${time}` : t('Today', 'اليوم'))
      : diff === 1 ? t('Tomorrow', 'غداً')
        : diff > 1 && diff < 7 ? d.toLocaleDateString(language, { weekday: 'short' })
          : d.toLocaleDateString(language, { day: 'numeric', month: 'short' })
  return <span className={`due ${late ? 'late' : diff === 0 ? 'today' : ''}`} title={d.toLocaleString(language)}>{late ? <AlertTriangle size={12} aria-hidden="true" /> : <CalendarClock size={12} aria-hidden="true" />}<time dateTime={due}>{text}</time></span>
}

/** The kind of a calendar item as an icon: meetings, focus blocks, tasks, everything else. */
export function KindIcon({ kind, source, size = 14 }: { kind?: string; source?: string; size?: number }) {
  const Icon = kind === 'focus' || kind === 'flexible' ? Target : kind === 'task' ? CheckSquare : source && source !== 'lifeos' ? Users : kind === 'fixed' ? Users : Zap
  return <Icon size={size} aria-hidden="true" className="kind-icon" />
}

/** A large, thumb-friendly action tile: icon over one or two words. */
export function QuickAction({ icon: Icon, label, to, onClick, tone = 'default' }: { icon: LucideIcon; label: string; to?: string; onClick?: () => void; tone?: 'default' | 'primary' }) {
  const inner = <><span className="qa-icon"><Icon size={20} aria-hidden="true" /></span><span>{label}</span></>
  return to ? <Link className={`quick-action tone-${tone}`} to={to}>{inner}</Link> : <button type="button" className={`quick-action tone-${tone}`} onClick={onClick}>{inner}</button>
}

/** Details on request: a native disclosure (keyboard and screen-reader friendly), collapsed by default. */
export function Expandable({ summary, icon, children, defaultOpen = false, className = '' }: { summary: ReactNode; icon?: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen)
  return <details className={`expandable ${className}`} open={open} onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
    <summary>{icon}<span>{summary}</span><ChevronDown size={16} className="chev" aria-hidden="true" /></summary>
    {open && <div className="expandable-body">{children}</div>}
  </details>
}

/**
 * A bottom sheet on phones, a centered card on larger screens. Built on <dialog> so focus is trapped, Escape closes
 * it and the page behind is inert.
 */
export function BottomSheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null), t = useText(), id = useId()
  useEffect(() => { const dialog = ref.current, previous = document.activeElement as HTMLElement | null; dialog?.showModal?.(); return () => { dialog?.close?.(); previous?.focus?.() } }, [])
  return <dialog ref={ref} className="sheet" aria-labelledby={id} onCancel={e => { e.preventDefault(); onClose() }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="sheet-inner">
      <span className="sheet-handle" aria-hidden="true" />
      <header className="sheet-head"><h2 id={id}>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label={t('Close', 'إغلاق')}><X size={18} /></button></header>
      <div className="sheet-body">{children}</div>
      {footer && <footer className="sheet-foot">{footer}</footer>}
    </div>
  </dialog>
}

/** Compact page header: a title (kept for orientation and screen readers) and the one primary action. */
export function PageHead({ title, icon: Icon, action, children }: { title: string; icon?: LucideIcon; action?: ReactNode; children?: ReactNode }) {
  return <header className="page-head">
    <h1>{Icon && <Icon size={22} aria-hidden="true" />}{title}</h1>
    {children && <div className="page-head-extra">{children}</div>}
    {action && <div className="page-head-action">{action}</div>}
  </header>
}

/** A small empty state: one icon, one short line, one action. */
export function EmptyNote({ icon: Icon, text, action }: { icon: LucideIcon; text: string; action?: ReactNode }) {
  return <div className="empty-note"><Icon size={22} aria-hidden="true" /><span>{text}</span>{action}</div>
}
