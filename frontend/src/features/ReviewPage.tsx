import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { ChevronLeft, ChevronRight, Trophy, TrendingUp, TrendingDown, Check, ArrowRightLeft, X, Flame, Star, Sparkles, Lightbulb, CircleCheckBig } from 'lucide-react'
import { api, type Plan, type ReviewDecision, type WeeklyReviewData } from '../lib/api'
import { useApi } from '../lib/useApi'
import { WeeklyInsights } from './intelligence/WeeklyInsights'
import { useText } from '../lib/i18n'
import { useLanguage } from '../contexts/LanguageContext'
import { useToast } from '../lib/toast'
import { addDays, minutesLabel, mondayOf } from '../lib/dates'
import { useReasonLabel } from '../lib/labels'
import { localDate } from '../lib/hooks'
import { useStatusLabel } from './ResourcePage'
import { PlannedActualBars } from './PlanningPage'
import { EmptyState, ErrorMessage, Skeleton } from '../components/ui/Shared'

const STEPS = ['look_back', 'unfinished', 'habits', 'reflect', 'next_week'] as const
type Step = typeof STEPS[number]
type Local = { reflection: WeeklyReviewData['review']['reflection']; decisions: Record<string, ReviewDecision>; priorities: number[] }

export default function ReviewPage() {
  const [week, setWeek] = useState(() => { const today = new Date(); return today.getDay() === 1 || today.getDay() === 2 ? addDays(mondayOf(), -7) : mondayOf() })
  const { data, error, loading, reload } = useApi<WeeklyReviewData>(`/api/reviews/${week}`)
  // Remount the workflow per loaded week so local edits always start from the saved review.
  return data && !loading ? <ReviewWorkflow key={`${week}-${data.review.status}`} week={week} setWeek={setWeek} data={data} reload={reload} /> : <section className="page"><ReviewHeader week={week} setWeek={setWeek} />{error ? <ErrorMessage error={error} /> : <Skeleton height={360} />}</section>
}

function ReviewHeader({ week, setWeek, status }: { week: string; setWeek: (w: string) => void; status?: string }) {
  const t = useText(), { language } = useLanguage()
  const end = addDays(week, 6)
  const fmt = (d: string) => new Date(`${d}T12:00`).toLocaleDateString(language, { month: 'short', day: 'numeric' })
  return <header className="page-heading reveal">
    <div><p className="eyebrow">{t('Weekly review', 'المراجعة الأسبوعية')}</p><h1>{t('Look back. Decide. Plan ahead.', 'انظر للخلف. قرّر. خطّط للأمام.')}</h1><p className="muted">{t('Fifteen calm minutes to close the week and choose what matters next.', 'خمس عشرة دقيقة هادئة لإغلاق الأسبوع واختيار ما يهم بعده.')}</p></div>
    <div className="toolbar week-switcher">
      <button className="icon-button" aria-label={t('Previous week', 'الأسبوع السابق')} onClick={() => setWeek(addDays(week, -7))}><ChevronLeft className="flip-rtl" /></button>
      <strong>{fmt(week)} – {fmt(end)}</strong>
      <button className="icon-button" aria-label={t('Next week', 'الأسبوع التالي')} disabled={week >= mondayOf()} onClick={() => setWeek(addDays(week, 7))}><ChevronRight className="flip-rtl" /></button>
      {status && <span className={`badge status-${status}`}>{status === 'completed' ? t('Completed', 'مكتملة') : status === 'draft' ? t('Draft saved', 'مسودة محفوظة') : t('Not started', 'لم تبدأ')}</span>}
    </div>
  </header>
}

