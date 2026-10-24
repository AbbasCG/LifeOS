import { useText } from './i18n'

/** Translate the stable reason keys returned by the briefing and assistant APIs. */
export function useReasonLabel() {
  const t = useText()
  return (reason: string) => ({
    urgent: t('Urgent', 'عاجلة'), high: t('High priority', 'أولوية عالية'), in_progress: t('In progress', 'قيد التنفيذ'),
    overdue: t('Overdue', 'متأخرة'), due_today: t('Due today', 'مستحقة اليوم'), due_soon: t('Due soon', 'مستحقة قريباً'), quick_win: t('Quick win', 'إنجاز سريع'), goal: t('Moves a goal', 'تدفع هدفاً'),
  }[reason] || reason)
}

/** Translate audit-log action keys. */
export function useAuditLabel() {
  const t = useText()
  return (action: string) => ({
    login: t('Signed in', 'تسجيل دخول'), login_failed: t('Failed sign-in attempt', 'محاولة دخول فاشلة'), logout: t('Signed out', 'تسجيل خروج'),
    password_changed: t('Password changed', 'تغيير كلمة المرور'), email_changed: t('Email changed', 'تغيير البريد'), password_reset: t('Password reset', 'إعادة تعيين كلمة المرور'),
    two_factor_enabled: t('Two-factor enabled', 'تفعيل التحقق بخطوتين'), two_factor_disabled: t('Two-factor disabled', 'تعطيل التحقق بخطوتين'),
    two_factor_challenge_failed: t('Wrong two-factor code', 'رمز تحقق خاطئ'), recovery_codes_regenerated: t('Recovery codes regenerated', 'إعادة إنشاء رموز الاسترداد'), recovery_code_used: t('Recovery code used', 'استخدام رمز استرداد'),
    session_revoked: t('Session signed out', 'إنهاء جلسة'), other_sessions_revoked: t('Other sessions signed out', 'إنهاء الجلسات الأخرى'), data_exported: t('Data exported', 'تصدير البيانات'),
    integration_connected: t('Calendar connected', 'ربط تقويم'), integration_disconnected: t('Calendar disconnected', 'فصل تقويم'), integration_revoked: t('Calendar access revoked', 'إلغاء وصول التقويم'),
    push_subscribed: t('Push notifications enabled', 'تفعيل الإشعارات الفورية'), push_unsubscribed: t('Push notifications disabled', 'إيقاف الإشعارات الفورية'),
    ai_action_executed: t('Assistant changes applied', 'تطبيق تغييرات المساعد'), automation_changed: t('Automation changed', 'تعديل أتمتة'),
  }[action] || action)
}
