import { useState, type ReactNode } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { TrendingDown, TrendingUp, Flame } from 'lucide-react'
import { type Analytics } from '../lib/api'
import { useApi } from '../lib/useApi'
import { useText } from '../lib/i18n'
import { useLanguage } from '../contexts/LanguageContext'
import { useStatusLabel } from './ResourcePage'
import { SuggestionCard } from './Dashboard'
import { Empty, ErrorMessage, Skeleton } from '../components/ui/Shared'

const RANGES = [7, 14, 30, 90]
const axis = { stroke: 'var(--color-text-muted)', fontSize: 11, tickLine: false, axisLine: false }
const tooltipStyle = { contentStyle: { background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 10, fontSize: 12, color: 'var(--color-text)' }, cursor: { fill: 'var(--color-surface-muted)' } }

function Change({ value, smallBase }: { value: number | null; smallBase?: string }) {
  const t = useText()
  if (value === null) return <small className="muted">{t('No previous data', 'لا توجد بيانات سابقة')}</small>
  // Percentages on a tiny baseline (e.g. 1 → 33 tasks = +3200%) mislead; show the previous amount instead.
  if (smallBase !== undefined) return <small className="muted">{t(`${smallBase} in the previous period`, `${smallBase} في الفترة السابقة`)}</small>
  const Icon = value >= 0 ? TrendingUp : TrendingDown
  return <small className={`change ${value >= 0 ? 'up' : 'down'}`}><Icon size={14} />{value > 0 ? '+' : ''}{value}% {t('vs previous', 'عن السابق')}</small>
}

function ChartPanel({ title, subtitle, children, wide }: { title: string; subtitle?: string; children: ReactNode; wide?: boolean }) {
  return <section className={`panel chart-panel reveal ${wide ? 'wide' : ''}`}><header><h2>{title}</h2>{subtitle && <p className="muted">{subtitle}</p>}</header>{children}</section>
}

