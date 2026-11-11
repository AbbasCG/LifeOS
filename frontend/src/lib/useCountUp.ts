import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** True when the person asked for less motion; every animation here then snaps to its end state. */
export const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * Counts a number up (or down) to its new value, but only when the value CHANGES after the first mount; the first value is simply shown.
 * The frames write `textContent` from requestAnimationFrame, so React never re-renders for them. Under reduced motion the new value is written at once.
 * `delta` is the signed change since the previous value, kept for about six seconds, so a short "+3" can say what changed without any motion.
 */
export function useCountUp(value: number, hold = 6000) {
  const ref = useRef<HTMLSpanElement>(null), shown = useRef(value), first = useRef(true), frame = useRef(0)
  const [seen, setSeen] = useState(value), [delta, setDelta] = useState(0)
  if (value !== seen) { setSeen(value); setDelta(value - seen) }
  useLayoutEffect(() => {
    const node = ref.current, from = shown.current
    if (!node) return
    const done = () => { shown.current = value; node.textContent = String(value) }
    if (first.current || from === value || prefersReducedMotion()) { first.current = false; done(); return }
    const span = Math.min(700, 320 + 40 * Math.abs(value - from)), start = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / span)
      if (p >= 1) return done()
      shown.current = Math.round(from + (value - from) * (1 - (1 - p) ** 3))
      node.textContent = String(shown.current)
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [value])
  useEffect(() => { if (!delta) return; const id = setTimeout(() => setDelta(0), hold); return () => clearTimeout(id) }, [delta, hold])
  return { ref, delta }
}
