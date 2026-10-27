import { WifiOff } from 'lucide-react'
import { useOnline } from '../../lib/pwa'
import { useText } from '../../lib/i18n'

export default function OfflineBanner() {
  const online = useOnline(), t = useText()
  if (online) return null
  return <div className="offline-banner" role="status"><WifiOff size={16} />{t('You’re offline. You can browse what’s on screen; new tasks, completed tasks and habits are kept on this device until you send them.', 'أنت غير متصل. يمكنك تصفح المعروض؛ وتُحفظ المهام الجديدة والمنجزة والعادات على هذا الجهاز حتى ترسلها.')}</div>
}
