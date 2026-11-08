import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { BottomSheet } from '../../components/visual'
import { useToast } from '../../lib/toast'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { formatDay } from '../../lib/dateTime'
import { recordState, tryFeature, type DiscoveryItem, type Release } from '../../lib/discovery'
import { ReleaseBody } from './ReleaseBody'

/**
 * The announcement of a new version. It is shown once: opening it records that it was seen, "Got it" or closing it ends it,
 * and "Later" brings it back after a day (at most twice). Nothing in it changes anything by itself.
 */
export default function WhatsNewSheet({ release, onDone }: { release: Release; onDone: () => void }) {
  const t = useText(), { language } = useLanguage(), toast = useToast(), navigate = useNavigate()
  const [busy, setBusy] = useState<string | null>(null), finished = useRef(false)
  useEffect(() => { void recordState('release', release.key, 'seen').catch(() => {}) }, [release.key])

  function finish(action: 'dismissed' | 'snoozed') {
    if (finished.current) return
    finished.current = true
    void recordState('release', release.key, action).catch(() => {})
    onDone()
  }

  async function tryIt(item: DiscoveryItem) {
    if (!item.feature) return
    setBusy(item.feature)
    try {
      const answer = await tryFeature(item.feature)
      if (answer.available && answer.route) { finish('dismissed'); navigate(answer.route) }
      else toast(t('This is not available for your account right now.', 'هذه الميزة غير متاحة لحسابك الآن.', 'Dit is nu niet beschikbaar voor je account.'), 'info')
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(null) }
  }

  const date = formatDay(release.date, language, { day: 'numeric', month: 'long', year: 'numeric' })
  return <BottomSheet tall title={release.title} onClose={() => finish('dismissed')} footer={<div className="rel-foot">
    <button type="button" className="primary" onClick={() => finish('dismissed')}>{t('Got it', 'حسنًا', 'Begrepen')}</button>
    <button type="button" className="quiet" onClick={() => finish('snoozed')}>{t('Later', 'لاحقًا', 'Later')}</button>
    <button type="button" className="quiet" onClick={() => { finish('dismissed'); navigate('/updates') }}>{t('All updates', 'كل التحديثات', 'Alle updates')}</button>
  </div>}>
    <p className="muted small rel-date">{release.importance === 'important' && <strong>{t('Important update', 'تحديث مهم', 'Belangrijke update')} · </strong>}<time dateTime={release.date}>{date}</time></p>
    <p className="rel-summary">{release.summary}</p>
    <ReleaseBody items={release.items} onTry={tryIt} busy={busy} />
  </BottomSheet>
}
