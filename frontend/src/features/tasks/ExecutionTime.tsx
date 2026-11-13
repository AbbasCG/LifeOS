import { useEffect, useId, useRef, useState } from 'react'
import { CalendarCheck, CalendarClock, CalendarX, Sun, Sunrise } from 'lucide-react'
import { sessionWhen } from '../../lib/taskSchedule'
import type { Execution } from './useExecution'
import { DEFAULT_DURATION, DURATIONS, MAX_DURATION, MIN_DURATION, choiceOf, dayLabel, validMinutes } from '../../lib/taskWhen'
import { accountDay, shiftDay } from '../../lib/accountDay'
import { ChoiceGroup } from '../../components/ui/Choice'
import { DateTimeField } from '../../components/ui/DateTimePicker'
import { ZoneNote } from '../../components/ui/ZoneNote'
import { ScheduleBadge, SlotChoices } from './ScheduleParts'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { formatTime } from '../../lib/dateTime'
import { useHourCycle } from '../../lib/useHourCycle'

const DURATION_VALUES = DURATIONS.map(String)

/**
 * «متى تريد تنفيذ المهمة؟»: the date tiles, ONE start time, the length chips and the computed end. Saving puts it in the calendar.
 * A task with several sessions keeps its note (they are edited in the calendar); a closed task has no calendar time at all.
 */
export function ExecutionSection({ exec, closed, busy, lateAfter }: { exec: Execution; closed: boolean; busy: boolean; lateAfter: boolean }) {
  const t = useText(), { language } = useLanguage(), titleId = useId(), endId = useId(), removeId = useId(), { opened, day, booking } = exec
  const [cycle] = useHourCycle(), customInput = useRef<HTMLInputElement>(null), choseCustom = useRef(false)
  const choice = choiceOf(day), minutes = Number(exec.minutes)
  // The suggestions follow the last valid length, once typing has settled (a custom number is not fetched digit by digit).
  const [committed, setCommitted] = useState(validMinutes(minutes) ? minutes : DEFAULT_DURATION)
  useEffect(() => {
    if (!validMinutes(minutes)) return
    const id = window.setTimeout(() => setCommitted(minutes), exec.custom ? 400 : 0)
    return () => window.clearTimeout(id)
  }, [minutes, exec.custom])
  // Choosing "Custom" puts the cursor in the number box.
  useEffect(() => { if (exec.custom && choseCustom.current) { choseCustom.current = false; customInput.current?.focus() } }, [exec.custom])
  const heading = t('When do you want to do it?', 'متى تريد تنفيذ المهمة؟', 'Wanneer wil je de taak doen?')
  const lengthLabel = t('How long will it take?', 'كم تستغرق؟', 'Hoe lang duurt het?')
  const tile = (value: string, label: string, Icon: typeof Sun, on: () => void, describedBy?: string) => <button key={value} type="button" role="radio" aria-checked={choice === value} aria-describedby={describedBy} className="choice" onClick={on}>
    <span className="choice-icon" aria-hidden="true"><Icon size={20} /></span><span className="choice-label">{label}</span></button>
  // The end is shown in the same clock as the start field (24-hour unless the user chose 12-hour).
  const clock = (time: string) => <bdi dir="ltr">{formatTime(time, cycle, language)}</bdi>
  const end = booking && (booking.endDay === day ? clock(booking.endTime) : <><bdi>{sessionWhen(booking.ends_at, language, t).dayText}</bdi> {clock(booking.endTime)}</>)
  const removing = choice === 'none' && !!opened.draft
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
        {tile('none', t('Not scheduled', 'بدون جدولة', 'Niet ingepland'), CalendarX, () => exec.pickDay(''), removing ? removeId : undefined)}
      </div>
      {removing && <p id={removeId} className="sched-notice"><CalendarX size={16} aria-hidden="true" />{t('Saving will remove it from your calendar. You can undo it afterwards.', 'سيؤدي الحفظ إلى إزالتها من التقويم، ويمكنك التراجع بعد ذلك.', 'Opslaan haalt de taak uit je agenda. Daarna kun je het ongedaan maken.')}</p>}
      {choice !== 'none' && <label className="rf-start">{t('Start time', 'وقت البداية', 'Starttijd')}<DateTimeField kind="time" id={exec.startId} value={exec.start} onChange={exec.changeStart} describedBy={endId} /></label>}
      <div className="field-block"><span className="field-title">{lengthLabel}</span>
        <ChoiceGroup label={lengthLabel} value={exec.custom ? 'custom' : exec.minutes} onChange={v => { if (v === 'custom') choseCustom.current = true; exec.chip(v) }}
          options={[...DURATION_VALUES.map(m => ({ value: m, label: m })), { value: 'custom', label: t('Custom', 'مدة مخصصة', 'Aangepast') }]} />
        {exec.custom && <input ref={customInput} type="number" inputMode="numeric" min={MIN_DURATION} max={MAX_DURATION} step={1} required value={exec.minutes} aria-label={t('Custom duration (minutes)', 'المدة المخصصة (بالدقائق)', 'Aangepaste duur (minuten)')} onChange={e => exec.changeMinutes(e.target.value)} />}</div>
      {choice !== 'none' && <>
        <p id={endId} className="rf-end">{end && <><CalendarCheck size={16} aria-hidden="true" />{t('Ends', 'النهاية', 'Einde')} {end}</>}</p>
        <div aria-live="polite">{lateAfter && <p className="sched-notice"><CalendarClock size={16} aria-hidden="true" />{t('The scheduled session is after the deadline.', 'الجلسة المجدولة بعد الموعد النهائي.', 'De ingeplande sessie valt na de deadline.')}</p>}</div>
        <ZoneNote />
        <SlotChoices task={{ id: 0, estimated_minutes: committed }} from={day} label={t('Suggested times', 'أوقات مقترحة', 'Voorgestelde tijden')} busy={busy} onPick={slot => { if (!busy) exec.fill(slot) }} />
        <small className="muted">{t('Saving puts it in your calendar.', 'الحفظ يضعها في التقويم.', 'Opslaan zet de taak in je agenda.')}</small></>}
    </>}
  </section>
}
