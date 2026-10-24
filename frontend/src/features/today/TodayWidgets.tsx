import { Link } from 'react-router'
import { Sunrise, Moon, CalendarClock, Hourglass, Play, Plus, Timer, HeartPulse, ClipboardCheck, Sparkles, Battery, BatteryLow, Gauge, Bot } from 'lucide-react'
import type { TodayData } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { minutesLabel } from '../../lib/dates'
import { Skeleton } from '../../components/ui/Shared'
import { CheckinCard } from '../wellbeing/CheckinCard'

type Props = { data: TodayData | null; onChange?: () => void }

export function BriefingWidget({ data }: Props) {
  const t = useText(), { language } = useLanguage(), ar = language === 'ar'
  const evening = data?.period === 'evening'
  return <section className={`panel reveal briefing-widget ${evening ? 'evening' : ''}`} aria-live="polite">
    <header className="row"><h2>{evening ? <><Moon size={18} />{t('Evening summary', 'ملخص المساء')}</> : <><Sunrise size={18} />{t('Morning briefing', 'إحاطة الصباح')}</>}</h2>{!evening && <Link className="quiet" to="/today/plan"><Sparkles size={15} />{t('Plan my day', 'خطط يومي')}</Link>}</header>
    {!data ? <Skeleton lines={3} /> : <ul className="briefing-lines">{data.briefing.map((line, i) => <li key={i}>{ar ? line.ar : line.en}</li>)}</ul>}
    {data?.reflection_prompt && <p className="reflection-prompt"><span>{ar ? data.reflection_prompt.ar : data.reflection_prompt.en}</span><Link className="quiet" to="/settings/wellbeing">{t('Write a reflection', 'اكتب تأملاً')}</Link></p>}
  </section>
}

function Ring({ value, label, detail, color }: { value: number; label: string; detail: string; color: string }) {
  const pct = Math.max(0, Math.min(1, value))
  return <div className="progress-ring" role="img" aria-label={`${label}: ${detail}`}>
    <svg viewBox="0 0 42 42" aria-hidden="true"><circle cx="21" cy="21" r="17" className="track" /><circle cx="21" cy="21" r="17" className="value" pathLength={100} strokeDasharray={`${pct * 100} 100`} style={{ stroke: color }} /></svg>
    <strong>{Math.round(pct * 100)}%</strong><span>{label}</span><small>{detail}</small>
  </div>
}

export function ProgressWidget({ data }: Props) {
  const t = useText(), { language } = useLanguage(), ar = language === 'ar'
  if (!data) return <section className="panel"><Skeleton height={120} /></section>
  const p = data.progress
  const ratio = (x: { done: number; target: number }) => x.target ? x.done / x.target : 0
  return <section className="panel reveal progress-widget">
    <header className="row"><h2>{t('Today’s progress', 'تقدم اليوم')}</h2><strong className="big-number">{p.overall}%</strong></header>
    <div className="rings">
      <Ring value={ratio(p.tasks)} color="var(--color-primary)" label={t('Tasks', 'المهام')} detail={p.tasks.target ? `${p.tasks.done}/${p.tasks.target}` : t('Nothing due', 'لا شيء مستحق')} />
      <Ring value={ratio(p.focus)} color="#0ea5e9" label={t('Focus', 'التركيز')} detail={`${minutesLabel(p.focus.done, ar)} / ${minutesLabel(p.focus.target, ar)}`} />
      <Ring value={ratio(p.habits)} color="var(--color-success)" label={t('Habits', 'العادات')} detail={p.habits.target ? `${p.habits.done}/${p.habits.target}` : t('None yet', 'لا يوجد')} />
    </div>
  </section>
}

export function CheckinWidget({ data, onChange }: Props) {
  const t = useText()
  if (!data) return <section className="panel"><Skeleton lines={3} /></section>
  if (!data.energy.enabled) return null
  const e = data.energy
  const levelLabel = { light: t('Light day', 'يوم خفيف'), moderate: t('Moderate load', 'عبء متوسط'), heavy: t('Heavy day', 'يوم ثقيل') }[e.level]
  return <section className="panel reveal checkin-widget" id="checkin">
    <header className="row"><h2><HeartPulse size={18} />{t('How are you today?', 'كيف حالك اليوم؟')}</h2>
      <span className={`badge load-${e.level}`}>{e.energy !== null && e.energy <= 2 ? <BatteryLow size={13} /> : e.energy !== null ? <Battery size={13} /> : <Gauge size={13} />}{levelLabel}{` · ${e.load_percent}%`}</span>
    </header>
    <CheckinCard key={e.checkin?.updated_at ?? 'new'} compact initial={e.checkin} date={data.date} onSaved={() => onChange?.()} />
  </section>
}

