import type { NewTask } from './api'
import { accountDay, accountZone, shiftDay, wallClockToInstant } from './accountDay'

/**
 * Quick Add's natural phrases, in English, Arabic and Dutch: "tomorrow at 7pm for one hour",
 * "بكرة الساعة 5 مساءً لمدة ساعتين", "morgen om 17:00 voor 30 minuten".
 *
 * Only the day offset (today, tomorrow, the day after), the time of day and the length are read. A time with no day word is reported
 * (`hasDay: false`) so Quick Add puts it on the day its tile says; `schedule.starts_at` then assumes today. The day and time are WHEN TO DO THE
 * TASK (`schedule.starts_at`, the account's wall clock), never a deadline: the deadline is not derived from them. The length is the
 * estimate. `task.title` is the text as typed; `title` is the same text without the words that were read (the day, the time, the length, and a
 * connector left dangling next to them: "Call the bank tomorrow at 10 for 30 minutes" is "Call the bank"). Quick Add saves `title` unless the
 * person keeps their exact text. A day word is only taken out when a time was read with it (alone it changes nothing, so it stays), and when
 * nothing meaningful would be left the text is kept as typed. A phrase that is not understood changes nothing. Days and clock times are the account's (V27).
 * A bare "at 5" / "om 5 uur" / "الساعة 5" is taken as 05:00, as before; a marker ("pm", "مساء", "'s middags") says otherwise.
 */

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩'

/** One character as the matchers see it: Arabic-Indic digits as 0-9, no diacritics, hamza / ya / ta marbuta folded, lower case. */
function foldChar(c: string) {
  return c.toLowerCase()
    .replace(/[٠-٩]/g, d => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[ً-ْـ]/g, '')
}
/** The folded text, and for each of its characters the index of the typed character it came from (so a match can be cut out of the typed text). */
function foldMap(text: string) {
  let folded = ''
  const origin: number[] = []
  for (let i = 0; i < text.length; i++) { const f = foldChar(text[i]); folded += f; for (let k = 0; k < f.length; k++) origin.push(i) }
  return { folded, origin }
}
const fold = (text: string) => foldMap(text).folded

/** A whole-word pattern that also works for Arabic (JavaScript's \b only knows ASCII letters). */
const word = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'iu')

const AFTER_TOMORROW = word('(?:the\\s+)?day after tomorrow|overmorgen|بعد\\s+(?:غد|غدا|بكره|بكرا)')
const TODAY = word('today|tonight|vandaag|vanavond|اليوم|الليله')
const TOMORROW = word('tomorrow|morgen|غدا|بكره|بكرا')

