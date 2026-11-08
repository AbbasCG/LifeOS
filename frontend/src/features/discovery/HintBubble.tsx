import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useText } from '../../lib/i18n'
import { hintTarget, type Hint } from '../../lib/discovery'

/**
 * A small note next to the thing it explains. It never takes focus, never covers the page with a backdrop and never blocks
 * the control it points at. Escape or "Got it" ends it for good.
 */
export function HintBubble({ hint, onGotIt, onTurnOff }: { hint: Hint; onGotIt: () => void; onTurnOff: () => void }) {
  const t = useText(), ref = useRef<HTMLDivElement>(null), [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const el = hintTarget(hint.target), bubble = ref.current
      if (!el || !bubble) return
      const r = el.getBoundingClientRect(), w = bubble.offsetWidth, h = bubble.offsetHeight
      const below = r.bottom + 10 + h <= window.innerHeight - 8
      setPos({ top: Math.max(8, below ? r.bottom + 10 : r.top - 10 - h), left: Math.min(Math.max(12, r.left + r.width / 2 - w / 2), window.innerWidth - w - 12) })
    }
    place()
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [hint.target])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onGotIt() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onGotIt])
  return <div ref={ref} className="hint-bubble" role="status" data-testid="hint-bubble" style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}>
    <p>{hint.text}</p>
    <div className="hint-actions">
      <button type="button" className="primary" onClick={onGotIt}>{t('Got it', 'فهمت', 'Begrepen')}</button>
      <button type="button" className="quiet" onClick={onTurnOff}>{t('Turn off tips', 'إيقاف التلميحات', 'Tips uitzetten')}</button>
    </div>
    <button type="button" className="icon-button hint-close" onClick={onGotIt} aria-label={t('Close tip', 'إغلاق التلميح', 'Tip sluiten')}><X size={16} /></button>
  </div>
}
