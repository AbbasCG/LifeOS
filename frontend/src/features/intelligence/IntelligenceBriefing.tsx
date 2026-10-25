import { useState } from 'react'
import { Link } from 'react-router'
import { AnimatePresence } from 'motion/react'
import { BrainCircuit, CalendarClock, Gauge, Hourglass, Settings2, Play } from 'lucide-react'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { Skeleton, ErrorMessage } from '../../components/ui/Shared'
import { isValidZone } from '../../lib/dial'
import type { MorningBriefing, Recommendation } from '../../lib/intelligence'
import { RecommendationCard } from './RecommendationCard'
import { confidenceLabel, reasonLabel, sourceLabel } from './labels'

type Tab = 'priorities' | 'day' | 'focus' | 'watch'

/** Morning intelligence on Today: deterministic, explained, and limited to the data sources the user allows. */
export function IntelligenceBriefing() {
  const t = useText(), { language } = useLanguage(), ar = language === 'ar'
  const { data, error } = useApi<MorningBriefing>('/api/intelligence/briefing')
  const [tab, setTab] = useState<Tab>('priorities'), [gone, setGone] = useState<number[]>([])
  if (error) return <section className="panel"><ErrorMessage error={error} /></section>
  if (!data) return <section className="panel intel-briefing"><Skeleton lines={4} /></section>
  if (!data.enabled) return null
  const zone = isValidZone(data.timezone) ? data.timezone : undefined
  const time = (iso: string) => new Date(iso).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', timeZone: zone })
  const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(language, { weekday: 'long' })
  const suggestions = data.suggestions.filter((r: Recommendation) => !gone.includes(r.id))
  const watchCount = data.overloaded.length + data.unfinished.length + data.improvements.length
  const tabs: [Tab, string, number][] = [['priorities', t('Priorities', 'الأولويات'), data.priorities.length], ['day', t('Today', 'اليوم'), data.meetings.length + data.deadlines.length], ['focus', t('Focus', 'التركيز'), data.focus.windows.length], ['watch', t('Watch-outs', 'تنبيهات'), watchCount]]

  return <section className="panel reveal intel-briefing" aria-labelledby="intel-title">
    <header className="row">
      <div><h2 id="intel-title"><BrainCircuit size={19} />{t('Morning intelligence', 'ذكاء الصباح')}</h2>
        <p className="muted small">{t('Computed from your own data on this server. Sources:', 'محسوب من بياناتك على هذا الخادم. المصادر:')} {data.sources.map(s => sourceLabel(s, t)).join(ar ? '، ' : ', ')}</p></div>
      <Link className="icon-button" to="/settings/ai" aria-label={t('AI settings', 'إعدادات الذكاء الاصطناعي')} title={t('AI settings', 'إعدادات الذكاء الاصطناعي')}><Settings2 size={17} /></Link>
    </header>
    <div className="segmented intel-tabs" role="tablist" aria-label={t('Briefing sections', 'أقسام الإحاطة')}>
      {tabs.map(([key, label, count]) => <button key={key} role="tab" id={`intel-tab-${key}`} aria-selected={tab === key} aria-controls="intel-panel" className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}{count > 0 && <small>{count}</small>}</button>)}
    </div>
    <div id="intel-panel" role="tabpanel" aria-labelledby={`intel-tab-${tab}`} className="intel-panel">
      {tab === 'priorities' && (data.priorities.length ? <ol className="intel-list">{data.priorities.map((p, i) => <li key={p.id} className={`risk-${p.risk}`}>
        <span className="rank">{i + 1}</span>
        <div className="grow"><strong>{p.title}</strong>
          <div className="metadata">{p.reasons.map(r => <span key={r} className={`chip reason-${r}`}>{reasonLabel(r, t)}</span>)}<span className={`chip conf-${p.confidence}`}>{confidenceLabel(p.confidence, t)}</span></div>
          <div className="score" aria-label={t(`Priority score ${p.score} of 100`, `درجة الأولوية ${p.score} من 100`)}><div style={{ width: `${p.score}%` }} /></div></div>
        <Link to={`/focus?task=${p.id}`} className="icon-button" aria-label={t('Focus on this task', 'ركّز على هذه المهمة')}><Play size={15} /></Link>
      </li>)}</ol> : <p className="muted">{t('No open tasks. A clear runway.', 'لا مهام مفتوحة. طريق ممهد.')}</p>)}
      {tab === 'day' && <div className="intel-cols">
        <div><h3><CalendarClock size={15} />{t('Meetings', 'الاجتماعات')}</h3>{data.meetings.length ? <ul className="intel-plain">{data.meetings.map((e, i) => <li key={i}><span dir="ltr" className="muted">{time(e.starts_at)}–{time(e.ends_at)}</span> {e.title} {e.source !== 'lifeos' && <span className="chip">{sourceLabel(e.source, t)}</span>}</li>)}</ul> : <p className="muted small">{t('No meetings left today.', 'لا اجتماعات متبقية اليوم.')}</p>}</div>
        <div><h3><Hourglass size={15} />{t('Deadlines (48 h)', 'المواعيد (٤٨ ساعة)')}</h3>{data.deadlines.length ? <ul className="intel-plain">{data.deadlines.map(d => <li key={d.id} className={`risk-${d.risk}`}>{d.title} <span className="muted" dir="ltr">{d.due_at && new Date(d.due_at).toLocaleString(language, { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: zone })}</span>{d.reasons.includes('deadline_risk') && <span className="chip warn">{reasonLabel('deadline_risk', t)}</span>}</li>)}</ul> : <p className="muted small">{t('Nothing due in the next two days.', 'لا شيء مستحق خلال يومين.')}</p>}</div>
      </div>}
      {tab === 'focus' && <div className="intel-focus">
        <p className="capacity"><strong>{data.focus.capacity.minutes}</strong> {t('minutes of focus realistically fit today', 'دقيقة تركيز تتسع واقعياً اليوم')}
          <span className={`chip conf-${data.focus.capacity.confidence}`}>{confidenceLabel(data.focus.capacity.confidence, t)}</span></p>
        <p className="muted small">{data.focus.capacity.typical_daily_minutes !== null
          ? t(`Based on ${data.focus.capacity.basis.sessions} focus session(s) over the last ${data.focus.capacity.basis.window_days} days (typically ${data.focus.capacity.typical_daily_minutes} min a day) and ${data.focus.capacity.free_minutes} free minutes left.`, `استناداً إلى ${data.focus.capacity.basis.sessions} جلسة تركيز في آخر ${data.focus.capacity.basis.window_days} يوماً (عادةً ${data.focus.capacity.typical_daily_minutes} دقيقة يومياً) و${data.focus.capacity.free_minutes} دقيقة متاحة.`)
          : t('Not enough focus history yet — this is simply your free time left today.', 'لا يوجد سجل تركيز كافٍ بعد — هذا ببساطة وقتك المتاح المتبقي اليوم.')}</p>
        {data.focus.windows.length ? <ul className="intel-windows">{data.focus.windows.map(w => <li key={w.starts_at}><span dir="ltr">{time(w.starts_at)}–{time(w.ends_at)}</span><span className="muted">{w.minutes} {t('min', 'د')}</span><i style={{ width: `${Math.min(100, w.minutes / 2.4)}%` }} aria-hidden="true" /></li>)}</ul>
          : <p className="muted small">{t('No free windows left inside your working hours.', 'لا فترات متاحة متبقية ضمن ساعات عملك.')}</p>}
      </div>}
      {tab === 'watch' && (watchCount ? <ul className="intel-plain watch">
        {data.overloaded.map(d => <li key={d.date}><Gauge size={14} />{t(`${day(d.date)} is ${d.load_percent}% booked.`, `${day(d.date)} محجوز بنسبة ${d.load_percent}٪.`)}</li>)}
        {data.unfinished.map(u => <li key={u.id}><Hourglass size={14} />{u.postponed ? t(`“${u.title}” postponed ${u.postponed_count} times.`, `«${u.title}» أُجّلت ${u.postponed_count} مرات.`) : t(`“${u.title}” in progress, untouched for ${u.idle_days} days.`, `«${u.title}» قيد التنفيذ دون تغيير منذ ${u.idle_days} أيام.`)}</li>)}
        {data.improvements.map(i => <li key={i.key} className="improve">{i[ar ? 'ar' : 'en']}</li>)}
      </ul> : <p className="muted">{t('Nothing to watch out for. Enjoy the day.', 'لا شيء يستدعي الانتباه. استمتع بيومك.')}</p>)}
    </div>
    {suggestions.length > 0 && <div className="intel-suggestions">
      <h3>{t('Suggestions', 'اقتراحات')}</h3>
      <ul className="rec-list"><AnimatePresence initial={false}>{suggestions.map(r => <RecommendationCard key={r.id} rec={r} onChange={(id, isGone) => isGone && setGone(g => [...g, id])} />)}</AnimatePresence></ul>
    </div>}
  </section>
}
