import { useId, useRef, useState } from 'react'
import type { RecordItem, TaskSchedule } from '../../lib/api'
import { deadlineField, deadlineInstant } from '../../lib/quickAdd'
import { isSplit, scheduleOf } from '../../lib/taskSchedule'
import type { Slot } from '../../lib/scheduleConflict'
import { useText } from '../../lib/i18n'

/** What saving the section's fields means: nothing to do, a slot to book/move, or a mistake to tell the user about. */
export type SessionPlan = { slot: Slot } | { error: string } | null

/**
 * The state of the «موعد التنفيذ المجدول» fields (start and end of the calendar session), kept by the edit dialog so its main Save
 * can send them. Both fields are wall times in the ACCOUNT's timezone, exactly like the deadline (see deadlineField). The end follows the start (same length: the
 * session's own, else the estimate) until the user sets the end by hand.
 */
export function useSessionFields(task: Partial<RecordItem>, estimate: number) {
  const t = useText(), startId = useId()
  const [current, setCurrent] = useState<TaskSchedule | null>(() => (task.id ? scheduleOf(task as RecordItem) : null))
  const [start, setStart] = useState(() => deadlineField(current?.starts_at)), [end, setEnd] = useState(() => deadlineField(current?.ends_at))
  const endByHand = useRef(false), forced = useRef<Slot | null>(null)
  const length = Math.max(5, estimate || 30) * 60_000

  const changeStart = (value: string) => {
    forced.current = null
    const was = deadlineInstant(start), wasEnd = deadlineInstant(end), next = deadlineInstant(value)
    setStart(value)
    if (next && (!endByHand.current || !wasEnd)) setEnd(deadlineField(new Date(Date.parse(next) + (was && wasEnd ? Date.parse(wasEnd) - Date.parse(was) : length)).toISOString()))
  }
  const changeEnd = (value: string) => { forced.current = null; endByHand.current = true; setEnd(value) }
  const fill = (slot: Slot) => { forced.current = slot; endByHand.current = false; setStart(deadlineField(slot.starts_at)); setEnd(deadlineField(slot.ends_at)) }
  /** The server's answer after a booking: the fields show what is now saved. */
  const saved = (schedule: TaskSchedule | null | undefined) => { if (schedule === undefined) return; forced.current = null; setCurrent(schedule); setStart(deadlineField(schedule?.starts_at)); setEnd(deadlineField(schedule?.ends_at)); endByHand.current = false }

  /** What the Save button has to do about the session, from the fields as they are now. */
  function plan(): SessionPlan {
    if (current && isSplit(current)) return null
    const taken = forced.current; forced.current = null
    if (taken) return { slot: taken }
    const s = deadlineInstant(start); let e = deadlineInstant(end)
    if (!start && !end) return current ? { error: t('A scheduled time cannot be cleared here. Move it, or remove it from the calendar (Undo or the calendar).', 'لا يمكن مسح موعد التنفيذ من هنا. انقله إلى وقت آخر، أو أزله من التقويم (تراجع أو التقويم).', 'Een ingeplande tijd kun je hier niet wissen. Verplaats hem, of haal hem uit de agenda (Ongedaan maken of de agenda).') } : null
    if (!s) return { error: t('Choose the start of the scheduled time.', 'اختر بداية موعد التنفيذ.', 'Kies het begin van de geplande tijd.') }
    if (!e) e = new Date(Date.parse(s) + length).toISOString()
    if (current && deadlineInstant(deadlineField(current.starts_at)) === s && deadlineInstant(deadlineField(current.ends_at)) === e) return null
    if (Date.parse(e) <= Date.parse(s)) return { error: t('The scheduled end must be after the start.', 'يجب أن تكون نهاية موعد التنفيذ بعد بدايته.', 'Het einde van de geplande tijd moet na het begin liggen.') }
    return { slot: { starts_at: s, ends_at: e } }
  }
  /** A signature of the fields, so the dialog notices unsaved changes here too. */
  const signature = `${start}|${end}`
  return { startId, current, start, end, changeStart, changeEnd, fill, saved, plan, signature }
}
export type SessionFields = ReturnType<typeof useSessionFields>

