import { accountDay, accountInstant, accountZone, shiftDay, wallClockToInstant, weekdayOf, zonedParts } from './accountDay'

/** Ask the app shell to open Quick Add (from the topbar, the bottom bar, a shortcut or an empty state). */
export const QUICK_ADD = 'lifeos:quick-add'
/** Fired after Quick Add saved a task, so lists and Today can refresh. */
export const TASKS_CHANGED = 'lifeos:tasks-changed'
export const openQuickAdd = () => window.dispatchEvent(new Event(QUICK_ADD))
/** Opens Quick add already listening, so a task is two taps: the microphone, then Add. */
export const openQuickAddByVoice = () => window.dispatchEvent(new CustomEvent(QUICK_ADD, { detail: { voice: true } }))

export type When = 'today' | 'tomorrow' | 'week' | 'nextweek' | 'none'
/** What the Quick Add date tiles hold: one of the quick choices, or a day picked on the calendar. */
export type QuickWhen = When | 'custom'
export type Priority = 'urgent' | 'high' | 'medium' | 'low'

/** The coming Monday as a day ('YYYY-MM-DD') in the account's calendar; a Monday asks for the one after it. */
export function nextWeekDay(now = new Date()): string {
  const today = accountDay(now)
  return shiftDay(today, ((8 - weekdayOf(today)) % 7) || 7)
}

/** Due date for a quick choice: 17:00 today (23:00 once 17:00 has passed) or 17:00 tomorrow, Sunday 17:00 for "this week", or the coming Monday 17:00. */
export function dueFor(when: When, now = new Date()): string | null {
  if (when === 'none') return null
  // "Today" is the account's today, and 17:00 is the account's wall clock (V27), matching how the server buckets days.
  const today = accountDay(now)
  const day = when === 'tomorrow' ? shiftDay(today, 1)
    : when === 'week' ? shiftDay(today, (7 - weekdayOf(today)) % 7)
    : when === 'nextweek' ? nextWeekDay(now)   // the coming Monday
    : today
  // After 17:00, "today" means tonight (23:00) rather than a deadline that has already passed.
  if (when === 'today' && Date.parse(accountInstant(day, 17)) <= now.getTime()) return accountInstant(day, 23)
  return accountInstant(day, 17)
}

/** A day picked on the calendar ('YYYY-MM-DD'): 17:00 that day, or 23:00 tonight when it is today and 17:00 has passed. Empty or invalid: no date. */
export function dueForDay(day: string, now = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  if (day === accountDay(now)) return dueFor('today', now)
  return accountInstant(day, 17)
}

/**
 * The task dialog's deadline field. Its value is 'YYYY-MM-DDTHH:mm' (or '' for no deadline) on the BROWSER's wall clock, exactly as the
 * date pickers have always stored it ("a deadline typed as 14:30 comes back as 14:30 on the same device"). The quick choices pick their
 * DAY on the ACCOUNT calendar (as they always did) and keep the field's own HH:mm; there is no instant arithmetic in field space. A
 * deadline always has a time (the schema has no date-only deadline), so with none yet the visible default is 17:00.
 * Known follow-up: typed times could use the account zone instead of the browser's; that is a product decision, not made here.
 */
export const DEFAULT_DEADLINE_TIME = '17:00'
const pad2 = (n: number) => String(n).padStart(2, '0')
const FIELD = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/

