import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Sparkles, CalendarClock, Trash2, Plus, AlertTriangle, RotateCcw, Check, X, Pencil, Hand, Target, Lightbulb } from 'lucide-react'
import { api, ApiError, type MissedBlock, type Plan, type PlanItem, type PlannedVsActual, type RecordItem } from '../lib/api'
import { localDate, localInput } from '../lib/hooks'
import { addDays, minutesLabel, mondayOf } from '../lib/dates'
import { useApi } from '../lib/useApi'
import { useText } from '../lib/i18n'
import { useLanguage } from '../contexts/LanguageContext'
import { useToast } from '../lib/toast'
import { useStatusLabel } from './ResourcePage'
import { Dialog, EmptyState, ErrorMessage, Skeleton } from '../components/ui/Shared'

type Horizon = 'today' | 'week' | 'next_week'
type Draft = PlanItem & { error?: string }

export function PlannedActualBars({ data }: { data: PlannedVsActual }) {
  const t = useText(), { language } = useLanguage(), ar = language === 'ar'
  const max = Math.max(1, ...data.days.flatMap(d => [d.planned_minutes, d.actual_minutes]))
  return <div className="pva">
    <div className="pva-legend" aria-hidden="true"><span><i className="swatch" style={{ background: 'var(--chart-1)' }} />{t('Planned', 'مخطط')}</span><span><i className="swatch" style={{ background: 'var(--chart-2)' }} />{t('Actual focus', 'تركيز فعلي')}</span></div>
    <ul className="pva-days">{data.days.map(day => <li key={day.date} title={`${day.date}: ${day.planned_minutes} / ${day.actual_minutes}`}>
      <span className="pva-label">{new Date(`${day.date}T12:00`).toLocaleDateString(language, { weekday: 'short' })}</span>
      <div className="pva-bars"><div className="pva-bar planned" style={{ width: `${day.planned_minutes / max * 100}%` }} /><div className="pva-bar actual" style={{ width: `${day.actual_minutes / max * 100}%` }} /></div>
      <span className="pva-value">{minutesLabel(day.planned_minutes, ar)} · {minutesLabel(day.actual_minutes, ar)}</span>
    </li>)}</ul>
    <p className="muted">{data.totals.planned_minutes ? t(`${minutesLabel(data.totals.actual_minutes, false)} of ${minutesLabel(data.totals.planned_minutes, false)} planned (${Math.round((data.totals.ratio ?? 0) * 100)}%) · ${data.totals.completed_planned_tasks}/${data.totals.planned_tasks} planned tasks done`, `${minutesLabel(data.totals.actual_minutes, true)} من ${minutesLabel(data.totals.planned_minutes, true)} مخطط (${Math.round((data.totals.ratio ?? 0) * 100)}٪) · ${data.totals.completed_planned_tasks}/${data.totals.planned_tasks} مهام مخططة منجزة`) : t('No planned blocks in this week yet.', 'لا توجد فترات مخططة هذا الأسبوع بعد.')}</p>
  </div>
}

