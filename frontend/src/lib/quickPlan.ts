import { accountDay, shiftDay } from './accountDay'
import type { CaptureReading } from './capture'
import { deadlineField } from './quickAdd'
import { bookingOf, defaultWhen, DEFAULT_DURATION, type Booking } from './taskWhen'

/** What Quick Add's day tiles hold: «not scheduled» (the default: nothing is created automatically), today, tomorrow, or a picked day. */
export type QuickDay = 'none' | 'today' | 'tomorrow' | 'custom'

/** The booking Quick Add will make: the day, the start and the end on the account's clock, and the two instants. */
export type QuickPlan = Booking & { day: string; start: string; minutes: number }

/**
 * Where a quick-added task goes in the calendar. A day AND time in the phrase ("tomorrow at 7pm") win over the tile; otherwise the tile's day
 * starts at the dialog's default (the next half hour today, never in the past, 09:00 on any other day), with the length the phrase gave (30
 * by default). 'none' (or a picked day that is not set yet) books nothing: null. The deadline is never involved.
 */
export function quickPlan(read: CaptureReading, choice: QuickDay, picked: string, now = new Date(), override?: string): QuickPlan | null {
  const minutes = Number(read.task.estimated_minutes) || DEFAULT_DURATION
  const field = (iso: string) => { const f = deadlineField(iso); return { day: f.slice(0, 10), start: f.slice(11, 16) } }
  const fixed = override ?? read.task.schedule?.starts_at
  if (fixed) {
    const booking = bookingOf(field(fixed).day, field(fixed).start, minutes, fixed)
    return booking && { ...booking, ...field(fixed), minutes }
  }
  const today = accountDay(now), day = choice === 'today' ? today : choice === 'tomorrow' ? shiftDay(today, 1) : choice === 'custom' ? picked : ''
  if (!day) return null
  const when = defaultWhen(day, now), booking = bookingOf(when.day, when.start, minutes)
  return booking && { ...booking, ...when, minutes }
}
