import { lazy, Suspense, useEffect, useState } from 'react'
import { useToast } from '../../lib/toast'
import { useText } from '../../lib/i18n'
import { whenIdle } from '../../lib/lazyPart'
import { calmMoment, loadBootstrap, markShown, shownThisSession, type Release } from '../../lib/discovery'

const WhatsNewSheet = lazy(() => import('./WhatsNewSheet'))

/**
 * Asks the server, once the app is idle, whether there is an announcement for this person, and shows it at the first calm
 * moment (not while typing, not over another sheet). One announcement per browser session; nothing is shown when the server
 * has none, when it fails, or when the person is offline.
 */
export default function DiscoveryHost() {
  const [release, setRelease] = useState<Release | null>(null), toast = useToast(), t = useText()
  useEffect(() => {
    if (shownThisSession()) return
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined
    const run = async () => {
      let data
      try { data = await loadBootstrap() } catch { return }
      if (cancelled) return
      // The server has an update this open tab cannot show yet: say so, and never reload by itself.
      if (data.update_required) toast(t('A new version of LifeOS is ready. Reload to see what’s new.', 'إصدار جديد من LifeOS جاهز. أعد التحميل لترى الجديد.', 'Er is een nieuwe versie van LifeOS. Laad opnieuw om te zien wat er nieuw is.'), 'info', { label: t('Reload', 'إعادة تحميل', 'Opnieuw laden'), onClick: () => location.reload() })
      const announcement = data.announcement
      if (!announcement) return
      const attempt = (tries: number) => {
        if (cancelled) return
        if (calmMoment()) { markShown(); setRelease(announcement) }
        else if (tries < 12) timer = setTimeout(() => attempt(tries + 1), 15_000)
      }
      attempt(0)
    }
    whenIdle(() => { if (!cancelled) void run() })
    return () => { cancelled = true; clearTimeout(timer) }
    // Once per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return release ? <Suspense fallback={null}><WhatsNewSheet release={release} onDone={() => setRelease(null)} /></Suspense> : null
}
