import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Clock, X } from 'lucide-react'
import { useLanguage } from '../../contexts/LanguageContext'
import { useText } from '../../lib/i18n'
import { accountDay } from '../../lib/accountDay'
import {
  addDays, addMonths, clampDay, formatDay, formatTime, from12, HOUR_CYCLE_CHANGED, joinDateTime, monthGrid, parseDay, parseTimeInput,
  preferredHourCycle, saveHourCycle, splitDateTime, TIME_RE, to12, withMonth, type HourCycle,
} from '../../lib/dateTime'

export type PickerKind = 'date' | 'time' | 'datetime'
type Props = {
  kind: PickerKind
  /** Controlled (`value` + `onChange`) or uncontrolled inside a plain form (`defaultValue` + `name`). */
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
  /** Form field name: a plain form post still receives the same text the native input sent. */
  name?: string
  id?: string
  required?: boolean
  disabled?: boolean
  /** 'YYYY-MM-DD' (or a date-time; only its date is used): earliest / latest day that can be picked. */
  min?: string
  max?: string
  className?: string
  /** Accessible name when there is no wrapping <label>; the shown value is added so the name always contains the visible text. */
  label?: string
  /** Set when the trigger is one option of a radio group (Quick Add's date tile): it then has role radio and this checked state. */
  radioChecked?: boolean
}

function useHourCycle(): [HourCycle, (next: HourCycle) => void] {
  const { language } = useLanguage()
  const [cycle, setCycle] = useState<HourCycle>(() => preferredHourCycle(language))
  useEffect(() => {
    const sync = () => setCycle(preferredHourCycle(language))
    window.addEventListener(HOUR_CYCLE_CHANGED, sync)
    return () => window.removeEventListener(HOUR_CYCLE_CHANGED, sync)
  }, [language])
  return [cycle, saveHourCycle]
}

const isPhone = () => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 640px)').matches

export function DateTimeField({ kind, value: controlled, defaultValue = '', onChange: notify, name, id, required, disabled, min, max, className, label, radioChecked }: Props) {
  const t = useText(), { language } = useLanguage(), [open, setOpen] = useState(false), [cycle] = useHourCycle()
  const trigger = useRef<HTMLButtonElement>(null), [own, setOwn] = useState(defaultValue)
  const value = controlled ?? own
  const onChange = useCallback((next: string) => { setOwn(next); notify?.(next) }, [notify])
  const { date, time } = kind === 'datetime' ? splitDateTime(value) : kind === 'date' ? { date: parseDay(value) ? value : '', time: '' } : { date: '', time: TIME_RE.test(value) ? value : '' }
  const text = kind === 'time' ? formatTime(time, cycle, language)
    : date ? formatDay(date, language, { weekday: 'short', day: 'numeric', month: 'short', ...(kind === 'date' ? { year: 'numeric' } : {}) }) + (kind === 'datetime' && time ? ` · ${formatTime(time, cycle, language)}` : '')
      : ''
  const placeholder = kind === 'time' ? t('Set time', 'اختر الوقت') : t('Set date', 'اختر التاريخ')
  const Icon = kind === 'time' ? Clock : CalendarDays
  const minDay = min?.slice(0, 10), maxDay = max?.slice(0, 10)

  return <span className={`dtp ${className ?? ''}`}>
    <button ref={trigger} id={id} type="button" className="dtp-trigger" disabled={disabled} aria-haspopup="dialog" {...(radioChecked === undefined ? { 'aria-expanded': open } : { role: 'radio', 'aria-checked': radioChecked })} aria-label={label ? `${label}: ${text || placeholder}` : undefined} data-value={value} data-min={min} data-max={max} onClick={() => setOpen(true)}>
      <Icon size={16} aria-hidden="true" /><span className={text ? '' : 'dtp-empty'} dir="auto">{text || placeholder}</span>
    </button>
    {/* Carries the value in a form post and makes `required` work, without the browser's own picker. */}
    <input className="dtp-value" type="text" tabIndex={-1} aria-hidden="true" autoComplete="off" name={name} value={value} required={required} disabled={disabled} onChange={() => undefined} />
    {open && <PickerSheet kind={kind} value={value} min={minDay} max={maxDay} clearable={!required} anchor={trigger} onChange={onChange} onClose={() => { setOpen(false); trigger.current?.focus() }} />}
  </span>
}

