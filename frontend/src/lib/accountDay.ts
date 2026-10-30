/**
 * "Today" in the account's own timezone (V27).
 *
 * The server plans and validates days in the timezone saved in the account's settings, while the browser's clock may
 * be in another zone. Between midnight in one zone and midnight in the other, the browser's idea of "today" is a day
 * off from the server's, and the server rejects it (or files the work under the wrong day). Everything the app sends
 * or compares as "today" goes through here instead. When the zone is not known yet, or this browser doesn't know it,
 * the browser's own day is used, as before.
 */
let zone: string | undefined

const known = (name: string) => { try { new Intl.DateTimeFormat('en', { timeZone: name }); return true } catch { return false } }

/** Set from the account's settings after sign-in, and again when the timezone is saved. */
export function setAccountZone(name?: string | null) { zone = name && known(name) ? name : undefined }
export const accountZone = () => zone

/** Wall-clock parts of an instant in a timezone (the browser's own when none is given). */
export function zonedParts(at: Date, timeZone?: string) {
  const out: Record<string, number> = {}
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(at)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return out
}
const parts = zonedParts
const pad = (n: number) => String(n).padStart(2, '0')

/** YYYY-MM-DD of an instant, in the account's timezone (the browser's when unknown). */
export function accountDay(at = new Date()): string {
  const p = parts(at, zone)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** Calendar arithmetic on a YYYY-MM-DD day, independent of any timezone. */
export function shiftDay(day: string, amount: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + amount))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** Weekday (0 = Sunday) of a YYYY-MM-DD day. */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** The instant at which the wall clock in `timeZone` reads this date and time (the browser's own zone when none is given). */
export function wallClockToInstant(y: number, m: number, d: number, h: number, mi: number, sec: number, timeZone?: string): Date {
  if (!timeZone) return new Date(y, m - 1, d, h, mi, sec)
  const wanted = Date.UTC(y, m - 1, d, h, mi, sec)
  // Start from the wanted time read as UTC, then correct by the zone's offset at that moment (twice, for DST edges).
  let guess = wanted
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), timeZone)
    guess += wanted - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  }
  return new Date(guess)
}

/** The instant (ISO, UTC) at which the wall clock in the account's timezone reads `hour:00` on `day`. */
export function accountInstant(day: string, hour: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return wallClockToInstant(y, m, d, hour, 0, 0, zone).toISOString()
}

/** Offset from UTC, in minutes, of a timezone at an instant (the browser's own when none is given). */
export function offsetMinutes(at: Date, timeZone?: string): number {
  const p = zonedParts(at, timeZone)
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000) / 60000)
}
