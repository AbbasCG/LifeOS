import { accountDay, accountInstant, shiftDay, weekdayOf } from './accountDay'

/** Ask the app shell to open Quick Add (from the topbar, the bottom bar, a shortcut or an empty state). */
export const QUICK_ADD = 'lifeos:quick-add'
/** Fired after Quick Add saved a task, so lists and Today can refresh. */
export const TASKS_CHANGED = 'lifeos:tasks-changed'
export const openQuickAdd = () => window.dispatchEvent(new Event(QUICK_ADD))
/** Opens Quick add already listening, so a task is two taps: the microphone, then Add. */
export const openQuickAddByVoice = () => window.dispatchEvent(new CustomEvent(QUICK_ADD, { detail: { voice: true } }))

export type When = 'today' | 'tomorrow' | 'week' | 'nextweek' | 'none'
export type Priority = 'urgent' | 'high' | 'medium' | 'low'

/** Due date for a quick choice: 17:00 today (23:00 once 17:00 has passed) or 17:00 tomorrow, Sunday 17:00 for "this week", or the coming Monday 17:00. */
export function dueFor(when: When, now = new Date()): string | null {
  if (when === 'none') return null
  // "Today" is the account's today, and 17:00 is the account's wall clock (V27), matching how the server buckets days.
  const today = accountDay(now)
  const day = when === 'tomorrow' ? shiftDay(today, 1)
    : when === 'week' ? shiftDay(today, (7 - weekdayOf(today)) % 7)
    : when === 'nextweek' ? shiftDay(today, ((8 - weekdayOf(today)) % 7) || 7)   // the coming Monday
    : today
  // After 17:00, "today" means tonight (23:00) rather than a deadline that has already passed.
  if (when === 'today' && Date.parse(accountInstant(day, 17)) <= now.getTime()) return accountInstant(day, 23)
  return accountInstant(day, 17)
}

/**
 * What a dictated phrase says about when and how important ("buy milk tomorrow, urgent"), in English or Arabic, so the
 * "When" and "Priority" chips can be set for the user to see and change. Only used for dictation; typed text is left alone,
 * and the text itself is never rewritten.
 */
export function spokenHints(text: string): { when?: When; priority?: Priority } {
  const s = ` ${text.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[ً-ْ]/g, '')} `
  const has = (...words: string[]) => words.some(w => s.includes(` ${w} `) || s.includes(` ${w},`) || s.includes(` ${w}.`))
  const hints: { when?: When; priority?: Priority } = {}
  if (has('next week') || /(الاسبوع|اسبوع)\s+(القادم|الجاي|الجايه|الجاي)/.test(s)) hints.when = 'nextweek'
  else if (has('tomorrow', 'غدا', 'بكره', 'بكرا')) hints.when = 'tomorrow'
  else if (has('this week') || /هذا\s+الاسبوع/.test(s)) hints.when = 'week'
  else if (has('today', 'tonight', 'اليوم', 'الليله')) hints.when = 'today'
  if (has('urgent', 'urgently', 'asap', 'عاجل', 'مستعجل', 'ضروري')) hints.priority = 'urgent'
  else if (has('important', 'high priority', 'مهم', 'اولويه عاليه')) hints.priority = 'high'
  else if (has('low priority', 'whenever', 'اولويه منخفضه', 'مو مستعجل')) hints.priority = 'low'
  return hints
}
