/**
 * Date and time helpers for the app's own picker. Dates are 'YYYY-MM-DD', times 'HH:mm' (24 hours), date-times 'YYYY-MM-DDTHH:mm' —
 * the same strings the native inputs used, so forms keep sending exactly what they sent before. Everything is plain calendar maths
 * (no time zone), so the picker never shifts a day.
 */
export type HourCycle = 12 | 24

const pad = (n: number) => String(n).padStart(2, '0')
export const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export function parseDay(value: string): { y: number; m: number; d: number } | null {
  const match = DATE_RE.exec(value)
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const real = new Date(Date.UTC(y, m - 1, d))
  return real.getUTCFullYear() === y && real.getUTCMonth() === m - 1 && real.getUTCDate() === d ? { y, m, d } : null
}
export const dayKey = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`
const fromUtc = (date: Date) => dayKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
export function addDays(day: string, amount: number): string {
  const p = parseDay(day)
  return p ? fromUtc(new Date(Date.UTC(p.y, p.m - 1, p.d + amount))) : day
}
export function addMonths(day: string, amount: number): string {
  const p = parseDay(day)
  if (!p) return day
  const target = new Date(Date.UTC(p.y, p.m - 1 + amount, 1))
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  return dayKey(target.getUTCFullYear(), target.getUTCMonth() + 1, Math.min(p.d, last))
}
/** 0 = Monday ... 6 = Sunday (the app's weeks start on Monday). */
export const weekdayIndex = (day: string) => { const p = parseDay(day); return p ? (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7 : 0 }

/** The six weeks (42 days) shown for the month that contains `day`, starting on a Monday. */
export function monthGrid(day: string): { day: string; inMonth: boolean }[] {
  const p = parseDay(day)
  if (!p) return []
  const first = dayKey(p.y, p.m, 1)
  const start = addDays(first, -weekdayIndex(first))
  return Array.from({ length: 42 }, (_, i) => { const d = addDays(start, i); return { day: d, inMonth: d.slice(0, 7) === first.slice(0, 7) } })
}

export const clampDay = (day: string, min?: string, max?: string) => (min && day < min ? min : max && day > max ? max : day)

export function splitDateTime(value: string): { date: string; time: string } {
  const [date = '', time = ''] = value.split('T')
  return { date: parseDay(date) ? date : '', time: TIME_RE.test(time.slice(0, 5)) ? time.slice(0, 5) : '' }
}
export const joinDateTime = (date: string, time: string) => `${date}T${time || '09:00'}`

export const toMinutes = (time: string) => { const m = TIME_RE.exec(time); return m ? Number(m[1]) * 60 + Number(m[2]) : null }
export const timeOf = (minutes: number) => { const m = ((Math.round(minutes) % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}` }

/** 24-hour 'HH:mm' to the parts shown on a 12-hour clock. */
export function to12(time: string): { hour: number; minute: number; pm: boolean } {
  const m = toMinutes(time) ?? 0, h = Math.floor(m / 60)
  return { hour: h % 12 === 0 ? 12 : h % 12, minute: m % 60, pm: h >= 12 }
}
export function from12(hour: number, minute: number, pm: boolean): string {
  return `${pad((hour % 12) + (pm ? 12 : 0))}:${pad(minute)}`
}

/** What a person may type: "14:30", "1430", "2:30pm", "2.30 م", "9" ... Returns 'HH:mm' (24 hours), or null when it is not a time. */
export function parseTimeInput(text: string): string | null {
  const raw = text.trim().toLowerCase().replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
  const match = /^(\d{1,2})(?:[:.٫]?(\d{2}))?\s*(a\.?m?\.?|p\.?m?\.?|ص|م)?$/.exec(raw)
  if (!match) return null
  const hour = Number(match[1]), minute = Number(match[2] ?? 0), period = match[3]
  if (minute > 59) return null
  if (period) return hour < 1 || hour > 12 ? null : from12(hour, minute, period.startsWith('p') || period === 'م')
  return hour > 23 ? null : `${pad(hour)}:${pad(minute)}`
}

const KEY = 'lifeos-hour-cycle'
export const HOUR_CYCLE_CHANGED = 'lifeos:hour-cycle'
/** 12 or 24 hours: the person's own choice if they made one, else what their language and region use. */
export function preferredHourCycle(language: string): HourCycle {
  try { const saved = localStorage.getItem(KEY); if (saved === '12' || saved === '24') return Number(saved) as HourCycle } catch { /* storage unavailable */ }
  try { return new Intl.DateTimeFormat(language, { hour: 'numeric' }).resolvedOptions().hour12 ? 12 : 24 } catch { return 24 }
}
export function saveHourCycle(cycle: HourCycle) {
  try { localStorage.setItem(KEY, String(cycle)) } catch { /* kept for this visit only */ }
  window.dispatchEvent(new Event(HOUR_CYCLE_CHANGED))
}

export function formatTime(time: string, cycle: HourCycle, language: string): string {
  const m = toMinutes(time)
  if (m === null) return ''
  const date = new Date(Date.UTC(2000, 0, 1, Math.floor(m / 60), m % 60))
  return new Intl.DateTimeFormat(language, { hour: cycle === 12 ? 'numeric' : '2-digit', minute: '2-digit', hour12: cycle === 12, timeZone: 'UTC' }).format(date)
}
export function formatDay(day: string, language: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  const p = parseDay(day)
  return p ? new Intl.DateTimeFormat(language, { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(p.y, p.m - 1, p.d))) : ''
}
