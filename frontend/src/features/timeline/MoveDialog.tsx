import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Lock } from 'lucide-react'
import { api } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { Dialog, ErrorMessage } from '../../components/ui/Shared'
import { zonedParts, zonedToUtc, type MovePreview, type TimelineItem } from '../../lib/timeline'

/**
 * Move one LifeOS event — or one occurrence of a series — with a live preview of what the new time would collide with,
 * including read-only commitments from connected calendars. Saving re-checks on the server.
 */
export function MoveDialog({ item, timeZone, onClose, onMoved }: { item: TimelineItem; timeZone?: string; onClose: () => void; onMoved: () => void }) {
  const t = useText(), { language } = useLanguage(), toast = useToast()
  const start = zonedParts(item.starts_at, timeZone), end = zonedParts(item.ends_at ?? item.starts_at, timeZone)
  const [date, setDate] = useState(start.date), [from, setFrom] = useState(start.time), [to, setTo] = useState(end.time)
  const [preview, setPreview] = useState<MovePreview | null>(null), [checking, setChecking] = useState(false), [confirmFixed, setConfirmFixed] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const startsAt = zonedToUtc(date, from, timeZone), endsAt = zonedToUtc(date, to, timeZone)
  const valid = Boolean(date && from && to) && endsAt > startsAt
  const changed = startsAt.toISOString() !== new Date(item.starts_at).toISOString() || endsAt.toISOString() !== new Date(item.ends_at ?? item.starts_at).toISOString()
  const clock = (iso: string) => new Date(iso).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', timeZone })
  const key = `${startsAt.toISOString()}|${endsAt.toISOString()}`

  useEffect(() => {
    if (!valid) return
    let live = true
    const timer = window.setTimeout(() => {
      setChecking(true)
      const q = new URLSearchParams({ event_id: String(item.meta.event_id), starts_at: key.split('|')[0], ends_at: key.split('|')[1], ...(item.meta.occurrence_start ? { occurrence_start: item.meta.occurrence_start } : {}) })
      api<MovePreview>(`/api/timeline/preview?${q}`).then(r => { if (live) { setPreview(r); setError('') } }).catch(e => { if (live) setError((e as Error).message) }).finally(() => { if (live) setChecking(false) })
    }, 250)
    return () => { live = false; window.clearTimeout(timer) }
  }, [key, valid, item.meta.event_id, item.meta.occurrence_start])

  async function save() {
    setBusy(true); setError('')
    try {
      await api(`/api/events/${item.meta.event_id}`, 'PATCH', { starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), ...(item.meta.occurrence_start ? { scope: 'occurrence', occurrence_start: item.meta.occurrence_start } : {}), ...(confirmFixed ? { confirm_fixed: true } : {}) })
      toast(t(`“${item.title}” moved to ${clock(startsAt.toISOString())}.`, `نُقل «${item.title}» إلى ${clock(startsAt.toISOString())}.`))
      onMoved()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const clashes = valid && preview ? preview.conflicts : []
  const needsFixed = preview?.fixed && changed
  return <Dialog title={t(`Move “${item.title}”`, `نقل «${item.title}»`)} onClose={onClose}>
    {item.meta.occurrence_start && <p className="muted small">{t('Only this occurrence moves; the rest of the series stays.', 'يُنقل هذا الموعد فقط؛ وتبقى بقية السلسلة كما هي.')}</p>}
    <div className="move-fields">
      <label>{t('Date', 'التاريخ')}<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
      <label>{t('Start', 'البداية')}<input type="time" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label>{t('End', 'النهاية')}<input type="time" value={to} onChange={e => setTo(e.target.value)} /></label>
    </div>
    {!valid ? <p className="error" role="alert">{t('The end must be after the start.', 'يجب أن تكون النهاية بعد البداية.')}</p>
      : <div className={`move-preview ${clashes.length ? 'has-clash' : 'clear'}`} role="status" aria-live="polite" aria-busy={checking}>
        {clashes.length === 0 ? <p><CheckCircle2 size={16} />{checking && !preview ? t('Checking…', 'جارٍ التحقق…') : t('This time is free.', 'هذا الوقت متاح.')}</p>
          : <><p><AlertTriangle size={16} />{t(`Overlaps ${clashes.length} commitment(s):`, `يتداخل مع ${clashes.length} التزام:`)}</p>
            <ul>{clashes.map((c, i) => <li key={i} className={`src-${c.source}`}><i className={`dot src-${c.source}`} aria-hidden="true" /><strong>{c.title}</strong> <span className="muted small" dir="ltr">{clock(c.starts_at)}–{clock(c.ends_at)}</span> <span className="chip">{c.read_only && <Lock size={10} />}{c.source_label}</span> <span className="muted small">{t(`${c.minutes} min`, `${c.minutes} دقيقة`)}</span></li>)}</ul>
            <p className="muted small">{t('Pick a free time. Connected calendars are never changed by LifeOS.', 'اختر وقتاً متاحاً. لا يغيّر LifeOS التقويمات المرتبطة أبداً.')}</p></>}
      </div>}
    {needsFixed && <label className="inline"><input type="checkbox" checked={confirmFixed} onChange={e => setConfirmFixed(e.target.checked)} />{t('This is a fixed commitment — I want to change its time.', 'هذا التزام ثابت — أريد تغيير وقته.')}</label>}
    <ErrorMessage error={error} />
    <div className="toolbar">
      <button className="quiet" onClick={onClose}>{t('Cancel', 'إلغاء')}</button>
      <button className="primary" disabled={busy || !valid || !changed || checking || clashes.length > 0 || (needsFixed && !confirmFixed)} onClick={() => void save()}>{busy ? t('Saving…', 'جارٍ الحفظ…') : t('Move', 'نقل')}</button>
    </div>
  </Dialog>
}
