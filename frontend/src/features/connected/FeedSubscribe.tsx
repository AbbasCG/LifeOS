import { useState, type FormEvent } from 'react'
import { Rss } from 'lucide-react'
import { api } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { ErrorMessage } from '../../components/ui/Shared'
import type { ConnectedAccount } from './AccountCard'

/**
 * Subscribe to a read-only .ics / webcal feed. The address is checked on the server by reading it once; it is never
 * shown again because a secret link works like a password.
 */
export function FeedSubscribe({ replacing, onDone }: { replacing?: boolean; onDone: () => void }) {
  const t = useText(), toast = useToast()
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('')
    try {
      const r = await api<{ account: ConnectedAccount }>('/api/integrations/ics', 'POST', { url })
      toast(t(`Subscribed to “${r.account.display_name ?? r.account.email}”. ${r.account.events_count} upcoming event(s) imported.`, `تم الاشتراك في «${r.account.display_name ?? r.account.email}». استُورد ${r.account.events_count} موعداً قادماً.`))
      setUrl(''); onDone()
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return <form className="feed-subscribe" onSubmit={e => void submit(e)}>
    <label htmlFor="feed-url">{replacing ? t('Paste the current calendar link', 'الصق رابط التقويم الحالي') : t('Calendar address (.ics or webcal)', 'عنوان التقويم (.ics أو webcal)')}</label>
    <div className="feed-row">
      <input id="feed-url" type="url" inputMode="url" dir="ltr" required placeholder="webcal://…" autoComplete="off" spellCheck={false} value={url} onChange={e => setUrl(e.target.value)} />
      <button className="primary" disabled={busy || !url.trim()}><Rss size={16} />{busy ? t('Checking…', 'جارٍ التحقق…') : t('Subscribe', 'اشتراك')}</button>
    </div>
    <p className="muted small">{replacing
      ? t('The old link stopped working. Subscribe with the new one, then disconnect the old subscription.', 'توقف الرابط القديم عن العمل. اشترك بالرابط الجديد ثم افصل الاشتراك القديم.')
      : t('School timetables, sports fixtures, public holidays or a “secret address” from another calendar. Treat secret links like passwords — LifeOS stores them encrypted and never shows them again.', 'جداول المدرسة أو المباريات أو العطل الرسمية أو «عنوان سري» من تقويم آخر. عامل الروابط السرية ككلمات مرور — يخزنها LifeOS مشفرة ولا يعرضها مجدداً.')}</p>
    <ErrorMessage error={error} />
  </form>
}
