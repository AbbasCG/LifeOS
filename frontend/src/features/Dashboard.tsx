import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight, Check, Flame, Lightbulb, AlertTriangle, PartyPopper, Target, Play, SlidersHorizontal, ClipboardCheck, LayoutGrid, ListChecks } from 'lucide-react'
import { api, type Briefing, type PlannedVsActual, type Suggestion } from '../lib/api'
import { FULL_WIDTH, normalizeLayout, type DashboardLayout, type WidgetId } from '../lib/dashboard'
import { mondayOf } from '../lib/dates'
import DashboardCustomizer from './DashboardCustomizer'
import { useAuth } from '../contexts/AuthContext'
import { useLanguage } from '../contexts/LanguageContext'
import { useText } from '../lib/i18n'
import { useReasonLabel } from '../lib/labels'
import { useApi } from '../lib/useApi'
import { localDate } from '../lib/hooks'
import { Empty, ErrorMessage, Skeleton } from '../components/ui/Shared'
import { NowCard, TodayStrip, TopThree, ProgressRow, CopilotPick } from './today/NowView'
import { Expandable, RingStat } from '../components/visual'
import { TASKS_CHANGED } from '../lib/quickAdd'
import { HABITS_CHANGED, openHabitSheet } from '../lib/quickActions'
import { HALF_WIDTH, normalizeToday, useDevice, type TodayLayout, type TodaySection } from '../lib/todayLayout'
import { TodayCustomizer } from './today/TodayCustomizer'
import { HabitBurst } from './progress/Journey'
import { DayDial } from './today/DayDial'
import { IntelligenceBriefing } from './intelligence/IntelligenceBriefing'
import { BriefingWidget, CheckinWidget, DeadlinesWidget, FocusTimeWidget, ProgressWidget, QuickActionsWidget } from './today/TodayWidgets'
import type { TodayData } from '../lib/api'

