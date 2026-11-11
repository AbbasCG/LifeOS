/**
 * The one place that turns an instant into a clock time for display. LifeOS shows a 24-hour clock everywhere a session or
 * event time appears: 08:00, 13:00, 17:45, 00:00 (never 12-hour, never AM/PM, never "24:00" for midnight).
 *
 * - Built on Intl with hourCycle 'h23' (hour12:false would print 24:00 at midnight in en-US) and read back through
 *   formatToParts, so the text is two digits, a colon and two digits in every language.
 * - Latin digits in Arabic too (locale tag 'ar-u-nu-latn') — the same «09:00» as in English and Dutch.
 * - The timezone is explicit when given (the account's zone: see accountZone()); with none, the browser's own zone is used,
 *   which is what the calendar grid wants (its dates are already shifted into the chosen zone).
 * - Display only. Stored values and API payloads are never produced here.
 * - Bidi: the result is plain text. Inside an Arabic sentence, wrap it with isolate() from taskSchedule or <bdi>.
 *
 * `CLOCK_HOUR_CYCLE` is the central setting: if a 12-hour option ever returns, it changes here (and in
 * dateTime.preferredHourCycle for the picker), not at each call site.
 */
export const CLOCK_HOUR_CYCLE = 'h23' as const

export type ClockOptions = { language?: string; timeZone?: string }
type Instant = Date | string | number

/** BCP-47 tag for a LifeOS language, always with Latin digits. */
export const clockLocale = (language?: string) => language === 'ar' ? 'ar-u-nu-latn' : language === 'nl' ? 'nl-NL-u-nu-latn' : 'en-u-nu-latn'

const cache = new Map<string, Intl.DateTimeFormat>()
function formatter(locale: string, key: string, options: Intl.DateTimeFormatOptions) {
  const id = `${locale}|${key}|${options.timeZone ?? ''}`
  let f = cache.get(id)
  if (!f) { f = new Intl.DateTimeFormat(locale, options); cache.set(id, f) }
  return f
}
const toDate = (at: Instant) => at instanceof Date ? at : new Date(at)
const safeZone = (timeZone?: string) => {
  if (!timeZone) return undefined
  try { new Intl.DateTimeFormat('en', { timeZone }); return timeZone } catch { return undefined }
}

/** "08:00", "13:00", "00:00", "23:59" — or '' for an invalid date. */
export function formatClock(at: Instant, { timeZone }: ClockOptions = {}): string {
  const date = toDate(at)
  if (Number.isNaN(date.getTime())) return ''
  const f = formatter('en-US-u-nu-latn', 'clock', { hour: '2-digit', minute: '2-digit', hourCycle: CLOCK_HOUR_CYCLE, timeZone: safeZone(timeZone) })
  const parts = f.formatToParts(date)
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0) % 24, minute = Number(parts.find(p => p.type === 'minute')?.value ?? 0)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** "09:00 – 09:30". */
export const formatClockRange = (from: Instant, to: Instant, opts: ClockOptions = {}) => `${formatClock(from, opts)} – ${formatClock(to, opts)}`

/** The day part only, in the language, in the zone ("Thu, 12 Nov"). `style` overrides the default short weekday/day/month. */
export function formatDayText(at: Instant, { language, timeZone }: ClockOptions = {}, style: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  const date = toDate(at)
  if (Number.isNaN(date.getTime())) return ''
  return formatter(clockLocale(language), JSON.stringify(style), { ...style, timeZone: safeZone(timeZone) }).format(date)
}

/** "Thu, 12 Nov 09:00" — a short day and the 24-hour time. Pass `style` for more or less of the date. */
export function formatDayTime(at: Instant, opts: ClockOptions = {}, style?: Intl.DateTimeFormatOptions): string {
  return `${formatDayText(at, opts, style)} ${formatClock(at, opts)}`.trim()
}

/** "Thursday 12 November 2026, 09:00" — the long form for a tooltip or a screen reader. */
export const formatFullDayTime = (at: Instant, opts: ClockOptions = {}) =>
  `${formatDayText(at, opts, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${formatClock(at, opts)}`

/** "12 Nov 2026, 09:00" — a medium date and the time (replaces dateStyle 'medium' + timeStyle 'short'). */
export const formatMediumDateTime = (at: Instant, opts: ClockOptions = {}) =>
  `${formatDayText(at, opts, { day: 'numeric', month: 'short', year: 'numeric' })}, ${formatClock(at, opts)}`
