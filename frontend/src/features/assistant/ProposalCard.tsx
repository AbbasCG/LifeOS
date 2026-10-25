import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { CalendarPlus, ArrowRight, CheckCircle2, X, Lightbulb, Clock, ListPlus, CalendarClock, Undo2, LayoutTemplate } from 'lucide-react'
import { api, type AssistantProposal } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { ErrorMessage } from '../../components/ui/Shared'
import { TEMPLATES_CHANGED } from '../../lib/copilot'

/**
 * Reviewable changes suggested by the assistant. Nothing changes until the user approves specific items.
 */
export function ProposalCard({ proposal: initial }: { proposal: AssistantProposal }) {
  const t = useText(), { language } = useLanguage(), toast = useToast()
  const [proposal, setProposal] = useState(initial), [selected, setSelected] = useState<string[]>(initial.actions.map(a => a.id))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [naming, setNaming] = useState(false), [templateName, setTemplateName] = useState('')
  const open = proposal.status === 'pending'
  const day = (iso: string) => new Date(iso).toLocaleDateString(language, { weekday: 'short', day: 'numeric', month: 'short' })
  const time = (iso: string) => new Date(iso).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
  const range = (start: string, end: string) => `${day(start)} · ${time(start)}–${time(end)}`
  const taskKind = proposal.kind === 'goal_plan' || proposal.kind === 'triage'
  const dueLabel = (iso: string) => `${day(iso)} · ${time(iso)}`
  const toggle = (id: string) => setSelected(list => list.includes(id) ? list.filter(x => x !== id) : [...list, id])

  async function run(path: 'apply' | 'dismiss' | 'undo') {
    setBusy(true); setError('')
    try {
      const next = await api<AssistantProposal>(`/api/assistant/proposals/${proposal.id}/${path}`, 'POST', path === 'apply' ? { action_ids: selected } : undefined)
      setProposal(next)
      if (path === 'apply') toast(taskKind
        ? t(`${next.results?.length ?? 0} task change(s) applied.`, `طُبّق ${next.results?.length ?? 0} تغيير على المهام.`)
        : t(`${next.results?.length ?? 0} change(s) applied to your calendar.`, `طُبّق ${next.results?.length ?? 0} تغيير على تقويمك.`))
      if (path === 'undo') {
        const kept = next.results?.filter(r => r.undo && !r.undo.done).length ?? 0
        toast(kept ? t(`Undone, except ${kept} change(s) you edited since — those were kept.`, `تم التراجع، باستثناء ${kept} تغيير عدّلته لاحقاً — أُبقي عليها.`) : t('All changes undone.', 'تم التراجع عن كل التغييرات.'))
      }
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function saveTemplate(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await api('/api/copilot/templates', 'POST', { proposal_id: proposal.id, name: templateName.trim() })
      setNaming(false); setTemplateName('')
      window.dispatchEvent(new Event(TEMPLATES_CHANGED))
      toast(t('Saved as a week template. Use it from the Copilot sidebar.', 'حُفظ كقالب أسبوعي. استخدمه من الشريط الجانبي للمساعد.'))
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  if (proposal.actions.length === 0) return null
  const canTemplate = proposal.actions.some(a => a.type === 'create_event') && proposal.kind !== 'template'
  const chosen = proposal.actions.filter(a => selected.includes(a.id)), mixed = chosen.some(a => a.type === 'move_event') && chosen.some(a => a.type === 'create_event')
  const verb = proposal.kind === 'rebalance' || (chosen.length > 0 && chosen.every(a => a.type === 'move_event')) ? t('Move', 'انقل') : t('Add', 'أضف')
  const heading = { rebalance: t('Suggested changes', 'تغييرات مقترحة'), goal_plan: t('Proposed tasks', 'مهام مقترحة'), triage: t('New deadlines', 'مواعيد جديدة'), find_time: t('Time found for your tasks', 'وقت مقترح لمهامك'), template: t('Week from your template', 'أسبوع من قالبك'), plan_week: t('Proposed week plan', 'خطة الأسبوع المقترحة'), prioritize: t('Your priorities, planned first', 'أولوياتك مخططة أولاً'), focus_blocks: t('Proposed focus blocks', 'فترات تركيز مقترحة'), reorganize_day: t('Reorganized day', 'يوم مُعاد تنظيمه') }[proposal.kind] ?? t('Proposed schedule', 'جدول مقترح')
  const applyLabel = proposal.kind === 'goal_plan' ? t(`Create ${selected.length} task(s)`, `أنشئ ${selected.length} مهمة`) : proposal.kind === 'triage' ? t(`Reschedule ${selected.length} task(s)`, `أعد جدولة ${selected.length} مهمة`) : mixed ? t(`Apply ${selected.length} change(s)`, `طبّق ${selected.length} تغيير`) : `${verb} ${selected.length} ${t('to calendar', 'إلى التقويم')}`
  return <div className={`proposal-card state-${proposal.status}`}>
    <div className="proposal-head">
      <strong>{heading}</strong>
      <span className={`badge proposal-${proposal.status}`}>{{ pending: t('Needs your approval', 'بانتظار موافقتك'), applied: t('Applied', 'طُبّق'), undone: t('Undone', 'تم التراجع'), dismissed: t('Dismissed', 'رُفض'), expired: t('Expired', 'منتهي') }[proposal.status]}</span>
    </div>
    <ul className="proposal-actions">
      {proposal.actions.map(action => {
        const result = proposal.results?.find(r => r.action_id === action.id), done = Boolean(result) && proposal.status !== 'undone'
        const keptReason = result?.undo && !result.undo.done ? ({ 'changed since': t('kept — you changed it', 'أُبقي — عدّلته'), 'in use since': t('kept — already in use', 'أُبقي — قيد الاستخدام'), 'original time is taken': t('kept — the original time is now taken', 'أُبقي — الوقت الأصلي مشغول الآن'), 'already deleted': t('already deleted', 'محذوف مسبقاً') } as Record<string, string>)[result.undo.reason ?? ''] ?? t('kept', 'أُبقي') : null
        return <li key={action.id} className={`${done ? 'done' : ''} ${result?.undo?.done ? 'reverted' : ''}`}>
          <label>
            {open ? <input type="checkbox" checked={selected.includes(action.id)} onChange={() => toggle(action.id)} /> : done ? <CheckCircle2 size={16} className="ok" /> : <span className="dot" />}
            <span className="proposal-title">{action.title}</span>
            {keptReason && <small className="chip">{keptReason}</small>}
            {action.type === 'move_event' && proposal.kind !== 'rebalance' && <small className="chip move-chip">{t('Moves an existing block', 'ينقل فترة قائمة')}</small>}
          </label>
          {action.type === 'move_event' && (action.reason || action.conflicts) && <span className="move-detail">
            {action.reason && <small className="muted">{action.reason}</small>}
            {action.conflicts && (action.conflicts.length === 0
              ? <small className="conflict-check ok"><CheckCircle2 size={12} />{t('No conflicts at the new time', 'لا تعارض في الوقت الجديد')}</small>
              : <small className="conflict-check warn">{t('Overlaps', 'يتداخل مع')}: {action.conflicts.map(c => `${c.title} (${c.source_label})`).join(', ')}</small>)}
          </span>}
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
    {canTemplate && (naming
      ? <form className="template-save" onSubmit={e => void saveTemplate(e)}>
        <label className="sr-only" htmlFor={`template-${proposal.id}`}>{t('Template name', 'اسم القالب')}</label>
        <input id={`template-${proposal.id}`} value={templateName} maxLength={80} required autoFocus onChange={e => setTemplateName(e.target.value)} placeholder={t('Template name, e.g. Deep work week', 'اسم القالب، مثلاً أسبوع العمل العميق')} />
        <button className="primary" disabled={busy || !templateName.trim()}>{t('Save template', 'حفظ القالب')}</button>
        <button type="button" className="quiet" onClick={() => setNaming(false)}>{t('Cancel', 'إلغاء')}</button>
      </form>
      : <button type="button" className="quiet save-template" disabled={busy} onClick={() => setNaming(true)}><LayoutTemplate size={15} />{t('Save as template', 'حفظ كقالب')}</button>)}
    {proposal.undo_until && <div className="toolbar"><button className="quiet" disabled={busy} onClick={() => void run('undo')}><Undo2 size={16} />{t('Undo these changes', 'التراجع عن هذه التغييرات')}</button>
      <small className="muted">{t(`Available until ${dueLabel(proposal.undo_until)}. Anything you edited since is kept.`, `متاح حتى ${dueLabel(proposal.undo_until)}. يُحتفظ بكل ما عدّلته لاحقاً.`)}</small></div>}
    {proposal.status === 'applied' && (taskKind ? <Link className="quiet" to="/tasks">{t('Open tasks', 'فتح المهام')}</Link> : <Link className="quiet" to="/calendar">{t('Open calendar', 'فتح التقويم')}</Link>)}
    {open && <p className="muted small">{taskKind
      ? t('Nothing changes until you approve. Each task is re-checked when you apply, and stale suggestions are refused.', 'لن يتغير شيء قبل موافقتك. يُعاد التحقق من كل مهمة عند التطبيق، وتُرفض الاقتراحات القديمة.')
      : t('Nothing changes until you approve. Times are re-checked against your calendar when you apply.', 'لن يتغير شيء قبل موافقتك. يُعاد التحقق من الأوقات مقابل تقويمك عند التطبيق.')}</p>}
  </div>
}
