import { localDate } from './hooks'
import { shiftDay, weekdayOf } from './accountDay'

/** Monday of the week containing `date`; with none, of the account's current week (V27). */
export function mondayOf(date?: Date) {
  const day = date ? localDate(date) : localDate()
  return shiftDay(day, -((weekdayOf(day) + 6) % 7))
}

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
