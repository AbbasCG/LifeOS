import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useInRouterContext } from 'react-router'
import { CalendarCheck, CalendarClock, CalendarDays, Timer, X } from 'lucide-react'
import type { Availability, CalendarOccurrence, RecordItem, TaskSchedule } from '../../lib/api'
import { accountDay } from '../../lib/accountDay'
import { slotWords, suggestSlots, type FreeSlot } from '../../lib/scheduleSlots'
import { calendarLink, durationWords, isSplit, scheduleOf, sessionCount, sessionFull, sessionsWord, sessionWhen, useClock } from '../../lib/taskSchedule'
import { useTaskScheduling, type Conflict, type Slot } from '../../lib/useTaskScheduling'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'

type Scheduling = ReturnType<typeof useTaskScheduling>

/** A link inside the app when there is a router (there always is, except in a bare test), else a plain link. */
function AppLink({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  return useInRouterContext() ? <Link to={to} className={className}>{children}</Link> : <a href={to} className={className}>{children}</a>
}

/** "Scheduled · Tomorrow 09:00": the calm badge for a task that has a session in the calendar. Not shown for other tasks. */
export function ScheduleBadge({ schedule }: { schedule: TaskSchedule }) {
  const t = useText(), { language } = useLanguage(), now = useClock()
  const when = sessionWhen(schedule.starts_at, language, t, now), n = sessionCount(schedule)
  return <span className="sched-badge" title={sessionFull(schedule.starts_at, schedule.ends_at, language)}>
    <CalendarCheck size={12} aria-hidden="true" />
    <span>{t('Scheduled', 'مجدولة', 'Gepland')}</span>{' '}
    <bdi><time dateTime={schedule.starts_at}>{when.text}</time></bdi>
    {isSplit(schedule) && n > 1 && <span className="sched-count">{sessionsWord(n, t)}</span>}
  </span>
}

/** The estimated length of the task, always as a length ("30 min"), never as a time of day. */
export function Duration({ minutes }: { minutes: number }) {
  const t = useText()
  return <span className="sched-duration"><Timer size={12} aria-hidden="true" /><span className="sr-only">{t('Estimated time', 'المدة التقديرية', 'Geschatte duur')}: </span>{durationWords(minutes, t)}</span>
}

/**
 * The next free times that fit the task, one tap each (the server's own free-time answer). `label` names the group. While a
 * request runs the group is busy: the buttons are aria-disabled (not disabled, so keyboard focus stays where it is) and a polite status says so.
 */
export function SlotChoices({ task, label, busy, onPick, focusFirst = false, onCancel }: { task: Pick<RecordItem, 'id' | 'estimated_minutes'>; label: string; busy: boolean; onPick: (slot: FreeSlot) => void; focusFirst?: boolean; onCancel?: () => void }) {
  const t = useText(), { language } = useLanguage()
  const minutes = Math.max(15, task.estimated_minutes || 30)
  const free = useApi<Availability>(`/api/availability?date=${accountDay()}&days=7&min_minutes=${minutes}`)
  const slots = suggestSlots(free.data, minutes), box = useRef<HTMLDivElement>(null), focused = useRef(false)
  const loaded = !!free.data
  useEffect(() => {
    if (!focusFirst || !loaded || focused.current) return
    focused.current = true
    box.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [focusFirst, loaded])
  if (!free.data) return null
  // Escape closes only these choices: preventDefault stops a dialog around them from taking it as its own "cancel".
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && onCancel) { e.preventDefault(); e.stopPropagation(); onCancel() } }
  return <div ref={box} className="task-quick" role="group" aria-label={label} aria-busy={busy} onKeyDown={onKey}>
    <span className="muted small">{label}</span>
    {slots.length === 0
      ? <span className="muted small">{t('No free time in the next week.', 'لا وقت متاح في الأسبوع القادم.', 'Geen vrije tijd in de komende week.')}</span>
      : slots.map(slot => <button key={slot.starts_at} type="button" className="filter-chip" aria-disabled={busy || undefined} aria-label={`${label} ${slotWords(slot, language, t)}`} onClick={() => { if (!busy) onPick(slot) }}><CalendarDays size={14} aria-hidden="true" /><bdi>{slotWords(slot, language, t)}</bdi></button>)}
    {/* The live region is always there and only its text changes, so a screen reader announces it. */}
    <span className="sr-only" role="status">{busy ? t('Saving…', 'جارٍ الحفظ…', 'Opslaan…') : ''}</span>
    {busy && <span className="muted small" aria-hidden="true">{t('Saving…', 'جارٍ الحفظ…', 'Opslaan…')}</span>}
    {onCancel && <button type="button" className="quiet" onClick={onCancel}>{t('Cancel', 'إلغاء', 'Annuleren')}</button>}
  </div>
}

