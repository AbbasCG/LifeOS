import { createElement, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, type RecordItem, type TaskSchedule } from './api'
import { useText } from './i18n'
import { useLanguage } from '../contexts/LanguageContext'
import { useToast } from './toast'
import { isAlreadyScheduled, isNotScheduled, isSeveralSessions, newIdempotencyKey, notifyScheduleChanged, scheduleOf, sessionWhen, isolate } from './taskSchedule'
import { parseConflict, type ScheduleConflict, type Slot } from './scheduleConflict'
import { ScheduleConflictDialog } from '../components/ui/ScheduleConflictDialog'

export type { Slot }
/** The server's "already booked" answer: which task, and the session it is booked in. */
export type Conflict = { taskId: number; session: { id: number; starts_at: string; ends_at: string } | null }
/** 'overlap': the time is taken (the conflict dialog is open); 'conflict': the task already has a session (409). */
export type Outcome = 'created' | 'moved' | 'conflict' | 'overlap' | 'several' | 'missing' | 'busy' | 'failed'
/** Options of one booking. `message` replaces the success toast; `silent` also skips the toast and the list refresh (the caller does both when it is done); `onError` receives the failure text instead of a toast; `onSuggestion` makes the
 *  conflict dialog's "first free time" button hand the slot to the caller (a form that re-saves) instead of booking it at once. */
export type PlaceOptions = { message?: string; silent?: boolean; onError?: (message: string) => void; onSuggestion?: (slot: Slot) => void; sessionId?: number | null; from?: Slot | null }
type Pending = { conflict: ScheduleConflict; task: PlaceTask; kind: 'create' | 'move'; opts: PlaceOptions }
type PlaceTask = Pick<RecordItem, 'id' | 'title'> & { schedule?: TaskSchedule | null }
type Booked = { data?: { id?: number }; schedule?: TaskSchedule | null }
/** What changed, when the answer says so: lets a list show the new state at once, before it has read the server again. */
export type Change = { taskId: number; schedule?: TaskSchedule | null }

/**
 * Booking a task into the calendar, in ONE place: the task row chips, the edit dialog, the calendar's "Place" and the event dialog all use it.
 *
 *  - `place` is the single entry: a task with a session is MOVED (PUT, the same session), a task without one gets a new session (POST).
 *    `schedule` / `reschedule` are the two halves when the caller already knows which one it wants.
 *  - One request at a time per task: the guard is a ref, so even two clicks inside the same frame send one request.
 *  - One `Idempotency-Key` per user action (create and move). A retry of the same action after a dropped connection reuses it.
 *  - "Scheduled" is only said after a real 2xx. 409 "already booked" is a conflict (the row is refreshed), 422 `schedule_conflict`
 *    opens the conflict dialog (render `conflictDialog`), nothing is created or moved.
 *  - After any outcome that may have changed the bookings, the task lists and the calendar read the server again (TASKS_CHANGED + CALENDAR_CHANGED).
 *  - Undo exists for creating (removes the session) and for moving (back to the earlier time).
 */
