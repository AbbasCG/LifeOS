import { useEffect } from 'react'
import { useReducedMotion } from 'motion/react'

/**
 * The calm light field behind every screen. Pointer position and scroll drift the light slightly (parallax) through CSS
 * variables, throttled to one update per animation frame; nothing moves when the user prefers reduced motion.
 */
export default function AmbientBackground() {
  const reduced = useReducedMotion()
  useEffect(() => {
    if (reduced) return
    const root = document.documentElement
    let frame = 0, mx = 0, my = 0
    const apply = () => {
      frame = 0
      root.style.setProperty('--mx', mx.toFixed(3))
      root.style.setProperty('--my', my.toFixed(3))
      root.style.setProperty('--sy', Math.min(1, window.scrollY / 900).toFixed(3))
    }
    const queue = () => { if (!frame) frame = requestAnimationFrame(apply) }
    const onPointer = (e: PointerEvent) => { if (e.pointerType !== 'mouse') return; mx = e.clientX / window.innerWidth * 2 - 1; my = e.clientY / window.innerHeight * 2 - 1; queue() }
    window.addEventListener('pointermove', onPointer, { passive: true })
    window.addEventListener('scroll', queue, { passive: true })
    return () => { window.removeEventListener('pointermove', onPointer); window.removeEventListener('scroll', queue); if (frame) cancelAnimationFrame(frame) }
  }, [reduced])
  return <div className="ambient" aria-hidden="true"><i /><i /><i /></div>
}
