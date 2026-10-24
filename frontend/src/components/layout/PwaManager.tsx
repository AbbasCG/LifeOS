import { useEffect } from 'react'
import { registerServiceWorker } from '../../lib/pwa'
import { useToast } from '../../lib/toast'
import { useText } from '../../lib/i18n'

/** Registers the service worker and offers updates through a toast; never reloads without consent. */
export default function PwaManager() {
  const toast = useToast(), t = useText()
  useEffect(() => {
    registerServiceWorker(apply => toast(t('A new version of LifeOS is ready.', 'إصدار جديد من LifeOS جاهز.'), 'info', { label: t('Reload', 'إعادة تحميل'), onClick: apply }))
    // Register once per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}