export const DateField = (props: Omit<Props, 'kind'>) => <DateTimeField kind="date" {...props} />
export const TimeField = (props: Omit<Props, 'kind'>) => <DateTimeField kind="time" {...props} />

function PickerSheet({ kind, value, min, max, clearable, anchor, onChange, onClose }: { kind: PickerKind; value: string; min?: string; max?: string; clearable: boolean; anchor: RefObject<HTMLElement | null>; onChange: (v: string) => void; onClose: () => void }) {
  const t = useText(), { language } = useLanguage(), rtl = language === 'ar', titleId = useId()
  const ref = useRef<HTMLDialogElement>(null), [cycle, setCycle] = useHourCycle()
  const parts = kind === 'datetime' ? splitDateTime(value) : kind === 'date' ? { date: parseDay(value) ? value : '', time: '' } : { date: '', time: TIME_RE.test(value) ? value : '' }
  const today = accountDay()
  const [view, setView] = useState(() => parts.date || clampDay(today, min, max)), [focused, setFocused] = useState(() => parts.date || clampDay(today, min, max))
  // What is being typed, or null while the box simply shows the chosen value.
  const [dateDraft, setDateDraft] = useState<string | null>(null), [timeDraft, setTimeDraft] = useState<string | null>(null)
  const [phone] = useState(isPhone), [months, setMonths] = useState(false)

  // The picker is its own modal dialog, so it opens above any form dialog it is used in and returns focus when it closes.
  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    // StrictMode (development) runs this effect, its cleanup and the effect again: opening an already open dialog throws, so check first.
    if (!dialog.open) { if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '') } // very old browsers: still opens, just not modal
    const target = anchor.current
    if (!phone && target) {
      const rect = target.getBoundingClientRect(), w = dialog.offsetWidth, h = dialog.offsetHeight
      const left = Math.max(8, Math.min(rtl ? rect.right - w : rect.left, window.innerWidth - w - 8))
      const below = rect.bottom + 6
      dialog.style.left = `${left}px`
      dialog.style.top = `${Math.max(8, below + h > window.innerHeight - 8 ? Math.max(8, rect.top - h - 6) : below)}px`
    }
    dialog.querySelector<HTMLElement>('[data-day-focus]')?.focus()
    return () => { if (dialog.open) { if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open') } }
  }, [anchor, phone, rtl])

  const timeShown = parts.time || '09:00'
  const timeText = timeDraft ?? (parts.time ? format(parts.time) : ''), dateText = dateDraft ?? parts.date
  function format(time: string) { return cycle === 24 ? time : (({ hour, minute, pm }) => `${hour}:${String(minute).padStart(2, '0')} ${pm ? 'PM' : 'AM'}`)(to12(time)) }

  const emit = useCallback((nextDate: string, nextTime: string) => {
    if (kind === 'date') onChange(nextDate)
    else if (kind === 'time') onChange(nextTime)
    else onChange(nextDate ? joinDateTime(nextDate, nextTime) : '')
  }, [kind, onChange])
  const pickDay = (day: string) => { if ((min && day < min) || (max && day > max)) return; setFocused(day); emit(day, parts.time); if (kind === 'date') onClose() }
  const setTime = (time: string) => emit(kind === 'time' ? '' : parts.date || clampDay(today, min, max), time)

  const grid = useMemo(() => monthGrid(view), [view])
  const monthTitle = formatDay(view, language, { month: 'long', year: 'numeric' })
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, i) => formatDay(addDays('2024-01-01', i), language, { weekday: 'short' })), [language])
  const move = (day: string) => { const next = clampDay(day, min, max); setFocused(next); if (next.slice(0, 7) !== view.slice(0, 7)) setView(next); requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[data-day-focus]')?.focus()) }
  const onGridKey = (e: React.KeyboardEvent) => {
    const flip = rtl ? -1 : 1
    const step: Record<string, number | undefined> = { ArrowLeft: -1 * flip, ArrowRight: flip, ArrowUp: -7, ArrowDown: 7 }
    if (step[e.key] !== undefined) { e.preventDefault(); move(addDays(focused, step[e.key]!)) }
    else if (e.key === 'PageUp') { e.preventDefault(); move(addMonths(focused, e.shiftKey ? -12 : -1)) }
    else if (e.key === 'PageDown') { e.preventDefault(); move(addMonths(focused, e.shiftKey ? 12 : 1)) }
  }

  const { hour, minute, pm } = to12(timeShown), h24 = Number(timeShown.slice(0, 2))
  const commitTyped = (text: string) => { const parsed = parseTimeInput(text); if (parsed) setTime(parsed); setTimeDraft(null) }
  const commitDate = (text: string) => { const day = parseDay(text) ? clampDay(text, min, max) : ''; if (day) { setView(day); setFocused(day); emit(day, parts.time) }; setDateDraft(null) }
  const holdEnter = (commit: (v: string) => void) => (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value) } }
  const Prev = rtl ? ChevronRight : ChevronLeft, Next = rtl ? ChevronLeft : ChevronRight
  const showDate = kind !== 'time', showTime = kind !== 'date'
  const title = kind === 'time' ? t('Choose a time', 'اختر الوقت') : kind === 'date' ? t('Choose a date', 'اختر التاريخ') : t('Choose date and time', 'اختر التاريخ والوقت')

  // Escape arrives as `cancel`. The native `close` event is deliberately NOT used: React StrictMode (development) mounts, unmounts and
  // remounts this component, and the unmount's dialog.close() queues a `close` event that would shut the freshly reopened picker.
  // `cancel` is stopped here because React passes a portal's events up to the form dialog that holds it.
  return createPortal(
    <dialog ref={ref} className={`dtp-dialog ${phone ? 'is-phone' : ''}`} dir={rtl ? 'rtl' : 'ltr'} aria-labelledby={titleId} onCancel={e => { e.preventDefault(); e.stopPropagation(); onClose() }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dtp-inner">
        <header className="dtp-head"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label={t('Close', 'إغلاق')}><X size={16} /></button></header>
        <div className="dtp-body">
          {showDate && <section className="dtp-cal" aria-label={t('Date', 'التاريخ')}>
            <div className="dtp-month">
              <button type="button" className="icon-button" onClick={() => setView(addMonths(view, months ? -12 : -1))} aria-label={months ? t('Previous year', 'السنة السابقة') : t('Previous month', 'الشهر السابق')}><Prev size={16} /></button>
              <button type="button" className="dtp-title" aria-expanded={months} aria-label={`${monthTitle}: ${t('choose month or year', 'اختر الشهر أو السنة')}`} onClick={() => setMonths(v => !v)}><span aria-live="polite">{monthTitle}</span><ChevronDown size={14} aria-hidden="true" /></button>
              <button type="button" className="icon-button" onClick={() => setView(addMonths(view, months ? 12 : 1))} aria-label={months ? t('Next year', 'السنة التالية') : t('Next month', 'الشهر التالي')}><Next size={16} /></button>
            </div>
            {months && <div className="dtp-months" role="group" aria-label={t('Month', 'الشهر')}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
                const label = formatDay(withMonth(view, Number(view.slice(0, 4)), m), language, { month: 'long' }), current = Number(view.slice(5, 7)) === m
                return <button key={m} type="button" className={current ? 'selected' : ''} aria-pressed={current} onClick={() => { setView(withMonth(view, Number(view.slice(0, 4)), m)); setMonths(false) }}>{label}</button>
              })}
            </div>}
            {!months && <div className="dtp-weekdays" aria-hidden="true">{weekdays.map(w => <span key={w}>{w}</span>)}</div>}
            {!months && <div className="dtp-grid" role="group" aria-label={monthTitle} onKeyDown={onGridKey}>
              {grid.map(({ day, inMonth }) => {
                const off = !!((min && day < min) || (max && day > max)), selected = day === parts.date
                return <button key={day} type="button" data-day={day} disabled={off} tabIndex={day === focused ? 0 : -1} {...(day === focused ? { 'data-day-focus': '' } : {})}
                  className={`dtp-day ${inMonth ? '' : 'outside'} ${day === today ? 'today' : ''} ${selected ? 'selected' : ''}`} aria-pressed={selected} aria-current={day === today ? 'date' : undefined}
                  aria-label={formatDay(day, language, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} onClick={() => pickDay(day)}>{Number(day.slice(8))}</button>
              })}
            </div>}
            <label className="dtp-typed">{t('Date', 'التاريخ')}<input type="text" inputMode="numeric" dir="ltr" placeholder="YYYY-MM-DD" value={dateText} onChange={e => setDateDraft(e.target.value)} onBlur={e => commitDate(e.target.value)} onKeyDown={holdEnter(commitDate)} /></label>
          </section>}
          {showTime && <section className="dtp-time" aria-label={t('Time', 'الوقت')}>
            <div className="dtp-time-head">
              <label className="dtp-typed">{t('Time', 'الوقت')}<input type="text" inputMode="text" dir="ltr" placeholder={cycle === 24 ? '14:30' : '2:30 PM'} value={timeText} onChange={e => setTimeDraft(e.target.value)} onBlur={e => { if (e.target.value.trim()) commitTyped(e.target.value) }} onKeyDown={holdEnter(commitTyped)} /></label>
              <div className="dtp-cycle" role="group" aria-label={t('Clock format', 'نظام الساعة')}>
                {([12, 24] as const).map(c => <button key={c} type="button" aria-pressed={cycle === c} onClick={() => setCycle(c)}>{c === 12 ? t('12 h', '١٢ س') : t('24 h', '٢٤ س')}</button>)}
              </div>
            </div>
            <div className="dtp-cols">
              <div className="dtp-hours" role="group" aria-label={t('Hour', 'الساعة')}>
                {(cycle === 12 ? Array.from({ length: 12 }, (_, i) => i + 1) : Array.from({ length: 24 }, (_, i) => i)).map(h => {
                  const selected = parts.time !== '' && (cycle === 12 ? hour === h : h24 === h)
                  return <button key={h} type="button" className={selected ? 'selected' : ''} aria-pressed={selected} aria-label={cycle === 12 ? `${h} ${pm ? 'PM' : 'AM'}` : String(h).padStart(2, '0')}
                    onClick={() => setTime(cycle === 12 ? from12(h, minute, pm) : `${String(h).padStart(2, '0')}:${timeShown.slice(3)}`)}>{cycle === 24 ? String(h).padStart(2, '0') : h}</button>
                })}
              </div>
              <div className="dtp-minutes" role="group" aria-label={t('Minute', 'الدقائق')}>
                {Array.from({ length: 12 }, (_, i) => i * 5).map(m => {
                  const selected = parts.time !== '' && minute === m
                  return <button key={m} type="button" className={selected ? 'selected' : ''} aria-pressed={selected} aria-label={`${t('minute', 'دقيقة')} ${String(m).padStart(2, '0')}`} onClick={() => setTime(`${timeShown.slice(0, 2)}:${String(m).padStart(2, '0')}`)}>{String(m).padStart(2, '0')}</button>
                })}
              </div>
              {cycle === 12 && <div className="dtp-period" role="group" aria-label={t('AM or PM', 'صباحاً أو مساءً')}>
                <button type="button" className={parts.time && !pm ? 'selected' : ''} aria-pressed={!!parts.time && !pm} onClick={() => setTime(from12(hour, minute, false))}>{t('AM', 'ص')}</button>
                <button type="button" className={parts.time && pm ? 'selected' : ''} aria-pressed={!!parts.time && pm} onClick={() => setTime(from12(hour, minute, true))}>{t('PM', 'م')}</button>
              </div>}
            </div>
          </section>}
        </div>
        <footer className="dtp-foot">
          {showDate && <button type="button" className="text-link" disabled={!!((min && today < min) || (max && today > max))} onClick={() => { const d = clampDay(today, min, max); setView(d); pickDay(d) }}>{t('Today', 'اليوم')}</button>}
          {clearable && value && <button type="button" className="text-link" onClick={() => { onChange(''); onClose() }}>{t('Clear', 'مسح')}</button>}
          <button type="button" className="primary" onClick={onClose}>{t('Done', 'تم')}</button>
        </footer>
      </div>
    </dialog>, document.body)
}

