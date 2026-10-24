import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight, Check, CalendarDays, Timer, Sparkles, Flame, Lightbulb, AlertTriangle, PartyPopper, Target, Play } from 'lucide-react'
import { api, type Briefing, type Suggestion } from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { useLanguage } from '../contexts/LanguageContext'
import { useText } from '../lib/i18n'
import { useReasonLabel } from '../lib/labels'
import { useApi } from '../lib/useApi'
import { localDate } from '../lib/hooks'
import { Empty, ErrorMessage, Skeleton } from '../components/ui/Shared'

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

function minutesLabel(minutes: number, t: (en: string, ar: string) => string) {
  const h = Math.floor(minutes / 60), m = minutes % 60
  return h ? `${h}${t('h', 'س')} ${m ? `${m}${t('m', 'د')}` : ''}`.trim() : `${m}${t('m', 'د')}`
}

export default function Dashboard() {
  const t = useText(), auth = useAuth(), { language } = useLanguage(), reason = useReasonLabel()
  const briefing = useApi<Briefing>('/api/briefing'), overview = useOverview()
  const [error, setError] = useState(''), [busy, setBusy] = useState<number | null>(null)
  const data = briefing.data
  const greeting = data?.period === 'evening' ? t('Good evening', 'مساء الخير') : data?.period === 'afternoon' ? t('Good afternoon', 'نهارك سعيد') : t('Good morning', 'صباح الخير')
  async function act(id: number, fn: () => Promise<unknown>) {
    setBusy(id); setError('')
    try { await fn(); briefing.reload(); await overview.reload() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const [now] = useState(() => Date.now())
  return <section className="page dashboard">
    <header className="daily-header reveal">
      <div>
        <p className="eyebrow">{new Date().toLocaleDateString(language, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        <h1>{greeting}{t(', ','، ')}{auth.user?.name.split(' ')[0]}<span className="accent-dot">.</span></h1>
        <p className="muted">{data ? t(`${data.focus.length} priorities · ${data.agenda.length} on your calendar · ${data.stats.focus_minutes_today} focus minutes today`, `${data.focus.length} أولويات · ${data.agenda.length} في تقويمك · ${data.stats.focus_minutes_today} دقيقة تركيز اليوم`) : t('A clear view of what matters today.', 'نظرة واضحة على ما يهمك اليوم.')}</p>
      </div>
      <div className="toolbar">
        <Link className="quiet" to="/focus"><Timer size={18} />{t('Focus', 'تركيز')}</Link>
        <Link className="primary" to="/planning"><Sparkles size={18} />{t('Plan my day', 'خطط يومي')}</Link>
      </div>
    </header>
    <ErrorMessage error={error || briefing.error || overview.error} />
    {data && data.suggestions.length > 0 && <div className="suggestions">{data.suggestions.map((s, i) => <SuggestionCard key={i} suggestion={s} index={i} />)}</div>}
    <div className="stats-grid">
      {!data ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={112} />) : <>
        <div className="stat reveal"><span>{t('Completed today', 'أُنجز اليوم')}</span><strong>{data.stats.completed_today}</strong><small className="muted">{t(`${data.stats.open_tasks} still open`, `${data.stats.open_tasks} مفتوحة`)}</small></div>
        <div className="stat reveal" style={{ animationDelay: '50ms' }}><span>{t('Focus today', 'تركيز اليوم')}</span><strong>{minutesLabel(data.stats.focus_minutes_today, t)}</strong><small className="muted">{t(`${overview.data?.focus_minutes ?? 0} min this week`, `${overview.data?.focus_minutes ?? 0} دقيقة هذا الأسبوع`)}</small></div>
        <div className={`stat reveal ${data.stats.overdue_tasks ? 'stat-alert' : ''}`} style={{ animationDelay: '100ms' }}><span>{t('Overdue', 'متأخرة')}</span><strong>{data.stats.overdue_tasks}</strong><Link className="muted" to="/tasks?due=overdue">{t('Review', 'مراجعة')}</Link></div>
        <div className="stat reveal" style={{ animationDelay: '150ms' }}><span>{t('Day load', 'حِمل اليوم')}</span><strong>{data.stats.available_minutes ? `${data.stats.load_percent}%` : '—'}</strong><div className="meter" aria-hidden="true"><div className={data.stats.load_percent > 100 ? 'over' : ''} style={{ width: `${Math.min(100, data.stats.load_percent)}%` }} /></div><small className="muted">{data.stats.available_minutes ? t(`${minutesLabel(data.stats.booked_minutes, t)} booked of ${minutesLabel(data.stats.available_minutes, t)}`, `${minutesLabel(data.stats.booked_minutes, t)} محجوزة من ${minutesLabel(data.stats.available_minutes, t)}`) : t('Not a working day', 'ليس يوم عمل')}</small></div>
      </>}
    </div>
    <div className="dashboard-grid">
      <section className="panel reveal">
        <header className="row"><div><h2>{t('Your next moves', 'خطواتك التالية')}</h2><p className="muted">{t('Ranked by urgency, importance and deadlines.', 'مرتبة حسب الإلحاح والأهمية والمواعيد.')}</p></div><Link to="/tasks" className="icon-button" aria-label={t('All tasks', 'كل المهام')}><ArrowUpRight size={20} className="flip-rtl" /></Link></header>
        {!data ? <Skeleton lines={3} /> : !data.focus.length ? <Empty>{t('A little breathing room. Add a task when you’re ready.', 'مساحة لالتقاط الأنفاس. أضف مهمة حين تكون مستعداً.')}</Empty> : data.focus.map((item, i) => <div className="record-row focus-row" key={item.id}>
          <span className="rank">{i + 1}</span>
          <button className="check" disabled={busy === item.id} aria-label={t('Complete task', 'إكمال المهمة')} onClick={() => void act(item.id, () => api(`/api/tasks/${item.id}`, 'PATCH', { status: 'completed' }))}><Check size={16} /></button>
          <div className="record-main"><strong>{item.title}</strong><div className="metadata"><span>{item.estimated_minutes} {t('min', 'د')}</span>{item.due_at && <time>{new Date(item.due_at).toLocaleString(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}{item.reasons.filter(r => r !== 'quick_win' || item.reasons.length === 1).map(r => <span key={r} className={`chip reason-${r}`}>{reason(r)}</span>)}</div></div>
          <Link to={`/focus?task=${item.id}`} className="icon-button" aria-label={t('Focus on this task', 'ركّز على هذه المهمة')}><Play size={16} /></Link>
        </div>)}
      </section>
      <section className="panel reveal">
        <header className="row"><h2>{t('Today, in perspective', 'نظرة على اليوم')}</h2><CalendarDays size={19} /></header>
        {!data ? <Skeleton lines={3} /> : data.agenda.length === 0 ? <Empty>{t('Your calendar is open today.', 'تقويمك متاح اليوم.')}</Empty> : <ol className="agenda">{data.agenda.map(event => {
          const start = new Date(event.starts_at).getTime(), end = new Date(event.ends_at).getTime()
          const state = end < now ? 'past' : start <= now ? 'live' : ''
          return <li className={`timeline-item ${state}`} key={event.id}><time>{new Date(event.starts_at).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })}</time><div className={`kind-${event.kind}`}><strong>{event.title}</strong><p className="muted">{state === 'live' ? t('Happening now', 'يحدث الآن') : event.kind === 'fixed' ? t('Fixed commitment', 'موعد ثابت') : t('Flexible time', 'وقت مرن')} · {Math.round((end - start) / 60000)} {t('min', 'د')}</p></div></li>
        })}</ol>}
        <Link className="quiet" to="/calendar">{t('Open calendar', 'فتح التقويم')}</Link>
      </section>
      <section className="panel reveal">
        <header className="row"><h2>{t('Habits today', 'عادات اليوم')}</h2><Link to="/habits">{t('Manage', 'إدارة')}</Link></header>
        {!data ? <Skeleton lines={2} /> : !data.habits.length ? <Empty>{t('Small routines create big change. Add your first habit.', 'الروتين الصغير يصنع تغييراً كبيراً. أضف أول عادة.')}</Empty> : <div className="habit-list">{data.habits.map(habit => <button key={habit.id} className={`habit-chip ${habit.done_today ? 'done' : ''} ${habit.at_risk ? 'risk' : ''}`} aria-pressed={habit.done_today} disabled={busy === -habit.id} onClick={() => void act(-habit.id, () => api(`/api/habits/${habit.id}/entry`, 'PUT', { date: localDate(), completed: !habit.done_today }))}>
          <span className="habit-check">{habit.done_today && <Check size={14} />}</span><span className="habit-name">{habit.title}</span><span className="streak" title={t('Current streak', 'السلسلة الحالية')}><Flame size={14} />{habit.current_streak}</span>
        </button>)}</div>}
      </section>
      <section className="panel reveal">
        <header className="row"><h2>{t('Goals in motion', 'أهداف قيد التقدم')}</h2><Target size={19} /></header>
        {!data ? <Skeleton lines={2} /> : !data.goals.length ? <Empty>{t('Set a goal to give your days direction.', 'حدد هدفاً يمنح أيامك اتجاهاً.')}</Empty> : data.goals.map(goal => <div className="goal-row" key={goal.id}><div className="row"><strong>{goal.title}</strong><span className="muted">{goal.percent}%</span></div><div className="meter"><div style={{ width: `${goal.percent}%`, background: goal.color }} /></div><small className="muted">{goal.progress} / {goal.target}{goal.due_at ? ` · ${new Date(goal.due_at).toLocaleDateString(language)}` : ''}</small></div>)}
        <Link className="quiet" to="/goals">{t('All goals', 'كل الأهداف')}</Link>
      </section>
      <section className="focus-callout reveal"><Timer size={26} /><h2>{t('Give one thing your full attention.', 'امنح شيئاً واحداً كامل انتباهك.')}</h2><p>{data?.focus[0] ? t(`Next up: ${data.focus[0].title}`, `التالي: ${data.focus[0].title}`) : t('Choose a task. Set a timer. Find your rhythm.', 'اختر مهمة واضبط المؤقت وابدأ بإيقاعك.')}</p><Link to={data?.focus[0] ? `/focus?task=${data.focus[0].id}` : '/focus'} className="primary">{t('Enter focus mode', 'دخول وضع التركيز')}</Link></section>
      <section className="panel reveal"><header className="row"><h2>{t('Your weekly rhythm', 'إيقاع أسبوعك')}</h2><Link to="/analytics">{t('Insights', 'التحليلات')}</Link></header>{overview.data ? <WeeklyChart data={overview.data} /> : <Skeleton height={200} />}</section>
    </div>
  </section>
}
