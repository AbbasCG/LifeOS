import type { Availability } from './api'
import { accountDay, accountZone, shiftDay } from './accountDay'
import { formatClock } from './clock'

/**
 * Where a task could go in the calendar: the first free stretch long enough for it on each of the next days, taken from the
 * server's own free-time answer (working hours, minus what is already booked). Nothing is booked from here; a slot is only
 * a suggestion until it is tapped.
 */
export type FreeSlot = { starts_at: string; ends_at: string; day: string }

const QUARTER = 15 * 60_000

/** One slot per working day, at most `limit` of them, starting no earlier than the next quarter hour. */
export function suggestSlots(availability: Availability | null | undefined, minutes: number, now = new Date(), limit = 3): FreeSlot[] {
  if (!availability) return []
  const length = Math.max(15, minutes) * 60_000, earliest = Math.ceil(now.getTime() / QUARTER) * QUARTER
  const found: FreeSlot[] = []
  for (const day of availability.days ?? []) {
    if (!day.work_day) continue
    for (const slot of day.slots) {
      const start = Math.max(Date.parse(slot.starts_at), earliest), end = Date.parse(slot.ends_at)
      if (end - start >= length) { found.push({ starts_at: new Date(start).toISOString(), ends_at: new Date(start + length).toISOString(), day: day.date }); break }
    }
    if (found.length >= limit) break
  }
  return found
}

/** "Today 15:30", "Tomorrow 09:00", "Thu 09:00": the day in the account's calendar and the time in its timezone. */
export function slotWords(slot: FreeSlot, language: string, t: (en: string, ar: string, nl?: string) => string, now = new Date()): string {
  const today = accountDay(now)
  const time = formatClock(slot.starts_at, { language, timeZone: accountZone() })
  const day = slot.day === today ? t('Today', 'اليوم', 'Vandaag') : slot.day === shiftDay(today, 1) ? t('Tomorrow', 'غدًا', 'Morgen')
    : new Date(`${slot.day}T12:00:00Z`).toLocaleDateString(language === 'ar' ? 'ar' : language === 'nl' ? 'nl-NL' : 'en', { weekday: 'short', timeZone: 'UTC' })
  return `${day} ${time}`
}
