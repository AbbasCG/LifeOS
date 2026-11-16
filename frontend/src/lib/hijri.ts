import { shiftDay } from './accountDay'

export type HijriDate = { day: number; month: number; year: number; label: string }

const ZONE = 'UTC'
const formatters = new Map<string, Intl.DateTimeFormat | null>()
const cache = new Map<string, HijriDate | null>()

function formatter(locale: string, numeric: boolean) {
  const key = `${locale}|${numeric}`
  if (!formatters.has(key)) {
    let f: Intl.DateTimeFormat | null
    try {
      const tag = `${locale}-u-ca-islamic-umalqura${numeric ? '-nu-latn' : ''}`
      f = new Intl.DateTimeFormat(tag, numeric ? { timeZone: ZONE, day: 'numeric', month: 'numeric', year: 'numeric' } : { timeZone: ZONE, day: 'numeric', month: 'long', year: 'numeric' })
      // A browser without the calendar quietly falls back to the Gregorian one; that is not a Hijri date.
      if (!/islamic-umalqura/.test(f.resolvedOptions().calendar)) f = null
    } catch { f = null }
    formatters.set(key, f)
  }
  return formatters.get(key) ?? null
}

/**
 * The Umm al-Qura Hijri date of a local calendar day (YYYY-MM-DD), moved by `offset` days first (-2..2, the person's own
 * moon-sighting adjustment). The label follows the app language. Returns null when this browser has no such calendar.
 */
export function hijriDate(day: string, language: string, offset = 0): HijriDate | null {
  const key = `${language}|${offset}|${day}`
  if (cache.has(key)) return cache.get(key) ?? null
  let out: HijriDate | null = null
  try {
    const [y, m, d] = shiftDay(day, offset).split('-').map(Number)
    const at = new Date(Date.UTC(y, m - 1, d, 12))
    const numeric = formatter('en', true), long = formatter(language, false)
    if (numeric && long && !Number.isNaN(at.getTime())) {
      const num: Record<string, number> = {}
      for (const p of numeric.formatToParts(at)) if (p.type === 'day' || p.type === 'month' || p.type === 'year') num[p.type] = Number(p.value)
      // English and Dutch read "6 Jumada II 1448 AH" better without the era; Arabic keeps its "هـ".
      const label = long.formatToParts(at).filter(p => language === 'ar' || p.type !== 'era').map(p => p.value).join('').trim()
      if (num.day && num.month && num.year) out = { day: num.day, month: num.month, year: num.year, label }
    }
  } catch { out = null }
  cache.set(key, out)
  return out
}