export function DeadlinesWidget({ data }: Props) {
  const t = useText(), { language } = useLanguage()
  const bucket = { overdue: t('Overdue', 'متأخرة'), today: t('Today', 'اليوم'), tomorrow: t('Tomorrow', 'غداً'), week: t('This week', 'هذا الأسبوع') }
  const type = { task: t('Task', 'مهمة'), project: t('Project', 'مشروع'), goal: t('Goal', 'هدف') }
  return <section className="panel reveal deadlines-widget">
    <header className="row"><h2><CalendarClock size={18} />{t('Upcoming deadlines', 'المواعيد القادمة')}</h2><Link to="/tasks?due=week">{t('All', 'الكل')}</Link></header>
    {!data ? <Skeleton lines={3} /> : data.deadlines.length === 0 ? <p className="muted">{t('No deadlines in the next 7 days.', 'لا مواعيد خلال الأيام السبعة القادمة.')}</p> :
      <ul className="deadline-list">{data.deadlines.slice(0, 6).map(d => <li key={`${d.type}-${d.id}`} className={`bucket-${d.bucket}`}>
        <span className="bucket">{bucket[d.bucket]}</span>
        <Link to={d.type === 'task' || d.type === 'external' ? '/tasks' : d.type === 'project' ? `/projects/${d.id}` : '/goals'}><strong>{d.title}</strong></Link>
        <small className="muted">{d.type === 'external' ? <span className="source-badge">{d.source}</span> : type[d.type]} · {new Date(d.due_at).toLocaleString(language, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</small>
      </li>)}</ul>}
  </section>
}

export function FocusTimeWidget({ data }: Props) {
  const t = useText(), { language } = useLanguage(), ar = language === 'ar'
  const time = (iso: string) => new Date(iso).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
  return <section className="panel reveal focus-time-widget">
    <header className="row"><h2><Hourglass size={18} />{t('Available focus time', 'وقت التركيز المتاح')}</h2>{data && <strong>{minutesLabel(data.focus_time.free_minutes, ar)}</strong>}</header>
    {!data ? <Skeleton lines={2} /> : data.focus_time.slots.length === 0 ? <p className="muted">{t('No free slot of 30+ minutes left today.', 'لا توجد فترة متاحة ٣٠ دقيقة أو أكثر اليوم.')}</p> :
      <ul className="slot-list">{data.focus_time.slots.map(s => <li key={s.starts_at}><time>{time(s.starts_at)}–{time(s.ends_at)}</time><span className="slot-bar"><span style={{ width: `${Math.min(100, s.minutes / 240 * 100)}%` }} /></span><small>{minutesLabel(s.minutes, ar)}</small></li>)}</ul>}
    {data?.focus_time.next_task && <Link className="primary" to={`/focus?task=${data.focus_time.next_task.id}`}><Play size={15} />{t(`Focus on “${data.focus_time.next_task.title}”`, `ركّز على «${data.focus_time.next_task.title}»`)}</Link>}
  </section>
}

export function QuickActionsWidget() {
  const t = useText()
  const actions = [
    { to: '/tasks', icon: Plus, label: t('Add a task', 'أضف مهمة') },
    { to: '/focus', icon: Timer, label: t('Start focus', 'ابدأ التركيز') },
    { to: '/today/plan', icon: Sparkles, label: t('Plan my day', 'خطط يومي') },
    { to: '/settings/wellbeing', icon: HeartPulse, label: t('Check in', 'سجّل حالتك') },
    { to: '/assistant', icon: Bot, label: t('Ask Copilot', 'اسأل المساعد') },
    { to: '/review', icon: ClipboardCheck, label: t('Weekly review', 'المراجعة الأسبوعية') },
  ]
  return <section className="panel reveal quick-actions">
    <h2>{t('Quick actions', 'إجراءات سريعة')}</h2>
    <div className="action-grid">{actions.map(a => <Link key={a.to} to={a.to} className="action-tile"><a.icon size={20} /><span>{a.label}</span></Link>)}</div>
  </section>
}
