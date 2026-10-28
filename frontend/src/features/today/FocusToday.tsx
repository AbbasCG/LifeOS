import { useState } from 'react'
import { Clock, Flame, Play, Target } from 'lucide-react'
import { api } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { useStartFocus } from '../../lib/useStartFocus'
import { minutesLabel } from '../../lib/dates'
import { BottomSheet, ProgressRing } from '../../components/visual'
import { Skeleton } from '../../components/ui/Shared'

type FocusToday = { today_minutes: number; goal_minutes: number | null; goal_streak_days: number; streak_days: number; best_hour: number | null; best_hour_minutes: number }
const GOALS = [30, 60, 90, 120, 180, 240]

/**
 * Focus at a glance (V24): minutes today against a daily goal the user sets, the focus-day streak, the goal streak
 * and the hour of the day they focus best. All from their own sessions; the goal is a target, never a limit.
 */
export function FocusToday() {
  const t = useText(), { language } = useLanguage(), focus = useStartFocus()
  const stats = useApi<FocusToday>('/api/focus-sessions/today')
  const [editing, setEditing] = useState(false)
  if (!stats.data) return <section className="panel focus-today"><Skeleton lines={2} /></section>
  const { today_minutes: today, goal_minutes: goal, streak_days: streak, goal_streak_days: goalStreak, best_hour: best } = stats.data
  const ar = language === 'ar'
  const hour = best === null ? null : new Date(2027, 0, 1, best).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
  return <section className="panel focus-today" aria-labelledby="focus-today-title">
    <header className="row"><h2 id="focus-today-title">{t('Focus', 'التركيز')}</h2>
      <button type="button" className="icon-button" disabled={focus.busy} onClick={() => void focus.go()} aria-label={t('Start focus', 'ابدأ التركيز')}><Play size={17} /></button></header>
    <div className="focus-today-body">
      <button type="button" className="focus-goal" onClick={() => setEditing(true)} aria-label={goal ? t(`${today} of ${goal} minutes today. Change daily goal`, `${today} من ${goal} دقيقة اليوم. تغيير الهدف اليومي`) : t(`${today} minutes today. Set a daily goal`, `${today} دقيقة اليوم. حدّد هدفاً يومياً`)}>
        <ProgressRing value={today} max={goal ?? Math.max(today, 1)} size={76} stroke={8} tone={goal && today >= goal ? 'success' : 'primary'} label={goal ? t(`${today} of ${goal} minutes`, `${today} من ${goal} دقيقة`) : t(`${today} minutes`, `${today} دقيقة`)}>
          <strong>{minutesLabel(today, ar)}</strong>
        </ProgressRing>
        <small>{goal ? t(`of ${minutesLabel(goal, ar)}`, `من ${minutesLabel(goal, ar)}`) : t('Set a goal', 'حدّد هدفاً')}</small>
      </button>
      <ul className="focus-facts">
        <li><Flame size={15} aria-hidden="true" />{streak ? t(`${streak}-day focus streak`, `${streak} يوم تركيز متتالٍ`) : t('No streak yet', 'لا سلسلة بعد')}</li>
        {goal !== null && <li><Target size={15} aria-hidden="true" />{goalStreak ? t(`Goal met ${goalStreak} day(s) in a row`, `بلغت الهدف ${goalStreak} يوم متتالٍ`) : today >= goal ? t('Goal met today', 'بلغت الهدف اليوم') : t(`${goal - today} min to go`, `بقي ${goal - today} د`)}</li>}
        {hour && <li><Clock size={15} aria-hidden="true" />{t(`Best hour: ${hour}`, `أفضل ساعة: ${hour}`)}</li>}
      </ul>
    </div>
    {editing && <GoalSheet goal={goal} onClose={() => setEditing(false)} onSaved={stats.reload} />}
  </section>
}

function GoalSheet({ goal, onClose, onSaved }: { goal: number | null; onClose: () => void; onSaved: () => void }) {
  const t = useText(), toast = useToast(), { language } = useLanguage()
  const [busy, setBusy] = useState(false)
  async function save(value: number | null) {
    setBusy(true)
    try {
      await api('/api/settings', 'PUT', { daily_focus_goal: value })
      toast(value ? t('Daily focus goal saved.', 'حُفظ هدف التركيز اليومي.') : t('Daily focus goal removed.', 'أُزيل هدف التركيز اليومي.'))
      onSaved(); onClose()
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(false) }
  }
  return <BottomSheet title={t('Daily focus goal', 'هدف التركيز اليومي')} onClose={onClose}>
    <p className="muted small">{t('A target to aim for, not a limit. Breaks don’t count.', 'هدف تسعى إليه وليس حداً. الاستراحات لا تُحتسب.')}</p>
    <div className="chip-row" role="radiogroup" aria-label={t('Minutes per day', 'دقائق في اليوم')}>
      {GOALS.map(m => <button key={m} type="button" role="radio" aria-checked={goal === m} className="filter-chip" disabled={busy} onClick={() => void save(m)}>{minutesLabel(m, language === 'ar')}</button>)}
    </div>
    {goal !== null && <button type="button" className="quiet" disabled={busy} onClick={() => void save(null)}>{t('No goal', 'بلا هدف')}</button>}
  </BottomSheet>
}