export type Overview={total_tasks:number;completed_tasks:number;completion_rate:number;overdue_tasks:number;focus_minutes:number;estimated_minutes:number;actual_minutes:number;days:{date:string;minutes:number}[]}
export function useOverview(){const [data,setData]=useState<Overview|null>(null),[error,setError]=useState('');async function reload(){try{setData(await api<Overview>('/api/overview'))}catch(e){setError((e as Error).message)}}useEffect(()=>{let active=true;api<Overview>('/api/overview').then(v=>{if(active)setData(v)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[]);return{data,error,reload}}
export function WeeklyChart({data}:{data:Overview}){const t=useText();const max=Math.max(1,...data.days.map(d=>d.minutes));return <div className="weekly-chart" role="img" aria-label={data.days.map(d=>`${d.date}: ${d.minutes} ${t('minutes','دقائق')}`).join(', ')}>{data.days.map(d=><div key={d.date} title={`${d.minutes} ${t('min','د')}`}><span>{d.minutes}</span><div className="bar-track"><div style={{height:`${d.minutes/max*100}%`}}/></div><small>{new Date(d.date+'T12:00').toLocaleDateString(undefined,{weekday:'short'})}</small></div>)}</div>}

const suggestionIcon = { info: Lightbulb, warning: AlertTriangle, positive: PartyPopper }

export function SuggestionCard({ suggestion, index }: { suggestion: Suggestion; index: number }) {
  const { language } = useLanguage()
  const Icon = suggestionIcon[suggestion.type] || Lightbulb
  const body = <><span className="suggestion-icon"><Icon size={18} /></span><p>{language === 'ar' ? suggestion.ar : suggestion.en}</p>{suggestion.action && <ArrowUpRight size={16} className="flip-rtl" />}</>
  const className = `suggestion ${suggestion.type} reveal`
  const style = { animationDelay: `${index * 60}ms` }
  return suggestion.action ? <Link to={suggestion.action} className={className} style={style}>{body}</Link> : <div className={className} style={style}>{body}</div>
}

function ReviewWidget() {
  const t = useText(), { language } = useLanguage(), ar = language === 'ar'
  const { data } = useApi<PlannedVsActual>(`/api/plans/insights?from=${mondayOf()}&days=7`)
  const totals = data?.totals
  const today = new Date().getDay()
  return <section className="panel reveal review-widget">
    <header className="row"><h2>{t('This week’s plan', 'خطة هذا الأسبوع')}</h2><ClipboardCheck size={19} /></header>
    {!totals ? <Skeleton lines={2} /> : totals.planned_minutes === 0 ? <p className="muted">{t('No planned focus blocks this week yet.', 'لا توجد فترات تركيز مخططة هذا الأسبوع بعد.')}</p> : <>
      <div className="row"><strong className="big-number">{Math.round((totals.ratio ?? 0) * 100)}%</strong><span className="muted">{t(`${Math.round(totals.actual_minutes / 60 * 10) / 10}h of ${Math.round(totals.planned_minutes / 60 * 10) / 10}h planned`, `${Math.round(totals.actual_minutes / 60 * 10) / 10} س من ${Math.round(totals.planned_minutes / 60 * 10) / 10} س مخططة`)}</span></div>
      <div className="meter"><div style={{ width: `${Math.min(100, (totals.ratio ?? 0) * 100)}%` }} /></div>
      <small className="muted">{ar ? `${totals.completed_planned_tasks}/${totals.planned_tasks} مهام مخططة منجزة` : `${totals.completed_planned_tasks}/${totals.planned_tasks} planned tasks done`}</small>
    </>}
    <div className="toolbar"><Link className="quiet" to="/planning">{t('Plan', 'خطّط')}</Link><Link className={today === 0 || today >= 5 ? 'primary' : 'quiet'} to="/review">{t('Weekly review', 'المراجعة الأسبوعية')}</Link></div>
  </section>
}

/** Widgets the new Today screen already shows up top; they are not repeated under "More for today". */
const SHOWN_ABOVE: WidgetId[] = ['next_moves', 'stats', 'agenda', 'progress', 'focus', 'actions', 'suggestions']

/**
 * Today (V20): understand the day in three seconds. One dominant NOW card with one action, today on a single strip,
 * the top three tasks, progress rings and one Copilot suggestion. Everything else is one tap away under "More".
 */
export default function Dashboard() {
  const t = useText(), auth = useAuth(), { language } = useLanguage(), reason = useReasonLabel()
  const briefing = useApi<Briefing>('/api/briefing'), overview = useOverview(), today = useApi<TodayData>('/api/today')
  const [error, setError] = useState(''), [busy, setBusy] = useState<number | null>(null), [burst, setBurst] = useState<number | null>(null), [customizing, setCustomizing] = useState(false)
  const settings = useApi<{ dashboard?: Partial<DashboardLayout>; today_layout?: TodayLayout }>('/api/settings')
  const device = useDevice(), [customizingTop, setCustomizingTop] = useState(false)
  const layout = normalizeLayout(settings.data?.dashboard)
  const data = briefing.data
  const greeting = data?.period === 'evening' ? t('Good evening', 'مساء الخير') : data?.period === 'afternoon' ? t('Good afternoon', 'نهارك سعيد') : t('Good morning', 'صباح الخير')
  const refresh = () => { briefing.reload(); today.reload(); void overview.reload() }
  useEffect(() => { window.addEventListener(TASKS_CHANGED, refresh); window.addEventListener(HABITS_CHANGED, refresh); return () => { window.removeEventListener(TASKS_CHANGED, refresh); window.removeEventListener(HABITS_CHANGED, refresh) } })
  async function act(id: number, fn: () => Promise<unknown>) {
    setBusy(id); setError('')
    try { await fn(); refresh() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const habits = data?.habits ?? []
  const habitChips = habits.length > 0 && <div className="habit-list compact" aria-label={t('Habits today', 'عادات اليوم')}>{habits.slice(0, 8).map(habit => <button key={habit.id} className={`habit-chip ${habit.done_today ? 'done' : ''} ${habit.at_risk ? 'risk' : ''}`} aria-pressed={habit.done_today} disabled={busy === -habit.id} onClick={() => void act(-habit.id, async () => { await api(`/api/habits/${habit.id}/entry`, 'PUT', { date: localDate(), completed: !habit.done_today }); if (!habit.done_today) { setBurst(habit.id); window.setTimeout(() => setBurst(b => b === habit.id ? null : b), 700) } })}>
    {burst === habit.id && <HabitBurst />}<span className="habit-check">{habit.done_today && <Check size={14} />}</span><span className="habit-name">{habit.title}</span><span className="streak" title={t('Current streak', 'السلسلة الحالية')}><Flame size={14} />{habit.current_streak}</span>
  </button>)}</div>
  const widgets: Record<WidgetId, ReactNode> = {
    today: <BriefingWidget data={today.data} />,
    progress: <ProgressWidget data={today.data} />,
    focus_time: <FocusTimeWidget data={today.data} />,
    checkin: <CheckinWidget data={today.data} onChange={() => { today.reload(); briefing.reload() }} />,
    deadlines: <DeadlinesWidget data={today.data} />,
    actions: <QuickActionsWidget />,
    intelligence: <IntelligenceBriefing />,
    suggestions: null,
    stats: null,
    next_moves: <section className="panel reveal">
        <header className="row"><h2>{t('Your next moves', 'خطواتك التالية')}</h2><Link to="/tasks" className="icon-button" aria-label={t('All tasks', 'كل المهام')}><ArrowUpRight size={20} className="flip-rtl" /></Link></header>
        {!data ? <Skeleton lines={3} /> : !data.focus.length ? <Empty>{t('Nothing open.', 'لا شيء مفتوح.')}</Empty> : data.focus.map((item, i) => <div className="record-row focus-row" key={item.id}>
          <span className="rank">{i + 1}</span>
          <button className="check" disabled={busy === item.id} aria-label={t('Complete task', 'إكمال المهمة')} onClick={() => void act(item.id, () => api(`/api/tasks/${item.id}`, 'PATCH', { status: 'completed' }))}><Check size={16} /></button>
          <div className="record-main"><strong>{item.title}</strong><div className="metadata"><span>{item.estimated_minutes} {t('min', 'د')}</span>{item.due_at && <time>{new Date(item.due_at).toLocaleString(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}{item.reasons.filter(r => r !== 'quick_win' || item.reasons.length === 1).map(r => <span key={r} className={`chip reason-${r}`}>{reason(r)}</span>)}</div></div>
          <Link to={`/focus?task=${item.id}`} className="icon-button" aria-label={t('Focus on this task', 'ركّز على هذه المهمة')}><Play size={16} /></Link>
        </div>)}
      </section>,
    agenda: <DayDial data={today.data} />,
    habits: null,
    goals: <section className="panel reveal">
        <header className="row"><h2>{t('Goals in motion', 'أهداف قيد التقدم')}</h2><Link to="/goals" className="icon-button" aria-label={t('All goals', 'كل الأهداف')}><Target size={19} /></Link></header>
        {!data ? <Skeleton lines={2} /> : !data.goals.length ? <Empty>{t('No goals yet.', 'لا أهداف بعد.')}</Empty> : <div className="goal-rings">{data.goals.map(goal => <RingStat key={goal.id} value={goal.percent} max={100} display={`${goal.percent}%`} caption={goal.title} to="/goals" />)}</div>}
      </section>,
    focus: null,
    weekly: <section className="panel reveal"><header className="row"><h2>{t('Your weekly rhythm', 'إيقاع أسبوعك')}</h2><Link to="/analytics">{t('Insights', 'التحليلات')}</Link></header>{overview.data ? <WeeklyChart data={overview.data} /> : <Skeleton height={200} />}</section>,
    review: <ReviewWidget />,
  }
  const more = layout.order.filter(id => !layout.hidden.includes(id) && !SHOWN_ABOVE.includes(id) && widgets[id] !== null)
  const date = new Date(`${(data?.date ?? today.data?.date ?? localDate())}T12:00:00`).toLocaleDateString(language, { weekday: 'long', day: 'numeric', month: 'long' })

  // V22: the top of Today in the order chosen for this device; hidden sections move into "More for today".
  const top = normalizeToday(settings.data?.today_layout?.[device])
  const sections: Record<TodaySection, ReactNode> = {
    now: <NowCard briefing={data} today={today.data} onDone={refresh} />,
    strip: <TodayStrip today={today.data} />,
    top3: <TopThree briefing={data} onChange={refresh} />,
    progress: <ProgressRow today={today.data} />,
    habits: habitChips && <section className="panel habits-today" aria-label={t('Habits today', 'عادات اليوم')}>{habitChips}<button type="button" className="quiet habit-all" onClick={openHabitSheet}><ListChecks size={15} aria-hidden="true" />{t('All habits', 'كل العادات')}</button></section>,
    copilot: <CopilotPick />,
    suggestions: data && data.suggestions.length > 0 && <div className="suggestions compact">{data.suggestions.slice(0, 2).map((s, i) => <SuggestionCard key={i} suggestion={s} index={i} />)}</div>,
  }
  // Two half-width sections side by side only when they follow each other; the chosen order is never rearranged.
  const place = (ids: TodaySection[]) => {
    const visible = ids.filter(id => sections[id]), half = new Set<TodaySection>()
    for (let i = 0; i < visible.length - 1; i++) if (HALF_WIDTH.includes(visible[i]) && HALF_WIDTH.includes(visible[i + 1])) { half.add(visible[i]); half.add(visible[i + 1]); i++ }
    return visible.map(id => <div key={id} className={`today-section section-${id} ${half.has(id) ? 'half' : 'full'}`}>{sections[id]}</div>)
  }

  return <section className="page dashboard v20">
    <header className="today-head">
      <h1>{date}</h1>
      <p className="muted">{greeting}{t(', ', '، ')}{auth.user?.name.split(' ')[0]}</p>
      <button type="button" className="icon-button today-customize" onClick={() => setCustomizingTop(true)} aria-label={t('Customize Today', 'تخصيص «اليوم»')} title={t('Customize Today', 'تخصيص «اليوم»')}><SlidersHorizontal size={19} /></button>
    </header>
    <ErrorMessage error={error || briefing.error || overview.error || today.error} />
    <div className="today-top">{place(top.order.filter(id => !top.hidden.includes(id)))}</div>
    <Expandable className="today-more" icon={<LayoutGrid size={18} aria-hidden="true" />} summary={t('More for today', 'المزيد لليوم')}>
      <div className="row"><span className="muted small">{t('Briefing, deadlines, goals, check-in and more.', 'الإحاطة والمواعيد والأهداف والتسجيل وغيرها.')}</span>
        <button className="icon-button" aria-label={t('Customize dashboard', 'تخصيص لوحة المعلومات')} title={t('Customize dashboard', 'تخصيص لوحة المعلومات')} onClick={() => setCustomizing(true)}><SlidersHorizontal size={19} /></button></div>
      {top.hidden.length > 0 && <div className="today-top in-more">{place(top.order.filter(id => top.hidden.includes(id)))}</div>}
      <div className="dashboard-grid">
        {more.map(id => <div key={id} className={`widget widget-${id} ${FULL_WIDTH.includes(id) ? 'span-full' : ''}`}>{widgets[id]}</div>)}
      </div>
    </Expandable>
    {customizingTop && <TodayCustomizer saved={settings.data?.today_layout ?? {}} device={device} onClose={() => setCustomizingTop(false)} onSaved={settings.reload} />}
    {customizing && <DashboardCustomizer layout={layout} onClose={() => setCustomizing(false)} onSaved={settings.reload} />}
  </section>
}