export default function PlanningPage() {
  const t = useText(), { language } = useLanguage(), ar = language === 'ar', label = useStatusLabel(), toast = useToast()
  const [horizon, setHorizon] = useState<Horizon>('week'), [allWarnings, setAllWarnings] = useState(false)
  const [plan, setPlan] = useState<Plan | null>(null), [draft, setDraft] = useState<Draft[]>([]), [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [editing, setEditing] = useState<{ index: number | null; item: Partial<Draft> } | null>(null)
  const recent = useApi<Plan[]>('/api/plans')
  const missed = useApi<{ data: MissedBlock[] }>('/api/plans/missed')
  const insights = useApi<PlannedVsActual>(`/api/plans/insights?from=${mondayOf()}&days=7`)
  const openTasks = useApi<{ data: RecordItem[] }>('/api/tasks?due=open&sort=priority&per_page=100')

  useEffect(() => {
    const pending = recent.data?.find(p => p.status === 'pending')
    if (pending && !plan) { setPlan(pending); setDraft(pending.items) }
  }, [recent.data, plan])

  const range = useMemo(() => {
    const today = localDate()
    if (horizon === 'today') return { date: today, days: 1 }
    if (horizon === 'next_week') return { date: addDays(mondayOf(), 7), days: 7 }
    return { date: today, days: 7 }
  }, [horizon])

  function load(next: Plan) { setPlan(next); setDraft(next.items); setDirty(false) }
  async function run<T>(fn: () => Promise<T>, success?: string) {
    setBusy(true); setError('')
    try { const result = await fn(); if (success) toast(success); return result } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const itemErrors = Object.entries(e.errors).filter(([k]) => k.startsWith('items.'))
        if (itemErrors.length) { setDraft(d => d.map((item, i) => ({ ...item, error: e.errors[`items.${i}.starts_at`]?.[0] || e.errors[`items.${i}.ends_at`]?.[0] || e.errors[`items.${i}.task_id`]?.[0] }))); setError(t('Some blocks need attention before saving.', 'بعض الفترات تحتاج إلى تعديل قبل الحفظ.')); return }
      }
      setError((e as Error).message); toast((e as Error).message, 'error')
    } finally { setBusy(false) }
  }
  const generate = (extra: Record<string, unknown> = {}, override?: { date: string; days: number }) => run(async () => load(await api<Plan>('/api/plans', 'POST', { ...(override ?? range), ...extra })), t('Proposal ready. Nothing changes until you accept.', 'المقترح جاهز. لن يتغير شيء حتى توافق.'))
  async function saveEdits() {
    if (!plan) return null
    const saved = await run(() => api<Plan>(`/api/plans/${plan.id}`, 'PATCH', { items: draft.map(({ key, task_id, starts_at, ends_at }) => ({ key, task_id, starts_at, ends_at })) }), t('Changes saved to the proposal.', 'حُفظت التغييرات في المقترح.'))
    if (saved) load(saved)
    return saved
  }
  async function accept() {
    if (!plan) return
    if (dirty && !(await saveEdits())) return
    const result = await run(() => api<Plan>(`/api/plans/${plan.id}/accept`, 'POST'), t('Plan accepted. Blocks were added to your calendar.', 'تم قبول الخطة وإضافة الفترات إلى تقويمك.'))
    if (result) { setPlan(result); setDirty(false); recent.reload(); insights.reload() }
  }
  async function reject() {
    if (!plan) return
    const result = await run(() => api<Plan>(`/api/plans/${plan.id}/reject`, 'POST'), t('Proposal rejected. Your calendar is unchanged.', 'رُفض المقترح. لم يتغير تقويمك.'))
    if (result) { setPlan(result); recent.reload() }
  }
  function remove(index: number) { setDraft(d => d.filter((_, i) => i !== index)); setDirty(true) }
  function applyEdit(item: Partial<Draft>, index: number | null) {
    const task = openTasks.data?.data.find(x => x.id === item.task_id)
    const next: Draft = { ...(index === null ? { reasons: ['manual'], manual: true, priority: task?.priority || 'medium', title: task?.title || '' } : draft[index]), ...item, error: undefined } as Draft
    next.minutes = Math.round((new Date(next.ends_at).getTime() - new Date(next.starts_at).getTime()) / 60000)
    setDraft(d => index === null ? [...d, next].sort((a, b) => a.starts_at.localeCompare(b.starts_at)) : d.map((x, i) => i === index ? next : x))
    setDirty(true); setEditing(null)
  }

  const pending = plan?.status === 'pending'
  const byDay = useMemo(() => {
    const groups = new Map<string, { item: Draft; index: number }[]>()
    draft.forEach((item, index) => { const key = localDate(new Date(item.starts_at)); groups.set(key, [...(groups.get(key) || []), { item, index }]) })
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [draft])
  const dayFormat = (day: string) => new Date(`${day}T12:00`).toLocaleDateString(language, { weekday: 'long', month: 'short', day: 'numeric' })
  const time = (iso: string) => new Date(iso).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })

  return <section className="page planning-page">
    <header className="page-heading reveal"><div><p className="eyebrow">{t('Smart planning', 'التخطيط الذكي')}</p><h1>{t('A realistic week, made with you', 'أسبوع واقعي بمشاركتك')}</h1><p className="muted">{t('LifeOS proposes focus blocks around your commitments. Review, adjust, then accept — your calendar changes only when you say so.', 'يقترح LifeOS فترات تركيز حول التزاماتك. راجعها وعدّلها ثم وافق — لا يتغير تقويمك إلا بموافقتك.')}</p></div><Link className="quiet" to="/review"><Target size={17} />{t('Weekly review', 'المراجعة الأسبوعية')}</Link></header>

    {missed.data && missed.data.data.length > 0 && <div className="banner warning reveal" role="status"><RotateCcw size={18} /><p>{t(`${missed.data.data.length} planned block(s) from the last two weeks were missed.`, `فاتتك ${missed.data.data.length} فترة مخططة خلال الأسبوعين الماضيين.`)}</p><button className="quiet" disabled={busy} onClick={() => void generate({ task_ids: [...new Set(missed.data!.data.map(m => m.task_id))] }, { date: localDate(), days: 7 })}>{t('Reschedule missed work', 'أعد جدولة العمل الفائت')}</button></div>}

    <div className="planning-top">
      <section className="panel reveal planning-controls">
        <h2>{t('Plan', 'خطّط')}</h2>
        <div className="segmented" role="radiogroup" aria-label={t('Planning horizon', 'فترة التخطيط')}>{([['today', t('Today', 'اليوم')], ['week', t('Next 7 days', 'الأيام السبعة القادمة')], ['next_week', t('Next week', 'الأسبوع القادم')]] as [Horizon, string][]).map(([key, name]) => <button key={key} role="radio" aria-checked={horizon === key} className={horizon === key ? 'active' : ''} onClick={() => setHorizon(key)}>{name}</button>)}</div>
        <p className="muted">{t(`From ${dayFormat(range.date)} for ${range.days} day(s), within your working hours.`, `من ${dayFormat(range.date)} لمدة ${range.days} يوم، ضمن ساعات عملك.`)} <Link to="/settings">{t('Adjust hours', 'ضبط الساعات')}</Link></p>
        <button className="primary" disabled={busy} onClick={() => void generate()}><Sparkles size={17} />{busy ? t('Working…', 'جارٍ العمل…') : pending ? t('Regenerate proposal', 'إعادة إنشاء المقترح') : t('Generate proposal', 'إنشاء مقترح')}</button>
      </section>
      <section className="panel reveal">
        <header className="row"><h2>{t('This week: planned vs actual', 'هذا الأسبوع: المخطط مقابل الفعلي')}</h2></header>
        {insights.data ? <PlannedActualBars data={insights.data} /> : <Skeleton lines={4} />}
      </section>
    </div>

    <ErrorMessage error={error} />

    {!plan ? (recent.loading ? <Skeleton height={220} /> : <section className="panel"><EmptyState icon={<CalendarClock size={28} />} title={t('No proposal yet', 'لا يوجد مقترح بعد')} action={<button className="primary" disabled={busy} onClick={() => void generate()}><Sparkles size={17} />{t('Generate proposal', 'إنشاء مقترح')}</button>}>{t('Add tasks with time estimates and set your working hours. LifeOS splits big tasks into focus blocks, protects fixed commitments, and explains every suggestion.', 'أضف مهاماً بمدد مقدرة واضبط ساعات عملك. يقسّم LifeOS المهام الكبيرة إلى فترات تركيز ويحمي التزاماتك الثابتة ويشرح كل اقتراح.')}</EmptyState></section>) : <>
      {plan.summary && <section className="panel reveal">
        <header className="row"><div><h2>{t('Proposal overview', 'نظرة على المقترح')}</h2><p className="muted">{plan.starts_on && dayFormat(plan.starts_on)} · {t(`${plan.days} day(s)`, `${plan.days} يوم`)}</p></div><span className={`badge status-${plan.status}`}>{plan.status === 'pending' ? t('Awaiting your review', 'بانتظار مراجعتك') : plan.status === 'accepted' ? t('Accepted', 'مقبول') : t('Rejected', 'مرفوض')}</span></header>
        <div className="plan-totals">
          <div><strong>{minutesLabel(draft.reduce((s, i) => s + i.minutes, 0), ar)}</strong><span>{t('planned focus', 'تركيز مخطط')}</span></div>
          <div><strong>{draft.length}</strong><span>{t('blocks', 'فترات')}</span></div>
          <div><strong>{new Set(draft.map(i => i.task_id)).size}</strong><span>{t('tasks', 'مهام')}</span></div>
          <div className={plan.warnings.length ? 'warn' : ''}><strong>{plan.warnings.length}</strong><span>{t('could not fit', 'لم تتسع')}</span></div>
        </div>
        <ul className="load-strip" aria-label={t('Daily load', 'الحمل اليومي')}>{plan.summary.days.map(day => <li key={day.date} className={`${day.overloaded ? 'overloaded' : ''} ${day.work_day ? '' : 'off'}`}>
          <span>{new Date(`${day.date}T12:00`).toLocaleDateString(language, { weekday: 'short', day: 'numeric' })}</span>
          <div className="meter"><div className={day.overloaded ? 'over' : ''} style={{ width: `${Math.min(100, day.load_percent)}%` }} /></div>
          <small>{day.work_day ? `${day.load_percent}%` : t('Off', 'عطلة')}</small>
          {day.work_day && <small className="muted">{t(`${minutesLabel(day.free_minutes, false)} free`, `${minutesLabel(day.free_minutes, true)} متاح`)}</small>}
        </li>)}</ul>
        {plan.summary.overload.map(o => <p key={o.date} className="banner warning compact"><AlertTriangle size={16} />{ar ? o.ar : o.en}</p>)}
      </section>}

      <div className="planning-body">
        <section className="panel reveal">
          <header className="row"><h2>{t('Suggested schedule', 'الجدول المقترح')}</h2>{pending && <button className="quiet" disabled={busy} onClick={() => { const s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1); setEditing({ index: null, item: { starts_at: s.toISOString(), ends_at: new Date(s.getTime() + 3600000).toISOString() } }) }}><Plus size={16} />{t('Add block', 'إضافة فترة')}</button>}</header>
          {draft.length === 0 ? <EmptyState icon={<CalendarClock size={26} />} title={t('No blocks in this proposal', 'لا توجد فترات في هذا المقترح')}>{t('Nothing fit, or every block was removed. Check the notes on the right or add a block manually.', 'لم يتسع شيء أو حُذفت كل الفترات. راجع الملاحظات أو أضف فترة يدوياً.')}</EmptyState> : byDay.map(([day, entries]) => <div key={day} className="plan-day">
            <h3>{dayFormat(day)}</h3>
            {entries.map(({ item, index }) => <article key={item.key ?? `new-${index}`} className={`plan-block ${item.manual ? 'manual' : ''} ${item.error ? 'has-error' : ''}`}>
              <time>{time(item.starts_at)}<span>{time(item.ends_at)}</span></time>
              <div className="plan-block-main">
                <strong>{item.title}</strong>
                <div className="metadata"><span className={`badge priority-${item.priority}`}>{label(item.priority)}</span><span>{minutesLabel(item.minutes, ar)}</span>{(item.parts ?? 1) > 1 && <span>{t(`Block ${item.part}/${item.parts}`, `فترة ${item.part}/${item.parts}`)}</span>}{item.manual && <span className="chip"><Hand size={11} />{t('Your change', 'تعديلك')}</span>}</div>
                {item.explanation && <p className="explain"><Lightbulb size={13} />{ar ? item.explanation.ar : item.explanation.en}</p>}
                {item.error && <p className="error compact">{item.error}</p>}
              </div>
              {pending && <div className="record-actions"><button className="icon-button" aria-label={t('Change time', 'تغيير الوقت')} onClick={() => setEditing({ index, item })}><Pencil size={15} /></button><button className="icon-button" aria-label={t('Remove block', 'حذف الفترة')} onClick={() => remove(index)}><Trash2 size={15} /></button></div>}
            </article>)}
          </div>)}
          {pending && <div className="sticky-actions">
            {dirty && <span className="muted">{t('You have unsaved changes.', 'لديك تغييرات غير محفوظة.')}</span>}
            {dirty && <button className="quiet" disabled={busy} onClick={() => void saveEdits()}>{t('Save changes', 'حفظ التغييرات')}</button>}
            <button className="quiet" disabled={busy} onClick={() => void reject()}><X size={16} />{t('Reject', 'رفض')}</button>
            <button className="primary" disabled={busy || draft.length === 0} onClick={() => void accept()}><Check size={16} />{dirty ? t('Save & accept', 'حفظ وقبول') : t('Accept & add to calendar', 'قبول وإضافة للتقويم')}</button>
          </div>}
          {plan.status === 'accepted' && <p className="success"><Check size={16} />{t('These blocks are on your calendar.', 'هذه الفترات في تقويمك الآن.')} <Link to="/calendar">{t('Open calendar', 'فتح التقويم')}</Link></p>}
        </section>
        <aside className="panel reveal">
          <h2>{t('Needs your attention', 'يحتاج انتباهك')}</h2>
          {plan.warnings.length === 0 ? <p className="muted">{t('Everything open fits in this window.', 'كل المهام المفتوحة تتسع في هذه الفترة.')}</p> : <>{plan.warnings.slice(0, allWarnings ? undefined : 4).map(w => <div key={w.task_id} className="warning-card">
            <strong>{w.title}</strong>
            <p className="muted">{ar ? w.reason_ar : w.reason} · {t(`needs ${minutesLabel(w.needed_minutes, false)}`, `تحتاج ${minutesLabel(w.needed_minutes, true)}`)}</p>
            <ul>{w.alternatives.map((alt, i) => <li key={i}>
              <span>{ar ? alt.ar : alt.en}</span>
              {pending && alt.type === 'horizon' && <button className="text-link" onClick={() => { setHorizon('week'); void generate({}, { date: localDate(), days: 7 }) }}>{t('Plan 7 days', 'خطّط ٧ أيام')}</button>}
              {pending && alt.type === 'manual' && <button className="text-link" onClick={() => { const s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1); setEditing({ index: null, item: { task_id: w.task_id, title: w.title, priority: w.priority, starts_at: s.toISOString(), ends_at: new Date(s.getTime() + Math.min(w.needed_minutes, 120) * 60000).toISOString() } }) }}>{t('Add block', 'إضافة فترة')}</button>}
              {pending && alt.type === 'swap' && alt.task_id && <button className="text-link" onClick={() => { const index = draft.findIndex(d => d.task_id === alt.task_id); if (index >= 0) remove(index) }}>{t('Remove one block', 'حذف فترة')}</button>}
              {alt.type === 'deadline' && <Link className="text-link" to="/tasks">{t('Open tasks', 'فتح المهام')}</Link>}
            </li>)}</ul>
          </div>)}{plan.warnings.length > 4 && <button type="button" className="quiet show-more" onClick={() => setAllWarnings(v => !v)}>{allWarnings ? t('Show fewer', 'عرض أقل') : t(`Show ${plan.warnings.length - 4} more`, `عرض ${plan.warnings.length - 4} أخرى`)}</button>}</>}
        </aside>
      </div>
    </>}

    {recent.data && recent.data.length > 1 && <details className="panel">
      <summary>{t('Recent proposals', 'المقترحات الأخيرة')}</summary>
      <ul className="history-list">{recent.data.map(p => <li key={p.id}><button className="text-button" onClick={() => load(p)}>{new Date(p.created_at).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })}</button><span className={`badge status-${p.status}`}>{p.status === 'pending' ? t('Pending', 'معلق') : p.status === 'accepted' ? t('Accepted', 'مقبول') : t('Rejected', 'مرفوض')}</span><span className="muted">{t(`${p.items.length} blocks`, `${p.items.length} فترات`)}</span></li>)}</ul>
    </details>}

    {editing && <BlockEditor initial={editing.item} tasks={openTasks.data?.data ?? []} isNew={editing.index === null} onClose={() => setEditing(null)} onSave={item => applyEdit(item, editing.index)} />}
  </section>
}

