import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useToast } from '../../lib/toast'
import { useText } from '../../lib/i18n'
import { hintTarget, loadTour, recordState, routePath, START_TOUR, type Tour, type TourStep } from '../../lib/discovery'

type Box = { top: number; left: number; width: number; height: number }
const GAP = 12

/** On screen sideways: a menu parked off to the side of a phone has a size but is not where the person can see it. */
function onScreen(target: string) {
  const el = hintTarget(target)
  if (!el) return false
  const r = el.getBoundingClientRect()
  return r.right > 0 && r.left < window.innerWidth
}

/** Where the card goes: beside the target on the side asked for (or the one with room), kept inside the screen. Without a target it is centred. */
function place(box: Box | null, card: { w: number; h: number }, placement: TourStep['placement']) {
  const vw = window.innerWidth, vh = window.innerHeight
  if (!box) return { top: Math.max(12, (vh - card.h) / 2), left: Math.max(12, (vw - card.w) / 2) }
  const rtl = document.documentElement.dir === 'rtl'
  const side = placement === 'start' ? (rtl ? 'right' : 'left') : placement === 'end' ? (rtl ? 'left' : 'right') : placement
  const fits = { bottom: box.top + box.height + GAP + card.h <= vh - 8, top: box.top - GAP - card.h >= 8 }
  const vertical = side === 'bottom' || side === 'top' ? side : fits.bottom || !fits.top ? 'bottom' : 'top'
  let top = vertical === 'bottom' ? box.top + box.height + GAP : box.top - GAP - card.h
  let left = box.left + box.width / 2 - card.w / 2
  if (side === 'left' || side === 'right') {
    left = side === 'left' ? box.left - GAP - card.w : box.left + box.width + GAP
    top = box.top + box.height / 2 - card.h / 2
    if (left < 8 || left + card.w > vw - 8) { left = box.left + box.width / 2 - card.w / 2; top = box.top + box.height + GAP }
  }
  return { top: Math.min(Math.max(8, top), Math.max(8, vh - card.h - 8)), left: Math.min(Math.max(12, left), Math.max(12, vw - card.w - 12)) }
}

/**
 * The guided tour engine. A tour only points at things and explains them: it never clicks, types or submits for the person.
 * It starts from a "Try now" (see `startTour`), walks the steps of reviewed content, can move to another screen or open the
 * menu to show a step's target, skips steps whose target does not exist when they are optional, and remembers where the person
 * stopped. Escape or "Skip tour" ends it at any step.
 */
