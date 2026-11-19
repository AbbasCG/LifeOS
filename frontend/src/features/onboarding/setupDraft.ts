import type { Language } from '../../contexts/LanguageContext'
import type { Method } from '../settings/prayerLogic'

/** What the setup asks for, exactly as /api/settings stores it. */
export type SetupFields = {
  language: Language; timezone: string; week_start: number; work_days: number[]; work_start: string; work_end: string
  calendar_system: 'gregorian' | 'hijri'; prayer_enabled: boolean; prayer_lat: number | null; prayer_lng: number | null; prayer_method: Method
}
export type Settings = Partial<SetupFields> & Record<string, unknown>
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }
/** A week that starts on Saturday or Sunday usually works Sunday to Thursday; one that starts on Monday works Monday to Friday. */
export const defaultWorkDays = (weekStart: number) => weekStart === 1 ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4]

/** Zones whose working week is Sunday to Thursday (the UAE, Asia/Dubai, works Monday to Friday). Only used to suggest the setup's defaults. */
const SUNDAY_WEEK_ZONES = new Set(['Asia/Riyadh', 'Asia/Kuwait', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Muscat', 'Asia/Baghdad', 'Asia/Amman', 'Asia/Damascus', 'Asia/Aden', 'Africa/Cairo', 'Africa/Khartoum', 'Africa/Tripoli'])
const isPlainWeek = (days: unknown) => Array.isArray(days) && days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d))

/** The account's settings with the setup's defaults where they were never saved (a new account has only its zone and language). */
export function setupDraft(s: Settings, uiLanguage: Language): SetupFields {
  const timezone = s.timezone || browserZone()
  // The setup only runs for a new account, whose week is still the server's Monday-to-Friday default: suggest the local week instead.
  const localWeek = SUNDAY_WEEK_ZONES.has(timezone) && (s.week_start ?? 1) === 1 && (s.work_days === undefined || isPlainWeek(s.work_days))
  const weekStart = localWeek ? 0 : typeof s.week_start === 'number' ? s.week_start : 1
  return {
    language: s.language ?? uiLanguage, timezone, week_start: weekStart,
    work_days: localWeek ? [0, 1, 2, 3, 4] : Array.isArray(s.work_days) && s.work_days.length ? s.work_days : defaultWorkDays(weekStart),
    work_start: s.work_start || '09:00', work_end: s.work_end || '17:00', calendar_system: s.calendar_system === 'hijri' ? 'hijri' : 'gregorian',
    prayer_enabled: s.prayer_enabled === true, prayer_lat: s.prayer_lat ?? null, prayer_lng: s.prayer_lng ?? null, prayer_method: s.prayer_method ?? 'umm_al_qura',
  }
}
