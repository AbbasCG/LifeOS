import { useState } from 'react'
import { Link } from 'react-router'
import { CalendarCheck, RefreshCw, Battery, BatteryLow, Zap, Coffee, AlertTriangle, LifeBuoy, Settings2, Check, Lock, Globe, Repeat } from 'lucide-react'
import { api, type DayPlan, type DayPlanAlternative, type Plan } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { localDate } from '../../lib/hooks'
import { minutesLabel } from '../../lib/dates'
import { ErrorMessage, Skeleton } from '../../components/ui/Shared'
import { useReasonLabel } from '../../lib/labels'

/**
 * "Plan my day": the real time budget, explanations and three alternative schedules. Choosing one creates a pending
 * proposal; the calendar only changes when the user explicitly adds it.
 */
export default function DayPlanPage() {
  const t = useText(), { language } = useLanguage(), toast = useToast(), reason = useReasonLabel(), ar = language === 'ar'
  const [date, setDate] = useState(localDate()), [replan, setReplan] = useState(0)
  const { data, error, reload } = useApi<DayPlan>(`/api/day-plan?date=${date}&replan=${replan > 0 ? 1 : 0}&r=${replan}`)
  const [selected, setSelected] = useState<DayPlanAlternative['key'] | null>(null), [proposal, setProposal] = useState<Plan | null>(null)
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(''), [editing, setEditing] = useState(false)
  const active = selected ?? data?.recommended ?? 'balanced'
  const alt = data?.alternatives.find(a => a.key === active)
  const time = (iso: string) => new Date(iso).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
  const bi = (v: { en: string; ar: string }) => ar ? v.ar : v.en

  async function choose() {
    setBusy(true); setFailure('')
    try { setProposal(await api<Plan>('/api/day-plan', 'POST', { date, variant: active })) } catch (e) { setFailure((e as Error).message) } finally { setBusy(false) }
  }
  async function accept() {
    if (!proposal) return
    setBusy(true); setFailure('')
    try { await api(`/api/plans/${proposal.id}/accept`, 'POST'); toast(t('Your day is on the calendar.', 'يومك الآن في التقويم.')); setProposal(null); reload() } catch (e) { setFailure((e as Error).message) } finally { setBusy(false) }
  }

  return <section className="page day-plan-page">
    <header className="page-heading"><div><p className="eyebrow">{t('Plan my day', 'خطط يومي')}</p><h1>{t('A realistic day, made with you', 'يوم واقعي تصنعه معك')}</h1><p className="muted">{t('Based on your real calendar, boundaries and energy. Nothing changes until you add it.', 'مبني على تقويمك الحقيقي وحدودك وطاقتك. لا يتغير شيء حتى تضيفه.')}</p></div>
      <div className="toolbar">
        <label className="sr-only" htmlFor="plan-date">{t('Day', 'اليوم')}</label>
        <input id="plan-date" type="date" value={date} min={localDate()} onChange={e => { setDate(e.target.value); setSelected(null); setProposal(null) }} />
        <button className="quiet" onClick={() => { setReplan(r => r + 1); setSelected(null); setProposal(null) }}><RefreshCw size={16} />{t('Replan from now', 'أعد التخطيط من الآن')}</button>
        <button className="quiet icon-button" aria-label={t('Boundaries and buffers', 'الحدود والفواصل')} aria-expanded={editing} onClick={() => setEditing(v => !v)}><Settings2 size={17} /></button>
      </div>
    </header>
    {editing && <BoundaryEditor onSaved={() => { setEditing(false); reload() }} />}
    <ErrorMessage error={error || failure} />
    {!data ? <section className="panel"><Skeleton lines={5} /></section> : <>
      <section className="panel budget-panel reveal">
        <div className="budget-bar" role="img" aria-label={t(`${minutesLabel(data.budget.committed_minutes, false)} committed, ${minutesLabel(data.budget.free_minutes, false)} free`, `${minutesLabel(data.budget.committed_minutes, true)} التزامات، ${minutesLabel(data.budget.free_minutes, true)} متاح`)}>
          <span className="committed" style={{ flexGrow: data.budget.committed_minutes || 0.0001 }} />
          <span className="capacity" style={{ flexGrow: data.budget.capacity_minutes || 0.0001 }} />
          <span className="slack" style={{ flexGrow: Math.max(0, data.budget.free_minutes - data.budget.capacity_minutes) || 0.0001 }} />
        </div>
        <dl className="budget-stats">
          <div><dt>{t('Committed', 'التزامات')}</dt><dd>{minutesLabel(data.budget.committed_minutes, ar)}</dd></div>
          <div><dt>{t('Free inside boundaries', 'متاح ضمن الحدود')}</dt><dd>{minutesLabel(data.budget.free_minutes, ar)}</dd></div>
          <div><dt>{t('Plannable today', 'قابل للتخطيط')}</dt><dd>{minutesLabel(data.budget.capacity_minutes, ar)}</dd></div>
          <div><dt>{t('Must-do work', 'أعمال ضرورية')}</dt><dd className={data.budget.must_do_minutes > data.budget.capacity_minutes ? 'over' : ''}>{minutesLabel(data.budget.must_do_minutes, ar)}</dd></div>
          <div><dt>{t('Energy', 'الطاقة')}</dt><dd>{data.energy === null ? <Link to="/settings/wellbeing">{t('Check in', 'سجّل')}</Link> : <>{data.energy <= 2 ? <BatteryLow size={15} /> : <Battery size={15} />}{data.energy}/5</>}</dd></div>
          {data.peak && <div><dt>{t('Peak focus', 'ذروة التركيز')}</dt><dd><Zap size={15} />{data.peak.start}–{data.peak.end}</dd></div>}
        </dl>
        <ul className="why-list">{data.explanation.map((e, i) => <li key={i}>{bi(e)}</li>)}</ul>
        {data.overload && <p className="banner warning"><AlertTriangle size={16} />{bi(data.overload)}</p>}
        {data.recovery.length > 0 && <p className="banner"><LifeBuoy size={16} />{t(`Recovering ${data.recovery.length} missed block(s): `, `استعادة ${data.recovery.length} فترة فائتة: `)}{data.recovery.map(r => r.title).join(', ')}</p>}
      </section>

      <div className="day-plan-grid">
        <section className="panel reveal">
          <h2>{t('Choose a plan', 'اختر خطة')}</h2>
          <div className="variant-tabs" role="radiogroup" aria-label={t('Plan options', 'خيارات الخطة')}>
            {data.alternatives.map(a => <button key={a.key} role="radio" aria-checked={active === a.key} className={`variant ${active === a.key ? 'active' : ''}`} onClick={() => { setSelected(a.key); setProposal(null) }}>
              <strong>{bi(a.title)}{data.recommended === a.key && <span className="badge">{t('Suggested', 'مقترحة')}</span>}</strong>
              <small>{bi(a.description)}</small>
              <span className="variant-metrics">{minutesLabel(a.metrics.planned_minutes, ar)} · {t(`${a.metrics.tasks} tasks`, `${a.metrics.tasks} مهام`)}{a.metrics.unscheduled_must_do ? ` · ${t(`${a.metrics.unscheduled_must_do} must-do left`, `${a.metrics.unscheduled_must_do} ضرورية متبقية`)}` : ''}</span>
            </button>)}
          </div>
          {alt && <>
            {alt.items.length === 0 ? <p className="muted">{t('Nothing fits in the free time left today. Try tomorrow or free up a commitment.', 'لا شيء يتسع في الوقت المتبقي اليوم. جرّب الغد أو حرّر التزاماً.')}</p> :
              <ol className="day-timeline">{[...alt.items.map(i => ({ type: 'item' as const, at: i.starts_at, item: i })), ...alt.breaks.map(b => ({ type: 'break' as const, at: b.at, brk: b }))].sort((a, b) => a.at.localeCompare(b.at)).map((row, i) => row.type === 'item' ? <li key={i} className={`area-${row.item.area ?? 'work'}`}>
                <time>{time(row.item.starts_at)}<span>{time(row.item.ends_at)}</span></time>
                <div><strong>{row.item.title}</strong><div className="metadata"><span>{minutesLabel(row.item.minutes, ar)}</span>{row.item.area && row.item.area !== 'work' && <span className="chip">{row.item.area === 'study' ? t('Study', 'دراسة') : t('Personal', 'شخصي')}</span>}{row.item.reasons.slice(0, 3).map(r => <span key={r} className={`chip reason-${r}`}>{reason(r)}</span>)}</div>{row.item.explanation && <small className="muted">{bi(row.item.explanation)}</small>}</div>
              </li> : <li key={i} className="break-row"><Coffee size={15} /><span>{t(`${row.brk.minutes}-minute break after`, `استراحة ${row.brk.minutes} دقيقة بعد`)} {time(row.brk.at)} — {bi(row.brk)}</span></li>)}</ol>}
            {alt.warnings.length > 0 && <div className="unscheduled"><h3>{t('Must-dos that do not fit', 'مهام ضرورية لا تتسع')}</h3><ul>{alt.warnings.map(w => <li key={w.task_id}><strong>{w.title}</strong> · {t(`needs ${minutesLabel(w.needed_minutes, false)} more`, `تحتاج ${minutesLabel(w.needed_minutes, true)} إضافية`)}<small className="muted">{w.alternatives.map(a => bi(a)).join(' ')}</small></li>)}</ul></div>}
            <div className="toolbar plan-actions">
              {!proposal ? <button className="primary" disabled={busy || alt.items.length === 0} onClick={() => void choose()}><Check size={16} />{t('Use this plan', 'استخدم هذه الخطة')}</button> : <>
                <button className="primary" disabled={busy} onClick={() => void accept()}><CalendarCheck size={16} />{t(`Add ${proposal.items.length} blocks to calendar`, `أضف ${proposal.items.length} فترات إلى التقويم`)}</button>
                <Link className="quiet" to="/planning">{t('Fine-tune in the planner', 'عدّل في المخطط')}</Link>
              </>}
            </div>
            <p className="muted small">{t('Blocks are only added when you confirm. Times are re-checked against your calendar first.', 'لا تُضاف الفترات إلا بعد تأكيدك، ويُعاد التحقق من الأوقات مقابل تقويمك أولاً.')}</p>
          </>}
        </section>
        <aside className="panel reveal">
          <h2>{t('Fixed today', 'ثابت اليوم')}</h2>
          {data.commitments.length === 0 ? <p className="muted">{t('No commitments — a clear day.', 'لا التزامات — يوم صافٍ.')}</p> :
            <ul className="commitment-list">{data.commitments.map((c, i) => <li key={i}><time>{time(c.starts_at)}–{time(c.ends_at)}</time><span>{c.title}</span>{c.kind === 'fixed' && <Lock size={13} aria-label={t('Fixed', 'ثابت')} />}{c.recurring && <Repeat size={13} aria-label={t('Recurring', 'متكرر')} />}{c.source !== 'lifeos' && <Globe size={13} aria-label={t('External calendar', 'تقويم خارجي')} />}</li>)}</ul>}
          <h3>{t('Boundaries', 'الحدود')}</h3>
          {Object.keys(data.boundaries).length === 0 ? <p className="muted small">{t('No working window today.', 'لا توجد فترة عمل اليوم.')}</p> :
            <ul className="boundary-list">{Object.entries(data.boundaries).map(([area, w]) => <li key={area}><span className={`dot area-${area}`} />{area === 'work' ? t('Work', 'العمل') : area === 'study' ? t('Study', 'الدراسة') : t('Personal', 'شخصي')}<time>{w.start}–{w.end}</time></li>)}</ul>}
        </aside>
      </div>
    </>}
  </section>
}

