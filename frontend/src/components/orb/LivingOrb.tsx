import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useReducedMotion } from 'motion/react'
import { useTheme } from '../../contexts/ThemeContext'
import type { OrbHandle, OrbMode } from '../../lib/orb/renderer'

const PALETTES = {
  light: ['#5b5ef0', '#14b8c4', '#a855f7'],
  dark: ['#7c80ff', '#2ee6d6', '#c084fc'],
} as const

type Props = {
  /** 0–1: fills the orb and lights the orbiting particles. */
  progress: number
  mode?: OrbMode
  /** Accessible description of what the orb shows, e.g. "Today: 40% done". */
  label: string
  size?: number | string
  className?: string
  /** Allow drag / arrow keys / tap. */
  interactive?: boolean
}

/**
 * The LifeOS orb. Renders a real-time WebGL scene (loaded on demand) and keeps a same-size CSS sphere as the fallback
 * for browsers without WebGL, lost contexts and server-side render, so the layout never shifts.
 */
export function LivingOrb({ progress, mode = 'idle', label, size = 220, className = '', interactive = true }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null), handle = useRef<OrbHandle | null>(null)
  const [live, setLive] = useState(false)
  const reduced = useReducedMotion() ?? false
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === 'dark'
  const latest = useRef({ progress, mode, dark })
  useEffect(() => { latest.current = { progress, mode, dark } })

  useEffect(() => {
    let cancelled = false
    void import('../../lib/orb/renderer').then(({ createOrb, webglAvailable }) => {
      if (cancelled || !canvas.current || !webglAvailable()) return
      const { progress: p, mode: m, dark: d } = latest.current
      const orb = createOrb(canvas.current, { progress: p, mode: m, dark: d, palette: [...PALETTES[d ? 'dark' : 'light']] }, { reducedMotion: reduced, onLost: () => { handle.current = null; setLive(false) } })
      if (!orb) return
      handle.current = orb
      setLive(true)
    }).catch(() => { /* keep the CSS fallback */ })
    return () => { cancelled = true; handle.current?.destroy(); handle.current = null }
  }, [reduced])

  useEffect(() => { handle.current?.update({ progress, mode, dark, palette: [...PALETTES[dark ? 'dark' : 'light']] }) }, [progress, mode, dark, live])

  function onKey(e: KeyboardEvent) {
    const step = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, -0.03], ArrowDown: [0, 0.03] }[e.key]
    if (step) { e.preventDefault(); handle.current?.nudge(step[0], step[1]) }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handle.current?.pulse() }
  }
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100)
  return <div className={`living-orb mode-${mode} ${live ? 'is-live' : ''} ${className}`} style={{ width: size, height: size, ['--orb-progress' as string]: `${pct}%` }}
    role="img" aria-label={label} tabIndex={interactive && live ? 0 : undefined} onKeyDown={interactive ? onKey : undefined}>
    <div className="orb-fallback" aria-hidden="true"><span /></div>
    <canvas ref={canvas} aria-hidden="true" onClick={() => interactive && handle.current?.pulse()} style={{ pointerEvents: interactive ? 'auto' : 'none' }} />
  </div>
}
