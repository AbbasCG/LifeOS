import type { ReorganizeHint } from './api'

/** Asks Today to open the "Reorganize my day" preview (from the card, the permanent action, or anything else). */
export const REORGANIZE_DAY = 'lifeos:reorganize-day'
export const openReorganize = () => window.dispatchEvent(new Event(REORGANIZE_DAY))

/** True when the day has slipped: something was missed, work is due without a session, or the rest of today is overbooked. */
export const hasSlipped = (hint?: ReorganizeHint | null) => !!hint && (hint.missed > 0 || hint.due_unscheduled > 0 || hint.overloaded)

type Words = (en: string, ar: string, nl?: string) => string
/** "Your day slipped: 2 sessions missed, 1 task due without time. Reorganize?" built from the hint's counts. */
export function slippedText(hint: ReorganizeHint, t: Words): string {
  const parts: string[] = []
  const { missed: m, due_unscheduled: d } = hint
  if (m > 0) parts.push(t(`${m} ${m === 1 ? 'session' : 'sessions'} missed`, `${m} ${m === 1 ? 'جلسة فائتة' : 'جلسات فائتة'}`, `${m} ${m === 1 ? 'sessie' : 'sessies'} gemist`))
  if (d > 0) parts.push(t(`${d} ${d === 1 ? 'task' : 'tasks'} due without time`, `${d} ${d === 1 ? 'مهمة مستحقة' : 'مهام مستحقة'} بلا وقت`, `${d} ${d === 1 ? 'taak' : 'taken'} met deadline zonder tijd`))
  if (hint.overloaded) parts.push(t('the rest of today is overbooked', 'ما تبقى من اليوم مزدحم', 'de rest van vandaag zit overvol'))
  return t(`Your day slipped: ${parts.join(', ')}. Reorganize?`, `انزلق يومك: ${parts.join('، ')}. أعد التنظيم؟`, `Je dag is uitgelopen: ${parts.join(', ')}. Herorganiseren?`)
}
