/** Short and long display names for the source of an imported commitment. */
export function sourceName(source: string, t: (en: string, ar: string) => string, long = false): string {
  switch (source) {
    case 'google': return long ? t('Google Calendar', 'تقويم Google') : 'Google'
    case 'outlook': return 'Outlook'
    case 'ics': return long ? t('a calendar subscription', 'اشتراك تقويم') : t('Subscription', 'اشتراك')
    default: return source
  }
}
