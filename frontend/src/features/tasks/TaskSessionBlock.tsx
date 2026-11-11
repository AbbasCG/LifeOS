import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useInRouterContext } from 'react-router'
import { CalendarCheck, CalendarClock, CalendarDays } from 'lucide-react'
import { api, ApiError, type RecordItem, type TaskSchedule } from '../../lib/api'
import { deadlineField, deadlineInstant } from '../../lib/quickAdd'
import { calendarLink, displayZone, isNotScheduled, isSeveralSessions, notifyScheduleChanged, scheduleOf, sessionFull } from '../../lib/taskSchedule'
import { DateTimeField } from '../../components/ui/DateTimePicker'
import { ErrorMessage } from '../../components/ui/Shared'
import { SlotChoices } from './ScheduleParts'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'

/** The one place that writes a session's time for people; switch it to the shared 24-hour formatter here when that lands. */
const sessionText = (s: TaskSchedule, language: string) => sessionFull(s.starts_at, s.ends_at, language, displayZone())

function CalendarLink({ to, children }: { to: string; children: ReactNode }) {
  return useInRouterContext() ? <Link to={to} className="filter-chip">{children}</Link> : <a href={to} className="filter-chip">{children}</a>
}

/** Which message the user should read for a refused move: the server's own words (overlap on `starts_at`, permission, past time). */
function refusal(e: unknown) {
  if (e instanceof ApiError) return e.errors.starts_at?.[0] ?? e.errors.ends_at?.[0] ?? e.message
  return (e as Error).message
}

/**
 * The calendar session of a task, apart from its deadline: when it is booked, "View in calendar" and "Reschedule", which moves
 * THAT session (PUT, never a new one). Changing the deadline never moves it, and a deadline before the session ends is said calmly.
 * Shown only for a task that has a session.
 */
export function TaskSessionBlock({ task, due }: { task: RecordItem; due: string }) {
  const t = useText(), { language } = useLanguage(), toast = useToast(), titleId = useId()
  const [schedule, setSchedule] = useState<TaskSchedule | null>(() => scheduleOf(task))
  const [choosing, setChoosing] = useState(false), [start, setStart] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const sending = useRef(false), trigger = useRef<HTMLButtonElement>(null), editor = useRef<HTMLDivElement>(null), restore = useRef(false)
  // Closing the editor puts focus back on "Reschedule" (once the editor is gone); opening it puts focus on its first control.
  useEffect(() => {
    if (choosing) editor.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
    else if (restore.current) { restore.current = false; trigger.current?.focus() }
  }, [choosing])
  if (!schedule) return null

  const dueAt = deadlineInstant(due), late = dueAt !== null && Date.parse(dueAt) < Date.parse(schedule.ends_at)
  const minutes = Math.max(15, Math.round((Date.parse(schedule.ends_at) - Date.parse(schedule.starts_at)) / 60000))
  const open = () => { setError(''); setStart(deadlineField(schedule.starts_at)); setChoosing(true) }
  const close = (clearError = true) => { restore.current = true; if (clearError) setError(''); setChoosing(false) }

  async function move(startsAt: string, endsAt: string) {
    if (!schedule || sending.current) return
    sending.current = true; setBusy(true); setError('')
    try {
      const moved = await api<{ schedule?: TaskSchedule | null }>(`/api/tasks/${task.id}/schedule`, 'PUT', { starts_at: startsAt, ends_at: endsAt, session_id: schedule.session_id })
      const next = moved?.schedule ?? { ...schedule, starts_at: startsAt, ends_at: endsAt }
      const message = t('Session moved.', 'نُقلت الجلسة.', 'Sessie verplaatst.')
      setSchedule(next); toast(message, 'success'); notifyScheduleChanged(); close(false)   // the toast is the one announcement
    } catch (e) {
      if (isSeveralSessions(e) || isNotScheduled(e)) notifyScheduleChanged()
      setError(refusal(e))
    } finally { sending.current = false; setBusy(false) }
  }
  function moveToField() {
    const at = deadlineInstant(start)
    if (!at || Date.parse(at) === Date.parse(schedule!.starts_at)) { setError(at ? t('That is the current time.', 'هذا هو الوقت الحالي.', 'Dit is de huidige tijd.') : t('Choose a date and time.', 'اختر التاريخ والوقت.', 'Kies een datum en tijd.')); return }
    void move(at, new Date(Date.parse(at) + minutes * 60000).toISOString())
  }
  // Escape closes only this editor (not the dialog around it); keys from the date picker's own sheet are left to it.
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && editor.current?.contains(e.target as Node)) { e.preventDefault(); e.stopPropagation(); close() } }

  return <section className="full rf-session" aria-labelledby={titleId}>
    <span id={titleId} className="field-title">{t('Scheduled session time', 'موعد الجلسة المجدولة', 'Tijd van de ingeplande sessie')}</span>
    <p className="rf-session-time"><CalendarCheck size={16} aria-hidden="true" /><bdi><time dateTime={schedule.starts_at}>{sessionText(schedule, language)}</time></bdi></p>
    <small className="muted">{t('Changing only the deadline does not move the session.', 'تغيير الموعد النهائي وحده لا ينقل الجلسة.', 'Alleen de deadline wijzigen verplaatst de sessie niet.')}</small>
    <div aria-live="polite">{late && <p className="sched-notice"><CalendarClock size={16} aria-hidden="true" />{t('The scheduled session is after the deadline.', 'الجلسة المجدولة بعد الموعد النهائي.', 'De ingeplande sessie valt na de deadline.')}</p>}</div>
    <div className="task-quick sched-actions">
      <CalendarLink to={calendarLink(schedule.starts_at, schedule.session_id)}><CalendarDays size={14} aria-hidden="true" />{t('View in calendar', 'عرض في التقويم', 'Bekijk in agenda')}</CalendarLink>
      <button ref={trigger} type="button" className="filter-chip" aria-expanded={choosing} aria-disabled={busy || undefined} onClick={() => { if (!busy) { if (choosing) close(); else open() } }}><CalendarClock size={14} aria-hidden="true" />{t('Reschedule', 'إعادة الجدولة', 'Opnieuw inplannen')}</button>
    </div>
    {choosing && <div ref={editor} className="rf-session-edit" role="group" aria-label={t('Reschedule the session', 'إعادة جدولة الجلسة', 'Sessie opnieuw inplannen')} aria-busy={busy} onKeyDown={onKey}>
      <label>{t('New start', 'بداية جديدة', 'Nieuwe start')}<DateTimeField kind="datetime" value={start} onChange={setStart} /></label>
      <div className="task-quick">
        <button type="button" className="primary" aria-disabled={busy || undefined} onClick={() => { if (!busy) moveToField() }}>{busy ? t('Saving…', 'جارٍ الحفظ…', 'Opslaan…') : t('Move session', 'نقل الجلسة', 'Sessie verplaatsen')}</button>
        <button type="button" className="quiet" onClick={() => close()}>{t('Cancel', 'إلغاء', 'Annuleren')}</button>
      </div>
      <SlotChoices task={{ id: task.id, estimated_minutes: minutes }} label={t('Suggested times', 'أوقات مقترحة', 'Voorgestelde tijden')} busy={busy} onPick={slot => { if (!busy) void move(slot.starts_at, slot.ends_at) }} />
    </div>}
    <ErrorMessage error={error} />
  </section>
}
