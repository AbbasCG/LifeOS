import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { ArrowLeft, CalendarDays, CalendarClock, Check, Sparkles, Sunrise } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { accountDay, accountZone, shiftDay } from '../../lib/accountDay'
import { formatClock } from '../../lib/clock'
import { formatDay } from '../../lib/dateTime'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { useLanguage } from '../../contexts/LanguageContext'
import { newIdempotencyKey } from '../../lib/taskSchedule'
import { postponeBody, postponeError, postponeTask, suggestPostpone, type PostponeResult, type PostponeSuggestion, type PostponeTask, type PostponeTo } from '../../lib/postpone'
import { DateTimeField } from '../../components/ui/DateTimePicker'

type MenuKey = 'tomorrow' | 'next_week' | 'suggest' | 'pick'
type Props = { id: string; task: PostponeTask; start: 'first' | 'last'; trigger: RefObject<HTMLButtonElement | null>; onClose: (focus: boolean) => void; onDone?: (result: PostponeResult) => void; blocked?: () => string }

/**
 * Keeps the popover on screen and inside whatever clips it (a task row, a sheet): below the button when it fits, above it otherwise,
 * shifted sideways so neither edge is cut off (Arabic at 320 px included).
 */
function place(el: HTMLElement | null, anchor: HTMLElement | null) {
  if (!el || !anchor) return
  el.style.top = ''; el.style.bottom = ''; el.style.translate = ''
  let bounds = { left: 0, top: 0, right: document.documentElement.clientWidth || window.innerWidth, bottom: window.innerHeight }
  for (let p = el.parentElement?.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p)
    if (/hidden|clip|auto|scroll/.test(`${s.overflowX} ${s.overflowY}`)) {
      const r = p.getBoundingClientRect()
      bounds = { left: Math.max(bounds.left, r.left), top: Math.max(bounds.top, r.top), right: Math.min(bounds.right, r.right), bottom: Math.min(bounds.bottom, r.bottom) }
      break
    }
  }
  el.style.maxWidth = `${Math.max(160, Math.floor(bounds.right - bounds.left - 8))}px`
  const r = el.getBoundingClientRect(), a = anchor.getBoundingClientRect()
  if (r.bottom > bounds.bottom - 4 && a.top - bounds.top >= r.height + 8) { el.style.top = 'auto'; el.style.bottom = '100%' }
  const dx = r.left < bounds.left + 4 ? bounds.left + 4 - r.left : r.right > bounds.right - 4 ? bounds.right - 4 - r.right : 0
  if (dx) el.style.translate = `${Math.round(dx)}px`
}

