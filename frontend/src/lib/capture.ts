import type { RecordItem } from './api'
import { accountDay, accountZone, shiftDay, wallClockToInstant } from './accountDay'

/**
 * Quick Add's natural phrases, in English, Arabic and Dutch: "tomorrow at 7pm for one hour",
 * "بكرة الساعة 5 مساءً لمدة ساعتين", "morgen om 17:00 voor 30 minuten".
 *
 * Only the day offset (today or tomorrow), the time of day and the length are read. The title is never rewritten, and a
 * phrase that is not understood changes nothing. Days and clock times are the account's (V27), like the Quick Add tiles.
 * A bare "at 5" / "om 5 uur" / "الساعة 5" is taken as 05:00, as before; a marker ("pm", "مساء", "'s middags") says otherwise.
 */

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩'

/** The text as the matchers see it: Arabic-Indic digits as 0-9, no diacritics, hamza / ya / ta marbuta folded, lower case. */
function fold(text: string) {
  return text.toLowerCase()
    .replace(/[٠-٩]/g, d => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[ً-ْـ]/g, '')
}

/** A whole-word pattern that also works for Arabic (JavaScript's \b only knows ASCII letters). */
const word = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'iu')

const AFTER_TOMORROW = word('day after tomorrow|overmorgen|بعد\\s+(?:غد|غدا|بكره|بكرا)')
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

function readTime(folded: string): Time | null {
  const half = folded.match(HALF)
  if (half) {
    const n = Number(half[1])
    return n >= 1 && n <= 12 ? { hour: hourOf(n - 1, dutchMarker(folded), false), minute: 30 } : null
  }
  for (const pattern of TIME) {
    const m = folded.match(pattern)
    if (!m) continue
    const minute = Number(m[2] ?? 0)
    const written = (m[3] ?? '').toLowerCase()
    const marker = AM_MARKER.test(written) ? 'am' : PM_MARKER.test(written) ? 'pm' : pattern === TIME[2] ? dutchMarker(folded) : null
    const hour = hourOf(Number(m[1]), marker, NIGHT.test(written))
    return hour < 24 && minute < 60 ? { hour, minute } : null
  }
  return null
}

export type CaptureReading = {
  task: Partial<RecordItem>
  /** What was read from the text, so Quick Add can show it before saving. */
  found: { due: boolean; duration: boolean }
}

export function readCapture(text: string, now = new Date()): CaptureReading {
  const folded = fold(text)
  const task: Partial<RecordItem> = { title: text.trim(), status: 'inbox', estimated_minutes: 30 }
  const found = { due: false, duration: false }

  const time = readTime(folded)
  if (time) {
    const offset = AFTER_TOMORROW.test(folded) ? 2 : TOMORROW.test(folded) ? 1 : 0
    const [y, m, d] = shiftDay(accountDay(now), offset).split('-').map(Number)
    task.due_at = wallClockToInstant(y, m, d, time.hour, time.minute, 0, accountZone()).toISOString()
    found.due = true
  }

  for (const { pattern, minutes } of DURATION) {
    const m = folded.match(pattern)
    if (!m) continue
    task.estimated_minutes = Math.max(5, Math.min(10080, minutes(m)))
    found.duration = true
    break
  }
  return { task, found }
}

export function parseCapture(text: string, now = new Date()): Partial<RecordItem> {
  return readCapture(text, now).task
}
