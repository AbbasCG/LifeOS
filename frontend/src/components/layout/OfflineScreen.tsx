import { WifiOff } from 'lucide-react'
import { useText } from '../../lib/i18n'

/** Shown instead of redirecting to sign-in when the server cannot be reached. */
export default function OfflineScreen({ onRetry }: { onRetry: () => void }) {
  const t = useText()
  return <main className="offline-screen" role="alert">
    <span className="empty-icon"><WifiOff size={28} /></span>
    <h1>{t('You’re offline', 'أنت غير متصل')}</h1>
    <p className="muted">{t('LifeOS can’t reach the server right now. Your data is safe — reconnect and try again.', 'لا يستطيع LifeOS الوصول إلى الخادم الآن. بياناتك آمنة — أعد الاتصال وحاول مجدداً.')}</p>
    <button className="primary" onClick={onRetry}>{t('Try again', 'إعادة المحاولة')}</button>
  </main>
}
