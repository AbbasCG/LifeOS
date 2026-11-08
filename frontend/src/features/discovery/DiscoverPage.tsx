import { useMemo, useState, type ComponentType } from 'react'
import { Link, useNavigate } from 'react-router'
import { Calendar, CalendarClock, ChartColumn, Check, Compass, ListTodo, Plug, Search, Settings, Sparkles, Sun, Timer } from 'lucide-react'
import { PageHead } from '../../components/visual'
import { Dialog, EmptyState, ErrorMessage, Skeleton } from '../../components/ui/Shared'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { featuresPath, matchesStatus, recommend, startTour, tryFeature, type CatalogueFeature, type StatusFilter } from '../../lib/discovery'
import { HintsSetting } from './HintsSetting'

const ORDER = ['today', 'tasks', 'calendar', 'focus', 'planning', 'assistant', 'insights', 'integrations', 'settings', 'general']
const ICONS: Record<string, ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' }>> = {
  today: Sun, tasks: ListTodo, calendar: Calendar, focus: Timer, planning: CalendarClock, assistant: Sparkles, insights: ChartColumn, integrations: Plug, settings: Settings, general: Compass,
}

/**
 * The Discovery Center: every feature a person can discover, in one place and in their language. They can search, filter by area and by
 * whether they have tried it, read about a feature, try it, and watch its guided tour (again, whenever they like). Suggestions are
 * simple and say why: new and untried first, then untried features in an area they already use. Nothing here is shown unasked: it is a page
 * the person opens, so it never competes with announcements or tips, and no tour or tip starts from it by itself.
 */
