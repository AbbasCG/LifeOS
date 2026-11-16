import type { HijriDate } from './hijri'

/** The Islamic days that are marked (Laylat al-Qadr is left out on purpose: the night is disputed). */
export type IslamicDay = 'new_year' | 'ashura' | 'ramadan' | 'eid_fitr' | 'arafah' | 'eid_adha'

const DAYS: Record<string, IslamicDay> = { '1-1': 'new_year', '1-10': 'ashura', '9-1': 'ramadan', '10-1': 'eid_fitr', '12-9': 'arafah', '12-10': 'eid_adha' }

export const islamicDayOf = (h: Pick<HijriDate, 'month' | 'day'> | null): IslamicDay | null => (h && DAYS[`${h.month}-${h.day}`]) || null

const LABELS: Record<IslamicDay, { en: string; ar: string; nl: string }> = {
  new_year: { en: 'Islamic New Year', ar: 'رأس السنة الهجرية', nl: 'Islamitisch Nieuwjaar' },
  ashura: { en: 'Ashura', ar: 'يوم عاشوراء', nl: 'Asjoera' },
  ramadan: { en: 'Ramadan begins', ar: 'بداية رمضان', nl: 'Begin van de ramadan' },
  eid_fitr: { en: 'Eid al-Fitr', ar: 'عيد الفطر', nl: 'Eid al-Fitr (Suikerfeest)' },
  arafah: { en: 'Day of Arafah', ar: 'يوم عرفة', nl: 'Dag van Arafat' },
  eid_adha: { en: 'Eid al-Adha', ar: 'عيد الأضحى', nl: 'Eid al-Adha (Offerfeest)' },
}
export const islamicDayLabel = (key: IslamicDay, language: string) => LABELS[key][language === 'ar' ? 'ar' : language === 'nl' ? 'nl' : 'en']
