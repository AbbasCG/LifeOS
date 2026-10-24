import { useState } from 'react'
import { Link } from 'react-router'
import { CalendarPlus, ArrowRight, CheckCircle2, X, Lightbulb, Clock, ListPlus, CalendarClock } from 'lucide-react'
import { api, type AssistantProposal } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { ErrorMessage } from '../../components/ui/Shared'

/**
 * Reviewable changes suggested by the assistant. Nothing changes until the user approves specific items.
 */
export function ProposalCard({ proposal: initial }: { proposal: AssistantProposal }) {
  const t = useText(), { language } = useLanguage(), toast = useToast()
  const [proposal, setProposal] = useState(initial), [selected, setSelected] = useState<string[]>(initial.actions.map(a => a.id))
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const open = proposal.status === 'pending'
  const day = (iso: string) => new Date(iso).toLocaleDateString(language, { weekday: 'short', day: 'numeric', month: 'short' })
  const time = (iso: string) => new Date(iso).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
  const range = (start: string, end: string) => `${day(start)} · ${time(start)}–${time(end)}`
  const taskKind = proposal.kind === 'goal_plan' || proposal.kind === 'triage'
  const dueLabel = (iso: string) => `${day(iso)} · ${time(iso)}`
  const toggle = (id: string) => setSelected(list => list.includes(id) ? list.filter(x => x !== id) : [...list, id])

  async function run(path: 'apply' | 'dismiss') {
    setBusy(true); setError('')
    try {
      const next = await api<AssistantProposal>(`/api/assistant/proposals/${proposal.id}/${path}`, 'POST', path === 'apply' ? { action_ids: selected } : undefined)
      setProposal(next)
      if (path === 'apply') toast(taskKind
        ? t(`${next.results?.length ?? 0} task change(s) applied.`, `طُبّق ${next.results?.length ?? 0} تغيير على المهام.`)
        : t(`${next.results?.length ?? 0} change(s) applied to your calendar.`, `طُبّق ${next.results?.length ?? 0} تغيير على تقويمك.`))
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  if (proposal.actions.length === 0) return null
  const verb = proposal.kind === 'rebalance' ? t('Move', 'انقل') : t('Add', 'أضف')
  const heading = { rebalance: t('Suggested changes', 'تغييرات مقترحة'), goal_plan: t('Proposed tasks', 'مهام مقترحة'), triage: t('New deadlines', 'مواعيد جديدة'), find_time: t('Time found for your tasks', 'وقت مقترح لمهامك') }[proposal.kind] ?? t('Proposed schedule', 'جدول مقترح')
  const applyLabel = proposal.kind === 'goal_plan' ? t(`Create ${selected.length} task(s)`, `أنشئ ${selected.length} مهمة`) : proposal.kind === 'triage' ? t(`Reschedule ${selected.length} task(s)`, `أعد جدولة ${selected.length} مهمة`) : `${verb} ${selected.length} ${t('to calendar', 'إلى التقويم')}`
  return <div className={`proposal-card state-${proposal.status}`}>
    <div className="proposal-head">
      <strong>{heading}</strong>
      <span className={`badge proposal-${proposal.status}`}>{{ pending: t('Needs your approval', 'بانتظار موافقتك'), applied: t('Applied', 'طُبّق'), dismissed: t('Dismissed', 'رُفض'), expired: t('Expired', 'منتهي') }[proposal.status]}</span>
    </div>
    <ul className="proposal-actions">
      {proposal.actions.map(action => {
        const done = proposal.results?.some(r => r.action_id === action.id)
        return <li key={action.id} className={done ? 'done' : ''}>
          <label>
            {open ? <input type="checkbox" checked={selected.includes(action.id)} onChange={() => toggle(action.id)} /> : done ? <CheckCircle2 size={16} className="ok" /> : <span className="dot" />}
            <span className="proposal-title">{action.title}</span>
          </label>
          <span className="proposal-time">
            {action.type === 'create_task' && <><ListPlus size={13} />{action.estimated_minutes} {t('min', 'د')}{action.due_at && <> · {t('due', 'الموعد')} {dueLabel(action.due_at)}</>}</>}
            {action.type === 'reschedule_task' && action.due_at && <>{action.from_due_at && <><s>{dueLabel(action.from_due_at)}</s><ArrowRight size={13} className="flip-rtl" /></>}<CalendarClock size={13} />{dueLabel(action.due_at)}</>}
            {action.type === 'move_event' && action.from_starts_at && action.from_ends_at && <><s>{range(action.from_starts_at, action.from_ends_at)}</s><ArrowRight size={13} className="flip-rtl" /></>}
            {action.starts_at && action.ends_at && <><Clock size={13} />{range(action.starts_at, action.ends_at)}</>}
          </span>
        </li>
      })}
    </ul>
    {proposal.explanation.length > 0 && <details className="proposal-why" open={open}>
      <summary><Lightbulb size={14} />{t('Why this plan', 'لماذا هذه الخطة')}</summary>
      <ul>{proposal.explanation.map((line, i) => <li key={i}>{line}</li>)}</ul>
    </details>}
    <ErrorMessage error={error} />
    {open && <div className="toolbar">
      <button className="primary" disabled={busy || selected.length === 0} onClick={() => void run('apply')}>{taskKind ? <ListPlus size={16} /> : <CalendarPlus size={16} />}{applyLabel}</button>
      <button className="quiet" disabled={busy} onClick={() => void run('dismiss')}><X size={16} />{t('Not now', 'ليس الآن')}</button>
    </div>}
    {proposal.status === 'applied' && (taskKind ? <Link className="quiet" to="/tasks">{t('Open tasks', 'فتح المهام')}</Link> : <Link className="quiet" to="/calendar">{t('Open calendar', 'فتح التقويم')}</Link>)}
    {open && <p className="muted small">{taskKind
      ? t('Nothing changes until you approve. Each task is re-checked when you apply, and stale suggestions are refused.', 'لن يتغير شيء قبل موافقتك. يُعاد التحقق من كل مهمة عند التطبيق، وتُرفض الاقتراحات القديمة.')
      : t('Nothing changes until you approve. Times are re-checked against your calendar when you apply.', 'لن يتغير شيء قبل موافقتك. يُعاد التحقق من الأوقات مقابل تقويمك عند التطبيق.')}</p>}
  </div>
}