function BlockEditor({ initial, tasks, isNew, onClose, onSave }: { initial: Partial<Draft>; tasks: RecordItem[]; isNew: boolean; onClose: () => void; onSave: (item: Partial<Draft>) => void }) {
  const t = useText()
  const startDefault = initial.starts_at ? localInput(initial.starts_at) : ''
  const duration = initial.starts_at && initial.ends_at ? Math.round((new Date(initial.ends_at).getTime() - new Date(initial.starts_at).getTime()) / 60000) : 60
  const [taskId, setTaskId] = useState(String(initial.task_id ?? tasks[0]?.id ?? '')), [start, setStart] = useState(startDefault), [minutes, setMinutes] = useState(duration)
  const options = [15, 25, 30, 45, 60, 75, 90, 120, 150, 180, 240]
  return <Dialog title={isNew ? t('Add a focus block', 'إضافة فترة تركيز') : t('Change block time', 'تغيير وقت الفترة')} onClose={onClose}>
    <form className="form-grid" onSubmit={e => { e.preventDefault(); const s = new Date(start); const task = tasks.find(x => x.id === Number(taskId)); onSave({ task_id: Number(taskId), title: initial.title || task?.title, priority: initial.priority || task?.priority, starts_at: s.toISOString(), ends_at: new Date(s.getTime() + minutes * 60000).toISOString() }) }}>
      {isNew && <label className="full">{t('Task', 'المهمة')}<select value={taskId} onChange={e => setTaskId(e.target.value)} required>{initial.task_id && !tasks.some(x => x.id === initial.task_id) && <option value={initial.task_id}>{initial.title}</option>}{tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>}
      <label>{t('Start', 'البداية')}<input type="datetime-local" required value={start} onChange={e => setStart(e.target.value)} /></label>
      <label>{t('Duration', 'المدة')}<select value={minutes} onChange={e => setMinutes(Number(e.target.value))}>{[...new Set([...options, minutes])].sort((a, b) => a - b).map(m => <option key={m} value={m}>{m} {t('min', 'د')}</option>)}</select></label>
      <p className="muted full">{t('Manual blocks may sit outside working hours. They still cannot overlap other commitments.', 'يمكن وضع الفترات اليدوية خارج ساعات العمل، لكنها لا تتداخل مع الالتزامات الأخرى.')}</p>
      <footer className="full row"><button type="button" className="quiet" onClick={onClose}>{t('Cancel', 'إلغاء')}</button><button className="primary" disabled={!start || !taskId}>{t('Apply', 'تطبيق')}</button></footer>
    </form>
  </Dialog>
}
