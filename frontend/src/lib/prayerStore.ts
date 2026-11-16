import { useSyncExternalStore } from 'react'

/**
 * What the app needs to know about the account's prayer settings without asking the server again: whether prayer times are on,
 * and the Ramadan work hours. It arrives with the settings (AppLayout reads them once, Settings updates them when saved).
 * Nothing else is kept here: the coordinates never leave the settings form and /api/settings.
 * `rev` changes whenever any prayer setting changes, so cached prayer times are read again.
 */
export type PrayerPrefs = { enabled: boolean; workStart: string; workEnd: string; rev: number }
type Source = Record<string, unknown> | null | undefined
const FIELDS = ['prayer_enabled', 'prayer_lat', 'prayer_lng', 'prayer_method', 'prayer_asr', 'prayer_before', 'prayer_after', 'jumuah_after', 'ramadan_mode', 'ramadan_work_start', 'ramadan_work_end', 'iftar_minutes', 'timezone']
let prefs: PrayerPrefs = { enabled: false, workStart: '10:00', workEnd: '15:00', rev: 0 }, signature = ''
const listeners = new Set<() => void>()
const time = (v: unknown, fallback: string) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : fallback

export function setPrayerPrefs(p?: Source) {
  const next = JSON.stringify(FIELDS.map(f => p?.[f] ?? null))
  if (next === signature) return
  signature = next
  prefs = { enabled: p?.prayer_enabled === true, workStart: time(p?.ramadan_work_start, '10:00'), workEnd: time(p?.ramadan_work_end, '15:00'), rev: prefs.rev + 1 }
  listeners.forEach(l => l())
}
export const prayerPrefs = () => prefs
export const usePrayerPrefs = () => useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, prayerPrefs, prayerPrefs)
