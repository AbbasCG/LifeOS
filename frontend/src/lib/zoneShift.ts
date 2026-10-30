import { offsetMinutes, wallClockToInstant, zonedParts } from './accountDay'

/**
 * Showing a calendar in another timezone (V29). The calendar grid is built from the browser's local time, so to draw
 * it in the account's timezone, every instant is *shifted*: a Date whose browser-local wall clock reads what the wall
 * clock reads in the chosen zone. All the grid arithmetic (positions, drags, labels) then works unchanged, and
 * anything sent to the server is shifted back. With no zone, nothing is shifted.
 */
export type ZoneShift = {
  zone?: string
  /** A real instant, as the Date the grid should draw. */
  viewDate: (instant: Date) => Date
  /** A drawn Date, as the real instant it stands for. */
  realDate: (drawn: Date) => Date
  /** Same as viewDate / realDate for ISO strings. */
  toView: (iso: string) => string
  toReal: (iso: string) => string
}

export function makeShift(zone?: string): ZoneShift {
  if (!zone) {
    const same = <T,>(x: T) => x
    return { zone, viewDate: d => new Date(d), realDate: d => new Date(d), toView: same, toReal: same }
  }
  const viewDate = (instant: Date) => {
    const p = zonedParts(instant, zone)
    return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, instant.getMilliseconds())
  }
  const realDate = (drawn: Date) => {
    const real = wallClockToInstant(drawn.getFullYear(), drawn.getMonth() + 1, drawn.getDate(), drawn.getHours(), drawn.getMinutes(), drawn.getSeconds(), zone)
    return new Date(real.getTime() + drawn.getMilliseconds())
  }
  return { zone, viewDate, realDate, toView: iso => viewDate(new Date(iso)).toISOString(), toReal: iso => realDate(new Date(iso)).toISOString() }
}

/** True when drawing in `zone` instead of the browser's own would change what is shown (now or in half a year). */
export function zonesDiffer(zone: string | undefined, now = new Date()): boolean {
  if (!zone) return false
  const later = new Date(now.getTime() + 182 * 86_400_000)
  return offsetMinutes(now, zone) !== offsetMinutes(now) || offsetMinutes(later, zone) !== offsetMinutes(later)
}