function ReviewWorkflow({ week, setWeek, data, reload }: { week: string; setWeek: (w: string) => void; data: WeeklyReviewData; reload: () => void }) {
  const t = useText(), { language } = useLanguage(), ar = language === 'ar', toast = useToast(), navigate = useNavigate(), label = useStatusLabel(), reason = useReasonLabel()
  const [step, setStep] = useState<Step>(data.review.status === 'completed' ? 'next_week' : 'look_back')
  const [local, setLocal] = useState<Local>({ reflection: data.review.reflection, decisions: { ...data.review.decisions }, priorities: data.review.priorities.length ? data.review.priorities : data.suggested_priorities.slice(0, 3).map(p => p.id) })
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const completed = data.review.status === 'completed'
  const index = STEPS.indexOf(step)
  const stepNames: Record<Step, string> = { look_back: t('Look back', 'نظرة للخلف'), unfinished: t('Unfinished work', 'العمل غير المنجز'), habits: t('Habits & goals', 'العادات والأهداف'), reflect: t('Reflect', 'تأمّل'), next_week: t('Next week', 'الأسبوع القادم') }
  const payload = () => ({ reflection: local.reflection, decisions: local.decisions, priorities: local.priorities })
  async function call<T>(fn: () => Promise<T>) { setBusy(true); setError(''); try { return await fn() } catch (e) { setError((e as Error).message); toast((e as Error).message, 'error') } finally { setBusy(false) } }
  async function go(next: Step) { if (!completed) await call(() => api(`/api/reviews/${week}`, 'PUT', payload())); setStep(next) }
  async function finish() {
    const result = await call(() => api<WeeklyReviewData>(`/api/reviews/${week}/complete`, 'POST', payload()))
    if (result) { const a = result.applied; toast(a ? t(`Review completed. ${a.done} done, ${a.carry} carried over, ${a.drop} dropped.`, `اكتملت المراجعة. ${a.done} منجزة، ${a.carry} مرحّلة، ${a.drop} ملغاة.`) : t('Review completed.', 'اكتملت المراجعة.')); reload() }
  }
  async function planNextWeek() {
    const following = addDays(week, 7), today = localDate()
    const result = await call(() => api<Plan>('/api/plans', 'POST', { date: following > today ? following : today, days: 7, priority_task_ids: local.priorities }))
    if (result) { toast(t('Draft plan ready for your review.', 'مسودة الخطة جاهزة لمراجعتك.')); navigate('/planning') }
  }
  const decide = (id: number, value: ReviewDecision) => setLocal(l => ({ ...l, decisions: { ...l.decisions, [id]: value } }))
  const togglePriority = (id: number) => setLocal(l => ({ ...l, priorities: l.priorities.includes(id) ? l.priorities.filter(p => p !== id) : l.priorities.length >= 5 ? l.priorities : [...l.priorities, id] }))
  const m = data.metrics
  const maxFocus = Math.max(1, ...data.focus_by_day.map(d => d.minutes))

  return <section className="page review-page">
    <ReviewHeader week={week} setWeek={setWeek} status={data.review.status} />
    <ol className="stepper" aria-label={t('Review steps', 'خطوات المراجعة')}>{STEPS.map((s, i) => <li key={s}><button className={`${s === step ? 'active' : ''} ${i < index ? 'done' : ''}`} aria-current={s === step ? 'step' : undefined} onClick={() => void go(s)}><span>{i < index ? <Check size={13} /> : i + 1}</span>{stepNames[s]}</button></li>)}</ol>
    <ErrorMessage error={error} />

    {step === 'look_back' && <div className="review-grid">
      {data.intelligence?.enabled && <WeeklyInsights week={week} data={data.intelligence} />}
      <div className="stats-grid">
        <div className="stat reveal"><span>{t('Completed', 'منجزة')}</span><strong>{m.completed}</strong><small className="muted">{t(`${m.unfinished} still open`, `${m.unfinished} مفتوحة`)}</small></div>
        <div className="stat reveal"><span>{t('Focus time', 'وقت التركيز')}</span><strong>{minutesLabel(m.focus_minutes, ar)}</strong>{m.focus_change !== null ? <small className={`change ${m.focus_change >= 0 ? 'up' : 'down'}`}>{m.focus_change >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}{m.focus_change > 0 ? '+' : ''}{m.focus_change}% {t('vs last week', 'عن الأسبوع الماضي')}</small> : <small className="muted">{t('No data last week', 'لا بيانات للأسبوع الماضي')}</small>}</div>
        <div className="stat reveal"><span>{t('On time', 'في الوقت')}</span><strong>{m.on_time_rate === null ? '—' : `${m.on_time_rate}%`}</strong><small className="muted">{t('Of tasks with deadlines', 'من المهام ذات المواعيد')}</small></div>
        <div className="stat reveal"><span>{t('Habit consistency', 'انتظام العادات')}</span><strong>{m.habit_consistency === null ? '—' : `${m.habit_consistency}%`}</strong><small className="muted">{t(`${data.habits.length} habits`, `${data.habits.length} عادات`)}</small></div>
      </div>
      <section className="panel reveal"><h2><Trophy size={18} /> {t('Achievements', 'إنجازات')}</h2>{data.achievements.length ? <ul className="badge-list">{data.achievements.map(a => <li key={a.key}><Star size={15} />{ar ? a.ar : a.en}</li>)}</ul> : <p className="muted">{t('A quiet week. Next week is a fresh start.', 'أسبوع هادئ. الأسبوع القادم بداية جديدة.')}</p>}</section>
      <section className="panel reveal"><h2>{t('Focus by day', 'التركيز حسب اليوم')}</h2><ul className="bar-list">{data.focus_by_day.map(d => <li key={d.date}><div className="row"><span>{new Date(`${d.date}T12:00`).toLocaleDateString(language, { weekday: 'long' })}</span><span className="muted">{minutesLabel(d.minutes, ar)}</span></div><div className="meter"><div style={{ width: `${d.minutes / maxFocus * 100}%` }} /></div></li>)}</ul></section>
      <section className="panel reveal"><h2>{t('Planned vs actual', 'المخطط مقابل الفعلي')}</h2><PlannedActualBars data={data.planned_vs_actual} /></section>
      <section className="panel reveal wide"><h2>{t(`Completed this week (${data.completed.length})`, `منجز هذا الأسبوع (${data.completed.length})`)}</h2>{data.completed.length ? <ul className="done-list">{data.completed.map(task => <li key={task.id}><CircleCheckBig size={16} /><span>{task.title}</span><small className="muted">{task.actual_minutes ? `${minutesLabel(task.actual_minutes, ar)} / ${minutesLabel(task.estimated_minutes, ar)}` : minutesLabel(task.estimated_minutes, ar)}</small></li>)}</ul> : <p className="muted">{t('No tasks were completed this week.', 'لم تُنجز مهام هذا الأسبوع.')}</p>}</section>
    </div>}

    {step === 'unfinished' && <section className="panel reveal">
      <header><h2>{t('Decide what happens to unfinished work', 'قرّر مصير العمل غير المنجز')}</h2><p className="muted">{t('Nothing changes until you complete the review.', 'لن يتغير شيء حتى تُكمل المراجعة.')}</p></header>
      {data.unfinished.length === 0 ? <EmptyState icon={<CircleCheckBig size={26} />} title={t('Nothing left behind', 'لا شيء متأخر')}>{t('Every task due this week is done.', 'كل المهام المستحقة هذا الأسبوع منجزة.')}</EmptyState> : <ul className="decision-list">{data.unfinished.map(task => {
        const value = local.decisions[task.id]
        return <li key={task.id} className={value ? `decided-${value}` : ''}>
          <div><strong>{task.title}</strong><div className="metadata"><span className={`badge priority-${task.priority}`}>{label(task.priority)}</span>{task.due_at && <time className={task.overdue ? 'overdue-text' : ''}>{new Date(task.due_at).toLocaleDateString(language)}</time>}<span>{label(task.status)}</span></div></div>
          <div className="segmented small" role="radiogroup" aria-label={task.title}>
            {([['done', <Check key="i" size={14} />, t('Done', 'منجزة')], ['carry', <ArrowRightLeft key="i" size={14} />, t('Carry over', 'ترحيل')], ['drop', <X key="i" size={14} />, t('Drop', 'إلغاء')]] as [ReviewDecision, ReactNode, string][]).map(([key, icon, name]) => <button key={key} role="radio" aria-checked={value === key} disabled={completed} className={value === key ? 'active' : ''} onClick={() => decide(task.id, key)}>{icon}{name}</button>)}
          </div>
        </li>
      })}</ul>}
    </section>}

    {step === 'habits' && <div className="review-grid">
      <section className="panel reveal"><h2>{t('Habits', 'العادات')}</h2>{data.habits.length ? <ul className="bar-list">{data.habits.map(h => <li key={h.id}><div className="row"><span><i className="swatch" style={{ background: h.color }} />{h.title}</span><span className="muted"><Flame size={13} /> {h.current_streak} · {h.completions}/{h.expected}</span></div><div className="meter"><div style={{ width: `${h.consistency}%` }} /></div></li>)}</ul> : <p className="muted">{t('No habits yet.', 'لا توجد عادات بعد.')} <Link to="/habits">{t('Add one', 'أضف عادة')}</Link></p>}</section>
      <section className="panel reveal"><h2>{t('Goals', 'الأهداف')}</h2>{data.goals.length ? data.goals.map(g => <div className="goal-row" key={g.id}><div className="row"><strong>{g.title}</strong><span className="muted">{g.percent}%</span></div><div className="meter"><div style={{ width: `${g.percent}%`, background: g.color }} /></div><small className="muted">{g.progress} / {g.target}</small></div>) : <p className="muted">{t('No goals yet.', 'لا توجد أهداف بعد.')} <Link to="/goals">{t('Set one', 'حدّد هدفاً')}</Link></p>}</section>
      <section className="panel reveal wide"><h2><Lightbulb size={18} /> {t('Areas to improve', 'مجالات للتحسين')}</h2>{data.improvements.length ? <ul className="badge-list improve">{data.improvements.map(i => <li key={i.key}>{ar ? i.ar : i.en}</li>)}</ul> : <p className="muted">{t('No obvious gaps. Keep the rhythm.', 'لا فجوات واضحة. حافظ على الإيقاع.')}</p>}</section>
    </div>}

    {step === 'reflect' && <section className="panel reveal reflect">
      <h2>{t('Reflect on the week', 'تأمّل في أسبوعك')}</h2>
      <fieldset className="rating" disabled={completed}><legend>{t('How did the week feel?', 'كيف كان شعورك بالأسبوع؟')}</legend>{[1, 2, 3, 4, 5].map(n => <button key={n} type="button" aria-pressed={local.reflection.rating === n} aria-label={t(`${n} of 5`, `${n} من ٥`)} className={(local.reflection.rating ?? 0) >= n ? 'on' : ''} onClick={() => setLocal(l => ({ ...l, reflection: { ...l.reflection, rating: n } }))}><Star size={22} /></button>)}</fieldset>
      {([['wins', t('What went well?', 'ما الذي سار بشكل جيد؟')], ['challenges', t('What got in the way?', 'ما الذي أعاقك؟')], ['lessons', t('What will you do differently?', 'ما الذي ستفعله بشكل مختلف؟')]] as ['wins' | 'challenges' | 'lessons', string][]).map(([key, prompt]) => <label key={key}>{prompt}<textarea rows={3} maxLength={4000} disabled={completed} value={local.reflection[key] || ''} onChange={e => setLocal(l => ({ ...l, reflection: { ...l.reflection, [key]: e.target.value } }))} /></label>)}
    </section>}

    {step === 'next_week' && <section className="panel reveal">
      <header><h2>{t('Choose up to 5 priorities for next week', 'اختر حتى ٥ أولويات للأسبوع القادم')}</h2><p className="muted">{t('Suggestions are ranked by urgency, importance and deadlines. Chosen priorities are planned first.', 'الاقتراحات مرتبة حسب الإلحاح والأهمية والمواعيد. تُخطَّط الأولويات المختارة أولاً.')}</p></header>
      {data.suggested_priorities.length === 0 ? <EmptyState icon={<Sparkles size={26} />} title={t('No open tasks', 'لا توجد مهام مفتوحة')}>{t('Capture what’s next, then come back to plan.', 'سجّل ما هو تالٍ ثم عد للتخطيط.')}</EmptyState> : <ul className="priority-picker">{data.suggested_priorities.map(task => {
        const chosen = local.priorities.includes(task.id)
        return <li key={task.id}><button aria-pressed={chosen} className={chosen ? 'chosen' : ''} disabled={completed || (!chosen && local.priorities.length >= 5)} onClick={() => togglePriority(task.id)}><span className="pick">{chosen ? local.priorities.indexOf(task.id) + 1 : ''}</span><span><strong>{task.title}</strong><span className="metadata"><span className={`badge priority-${task.priority}`}>{label(task.priority)}</span><span>{minutesLabel(task.estimated_minutes, ar)}</span>{task.reasons.filter(r => !['quick_win', 'urgent', 'high'].includes(r)).map(r => <span key={r} className={`chip reason-${r}`}>{reason(r)}</span>)}</span></span></button></li>
      })}</ul>}
      {completed ? <div className="review-done"><CircleCheckBig size={22} /><div><strong>{t('Review completed', 'اكتملت المراجعة')}</strong><p className="muted">{t('Turn your priorities into a realistic plan for next week.', 'حوّل أولوياتك إلى خطة واقعية للأسبوع القادم.')}</p></div><button className="primary" disabled={busy} onClick={() => void planNextWeek()}><Sparkles size={16} />{t('Plan next week', 'خطّط للأسبوع القادم')}</button></div> : <p className="muted">{t(`Completing the review will apply your decisions: ${Object.values(local.decisions).filter(v => v === 'done').length} done, ${Object.values(local.decisions).filter(v => v === 'carry').length} carried over, ${Object.values(local.decisions).filter(v => v === 'drop').length} dropped.`, `إكمال المراجعة سيطبق قراراتك: ${Object.values(local.decisions).filter(v => v === 'done').length} منجزة، ${Object.values(local.decisions).filter(v => v === 'carry').length} مرحّلة، ${Object.values(local.decisions).filter(v => v === 'drop').length} ملغاة.`)}</p>}
    </section>}

    <div className="sticky-actions">
      {index > 0 && <button className="quiet" disabled={busy} onClick={() => void go(STEPS[index - 1])}><ChevronLeft size={16} className="flip-rtl" />{t('Back', 'السابق')}</button>}
      {index < STEPS.length - 1 ? <button className="primary" disabled={busy} onClick={() => void go(STEPS[index + 1])}>{t('Continue', 'متابعة')}<ChevronRight size={16} className="flip-rtl" /></button> : !completed && <button className="primary" disabled={busy} onClick={() => void finish()}><Check size={16} />{t('Complete review', 'إكمال المراجعة')}</button>}
    </div>
  </section>
}
