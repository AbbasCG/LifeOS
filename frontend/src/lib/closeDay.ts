/** Asks Today to open the "Close the day" sheet (from the evening card, the permanent action, or anything else). */
export const CLOSE_DAY = 'lifeos:close-day'
export const openCloseDay = () => window.dispatchEvent(new Event(CLOSE_DAY))

/** "Your work day is over: 3 things are still open. Close the day?" in English, Arabic or Dutch. */
export function closeDayText(open: number, t: (en: string, ar: string, nl?: string) => string) {
  const ar = open === 1 ? 'بقي شيء واحد مفتوحاً' : open === 2 ? 'بقي شيئان مفتوحين' : open <= 10 ? `بقيت ${open} أشياء مفتوحة` : `بقي ${open} شيئاً مفتوحاً`
  return t(`Your work day is over: ${open} ${open === 1 ? 'thing is' : 'things are'} still open. Close the day?`, `انتهى يوم عملك: ${ar}. أتغلق اليوم؟`, `Je werkdag is voorbij: nog ${open} ${open === 1 ? 'ding' : 'dingen'} open. Dag afsluiten?`)
}

