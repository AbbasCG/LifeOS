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

function parts(at: Date, timeZone?: string) {
  const out: Record<string, number> = {}
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(at)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return out
}
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

/** The instant (ISO, UTC) at which the wall clock in the account's timezone reads `hour:00` on `day`. */
export function accountInstant(day: string, hour: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const wanted = Date.UTC(y, m - 1, d, hour)
  if (!zone) return new Date(y, m - 1, d, hour).toISOString()
  // Start from the wanted time read as UTC, then correct by the zone's offset at that moment (twice, for DST edges).
  let guess = wanted
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess), zone)
    guess += wanted - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  }
  return new Date(guess).toISOString()
}
