import { useId } from 'react'
import { CalendarCheck, CalendarX, Sun, Sunrise } from 'lucide-react'
import { sessionWhen } from '../../lib/taskSchedule'
import type { Execution } from './useExecution'
import { DEFAULT_DURATION, DURATIONS, MAX_DURATION, MIN_DURATION, bookingOf, choiceOf, dayLabel, validMinutes } from '../../lib/taskWhen'
import { accountDay, shiftDay } from '../../lib/accountDay'
import { ChoiceGroup } from '../../components/ui/Choice'
import { DateTimeField } from '../../components/ui/DateTimePicker'
import { ZoneNote } from '../../components/ui/ZoneNote'
import { ScheduleBadge, SlotChoices } from './ScheduleParts'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'

const DURATION_VALUES = DURATIONS.map(String)

/**
 * «متى تريد تنفيذ المهمة؟»: the date tiles, ONE start time, the length chips and the computed end. Saving puts it in the calendar.
 * A task with several sessions keeps its note (they are edited in the calendar); a closed task has no calendar time at all.
 */
export function ExecutionSection({ exec, closed, busy }: { exec: Execution; closed: boolean; busy: boolean }) {
  const t = useText(), { language } = useLanguage(), titleId = useId(), { opened, day } = exec
  const choice = choiceOf(day), minutes = Number(exec.minutes), booking = bookingOf(day, exec.start, minutes)
  const heading = t('When do you want to do it?', 'متى تريد تنفيذ المهمة؟', 'Wanneer wil je de taak doen?')
  const tile = (value: string, label: string, Icon: typeof Sun, on: () => void) => <button key={value} type="button" role="radio" aria-checked={choice === value} className="choice" onClick={on}>
    <span className="choice-icon" aria-hidden="true"><Icon size={20} /></span><span className="choice-label">{label}</span></button>
  const end = booking && (booking.endDay === day ? <bdi dir="ltr">{booking.endTime}</bdi>
    : <><bdi>{sessionWhen(booking.ends_at, language, t).dayText}</bdi> <bdi dir="ltr">{booking.endTime}</bdi></>)
  return <section className="full rf-when" aria-labelledby={titleId} aria-busy={busy}>
    <span id={titleId} className="field-title">{heading}</span>
    {closed ? <small className="muted">{t('Completed and cancelled tasks are not scheduled. Reopen the task to put it in the calendar.', 'المهام المكتملة أو الملغاة لا تُجدول. أعد فتح المهمة لوضعها في التقويم.', 'Voltooide en geannuleerde taken worden niet ingepland. Heropen de taak om haar in de agenda te zetten.')}</small>
    : opened.split ? <>
      {opened.current && <ScheduleBadge schedule={opened.current} />}
      <small className="muted">{t('This task has several sessions. Change them in the calendar.', 'لهذه المهمة عدة جلسات. عدّلها من التقويم.', 'Deze taak heeft meerdere sessies. Pas ze aan in de agenda.')}</small></>
    : <>
      {opened.current && <ScheduleBadge schedule={opened.current} />}
      <div className="qa-whens rf-whens" role="radiogroup" aria-label={heading}>
        {tile('today', t('Today', 'اليوم', 'Vandaag'), Sun, () => exec.pickDay(accountDay()))}
        {tile('tomorrow', t('Tomorrow', 'غدًا', 'Morgen'), Sunrise, () => exec.pickDay(shiftDay(accountDay(), 1)))}
        <span className={`qa-pick${choice === 'custom' ? ' is-set' : ''}`}><DateTimeField kind="date" value={choice === 'custom' ? day : ''} min={accountDay()} onChange={exec.pickDay} label={t('Pick a date', 'تاريخ آخر', 'Andere datum')} placeholder={t('Pick a date', 'تاريخ آخر', 'Andere datum')} shown={choice === 'custom' ? dayLabel(day, language) : undefined} radioChecked={choice === 'custom'} /></span>
        {tile('none', t('Not scheduled', 'بدون جدولة', 'Niet ingepland'), CalendarX, () => exec.pickDay(''))}
      </div>
      {choice === 'none' ? (opened.draft && <p className="sched-notice" role="status"><CalendarX size={16} aria-hidden="true" />{t('Saving will remove it from your calendar. You can undo it afterwards.', 'سيؤدي الحفظ إلى إزالتها من التقويم، ويمكنك التراجع بعد ذلك.', 'Opslaan haalt de taak uit je agenda. Daarna kun je het ongedaan maken.')}</p>)
      : <>
        <label className="rf-start">{t('Start time', 'وقت البداية', 'Starttijd')}<DateTimeField kind="time" id={exec.startId} value={exec.start} onChange={exec.changeStart} /></label>
        <div className="field-block rf-dur"><span className="field-title">{t('Duration (minutes)', 'المدة (بالدقائق)', 'Duur (minuten)')}</span>
          <ChoiceGroup label={t('Duration (minutes)', 'المدة (بالدقائق)', 'Duur (minuten)')} value={exec.custom ? 'custom' : exec.minutes} onChange={exec.chip}
            options={[...DURATION_VALUES.map(m => ({ value: m, label: m })), { value: 'custom', label: t('Custom', 'مدة مخصصة', 'Aangepast') }]} />
          {exec.custom && <input type="number" inputMode="numeric" min={MIN_DURATION} max={MAX_DURATION} step={1} required value={exec.minutes} aria-label={t('Custom duration (minutes)', 'المدة المخصصة (بالدقائق)', 'Aangepaste duur (minuten)')} onChange={e => exec.changeMinutes(e.target.value)} />}</div>
        <p className="rf-end" role="status">{end && <><CalendarCheck size={16} aria-hidden="true" />{t('Ends', 'النهاية', 'Einde')} {end}</>}</p>
        <ZoneNote />
        <SlotChoices task={{ id: 0, estimated_minutes: validMinutes(minutes) ? minutes : DEFAULT_DURATION }} from={day} label={t('Suggested times', 'أوقات مقترحة', 'Voorgestelde tijden')} busy={busy} onPick={slot => { if (!busy) exec.fill(slot) }} />
        <small className="muted">{t('Saving puts it in your calendar.', 'الحفظ يضعها في التقويم.', 'Opslaan zet de taak in je agenda.')}</small></>}
    </>}
  </section>
}
