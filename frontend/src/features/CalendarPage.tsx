import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { ChevronLeft, ChevronRight, Plus, GripVertical, Lock, AlertTriangle, MousePointerClick, X, Eye, EyeOff, Repeat, Globe, CalendarDays, CalendarRange, Columns3, List } from 'lucide-react'
import { KindIcon } from '../components/visual'
import { api, type Availability, type CalendarOccurrence, type RecordItem } from '../lib/api'
import { useCalendar } from '../lib/useCalendar'
import EventForm from './EventForm'
import { useRecords, localDate } from '../lib/hooks'
import { useApi } from '../lib/useApi'
import { useText } from '../lib/i18n'
import { announce } from '../lib/announce'
import { useLanguage } from '../contexts/LanguageContext'
import { useToast } from '../lib/toast'
import { minutesLabel } from '../lib/dates'
import { useStatusLabel } from './ResourcePage'
import { Empty, ErrorMessage } from '../components/ui/Shared'
import { atMinutes, findConflict, layoutLanes, minutesInto, movePreview, overlappingIds, resizePreview, snap } from '../lib/calendar'
import { sourceName } from '../lib/sources'

const HOUR = 52
type Drag = { item: CalendarOccurrence; mode: 'move' | 'resize'; locked: boolean; pointerId: number; startX: number; startY: number; origStart: Date; origEnd: Date; origDay: Date; moved: boolean }
type Preview = { id: string; start: Date; end: Date; dayIndex: number; conflict?: CalendarOccurrence }

