import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { TrendingDown, TrendingUp, Minus, Info } from 'lucide-react'
import type { Analytics, PeriodComparison } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { minutesLabel } from '../../lib/dates'
import { Empty } from '../../components/ui/Shared'

const axis = { stroke: 'var(--color-text-muted)', fontSize: 11, tickLine: false, axisLine: false }
const tooltipStyle = { contentStyle: { background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, fontSize: 12, color: 'var(--color-text)' }, cursor: { fill: 'var(--color-surface-muted)' } }

function Panel({ title, subtitle, children, wide }: { title: string; subtitle?: string; children: ReactNode; wide?: boolean }) {
  return <section className={`panel chart-panel reveal ${wide ? 'wide' : ''}`}><header><h2>{title}</h2>{subtitle && <p className="muted">{subtitle}</p>}</header>{children}</section>
}

function Delta({ change, small, previous }: { change: number | null; small: boolean; previous: string }) {
  const t = useText()
  if (small) return <small className="muted">{t(`${previous} before — too little to compare`, `${previous} سابقاً — أقل من أن يُقارن`)}</small>
  if (change === null) return <small className="muted">{t('No earlier data', 'لا توجد بيانات سابقة')}</small>
  const Icon = change > 0 ? TrendingUp : change < 0 ? TrendingDown : Minus
  return <small className={`change ${change >= 0 ? 'up' : 'down'}`}><Icon size={14} />{change > 0 ? '+' : ''}{change}% · {t(`was ${previous}`, `كان ${previous}`)}</small>
}

export function PeriodCards({ periods }: { periods: Analytics['periods'] }) {
  const t = useText(), { language } = useLanguage(), ar = language === 'ar'
  if (!periods) return null
  const card = (title: string, sub: string, p: PeriodComparison) => <div className="period-card reveal">
    <h3>{title}</h3><p className="muted small">{sub}</p>
    <dl>
      <div><dt>{t('Tasks completed', 'مهام منجزة')}</dt><dd><strong>{p.current.completed}</strong><Delta change={p.change.completed} small={p.small_base.completed} previous={String(p.previous.completed)} /></dd></div>
      <div><dt>{t('Focus', 'التركيز')}</dt><dd><strong>{minutesLabel(p.current.focus_minutes, ar)}</strong><Delta change={p.change.focus_minutes} small={p.small_base.focus_minutes} previous={minutesLabel(p.previous.focus_minutes, ar)} /></dd></div>
    </dl>
  </div>
  return <div className="period-cards">
    {card(t('This week', 'هذا الأسبوع'), t('Compared with last week up to the same point.', 'مقارنة بالأسبوع الماضي حتى النقطة نفسها.'), periods.week)}
    {card(t('This month', 'هذا الشهر'), t('Compared with the same days of last month.', 'مقارنة بالأيام نفسها من الشهر الماضي.'), periods.month)}
  </div>
}

export function EnergyPanel({ energy }: { energy: Analytics['energy'] }) {
  const t = useText(), { language } = useLanguage(), ar = language === 'ar'
  if (!energy) return null
  const names = { low: t('Low energy (1–2)', 'طاقة منخفضة (١–٢)'), medium: t('Medium (3)', 'متوسطة (٣)'), high: t('High energy (4–5)', 'طاقة عالية (٤–٥)') }
  const max = Math.max(1, ...energy.groups.map(g => g.avg_focus_minutes ?? 0))
  return <Panel title={t('Energy vs productivity', 'الطاقة مقابل الإنتاجية')} subtitle={t('Average focus and completed tasks on days you checked in.', 'متوسط التركيز والمهام المنجزة في الأيام التي سجلت فيها حالتك.')}>
    {!energy.enabled ? <Empty>{t('Check-ins are turned off.', 'التسجيل اليومي متوقف.')} <Link to="/settings/wellbeing">{t('Wellbeing settings', 'إعدادات الرفاه')}</Link></Empty>
      : energy.checked_in_days === 0 ? <Empty>{t('No check-ins in this period. Add a daily check-in to see how energy relates to your work.', 'لا تسجيلات في هذه الفترة. سجّل حالتك يومياً لترى علاقة الطاقة بعملك.')}</Empty>
        : <>
          <ul className="bar-list energy-groups">{energy.groups.map(g => <li key={g.level} className={g.reliable ? '' : 'thin'}>
            <div className="row"><span>{names[g.level]}</span><span className="muted">{g.days ? `${minutesLabel(g.avg_focus_minutes ?? 0, ar)} · ${g.avg_completed} ${t('tasks', 'مهام')} · ${t(`${g.days} day(s)`, `${g.days} يوم`)}` : t('No days', 'لا أيام')}</span></div>
            <div className="meter"><div style={{ width: `${(g.avg_focus_minutes ?? 0) / max * 100}%` }} /></div>
          </li>)}</ul>
          <p className="muted small note"><Info size={13} />{energy.reliable
            ? t('Based on your own entries; a pattern, not proof of cause — and not medical advice.', 'مبني على تسجيلاتك؛ نمط وليس دليلاً على السبب — وليس نصيحة طبية.')
            : t(`Comparisons appear once at least two groups have ${energy.min_days_per_group ?? 3}+ days.`, `تظهر المقارنات عندما تضم مجموعتان على الأقل ${energy.min_days_per_group ?? 3} أيام أو أكثر.`)}</p>
        </>}
  </Panel>
}