/** The active sessions of a task, read from the calendar for the next two months (the same data the calendar shows). */
function useSessions(taskId: number, enabled: boolean) {
  const [range] = useState(() => { const from = Date.now() - 12 * 3_600_000; return { now: from + 12 * 3_600_000, query: `from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(from + 60 * 86_400_000).toISOString())}` } })
  const res = useApi<{ data: CalendarOccurrence[] }>(enabled ? `/api/calendar?${range.query}` : null)
  const list = (res.data?.data ?? []).filter(o => o.task_id === taskId && o.event_id != null && o.source === 'lifeos' && Date.parse(o.ends_at) > range.now)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  return { loading: enabled && !res.data && !res.error, list }
}

/** Rescheduling a booked task: (which session, if there are several) then a new time. Moves the existing session. */
function RescheduleChooser({ task, schedule, scheduling, onClose }: { task: RecordItem; schedule: TaskSchedule; scheduling: Scheduling; onClose: () => void }) {
  const t = useText(), { language } = useLanguage()
  const several = isSplit(schedule)
  const sessions = useSessions(task.id, several)
  const [picked, setPicked] = useState<number | null>(several ? null : schedule.session_id)
  const busy = scheduling.pending === task.id
  const current = sessions.list.find(s => s.event_id === picked)
  const from: Slot | null = current ? { starts_at: current.starts_at, ends_at: current.ends_at } : !several ? { starts_at: schedule.starts_at, ends_at: schedule.ends_at } : null
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }
  async function move(slot: FreeSlot) {
    const outcome = await scheduling.reschedule(task, slot, { sessionId: picked, from })
    if (outcome === 'moved') onClose()
    else if (outcome === 'several') setPicked(null)
  }
  const list = useRef<HTMLDivElement>(null), listed = !sessions.loading
  useEffect(() => { if (several && picked === null && listed) list.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }) }, [several, picked, listed])
  if (several && picked === null) {
    const options = sessions.list.length ? sessions.list.map(s => ({ id: s.event_id as number, at: s.starts_at, end: s.ends_at })) : [{ id: schedule.session_id, at: schedule.starts_at, end: schedule.ends_at }]
    const label = t('Which session?', 'أي جلسة؟', 'Welke sessie?')
    return <div ref={list} className="task-quick" role="group" aria-label={label} aria-busy={sessions.loading} onKeyDown={onKey}>
      <span className="muted small">{label}</span>
      {options.map(o => <button key={o.id} type="button" className="filter-chip" onClick={() => setPicked(o.id)}><bdi>{sessionWhen(o.at, language, t).text}</bdi></button>)}
      <button type="button" className="quiet" onClick={onClose}>{t('Cancel', 'إلغاء', 'Annuleren')}</button>
    </div>
  }
  return <SlotChoices task={task} label={t('Reschedule', 'إعادة الجدولة', 'Opnieuw inplannen')} busy={busy} focusFirst onCancel={onClose} onPick={slot => void move(slot)} />
}

/**
 * What the opened task offers for its calendar time. Unscheduled: the "Schedule" choices. Scheduled: "View in calendar" and
 * "Reschedule" (and never the booking choices, so a second tap cannot book a second session).
 */
export function ScheduleControls({ task, scheduling, choosing, setChoosing }: { task: RecordItem; scheduling: Scheduling; choosing: boolean; setChoosing: (open: boolean) => void }) {
  const t = useText(), { language } = useLanguage()
  const schedule = scheduleOf(task), booked = !!schedule, busy = scheduling.pending === task.id
  const trigger = useRef<HTMLButtonElement>(null), restore = useRef(false), wasBooked = useRef(booked)
  // Closing the choices puts focus back on the button that opened them (after the choices are gone, no timers).
  useEffect(() => { if (!choosing && restore.current) { restore.current = false; trigger.current?.focus() } }, [choosing])
  // A booking replaces the chips that were tapped by the actions: when that left focus on nothing, it goes to "Reschedule".
  useEffect(() => {
    if (booked && !wasBooked.current) { const a = document.activeElement; if (!a || a === document.body) trigger.current?.focus() }
    wasBooked.current = booked
  }, [booked])
  if (!schedule) return <SlotChoices task={task} label={t('Schedule', 'جدولة', 'Inplannen')} busy={busy} onPick={slot => void scheduling.schedule(task, slot)} />
  const close = () => { restore.current = true; setChoosing(false) }
  return <>
    <div className="task-quick sched-actions" role="group" aria-label={t('Calendar session', 'جلسة التقويم', 'Agendasessie')} aria-busy={busy}>
      <span className="muted small">{isSplit(schedule) && sessionCount(schedule) > 1 ? `${sessionsWord(sessionCount(schedule), t)} · ` : ''}<bdi>{sessionFull(schedule.starts_at, schedule.ends_at, language)}</bdi></span>
      <AppLink to={calendarLink(schedule.starts_at, schedule.session_id)} className="filter-chip"><CalendarDays size={14} aria-hidden="true" />{t('View in calendar', 'عرض في التقويم', 'Bekijk in agenda')}</AppLink>
      <button ref={trigger} type="button" className="filter-chip" aria-expanded={choosing} aria-disabled={busy || undefined} aria-busy={busy} onClick={() => { if (!busy) { if (choosing) close(); else setChoosing(true) } }}><CalendarClock size={14} aria-hidden="true" />{t('Reschedule', 'إعادة الجدولة', 'Opnieuw inplannen')}</button>
    </div>
    {choosing && <RescheduleChooser task={task} schedule={schedule} scheduling={scheduling} onClose={close} />}
  </>
}

