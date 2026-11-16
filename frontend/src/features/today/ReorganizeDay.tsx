import { Suspense, useEffect, useRef, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import type { ReorganizeHint } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { lazyPart } from '../../lib/lazyPart'
import { REORGANIZE_DAY, hasSlipped, openReorganize, slippedText } from '../../lib/reorganize'

const Sheet = lazyPart(() => import('./ReorganizeSheet').then(m => m.default))

/** The permanent, quiet action next to "Plan my day". It may answer "nothing has slipped". */
export function ReorganizeButton() {
  const t = useText()
  return <button type="button" className="quiet" data-reorganize-open onClick={openReorganize}><CalendarClock size={16} aria-hidden="true" />{t('Reorganize my day', 'أعد تنظيم يومي', 'Herorganiseer mijn dag')}</button>
}

/** Shown only when the server says something slipped; one primary button opens the preview. Nothing changes until the user applies it. */
export function ReorganizeCard({ hint }: { hint?: ReorganizeHint | null }) {
  const t = useText()
  if (!hint || !hasSlipped(hint)) return null
  return <section className="panel install-banner" aria-label={t('Reorganize my day', 'أعد تنظيم يومي', 'Herorganiseer mijn dag')}>
    <CalendarClock size={20} aria-hidden="true" />
    <div><span>{slippedText(hint, t)}</span></div>
    <button type="button" className="primary" onClick={openReorganize}>{t('Reorganize', 'أعد التنظيم', 'Herorganiseer')}</button>
  </section>
}

/** Owns the preview sheet (loaded on first use) and gives focus back to whatever opened it. */
export function ReorganizeHost() {
  const [open, setOpen] = useState(false), opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const show = () => { opener.current = document.activeElement as HTMLElement | null; setOpen(true) }
    window.addEventListener(REORGANIZE_DAY, show)
    return () => window.removeEventListener(REORGANIZE_DAY, show)
  }, [])
  function close() {
    setOpen(false)
    // The card disappears once the day is fixed: focus then goes to the permanent action instead of nowhere.
    window.setTimeout(() => { if (!opener.current?.isConnected) document.querySelector<HTMLElement>('[data-reorganize-open]')?.focus() }, 0)
  }
  return open ? <Suspense fallback={null}><Sheet onClose={close} /></Suspense> : null
}