export function ConsistencyPanel({ consistency }: { consistency: Analytics['consistency'] }) {
  const t = useText(), { language } = useLanguage(), ar = language === 'ar'
  if (!consistency) return null
  const weeks = consistency.weeks.map(w => ({ ...w, label: new Date(`${w.start}T12:00`).toLocaleDateString(language, { month: 'short', day: 'numeric' }) }))
  return <Panel title={t('Focus consistency', 'انتظام التركيز')} subtitle={t('How regularly you focus, week by week.', 'مدى انتظام تركيزك أسبوعاً بأسبوع.')}>
    <div className="mini-stats">
      <div><strong>{consistency.focus_days}/{consistency.days}</strong><span>{t('days with focus', 'أيام فيها تركيز')}</span></div>
      <div><strong>{consistency.longest_streak}</strong><span>{t('longest run (days)', 'أطول سلسلة (أيام)')}</span></div>
      <div><strong>{consistency.weekly_variation === null ? '—' : `±${consistency.weekly_variation}%`}</strong><span>{t('week-to-week swing', 'تذبذب أسبوعي')}</span></div>
    </div>
    {weeks.length > 1 && <ResponsiveContainer width="100%" height={180}>
      <BarChart data={weeks} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--color-border)" />
        <XAxis dataKey="label" {...axis} reversed={ar} />
        <YAxis allowDecimals={false} {...axis} orientation={ar ? 'right' : 'left'} />
        <Tooltip {...tooltipStyle} formatter={(v) => minutesLabel(Number(v), ar)} />
        <Bar dataKey="focus_minutes" name={t('Focus', 'التركيز')} fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={36} />
      </BarChart>
    </ResponsiveContainer>}
  </Panel>
}

export function WorkloadPanel({ workload }: { workload: Analytics['workload'] }) {
  const t = useText(), { language } = useLanguage(), ar = language === 'ar'
  if (!workload) return null
  const area = { work: t('Work', 'العمل'), study: t('Study', 'الدراسة'), personal: t('Personal', 'شخصي') }
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2026, 0, 4 + i).toLocaleDateString(language, { weekday: 'short' }))
  const maxDone = Math.max(1, ...workload.completed_by_weekday.map(d => d.completed))
  const due = workload.due_next_7_days
  return <Panel title={t('Workload distribution', 'توزيع العمل')} subtitle={t('Focus by life area (from category time boundaries) and completions by weekday.', 'التركيز حسب المجال (من حدود وقت الفئات) والإنجاز حسب أيام الأسبوع.')}>
    <ul className="bar-list">{workload.by_area.map(a => <li key={a.area}><div className="row"><span>{area[a.area]}</span><span className="muted">{minutesLabel(a.focus_minutes, ar)} · {a.share}% · {a.completed} {t('done', 'منجزة')}</span></div><div className="meter"><div style={{ width: `${a.share}%` }} /></div></li>)}</ul>
    <div className="weekday-strip" aria-label={t('Tasks completed by weekday', 'المهام المنجزة حسب اليوم')}>{workload.completed_by_weekday.map(d => <div key={d.weekday}><span style={{ height: `${Math.max(4, d.completed / maxDone * 48)}px` }} /><small>{weekdays[d.weekday]}</small><b>{d.completed}</b></div>)}</div>
    <p className="muted small">{t(`Next 7 days: ${due.tasks} open task(s) due${due.overdue ? `, ${due.overdue} already overdue` : ''} — about ${minutesLabel(due.remaining_minutes, false)} of remaining work.`, `الأيام السبعة القادمة: ${due.tasks} مهمة مستحقة${due.overdue ? `، منها ${due.overdue} متأخرة` : ''} — نحو ${minutesLabel(due.remaining_minutes, true)} من العمل المتبقي.`)}</p>
  </Panel>
}

export function GoalsPanel({ goals }: { goals: Analytics['goals'] }) {
  const t = useText()
  if (!goals) return null
  const status: Record<string, string> = { on_track: t('On track', 'على المسار'), at_risk: t('At risk', 'في خطر'), behind: t('Behind', 'متأخر'), overdue: t('Overdue', 'تجاوز الموعد'), completed: t('Completed', 'مكتمل'), no_deadline: t('No deadline', 'بلا موعد') }
  return <Panel title={t('Goal progress', 'تقدم الأهداف')} subtitle={t('Progress against the time used so far (marker = expected).', 'التقدم مقابل الوقت المستهلك (العلامة = المتوقع).')}>
    {!goals.length ? <Empty>{t('No goals yet.', 'لا توجد أهداف بعد.')} <Link to="/goals">{t('Add a goal', 'أضف هدفاً')}</Link></Empty> :
      <ul className="bar-list goal-progress">{goals.slice(0, 8).map(g => <li key={g.id}>
        <div className="row"><span><i className="swatch" style={{ background: g.color }} />{g.title}</span><span className={`badge health-${g.status}`}>{status[g.status] ?? g.status}</span></div>
        <div className="meter with-marker"><div style={{ width: `${g.percent}%`, background: g.color }} />{g.expected_percent !== null && <i style={{ insetInlineStart: `${g.expected_percent}%` }} aria-hidden="true" />}</div>
        <small className="muted">{g.percent}%{g.expected_percent !== null ? t(` · expected ${g.expected_percent}%`, ` · المتوقع ${g.expected_percent}%`) : ''}{g.days_left !== null ? t(` · ${g.days_left} day(s) left`, ` · متبقٍ ${g.days_left} يوم`) : ''}</small>
      </li>)}</ul>}
  </Panel>
}
