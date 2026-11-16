import { useMemo } from 'react'
import { useLanguage } from '../contexts/LanguageContext'
import { hijriDate } from './hijri'
import { islamicDayLabel, islamicDayOf } from './islamicDays'
import { useCalendarPrefs } from './weekStart'

export type HijriInfo = { day: number; month: number; year: number; label: string; special: string | null }

/** null unless the account shows Hijri dates; otherwise a lookup for a YYYY-MM-DD day (null when this browser cannot work it out). */
export function useHijri(): ((day: string) => HijriInfo | null) | null {
  const { system, hijriOffset } = useCalendarPrefs(), { language } = useLanguage()
  return useMemo(() => system !== 'hijri' ? null : (day: string) => {
    const h = hijriDate(day, language, hijriOffset)
    if (!h) return null
    const key = islamicDayOf(h)
    return { ...h, special: key ? islamicDayLabel(key, language) : null }
  }, [system, hijriOffset, language])
}

/** The Hijri span of a shown period, "first – last"; a single day also keeps its Islamic day name. */
export function hijriRange(first: HijriInfo | null, last: HijriInfo | null, single: boolean): HijriInfo | null {
  if (!first) return null
  if (single || !last) return first
  return { ...first, label: `${first.label} – ${last.label}`, special: null }
}
