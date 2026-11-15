import { Suspense, useEffect, useState } from 'react'
import { START_TOUR } from '../../lib/discovery'
import { lazyPart, whenIdle } from '../../lib/lazyPart'
import { useToast } from '../../lib/toast'
import { useText } from '../../lib/i18n'

// The tour engine only runs after "Try now"; it is fetched when the page is idle (so it is cached for offline use) or at the first request.
const load = () => import('./TourSheet')
const Sheet = lazyPart(() => load().then(m => m.default))

/** Always mounted: waits for START_TOUR and mounts the tour engine on the first one (it then stays, to follow the tour across screens). */
export default function TourHost({ openMenu, closeMenu }: { openMenu: () => void; closeMenu: () => void }) {
  const [first, setFirst] = useState<string | null>(null), toast = useToast(), t = useText()
  useEffect(() => whenIdle(() => Sheet.preload()), [])
  useEffect(() => {
    const onStart = (e: Event) => { const id = (e as CustomEvent<{ id: string }>).detail?.id; if (id) load().then(() => setFirst(current => current ?? id), () => toast(t('The tour is not available yet. Connect once to finish loading it.', 'الجولة غير متاحة بعد. اتصل مرة واحدة لإكمال تحميلها.', 'De rondleiding is nog niet beschikbaar. Maak één keer verbinding om haar te laden.'), 'error')) }
    window.addEventListener(START_TOUR, onStart)
    return () => window.removeEventListener(START_TOUR, onStart)
  }, [toast, t])
  return first === null ? null : <Suspense fallback={null}><Sheet openMenu={openMenu} closeMenu={closeMenu} first={first} /></Suspense>
}