export default function AnalyticsPage() {
  const t = useText(), { language } = useLanguage(), label = useStatusLabel()
  const [days, setDays] = useState(30)
  const { data, error, loading } = useApi<Analytics>(`/api/analytics?days=${days}`)
  const dayLabel = (date: string) => new Date(`${date}T12:00`).toLocaleDateString(language, days > 14 ? { month: 'short', day: 'numeric' } : { weekday: 'short' })
  const series = data?.series.map(d => ({ ...d, label: dayLabel(d.date) })) ?? []
  const hasActivity = !!data && (data.totals.completed > 0 || data.totals.focus_minutes > 0 || data.totals.created > 0)
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2026, 0, 4 + i).toLocaleDateString(language, { weekday: 'short' }))
  return <section className="page analytics-page">
    <header className="page-heading reveal">
      <div><p className="eyebrow">{t('Insights', 'التحليلات')}</p><h1>{t('See your progress', 'شاهد تقدمك')}</h1><p className="muted">{t('Patterns from your recorded work, compared with the period before.', 'أنماط من عملك المسجل مقارنة بالفترة السابقة.')}</p></div>
      <div className="segmented" role="radiogroup" aria-label={t('Time range', 'الفترة الزمنية')}>{RANGES.map(r => <button key={r} role="radio" aria-checked={days === r} className={days === r ? 'active' : ''} onClick={() => setDays(r)}>{t(`${r} days`, `${r} يوماً`)}</button>)}</div>
    </header>
    <ErrorMessage error={error} />
    {!data ? <div className="stats-grid">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={120} />)}</div> : <div className={`analytics-body ${loading ? 'is-loading' : ''}`}>
      <div className="stats-grid">
        <div className="stat reveal"><span>{t('Tasks completed', 'مهام منجزة')}</span><strong>{data.totals.completed}</strong><Change value={data.comparison.completed.change} smallBase={data.comparison.completed.previous < 3 ? String(data.comparison.completed.previous) : undefined} /></div>
        <div className="stat reveal"><span>{t('Focus time', 'وقت التركيز')}</span><strong>{(data.totals.focus_minutes / 60).toFixed(1)}{t('h', 'س')}</strong><Change value={data.comparison.focus_minutes.change} smallBase={data.comparison.focus_minutes.previous < 180 ? `${(data.comparison.focus_minutes.previous / 60).toFixed(1)}${t('h', 'س')}` : undefined} /></div>
        <div className="stat reveal"><span>{t('On-time completion', 'الإنجاز في الوقت')}</span><strong>{data.totals.on_time_rate === null ? '—' : `${data.totals.on_time_rate}%`}</strong><small className="muted">{t('Of tasks with deadlines', 'من المهام ذات المواعيد')}</small></div>
        <div className="stat reveal"><span>{t('Estimate accuracy', 'دقة التقدير')}</span><strong>{data.totals.estimate_ratio === null ? '—' : `${data.totals.estimate_ratio}×`}</strong><small className="muted">{data.totals.estimate_ratio === null ? t('Track focus on tasks to measure', 'سجّل التركيز على المهام للقياس') : t(`${data.totals.actual_minutes} actual vs ${data.totals.estimated_minutes} estimated min`, `${data.totals.actual_minutes} فعلية مقابل ${data.totals.estimated_minutes} مقدرة`)}</small></div>
      </div>
      <div className="suggestions">{data.insights.map((s, i) => <SuggestionCard key={i} suggestion={s} index={i} />)}</div>
      {!hasActivity ? <Empty>{t('No activity in this period yet. Complete tasks and focus sessions to see your patterns.', 'لا يوجد نشاط في هذه الفترة بعد. أنجز مهاماً وجلسات تركيز لترى أنماطك.')}</Empty> : <div className="chart-grid">
        <ChartPanel wide title={t('Tasks over time', 'المهام عبر الزمن')} subtitle={t('Completed versus newly added tasks each day.', 'المهام المنجزة مقابل المضافة يومياً.')}>
          <div className="chart" role="img" aria-label={t('Tasks completed and created per day', 'المهام المنجزة والمضافة يومياً')}>
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={series} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <defs><linearGradient id="fill-completed" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.28} /><stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid vertical={false} stroke="var(--color-border)" />
                <XAxis dataKey="label" {...axis} minTickGap={16} reversed={language === 'ar'} />
                <YAxis allowDecimals={false} {...axis} orientation={language === 'ar' ? 'right' : 'left'} />
                <Tooltip {...tooltipStyle} cursor={{ stroke: 'var(--color-text-muted)', strokeDasharray: '3 3' }} />
                <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                <Area animationDuration={500} type="monotone" dataKey="completed" name={t('Completed', 'منجزة')} stroke="var(--chart-1)" strokeWidth={2} fill="url(#fill-completed)" activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--color-surface)' }} />
                <Area animationDuration={500} type="monotone" dataKey="created" name={t('Added', 'مضافة')} stroke="var(--chart-2)" strokeWidth={2} strokeDasharray="5 4" fill="none" activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--color-surface)' }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </ChartPanel>
        <ChartPanel title={t('Daily focus minutes', 'دقائق التركيز اليومية')}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={series} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="label" {...axis} minTickGap={12} reversed={language === 'ar'} />
              <YAxis allowDecimals={false} {...axis} orientation={language === 'ar' ? 'right' : 'left'} />
              <Tooltip {...tooltipStyle} />
              <Bar dataKey="focus_minutes" name={t('Focus minutes', 'دقائق التركيز')} fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={28} />
            </BarChart>
          </ResponsiveContainer>
        </ChartPanel>
        <ChartPanel title={t('When you focus', 'متى تركز')} subtitle={t('Focus minutes by hour of day.', 'دقائق التركيز حسب ساعة اليوم.')}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data.focus_by_hour.map(h => ({ ...h, label: `${String(h.hour).padStart(2, '0')}:00` }))} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="label" {...axis} interval={3} reversed={language === 'ar'} />
              <YAxis allowDecimals={false} {...axis} orientation={language === 'ar' ? 'right' : 'left'} />
              <Tooltip {...tooltipStyle} />
              <Bar dataKey="minutes" name={t('Focus minutes', 'دقائق التركيز')} fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartPanel>
        <ChartPanel title={t('Tasks by priority', 'المهام حسب الأولوية')} subtitle={t('Open now versus completed this period.', 'المفتوحة الآن مقابل المنجزة في هذه الفترة.')}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data.by_priority.map(p => ({ ...p, label: label(p.priority) }))} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barGap={2}>
              <CartesianGrid vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="label" {...axis} reversed={language === 'ar'} />
              <YAxis allowDecimals={false} {...axis} orientation={language === 'ar' ? 'right' : 'left'} />
              <Tooltip {...tooltipStyle} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="open" name={t('Open', 'مفتوحة')} fill="var(--chart-2)" radius={[4, 4, 0, 0]} maxBarSize={26} />
              <Bar dataKey="completed" name={t('Completed', 'منجزة')} fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={26} />
            </BarChart>
          </ResponsiveContainer>
        </ChartPanel>
        <ChartPanel title={t('Where your time went', 'أين ذهب وقتك')} subtitle={t('Focus minutes and completed tasks by project.', 'دقائق التركيز والمهام المنجزة حسب المشروع.')}>
          {!data.by_project.length ? <Empty>{t('No project activity yet.', 'لا يوجد نشاط للمشاريع بعد.')}</Empty> : <ul className="bar-list">{(() => { const max = Math.max(1, ...data.by_project.map(p => p.focus_minutes)); return data.by_project.map(p => <li key={p.project_id ?? 0}><div className="row"><span><i className="swatch" style={{ background: p.color || 'var(--color-text-muted)' }} />{p.title || t('No project', 'بلا مشروع')}</span><span className="muted">{p.focus_minutes} {t('min', 'د')} · {p.completed} {t('done', 'منجزة')}</span></div><div className="meter"><div style={{ width: `${p.focus_minutes / max * 100}%` }} /></div></li>) })()}</ul>}
        </ChartPanel>
        <ChartPanel title={t('Focus by weekday', 'التركيز حسب اليوم')}>
          <ul className="bar-list">{(() => { const max = Math.max(1, ...data.focus_by_weekday.map(d => d.minutes)); return data.focus_by_weekday.map(d => <li key={d.weekday}><div className="row"><span>{weekdays[d.weekday]}</span><span className="muted">{d.minutes} {t('min', 'د')}</span></div><div className="meter"><div style={{ width: `${d.minutes / max * 100}%` }} /></div></li>) })()}</ul>
        </ChartPanel>
      </div>}
      <section className="panel reveal">
        <header><h2>{t('Habit consistency', 'انتظام العادات')}</h2></header>
        {!data.habits.length ? <Empty>{t('Add habits to track your consistency.', 'أضف عادات لتتابع انتظامك.')}</Empty> : <ul className="bar-list">{data.habits.map(h => <li key={h.id}><div className="row"><span><i className="swatch" style={{ background: h.color }} />{h.title}</span><span className="muted"><Flame size={13} /> {h.current_streak} · {t('best', 'الأفضل')} {h.longest_streak} · {h.completions}/{h.expected}</span></div><div className="meter"><div style={{ width: `${h.consistency}%` }} /></div></li>)}</ul>}
      </section>
      <details className="panel data-table">
        <summary>{t('View daily data as a table', 'عرض البيانات اليومية كجدول')}</summary>
        <div className="table-scroll"><table><thead><tr><th>{t('Date', 'التاريخ')}</th><th>{t('Completed', 'منجزة')}</th><th>{t('Added', 'مضافة')}</th><th>{t('Focus minutes', 'دقائق التركيز')}</th></tr></thead><tbody>{data.series.map(d => <tr key={d.date}><td>{d.date}</td><td>{d.completed}</td><td>{d.created}</td><td>{d.focus_minutes}</td></tr>)}</tbody></table></div>
      </details>
    </div>}
  </section>
}
