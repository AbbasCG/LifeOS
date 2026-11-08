import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Gift, ThumbsDown, ThumbsUp } from 'lucide-react'
import { PageHead } from '../../components/visual'
import { EmptyState, ErrorMessage, Skeleton } from '../../components/ui/Shared'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { formatDay } from '../../lib/dateTime'
import { recordState, releasesPath, startTour, tryFeature, type DiscoveryItem, type HistoryRelease } from '../../lib/discovery'
import { ReleaseBody } from './ReleaseBody'

/** The update history: every published release for this screen, newest first. Reading it counts as seeing the announcements in it. */
export default function UpdatesPage() {
  const t = useText(), { language } = useLanguage(), toast = useToast(), navigate = useNavigate(), [params] = useSearchParams()
  const { data, error, loading } = useApi<{ data: HistoryRelease[] }>(releasesPath())
  const [rated, setRated] = useState<Record<string, boolean>>({}), [busy, setBusy] = useState<string | null>(null)
  const focus = params.get('release'), marked = useRef(false)

  useEffect(() => {
    if (!data || marked.current) return
    marked.current = true
    for (const release of data.data) if (!release.seen) void recordState('release', release.key, 'seen').catch(() => {})
  }, [data])
  useEffect(() => { if (data && focus) document.getElementById(`release-${focus}`)?.scrollIntoView({ block: 'start' }) }, [data, focus])

  async function rate(key: string, helpful: boolean) {
    setRated(r => ({ ...r, [key]: helpful }))
    try { await recordState('release', key, helpful ? 'helpful' : 'unhelpful') } catch (e) { toast((e as Error).message, 'error') }
  }
  async function tryIt(item: DiscoveryItem) {
    if (!item.feature) return
    setBusy(item.feature)
    try {
      const answer = await tryFeature(item.feature)
      if (answer.available && answer.route) { navigate(answer.route); if (answer.tour) startTour(answer.tour) }
      else toast(t('This is not available for your account right now.', 'هذه الميزة غير متاحة لحسابك الآن.', 'Dit is nu niet beschikbaar voor je account.'), 'info')
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(null) }
  }

  return <section className="page updates-page">
    <PageHead title={t('What’s new', 'ما الجديد', 'Wat is er nieuw')} icon={Gift} />
    <ErrorMessage error={error} />
    {loading ? <Skeleton lines={4} /> : !data?.data.length
      ? <EmptyState title={t('No updates yet', 'لا توجد تحديثات بعد', 'Nog geen updates')}>{t('When LifeOS gets something new, you will find it here.', 'عندما يصل جديد إلى LifeOS ستجده هنا.', 'Zodra LifeOS iets nieuws krijgt, vind je het hier.')}</EmptyState>
      : data.data.map(release => {
        const mine = rated[release.key] ?? release.helpful
        return <article key={release.key} id={`release-${release.key}`} className={`panel rel-card${focus === release.key ? ' is-focus' : ''}`} aria-labelledby={`rel-title-${release.key}`}>
          <header>
            <h2 id={`rel-title-${release.key}`}>{release.title}</h2>
            <p className="muted small">{release.importance === 'important' && <strong>{t('Important update', 'تحديث مهم', 'Belangrijke update')} · </strong>}<time dateTime={release.date}>{formatDay(release.date, language, { day: 'numeric', month: 'long', year: 'numeric' })}</time></p>
          </header>
          <p className="rel-summary">{release.summary}</p>
          <ReleaseBody items={release.items} onTry={tryIt} busy={busy} />
          <footer className="rel-rate" role="group" aria-label={t('Was this update useful?', 'هل كان هذا التحديث مفيدًا؟', 'Was deze update nuttig?')}>
            <span className="muted small">{t('Was this useful?', 'هل كان مفيدًا؟', 'Was dit nuttig?')}</span>
            <button type="button" className="icon-button" aria-pressed={mine === true} aria-label={t('Useful', 'مفيد', 'Nuttig')} onClick={() => void rate(release.key, true)}><ThumbsUp size={17} aria-hidden="true" /></button>
            <button type="button" className="icon-button" aria-pressed={mine === false} aria-label={t('Not useful', 'غير مفيد', 'Niet nuttig')} onClick={() => void rate(release.key, false)}><ThumbsDown size={17} aria-hidden="true" /></button>
          </footer>
        </article>
      })}
  </section>
}