function BoundaryEditor({ onSaved }: { onSaved: () => void }) {
  const t = useText()
  const { data } = useApi<Record<string, unknown>>('/api/settings')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function save(form: FormData) {
    setBusy(true); setError('')
    const v = (k: string) => (form.get(k) as string) || null
    try { await api('/api/settings', 'PUT', { buffer_minutes: Number(form.get('buffer_minutes') || 0), study_start: v('study_start'), study_end: v('study_end'), personal_start: v('personal_start'), personal_end: v('personal_end') }); onSaved() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  if (!data) return <section className="panel"><Skeleton lines={2} /></section>
  return <form className="panel boundary-editor reveal" action={form => void save(form)}>
    <h2>{t('Boundaries and buffers', 'الحدود والفواصل')}</h2>
    <p className="muted small">{t('Work hours come from General settings. Give a category the Study or Personal area to plan its tasks in these windows.', 'تأتي ساعات العمل من الإعدادات العامة. اجعل منطقة الفئة «دراسة» أو «شخصي» لتُخطط مهامها في هذه الفترات.')}</p>
    <div className="form-grid">
      <label>{t('Buffer around commitments (min)', 'فاصل حول الالتزامات (د)')}<input name="buffer_minutes" type="number" min={0} max={60} defaultValue={Number(data.buffer_minutes ?? 10)} /></label>
      <span />
      <label>{t('Study from', 'الدراسة من')}<input name="study_start" type="time" defaultValue={String(data.study_start ?? '')} /></label>
      <label>{t('Study until', 'الدراسة حتى')}<input name="study_end" type="time" defaultValue={String(data.study_end ?? '')} /></label>
      <label>{t('Personal time from', 'الوقت الشخصي من')}<input name="personal_start" type="time" defaultValue={String(data.personal_start ?? '')} /></label>
      <label>{t('Personal time until', 'الوقت الشخصي حتى')}<input name="personal_end" type="time" defaultValue={String(data.personal_end ?? '')} /></label>
    </div>
    <ErrorMessage error={error} />
    <button className="primary" disabled={busy}>{t('Save boundaries', 'حفظ الحدود')}</button>
  </form>
}
