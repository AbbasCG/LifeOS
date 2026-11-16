import { localDate } from './hooks'
import { startOfWeek } from './weekStart'

/** First day of the week containing `date` (the account's week start, Monday by default); with none, of the account's current week (V27). */
export function weekStartOf(date?: Date) { return startOfWeek(date ? localDate(date) : localDate()) }
/** Kept under its old name for callers that predate the week-start setting. */
export const mondayOf = weekStartOf

export function addDays(day: string, amount: number) {
  const d = new Date(`${day}T12:00`)
  d.setDate(d.getDate() + amount)
  return localDate(d)
}

export function minutesLabel(minutes: number, ar: boolean) {
  const h = Math.floor(minutes / 60), m = Math.round(minutes % 60)
  if (!h) return `${m}${ar ? 'د' : 'm'}`
  return `${h}${ar ? 'س' : 'h'}${m ? ` ${m}${ar ? 'د' : 'm'}` : ''}`
}
