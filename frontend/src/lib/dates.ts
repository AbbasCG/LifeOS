import { localDate } from './hooks'

/** Monday of the week containing `date` (local time). */
export function mondayOf(date = new Date()) {
  const d = new Date(date)
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return localDate(d)
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
