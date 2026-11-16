import { useEffect, useMemo, useState } from 'react'
import { api } from './api'
import { accountDay, shiftDay } from './accountDay'
import { formatClock } from './clock'
import { useText } from './i18n'
import { useLanguage } from '../contexts/LanguageContext'
import { usePrayerPrefs } from './prayerStore'

/** What GET /api/prayer-times answers (times are ISO instants in UTC; all null on a day the sun does not rise or set). */
export type PrayerKey = 'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha'
export type PrayerWindow = { prayer: string; prayers?: string[]; starts_at: string; ends_at: string }
export type PrayerDay = { date: string; ramadan: boolean; times: Record<PrayerKey, string | null>; windows: PrayerWindow[]; iftar: { starts_at: string; ends_at: string } | null }
export type PrayerData = { enabled: boolean; timezone?: string; method?: string; days: PrayerDay[] }

type Text = (en: string, ar: string, nl?: string) => string
const NAMES: Record<PrayerKey, [string, string, string]> = {
  fajr: ['Fajr', 'الفجر', 'Fadjr'], sunrise: ['Sunrise', 'الشروق', 'Zonsopkomst'], dhuhr: ['Dhuhr', 'الظهر', 'Dohr'],
  asr: ['Asr', 'العصر', 'Asr'], maghrib: ['Maghrib', 'المغرب', 'Maghrib'], isha: ['Isha', 'العشاء', 'Isja'],
}
export const prayerLabel = (key: string, t: Text) => key in NAMES ? t(...NAMES[key as PrayerKey]) : key
/** A window's prayers by name; a merged window ("Dhuhr and Asr") lists all of them. */
export const windowLabel = (w: PrayerWindow, t: Text) => (w.prayers?.length ? w.prayers : [w.prayer]).map(k => prayerLabel(k, t)).join(t(' + ', ' + ', ' + '))

/** One request per range, kept for the session of these settings (a different `rev` empties it). A failed read is not kept. */
const cache = new Map<string, Promise<PrayerData>>()
let cacheRev = -1
function fetchRange(from: string, days: number, rev: number): Promise<PrayerData> {
  if (cacheRev !== rev) { cache.clear(); cacheRev = rev }
  const key = `${from}|${days}`
  let hit = cache.get(key)
  if (!hit) { hit = api<PrayerData>(`/api/prayer-times?from=${from}&days=${days}`); cache.set(key, hit); hit.catch(() => { if (cache.get(key) === hit) cache.delete(key) }) }
  return hit
}

/** The prayer times of `days` days from `from` (YYYY-MM-DD), or null while they load, when prayer times are off, or when `from` is null. */
export function usePrayerRange(from: string | null, days: number): PrayerData | null {
  const { enabled, rev } = usePrayerPrefs(), key = enabled && from ? `${rev}|${from}|${days}` : null
  const [got, setGot] = useState<{ key: string; data: PrayerData } | null>(null)
  useEffect(() => {
    if (!key || !from) return
    let live = true
    fetchRange(from, days, rev).then(data => { if (live) setGot({ key, data }) }).catch(() => { /* prayer times are a courtesy: no message when they cannot be read */ })
    return () => { live = false }
  }, [key, from, days, rev])
  return key && got?.key === key && got.data.enabled ? got.data : null
}

/** The first prayer window that really overlaps [start, end): touching at an edge is not an overlap. */
export function overlapOf(days: PrayerDay[], start: Date, end: Date): { window: PrayerWindow; day: PrayerDay; time: string | null } | null {
  const s = start.getTime(), e = end.getTime()
  if (Number.isNaN(s) || Number.isNaN(e)) return null
  for (const day of days) for (const w of day.windows) {
    const ws = Date.parse(w.starts_at), we = Date.parse(w.ends_at)
    if (e > s ? ws < e && we > s : ws <= s && s < we) return { window: w, day, time: day.times[(w.prayers?.[0] ?? w.prayer) as PrayerKey] ?? null }
  }
  return null
}

/** The next of the five prayers after `now` (sunrise is not a prayer); after Isha that is tomorrow's Fajr. Null when no day has times. */
export function nextPrayer(days: PrayerDay[], now: Date): { key: PrayerKey; at: Date; minutes: number } | null {
  let best: { key: PrayerKey; at: Date } | null = null
  for (const day of days) for (const key of ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const) {
    const iso = day.times[key], at = iso ? new Date(iso) : null
    if (at && at > now && (!best || at < best.at)) best = { key, at }
  }
  return best && { ...best, minutes: Math.max(0, Math.ceil((best.at.getTime() - now.getTime()) / 60000)) }
}

/** "1 h 12 min", "12 min". */
export function untilWords(minutes: number, t: Text) {
  const h = Math.floor(minutes / 60), m = minutes % 60
  return h ? m === 0 ? t(`${h} h`, `${h} س`, `${h} u`) : t(`${h} h ${m} min`, `${h} س ${m} د`, `${h} u ${m} min`) : t(`${m} min`, `${m} د`, `${m} min`)
}

/** The prayer a booking would sit on, as words: `{ name: 'Asr', time: '15:42' }`, or null (also while loading and when prayer times are off). */
export function usePrayerOverlap(startsAt?: string | null, endsAt?: string | null): { name: string; time: string } | null {
  const t = useText(), { language } = useLanguage(), s = startsAt ? new Date(startsAt) : null
  // From the day before (a window can run past midnight) for three days: the same read serves every edit of the time on that day.
  const data = usePrayerRange(s && !Number.isNaN(s.getTime()) ? shiftDay(accountDay(s), -1) : null, 3)
  return useMemo(() => {
    if (!data || !startsAt || !endsAt) return null
    const hit = overlapOf(data.days, new Date(startsAt), new Date(endsAt))
    return hit && { name: windowLabel(hit.window, t), time: hit.time ? formatClock(hit.time, { timeZone: data.timezone }) : '' }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` changes with the language only
  }, [data, startsAt, endsAt, language])
}
