import { useEffect, useState } from 'react'
import { CalendarPlus, PenLine, PowerOff, Trash2 } from 'lucide-react'
import { api } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { ErrorMessage } from '../../components/ui/Shared'
import { WritePreview } from './WritePreview'
import type { WriteLink, WriteState } from '../../lib/calendarWrite'

/**
 * Opt-in "add events" for one connected calendar account: separate permission, an explicit calendar, and copies LifeOS
 * added whose LifeOS event is gone (which can be removed, with a preview).
 */
export function WriteAccess({ accountId, label, write, orphans, onChanged }: { accountId: number; label: string; write: WriteState; orphans: WriteLink[]; onChanged: () => void }) {
  const t = useText(), { language } = useLanguage(), toast = useToast()
  const [calendars, setCalendars] = useState<{ id: string; name: string; primary: boolean }[] | null>(null), [chosen, setChosen] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [removing, setRemoving] = useState<number | null>(null)
  const picking = write.granted && !write.enabled

  useEffect(() => {
    if (!picking) return
    let live = true
    api<{ data: { id: string; name: string; primary: boolean }[] }>(`/api/integrations/accounts/${accountId}/write/calendars`)
      .then(r => { if (live) { setCalendars(r.data); setChosen(r.data.find(c => c.primary)?.id ?? r.data[0]?.id ?? '') } }).catch(e => { if (live) setError((e as Error).message) })
    return () => { live = false }
  }, [picking, accountId])

  async function run<T>(fn: () => Promise<T>, done?: string) {
    setBusy(true); setError('')
    try { const r = await fn(); if (done) toast(done); return r } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function allow() {
    const r = await run(() => api<{ authorization_url: string }>(`/api/integrations/accounts/${accountId}/write/connect`, 'POST'))
    if (r) window.location.assign(r.authorization_url)
  }
  const choose = (calendarId: string | null) => void run(() => api(`/api/integrations/accounts/${accountId}/write`, 'PUT', { calendar_id: calendarId }), calendarId ? t('Adding events is on.', 'تم تفعيل إضافة المواعيد.', 'Afspraken toevoegen staat aan.') : t('Adding events is off.', 'تم إيقاف إضافة المواعيد.', 'Afspraken toevoegen staat uit.')).then(onChanged)

  if (!write.available) return null
  return <section className={`write-access ${write.enabled ? 'on' : ''}`} aria-label={t(`Add events to ${label}`, `إضافة مواعيد إلى ${label}`, `Afspraken toevoegen aan ${label}`)}>
    <header><PenLine size={15} /><strong>{t(`Add events to ${label}`, `إضافة مواعيد إلى ${label}`, `Afspraken toevoegen aan ${label}`)}</strong><span className={`pill ${write.enabled ? 'pill-ok' : 'pill-off'}`}>{write.enabled ? t('On', 'مفعّل', 'Aan') : t('Off', 'متوقف', 'Uit')}</span></header>
    {!write.granted && <>
      <p className="muted small">{t(`Optional. Lets you send a LifeOS event to ${label} — one at a time, after a preview, only when you confirm. It needs a separate permission to create and edit events; LifeOS only ever changes events it added.`, `اختياري. يتيح إرسال موعد من LifeOS إلى ${label} — واحداً تلو الآخر، بعد معاينة، وعند تأكيدك فقط. يتطلب إذناً منفصلاً لإنشاء المواعيد وتعديلها؛ ولا يغيّر LifeOS إلا ما أضافه.`, `Optioneel. Hiermee stuur je een LifeOS-afspraak naar ${label} — één voor één, na een voorbeeld, alleen als je bevestigt. Daarvoor is een apart recht nodig om afspraken aan te maken en te wijzigen; LifeOS wijzigt alleen afspraken die het zelf toevoegde.`)}</p>
      <button className="quiet" disabled={busy} onClick={() => void allow()}><CalendarPlus size={15} />{t('Allow adding events…', 'السماح بإضافة المواعيد…', 'Toevoegen van afspraken toestaan…')}</button>
    </>}
    {picking && <div className="write-pick">
      <label htmlFor={`write-cal-${accountId}`}>{t('Calendar for new events', 'التقويم للمواعيد الجديدة', 'Agenda voor nieuwe afspraken')}</label>
      <div className="feed-row">
        <select id={`write-cal-${accountId}`} value={chosen} disabled={!calendars?.length} onChange={e => setChosen(e.target.value)}>{(calendars ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button className="primary" disabled={busy || !chosen} onClick={() => choose(chosen)}>{t('Turn on', 'تفعيل', 'Aanzetten')}</button>
      </div>
      {calendars?.length === 0 && <p className="muted small">{t('This account has no calendar you can edit.', 'لا يوجد في هذا الحساب تقويم يمكنك تعديله.', 'Dit account heeft geen agenda die je kunt bewerken.')}</p>}
    </div>}
    {write.enabled && <div className="feed-row">
      <p className="small">{t(`Adds to “${write.calendar_name}”. ${write.copies} event(s) added so far.`, `يُضيف إلى «${write.calendar_name}». أُضيف ${write.copies} موعد حتى الآن.`, `Voegt toe aan “${write.calendar_name}”. Tot nu toe ${write.copies} afspraak/afspraken toegevoegd.`)}</p>
      <button className="quiet" disabled={busy} onClick={() => choose(null)}><PowerOff size={15} />{t('Turn off', 'إيقاف', 'Uitzetten')}</button>
    </div>}
    {write.granted && <p className="muted small">{t('Turning off stops new changes. To withdraw the permission itself, remove LifeOS in your account’s security settings, then reconnect.', 'الإيقاف يمنع أي تغييرات جديدة. لسحب الإذن نفسه، أزل LifeOS من إعدادات الأمان في حسابك ثم أعد الربط.', 'Uitzetten stopt nieuwe wijzigingen. Om het recht zelf in te trekken, verwijder je LifeOS in de beveiligingsinstellingen van je account en koppel je opnieuw.')}</p>}
    {orphans.length > 0 && <div className="write-orphans">
      <p className="small"><strong>{t(`${orphans.length} copy(ies) whose LifeOS event was deleted`, `${orphans.length} نسخة حُذف موعدها في LifeOS`, `${orphans.length} kopie(ën) waarvan de LifeOS-afspraak is verwijderd`)}</strong></p>
      <ul>{orphans.map(o => <li key={o.id}>
        <span>{o.title} <small className="muted" dir="ltr">{new Date(o.starts_at).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })}</small></span>
        {removing === o.id ? <WritePreview op="delete" accountId={accountId} linkId={o.id} onCancel={() => setRemoving(null)} onDone={() => { setRemoving(null); onChanged() }} />
          : <button className="quiet" disabled={!write.enabled} onClick={() => setRemoving(o.id)}><Trash2 size={14} />{t('Remove copy', 'إزالة النسخة', 'Kopie verwijderen')}</button>}
      </li>)}</ul>
    </div>}
    <ErrorMessage error={error} />
  </section>
}
