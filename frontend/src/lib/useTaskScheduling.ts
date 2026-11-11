import { useRef, useState } from 'react'
import { api, ApiError, type RecordItem, type TaskSchedule } from './api'
import { useText } from './i18n'
import { useLanguage } from '../contexts/LanguageContext'
import { useToast } from './toast'
import { isAlreadyScheduled, isNotScheduled, isSeveralSessions, newIdempotencyKey, notifyScheduleChanged, sessionWhen, isolate } from './taskSchedule'

export type Slot = { starts_at: string; ends_at: string }
/** The server's "already booked" answer: which task, and the session it is booked in. */
export type Conflict = { taskId: number; session: { id: number; starts_at: string; ends_at: string } | null }
export type Outcome = 'created' | 'moved' | 'conflict' | 'several' | 'missing' | 'busy' | 'failed'
type Booked = { data?: { id?: number }; schedule?: TaskSchedule | null }
/** What changed, when the answer says so: lets a list show the new state at once, before it has read the server again. */
export type Change = { taskId: number; schedule?: TaskSchedule | null }

/**
 * Booking a task into the calendar, in one place (the task list, the calendar's "Place" and the event dialog all use it).
 *
 *  - One request at a time per task: the guard is a ref, so even two clicks inside the same frame send one request.
 *  - One `Idempotency-Key` per user action. A retry of the same action (after a dropped connection) reuses it, so the server
 *    answers with the session it already made instead of making another.
 *  - "Scheduled" is only said when the server created (201) or confirmed (200) a session. The server's 409 "already booked"
 *    is a conflict, never a success.
 *  - After any outcome that may have changed the bookings, the task lists and the calendar read the server again.
 */
export function useTaskScheduling({ onConflict, onChanged }: { onConflict?: (conflict: Conflict) => void; onChanged?: (change: Change) => void } = {}) {
  const changed = (change: Change) => { onChanged?.(change); notifyScheduleChanged() }
  const t = useText(), { language } = useLanguage(), toast = useToast()
  const [pending, setPending] = useState<number | null>(null)
  const inFlight = useRef(new Set<number>()), keys = useRef(new Map<string, string>())

  async function guarded(taskId: number, work: () => Promise<Outcome>): Promise<Outcome> {
    if (inFlight.current.has(taskId)) return 'busy'
    inFlight.current.add(taskId); setPending(taskId)
    try { return await work() } finally { inFlight.current.delete(taskId); setPending(p => (p === taskId ? null : p)) }
  }
  const undoable = (taskId: number, undo: () => Promise<unknown>, done: string, clears = false) => ({ label: t('Undo', 'تراجع', 'Ongedaan maken'), onClick: () => { void undo().then(() => { toast(done); changed(clears ? { taskId, schedule: null } : { taskId }) }).catch(e => toast((e as Error).message, 'error')) } })

  /** Book a new session for an unscheduled task. */
  const schedule = (task: Pick<RecordItem, 'id' | 'title'>, slot: Slot, message?: string): Promise<Outcome> => guarded(task.id, async () => {
    const intent = `${task.id}|${slot.starts_at}|${slot.ends_at}`, key = keys.current.get(intent) ?? newIdempotencyKey()
    keys.current.set(intent, key)
    try {
      const made = await api<Booked>(`/api/tasks/${task.id}/schedule`, 'POST', { starts_at: slot.starts_at, ends_at: slot.ends_at }, { 'Idempotency-Key': key })
      keys.current.delete(intent)
      const id = made.data?.id, when = sessionWhen(slot.starts_at, language, t).text
      toast(message ?? t(`“${task.title}” scheduled ${when}.`, `جُدولت «${isolate(task.title)}» ${isolate(when)}.`, `“${task.title}” ingepland ${when}.`), 'success',
        id ? undoable(task.id, () => api(`/api/events/${id}`, 'DELETE'), t('Removed from the calendar.', 'أُزيلت من التقويم.', 'Uit de agenda gehaald.'), true) : undefined)
      changed({ taskId: task.id, schedule: made.schedule })
      return 'created'
    } catch (e) {
      if (isAlreadyScheduled(e)) {
        keys.current.delete(intent); changed({ taskId: task.id })
        const s = e.data.session as Conflict['session'] | undefined
        const conflict: Conflict = { taskId: task.id, session: s && typeof s === 'object' ? s : null }
        if (onConflict) onConflict(conflict); else toast(t('This task is already scheduled.', 'هذه المهمة مجدولة بالفعل.', 'Deze taak is al ingepland.'), 'error')
        return 'conflict'
      }
      // A dropped connection keeps the key, so trying again cannot book twice; any answer from the server ends this action.
      if (!(e instanceof ApiError && e.status === 0)) keys.current.delete(intent)
      toast((e as Error).message, 'error')
      return 'failed'
    }
  })

  /** Move a task's existing session to another time. Never creates one. */
  const reschedule = (task: Pick<RecordItem, 'id' | 'title'>, slot: Slot, opts: { sessionId?: number | null; from?: Slot | null } = {}): Promise<Outcome> => guarded(task.id, async () => {
    const body = (s: Slot) => ({ starts_at: s.starts_at, ends_at: s.ends_at, ...(opts.sessionId ? { session_id: opts.sessionId } : {}) })
    try {
      const moved = await api<Booked>(`/api/tasks/${task.id}/schedule`, 'PUT', body(slot))
      const when = sessionWhen(slot.starts_at, language, t).text, from = opts.from
      toast(t(`“${task.title}” moved to ${when}.`, `نُقلت «${isolate(task.title)}» إلى ${isolate(when)}.`, `“${task.title}” verplaatst naar ${when}.`), 'success',
        from ? undoable(task.id, () => api(`/api/tasks/${task.id}/schedule`, 'PUT', body(from)), t('Back to the earlier time.', 'أُعيدت إلى الوقت السابق.', 'Terug naar de vorige tijd.')) : undefined)
      changed({ taskId: task.id, schedule: moved?.schedule })
      return 'moved'
    } catch (e) {
      if (isSeveralSessions(e)) { changed({ taskId: task.id }); toast(t('This task has several sessions. Choose which one to move.', 'لهذه المهمة عدة جلسات. اختر الجلسة التي تريد نقلها.', 'Deze taak heeft meerdere sessies. Kies welke je wilt verplaatsen.'), 'error'); return 'several' }
      if (isNotScheduled(e)) { changed({ taskId: task.id }); toast(t('This task is not scheduled yet.', 'هذه المهمة غير مجدولة بعد.', 'Deze taak is nog niet ingepland.'), 'error'); return 'missing' }
      toast((e as Error).message, 'error')
      return 'failed'
    }
  })

  return { pending, schedule, reschedule }
}
