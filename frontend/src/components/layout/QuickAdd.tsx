import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { QUICK_ADD } from '../../lib/quickAdd'
import { lazyPart, whenIdle } from '../../lib/lazyPart'
import { preloadSheetParts } from './quickAddParts'
import { useToast } from '../../lib/toast'
import { useText } from '../../lib/i18n'

// The sheet (form, phrase reading, date picker) is not needed by every first load: it is fetched once the page is idle, so the first open is
// instant and it also works offline (the service worker caches what the page fetched). Opening it sooner starts the same fetch.
const load = () => import('./QuickAddSheet')
const Sheet = lazyPart(() => load().then(m => { whenIdle(preloadSheetParts); return m.default }))

/** Always mounted: listens for QUICK_ADD and the installed app's `/?add=task` shortcut, and mounts the sheet on the first open (it then stays, as it keeps the draft). */
export default function QuickAdd() {
  const [open, setOpen] = useState(false), [voice, setVoice] = useState(false), [params] = useSearchParams()
  const [used, setUsed] = useState(false), toast = useToast(), t = useText()
  const addParam = params.get('add') === 'task'
  // A shortcut launch also keeps the sheet mounted after it closes (closing drops the param), as "More details" hands the draft to it.
  if (addParam && !used) setUsed(true)
  useEffect(() => whenIdle(() => Sheet.preload()), [])
  useEffect(() => {
    const show = (e: Event) => {
      const voice = (e as CustomEvent<{ voice?: boolean } | undefined>).detail?.voice === true
      // The file is fetched first: if it cannot be (offline before it was ever cached) the user is told, and the next tap tries again.
      load().then(() => { setOpen(true); setUsed(true); setVoice(voice) }, () => toast(t('Quick add is not available yet. Connect once to finish loading it.', 'الإضافة السريعة غير متاحة بعد. اتصل مرة واحدة لإكمال تحميلها.', 'Snel toevoegen is nog niet beschikbaar. Maak één keer verbinding om het te laden.'), 'error'))
    }
    window.addEventListener(QUICK_ADD, show)
    return () => window.removeEventListener(QUICK_ADD, show)
  }, [toast, t])
  return used || addParam ? <Suspense fallback={null}><Sheet open={open} voice={voice} setOpen={setOpen} setVoice={setVoice} /></Suspense> : null
}