export default function CalendarPage() {
  const t = useText(), { language } = useLanguage(), ar = language === 'ar', label = useStatusLabel(), toast = useToast()
  const [date, setDate] = useState(localDate()), [view, setViewState] = useState(() => { try { const saved = localStorage.getItem('lifeos-calendar-view'); if (saved && ['day', 'week', 'month', 'agenda'].includes(saved)) return saved } catch { /* storage unavailable */ } return window.innerWidth < 700 ? 'agenda' : 'week' })
  // The chosen view is remembered on this device; phones start with the agenda.
  const setView = (next: string) => { setViewState(next); try { localStorage.setItem('lifeos-calendar-view', next) } catch { /* storage unavailable */ } }
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const [editing, setEditing] = useState<Partial<CalendarOccurrence> | null>(null)
  const [now, setNow] = useState(() => new Date()), [, setBusy] = useState(false), [showFree, setShowFree] = useState(true)
  const [preview, setPreview] = useState<Preview | null>(null), [placing, setPlacing] = useState<RecordItem | null>(null), [dropHint, setDropHint] = useState<{ dayIndex: number; minutes: number } | null>(null)
  const scroller = useRef<HTMLDivElement>(null), columns = useRef<(HTMLDivElement | null)[]>([]), drag = useRef<Drag | null>(null), previewRef = useRef<Preview | null>(null), suppressClick = useRef(false)
  const start = new Date(`${date}T00:00`)
  if (view === 'month') start.setDate(1); else if (view === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  const end = new Date(start); end.setDate(end.getDate() + (view === 'month' ? new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate() : view === 'day' ? 1 : 7))
  // Week and agenda headings name the dates shown, so moving forward or back is visible at a glance.
  const lastDay = new Date(end); lastDay.setDate(lastDay.getDate() - 1)
  const rangeLabel = `${start.toLocaleDateString(language, { day: 'numeric', month: 'short' })} – ${lastDay.toLocaleDateString(language, { day: 'numeric', month: 'short' })}`
  const data = useCalendar(start, end)
  const tasks = useRecords('tasks', 'per_page=50&due=open&sort=priority')
  const days = Array.from({ length: Math.round((end.getTime() - start.getTime()) / 86400000) }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d })
  const availability = useApi<Availability>(`/api/availability?date=${localDate(start)}&days=${days.length}`)
  const timed = view === 'day' || view === 'week'
  const scheduledTaskIds = new Set(data.items.map(e => e.task_id).filter(Boolean))
  const unscheduled = tasks.items.filter(task => !scheduledTaskIds.has(task.id))
  const overlaps = overlappingIds(data.items)

  useEffect(() => { const id = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(id) }, [])
  useEffect(() => { if (timed && scroller.current) scroller.current.scrollTop = 7 * HOUR }, [timed])

  // A new period or view is announced by its heading, so keyboard and screen-reader users hear where they landed.
  const period = `${view}|${date}`, shownPeriod = useRef(period)
  useEffect(() => {
    if (shownPeriod.current === period) return
    shownPeriod.current = period
    announce(document.querySelector('main h1')?.textContent?.replace(/\s+/g, ' ').trim() ?? '')
  }, [period])
  function shift(direction: number) { const d = new Date(`${date}T12:00`); if (view === 'month') d.setMonth(d.getMonth() + direction); else d.setDate(d.getDate() + direction * (view === 'day' ? 1 : 7)); setDate(localDate(d)) }
  /** Swipe sideways on a phone to go to the next or previous day/week/month (mirrored in Arabic). */
  function swipeEnd(x: number, y: number) {
    const s0 = swipe.current; swipe.current = null
    if (!s0 || drag.current || preview) return
    const dx = x - s0.x, dy = y - s0.y
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) shift((dx < 0 ? 1 : -1) * (ar ? -1 : 1))
  }
  function eventsOn(day: Date) { const next = new Date(day); next.setDate(next.getDate() + 1); return data.items.filter(i => new Date(i.starts_at!) < next && new Date(i.ends_at!) > day) }
  function refresh() { data.reload(); availability.reload() }
  async function save(fn: () => Promise<unknown>, success?: string) {
    setBusy(true)
    try { await fn(); data.setError(''); if (success) toast(success); refresh(); return true } catch (e) { toast((e as Error).message, 'error'); refresh(); return false } finally { setBusy(false) }
  }
  const time = (value: string | Date) => new Date(value).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })

  /** Persist a moved/resized block optimistically, with undo. */
  async function commit(item: CalendarOccurrence, nextStart: Date, nextEnd: Date) {
    if (!item.editable || !item.event_id) { toast(t('This event is synced from another calendar and is read-only here.', 'هذا الموعد متزامن من تقويم آخر وهو للقراءة فقط هنا.'), 'info'); return }
    const conflict = findConflict(data.items, item.id, nextStart, nextEnd)
    if (conflict) { toast(t(`That time overlaps “${conflict.title}”. The block was not moved.`, `هذا الوقت يتداخل مع «${conflict.title}». لم يتم نقل الفترة.`), 'error'); return }
    const scope = item.recurring ? { scope: 'occurrence', occurrence_start: item.occurrence_start } : {}
    const before = { ...scope, starts_at: item.starts_at, ends_at: item.ends_at }
    data.setItems(data.items.map(i => i.id === item.id ? { ...i, starts_at: nextStart.toISOString(), ends_at: nextEnd.toISOString() } : i))
    const ok = await save(() => api(`/api/events/${item.event_id}`, 'PATCH', { ...scope, starts_at: nextStart.toISOString(), ends_at: nextEnd.toISOString() }))
    const message = item.recurring ? t(`Only this “${item.title}” moved to ${time(nextStart)} – ${time(nextEnd)}. The series is unchanged.`, `نُقل هذا الموعد «${item.title}» فقط إلى ${time(nextStart)} – ${time(nextEnd)}. السلسلة كما هي.`) : t(`“${item.title}” now ${time(nextStart)} – ${time(nextEnd)}.`, `«${item.title}» الآن ${time(nextStart)} – ${time(nextEnd)}.`)
    if (ok) toast(message, 'success', { label: t('Undo', 'تراجع'), onClick: () => void save(() => api(`/api/events/${item.event_id}`, 'PATCH', before), t('Change undone.', 'تم التراجع عن التغيير.')) })
  }

  function dayIndexAt(clientX: number, fallback: number) {
    const index = columns.current.findIndex(col => { if (!col) return false; const r = col.getBoundingClientRect(); return clientX >= r.left && clientX <= r.right })
    return index >= 0 ? index : fallback
  }
  function beginDrag(e: ReactPointerEvent<HTMLElement>, item: CalendarOccurrence, mode: Drag['mode'], dayIndex: number) {
    if (e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { item, mode, locked: item.kind === 'fixed' || !item.editable, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, origStart: new Date(item.starts_at!), origEnd: new Date(item.ends_at!), origDay: days[dayIndex], moved: false }
  }
  function moveDrag(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    const dy = e.clientY - d.startY
    if (!d.moved && Math.hypot(e.clientX - d.startX, dy) < 5) return
    d.moved = true
    if (d.locked) { drag.current = null; toast(d.item.editable ? t('Fixed commitments are protected. Open the event to change its time.', 'الالتزامات الثابتة محمية. افتح الموعد لتغيير وقته.') : t('This event is synced from another calendar and is read-only here.', 'هذا الموعد متزامن من تقويم آخر وهو للقراءة فقط هنا.'), 'info'); return }
    const delta = dy / HOUR * 60
    const origIndex = days.findIndex(day => localDate(day) === localDate(d.origDay))
    const dayIndex = d.mode === 'move' ? dayIndexAt(e.clientX, origIndex) : origIndex
    const next = d.mode === 'move' ? movePreview(d.origStart, d.origEnd, d.origDay, days[dayIndex], delta) : resizePreview(d.origStart, d.origEnd, d.origDay, delta)
    const p = { id: d.item.id, ...next, dayIndex, conflict: findConflict(data.items, d.item.id, next.start, next.end) }
    previewRef.current = p
    setPreview(p)
  }
  function endDrag(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current, p = previewRef.current
    if (!d || e.pointerId !== d.pointerId) return
    drag.current = null; previewRef.current = null; setPreview(null)
    if (!d.moved) return
    suppressClick.current = true
    setTimeout(() => { suppressClick.current = false }, 0)
    if (!p) return
    if (p.start.getTime() === d.origStart.getTime() && p.end.getTime() === d.origEnd.getTime()) return
    void commit(d.item, p.start, p.end)
  }
  function cancelDrag() { drag.current = null; previewRef.current = null; setPreview(null) }
  function onEventKey(e: KeyboardEvent<HTMLElement>, item: CalendarOccurrence, day: Date) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(item); return }
    if (!e.altKey && !e.ctrlKey && !e.metaKey && moveFocus(e)) return
    if (!e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    if (item.kind === 'fixed' || !item.editable) { toast(t('Fixed commitments are protected. Open the event to change its time.', 'الالتزامات الثابتة محمية. افتح الموعد لتغيير وقته.'), 'info'); return }
    const delta = e.key === 'ArrowUp' ? -15 : 15, s = new Date(item.starts_at!), en = new Date(item.ends_at!)
    const next = e.shiftKey ? resizePreview(s, en, day, delta) : movePreview(s, en, day, day, delta)
    void commit(item, next.start, next.end)
  }
  /**
   * Plain arrows move between blocks without a mouse: up and down to the previous or next block of the day, left and
   * right to the closest block on the neighbouring day (following reading direction); Page Up and Page Down change the
   * period. Returns whether the key was handled.
   */
  function moveFocus(e: KeyboardEvent<HTMLElement>) {
    if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); shift(e.key === 'PageUp' ? -1 : 1); return true }
    if (e.shiftKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return false
    const block = e.currentTarget, column = block.closest('.time-column')
    const dayColumns = [...(block.closest('.time-grid')?.querySelectorAll<HTMLElement>('.time-column') ?? [])]
    const blocks = (c: Element | null | undefined) => [...(c?.querySelectorAll<HTMLElement>('.grid-event') ?? [])].sort((a, b) => a.offsetTop - b.offsetTop)
    let target: HTMLElement | undefined
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const day = blocks(column), i = day.indexOf(block)
      target = day[i + (e.key === 'ArrowUp' ? -1 : 1)]
    } else {
      const rtl = getComputedStyle(block).direction === 'rtl'
      const step = (e.key === 'ArrowRight') !== rtl ? 1 : -1
      // Skip empty days until one has a block; pick the block nearest in time.
      for (let i = dayColumns.indexOf(column as HTMLElement) + step; i >= 0 && i < dayColumns.length && !target; i += step) {
        target = blocks(dayColumns[i]).sort((a, b) => Math.abs(a.offsetTop - block.offsetTop) - Math.abs(b.offsetTop - block.offsetTop))[0]
      }
    }
    e.preventDefault()
    target?.focus()
    return true
  }
  function createTaskBlock(task: RecordItem, s: Date) {
    const length = Math.max(15, task.estimated_minutes || 30), e = new Date(s.getTime() + length * 60000)
    const conflict = findConflict(data.items, undefined, s, e)
    if (conflict) { toast(t(`That time overlaps “${conflict.title}”. Pick a free slot.`, `هذا الوقت يتداخل مع «${conflict.title}». اختر وقتاً متاحاً.`), 'error'); return }
    setPlacing(null)
    void save(() => api('/api/events', 'POST', { title: task.title, task_id: task.id, kind: 'flexible', starts_at: s.toISOString(), ends_at: e.toISOString() }), t(`Time blocked for “${task.title}”.`, `حُجز وقت لـ«${task.title}».`))
  }
  function pointerMinutes(e: { clientY: number; currentTarget: HTMLElement }) { return snap((e.clientY - e.currentTarget.getBoundingClientRect().top) / HOUR * 60) }
  function dropOnDay(e: DragEvent<HTMLElement>, day: Date, minutes: number | null) {
    e.preventDefault(); setDropHint(null)
    const payload = e.dataTransfer.getData('text/plain')
    if (!payload.startsWith('task:')) return
    const task = tasks.items.find(i => i.id === Number(payload.slice(5)))
    if (task) createTaskBlock(task, atMinutes(day, Math.max(0, Math.min(23 * 60 + 45, minutes ?? 9 * 60))))
  }
  function slotClick(day: Date, hour: number) {
    const s = atMinutes(day, hour * 60)
    if (placing) { createTaskBlock(placing, s); return }
    setEditing({ starts_at: s.toISOString(), ends_at: new Date(s.getTime() + 3600000).toISOString(), kind: 'flexible' })
  }
  const freeFor = (day: Date) => availability.data?.days.find(d => d.date === localDate(day))

  return <section className="page calendar-page">
    <header className="cal-bar">
      <h1>{view === 'day' ? start.toLocaleDateString(language, { weekday: 'long', day: 'numeric', month: 'long' }) : view === 'month' ? start.toLocaleDateString(language, { month: 'long', year: 'numeric' }) : <>{view === 'agenda' && <span className="sr-only">{t('Agenda', 'الجدول')}: </span>}{rangeLabel}</>}</h1>
      <div className="cal-nav">
        <button className="icon-button" aria-label={t('Previous', 'السابق')} onClick={() => shift(-1)}><ChevronLeft className="flip-rtl" /></button>
        <button className="quiet" onClick={() => setDate(localDate())}>{t('Today', 'اليوم')}</button>
        <button className="icon-button" aria-label={t('Next', 'التالي')} onClick={() => shift(1)}><ChevronRight className="flip-rtl" /></button>
        <input className="cal-date hide-phone" type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} aria-label={t('Date', 'التاريخ')} />
      </div>
      <div className="segmented cal-views" role="radiogroup" aria-label={t('Calendar view', 'عرض التقويم')}>{([['day', t('Day', 'يوم'), CalendarDays], ['week', t('Week', 'أسبوع'), Columns3], ['month', t('Month', 'شهر'), CalendarRange], ['agenda', t('Agenda', 'جدول'), List]] as const).map(([key, name, Icon]) => <button key={key} role="radio" aria-checked={view === key} className={view === key ? 'active' : ''} onClick={() => setView(key)}><Icon size={15} aria-hidden="true" /><span>{name}</span></button>)}</div>
      <button className="icon-button cal-free" aria-pressed={showFree} onClick={() => setShowFree(v => !v)} aria-label={showFree ? t('Hide free time', 'إخفاء الوقت المتاح') : t('Show free time', 'إظهار الوقت المتاح')} title={showFree ? t('Hide free time', 'إخفاء الوقت المتاح') : t('Show free time', 'إظهار الوقت المتاح')}>{showFree ? <EyeOff size={18} /> : <Eye size={18} />}</button>
      <button className="primary cal-new" onClick={() => { const s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1); setEditing({ starts_at: s.toISOString(), ends_at: new Date(s.getTime() + 3600000).toISOString() }) }}><Plus size={18} /><span>{t('New event', 'موعد جديد')}</span></button>
    </header>
    <ErrorMessage error={data.error || tasks.error} />
    {overlaps.size > 0 && <p className="conflict-chip" role="status"><AlertTriangle size={15} aria-hidden="true" />{t(`${overlaps.size} overlapping`, `${overlaps.size} متداخلة`)}</p>}
    {placing && <div className="banner placing" role="status"><MousePointerClick size={18} /><p>{t(`Tap a time slot to schedule “${placing.title}” (${placing.estimated_minutes} min).`, `اضغط على وقت لجدولة «${placing.title}» (${placing.estimated_minutes} د).`)}</p><button className="icon-button" aria-label={t('Cancel placing', 'إلغاء الجدولة')} onClick={() => setPlacing(null)}><X size={16} /></button></div>}
    <div className={`calendar-layout ${timed ? 'with-tray' : ''}`} onTouchStart={e => { swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY } }} onTouchEnd={e => swipeEnd(e.changedTouches[0].clientX, e.changedTouches[0].clientY)}>
      {timed ? <div className={`time-grid ${view} ${preview ? 'dragging' : ''} ${placing ? 'placing' : ''}`} style={{ ['--days' as string]: days.length }}>
        <div className="time-grid-head"><span />{days.map(day => { const free = freeFor(day); return <div key={localDate(day)} className={localDate(day) === localDate(now) ? 'today' : ''}><span>{day.toLocaleDateString(language, { weekday: 'short' })}</span><strong>{day.getDate()}</strong>{showFree && free?.work_day && free.free_minutes > 0 && <small className="free-total">{t(`${minutesLabel(free.free_minutes, false)} free`, `${minutesLabel(free.free_minutes, true)} متاح`)}</small>}</div> })}</div>
        <div className="time-grid-body" ref={scroller}>
          <div className="time-gutter">{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * HOUR }}>{h ? time(new Date(2026, 0, 1, h)) : ''}</span>)}</div>
          {days.map((day, dayIndex) => {
            const isToday = localDate(day) === localDate(now), free = freeFor(day)
            return <div key={localDate(day)} ref={el => { columns.current[dayIndex] = el }} className={`time-column ${isToday ? 'today' : ''}`} style={{ height: 24 * HOUR }}
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropHint({ dayIndex, minutes: pointerMinutes(e) }) }}
              onDragLeave={() => setDropHint(null)}
              onDrop={e => dropOnDay(e, day, pointerMinutes(e))}>
              {showFree && free?.slots.map(slot => { const top = minutesInto(day, new Date(slot.starts_at)) / 60 * HOUR, height = slot.minutes / 60 * HOUR; return <div key={slot.starts_at} className="free-band" style={{ top, height }} aria-hidden="true">{height >= 26 && <span>{t(`Free ${minutesLabel(slot.minutes, false)}`, `متاح ${minutesLabel(slot.minutes, true)}`)}</span>}</div> })}
              {Array.from({ length: 24 }, (_, h) => <button key={h} className="slot" style={{ top: h * HOUR, height: HOUR }} aria-label={placing ? t(`Schedule at ${h}:00`, `جدولة الساعة ${h}:00`) : t(`Add event at ${h}:00`, `إضافة موعد الساعة ${h}:00`)} onClick={() => slotClick(day, h)} />)}
              {dropHint?.dayIndex === dayIndex && <div className="drop-hint" style={{ top: dropHint.minutes / 60 * HOUR }}><span>{time(atMinutes(day, dropHint.minutes))}</span></div>}
              {layoutLanes(eventsOn(day)).map(({ item, lane, lanes }) => {
                const s = new Date(item.starts_at!), en = new Date(item.ends_at!)
                const dayStart = day.getTime(), dayEnd = dayStart + 86400000
                const top = (Math.max(s.getTime(), dayStart) - dayStart) / 3600000 * HOUR
                const height = Math.max(22, (Math.min(en.getTime(), dayEnd) - Math.max(s.getTime(), dayStart)) / 3600000 * HOUR - 2)
                const flexible = item.kind !== 'fixed' && item.editable, active = preview?.id === item.id, external = item.source !== 'lifeos'
                return <div key={item.id} role="button" tabIndex={0} aria-describedby="calendar-keyboard-help"
                  className={`grid-event kind-${item.kind} ${external ? 'external' : ''} ${height < 44 ? 'compact' : ''} ${active ? 'is-source' : ''} ${overlaps.has(item.id) ? 'conflict' : ''}`}
                  style={{ top, height, insetInlineStart: `calc(${lane / lanes * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` }}
                  onPointerDown={e => { if (e.pointerType === 'mouse') beginDrag(e, item, 'move', dayIndex) }} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag}
                  onClick={() => { if (!suppressClick.current) setEditing(item) }} onKeyDown={e => onEventKey(e, item, day)}>
                  {item.recurring && <Repeat size={10} className="recurring-mark" aria-label={t('Repeats', 'متكرر')} />}{external && <Globe size={10} className="recurring-mark" aria-label={t('External calendar', 'تقويم خارجي')} />}{flexible ? <span className="grip" aria-hidden="true" onPointerDown={e => beginDrag(e, item, 'move', dayIndex)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag}><GripVertical size={13} /></span> : !external && <Lock size={11} className="lock" aria-hidden="true" />}
                  <strong><KindIcon kind={item.kind} source={item.source} size={11} />{item.title}</strong><span className="sr-only">, </span><small>{time(s)} – {time(en)}</small>{!flexible && <span className="sr-only">, {t('fixed', 'ثابت')}</span>}
                  {flexible && <span className="resize-handle" aria-hidden="true" onPointerDown={e => beginDrag(e, item, 'resize', dayIndex)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag} />}
                </div>
              })}
              {preview && preview.dayIndex === dayIndex && <div className={`drag-ghost ${preview.conflict ? 'bad' : ''}`} style={{ top: minutesInto(day, preview.start) / 60 * HOUR, height: Math.max(22, (preview.end.getTime() - preview.start.getTime()) / 3600000 * HOUR - 2) }} aria-live="polite">
                <strong>{time(preview.start)} – {time(preview.end)}</strong><small>{preview.conflict ? t(`Overlaps “${preview.conflict.title}”`, `يتداخل مع «${preview.conflict.title}»`) : minutesLabel(Math.round((preview.end.getTime() - preview.start.getTime()) / 60000), ar)}</small>
              </div>}
              {isToday && <div className="now-line" style={{ top: (now.getHours() * 60 + now.getMinutes()) / 60 * HOUR }} aria-hidden="true" />}
            </div>
          })}
        </div>
        <p id="calendar-keyboard-help" className="sr-only">{t('Arrow keys move between blocks; Page Up and Page Down change the period. Press Enter to edit. Alt plus arrow keys move a flexible block by 15 minutes; add Shift to change its length.', 'الأسهم تنتقل بين الفترات، وPage Up وPage Down تغيّران الفترة الزمنية. اضغط Enter للتعديل. Alt مع الأسهم ينقل الفترة المرنة ١٥ دقيقة، ومع Shift يغيّر مدتها.')}</p>
      </div> : data.loading ? <Empty>{t('Loading…', 'جارٍ التحميل…')}</Empty> : view === 'agenda' ? <div className="agenda">{days.map(day => {
        const events = eventsOn(day).sort((a, b) => a.starts_at!.localeCompare(b.starts_at!)), free = freeFor(day), key = localDate(day)
        const diff = Math.round((new Date(`${key}T12:00`).getTime() - new Date(`${localDate(now)}T12:00`).getTime()) / 86400000)
        const dayName = diff === 0 ? t('Today', 'اليوم') : diff === 1 ? t('Tomorrow', 'غداً') : day.toLocaleDateString(language, { weekday: 'long' })
        return <section key={key} className={`agenda-day ${diff === 0 ? 'today' : ''}`} onDragOver={e => e.preventDefault()} onDrop={e => dropOnDay(e, day, null)} aria-label={`${dayName} ${day.toLocaleDateString(language, { day: 'numeric', month: 'long' })}`}>
          <header><span className="agenda-date"><strong>{day.getDate()}</strong><span>{dayName}</span></span>
            {showFree && free?.work_day && free.free_minutes > 0 && <small className="free-total">{t(`${minutesLabel(free.free_minutes, false)} free`, `${minutesLabel(free.free_minutes, true)} متاح`)}</small>}
            <button className="icon-button" aria-label={t('Add event', 'إضافة موعد')} onClick={() => { const s = new Date(day); s.setHours(9); setEditing({ starts_at: s.toISOString(), ends_at: new Date(s.getTime() + 3600000).toISOString() }) }}><Plus size={17} /></button></header>
          {events.length === 0 ? <p className="agenda-empty">{t('Open day', 'يوم متاح')}</p> : <ul>{events.map(item => {
            const external = item.source !== 'lifeos', current = new Date(item.starts_at!) <= now && new Date(item.ends_at!) > now
            return <li key={item.id}><button type="button" className={`agenda-item kind-${item.kind} ${external ? 'external' : ''} ${overlaps.has(item.id) ? 'conflict' : ''} ${current ? 'current' : ''} ${new Date(item.ends_at!) <= now ? 'past' : ''}`} onClick={() => setEditing(item)}>
              <time><strong>{time(item.starts_at!)}</strong><small>{time(item.ends_at!)}</small></time>
              <span className="agenda-bar" aria-hidden="true" />
              <span className="agenda-title"><KindIcon kind={item.kind} source={item.source} /><strong>{item.title}</strong></span>
              <span className="agenda-marks">{overlaps.has(item.id) && <AlertTriangle size={14} aria-label={t('Overlaps another event', 'يتداخل مع موعد آخر')} />}{item.recurring && <Repeat size={13} aria-label={t('Repeats', 'متكرر')} />}{external ? <Globe size={13} aria-label={sourceName(item.source ?? '', t)} /> : item.kind === 'fixed' && <Lock size={13} aria-label={t('Fixed', 'ثابت')} />}</span>
            </button></li>
          })}</ul>}
        </section>
      })}{data.items.length === 0 && <Empty>{t('Nothing scheduled in this period.', 'لا شيء مجدول في هذه الفترة.')}</Empty>}</div> : <div className={`calendar-grid ${view}`}>{days.map(day => {
        const events = eventsOn(day).sort((a, b) => a.starts_at!.localeCompare(b.starts_at!)), free = freeFor(day)
        return <section key={localDate(day)} className={`calendar-day ${localDate(day) === localDate(now) ? 'today' : ''}`} onDragOver={e => e.preventDefault()} onDrop={e => dropOnDay(e, day, null)}>
          <header><span>{day.toLocaleDateString(language, { weekday: 'short' })}</span><strong>{day.getDate()}</strong>{showFree && free?.work_day && free.free_minutes > 0 && <small className="free-total">{minutesLabel(free.free_minutes, ar)}</small>}<button className="quiet" aria-label={t('Add event', 'إضافة موعد')} onClick={() => { const s = new Date(day); s.setHours(9); setEditing({ starts_at: s.toISOString(), ends_at: new Date(s.getTime() + 3600000).toISOString() }) }}>+</button></header>
          {events.map(item => <article key={item.id} className={`calendar-event kind-${item.kind} ${item.source !== 'lifeos' ? 'external' : ''} ${overlaps.has(item.id) ? 'conflict' : ''}`}><button className="text-button" onClick={() => setEditing(item)}><small>{time(item.starts_at!)}</small><strong><KindIcon kind={item.kind} source={item.source} size={11} /> {item.title}</strong></button></article>)}
        </section>
      })}</div>}
      {timed && <aside className="panel task-tray" aria-label={t('Unscheduled tasks', 'مهام غير مجدولة')}>
        <h2 title={t('Drag a task onto the calendar, or tap “Place” and then a time slot.', 'اسحب مهمة إلى التقويم، أو اضغط «جدولة» ثم اختر وقتاً.')}>{t('Unscheduled', 'غير مجدولة')} <span className="tray-count">{unscheduled.length}</span></h2>
        {!unscheduled.length ? <p className="muted empty-small">{t('Everything open has a time. Nice.', 'كل المهام المفتوحة لها وقت. رائع.')}</p> : <ul>{unscheduled.slice(0, 20).map(task => <li key={task.id} draggable className={`tray-task priority-edge-${task.priority} ${placing?.id === task.id ? 'selected' : ''}`} onDragStart={e => { e.dataTransfer.setData('text/plain', `task:${task.id}`); e.dataTransfer.effectAllowed = 'copyMove' }} onDragEnd={() => setDropHint(null)}>
          <GripVertical size={14} aria-hidden="true" /><span><strong>{task.title}</strong><small className="muted">{label(task.priority || 'medium')} · {task.estimated_minutes} {t('min', 'د')}</small></span>
          <button className="chip-button small" aria-pressed={placing?.id === task.id} onClick={() => setPlacing(placing?.id === task.id ? null : task)}>{placing?.id === task.id ? t('Cancel', 'إلغاء') : t('Place', 'جدولة')}</button>
        </li>)}</ul>}
      </aside>}
    </div>
    {editing && <EventForm item={editing} tasks={tasks.items} onSaved={refresh} onClose={() => setEditing(null)} />}
  </section>
}
