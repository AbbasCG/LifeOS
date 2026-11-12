import { ApiError } from './api'
import { durationWords, displayZone, sessionWhen } from './taskSchedule'
import { formatClock } from './clock'

/**
 * The server refuses a booking that overlaps something the user already has (HTTP 422) and says what and when:
 * `{ message, errors, conflict: { code: 'schedule_conflict', requested, conflicts: [..], suggestion } }` (ISO UTC).
 * This file only reads that answer and words it; the dialog is components/ui/ScheduleConflictDialog.tsx.
 */
export type Slot = { starts_at: string; ends_at: string }
export type ConflictItem = {
  id: number | null; event_id: number | null; task_id: number | null; title: string
  kind: 'task_session' | 'event' | 'external'; source?: string | null
  starts_at: string; ends_at: string; overlap_minutes: number
}
export type ScheduleConflict = { requested: Slot; conflicts: ConflictItem[]; suggestion: Slot | null }

type Words = (en: string, ar: string, nl?: string) => string
const valid = (iso: unknown): iso is string => typeof iso === 'string' && !Number.isNaN(Date.parse(iso))
const slotOf = (v: unknown): Slot | null => {
  const s = v as Partial<Slot> | null
  return s && typeof s === 'object' && valid(s.starts_at) && valid(s.ends_at) ? { starts_at: s.starts_at, ends_at: s.ends_at } : null
}

/** Is this error the server's "that time is taken" answer? Returns it in a safe shape, else null (any other error). */
export function parseConflict(error: unknown): ScheduleConflict | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null
  const raw = error.data?.conflict as { code?: unknown; requested?: unknown; conflicts?: unknown; suggestion?: unknown } | undefined
  if (!raw || typeof raw !== 'object' || raw.code !== 'schedule_conflict') return null
  const requested = slotOf(raw.requested)
  const conflicts: ConflictItem[] = (Array.isArray(raw.conflicts) ? raw.conflicts : []).slice(0, 5).flatMap((c: Partial<ConflictItem>) => {
    const slot = slotOf(c)
    if (!slot || !c) return []
    const kind = c.kind === 'event' || c.kind === 'external' ? c.kind : 'task_session'
    return [{ id: typeof c.id === 'number' ? c.id : null, event_id: typeof c.event_id === 'number' ? c.event_id : null, task_id: typeof c.task_id === 'number' ? c.task_id : null,
      title: typeof c.title === 'string' ? c.title : '', kind, source: typeof c.source === 'string' ? c.source : null, ...slot, overlap_minutes: Math.max(0, Math.round(Number(c.overlap_minutes) || 0)) }]
  })
  if (!requested || conflicts.length === 0) return null
  return { requested, conflicts, suggestion: slotOf(raw.suggestion) }
}

const clock = (iso: string, language: string, zone: string) => formatClock(iso, { language, timeZone: zone })
/** "09:15–09:45" (24-hour, the account's zone). */
export const rangeText = (s: Slot, language: string, zone = displayZone()) => `${clock(s.starts_at, language, zone)}–${clock(s.ends_at, language, zone)}`

/** «هذا الوقت محجوز بالفعل لمهمة أخرى.»: neutral wording when anything other than a task is in the way. */
export function conflictTitle(c: ScheduleConflict, t: Words): string {
  return c.conflicts.every(i => i.kind === 'task_session')
    ? t('This time is already booked for another task.', 'هذا الوقت محجوز بالفعل لمهمة أخرى.', 'Deze tijd is al gereserveerd voor een andere taak.')
    : t('This time is already booked for another task or event.', 'هذا الوقت محجوز بالفعل لمهمة أو موعد آخر.', 'Deze tijd is al gereserveerd voor een andere taak of afspraak.')
}

/** "You can't schedule this task from 09:15 to 09:45, because you have another task from 09:00 to 09:30." (plain text, times in 24h). */
export function conflictSentence(c: ScheduleConflict, t: Words, language: string, zone = displayZone()): string {
  const first = c.conflicts[0], at = (s: Slot) => ({ a: clock(s.starts_at, language, zone), b: clock(s.ends_at, language, zone) })
  const r = at(c.requested), o = at(first)
  const task = first.kind === 'task_session'
  const other = c.conflicts.length > 1 ? t('other items', 'عناصر أخرى', 'andere items') : null
  return t(
    `You can't schedule this task from ${r.a} to ${r.b}, because you already have ${other ? other : task ? 'another task' : 'another event'} from ${o.a} to ${o.b}.`,
    `لا يمكن جدولة هذه المهمة من ${r.a} إلى ${r.b}، لأن لديك ${other ? other : task ? 'مهمة أخرى' : 'موعدًا آخر'} من ${o.a} إلى ${o.b}.`,
    `Je kunt deze taak niet inplannen van ${r.a} tot ${r.b}, omdat je al ${other ? other : task ? 'een andere taak' : 'een andere afspraak'} hebt van ${o.a} tot ${o.b}.`)
}

/** "15 min overlap" / «تداخل 15 دقيقة». */
export const overlapText = (minutes: number, t: Words) => {
  const d = durationWords(minutes, t)
  return t(`${d} overlap`, `تداخل ${d}`, `${d} overlap`)
}
/** "Tomorrow" / "Thu, 12 Nov": the day of an instant, in the account's zone. */
export const conflictDay = (iso: string, t: Words, language: string, zone = displayZone()) => sessionWhen(iso, language, t, new Date(), zone).dayText
