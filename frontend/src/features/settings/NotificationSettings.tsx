import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { BellRing, Smartphone, Send, Trash2, MoonStar, History, CheckCircle2, AlertTriangle, Info } from 'lucide-react'
import { api, type InboxNotification } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { pushState, enablePush, disablePush, type PushState } from '../../lib/push'
import { ErrorMessage, Skeleton } from '../../components/ui/Shared'

type Channel = { enabled: boolean; push: boolean }
type PushConfig = { configured: boolean; public_key: string | null; channels: Record<string, Channel> }
type Device = { id: number; device: string | null; created_at: string; last_used_at: string | null }
type Prefs = { quiet_start?: string | null; quiet_end?: string | null; notifications?: boolean; event_remind_minutes?: number }

const CATEGORIES = ['reminders', 'deadlines', 'calendar', 'focus', 'planning', 'review', 'system'] as const

export default function NotificationSettings() {
  const t = useText(), { language } = useLanguage(), toast = useToast()
  const config = useApi<PushConfig>('/api/push/config'), prefs = useApi<Prefs>('/api/settings')
  const devices = useApi<Device[]>('/api/push/subscriptions'), history = useApi<{ data: InboxNotification[] }>('/api/notifications')
  const [channels, setChannels] = useState<Record<string, Channel> | null>(null), [lead, setLead] = useState<number | null>(null)
  const [state, setState] = useState<PushState | null>(null), [busy, setBusy] = useState(''), [error, setError] = useState('')
  useEffect(() => { if (config.data) void pushState(config.data.configured).then(setState) }, [config.data])
  const current = channels ?? config.data?.channels, minutes = lead ?? prefs.data?.event_remind_minutes ?? 30

  const labels: Record<string, [string, string]> = {
    reminders: [t('Task reminders', 'تذكيرات المهام'), t('At the reminder time you set on a task.', 'في وقت التذكير الذي تحدده للمهمة.')],
    deadlines: [t('Deadlines', 'المواعيد النهائية'), t('An hour before a task is due, and when it becomes overdue.', 'قبل ساعة من موعد المهمة وعند تأخرها.')],
    calendar: [t('Calendar events', 'مواعيد التقويم'), t('Before events start, including recurring and connected-calendar events.', 'قبل بدء المواعيد، بما فيها المتكررة ومواعيد التقويمات المرتبطة.')],
    focus: [t('Focus sessions', 'جلسات التركيز'), t('When a focus session ends.', 'عند انتهاء جلسة التركيز.')],
    planning: [t('Daily planning', 'التخطيط اليومي'), t('At the start of your working day.', 'في بداية يوم عملك.')],
    review: [t('Weekly review', 'المراجعة الأسبوعية'), t('At the end of your week.', 'في نهاية أسبوعك.')],
    system: [t('Account & security', 'الحساب والأمان'), t('Connection problems and important account notices. Always shown in the app.', 'مشكلات الربط وتنبيهات الحساب المهمة. تظهر دائماً داخل التطبيق.')],
  }
  const pushLabel = (s: string | null | undefined) => s ? ({ sent: t('Pushed', 'أُرسل'), queued: t('Sending…', 'جارٍ الإرسال…'), retrying: t('Retrying', 'إعادة المحاولة'), failed: t('Push failed', 'فشل الإرسال'), suppressed: t('Held during focus', 'مؤجل أثناء التركيز'), no_device: t('No device', 'لا يوجد جهاز') } as Record<string, string>)[s] ?? s : t('In-app', 'داخل التطبيق')
  const when = (iso: string) => new Date(iso).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key); setError('')
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  const enable = () => run('enable', async () => {
    const next = await enablePush(config.data!.public_key!)
    setState(next); devices.reload()
    if (next === 'enabled') toast(t('Push notifications are on for this device.', 'تم تفعيل الإشعارات على هذا الجهاز.'))
  })
  const disable = () => run('disable', async () => { await disablePush(); setState('available'); devices.reload(); toast(t('Push turned off for this device.', 'تم إيقاف الإشعارات لهذا الجهاز.')) })
  const test = () => run('test', async () => {
    const r = await api<{ push_status: string | null }>('/api/push/test', 'POST')
    toast(r.push_status === 'queued' || r.push_status === 'sent' ? t('Test sent. It should appear in a few seconds.', 'أُرسل الاختبار. سيظهر خلال ثوانٍ.') : t('Test added to your in-app notifications.', 'أُضيف الاختبار إلى إشعاراتك داخل التطبيق.'))
    history.reload()
  })
  const remove = (id: number) => run(`device-${id}`, async () => { await api(`/api/push/subscriptions/${id}`, 'DELETE'); devices.reload(); setState(await pushState(true)) })
  const save = () => run('save', async () => { await api('/api/settings', 'PUT', { notification_channels: current, event_remind_minutes: minutes }); toast(t('Notification preferences saved.', 'حُفظت تفضيلات الإشعارات.')) })
  const toggle = (c: string, field: keyof Channel) => setChannels({ ...current!, [c]: { ...current![c], [field]: !current![c][field] } })

  if (config.error) return <ErrorMessage error={config.error} />
  if (!config.data || !current) return <Skeleton lines={5} />
  const pushReady = state === 'enabled'
  const pushMessage: Record<PushState, [typeof Info, string]> = {
    unsupported: [Info, t('This browser doesn’t support push notifications. You’ll still see every notification in the app.', 'هذا المتصفح لا يدعم الإشعارات الفورية. ستظهر كل الإشعارات داخل التطبيق.')],
    'no-worker': [Info, t('Push needs the installed or production version of LifeOS (served over HTTPS). In-app notifications work everywhere.', 'تتطلب الإشعارات الفورية نسخة LifeOS المثبتة أو نسخة الإنتاج عبر HTTPS. الإشعارات داخل التطبيق تعمل دائماً.')],
    'not-configured': [Info, t('Push isn’t set up on this server yet, so notifications appear in the app only. An administrator needs to add VAPID keys and run a queue worker.', 'لم تُعدّ الإشعارات الفورية على هذا الخادم بعد، لذلك تظهر الإشعارات داخل التطبيق فقط. يحتاج المسؤول إلى إضافة مفاتيح VAPID وتشغيل عامل الطوابير.')],
    denied: [AlertTriangle, t('Notifications are blocked for this site. Allow them in your browser’s site settings, then come back.', 'الإشعارات محظورة لهذا الموقع. اسمح بها من إعدادات الموقع في متصفحك ثم عد.')],
    enabled: [CheckCircle2, t('Push is on for this device.', 'الإشعارات الفورية مفعّلة على هذا الجهاز.')],
    available: [BellRing, t('Get reminders even when LifeOS isn’t open.', 'تلقَّ التذكيرات حتى عندما لا يكون LifeOS مفتوحاً.')],
  }
  const [StateIcon, stateText] = pushMessage[state ?? 'unsupported']

  return <div className="settings-stack">
    <section className="panel reveal">
      <h2><Smartphone size={18} /> {t('Push on this device', 'الإشعارات على هذا الجهاز')}</h2>
      <p className={`push-state state-${state}`}><StateIcon size={16} />{stateText}</p>
      <div className="toolbar">
        {state === 'available' && <button className="primary" disabled={!!busy} onClick={() => void enable()}><BellRing size={16} />{t('Turn on push', 'تفعيل الإشعارات')}</button>}
        {pushReady && <button className="quiet" disabled={!!busy} onClick={() => void disable()}>{t('Turn off on this device', 'إيقاف على هذا الجهاز')}</button>}
        <button className="quiet" disabled={!!busy} onClick={() => void test()}><Send size={16} />{t('Send a test', 'إرسال اختبار')}</button>
      </div>
      {devices.data && devices.data.length > 0 && <ul className="device-list">{devices.data.map(d => <li key={d.id}>
        <Smartphone size={15} /><span><strong>{d.device?.split(' ').slice(-1)[0] || t('Browser', 'متصفح')}</strong><small className="muted">{t('Added', 'أُضيف')} {when(d.created_at)}{d.last_used_at ? ` · ${t('last push', 'آخر إشعار')} ${when(d.last_used_at)}` : ''}</small></span>
        <button className="icon-button" aria-label={t('Remove device', 'إزالة الجهاز')} disabled={!!busy} onClick={() => void remove(d.id)}><Trash2 size={15} /></button>
      </li>)}</ul>}
    </section>

    <section className="panel reveal">
      <h2><BellRing size={18} /> {t('What to notify me about', 'ما الذي أُبلَّغ به')}</h2>
      {prefs.data?.notifications === false && <p className="notice muted">{t('Reminders are switched off in General settings, so only account notices are sent.', 'التذكيرات متوقفة في الإعدادات العامة، لذا تُرسل تنبيهات الحساب فقط.')}</p>}
      <table className="channel-table">
        <thead><tr><th scope="col">{t('Category', 'الفئة')}</th><th scope="col">{t('In app', 'داخل التطبيق')}</th><th scope="col">{t('Push', 'فوري')}</th></tr></thead>
        <tbody>{CATEGORIES.map(c => <tr key={c}>
          <th scope="row"><strong>{labels[c][0]}</strong><small className="muted">{labels[c][1]}</small></th>
          <td><input type="checkbox" aria-label={`${labels[c][0]} — ${t('in app', 'داخل التطبيق')}`} checked={current[c].enabled} disabled={c === 'system'} onChange={() => toggle(c, 'enabled')} /></td>
          <td><input type="checkbox" aria-label={`${labels[c][0]} — ${t('push', 'فوري')}`} checked={current[c].push && current[c].enabled} disabled={!current[c].enabled} onChange={() => toggle(c, 'push')} /></td>
        </tr>)}</tbody>
      </table>
      <label className="inline-field">{t('Remind me before events', 'ذكّرني قبل المواعيد')}
        <select value={minutes} onChange={e => setLead(Number(e.target.value))}>{[0, 5, 10, 15, 30, 60, 120].map(m => <option key={m} value={m}>{m === 0 ? t('At start time', 'عند البدء') : `${m} ${t('min', 'د')}`}</option>)}</select>
      </label>
      <p className="muted small"><MoonStar size={14} /> {prefs.data?.quiet_start && prefs.data?.quiet_end ? t(`Quiet hours ${prefs.data.quiet_start}–${prefs.data.quiet_end}: nothing is sent except account notices.`, `ساعات الهدوء ${prefs.data.quiet_start}–${prefs.data.quiet_end}: لا يُرسل شيء عدا تنبيهات الحساب.`) : t('No quiet hours set.', 'لم تُحدَّد ساعات هدوء.')} <Link to="/settings">{t('Change in General', 'تغيير في الإعدادات العامة')}</Link></p>
      <ErrorMessage error={error} />
      <button className="primary" disabled={!!busy} onClick={() => void save()}>{t('Save preferences', 'حفظ التفضيلات')}</button>
    </section>

    <section className="panel reveal">
      <h2><History size={18} /> {t('Recent notifications', 'الإشعارات الأخيرة')}</h2>
      {!history.data ? <Skeleton lines={3} /> : history.data.data.length === 0 ? <p className="muted">{t('Nothing yet.', 'لا شيء بعد.')}</p> :
        <ul className="notification-history">{history.data.data.slice(0, 20).map(n => <li key={n.id}>
          <span><strong>{n.title}</strong><small className="muted">{labels[n.category ?? 'system']?.[0] ?? n.kind} · {when(n.created_at)}</small></span>
          <span className={`badge push-${n.push_status ?? 'inapp'}`} title={n.push_error ?? undefined}>{pushLabel(n.push_status)}</span>
        </li>)}</ul>}
    </section>
  </div>
}