/** The postpone menu: Tomorrow and Next week act at once; "Suggest a time…" and "Pick a date…" show what would happen and wait for Confirm. */
export default function PostponeMenu({ id, task, start, trigger, onClose, onDone, blocked }: Props) {
  const t = useText(), { language } = useLanguage(), toast = useToast()
  const [mode, setMode] = useState<'menu' | 'suggest' | 'pick'>('menu'), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [suggestion, setSuggestion] = useState<PostponeSuggestion | null>(null), [day, setDay] = useState(() => shiftDay(accountDay(), 1))
  const box = useRef<HTMLDivElement>(null), keys = useRef(new Map<string, string>()), first = useRef(true)
  const items = () => Array.from(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])

  // Focus: the first (or last) item when the menu opens; the panel's main control once it is shown.
  useEffect(() => {
    if (mode === 'menu') { const list = items(); (first.current && start === 'last' ? list.at(-1) : list[0])?.focus(); first.current = false; return }
    (box.current?.querySelector<HTMLElement>('.dtp-trigger, [data-first]:not([aria-disabled="true"])') ?? box.current?.querySelector<HTMLElement>('[role="group"]'))?.focus()
  }, [mode, suggestion, start])
  // A press outside closes it (the date picker opens in its own dialog and counts as inside).
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target || box.current?.contains(target) || trigger.current?.contains(target) || target.closest?.('.dtp-dialog')) return
      onClose(false)
    }
    document.addEventListener('pointerdown', down)
    return () => document.removeEventListener('pointerdown', down)
  }, [onClose, trigger])
  useLayoutEffect(() => place(box.current, trigger.current), [mode, suggestion, error, trigger])
  // Placed again once whatever holds it has settled (a row still animating open, a font, a resize).
  useEffect(() => {
    const again = () => place(box.current, trigger.current), timers = [150, 450].map(ms => window.setTimeout(again, ms))
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(again) : null
    if (box.current) observer?.observe(box.current)
    window.addEventListener('resize', again)
    return () => { timers.forEach(clearTimeout); observer?.disconnect(); window.removeEventListener('resize', again) }
  }, [mode, suggestion, error, trigger])

  async function go(to: PostponeTo, date?: string) {
    if (busy) return
    const why = blocked?.()
    if (why) { setError(why); return }
    const body = postponeBody(task, to, date), signature = JSON.stringify(body), key = keys.current.get(signature) ?? newIdempotencyKey()
    keys.current.set(signature, key); setBusy(true); setError('')
    try {
      const result = await postponeTask(task, body, { t, toast, language }, key)
      keys.current.delete(signature)
      onClose(true); onDone?.(result)
    } catch (e) {
      // A final answer (4xx) drops the key; a dropped connection keeps it, so trying again cannot move the task twice.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) keys.current.delete(signature)
      setError(postponeError(e, t))
    } finally { setBusy(false) }
  }
  async function suggest() {
    if (busy) return
    setMode('suggest'); setSuggestion(null); setError(''); setBusy(true)
    try { setSuggestion((await suggestPostpone(task.id)).suggestion) } catch (e) { setError(postponeError(e, t)) } finally { setBusy(false) }
  }
  function back() { setMode('menu'); setError('') }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    // Keys typed in the date picker (its own dialog, rendered elsewhere) are not the menu's.
    if (!box.current?.contains(e.target as Node)) return
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(true); return }
    if (mode !== 'menu') return
    if (e.key === 'Tab') { onClose(false); return }
    const list = items(), at = list.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % list.length : e.key === 'ArrowUp' ? (at - 1 + list.length) % list.length : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : -1
    if (next >= 0) { e.preventDefault(); list[next]?.focus() }
  }

  const clock = (iso: string) => formatClock(iso, { timeZone: accountZone() })
  const shownDay = (d: string) => formatDay(d, language)
  const suggested = (s: PostponeSuggestion) => s.starts_at && s.ends_at
    ? t(`Suggested: ${shownDay(s.date)} · ${clock(s.starts_at)}–${clock(s.ends_at)}`, `المقترح: ${shownDay(s.date)} · ${clock(s.starts_at)}–${clock(s.ends_at)}`, `Voorstel: ${shownDay(s.date)} · ${clock(s.starts_at)}–${clock(s.ends_at)}`)
    : t(`Suggested: deadline on ${shownDay(s.date)}`, `المقترح: الموعد النهائي يوم ${shownDay(s.date)}`, `Voorstel: deadline op ${shownDay(s.date)}`) + (s.due_at && !s.due_all_day ? ` ${clock(s.due_at)}` : '')
  const menu: [MenuKey, string, typeof Sunrise][] = [
    ['tomorrow', t('Tomorrow', 'غدًا', 'Morgen'), Sunrise],
    ['next_week', t('Next week', 'الأسبوع القادم', 'Volgende week'), CalendarClock],
    ['suggest', t('Suggest a time…', 'اقترح وقتًا…', 'Stel een tijd voor…'), Sparkles],
    ['pick', t('Pick a date…', 'اختر تاريخًا…', 'Kies een datum…'), CalendarDays],
  ]
  function choose(key: MenuKey) {
    if (busy) return
    if (key === 'suggest') void suggest()
    else if (key === 'pick') { setError(''); setMode('pick') }
    else void go(key)
  }
  const backButton = <button type="button" onClick={back}><ArrowLeft size={14} aria-hidden="true" className="flip-rtl" />{t('Back', 'رجوع', 'Terug')}</button>

  return <div ref={box} className="rec-popover" style={{ width: mode === 'menu' ? undefined : '18rem' }} onKeyDown={onKey}>
    {mode === 'menu' && <div id={id} role="menu" aria-label={t('Postpone', 'تأجيل', 'Uitstellen')} aria-busy={busy || undefined} style={{ display: 'grid' }}>
      {menu.map(([key, label, Icon]) => <button key={key} type="button" role="menuitem" tabIndex={-1} data-to={key} aria-disabled={busy || undefined} onClick={() => choose(key)}><Icon size={14} aria-hidden="true" />{label}</button>)}
    </div>}
    {mode === 'suggest' && <div id={id} role="group" tabIndex={-1} aria-label={t('Suggest a time', 'اقترح وقتًا', 'Stel een tijd voor')} aria-busy={busy || undefined} style={{ display: 'grid', gap: 6 }}>
      <p className="small" aria-live="polite">{suggestion ? suggested(suggestion) : busy ? t('Looking for free time…', 'نبحث عن وقت فارغ…', 'Vrije tijd zoeken…') : ''}</p>
      {suggestion && !suggestion.has_room && <p className="muted small">{t('There is no free time for it in the next work days, so this is simply the next work day.', 'لا يوجد وقت فارغ لها في أيام العمل القادمة، فهذا ببساطة يوم العمل التالي.', 'Er is geen vrije tijd voor in de komende werkdagen, dus dit is gewoon de volgende werkdag.')}</p>}
      <button type="button" className="primary" data-first aria-disabled={busy || !suggestion || undefined} onClick={() => { if (suggestion) void go('date', suggestion.date) }}><Check size={15} aria-hidden="true" />{t('Confirm', 'تأكيد', 'Bevestigen')}</button>
      {backButton}
    </div>}
    {mode === 'pick' && <div id={id} role="group" tabIndex={-1} aria-label={t('Pick a date', 'اختر تاريخًا', 'Kies een datum')} style={{ display: 'grid', gap: 6 }}>
      <DateTimeField kind="date" label={t('Day', 'اليوم', 'Dag')} value={day} min={accountDay()} onChange={setDay} />
      <button type="button" className="primary" data-first aria-disabled={busy || !day || undefined} onClick={() => { if (day) void go('date', day) }}><Check size={15} aria-hidden="true" />{t('Confirm', 'تأكيد', 'Bevestigen')}</button>
      {backButton}
    </div>}
    {error && <p role="alert" className="error small">{error}</p>}
  </div>
}