export default function DiscoverPage() {
  const t = useText(), toast = useToast(), navigate = useNavigate()
  const { data, error, loading } = useApi<{ data: CatalogueFeature[] }>(featuresPath())
  const [query, setQuery] = useState(''), [status, setStatus] = useState<StatusFilter>('all'), [category, setCategory] = useState('all')
  const [busy, setBusy] = useState<string | null>(null), [open, setOpen] = useState<CatalogueFeature | null>(null)

  const labels: Record<string, string> = {
    today: t('Today', 'اليوم', 'Vandaag'), tasks: t('Tasks', 'المهام', 'Taken'), calendar: t('Calendar', 'التقويم', 'Agenda'), focus: t('Focus', 'التركيز', 'Focus'),
    planning: t('Planning', 'التخطيط', 'Plannen'), assistant: t('Assistant', 'المساعد', 'Assistent'), insights: t('Insights', 'الرؤى', 'Inzichten'),
    integrations: t('Integrations', 'التكاملات', 'Koppelingen'), settings: t('Settings', 'الإعدادات', 'Instellingen'), general: t('General', 'عام', 'Algemeen'),
  }
  const reasons: Record<string, string> = {
    setup_needed: t('Needs setup first.', 'تحتاج إلى إعداد أولًا.', 'Eerst instellen.'),
    platform: t('Not available on this device.', 'غير متاحة على هذا الجهاز.', 'Niet beschikbaar op dit apparaat.'),
    update_required: t('Reload LifeOS to use this.', 'أعد تحميل LifeOS لاستخدامها.', 'Laad LifeOS opnieuw om dit te gebruiken.'),
  }
  const statuses: { id: StatusFilter; label: string }[] = [
    { id: 'all', label: t('All', 'الكل', 'Alles') }, { id: 'new', label: t('New', 'جديد', 'Nieuw') },
    { id: 'untried', label: t('Not tried yet', 'لم تُجرَّب بعد', 'Nog niet geprobeerd') }, { id: 'tried', label: t('Tried', 'جرّبتها', 'Geprobeerd') },
  ]
  const label = (c: string) => labels[c] ?? c

  const all = useMemo(() => data?.data ?? [], [data])
  const categories = useMemo(() => [...new Set(all.map(f => f.category))].sort((a, b) => (ORDER.indexOf(a) + 100) % 100 - (ORDER.indexOf(b) + 100) % 100), [all])
  const recommended = useMemo(() => recommend(all), [all])
  const filtering = query.trim() !== '' || status !== 'all' || category !== 'all'

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const shown = all.filter(f => (!needle || `${f.name} ${f.description}`.toLowerCase().includes(needle)) && matchesStatus(f, status) && (category === 'all' || f.category === category))
    const byCategory = new Map<string, CatalogueFeature[]>()
    for (const f of shown) byCategory.set(f.category, [...(byCategory.get(f.category) ?? []), f])
    return { count: shown.length, list: [...byCategory.entries()].sort(([a], [b]) => (ORDER.indexOf(a) + 100) % 100 - (ORDER.indexOf(b) + 100) % 100) }
  }, [all, query, status, category])

  async function tryIt(feature: CatalogueFeature) {
    setBusy(feature.id)
    try {
      const answer = await tryFeature(feature.id)
      if (answer.available && answer.route) { setOpen(null); navigate(answer.route); if (answer.tour) startTour(answer.tour) }
      else toast(t('This is not available for your account right now.', 'هذه الميزة غير متاحة لحسابك الآن.', 'Dit is nu niet beschikbaar voor je account.'), 'info')
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(null) }
  }
  /** Watching a tour again is not a new "try": it only goes to the feature's screen and starts the tour there. */
  function replay(feature: CatalogueFeature) {
    if (!feature.tour) return
    setOpen(null)
    navigate(feature.route)
    startTour(feature.tour)
  }

  const badges = (f: CatalogueFeature) => <>
    {f.is_new && <span className="rel-new">{t('New', 'جديد', 'Nieuw')}</span>}
    {f.tried && <span className="disc-tried"><Check size={12} aria-hidden="true" />{t('Tried', 'جرّبتها', 'Geprobeerd')}</span>}
  </>
  const actions = (f: CatalogueFeature) => f.can_try
    ? <div className="rel-actions">
      <button type="button" className="primary" disabled={busy === f.id} onClick={() => void tryIt(f)}>{t('Try now', 'جرّبها الآن', 'Probeer nu')}</button>
      {f.tour && <button type="button" className="quiet" onClick={() => replay(f)}>{f.tour_done ? t('Watch the tour again', 'شاهد الجولة مرة أخرى', 'Bekijk de rondleiding opnieuw') : t('Take the tour', 'ابدأ الجولة', 'Volg de rondleiding')}</button>}
    </div>
    : <p className="muted small" role="note">{reasons[f.unavailable_reason ?? ''] ?? t('Not available right now.', 'غير متاحة الآن.', 'Nu niet beschikbaar.')}</p>

  const total = all.length
  return <section className="page discover-page">
    <PageHead title={t('Discover', 'اكتشف', 'Ontdekken')} icon={Compass} />
    <ErrorMessage error={error} />
    {loading ? <Skeleton lines={4} /> : total === 0
      ? <EmptyState title={t('Nothing to discover yet', 'لا شيء لاكتشافه بعد', 'Nog niets te ontdekken')}>{t('New features will be listed here, with a quick tour for each.', 'ستُعرض هنا الميزات الجديدة، مع جولة سريعة لكل منها.', 'Nieuwe functies staan hier, met voor elk een korte rondleiding.')}</EmptyState>
      : <>
        {!filtering && recommended.length > 0 && <section className="disc-recs" aria-labelledby="disc-recs-title">
          <h2 id="disc-recs-title">{t('Recommended for you', 'مقترحة لك', 'Aanbevolen voor jou')}</h2>
          <ul className="disc-rec-list">
            {recommended.map(r => <li key={r.feature.id}>
              <button type="button" className="disc-rec" onClick={() => setOpen(r.feature)}>
                <strong>{r.feature.name}</strong>
                <span className="muted small">{r.reason === 'new'
                  ? t('New, and you have not tried it yet', 'جديدة ولم تجرّبها بعد', 'Nieuw en nog niet geprobeerd')
                  : t(`Because you already use ${label(r.category ?? '')}`, `لأنك تستخدم ${label(r.category ?? '')}`, `Omdat je ${label(r.category ?? '')} al gebruikt`)}</span>
              </button>
            </li>)}
          </ul>
        </section>}

        <div className="disc-tools">
          <label className="discover-search"><Search size={16} aria-hidden="true" /><span className="sr-only">{t('Search features', 'ابحث في الميزات', 'Zoek functies')}</span>
            <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('Search features', 'ابحث في الميزات', 'Zoek functies')} /></label>
          <div className="disc-chips" role="group" aria-label={t('Show', 'عرض', 'Toon')}>
            {statuses.map(s => <button key={s.id} type="button" className="disc-chip" aria-pressed={status === s.id} onClick={() => setStatus(s.id)}>{s.label}</button>)}
          </div>
          {categories.length > 1 && <label className="disc-category"><span className="small">{t('Area', 'القسم', 'Onderdeel')}</span>
            <select value={category} onChange={e => setCategory(e.target.value)}>
              <option value="all">{t('All areas', 'كل الأقسام', 'Alle onderdelen')}</option>
              {categories.map(c => <option key={c} value={c}>{label(c)}</option>)}
            </select></label>}
        </div>
        {groups.count > 0 && <p className="muted small" role="status">{t(`Features shown: ${groups.count}`, `الميزات المعروضة: ${groups.count}`, `Getoonde functies: ${groups.count}`)}</p>}

        {groups.count === 0 && <p className="muted" role="status">{t('No feature matches your search.', 'لا توجد ميزة تطابق بحثك.', 'Geen functie past bij je zoekopdracht.')}</p>}
        {groups.list.map(([cat, features]) => <div key={cat} className="discover-group">
          <h2>{label(cat)}</h2>
          <ul className="discover-grid">
            {features.map(f => {
              const Icon = ICONS[f.category] ?? Compass
              return <li key={f.id} className="panel discover-card">
                <h3><Icon size={18} aria-hidden="true" />{f.name}{badges(f)}</h3>
                <p>{f.description}</p>
                {f.image && <img className="rel-media" src={f.image.src} alt={f.image.alt} loading="lazy" decoding="async" />}
                {actions(f)}
                <button type="button" className="quiet disc-more" aria-haspopup="dialog" onClick={() => setOpen(f)}>{t('Details', 'التفاصيل', 'Details')}</button>
              </li>
            })}
          </ul>
        </div>)}
        <div className="discover-foot">
          <HintsSetting />
          <p><Link to="/updates">{t('See all updates', 'شاهد كل التحديثات', 'Bekijk alle updates')}</Link></p>
        </div>
      </>}
    {open && <Dialog title={open.name} onClose={() => setOpen(null)}>
      <div className="disc-detail">
        <p className="disc-meta"><span>{label(open.category)}</span>{badges(open)}</p>
        <p>{open.description}</p>
        {open.image && <img className="rel-media" src={open.image.src} alt={open.image.alt} loading="lazy" decoding="async" />}
        {actions(open)}
      </div>
    </Dialog>}
  </section>
}