export function useTaskScheduling({ onConflict, onChanged, onChooseTime }: { onConflict?: (conflict: Conflict) => void; onChanged?: (change: Change) => void; onChooseTime?: (taskId: number) => void } = {}) {
  /** `quiet`: the caller refreshes the lists itself, once, when everything it is saving is done. */
  const changed = (change: Change, quiet = false) => { onChanged?.(change); if (!quiet) notifyScheduleChanged() }
  const t = useText(), { language } = useLanguage(), toast = useToast()
  const [pending, setPending] = useState<number | null>(null), [overlap, setOverlap] = useState<Pending | null>(null)
  const inFlight = useRef(new Set<number>()), keys = useRef(new Map<string, string>())

  async function guarded(taskId: number, work: () => Promise<Outcome>): Promise<Outcome> {
    if (inFlight.current.has(taskId)) return 'busy'
    inFlight.current.add(taskId); setPending(taskId)
    try { return await work() } finally { inFlight.current.delete(taskId); setPending(p => (p === taskId ? null : p)) }
  }
  const undoable = (taskId: number, undo: () => Promise<unknown>, done: string, clears = false) => ({ label: t('Undo', 'تراجع', 'Ongedaan maken'), onClick: () => { void undo().then(() => { toast(done); changed(clears ? { taskId, schedule: null } : { taskId }) }).catch(e => toast((e as Error).message, 'error')) } })
  const keyFor = (intent: string) => { const key = keys.current.get(intent) ?? newIdempotencyKey(); keys.current.set(intent, key); return key }
  /** A failure that is not the server's answer (dropped connection) keeps the key, so trying again cannot book twice. */
  const settle = (intent: string, e: unknown) => { if (!(e instanceof ApiError && e.status === 0)) keys.current.delete(intent) }
  /** The failure is told once: to the caller's own place for it when it gave one (`onError`), else in a toast. */
  const say = (message: string, opts: PlaceOptions) => { if (opts.onError) opts.onError(message); else toast(message, 'error') }
  const fail = (e: unknown, opts: PlaceOptions): Outcome => { say((e as Error).message, opts); return 'failed' }
  /** The server said the time is taken: remember what was asked, refresh the row, open the dialog. */
  const taken = (conflict: ScheduleConflict, task: PlaceTask, kind: Pending['kind'], opts: PlaceOptions): Outcome => { changed({ taskId: task.id }); setOverlap({ conflict, task, kind, opts }); return 'overlap' }

  /** Book a new session for an unscheduled task. `extra` is the success message or the options. */
  const schedule = (task: PlaceTask, slot: Slot, extra?: string | PlaceOptions): Promise<Outcome> => guarded(task.id, async () => {
    const opts: PlaceOptions = typeof extra === 'string' ? { message: extra } : extra ?? {}
    const intent = `${task.id}|${slot.starts_at}|${slot.ends_at}`, key = keyFor(intent)
    try {
      const made = await api<Booked>(`/api/tasks/${task.id}/schedule`, 'POST', { starts_at: slot.starts_at, ends_at: slot.ends_at }, { 'Idempotency-Key': key })
      keys.current.delete(intent)
      const id = made.data?.id, when = sessionWhen(slot.starts_at, language, t).text
      if (!opts.silent) toast(opts.message ?? t(`“${task.title}” scheduled ${when}.`, `جُدولت «${isolate(task.title)}» ${isolate(when)}.`, `“${task.title}” ingepland ${when}.`), 'success',
        id ? undoable(task.id, () => api(`/api/events/${id}`, 'DELETE'), t('Removed from the calendar.', 'أُزيلت من التقويم.', 'Uit de agenda gehaald.'), true) : undefined)
      changed({ taskId: task.id, schedule: made.schedule ?? (id ? { session_id: id, ...slot, sessions: 1, split: false } : undefined) }, opts.silent)
      return 'created'
    } catch (e) {
      settle(intent, e)
      const overlapping = parseConflict(e)
      if (overlapping) return taken(overlapping, task, 'create', opts)
      if (isAlreadyScheduled(e)) {
        changed({ taskId: task.id })
        const s = e.data.session as Conflict['session'] | undefined
        const conflict: Conflict = { taskId: task.id, session: s && typeof s === 'object' ? s : null }
        if (onConflict) onConflict(conflict); else { const m = t('This task is already scheduled.', 'هذه المهمة مجدولة بالفعل.', 'Deze taak is al ingepland.'); say(m, opts) }
        return 'conflict'
      }
      return fail(e, opts)
    }
  })

  /** Move a task's existing session to another time. Never creates one. */
  const reschedule = (task: PlaceTask, slot: Slot, opts: PlaceOptions = {}): Promise<Outcome> => guarded(task.id, async () => {
    const body = (s: Slot) => ({ starts_at: s.starts_at, ends_at: s.ends_at, ...(opts.sessionId ? { session_id: opts.sessionId } : {}) })
    const intent = `move|${task.id}|${opts.sessionId ?? ''}|${slot.starts_at}|${slot.ends_at}`, key = keyFor(intent)
    try {
      const moved = await api<Booked>(`/api/tasks/${task.id}/schedule`, 'PUT', body(slot), { 'Idempotency-Key': key })
      keys.current.delete(intent)
      const when = sessionWhen(slot.starts_at, language, t).text, from = opts.from
      if (!opts.silent) toast(opts.message ?? t(`“${task.title}” moved to ${when}.`, `نُقلت «${isolate(task.title)}» إلى ${isolate(when)}.`, `“${task.title}” verplaatst naar ${when}.`), 'success',
        from ? undoable(task.id, () => api(`/api/tasks/${task.id}/schedule`, 'PUT', body(from)), t('Back to the earlier time.', 'أُعيدت إلى الوقت السابق.', 'Terug naar de vorige tijd.')) : undefined)
      changed({ taskId: task.id, schedule: moved?.schedule ?? (opts.sessionId ? { session_id: opts.sessionId, ...slot, sessions: 1, split: false } : undefined) }, opts.silent)
      return 'moved'
    } catch (e) {
      settle(intent, e)
      const overlapping = parseConflict(e)
      if (overlapping) return taken(overlapping, task, 'move', opts)
      if (isSeveralSessions(e)) { changed({ taskId: task.id }); const m = t('This task has several sessions. Choose which one to move.', 'لهذه المهمة عدة جلسات. اختر الجلسة التي تريد نقلها.', 'Deze taak heeft meerdere sessies. Kies welke je wilt verplaatsen.'); say(m, opts); return 'several' }
      if (isNotScheduled(e)) { changed({ taskId: task.id }); const m = t('This task is not scheduled yet.', 'هذه المهمة غير مجدولة بعد.', 'Deze taak is nog niet ingepland.'); say(m, opts); return 'missing' }
      return fail(e, opts)
    }
  })

  /** THE way to set a task's execution time: moves its session when it has one (task.schedule), else books a new one. */
  const place = (task: PlaceTask, slot: Slot, opts: PlaceOptions = {}): Promise<Outcome> => {
    const current = scheduleOf(task)
    return current ? reschedule(task, slot, { sessionId: current.session_id, from: { starts_at: current.starts_at, ends_at: current.ends_at }, ...opts }) : schedule(task, slot, opts)
  }

  const applySuggestion = (p: Pending, slot: Slot) => {
    setOverlap(null)
    if (p.opts.onSuggestion) { p.opts.onSuggestion(slot); return }
    void (p.kind === 'move' ? reschedule(p.task, slot, p.opts) : schedule(p.task, slot, p.opts))
  }
  // The handlers only read refs when they run (a click), never while rendering.
  // eslint-disable-next-line react-hooks/refs
  const conflictDialog: ReactNode = overlap ? createElement(ScheduleConflictDialog, {
    key: overlap.conflict.requested.starts_at, conflict: overlap.conflict,
    onChoose: () => onChooseTime?.(overlap.task.id), onClose: () => setOverlap(null),
    onUseSuggestion: slot => applySuggestion(overlap, slot),
  }) : null

  return { pending, schedule, reschedule, place, conflictDialog }
}
