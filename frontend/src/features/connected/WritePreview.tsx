import { useEffect, useState } from 'react'
import { ArrowRight, CalendarPlus, CalendarX2, RefreshCw, ShieldCheck } from 'lucide-react'
import { api } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { ErrorMessage, Skeleton } from '../../components/ui/Shared'
import type { WriteOp, WritePreview as Preview } from '../../lib/calendarWrite'

/**
 * Shows exactly what one change to a connected calendar will do, and makes it only when the user confirms. The server
 * refuses the confirmation if anything changed since this preview.
 */
export function WritePreview({ op, accountId, eventId, linkId, onDone, onCancel }: { op: WriteOp; accountId: number; eventId?: number | null; linkId?: number | null; onDone: () => void; onCancel: () => void }) {
  const t = useText(), { language } = useLanguage(), toast = useToast()
  const [preview, setPreview] = useState<Preview | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const when = (iso: string) => new Date(iso).toLocaleString(language, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const span = (s: { starts_at: string; ends_at: string }) => `${when(s.starts_at)} – ${new Date(s.ends_at).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })}`

  useEffect(() => {
    let live = true
    api<Preview>('/api/calendar-write/preview', 'POST', { op, account_id: accountId, event_id: eventId ?? null, link_id: linkId ?? null })
      .then(p => { if (live) setPreview(p) }).catch(e => { if (live) setError((e as Error).message) })
    return () => { live = false }
  }, [op, accountId, eventId, linkId])

  async function confirm() {
    if (!preview) return
    setBusy(true); setError('')
    try {
      await api('/api/calendar-write/confirm', 'POST', { token: preview.token })
      const where = `${preview.account.label}${preview.calendar.name ? ` · ${preview.calendar.name}` : ''}`
      toast({ create: t(`Added to ${where}.`, `أُضيف إلى ${where}.`), update: t(`Updated in ${where}.`, `حُدّث في ${where}.`), delete: t(`Removed from ${where}.`, `أُزيل من ${where}.`) }[op])
      onDone()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const verb = { create: t('Add event', 'إضافة الموعد'), update: t('Update copy', 'تحديث النسخة'), delete: t('Remove copy', 'إزالة النسخة') }[op]
  const Icon = { create: CalendarPlus, update: RefreshCw, delete: CalendarX2 }[op]
  return <div className={`write-preview op-${op}`} role="group" aria-label={t('Change preview', 'معاينة التغيير')}>
    {!preview && !error && <Skeleton lines={3} />}
    {preview && <>
      <p className="write-where"><ShieldCheck size={15} />{t(`This changes ${preview.account.label} (${preview.account.email ?? ''}) — calendar “${preview.calendar.name ?? ''}”.`, `سيُغيّر هذا ${preview.account.label} (${preview.account.email ?? ''}) — تقويم «${preview.calendar.name ?? ''}».`)}</p>
      <div className="write-diff">
        {preview.before && <div className="was"><small>{op === 'delete' ? t('Will be removed', 'سيُزال') : t('Now there', 'الآن هناك')}</small><strong>{preview.before.title}</strong><span dir="ltr">{span(preview.before)}</span></div>}
        {preview.before && preview.after && <ArrowRight size={16} className="flip-rtl" aria-hidden="true" />}
        {preview.after && <div className="will"><small>{op === 'create' ? t('Will be added', 'سيُضاف') : t('Will become', 'سيصبح')}</small><strong>{preview.after.title}</strong><span dir="ltr">{span(preview.after)}</span></div>}
      </div>
      <p className="muted small">{t('Only this one change is made, and only if nothing changed since this preview. LifeOS never changes events it did not add.', 'يُنفَّذ هذا التغيير وحده، وفقط إن لم يتغير شيء منذ هذه المعاينة. لا يغيّر LifeOS أبداً مواعيد لم يُضفها.')}</p>
    </>}
    <ErrorMessage error={error} />
    <div className="toolbar">
      <button className="quiet" onClick={onCancel}>{t('Cancel', 'إلغاء')}</button>
      <button className={op === 'delete' ? 'danger' : 'primary'} disabled={!preview || busy} onClick={() => void confirm()}><Icon size={15} />{busy ? t('Working…', 'جارٍ التنفيذ…') : t(`Confirm: ${verb}`, `تأكيد: ${verb}`)}</button>
    </div>
  </div>
}
