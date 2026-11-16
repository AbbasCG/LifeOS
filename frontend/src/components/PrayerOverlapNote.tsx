import { Clock } from 'lucide-react'
import { useText } from '../lib/i18n'
import { usePrayerOverlap } from '../lib/prayer'
import { usePrayerPrefs } from '../lib/prayerStore'

/**
 * "This overlaps Asr (15:42). You can still save." A quiet note under a booking's time fields. It never blocks anything and never changes
 * what is sent. Nothing is rendered, and nothing is fetched, when the account has not turned prayer times on.
 */
export default function PrayerOverlapNote({ start, end, className }: { start?: string | null; end?: string | null; className?: string }) {
  const { enabled } = usePrayerPrefs()
  return enabled ? <Note start={start} end={end} className={className} /> : null
}
function Note({ start, end, className }: { start?: string | null; end?: string | null; className?: string }) {
  const t = useText(), hit = usePrayerOverlap(start, end)
  return <div aria-live="polite" className={className}>{hit && <p className="sched-notice prayer-note"><Clock size={16} aria-hidden="true" />
    <span>{t('This overlaps ', 'هذا يتداخل مع ', 'Dit overlapt met ')}{hit.name}{hit.time && <> (<bdi dir="ltr">{hit.time}</bdi>)</>}{t('. You can still save.', '. يمكنك الحفظ مع ذلك.', '. Je kunt het toch opslaan.')}</span></p>}</div>
}