/** "This task is already scheduled." with the two ways forward; shown when the server refused a second booking. */
export function ScheduledNotice({ task, conflict, onReschedule, onDismiss }: { task: RecordItem; conflict: Conflict; onReschedule: () => void; onDismiss: () => void }) {
  const t = useText(), box = useRef<HTMLDivElement>(null)
  const known = scheduleOf(task), at = known ?? conflict.session
  // The message is announced (role=alert) and focus moves to it, so a keyboard user lands on the news and its actions, not on nothing.
  useEffect(() => { box.current?.focus({ preventScroll: false }) }, [])
  return <div ref={box} tabIndex={-1} className="sched-notice" role="alert" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDismiss() } }}>
    <CalendarCheck size={16} aria-hidden="true" />
    <p>{t('This task is already scheduled.', 'هذه المهمة مجدولة بالفعل.', 'Deze taak is al ingepland.')}</p>
    {at && <AppLink to={calendarLink(at.starts_at, 'session_id' in at ? at.session_id : at.id)} className="filter-chip"><CalendarDays size={14} aria-hidden="true" />{t('View in calendar', 'عرض في التقويم', 'Bekijk in agenda')}</AppLink>}
    <button type="button" className="filter-chip" onClick={onReschedule}><CalendarClock size={14} aria-hidden="true" />{t('Reschedule', 'إعادة الجدولة', 'Opnieuw inplannen')}</button>
    <button type="button" className="icon-button" aria-label={t('Dismiss', 'إغلاق', 'Sluiten')} onClick={onDismiss}><X size={16} aria-hidden="true" /></button>
  </div>
}

/**
 * What opening a calendar item that belongs to a task shows: which task, when (in the zone the calendar is drawn in), for how
 * long, a link to the task, and "Reschedule", which moves this very session to another free time (it never adds one).
 */
export function TaskSessionPanel({ taskId, eventId, title, startsAt, endsAt, zone, canMove, onMoved }: { taskId: number; eventId: number; title: string; startsAt: string; endsAt: string; zone: string; canMove: boolean; onMoved: (slot: Slot) => void }) {
  const t = useText(), { language } = useLanguage(), scheduling = useTaskScheduling()
  const [choosing, setChoosing] = useState(false), trigger = useRef<HTMLButtonElement>(null)
  const minutes = Math.max(15, Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60000)), busy = scheduling.pending === taskId
  const restore = useRef(false)
  useEffect(() => { if (!choosing && restore.current) { restore.current = false; trigger.current?.focus() } }, [choosing])
  const close = () => { restore.current = true; setChoosing(false) }
  async function move(slot: FreeSlot) {
    const outcome = await scheduling.reschedule({ id: taskId, title }, slot, { sessionId: eventId, from: { starts_at: startsAt, ends_at: endsAt } })
    if (outcome === 'moved') onMoved(slot)
  }
  return <section className="full sched-panel" aria-label={t('Task session', 'جلسة المهمة', 'Taaksessie')}>
    <p className="sched-panel-title"><CalendarCheck size={15} aria-hidden="true" /><strong>{t('Scheduled task session', 'جلسة مهمة مجدولة', 'Ingeplande taaksessie')}</strong></p>
    <dl>
      <dt>{t('Task', 'المهمة', 'Taak')}</dt><dd><bdi><AppLink to={`/tasks?task=${taskId}`}>{title}</AppLink></bdi></dd>
      <dt>{t('Time', 'الوقت', 'Tijd')}</dt><dd><bdi><time dateTime={startsAt}>{sessionFull(startsAt, endsAt, language, zone)}</time></bdi></dd>
      <dt>{t('Duration', 'المدة', 'Duur')}</dt><dd>{durationWords(minutes, t)}</dd>
    </dl>
    {canMove && <button ref={trigger} type="button" className="filter-chip" aria-expanded={choosing} aria-disabled={busy || undefined} aria-busy={busy} onClick={() => { if (!busy) { if (choosing) close(); else setChoosing(true) } }}><CalendarClock size={14} aria-hidden="true" />{t('Reschedule', 'إعادة الجدولة', 'Opnieuw inplannen')}</button>}
    {choosing && <SlotChoices task={{ id: taskId, estimated_minutes: minutes }} label={t('Reschedule', 'إعادة الجدولة', 'Opnieuw inplannen')} busy={busy} focusFirst onCancel={close} onPick={slot => void move(slot)} />}
  </section>
}