/** Deadline field value for an instant: its day and time on the browser's wall clock. Empty or invalid: ''. */
export function deadlineField(iso?: string | null): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
/** The instant (ISO, UTC) a field value means on the browser's wall clock (what the form posts); null for '' or something that is not a date. */
export function deadlineInstant(field: string): string | null {
  const m = FIELD.exec(field)
  if (!m) return null
  const at = new Date(`${m[1]}T${m[2] ?? DEFAULT_DEADLINE_TIME}`)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/** The day "This week" means: the coming Sunday, or today when it is Sunday. */
export const weekEndDay = (today: string) => shiftDay(today, (7 - weekdayOf(today)) % 7)
export type DeadlineWhen = 'none' | 'today' | 'tomorrow' | 'week' | 'custom'
/**
 * Which "When" choice a deadline field value is. The field is read as the instant it means on the browser's clock, and that instant's
 * ACCOUNT day is compared with the account's today, tomorrow and Sunday. Empty: none. Today, then tomorrow, then the end of this week win
 * in that order; any other day, past or future, is 'custom' so no tile claims it. When the browser and account zones differ, the tile follows
 * the account day of the typed moment (e.g. 23:30 in a browser an hour behind the account can read as the account's tomorrow).
 */
export function deriveWhen(field: string, now = new Date()): DeadlineWhen {
  const iso = deadlineInstant(field)
  if (!field || !iso) return 'none'
  const today = accountDay(now), day = accountDay(new Date(iso))
  return day === today ? 'today' : day === shiftDay(today, 1) ? 'tomorrow' : day === weekEndDay(today) ? 'week' : 'custom'
}
/** The next half hour after `now` on a wall clock ('HH:mm'; the browser's unless a timezone is given); '23:59' when that would be tomorrow. */
export function nextHalfHour(now = new Date(), timeZone?: string): string {
  const p = zonedParts(now, timeZone), next = (Math.floor((p.hour * 60 + p.minute) / 30) + 1) * 30
  return next >= 24 * 60 ? '23:59' : `${pad2(Math.floor(next / 60))}:${pad2(next % 60)}`
}
/**
 * A deadline field value after tapping a "When" tile: the chosen DAY (account calendar) with the HH:mm already in the field. With no time
 * yet it is 17:00, or, when that day is today and 17:00 has already passed on the field's clock, the next half hour (never a silent
 * late-night time). 'none' clears it.
 */
export function whenField(when: When, field: string, now = new Date()): string {
  if (when === 'none') return ''
  const today = accountDay(now)
  const day = when === 'tomorrow' ? shiftDay(today, 1) : when === 'week' ? weekEndDay(today) : when === 'nextweek' ? nextWeekDay(now) : today
  const time = FIELD.exec(field)?.[2] ?? (day === today && now.getHours() * 60 + now.getMinutes() >= 17 * 60 ? nextHalfHour(now) : DEFAULT_DEADLINE_TIME)
  return `${day}T${time}`
}
/**
 * A saved task's new deadline (ISO) when moved to a quick choice (the list's "Move to" chips and the swipe snooze). It maps an instant to an
 * instant with no text field, so BOTH the day and the time of day are the ACCOUNT's: the same day and clock time the calendar shows.
 * It keeps the time of day the deadline already had; with none it is 17:00 account time, or the next half hour when that is today and
 * 17:00 has passed. null clears the deadline.
 */
export function dueKeepingTime(when: When, currentIso: string | null | undefined, now = new Date()): string | null {
  if (when === 'none') return null
  const zone = accountZone(), today = accountDay(now)
  const day = when === 'tomorrow' ? shiftDay(today, 1) : when === 'week' ? weekEndDay(today) : when === 'nextweek' ? nextWeekDay(now) : today
  let time = DEFAULT_DEADLINE_TIME
  if (currentIso && !Number.isNaN(Date.parse(currentIso))) { const p = zonedParts(new Date(currentIso), zone); time = `${pad2(p.hour)}:${pad2(p.minute)}` }
  else { const p = zonedParts(now, zone); if (day === today && p.hour * 60 + p.minute >= 17 * 60) time = nextHalfHour(now, zone) }
  const [y, m, d] = day.split('-').map(Number), [h, mi] = time.split(':').map(Number)
  return wallClockToInstant(y, m, d, h, mi, 0, zone).toISOString()
}

/**
 * What a dictated phrase says about when and how important ("buy milk tomorrow, urgent"), in English, Arabic or Dutch, so the
 * "When" and "Priority" chips can be set for the user to see and change. Only used for dictation; typed text is left alone,
 * and the text itself is never rewritten.
 */
export function spokenHints(text: string): { when?: When; priority?: Priority } {
  const s = ` ${text.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[ً-ْ]/g, '')} `
  const has = (...words: string[]) => words.some(w => s.includes(` ${w} `) || s.includes(` ${w},`) || s.includes(` ${w}.`))
  const hints: { when?: When; priority?: Priority } = {}
  if (has('next week', 'volgende week') || /(الاسبوع|اسبوع)\s+(القادم|الجاي|الجايه|الجاي)/.test(s)) hints.when = 'nextweek'
  else if (has('tomorrow', 'morgen', 'غدا', 'بكره', 'بكرا')) hints.when = 'tomorrow'
  else if (has('this week', 'deze week') || /هذا\s+الاسبوع/.test(s)) hints.when = 'week'
  else if (has('today', 'tonight', 'vandaag', 'vanavond', 'اليوم', 'الليله')) hints.when = 'today'
  if (has('urgent', 'urgently', 'asap', 'dringend', 'عاجل', 'مستعجل', 'ضروري')) hints.priority = 'urgent'
  else if (has('important', 'high priority', 'belangrijk', 'hoge prioriteit', 'مهم', 'اولويه عاليه')) hints.priority = 'high'
  else if (has('low priority', 'whenever', 'lage prioriteit', 'geen haast', 'اولويه منخفضه', 'مو مستعجل')) hints.priority = 'low'
  return hints
}
