import { useEffect, useRef, useState, type DragEvent } from 'react'
import { ChevronLeft, ChevronRight, Plus, GripVertical } from 'lucide-react'
import { api, type RecordItem } from '../lib/api'
import { useRecords, localDate } from '../lib/hooks'
import { useText } from '../lib/i18n'
import { useLanguage } from '../contexts/LanguageContext'
import { RecordForm, useStatusLabel } from './ResourcePage'
import { Empty, ErrorMessage, Dialog } from '../components/ui/Shared'
import { layoutLanes } from '../lib/calendar'

const HOUR = 52
const SNAP = 15
function minutesFromPointer(e: DragEvent<HTMLElement> | React.MouseEvent<HTMLElement>, offset = 0) {
  const rect = e.currentTarget.getBoundingClientRect()
  const minutes = (e.clientY - rect.top - offset) / HOUR * 60
  return Math.max(0, Math.min(24 * 60 - SNAP, Math.round(minutes / SNAP) * SNAP))
}

export default function CalendarPage() {
  const t = useText(), { language } = useLanguage(), label = useStatusLabel()
  const [date, setDate] = useState(localDate()), [view, setView] = useState(() => window.innerWidth < 700 ? 'day' : 'week')
  const [editing, setEditing] = useState<Partial<RecordItem> | null>(null), [moving, setMoving] = useState<{ item: RecordItem; start: Date; end: Date } | null>(null)
  const [now, setNow] = useState(() => new Date()), [busy, setBusy] = useState(false)
  const scroller = useRef<HTMLDivElement>(null), grab = useRef(0)
  const start = new Date(`${date}T00:00`)
  if (view === 'month') start.setDate(1); else if (view === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  const end = new Date(start); end.setDate(end.getDate() + (view === 'month' ? new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate() : view === 'day' ? 1 : 7))
  const data = useRecords('events', `per_page=100&from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`)
  const tasks = useRecords('tasks', 'per_page=50&due=open&sort=priority')
  const days = Array.from({ length: Math.round((end.getTime() - start.getTime()) / 86400000) }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d })
  const timed = view === 'day' || view === 'week'
  const scheduledTaskIds = new Set(data.items.map(e => e.task_id).filter(Boolean))
  const unscheduled = tasks.items.filter(task => !scheduledTaskIds.has(task.id))

  useEffect(() => { const id = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(id) }, [])
  useEffect(() => { if (timed && scroller.current) scroller.current.scrollTop = 7 * HOUR }, [timed])

  function shift(direction: number) { const d = new Date(`${date}T12:00`); if (view === 'month') d.setMonth(d.getMonth() + direction); else d.setDate(d.getDate() + direction * (view === 'day' ? 1 : 7)); setDate(localDate(d)) }
  function at(day: Date, minutes: number) { const d = new Date(day); d.setHours(0, minutes, 0, 0); return d }
  function eventsOn(day: Date) { const next = new Date(day); next.setDate(next.getDate() + 1); return data.items.filter(i => new Date(i.starts_at!) < next && new Date(i.ends_at!) > day) }
  async function save(fn: () => Promise<unknown>) { setBusy(true); try { await fn(); data.setError(''); await data.reload() } catch (e) { data.setError((e as Error).message) } finally { setBusy(false) } }
  function dropOnDay(e: DragEvent<HTMLElement>, day: Date, minutes: number | null) {
    e.preventDefault()
    const payload = e.dataTransfer.getData('text/plain')
    if (payload.startsWith('task:')) {
      const task = tasks.items.find(i => i.id === Number(payload.slice(5)))
      if (!task) return
      const s = at(day, minutes ?? 9 * 60), length = Math.max(15, task.estimated_minutes || 30)
      void save(() => api('/api/events', 'POST', { title: task.title, task_id: task.id, kind: 'flexible', starts_at: s.toISOString(), ends_at: new Date(s.getTime() + length * 60000).toISOString() }))
      return
    }
    const item = data.items.find(i => i.id === Number(payload))
    if (!item) return
    const old = new Date(item.starts_at!), duration = new Date(item.ends_at!).getTime() - old.getTime()
    const next = minutes === null ? (() => { const d = new Date(day); d.setHours(old.getHours(), old.getMinutes()); return d })() : at(day, minutes)
    if (next.getTime() !== old.getTime()) setMoving({ item, start: next, end: new Date(next.getTime() + duration) })
  }
  const time = (iso: string | Date) => new Date(iso).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })

  return <section className="page calendar-page">
    <header className="page-heading reveal"><div><p className="eyebrow">{t('Calendar', 'التقويم')}</p><h1>{t('Make space for your day', 'امنح يومك مساحة')}</h1><p className="muted">{t('Drag tasks onto the grid to block time. Drag flexible blocks to move them. Times use this device’s timezone.', 'اسحب المهام إلى الجدول لحجز وقت لها، واسحب الفترات المرنة لنقلها. الأوقات حسب المنطقة الزمنية للجهاز.')}</p></div><button className="primary" onClick={() => { const s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1); setEditing({ starts_at: s.toISOString(), ends_at: new Date(s.getTime() + 3600000).toISOString() }) }}><Plus size={18} />{t('New event', 'موعد جديد')}</button></header>
    <div className="toolbar calendar-toolbar">
      <button className="icon-button" aria-label={t('Previous', 'السابق')} onClick={() => shift(-1)}><ChevronLeft className="flip-rtl" /></button>
      <input type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} aria-label={t('Date', 'التاريخ')} />
      <button className="icon-button" aria-label={t('Next', 'التالي')} onClick={() => shift(1)}><ChevronRight className="flip-rtl" /></button>
      <button className="quiet" onClick={() => setDate(localDate())}>{t('Today', 'اليوم')}</button>
      <strong className="calendar-range">{start.toLocaleDateString(language, { month: 'long', year: 'numeric' })}</strong>
      <div className="segmented" role="radiogroup" aria-label={t('Calendar view', 'عرض التقويم')}>{[['day', t('Day', 'يوم')], ['week', t('Week', 'أسبوع')], ['month', t('Month', 'شهر')], ['agenda', t('Agenda', 'جدول')]].map(([key, name]) => <button key={key} role="radio" aria-checked={view === key} className={view === key ? 'active' : ''} onClick={() => setView(key)}>{name}</button>)}</div>
    </div>
    <ErrorMessage error={data.error || tasks.error} />
    <div className={`calendar-layout ${timed ? 'with-tray' : ''}`}>
      {timed ? <div className={`time-grid ${view}`} style={{ ['--days' as string]: days.length }}>
        <div className="time-grid-head"><span />{days.map(day => <div key={localDate(day)} className={localDate(day) === localDate(now) ? 'today' : ''}><span>{day.toLocaleDateString(language, { weekday: 'short' })}</span><strong>{day.getDate()}</strong></div>)}</div>
        <div className="time-grid-body" ref={scroller}>
          <div className="time-gutter">{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * HOUR }}>{h ? time(new Date(2026, 0, 1, h)) : ''}</span>)}</div>
          {days.map(day => {
            const isToday = localDate(day) === localDate(now)
            return <div key={localDate(day)} className={`time-column ${isToday ? 'today' : ''}`} style={{ height: 24 * HOUR }}
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
              onDrop={e => dropOnDay(e, day, minutesFromPointer(e, grab.current))}
              onDoubleClick={e => { if (e.target !== e.currentTarget) return; const s = at(day, Math.floor(minutesFromPointer(e) / 30) * 30); setEditing({ starts_at: s.toISOString(), ends_at: new Date(s.getTime() + 3600000).toISOString() }) }}>
              {Array.from({ length: 24 }, (_, h) => <button key={h} className="slot" style={{ top: h * HOUR, height: HOUR }} aria-label={t(`Add event at ${h}:00`, `إضافة موعد الساعة ${h}:00`)} onClick={() => { const s = at(day, h * 60); setEditing({ starts_at: s.toISOString(), ends_at: new Date(s.getTime() + 3600000).toISOString() }) }} />)}
              {layoutLanes(eventsOn(day)).map(({ item, lane, lanes }) => {
                const s = new Date(item.starts_at!), e = new Date(item.ends_at!)
                const dayStart = day.getTime(), dayEnd = dayStart + 86400000
                const top = (Math.max(s.getTime(), dayStart) - dayStart) / 3600000 * HOUR
                const height = Math.max(22, (Math.min(e.getTime(), dayEnd) - Math.max(s.getTime(), dayStart)) / 3600000 * HOUR - 2)
                return <article key={item.id} className={`grid-event kind-${item.kind} ${height < 44 ? 'compact' : ''}`} style={{ top, height, insetInlineStart: `calc(${lane / lanes * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` }}
                  draggable={item.kind === 'flexible'} onDragStart={ev => { ev.dataTransfer.setData('text/plain', String(item.id)); grab.current = ev.clientY - ev.currentTarget.getBoundingClientRect().top }} onDragEnd={() => { grab.current = 0 }}>
                  <button className="text-button" onClick={() => setEditing(item)}><strong>{item.title}</strong><small>{time(s)} – {time(e)}</small></button>
                </article>
              })}
              {isToday && <div className="now-line" style={{ top: (now.getHours() * 60 + now.getMinutes()) / 60 * HOUR }} aria-hidden="true" />}
            </div>
          })}
        </div>
      </div> : data.loading ? <Empty>{t('Loading…', 'جارٍ التحميل…')}</Empty> : <div className={`calendar-grid ${view}`}>{days.map(day => {
        const events = eventsOn(day).sort((a, b) => a.starts_at!.localeCompare(b.starts_at!))
        if (view === 'agenda' && !events.length) return null
        return <section key={localDate(day)} className={`calendar-day ${localDate(day) === localDate(now) ? 'today' : ''}`} onDragOver={e => e.preventDefault()} onDrop={e => dropOnDay(e, day, null)}>
          <header><span>{day.toLocaleDateString(language, { weekday: 'short' })}</span><strong>{day.getDate()}</strong><button className="quiet" aria-label={t('Add event', 'إضافة موعد')} onClick={() => { const s = new Date(day); s.setHours(9); setEditing({ starts_at: s.toISOString(), ends_at: new Date(s.getTime() + 3600000).toISOString() }) }}>+</button></header>
          {events.map(item => <article key={item.id} className={`calendar-event kind-${item.kind}`} draggable={item.kind === 'flexible'} onDragStart={e => e.dataTransfer.setData('text/plain', String(item.id))}><button className="text-button" onClick={() => setEditing(item)}><small>{time(item.starts_at!)} – {time(item.ends_at!)}</small><strong>{item.title}</strong><small>{item.kind === 'fixed' ? t('Fixed', 'ثابت') : t('Flexible', 'مرن')}</small></button><button className="quiet" onClick={() => setMoving({ item, start: new Date(item.starts_at!), end: new Date(new Date(item.ends_at!).getTime() + 15 * 60000) })}>{t('+15 min', '+١٥ دقيقة')}</button></article>)}
          {events.length === 0 && <p className="free-slot">{t('Open time', 'وقت متاح')}</p>}
        </section>
      })}{view === 'agenda' && data.items.length === 0 && <Empty>{t('Nothing scheduled in this period.', 'لا شيء مجدول في هذه الفترة.')}</Empty>}</div>}
      {timed && <aside className="panel task-tray" aria-label={t('Unscheduled tasks', 'مهام غير مجدولة')}>
        <h2>{t('Unscheduled', 'غير مجدولة')}</h2>
        <p className="muted">{t('Drag a task onto the calendar to reserve time for it.', 'اسحب مهمة إلى التقويم لحجز وقت لها.')}</p>
        {!unscheduled.length ? <p className="muted empty-small">{t('Everything open has a time. Nice.', 'كل المهام المفتوحة لها وقت. رائع.')}</p> : <ul>{unscheduled.slice(0, 20).map(task => <li key={task.id} draggable className={`tray-task priority-edge-${task.priority}`} onDragStart={e => { e.dataTransfer.setData('text/plain', `task:${task.id}`); e.dataTransfer.effectAllowed = 'copyMove'; grab.current = 0 }}>
          <GripVertical size={14} aria-hidden="true" /><span><strong>{task.title}</strong><small className="muted">{label(task.priority || 'medium')} · {task.estimated_minutes} {t('min', 'د')}</small></span>
          <button className="icon-button" disabled={busy} aria-label={t(`Schedule “${task.title}” in the next free hour`, `جدولة «${task.title}» في الساعة المتاحة التالية`)} onClick={() => { const s = new Date(); s.setMinutes(s.getMinutes() < 30 ? 30 : 60, 0, 0); void save(() => api('/api/events', 'POST', { title: task.title, task_id: task.id, kind: 'flexible', starts_at: s.toISOString(), ends_at: new Date(s.getTime() + Math.max(15, task.estimated_minutes || 30) * 60000).toISOString() })) }}><Plus size={15} /></button>
        </li>)}</ul>}
      </aside>}
    </div>
    {editing && <RecordForm resource="events" item={editing} onSave={() => void data.reload()} onClose={() => setEditing(null)} />}
    {moving && <Dialog title={t('Confirm schedule change', 'تأكيد تغيير الجدول')} onClose={() => setMoving(null)}><p><strong>{moving.item.title}</strong></p><p className="muted">{moving.start.toLocaleDateString(language, { weekday: 'long', month: 'short', day: 'numeric' })} · {time(moving.start)} – {time(moving.end)}</p><div className="toolbar"><button className="quiet" onClick={() => setMoving(null)}>{t('Cancel', 'إلغاء')}</button><button className="primary" disabled={busy} onClick={() => { const m = moving; setMoving(null); void save(() => api(`/api/events/${m.item.id}`, 'PATCH', { starts_at: m.start.toISOString(), ends_at: m.end.toISOString() })) }}>{t('Save change', 'حفظ التغيير')}</button></div></Dialog>}
  </section>
}
