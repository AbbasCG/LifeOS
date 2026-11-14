import { accountDay, shiftDay } from './accountDay'
import type { CaptureReading } from './capture'
import { deadlineField, deadlineInstant } from './quickAdd'
import { bookingOf, defaultWhen, DEFAULT_DURATION, type Booking } from './taskWhen'

/** What Quick Add's day tiles hold: «not scheduled» (the default: nothing is created automatically), today, tomorrow, or a picked day. */
export type QuickDay = 'none' | 'today' | 'tomorrow' | 'custom'

/** The booking Quick Add will make: the day, the start and the end on the account's clock, and the two instants. */
export type QuickPlan = Booking & { day: string; start: string; minutes: number }

/** `plan`: the booking, or null (nothing to book). `passed`: the 'HH:mm' of a time the phrase asked for that has already gone by (then nothing is booked and the task is added without a time). */
export type QuickResult = { plan: QuickPlan | null; passed: string | null }

/**
 * Where a quick-added task goes in the calendar. A day AND time in the phrase ("tomorrow at 7pm") win over the tile. A time with no day
 * word ("call the dentist at 3pm") is on the tile's day (today when nothing is chosen). With no time, the tile's day starts at the dialog's
 * default (the next half hour today, never in the past, 09:00 on any other day), with the length the phrase gave (30 by default). 'none'
 * (or a picked day that is not set yet) books nothing. A start that is not in the future is never booked (`passed`). The deadline is never involved.
 */
export function quickPlan(read: CaptureReading, choice: QuickDay, picked: string, now = new Date(), override?: string): QuickResult {
  const minutes = Number(read.task.estimated_minutes) || DEFAULT_DURATION
  const field = (iso: string) => { const f = deadlineField(iso); return { day: f.slice(0, 10), start: f.slice(11, 16) } }
  const today = accountDay(now), tileDay = choice === 'today' ? today : choice === 'tomorrow' ? shiftDay(today, 1) : choice === 'custom' ? picked : ''
  let fixed = override ?? read.task.schedule?.starts_at
  if (!override && read.time && !read.hasDay) fixed = deadlineInstant(`${tileDay || today}T${read.time}`) ?? undefined
  if (fixed) {
    const at = field(fixed)
    if (Date.parse(fixed) <= now.getTime()) return { plan: null, passed: at.start }
    const booking = bookingOf(at.day, at.start, minutes, fixed)
    return { plan: booking && { ...booking, ...at, minutes }, passed: null }
  }
  if (!tileDay) return { plan: null, passed: null }
  const when = defaultWhen(tileDay, now), booking = bookingOf(when.day, when.start, minutes)
  return { plan: booking && { ...booking, ...when, minutes }, passed: null }
}
