import { Suspense, useEffect, useRef, useState } from 'react'
import { Sunset } from 'lucide-react'
import type { CloseDayHint } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { lazyPart } from '../../lib/lazyPart'
import { CLOSE_DAY, closeDayText, openCloseDay } from '../../lib/closeDay'

const Sheet = lazyPart(() => import('./CloseDaySheet').then(m => m.default))


/** The permanent, quiet action next to "Reorganize my day". It may answer "nothing is left open". */
export function CloseDayButton() {
  const t = useText()
  return <button type="button" className="quiet" data-close-day-open onClick={openCloseDay}><Sunset size={16} aria-hidden="true" />{t('Close the day', 'أغلق اليوم', 'Dag afsluiten')}</button>
}

/** Shown only when the server suggests it (after the work hours of a work day, with something open); one button opens the sheet. */
export function CloseDayCard({ hint }: { hint?: CloseDayHint | null }) {
  const t = useText()
  if (!hint?.suggested) return null
  return <section className="panel install-banner" aria-label={t('Close the day', 'أغلق اليوم', 'Dag afsluiten')}>
    <Sunset size={20} aria-hidden="true" />
    <div><span>{closeDayText(hint.open_today, t)}</span></div>
    <button type="button" className="primary" onClick={openCloseDay}>{t('Close the day', 'أغلق اليوم', 'Dag afsluiten')}</button>
  </section>
}

/** Owns the sheet (loaded on first use) and gives focus back to whatever opened it, or to the permanent action when that is gone. */
export function CloseDayHost() {
  const [open, setOpen] = useState(false), opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const show = () => { opener.current = document.activeElement as HTMLElement | null; setOpen(true) }
    window.addEventListener(CLOSE_DAY, show)
    return () => window.removeEventListener(CLOSE_DAY, show)
  }, [])
  function close() {
    setOpen(false)
    window.setTimeout(() => { if (!opener.current?.isConnected) document.querySelector<HTMLElement>('[data-close-day-open]')?.focus() }, 0)
  }
  return open ? <Suspense fallback={null}><Sheet onClose={close} /></Suspense> : null
}