export default function TourHost({ openMenu, closeMenu }: { openMenu: () => void; closeMenu: () => void }) {
  const t = useText(), toast = useToast(), navigate = useNavigate(), { pathname } = useLocation(), titleId = useId()
  const [tour, setTour] = useState<Tour | null>(null), [index, setIndex] = useState(0), [box, setBox] = useState<Box | null>(null), [card, setCard] = useState({ w: 320, h: 180 })
  const cardRef = useRef<HTMLDivElement>(null), opener = useRef<HTMLElement | null>(null), menuOpened = useRef(false), direction = useRef(1), busy = useRef(false)

  const end = useCallback((how: 'completed' | 'skipped') => {
    setTour(current => {
      if (current) void recordState('tour', current.id, how).catch(() => {})
      return null
    })
    if (menuOpened.current) { menuOpened.current = false; closeMenu() }
    busy.current = false
    const back = opener.current; opener.current = null
    if (back?.isConnected) back.focus()
  }, [closeMenu])

  useEffect(() => {
    const onStart = async (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id
      if (!id || busy.current) return
      busy.current = true
      try {
        const data = await loadTour(id)
        const resume = !data.state.completed && !data.state.skipped && data.state.step_index > 0 && data.state.step_index < data.steps.length ? data.state.step_index : 0
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        direction.current = 1
        setIndex(resume); setTour(data)
        void recordState('tour', id, 'started').catch(() => {})
      } catch {
        busy.current = false
        toast(t('This tour is not available right now.', 'هذه الجولة غير متاحة الآن.', 'Deze rondleiding is nu niet beschikbaar.'), 'info')
      }
    }
    window.addEventListener(START_TOUR, onStart)
    return () => window.removeEventListener(START_TOUR, onStart)
  }, [toast, t])

  const step = tour?.steps[index]
  // Bring the step's target into view: go to its screen, open the menu if it hides there, then follow it (it may move while a menu slides in).
  useEffect(() => {
    if (tour && index > 0) void recordState('tour', tour.id, 'step', index).catch(() => {})
  }, [tour, index])
  useEffect(() => {
    if (!tour || !step) return
    if (step.route && routePath(step.route) !== pathname) navigate(step.route)
    else if (step.reveal === 'sidebar' && !onScreen(step.target)) { menuOpened.current = true; openMenu() }
    else if (!step.reveal && menuOpened.current && !onScreen(step.target)) { menuOpened.current = false; closeMenu() }
    // Runs again once the screen has changed, so a step with both a screen and a menu reveal does both.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour, index, pathname])

  useEffect(() => {
    if (!tour || !step) return
    let waited = 0, stopped = false
    const measure = () => {
      const el = hintTarget(step.target)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: r.top, left: r.left, width: r.width, height: r.height }
    }
    const timer = setInterval(() => {
      if (stopped) return
      const next = measure()
      if (next) {
        const el = hintTarget(step.target)
        if (waited >= 0 && el && !(next.top >= 0 && next.top + next.height <= window.innerHeight)) el.scrollIntoView({ block: 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
        waited = -1
        setBox(prev => prev && prev.top === next.top && prev.left === next.left && prev.width === next.width && prev.height === next.height ? prev : next)
      } else if (waited >= 0) {
        waited += 150
        if (waited > 3000) {
          waited = -1
          if (step.optional) {
            const to = index + direction.current
            if (to >= 0 && to < tour.steps.length) setIndex(to); else end('completed')
          } else setBox(null)
        }
      } else setBox(null)
    }, 150)
    return () => { stopped = true; clearInterval(timer); setBox(null) }
  }, [tour, index, step, end])

  // The card takes focus at each step so a keyboard or screen-reader user lands on it; Escape ends the tour.
  useEffect(() => {
    if (!tour) return
    cardRef.current?.focus({ preventScroll: true })
    if (cardRef.current) setCard({ w: cardRef.current.offsetWidth, h: cardRef.current.offsetHeight })
  }, [tour, index])
  useEffect(() => {
    if (!tour) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); end('skipped') } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [tour, end])

  if (!tour || !step) return null
  const last = index === tour.steps.length - 1, at = place(box, card, step.placement)
  const go = (by: number) => { direction.current = by; const to = index + by; if (to >= tour.steps.length) end('completed'); else if (to >= 0) setIndex(to) }
  return <>
    <div className={`tour-dim${box ? ' has-target' : ''}`} aria-hidden="true" style={box ? { top: box.top - 6, left: box.left - 6, width: box.width + 12, height: box.height + 12 } : undefined} />
    <div ref={cardRef} className="tour-card" role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1} data-testid="tour-card" style={{ top: at.top, left: at.left }}>
      <p className="tour-progress">{tour.title} · {index + 1} / {tour.steps.length}</p>
      <h2 id={titleId}>{step.title}</h2>
      <p>{step.body}</p>
      <div className="tour-actions">
        {index > 0 && <button type="button" className="quiet" onClick={() => go(-1)}>{t('Back', 'السابق', 'Terug')}</button>}
        <button type="button" className="primary" onClick={() => go(1)}>{last ? t('Done', 'تم', 'Klaar') : t('Next', 'التالي', 'Volgende')}</button>
        {!last && <button type="button" className="quiet" onClick={() => end('skipped')}>{t('Skip tour', 'تخطّي الجولة', 'Rondleiding overslaan')}</button>}
      </div>
    </div>
  </>
}