const AM = '(?:am|a\\.m\\.|صباحا|فجرا)'
const PM = '(?:pm|p\\.m\\.|مساء|عصرا|ظهرا|ليلا)'
const NIGHT = word('ليلا')
const CLOCK = '(\\d{1,2})(?:[:.](\\d{2}))?'
/** English "at 7", Arabic "الساعة 7", Dutch "om 7" / "om 7 uur", each optionally followed by a marker. */
const TIME = [
  new RegExp(`(?<![\\p{L}\\p{N}])at\\s+${CLOCK}\\s*(${AM}|${PM})?(?![\\p{L}\\p{N}])`, 'iu'),
  new RegExp(`(?<![\\p{L}\\p{N}])الساعه\\s+${CLOCK}\\s*(${AM}|${PM})?(?![\\p{L}\\p{N}])`, 'iu'),
  new RegExp(`(?<![\\p{L}\\p{N}])om\\s+${CLOCK}(?:\\s*uur)?(?![\\p{L}\\p{N}])`, 'iu'),
]
/** Dutch "half 6" is half past five. */
const HALF = word('om\\s+half\\s+(\\d{1,2})')
const DUTCH_AM = /['’]s\s*(?:ochtends|morgens)/iu
const DUTCH_PM = /['’]s\s*(?:middags|avonds|nachts)/iu

const WORD_NUMBER: Record<string, number> = { een: 1, one: 1, a: 1, an: 1, two: 2, twee: 2, drie: 3 }
const DURATION = [
  // English: "for 2 hours", "for one hour", "for 30 minutes"
  { pattern: word('for\\s+(\\d+|one|two|an?)\\s+(hours?|minutes?)'), minutes: (m: RegExpMatchArray) => count(m[1]) * (/^hour/i.test(m[2]) ? 60 : 1) },
  // Arabic: "لمدة 30 دقيقة", "لمدة 3 ساعات"
  { pattern: word('(?:لمده|مده)\\s+(\\d+)\\s+(ساعه|ساعات|دقيقه|دقائق|دقايق)'), minutes: (m: RegExpMatchArray) => count(m[1]) * (/^ساع/.test(m[2]) ? 60 : 1) },
  // Arabic: "لمدة ساعة", "لمدة ساعتين", "لمدة نصف ساعة", "لمدة ساعة ونصف"
  { pattern: word('(?:لمده|مده)\\s+(ساعه\\s+ونصف|نصف\\s+ساعه|ساعتين|ساعتان|ساعه)'), minutes: (m: RegExpMatchArray) => /ونصف/.test(m[1]) ? 90 : /نصف/.test(m[1]) ? 30 : /^ساعت/.test(m[1]) ? 120 : 60 },
  // Dutch: "voor 30 minuten", "voor een uur", "voor twee uur", "voor anderhalf uur", "voor een kwartier"
  { pattern: word('voor\\s+(anderhalf\\s+uur|een\\s+kwartier)'), minutes: (m: RegExpMatchArray) => /kwartier/i.test(m[1]) ? 15 : 90 },
  { pattern: word('voor\\s+(\\d+|een|twee|drie)\\s+(uur|minuten|minuut)'), minutes: (m: RegExpMatchArray) => count(m[1]) * (/^uur/i.test(m[2]) ? 60 : 1) },
]

function count(value: string) {
  const n = Number(value)
  return Number.isFinite(n) ? n : WORD_NUMBER[value.toLowerCase()] ?? 1
}

/** 24-hour clock hour from the number as typed and an am / pm marker. "12 pm" is noon, "12 am" and "12 ليلا" are midnight. */
function hourOf(hour: number, marker: 'am' | 'pm' | null, night: boolean) {
  if (!marker) return hour
  if (marker === 'am') return hour % 12
  return night && hour === 12 ? 0 : hour % 12 + 12
}

type Time = { hour: number; minute: number }
const AM_MARKER = new RegExp(`^${AM}$`, 'iu')
const PM_MARKER = new RegExp(`^${PM}$`, 'iu')
const dutchMarker = (folded: string) => DUTCH_PM.test(folded) ? 'pm' : DUTCH_AM.test(folded) ? 'am' : null

/** [start, end) in the folded text. */
type Span = [number, number]
const spanOf = (m: RegExpMatchArray): Span => [m.index!, m.index! + m[0].length]
/** The Dutch "'s middags" / "'s ochtends" that went with the time, if any. */
const dutchMarkerSpan = (folded: string) => { const m = folded.match(DUTCH_PM) ?? folded.match(DUTCH_AM); return m ? [spanOf(m)] : [] }

function readTime(folded: string): (Time & { spans: Span[] }) | null {
  const half = folded.match(HALF)
  if (half) {
    const n = Number(half[1])
    return n >= 1 && n <= 12 ? { hour: hourOf(n - 1, dutchMarker(folded), false), minute: 30, spans: [spanOf(half), ...dutchMarkerSpan(folded)] } : null
  }
  for (const pattern of TIME) {
    const m = folded.match(pattern)
    if (!m) continue
    const minute = Number(m[2] ?? 0)
    const written = (m[3] ?? '').toLowerCase()
    const dutch = pattern === TIME[2] && !written ? dutchMarker(folded) : null
    const marker = AM_MARKER.test(written) ? 'am' : PM_MARKER.test(written) ? 'pm' : dutch
    const hour = hourOf(Number(m[1]), marker, NIGHT.test(written))
    return hour < 24 && minute < 60 ? { hour, minute, spans: [spanOf(m), ...(dutch ? dutchMarkerSpan(folded) : [])] } : null
  }
  return null
}

/**
 * Words that only link the understood words to the rest ("at", "for", "في", "الساعة", "om", "voor"): taken out with them when they come
 * right before them, and trimmed from the ends. "on" / "op" are not among them: "turn the lights on tomorrow at 7" keeps its "on".
 */
const CONNECTORS = new Set(['at', 'for', 'around', 'في', 'الساعه', 'لمده', 'مده', 'حوالي', 'عند', 'om', 'voor', 'rond'].map(fold))
/** Words that do not make a title on their own. */
const FILLER = new Set([...CONNECTORS, 'the', 'a', 'an', 'and', 'on', 'in', 'to', 'de', 'het', 'een', 'en', 'op', 'و'])
const EDGE = /^[\s,.;:!?،؛\-–—]+|[\s,;:\-–—،؛]+$/gu

/** The typed text without the given folded spans, tidied; the typed text itself when nothing meaningful would be left. */
function withoutSpans(text: string, origin: number[], spans: Span[]) {
  if (!spans.length) return text.trim()
  // Folded spans back to typed positions; a diacritic right after a match (folded away) goes with it.
  const cut = spans.map(([s, e]): Span => { let end = origin[e - 1] + 1; while (end < text.length && !foldChar(text[end])) end++; return [origin[s], end] })
  // A connector right before an understood part goes with it ("for tomorrow", "في الساعة").
  for (const span of cut) {
    for (;;) {
      const before = text.slice(0, span[0]).match(/([\p{L}\p{M}]+)\s*$/u)
      if (!before || !CONNECTORS.has(fold(before[1]))) break
      span[0] = before.index!
    }
  }
  cut.sort((a, b) => a[0] - b[0])
  let out = '', at = 0
  for (const [s, e] of cut) { if (s > at) out += `${text.slice(at, s)} `; at = Math.max(at, e) }
  out += text.slice(at)
  let title = out.replace(/\s+/g, ' ').replace(/\s+([,.;:!?،؛])/g, '$1').replace(/([,;،؛])(?:\s*[,;،؛])+/g, '$1')
  for (let before = ''; before !== title;) {
    before = title
    title = title.replace(EDGE, '')
    const words = title.split(' ')
    if (words.length > 1 && CONNECTORS.has(fold(words[0]))) words.shift()
    if (words.length > 1 && CONNECTORS.has(fold(words[words.length - 1].replace(/[.!?]+$/u, '')))) words.pop()
    title = words.join(' ')
  }
  const meaningful = title.split(/[\s,.;:!?،؛\-–—]+/u).some(w => /[\p{L}\p{N}]/u.test(w) && !FILLER.has(fold(w)))
  return meaningful ? title : text.trim()
}

export type CaptureReading = {
  task: NewTask
  /** What was read from the text, so Quick Add can show it before saving. `start`: a day and time of day, read as the start of the session. */
  found: { start: boolean; duration: boolean }
  /** Whether a day word (today, tomorrow, the day after) was read. Without one the time belongs to the day Quick Add's tile says. */
  hasDay: boolean
  /** The clock time that was read, 'HH:mm' (the account's wall clock), or null. */
  time: string | null
  /** The account day ('YYYY-MM-DD') the day word names, or null without one. */
  day: string | null
  /** The title without the understood words (see above); the text as typed when nothing was taken out. */
  title: string
}

export function readCapture(text: string, now = new Date()): CaptureReading {
  const { folded, origin } = foldMap(text)
  const task: NewTask = { title: text.trim(), status: 'inbox', estimated_minutes: 30 }
  const found = { start: false, duration: false }
  const spans: Span[] = []

  const time = readTime(folded)
  const dayMatch = folded.match(AFTER_TOMORROW) ?? folded.match(TOMORROW) ?? folded.match(TODAY)
  const hasDay = dayMatch !== null
  const offset = folded.match(AFTER_TOMORROW) ? 2 : folded.match(TOMORROW) ? 1 : 0
  const day = hasDay ? shiftDay(accountDay(now), offset) : null
  if (time) {
    const [y, m, d] = shiftDay(accountDay(now), offset).split('-').map(Number)
    task.schedule = { starts_at: wallClockToInstant(y, m, d, time.hour, time.minute, 0, accountZone()).toISOString() }
    found.start = true
    spans.push(...time.spans)
    if (dayMatch) spans.push(spanOf(dayMatch))
  }

  for (const { pattern, minutes } of DURATION) {
    const m = folded.match(pattern)
    if (!m) continue
    task.estimated_minutes = Math.max(5, Math.min(10080, minutes(m)))
    found.duration = true
    spans.push(spanOf(m))
    break
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  return { task, found, hasDay, time: time ? `${pad(time.hour)}:${pad(time.minute)}` : null, day, title: withoutSpans(text, origin, spans) }
}

export function parseCapture(text: string, now = new Date()): NewTask {
  return readCapture(text, now).task
}
