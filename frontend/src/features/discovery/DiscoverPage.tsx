import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Compass, Search } from 'lucide-react'
import { PageHead } from '../../components/visual'
import { EmptyState, ErrorMessage, Skeleton } from '../../components/ui/Shared'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { featuresPath, startTour, tryFeature, type CatalogueFeature } from '../../lib/discovery'
import { HintsSetting } from './HintsSetting'

const ORDER = ['today', 'tasks', 'calendar', 'focus', 'planning', 'assistant', 'insights', 'integrations', 'settings', 'general']

/**
 * The Discovery Center: every feature a person can discover, in one place and in their language. Each can be tried, its guided tour can be
 * watched again later, and a feature that cannot be used right now says why instead of disappearing. Nothing here is shown unasked: it is a
 * page the person opens, so it never competes with announcements or tips.
 */
export default function DiscoverPage() {
  const t = useText(), toast = useToast(), navigate = useNavigate()
  const { data, error, loading } = useApi<{ data: CatalogueFeature[] }>(featuresPath())
  const [query, setQuery] = useState(''), [busy, setBusy] = useState<string | null>(null)

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

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const shown = (data?.data ?? []).filter(f => !needle || `${f.name} ${f.description}`.toLowerCase().includes(needle))
    const byCategory = new Map<string, CatalogueFeature[]>()
    for (const f of shown) byCategory.set(f.category, [...(byCategory.get(f.category) ?? []), f])
    return [...byCategory.entries()].sort(([a], [b]) => (ORDER.indexOf(a) + 100) % 100 - (ORDER.indexOf(b) + 100) % 100)
  }, [data, query])

  async function tryIt(feature: CatalogueFeature) {
    setBusy(feature.id)
    try {
      const answer = await tryFeature(feature.id)
      if (answer.available && answer.route) { navigate(answer.route); if (answer.tour) startTour(answer.tour) }
      else toast(t('This is not available for your account right now.', 'هذه الميزة غير متاحة لحسابك الآن.', 'Dit is nu niet beschikbaar voor je account.'), 'info')
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(null) }
  }
  /** Watching a tour again is not a new "try": it only goes to the feature's screen and starts the tour there. */
  function replay(feature: CatalogueFeature) {
    if (!feature.tour) return
    navigate(feature.route)
    startTour(feature.tour)
  }

  const total = data?.data.length ?? 0
  return <section className="page discover-page">
    <PageHead title={t('Discover', 'اكتشف', 'Ontdekken')} icon={Compass} />
    <ErrorMessage error={error} />
    {loading ? <Skeleton lines={4} /> : total === 0
      ? <EmptyState title={t('Nothing to discover yet', 'لا شيء لاكتشافه بعد', 'Nog niets te ontdekken')}>{t('New features will be listed here, with a quick tour for each.', 'ستُعرض هنا الميزات الجديدة، مع جولة سريعة لكل منها.', 'Nieuwe functies staan hier, met voor elk een korte rondleiding.')}</EmptyState>
      : <>
        <label className="discover-search"><Search size={16} aria-hidden="true" /><span className="sr-only">{t('Search features', 'ابحث في الميزات', 'Zoek functies')}</span>
          <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('Search features', 'ابحث في الميزات', 'Zoek functies')} /></label>
        {groups.length === 0 && <p className="muted" role="status">{t('No feature matches your search.', 'لا توجد ميزة تطابق بحثك.', 'Geen functie past bij je zoekopdracht.')}</p>}
        {groups.map(([category, features]) => <div key={category} className="discover-group">
          <h2>{labels[category] ?? category}</h2>
          <ul className="discover-grid">
            {features.map(f => <li key={f.id} className="panel discover-card">
              <h3>{f.name}{f.is_new && <span className="rel-new">{t('New', 'جديد', 'Nieuw')}</span>}</h3>
              <p>{f.description}</p>
              {f.image && <img className="rel-media" src={f.image.src} alt={f.image.alt} loading="lazy" decoding="async" />}
              {f.can_try
                ? <div className="rel-actions">
                  <button type="button" className="primary" disabled={busy === f.id} onClick={() => void tryIt(f)}>{t('Try now', 'جرّبها الآن', 'Probeer nu')}</button>
                  {f.tour && <button type="button" className="quiet" onClick={() => replay(f)}>{f.tour_done ? t('Watch the tour again', 'شاهد الجولة مرة أخرى', 'Bekijk de rondleiding opnieuw') : t('Take the tour', 'ابدأ الجولة', 'Volg de rondleiding')}</button>}
                </div>
                : <p className="muted small" role="note">{reasons[f.unavailable_reason ?? ''] ?? t('Not available right now.', 'غير متاحة الآن.', 'Nu niet beschikbaar.')}</p>}
            </li>)}
          </ul>
        </div>)}
        <div className="discover-foot">
          <HintsSetting />
          <p><Link to="/updates">{t('See all updates', 'شاهد كل التحديثات', 'Bekijk alle updates')}</Link></p>
        </div>
      </>}
  </section>
}
