import { m, useReducedMotion } from 'motion/react'
import { Check } from 'lucide-react'
import { useText } from '../../lib/i18n'

/**
 * A goal as a journey: each milestone is a stop on the path; finished stretches fill in, the next stop pulses.
 */
export function GoalJourney({ milestones, color }: { milestones: { title: string; completed: boolean }[]; color: string }) {
  const t = useText()
  if (milestones.length === 0) return null
  const next = milestones.findIndex(stone => !stone.completed)
  const done = milestones.filter(stone => stone.completed).length
  return <div className="goal-journey-wrap" style={{ ['--goal-color' as string]: color }}>
    <ol className="goal-journey" aria-label={t(`Milestones: ${done} of ${milestones.length} done`, `المراحل: ${done} من ${milestones.length}`)}>
      {milestones.map((stone, i) => {
        const fill = stone.completed && milestones[i + 1]?.completed ? 1 : stone.completed ? 0.5 : 0
        return <li key={`${i}-${stone.title}`} className={stone.completed ? 'done' : i === next ? 'next' : ''}>
          <span className="node" title={stone.title}>{stone.completed ? <Check size={13} /> : i + 1}<span className="label">{stone.title}</span></span>
          <span className="sr-only">{stone.completed ? t('done', 'منجز') : i === next ? t('next', 'التالي') : t('later', 'لاحقاً')}</span>
          {i < milestones.length - 1 && <span className="path" aria-hidden="true"><m.span initial={{ scaleX: 0 }} animate={{ scaleX: fill }} transition={{ type: 'spring', stiffness: 120, damping: 22, delay: 0.1 + i * 0.08 }} /></span>}
        </li>
      })}
    </ol>
  </div>
}

/** Last 12 weeks of a habit, one square per day (weeks as columns, Monday first). */
export function HabitHeatmap({ dates, color, today }: { dates: string[]; color?: string | null; today: string }) {
  const t = useText()
  const done = new Set(dates)
  const end = new Date(`${today}T12:00:00`)
  const start = new Date(end); start.setDate(start.getDate() - 83)
  const lead = (start.getDay() + 6) % 7
  const days = Array.from({ length: 84 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })
  const count = days.filter(d => done.has(d)).length
  return <div className="habit-heatmap" role="img" aria-label={t(`Done on ${count} of the last 84 days`, `أُنجزت في ${count} من آخر ٨٤ يوماً`)} style={{ ['--habit-color' as string]: color ?? undefined }}>
    {Array.from({ length: lead }, (_, i) => <span key={`pad-${i}`} style={{ visibility: 'hidden' }} />)}
    {days.map(d => <span key={d} className={`${done.has(d) ? 'on' : ''} ${d === today ? 'today' : ''}`} title={d} />)}
  </div>
}

/** A short burst of particles when a habit is ticked off; nothing is rendered for reduced motion. */
export function HabitBurst() {
  const reduced = useReducedMotion()
  if (reduced) return null
  return <span className="habit-burst" aria-hidden="true">{Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2
    return <m.i key={i} initial={{ x: 0, y: 0, opacity: 1, scale: 1 }} animate={{ x: Math.cos(a) * 26, y: Math.sin(a) * 26, opacity: 0, scale: 0.4 }} transition={{ duration: 0.6, ease: 'easeOut' }} />
  })}</span>
}
