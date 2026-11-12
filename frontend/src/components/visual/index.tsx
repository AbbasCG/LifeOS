import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { m } from 'motion/react'
import { AlertTriangle, ArrowDown, ArrowUp, CalendarClock, CheckSquare, ChevronDown, Flame, Minus, Target, Users, X, Zap, type LucideIcon } from 'lucide-react'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useAnimatedClose } from '../../lib/useAnimatedClose'
import { formatClock, formatDayText, formatMediumDateTime } from '../../lib/clock'
import { isAllDay } from '../../lib/dueDate'
import { dayIn, displayZone } from '../../lib/taskSchedule'

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

const PRIORITY: Record<string, { icon: LucideIcon; en: string; ar: string; nl: string }> = {
  urgent: { icon: Flame, en: 'Urgent', ar: 'عاجل', nl: 'Dringend' }, high: { icon: ArrowUp, en: 'High', ar: 'عالية', nl: 'Hoog' }, medium: { icon: Minus, en: 'Medium', ar: 'متوسطة', nl: 'Gemiddeld' }, low: { icon: ArrowDown, en: 'Low', ar: 'منخفضة', nl: 'Laag' },
}

/** Priority as icon + color, with the word for screen readers (or shown when `labelled`). */
export function PriorityMark({ priority, labelled = false }: { priority?: string | null; labelled?: boolean }) {
  const t = useText(), p = PRIORITY[priority ?? ''] ?? PRIORITY.medium
  const Icon = p.icon
  return <span className={`prio prio-${priority ?? 'medium'}`} title={t(p.en, p.ar, p.nl)}><Icon size={13} aria-hidden="true" />{labelled ? <span>{t(p.en, p.ar, p.nl)}</span> : <span className="sr-only">{t(p.en, p.ar, p.nl)}</span>}</span>
}

/**
 * A deadline as a short relative chip: "Today 14:00", "Tomorrow", "Tue", "3d late" (late is red with an icon). Days and times are the
 * ACCOUNT's (the same as the form and the list badge), whatever zone this device is in. A date-only deadline (`allDay`) has no time
 * and is late only once its day has ended.
 */
