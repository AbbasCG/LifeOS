import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { m, AnimatePresence } from 'motion/react'
import { CalendarDays, CheckSquare, ListChecks, Timer, Flag, Repeat, ChevronLeft, ChevronRight, SlidersHorizontal, Lock, AlertTriangle, ArrowRight, Globe, CopyPlus, ExternalLink, Info, X, Check, CalendarRange } from 'lucide-react'
import { api } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { localDate } from '../../lib/hooks'
import { isValidZone } from '../../lib/dial'
import { ErrorMessage, Skeleton } from '../../components/ui/Shared'
import { addDays, type TimelineConflict, type TimelineData, type TimelineItem } from '../../lib/timeline'

const KIND_ICON = { event: CalendarDays, task: CheckSquare, external_task: ListChecks, focus: Timer, goal: Flag, habit: Repeat } as const

function Chip({ active, onClick, children, count }: { active: boolean; onClick: () => void; children: ReactNode; count?: number }) {
  return <button type="button" className={`filter-chip ${active ? 'active' : ''}`} aria-pressed={active} onClick={onClick}>{children}{count !== undefined && <small>{count}</small>}</button>
}

/**
 * Everything in one stream: LifeOS events and tasks, connected calendars and task apps, focus sessions, goal deadlines
 * and habits. Connected records are read-only here; a connected task can be copied into LifeOS.
 */
