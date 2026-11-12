import { useId, type ReactNode } from 'react'
import { Link, useInRouterContext } from 'react-router'
import { CalendarCheck, CalendarClock, CalendarDays } from 'lucide-react'
import type { RecordItem } from '../../lib/api'
import { deadlineInstant } from '../../lib/quickAdd'
import { calendarLink, displayZone, isSplit, sessionFull } from '../../lib/taskSchedule'
import type { SessionFields } from './sessionFields'
import { DateTimeField } from '../../components/ui/DateTimePicker'
import { SlotChoices } from './ScheduleParts'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { ZoneNote } from '../../components/ui/ZoneNote'

function CalendarLink({ to, children }: { to: string; children: ReactNode }) {
  return useInRouterContext() ? <Link to={to} className="filter-chip">{children}</Link> : <a href={to} className="filter-chip">{children}</a>
}

/**
 * «موعد التنفيذ المجدول»: when the work is booked in the calendar (start and end), apart from the deadline and the estimate.
 * Saved with the dialog's Save: a task with a session is MOVED (PUT), one without gets a new session (POST). Changing only the
 * deadline never moves the session; a deadline before the session ends is said calmly.
 */
export function ScheduledTimeSection({ task, fields, due, busy }: { task: RecordItem; fields: SessionFields; due: string; busy: boolean }) {
  const t = useText(), { language } = useLanguage(), titleId = useId(), { current } = fields
  const dueAt = deadlineInstant(due), endsAt = deadlineInstant(fields.end) ?? current?.ends_at, late = !!endsAt && dueAt !== null && Date.parse(dueAt) < Date.parse(endsAt)
  const split = !!current && isSplit(current)
  return <section className="full rf-session" aria-labelledby={titleId} aria-busy={busy}>
    <span id={titleId} className="field-title">{t('Scheduled execution time', 'موعد التنفيذ المجدول', 'Geplande uitvoeringstijd')}</span>
    {current ? <p className="rf-session-time"><CalendarCheck size={16} aria-hidden="true" /><bdi><time dateTime={current.starts_at}>{sessionFull(current.starts_at, current.ends_at, language, displayZone())}</time></bdi></p>
      : <small className="muted">{t('Not scheduled yet. Fill in a start to put it in the calendar.', 'غير مجدولة بعد. أدخل وقت بداية لوضعها في التقويم.', 'Nog niet ingepland. Vul een start in om de taak in de agenda te zetten.')}</small>}
    {split ? <small className="muted">{t('This task has several sessions. Change them in the calendar.', 'لهذه المهمة عدة جلسات. عدّلها من التقويم.', 'Deze taak heeft meerdere sessies. Pas ze aan in de agenda.')}</small> : <>
      <div className="rf-session-edit">
        <label>{t('Execution start', 'بداية التنفيذ', 'Start uitvoering')}<DateTimeField kind="datetime" id={fields.startId} value={fields.start} onChange={fields.changeStart} /></label>
        <label>{t('Execution end', 'نهاية التنفيذ', 'Einde uitvoering')}<DateTimeField kind="datetime" value={fields.end} onChange={fields.changeEnd} /></label>
      </div>
      <ZoneNote />
      <small className="muted">{t('Saved with the Save button. The end follows the start by the estimated time. Changing only the deadline does not move the session. To remove the session, use the calendar or Undo.', 'تُحفظ بزر «حفظ». تتبع النهاية البداية بحسب المدة المتوقعة. تغيير الموعد النهائي وحده لا ينقل الجلسة. لإزالة الجلسة استخدم التقويم أو «تراجع».', 'Wordt opgeslagen met Opslaan. Het einde volgt de start met de geschatte duur. Alleen de deadline wijzigen verplaatst de sessie niet. Om de sessie te verwijderen: gebruik de agenda of Ongedaan maken.')}</small>
      <SlotChoices task={{ id: task.id, estimated_minutes: Math.max(15, Math.round((Date.parse(deadlineInstant(fields.end) ?? '') - Date.parse(deadlineInstant(fields.start) ?? '')) / 60000) || task.estimated_minutes || 30) }} label={t('Suggested times', 'أوقات مقترحة', 'Voorgestelde tijden')} busy={busy} onPick={slot => { if (!busy) fields.fill(slot) }} />
    </>}
    <div aria-live="polite">{late && <p className="sched-notice"><CalendarClock size={16} aria-hidden="true" />{t('The scheduled session is after the deadline.', 'الجلسة المجدولة بعد الموعد النهائي.', 'De ingeplande sessie valt na de deadline.')}</p>}</div>
    {current && <div className="task-quick sched-actions"><CalendarLink to={calendarLink(current.starts_at, current.session_id)}><CalendarDays size={14} aria-hidden="true" />{t('View in calendar', 'عرض في التقويم', 'Bekijk in agenda')}</CalendarLink></div>}
  </section>
}
