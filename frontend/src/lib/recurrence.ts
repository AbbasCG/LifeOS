import type { Recurrence } from './api'

/** Human summary of a recurrence rule, e.g. "Every 2 weeks on Mon, Thu · 10 times". */
export function describeRecurrence(rule: Recurrence | null | undefined, language: string, t: (en: string, ar: string) => string) {
  if (!rule) return ''
  const n = rule.interval ?? 1
  const unit = { daily: [t('day', 'يوم'), t('days', 'أيام')], weekly: [t('week', 'أسبوع'), t('weeks', 'أسابيع')], monthly: [t('month', 'شهر'), t('months', 'أشهر')], yearly: [t('year', 'سنة'), t('years', 'سنوات')] }[rule.freq]
  let text = n === 1 ? t(`Every ${unit[0]}`, `كل ${unit[0]}`) : t(`Every ${n} ${unit[1]}`, `كل ${n} ${unit[1]}`)
  if (rule.freq === 'weekly' && rule.by_weekday?.length) text += ` · ${[...rule.by_weekday].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(d => new Date(2026, 0, 4 + d).toLocaleDateString(language, { weekday: 'short' })).join(language === 'ar' ? '، ' : ', ')}`
  if (rule.count) text += ` · ${t(`${rule.count} times`, `${rule.count} مرات`)}`
  if (rule.until) text += ` · ${t(`until ${new Date(`${rule.until}T12:00`).toLocaleDateString(language)}`, `حتى ${new Date(`${rule.until}T12:00`).toLocaleDateString(language)}`)}`
  return text
}
