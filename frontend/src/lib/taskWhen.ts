import { accountDay, accountZone, shiftDay } from './accountDay'
import type { TaskSchedule } from './api'
import { deadlineField, deadlineInstant, nextHalfHour } from './quickAdd'

/**
 * "When do you want to do it?": the execution time of a task as the task dialog edits it. Everything is the ACCOUNT's wall clock
 * (day 'YYYY-MM-DD', start 'HH:mm'); the instants are derived with the same helpers the deadline field uses. The length is the
 * task's estimate (`estimated_minutes`), so there is one number for it, and the end is only ever computed (start + length), never typed.
 */
export const DURATIONS = [15, 30, 45, 60, 120]
export const DEFAULT_DURATION = 30
export const MIN_DURATION = 5
export const MAX_DURATION = 10080
export const DEFAULT_START = '09:00'

export type DayChoice = 'today' | 'tomorrow' | 'custom' | 'none'
/** Which date tile a day is: today and tomorrow on the account's calendar, any other day is a picked date, '' is "not scheduled". */
export function choiceOf(day: string, now = new Date()): DayChoice {
  if (!day) return 'none'
  const today = accountDay(now)
  return day === today ? 'today' : day === shiftDay(today, 1) ? 'tomorrow' : 'custom'
}

export const validMinutes = (minutes: number) => Number.isInteger(minutes) && minutes >= MIN_DURATION && minutes <= MAX_DURATION

/** Where a freshly chosen day starts: the next half hour for today (never in the past), 09:00 for any other day; with no half hour left today, tomorrow 09:00. */
export function defaultWhen(day: string, now = new Date()): { day: string; start: string } {
  if (day !== accountDay(now)) return { day, start: DEFAULT_START }
  const next = nextHalfHour(now, accountZone())
  return next === '23:59' ? { day: shiftDay(day, 1), start: DEFAULT_START } : { day, start: next }
}
/** A start the user already chose, moved to a day: kept, unless that day is today and the time has passed (then the day's default). */
export function whenFor(day: string, start: string, now = new Date()): { day: string; start: string } {
  if (!/^\d{2}:\d{2}$/.test(start)) return defaultWhen(day, now)
  const at = deadlineInstant(`${day}T${start}`)
  return day === accountDay(now) && (at === null || Date.parse(at) < now.getTime()) ? defaultWhen(day, now) : { day, start }
}
/** The start as the clock will really show it: a time the clock skips (02:30 on the spring day) is 03:30. */
export function settledStart(day: string, start: string): string {
  const real = deadlineField(deadlineInstant(`${day}T${start}`))
  return real ? real.slice(11, 16) : start
}

/** The length of a session in whole minutes. */
export const lengthOf = (startsAt: string, endsAt: string) => Math.max(1, Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000))

export type Booking = { starts_at: string; ends_at: string; endDay: string; endTime: string }
/**
 * The booking a day, a start and a length mean: both instants (real elapsed time, so a day with a clock change is 23 or 25 hours long)
 * and the end as the account's wall clock (`endDay` differs from `day` when it passes midnight). null while any of them is not valid.
 * `savedStart`: the saved instant of an unchanged start (the second 02:30 of the autumn day reads the same as the first on the wall clock).
 */
export function bookingOf(day: string, start: string, minutes: number, savedStart?: string): Booking | null {
  if (!day || !/^\d{2}:\d{2}$/.test(start) || !validMinutes(minutes)) return null
  const startsAt = savedStart ?? deadlineInstant(`${day}T${start}`)
  if (!startsAt) return null
  const endsAt = new Date(Date.parse(startsAt) + minutes * 60_000).toISOString(), end = deadlineField(endsAt)
  return { starts_at: startsAt, ends_at: endsAt, endDay: end.slice(0, 10), endTime: end.slice(11, 16) }
}

/** A saved session as the dialog's fields show it: its day and start on the account's clock and its length. */
export function sessionDraft(schedule: TaskSchedule): { day: string; start: string; minutes: number } {
  const field = deadlineField(schedule.starts_at)
  return { day: field.slice(0, 10), start: field.slice(11, 16), minutes: lengthOf(schedule.starts_at, schedule.ends_at) }
}

/** 'Wednesday 11 November' for a 'YYYY-MM-DD' day (the year only when it is not this year): a calendar date, so no timezone shifts it. */
export function dayLabel(day: string, language: string, thisYear = accountDay().slice(0, 4)): string {
  return new Intl.DateTimeFormat(language === 'ar' ? 'ar-u-nu-latn' : language === 'nl' ? 'nl-NL' : 'en', { weekday: 'long', day: 'numeric', month: 'long', ...(day.slice(0, 4) !== thisYear ? { year: 'numeric' as const } : {}), timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`))
}