export function DueChip({ due, allDay, done = false, label }: { due?: string | null; allDay?: boolean; done?: boolean; label?: string }) {
  const t = useText(), { language } = useLanguage()
  if (!due || Number.isNaN(Date.parse(due))) return null
  const d = new Date(due), now = new Date(), zone = displayZone(), date = isAllDay({ due_at: due, due_all_day: allDay })
  const dayNo = (iso: string) => { const [y, m, n] = iso.split('-').map(Number); return Date.UTC(y, m - 1, n) / 86400000 }
  const diff = Math.round(dayNo(dayIn(d, zone)) - dayNo(dayIn(now, zone)))
  const late = !done && d.getTime() < now.getTime()
  const time = formatClock(d, { language, timeZone: zone }), clock = time !== '00:00'
  const text = late && diff < 0 ? t(`${-diff}d late`, `متأخرة ${-diff} يوم`, `${-diff} d te laat`)
    : diff === 0 ? (!date && clock ? `${t('Today', 'اليوم', 'Vandaag')} ${time}` : t('Today', 'اليوم', 'Vandaag'))
      : diff === 1 ? t('Tomorrow', 'غدًا', 'Morgen')
        : formatDayText(d, { language, timeZone: zone }, diff > 1 && diff < 7 ? { weekday: 'short' } : { day: 'numeric', month: 'short' })
  const title = date ? formatDayText(d, { language, timeZone: zone }, { day: 'numeric', month: 'short', year: 'numeric' }) : formatMediumDateTime(d, { language, timeZone: zone })
  return <span className={`due ${late ? 'late' : diff === 0 ? 'today' : ''}`} title={title}>{late ? <AlertTriangle size={12} aria-hidden="true" /> : <CalendarClock size={12} aria-hidden="true" />}{label && <span className="due-label">{label}</span>}<time dateTime={due}>{text}</time></span>
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

/** The sheet's guarded close: buttons inside a sheet (Cancel) use it so they ask before throwing away unsaved work. */
const SheetCloseContext = createContext<(() => void) | null>(null)

/** A Cancel button for a sheet footer: same guard as the backdrop, Escape and the close button. */
export function SheetCancel({ children }: { children: ReactNode }) {
  const request = useContext(SheetCloseContext)
  return <button type="button" className="quiet" onClick={() => request?.()}>{children}</button>
}

/**
 * A bottom sheet on phones, a centered card on larger screens. Built on <dialog> so focus is trapped, Escape closes
 * it and the page behind is inert.
 *
 * `dirty` (optional) says whether the sheet holds work that has not been saved. When it returns true, a tap on the backdrop, Escape,
 * the close button and a <SheetCancel> first ask "Discard your changes?" instead of closing at once, so a stray tap cannot lose a
 * half-filled form. Saving closes through `onClose` directly and never asks.
 */
export function BottomSheet({ title, onClose, children, footer, tall, dirty }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; tall?: boolean; dirty?: () => boolean }) {
  const ref = useRef<HTMLDialogElement>(null), t = useText(), id = useId(), [confirming, setConfirming] = useState(false), exit = useAnimatedClose(ref, onClose)
  const keepRef = useRef<HTMLButtonElement>(null), returnTo = useRef<HTMLElement | null>(null)
  // showModal() focuses the first control (the close button); a field marked data-autofocus takes focus instead.
  useEffect(() => { const dialog = ref.current, previous = document.activeElement as HTMLElement | null; dialog?.showModal?.(); dialog?.querySelector<HTMLElement>('[data-autofocus]')?.focus(); return () => { dialog?.close?.(); previous?.focus?.() } }, [])
  // On a phone the on-screen keyboard covers the bottom of the page without resizing the layout viewport: follow the visual viewport so the
  // footer (Save / Add) always stays above the keyboard and the body scrolls inside the sheet.
  useEffect(() => {
    const vv = window.visualViewport, dialog = ref.current
    if (!vv || !dialog) return
    const apply = () => {
      dialog.style.setProperty('--kb', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`)
      dialog.style.setProperty('--vvh', `${Math.round(vv.height)}px`)
    }
    apply(); vv.addEventListener('resize', apply); vv.addEventListener('scroll', apply)
    return () => { vv.removeEventListener('resize', apply); vv.removeEventListener('scroll', apply) }
  }, [])
  const request = useCallback(() => {
    if (dirty?.()) { returnTo.current = document.activeElement as HTMLElement | null; setConfirming(true) } else exit()
  }, [dirty, exit])
  useEffect(() => { if (confirming) keepRef.current?.focus() }, [confirming])
  const keepEditing = () => { setConfirming(false); returnTo.current?.focus?.() }
  // stopPropagation: a sheet opened from inside another sheet's form must not also close the one beneath it.
  return <dialog ref={ref} className={`sheet${tall ? ' sheet-tall' : ''}`} aria-labelledby={id} onCancel={e => { e.preventDefault(); e.stopPropagation(); if (confirming) keepEditing(); else request() }} onClose={e => e.stopPropagation()} onClick={e => { if (e.target === e.currentTarget && !confirming) request() }}>
    <SheetCloseContext.Provider value={request}>
      <div className="sheet-inner">
        <span className="sheet-handle" aria-hidden="true" />
        <header className="sheet-head"><h2 id={id}>{title}</h2><button type="button" className="icon-button" onClick={request} aria-label={t('Close', 'إغلاق', 'Sluiten')}><X size={18} /></button></header>
        <div className="sheet-body">{children}</div>
        {confirming && <div className="sheet-confirm" role="alertdialog" aria-labelledby={`${id}-discard`} aria-describedby={`${id}-discard-why`}>
          <strong id={`${id}-discard`}>{t('Discard your changes?', 'تجاهل التغييرات؟', 'Wijzigingen negeren?')}</strong>
          <p id={`${id}-discard-why`} className="muted small">{t('What you entered here has not been saved.', 'ما أدخلته هنا لم يُحفظ.', 'Wat je hier hebt ingevoerd is niet opgeslagen.')}</p>
          <div className="sheet-confirm-actions">
            <button type="button" ref={keepRef} className="primary" onClick={keepEditing}>{t('Keep editing', 'متابعة التعديل', 'Blijven bewerken')}</button>
            <button type="button" className="quiet danger-text" onClick={exit}>{t('Discard', 'تجاهل', 'Negeren')}</button>
          </div>
        </div>}
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </div>
    </SheetCloseContext.Provider>
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
