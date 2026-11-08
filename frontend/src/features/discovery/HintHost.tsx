import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { whenIdle } from '../../lib/lazyPart'
import { calmMoment, hintShownThisSession, hintTarget, loadGuide, markHintShown, recordState, routePath, setHintsEnabled, setNewFeatures, tryFeature, type Hint, type NewFeature } from '../../lib/discovery'
import { HintBubble } from './HintBubble'

/**
 * Feature discovery in the screens themselves. Once the app is idle it asks the server which features are new to this person
 * (the menu shows "New" on them) and which hints are due. At most one hint is shown per browser session, only on the screen
 * it belongs to, only when its target is on screen, and only at a calm moment: not while typing, not over a dialog or a focus
 * session. Opening a screen of a new feature clears its badge.
 */
export default function HintHost() {
  const { pathname } = useLocation(), [hint, setHint] = useState<Hint | null>(null)
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hints = useRef<Hint[] | null>(null), path = useRef(pathname), shown = useRef(false), tried = useRef(new Set<string>()), newOnes = useRef<NewFeature[]>([])

  const tryShow = (attempt = 0): void => {
    if (shown.current || hintShownThisSession() || !hints.current) return
    const candidate = hints.current.find(h => routePath(h.route) === path.current && hintTarget(h.target))
    if (!candidate) return
    if (!calmMoment()) { if (attempt < 8) retry.current = setTimeout(() => tryShow(attempt + 1), 10_000); return }
    shown.current = true; markHintShown(); setHint(candidate)
    void recordState('hint', candidate.id, 'seen').catch(() => {})
  }

  useEffect(() => {
    let cancelled = false
    whenIdle(() => {
      if (cancelled) return
      loadGuide().then(g => {
        if (cancelled) return
        hints.current = g.hints; newOnes.current = g.new
        setNewFeatures(g.new.filter(f => !tried.current.has(f.id)))
        tryShow()
      }).catch(() => {})
    })
    return () => { cancelled = true; clearTimeout(retry.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Moving to another screen: a hint for that screen may now be due, and a new feature's own screen counts as opened.
  useEffect(() => {
    path.current = pathname
    clearTimeout(retry.current)
    const opened = newOnes.current.filter(f => routePath(f.route) === pathname && !tried.current.has(f.id))
    if (opened.length) {
      opened.forEach(f => tried.current.add(f.id))
      setNewFeatures(newOnes.current.filter(f => !tried.current.has(f.id)))
      opened.forEach(f => { void tryFeature(f.id).catch(() => {}) })
    }
    const timer = setTimeout(() => tryShow(), 1200)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  if (!hint) return null
  const close = () => { void recordState('hint', hint.id, 'dismissed').catch(() => {}); setHint(null) }
  const turnOff = () => { void setHintsEnabled(false).catch(() => {}); close() }
  return <HintBubble hint={hint} onGotIt={close} onTurnOff={turnOff} />
}
