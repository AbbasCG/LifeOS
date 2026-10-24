import { WifiOff } from 'lucide-react'
import { useOnline } from '../../lib/pwa'
import { useText } from '../../lib/i18n'

export default function OfflineBanner() {
  const online = useOnline(), t = useText()
  if (online) return null
  return <div className="offline-banner" role="status"><WifiOff size={16} />{t('You’re offline. You can browse what’s on screen; changes will not be saved until you reconnect.', 'أنت غير متصل. يمكنك تصفح المعروض، ولن تُحفظ التغييرات حتى تعيد الاتصال.')}</div>
}
