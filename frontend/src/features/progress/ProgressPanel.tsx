import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { TrendingUp, TrendingDown, Minus, Play, Plus, Lightbulb, Flame, AlertTriangle, ClipboardCheck } from 'lucide-react'
import { api } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { ErrorMessage, Skeleton } from '../../components/ui/Shared'
import { localDate } from '../../lib/hooks'
import { GoalJourney, HabitHeatmap } from './Journey'

type Bi = { en: string; ar: string }
type GoalHealth = { id: number; title: string; color: string; percent: number; expected_percent: number | null; days_left: number | null; status: 'completed' | 'on_track' | 'behind' | 'at_risk' | 'overdue' | 'no_deadline'; reasons: Bi[]; milestones: { done: number; total: number; next: string | null }; milestone_list?: { title: string; completed: boolean }[]; tasks: { open: number; done: number; overdue: number }; trend: { recent: number; previous: number; direction: 'up' | 'down' | 'flat' }; focus_minutes_30d: number; next_actions: { id: number; title: string }[]; suggested_tasks: { title: string }[]; recommendations: (Bi & { type: string })[] }
type ProjectHealth = { id: number; title: string; color: string; health: 'healthy' | 'attention' | 'at_risk' | 'paused'; reasons: Bi[]; open: number; overdue: number; completed_recently: number; milestones: { done: number; total: number; percent: number | null }; days_left: number | null }
type HabitInsight = { id: number; title: string; color?: string | null; recent?: string[]; consistency: number; previous_consistency: number; trend: 'up' | 'down' | 'flat'; current_streak: number; at_risk: boolean; suggestion: Bi | null }
type Progress = { goals: GoalHealth[]; projects: ProjectHealth[]; habits: HabitInsight[] }

const TrendIcon = ({ d }: { d: 'up' | 'down' | 'flat' }) => d === 'up' ? <TrendingUp size={14} /> : d === 'down' ? <TrendingDown size={14} /> : <Minus size={14} />

/**
 * Explainable health for goals, projects or habits, shown above the matching list.
 */