export default function TimelinePage() {
  const t = useText(), { language } = useLanguage(), toast = useToast(), ar = language === 'ar'
  const [view, setView] = useState<'day' | 'week'>('day'), [anchor, setAnchor] = useState(localDate())
  const [filters, setFilters] = useState<{ sources: string[]; accounts: number[]; areas: string[]; kinds: string[] }>({ sources: [], accounts: [], areas: [], kinds: [] })
  const [showFilters, setShowFilters] = useState(false), [busy, setBusy] = useState<string | null>(null), [failure, setFailure] = useState('')
  const from = view === 'week' ? addDays(anchor, -((new Date(`${anchor}T12:00:00`).getDay() + 6) % 7)) : anchor
  const to = view === 'week' ? addDays(from, 6) : anchor
  const query = new URLSearchParams({ from, to })
  for (const [key, values] of Object.entries(filters)) if (values.length) query.set(key, values.join(','))
  const { data, error, loading, reload } = useApi<TimelineData>(`/api/timeline?${query}`)
  const timeZone = data?.range.timezone && isValidZone(data.range.timezone) ? data.range.timezone : undefined
  const time = (iso: string) => new Date(iso).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', timeZone })
  const dayKey = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
  const dayTitle = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(language, { weekday: 'long', day: 'numeric', month: 'long' })
  const toggle = <K extends keyof typeof filters>(key: K, value: (typeof filters)[K][number]) => setFilters(f => ({ ...f, [key]: (f[key] as (typeof value)[]).includes(value) ? (f[key] as (typeof value)[]).filter(v => v !== value) : [...(f[key] as (typeof value)[]), value] }))
  const activeFilters = Object.values(filters).reduce((n, v) => n + v.length, 0)
  const kindLabel: Record<string, string> = { event: t('Events', 'المواعيد'), task: t('Tasks', 'المهام'), external_task: t('Connected tasks', 'مهام مرتبطة'), focus: t('Focus', 'التركيز'), goal: t('Goals', 'الأهداف'), habit: t('Habits', 'العادات') }
  const areaLabel: Record<string, string> = { work: t('Work', 'العمل'), study: t('Study', 'الدراسة'), personal: t('Personal', 'شخصي'), unassigned: t('Unassigned', 'غير محدد') }

  async function copy(item: TimelineItem) {
    setBusy(item.id); setFailure('')
    try { await api(`/api/connected/tasks/${item.meta.external_id}/copy`, 'POST'); toast(t(`“${item.title}” copied into LifeOS. ${item.source_label} is unchanged.`, `نُسخت «${item.title}» إلى LifeOS. ${item.source_label} لم يتغير.`)); reload() } catch (e) { setFailure((e as Error).message) } finally { setBusy(null) }
  }

  const conflictText = (c: TimelineConflict) => {
    const at = `${new Date(c.at).toLocaleDateString(language, { weekday: 'short', timeZone })} ${time(c.at)}`
    switch (c.type) {
      case 'overlap': return t(`${c.titles[0]} overlaps ${c.titles[1]} (${c.minutes} min) · ${at}`, `«${c.titles[0]}» يتداخل مع «${c.titles[1]}» (${c.minutes} دقيقة) · ${at}`)
      case 'busy_task': return t(`Planned work “${c.titles[0]}” falls during “${c.titles[1]}” · ${at}`, `العمل المخطط «${c.titles[0]}» يقع أثناء «${c.titles[1]}» · ${at}`)
      case 'deadline': return !c.meetings ? t(`“${c.titles[0]}” may not fit before its deadline: needs about ${c.need} min, about ${c.free} min free in your planning hours · ${at}`, `قد لا تتسع «${c.titles[0]}» قبل موعدها: تحتاج نحو ${c.need} دقيقة والمتاح نحو ${c.free} دقيقة في ساعات التخطيط · ${at}`) : t(`“${c.titles[0]}” may not fit before its deadline: needs ~${c.need} min, ~${c.free} free after ${c.meetings} meeting(s) · ${at}`, `قد لا تتسع «${c.titles[0]}» قبل موعدها: تحتاج ~${c.need} دقيقة والمتاح ~${c.free} بعد ${c.meetings} اجتماع · ${at}`)
      case 'duplicate': return t(`“${c.titles[0]}” is in ${c.accounts?.length ?? 2} accounts (${c.accounts?.join(', ')}) — shown once`, `«${c.titles[0]}» موجود في ${c.accounts?.length ?? 2} حسابات (${c.accounts?.join('، ')}) — يُعرض مرة واحدة`)
      case 'timezone': return t(`“${c.titles[0]}” was organised in ${c.organiser_zone} (${c.organiser_time} there, ${c.your_time} for you)`, `«${c.titles[0]}» منظّم بتوقيت ${c.organiser_zone} (${c.organiser_time} هناك، ${c.your_time} بتوقيتك)`)
      case 'moved': return t(`“${c.titles[0]}” was rescheduled from ${c.from ? time(c.from) : ''} to ${c.to ? time(c.to) : ''}`, `أُعيدت جدولة «${c.titles[0]}» من ${c.from ? time(c.from) : ''} إلى ${c.to ? time(c.to) : ''}`)
      default: return t(`“${c.titles[0]}” was cancelled · ${at}`, `أُلغي «${c.titles[0]}» · ${at}`)
    }
  }

  const row = (item: TimelineItem, compact = false) => {
    const Icon = KIND_ICON[item.kind]
    const done = item.status === 'completed'
    return <m.li key={item.id} layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      className={`tl-item kind-${item.kind} src-${item.source} ${item.conflict ? 'has-conflict' : ''} ${done ? 'done' : ''} ${compact ? 'compact' : ''}`}>
      <time dir="ltr">{item.all_day ? t('All day', 'طوال اليوم') : <>{time(item.starts_at)}{item.ends_at && !compact ? `–${time(item.ends_at)}` : ''}</>}</time>
      <span className="tl-bar" aria-hidden="true" />
      <div className="tl-main">
        <div className="tl-title"><Icon size={14} aria-hidden="true" /><strong>{item.title}</strong>{done && <Check size={14} className="ok" aria-label={t('Done', 'منجز')} />}</div>
        {!compact && <div className="tl-meta">
          <span className={`source-badge src-${item.source}`}>{item.source !== 'lifeos' && <Globe size={10} />} {item.source_label}{item.account ? ` · ${item.account}` : ''}</span>
          {item.area && <span className="chip">{areaLabel[item.area]}</span>}
          {item.read_only && <span className="chip"><Lock size={10} />{t('Read-only', 'للقراءة فقط')}</span>}
          {item.moved_from && <span className="chip moved"><ArrowRight size={10} className="flip-rtl" />{t(`moved from ${time(item.moved_from)}`, `نُقل من ${time(item.moved_from)}`)}</span>}
          {item.conflict && <span className="chip conflict"><AlertTriangle size={10} />{t('Conflict', 'تعارض')}</span>}
          {item.meta.minutes !== undefined && <span className="chip">{item.meta.minutes} {t('min', 'د')}</span>}
          {item.meta.percent !== undefined && <span className="chip">{item.meta.percent}%</span>}
        </div>}
      </div>
      {!compact && <div className="tl-actions">
        {item.kind === 'external_task' && !done && <button className="quiet" disabled={busy !== null} onClick={() => void copy(item)}><CopyPlus size={14} />{t('Copy to LifeOS', 'نسخ إلى LifeOS')}</button>}
        {item.link.startsWith('http') ? <a className="icon-button" href={item.link} target="_blank" rel="noreferrer noopener" aria-label={t(`Open in ${item.source_label}`, `فتح في ${item.source_label}`)}><ExternalLink size={15} /></a>
          : <Link className="icon-button" to={item.link} aria-label={t('Open', 'فتح')}><ArrowRight size={15} className="flip-rtl" /></Link>}
      </div>}
    </m.li>
  }

  const days = data ? Array.from({ length: view === 'week' ? 7 : 1 }, (_, i) => addDays(from, i)) : []
  const byDay = (date: string) => (data?.items ?? []).filter(i => dayKey(i.starts_at) === date)
  const high = (data?.conflicts ?? []).filter(c => c.severity === 'high')
  const info = (data?.conflicts ?? []).filter(c => c.severity !== 'high')

  return <section className="page timeline-page">
    <header className="page-heading reveal">
      <div><p className="eyebrow">{t('Timeline', 'الخط الزمني')}</p><h1>{t('Your whole day, in one place', 'يومك كله في مكان واحد')}</h1><p className="muted">{t('LifeOS, your connected calendars and task apps, focus, goals and habits — each with its source.', 'LifeOS وتقويماتك وتطبيقات مهامك المرتبطة والتركيز والأهداف والعادات — كلٌ مع مصدره.')}</p></div>
      <div className="toolbar">
        <div className="segmented" role="radiogroup" aria-label={t('View', 'العرض')}>{(['day', 'week'] as const).map(v => <button key={v} role="radio" aria-checked={view === v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>{v === 'day' ? t('Day', 'يوم') : t('Week', 'أسبوع')}</button>)}</div>
        <div className="date-nav">
          <button className="icon-button" aria-label={t('Previous', 'السابق')} onClick={() => setAnchor(a => addDays(a, view === 'week' ? -7 : -1))}><ChevronLeft size={18} className="flip-rtl" /></button>
          <button className="quiet" onClick={() => setAnchor(localDate())}>{t('Today', 'اليوم')}</button>
          <button className="icon-button" aria-label={t('Next', 'التالي')} onClick={() => setAnchor(a => addDays(a, view === 'week' ? 7 : 1))}><ChevronRight size={18} className="flip-rtl" /></button>
          <input type="date" aria-label={t('Date', 'التاريخ')} value={anchor} onChange={e => e.target.value && setAnchor(e.target.value)} />
        </div>
        <button className={`quiet ${activeFilters ? 'has-filters' : ''}`} aria-expanded={showFilters} onClick={() => setShowFilters(s => !s)}><SlidersHorizontal size={16} />{t('Filters', 'التصفية')}{activeFilters ? ` (${activeFilters})` : ''}</button>
      </div>
    </header>

    <AnimatePresence initial={false}>{showFilters && data && <m.section className="panel timeline-filters" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 32 }} aria-label={t('Filters', 'التصفية')}>
      <div className="filter-group"><span>{t('Source', 'المصدر')}</span>{data.facets.sources.map(s => <Chip key={s.key} active={filters.sources.includes(s.key)} onClick={() => toggle('sources', s.key)} count={s.count}><i className={`dot src-${s.key}`} />{s.label}</Chip>)}</div>
      {data.facets.accounts.length > 0 && <div className="filter-group"><span>{t('Account', 'الحساب')}</span>
        <Chip active={filters.accounts.includes(0)} onClick={() => toggle('accounts', 0)}>LifeOS</Chip>
        {data.facets.accounts.map(a => <Chip key={a.id} active={filters.accounts.includes(a.id)} onClick={() => toggle('accounts', a.id)} count={a.count}><i className={`dot src-${a.provider}`} /><span dir="ltr">{a.label}</span></Chip>)}</div>}
      <div className="filter-group"><span>{t('Life area', 'المجال')}</span>{data.facets.areas.filter(a => a.count > 0 || filters.areas.includes(a.key)).map(a => <Chip key={a.key} active={filters.areas.includes(a.key)} onClick={() => toggle('areas', a.key)} count={a.count}>{areaLabel[a.key]}</Chip>)}</div>
      <div className="filter-group"><span>{t('Type', 'النوع')}</span>{data.facets.kinds.filter(k => k.count > 0 || filters.kinds.includes(k.key)).map(k => <Chip key={k.key} active={filters.kinds.includes(k.key)} onClick={() => toggle('kinds', k.key)} count={k.count}>{kindLabel[k.key]}</Chip>)}</div>
      {activeFilters > 0 && <button className="text-link" onClick={() => setFilters({ sources: [], accounts: [], areas: [], kinds: [] })}><X size={13} />{t('Clear filters', 'مسح التصفية')}</button>}
    </m.section>}</AnimatePresence>

    <ErrorMessage error={error || failure} />
    {(high.length > 0 || info.length > 0) && <section className="panel reveal timeline-conflicts" aria-label={t('Conflicts and changes', 'التعارضات والتغييرات')}>
      {high.length > 0 && <><h2><AlertTriangle size={17} />{t(`${high.length} conflict(s) to look at`, `${high.length} تعارض يحتاج انتباهك`)}</h2><ul>{high.slice(0, 8).map((c, i) => <li key={i} className={`conflict-${c.type}`}>{conflictText(c)}</li>)}</ul></>}
      {info.length > 0 && <details open={high.length === 0}><summary><Info size={14} />{t(`${info.length} change(s) from connected calendars`, `${info.length} تغيير من التقويمات المرتبطة`)}</summary><ul>{info.slice(0, 10).map((c, i) => <li key={i} className={`conflict-${c.type}`}>{conflictText(c)}</li>)}</ul></details>}
      <p className="muted small">{t('LifeOS never changes connected calendars. Ask Copilot to plan around these, or adjust your own events.', 'لا يغيّر LifeOS التقويمات المرتبطة أبداً. اطلب من المساعد التخطيط حولها أو عدّل مواعيدك.')} <Link to={`/assistant?ask=${encodeURIComponent(ar ? 'هل لدي تعارضات؟' : 'Do I have any conflicts?')}`}>{t('Ask Copilot', 'اسأل المساعد')}</Link></p>
    </section>}

    {!data ? <section className="panel"><Skeleton lines={6} /></section> : data.items.length === 0 ? <section className="panel timeline-empty reveal">
      <CalendarRange size={34} aria-hidden="true" />
      <h2>{activeFilters ? t('Nothing matches these filters', 'لا شيء يطابق هذه التصفية') : t('A clear stretch', 'مساحة فارغة')}</h2>
      <p className="muted">{activeFilters ? t('Try removing a filter.', 'جرّب إزالة أحد عوامل التصفية.') : t('Nothing is scheduled here. Plan the day, or connect a calendar to see everything in one place.', 'لا شيء مجدول هنا. خطط يومك، أو اربط تقويماً لترى كل شيء في مكان واحد.')}</p>
      <div className="toolbar center">{activeFilters ? <button className="quiet" onClick={() => setFilters({ sources: [], accounts: [], areas: [], kinds: [] })}>{t('Clear filters', 'مسح التصفية')}</button> : <><Link className="primary" to="/today/plan">{t('Plan my day', 'خطط يومي')}</Link><Link className="quiet" to="/settings/integrations">{t('Connect a calendar', 'اربط تقويماً')}</Link></>}</div>
    </section> : <div className={`timeline-days view-${view} ${loading ? 'is-loading' : ''}`}>
      {days.map(date => { const items = byDay(date); return <section key={date} className={`panel tl-day ${date === localDate() ? 'is-today' : ''}`} aria-label={dayTitle(date)}>
        <header><h2>{dayTitle(date)}</h2><small className="muted">{t(`${items.length} item(s)`, `${items.length} عنصر`)}</small></header>
        {items.length === 0 ? <p className="muted small">{t('Free', 'متاح')}</p> : <ol className="tl-list">{items.map(i => row(i, view === 'week'))}</ol>}
      </section> })}
    </div>}
  </section>
}
