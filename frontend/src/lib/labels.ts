import { useText } from './i18n'

/** Translate the stable reason keys returned by the briefing and assistant APIs. */
export function useReasonLabel() {
  const t = useText()
  return (reason: string) => ({
    urgent: t('Urgent', 'عاجلة'), high: t('High priority', 'أولوية عالية'), in_progress: t('In progress', 'قيد التنفيذ'),
    overdue: t('Overdue', 'متأخرة'), due_today: t('Due today', 'مستحقة اليوم'), due_soon: t('Due soon', 'مستحقة قريباً'), quick_win: t('Quick win', 'إنجاز سريع'),
  }[reason] || reason)
}