export function ProgressPanel({ resource, onChange }: { resource: 'goals' | 'projects' | 'habits'; onChange?: () => void }) {
  const t = useText(), { language } = useLanguage(), toast = useToast(), ar = language === 'ar', navigate = useNavigate()
  const { data, error, reload } = useApi<Progress>('/api/insights/progress')
  const [busy, setBusy] = useState('')
  const statusLabel: Record<string, string> = { completed: t('Completed', 'مكتمل'), on_track: t('On track', 'على المسار'), behind: t('Behind', 'متأخر قليلاً'), at_risk: t('At risk', 'في خطر'), overdue: t('Past deadline', 'تجاوز الموعد'), no_deadline: t('No deadline', 'بلا موعد'), healthy: t('Healthy', 'سليم'), attention: t('Needs attention', 'يحتاج اهتماماً'), paused: t('Paused', 'متوقف') }
  async function addTask(goal: GoalHealth, title: string) {
    setBusy(`${goal.id}:${title}`)
    try { await api('/api/tasks', 'POST', { title, goal_id: goal.id, status: 'todo' }); toast(t(`Added “${title}” to your tasks.`, `أُضيفت «${title}» إلى مهامك.`)); reload(); onChange?.() } catch (e) { toast((e as Error).message, 'error') } finally { setBusy('') }
  }
  // A review of the month so far opens in Copilot; its proposed next step waits for approval there.
  async function review(goal: GoalHealth) {
    setBusy(`review:${goal.id}`)
    try { const r = await api<{ conversation: { id: string } }>(`/api/goals/${goal.id}/review`, 'POST', { language }); navigate(`/assistant?c=${r.conversation.id}`) } catch (e) { toast((e as Error).message, 'error'); setBusy('') }
  }
  if (error) return <ErrorMessage error={error} />
  if (!data) return <section className="panel"><Skeleton lines={3} /></section>

  if (resource === 'goals') {
    const goals = data.goals.filter(g => g.status !== 'completed')
    if (goals.length === 0) return null
    const attention = goals.filter(g => ['at_risk', 'overdue', 'behind'].includes(g.status)).length
    return <section className="panel progress-panel reveal" aria-label={t('Goal health', 'صحة الأهداف')}>
      <header className="row"><h2>{t('Goal health', 'صحة الأهداف')}</h2><span className="muted small">{attention ? t(`${attention} need attention`, `${attention} تحتاج اهتماماً`) : t('Everything is on track', 'كل شيء على المسار')}</span></header>
      <div className="health-grid">{goals.map(g => <article key={g.id} className={`health-card status-${g.status}`}>
        <div className="row"><strong>{g.title}</strong><span className={`badge health-${g.status}`}>{statusLabel[g.status]}</span></div>
        <div className="pace" aria-label={t(`${g.percent}% done${g.expected_percent !== null ? `, ${g.expected_percent}% of time used` : ''}`, `${g.percent}٪ منجز`)}>
          <progress max={100} value={g.percent} style={{ ['--bar' as string]: g.color }} />
          {g.expected_percent !== null && <span className="pace-marker" style={{ insetInlineStart: `${g.expected_percent}%` }} title={t('Where you would be at an even pace', 'حيث يُفترض أن تكون بوتيرة ثابتة')} />}
        </div>
        <small className="muted">{g.percent}%{g.expected_percent !== null ? ` · ${t(`${g.expected_percent}% of time used`, `${g.expected_percent}٪ من الوقت`)}` : ''}{g.milestones.total ? ` · ${g.milestones.done}/${g.milestones.total} ${t('milestones', 'مراحل')}` : ''}{g.days_left !== null && g.days_left >= 0 ? ` · ${t(`${g.days_left} days left`, `متبقٍ ${g.days_left} يوماً`)}` : ''}</small>
        {g.milestone_list && <GoalJourney milestones={g.milestone_list} color={g.color} />}
        <ul className="reasons">{g.reasons.map((r, i) => <li key={i}>{ar ? r.ar : r.en}</li>)}<li className="trend"><TrendIcon d={g.trend.direction} />{t(`${g.trend.recent} task(s) done in 14 days (previously ${g.trend.previous})`, `${g.trend.recent} مهمة خلال ١٤ يوماً (سابقاً ${g.trend.previous})`)}</li></ul>
        {g.next_actions[0] && <Link className="next-action" to={`/focus?task=${g.next_actions[0].id}`}><Play size={14} />{t('Next:', 'التالي:')} {g.next_actions[0].title}</Link>}
        {g.recommendations.map((r, i) => <p key={i} className="recommendation"><Lightbulb size={14} />{ar ? r.ar : r.en}</p>)}
        <button className="quiet review-goal" disabled={busy !== ''} onClick={() => void review(g)} aria-label={t(`Review “${g.title}” this month`, `راجع «${g.title}» لهذا الشهر`)}><ClipboardCheck size={15} />{busy === `review:${g.id}` ? t('Reviewing…', 'جارٍ المراجعة…') : t('Review this month', 'مراجعة هذا الشهر')}</button>
        {g.suggested_tasks.length > 0 && <div className="suggested"><small className="muted">{t('From your milestones:', 'من مراحلك:')}</small>{g.suggested_tasks.map(s => <button key={s.title} className="chip-button" disabled={busy !== ''} onClick={() => void addTask(g, s.title)}><Plus size={13} />{s.title}</button>)}</div>}
      </article>)}</div>
    </section>
  }

  if (resource === 'projects') {
    if (data.projects.length === 0) return null
    return <section className="panel progress-panel reveal" aria-label={t('Project health', 'صحة المشاريع')}>
      <h2>{t('Project health', 'صحة المشاريع')}</h2>
      <ul className="health-list">{data.projects.map(p => <li key={p.id}>
        <span className="dot" style={{ background: p.color }} aria-hidden="true" />
        <div><Link to={`/projects/${p.id}`}><strong>{p.title}</strong></Link><small className="muted">{p.reasons.map(r => ar ? r.ar : r.en).join(' ')}</small></div>
        <span className="muted small">{p.milestones.percent !== null ? `${p.milestones.percent}% ${t('milestones', 'مراحل')}` : `${p.open} ${t('open', 'مفتوحة')}`}</span>
        <span className={`badge health-${p.health}`}>{p.health === 'at_risk' && <AlertTriangle size={12} />}{statusLabel[p.health]}</span>
      </li>)}</ul>
    </section>
  }

  if (data.habits.length === 0) return null
  return <section className="panel progress-panel reveal" aria-label={t('Habit consistency', 'الالتزام بالعادات')}>
    <h2>{t('Habit consistency · last 30 days', 'الالتزام بالعادات · آخر ٣٠ يوماً')}</h2>
    <ul className="health-list">{data.habits.map(h => <li key={h.id}>
      <div><strong>{h.title}</strong>{h.recent && <HabitHeatmap dates={h.recent} color={h.color} today={localDate()} />}{h.suggestion && <small className="muted">{ar ? h.suggestion.ar : h.suggestion.en}</small>}</div>
      <span className="streak-pill"><Flame size={13} />{h.current_streak}</span>
      <span className={`trend-pill trend-${h.trend}`}><TrendIcon d={h.trend} />{h.consistency}%</span>
      {h.at_risk && <span className="badge health-at_risk">{t('Streak at risk', 'السلسلة في خطر')}</span>}
    </li>)}</ul>
  </section>
}
