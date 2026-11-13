import { useId, useRef, useState } from 'react'
import type { RecordItem, TaskSchedule } from '../../lib/api'
import { deadlineField } from '../../lib/quickAdd'
import { isSplit, scheduleOf } from '../../lib/taskSchedule'
import { DEFAULT_DURATION, DURATIONS, bookingOf, defaultStart, sessionDraft, startOnDay, validMinutes } from '../../lib/taskWhen'

/** What the dialog posts for the execution time: `schedule` (absent = sessions untouched, null = remove the session) and the length. */
export type ExecutionPayload = { estimated_minutes: number; schedule?: { starts_at: string } | null }

/**
 * The state of «متى تريد تنفيذ المهمة؟»: the day, the start and the length of the task's calendar session, as the account's wall clock.
 * The length IS `estimated_minutes`. One Save sends all of it with the task (`payload`), so there is no second request and no half-save.
 */
export function useExecution(item: Partial<RecordItem>) {
  const startId = useId()
  const [opened] = useState(() => {
    const current: TaskSchedule | null = item.id ? scheduleOf(item as RecordItem) : null, split = !!current && isSplit(current)
    return { current, split, draft: current && !split ? sessionDraft(current) : null }
  })
  const estimate = Number(item.estimated_minutes) || DEFAULT_DURATION
  const [day, setDay] = useState(opened.draft?.day ?? ''), [start, setStart] = useState(opened.draft?.start ?? '')
  const [minutes, setMinutes] = useState(String(opened.draft?.minutes ?? estimate))
  const [custom, setCustom] = useState(() => !DURATIONS.includes(Number(opened.draft?.minutes ?? estimate)))
  // Until the user types a start, every day he chooses gets that day's own default; once he has, his time is kept (unless it has passed today).
  const touched = useRef(!!opened.draft)

  const pickDay = (next: string) => {
    if (next) setStart(touched.current && start ? startOnDay(next, start) : defaultStart(next))
    setDay(next)
  }
  const changeStart = (value: string) => { touched.current = true; setStart(value) }
  const fill = (slot: { starts_at: string }) => { const field = deadlineField(slot.starts_at); touched.current = true; setDay(field.slice(0, 10)); setStart(field.slice(11, 16)) }
  const changeMinutes = (value: string) => setMinutes(value)
  const chip = (value: string) => { if (value === 'custom') setCustom(true); else { setCustom(false); setMinutes(value) } }

  /**
   * What the Save sends for the execution time, from the fields as they are (or with `over`, a day and start that were just filled in).
   * Nothing for a closed or split task; `schedule: null` when a scheduled task is set to "not scheduled"; a `schedule` only when the day,
   * the start or the length changed. null: the fields do not make a valid time.
   */
  function payload(closed: boolean, over?: { day: string; start: string }): ExecutionPayload | null {
    const d = over?.day ?? day, s = over?.start ?? start, m = Number(minutes), base = Number(item.estimated_minutes) || opened.draft?.minutes || DEFAULT_DURATION
    if (closed || opened.split) return { estimated_minutes: base }
    if (!d) return opened.draft ? { estimated_minutes: base, schedule: null } : { estimated_minutes: base }
    const same = !!opened.draft && d === opened.draft.day && s === opened.draft.start
    if (same && m === opened.draft!.minutes) return { estimated_minutes: base }
    const starts_at = same ? opened.current!.starts_at : bookingOf(d, s, m)?.starts_at
    return starts_at && validMinutes(m) ? { estimated_minutes: m, schedule: { starts_at } } : null
  }
  /** A signature of the fields, so the dialog notices unsaved changes here too. */
  const signature = `${day}|${start}|${minutes}`
  return { startId, opened, day, start, minutes, custom, pickDay, changeStart, fill, changeMinutes, chip, payload, signature }
}
export type Execution = ReturnType<typeof useExecution>

