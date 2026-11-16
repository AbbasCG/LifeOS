import { useSyncExternalStore } from 'react'
import { shiftDay, weekdayOf } from './accountDay'

/**
 * The account's calendar preferences: the first day of the week (0 = Sunday ... 6 = Saturday, like Date.getDay and the server's
 * `week_start`), whether a Hijri date is shown beside the Gregorian one, and the Hijri day adjustment (-2..2).
 * They arrive with the account's settings (AppLayout reads them once, Settings updates them when saved); until then the
 * defaults every account had before the setting existed apply: Monday, Gregorian only.
 */
export type CalendarSystem = 'gregorian' | 'hijri'
export type CalendarPrefs = { weekStart: number; system: CalendarSystem; hijriOffset: number }
const DEFAULTS: CalendarPrefs = { weekStart: 1, system: 'gregorian', hijriOffset: 0 }
let prefs = DEFAULTS
const listeners = new Set<() => void>()

/** Takes the three settings fields as the server returns them; anything missing or out of range falls back to the default. */
export function setCalendarPrefs(p?: { week_start?: unknown; calendar_system?: unknown; hijri_offset?: unknown } | null) {
  const ws = Number(p?.week_start), off = Number(p?.hijri_offset)
  const next: CalendarPrefs = {
    weekStart: Number.isInteger(ws) && ws >= 0 && ws <= 6 ? ws : DEFAULTS.weekStart,
    system: p?.calendar_system === 'hijri' ? 'hijri' : 'gregorian',
    hijriOffset: Number.isInteger(off) && off >= -2 && off <= 2 ? off : 0,
  }
  if (next.weekStart === prefs.weekStart && next.system === prefs.system && next.hijriOffset === prefs.hijriOffset) return
  prefs = next
  listeners.forEach(l => l())
}
export const calendarPrefs = () => prefs
export const accountWeekStart = () => prefs.weekStart

/** Re-renders when the preferences arrive or change. */
export function useCalendarPrefs(): CalendarPrefs {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, calendarPrefs, calendarPrefs)
}

/** How many days `day` (YYYY-MM-DD) is after the first day of its week: 0 on the first day, 6 on the last. */
export const daysIntoWeek = (day: string, weekStart = prefs.weekStart) => (weekdayOf(day) - weekStart + 7) % 7

/** First day of the week containing `day`. */
export const startOfWeek = (day: string, weekStart = prefs.weekStart) => shiftDay(day, -daysIntoWeek(day, weekStart))

/** The seven weekday numbers (0 = Sunday) in column order for a week that starts on `weekStart`. */
export const weekdayOrder = (weekStart = prefs.weekStart) => Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7)
