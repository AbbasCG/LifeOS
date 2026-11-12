import { ApiError, type CalendarOccurrence } from './api'
import { parseConflict, type ScheduleConflict, type Slot } from './scheduleConflict'
import { findConflict } from './calendar'

/**
 * Was this request refused because the time is taken? Returns what the conflict dialog needs, else null (any other failure).
 *
 * The server's structured answer (`conflict`, see parseConflict) is used when it is there. An answer without it (an older server) is a
 * plain 422 on `starts_at`; it is then explained from the calendar the page already holds: `known` are the occurrences as REAL instants
 * and `requested` is the slot that was asked for, so the dialog can still name the item in the way. No suggestion is invented in that case.
 */
export function refusalOf(error: unknown, requested: Slot, known: CalendarOccurrence[], ownEventId?: number | null): ScheduleConflict | null {
  const parsed = parseConflict(error)
  if (parsed) return parsed
  if (!(error instanceof ApiError) || error.status !== 422 || !error.errors?.starts_at) return null
  const start = new Date(requested.starts_at), end = new Date(requested.ends_at)
  const hit = findConflict(known.filter(i => ownEventId == null || i.event_id !== ownEventId), undefined, start, end)
  if (!hit) return null
  const overlap = Math.round((Math.min(end.getTime(), Date.parse(hit.ends_at)) - Math.max(start.getTime(), Date.parse(hit.starts_at))) / 60000)
  return {
    requested,
    conflicts: [{ id: hit.event_id, event_id: hit.event_id, task_id: hit.task_id ?? null, title: hit.title, kind: hit.source !== 'lifeos' ? 'external' : hit.task_id ? 'task_session' : 'event', source: hit.source,
      starts_at: hit.starts_at, ends_at: hit.ends_at, overlap_minutes: Math.max(0, overlap) }],
    suggestion: null,
  }
}
