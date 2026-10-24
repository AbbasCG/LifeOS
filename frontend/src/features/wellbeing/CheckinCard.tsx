import { useState, type FormEvent } from 'react'
import { localDate } from '../../lib/hooks'
import { CheckCircle2, HeartPulse } from 'lucide-react'
import { api, type Checkin } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { ErrorMessage } from '../../components/ui/Shared'

type Scale = 'energy' | 'mood' | 'stress' | 'workload'


/**
 * Optional daily check-in: four 1–5 scales, sleep and a short reflection. Every field is optional.
 * Parents remount it with a `key` when the saved check-in changes.
 */
export function CheckinCard({ initial, date = localDate(), compact = false, onSaved }: { initial: Checkin | null; date?: string; compact?: boolean; onSaved?: (c: Checkin) => void }) {
  const t = useText(), toast = useToast()
  const [values, setValues] = useState<Partial<Checkin>>(initial ?? {}), [sleep, setSleep] = useState(initial?.sleep_minutes != null ? String(initial.sleep_minutes / 60) : '')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(!!initial)
  const scales: { key: Scale; label: string; low: string; high: string }[] = [
    { key: 'energy', label: t('Energy', 'الطاقة'), low: t('Drained', 'مستنزف'), high: t('Energised', 'نشيط') },
    { key: 'mood', label: t('Mood', 'المزاج'), low: t('Low', 'منخفض'), high: t('Great', 'ممتاز') },
    { key: 'stress', label: t('Stress', 'التوتر'), low: t('Calm', 'هادئ'), high: t('Very stressed', 'متوتر جداً') },
    { key: 'workload', label: t('Workload', 'عبء العمل'), low: t('Light', 'خفيف'), high: t('Heavy', 'ثقيل') },
  ]
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('')
    const hours = sleep.trim() === '' ? null : Number(sleep.replace(',', '.'))
    try {
      const result = await api<Checkin>(`/api/checkins/${date}`, 'PUT', { energy: values.energy ?? null, mood: values.mood ?? null, stress: values.stress ?? null, workload: values.workload ?? null, sleep_minutes: hours === null || Number.isNaN(hours) ? null : Math.round(hours * 60), reflection: values.reflection || null })
      setSaved(true); toast(t('Check-in saved.', 'حُفظ تسجيل اليوم.')); onSaved?.(result)
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return <form className={`checkin-card${compact ? ' compact' : ''}`} onSubmit={submit} aria-label={t('Daily check-in', 'تسجيل اليوم')}>
    {scales.map(s => <fieldset key={s.key} className="scale">
      <legend>{s.label}</legend>
      <div className="scale-options" role="radiogroup" aria-label={s.label}>
        {[1, 2, 3, 4, 5].map(n => <label key={n} className={values[s.key] === n ? 'selected' : ''}>
          <input type="radio" name={`${s.key}-${date}`} value={n} checked={values[s.key] === n} onChange={() => { setValues({ ...values, [s.key]: n }); setSaved(false) }} />
          <span aria-hidden="true">{n}</span><span className="sr-only">{n === 1 ? s.low : n === 5 ? s.high : String(n)}</span>
        </label>)}
      </div>
      <div className="scale-ends" aria-hidden="true"><small>{s.low}</small><small>{s.high}</small></div>
    </fieldset>)}
    <label className="sleep-field">{t('Sleep last night (hours)', 'النوم الليلة الماضية (ساعات)')}<input type="number" inputMode="decimal" min="0" max="24" step="0.5" value={sleep} onChange={e => { setSleep(e.target.value); setSaved(false) }} /></label>
    {!compact && <label className="full">{t('Reflection (optional)', 'تأمل (اختياري)')}<textarea rows={3} maxLength={2000} value={values.reflection ?? ''} onChange={e => { setValues({ ...values, reflection: e.target.value }); setSaved(false) }} placeholder={t('What went well? What drained you?', 'ما الذي سار جيداً؟ وما الذي استنزفك؟')} /></label>}
    <ErrorMessage error={error} />
    <div className="toolbar">
      <button className="primary" disabled={busy}><HeartPulse size={16} />{saved ? t('Update check-in', 'تحديث التسجيل') : t('Save check-in', 'حفظ التسجيل')}</button>
      {saved && <span className="success inline" role="status"><CheckCircle2 size={15} />{t('Saved for today', 'محفوظ لليوم')}</span>}
    </div>
  </form>
}
