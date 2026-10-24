import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { CalendarDays, RefreshCw, Unplug, Link2, ShieldCheck, AlertTriangle, CheckCircle2, Lock, Server } from 'lucide-react'
import { api } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { Dialog, ErrorMessage, Skeleton } from '../../components/ui/Shared'

type Account = { id: number; provider: string; email: string | null; display_name: string | null; status: 'active' | 'error' | 'revoked'; last_synced_at: string | null; last_error: string | null; events_count: number; connected_at: string | null }
type Provider = { provider: 'google' | 'outlook'; label: string; configured: boolean; redirect_uri: string; accounts: Account[] }

export default function IntegrationsSettings() {
  const t = useText(), { language } = useLanguage(), toast = useToast()
  const [params, setParams] = useSearchParams()
  const { data, error, reload } = useApi<{ providers: Provider[] }>('/api/integrations')
  const [busy, setBusy] = useState<string | null>(null), [failure, setFailure] = useState(''), [disconnecting, setDisconnecting] = useState<Account | null>(null)
  useEffect(() => {
    const connected = params.get('connected'), problem = params.get('error')
    if (!connected && !problem) return
    if (connected) toast(t(`${connected === 'google' ? 'Google Calendar' : 'Outlook'} connected. Your commitments now count as busy time.`, `تم ربط ${connected === 'google' ? 'تقويم Google' : 'Outlook'}. التزاماتك تُحتسب الآن وقتاً مشغولاً.`))
    if (problem) toast({ state: t('The sign-in link expired or was already used. Please try again.', 'انتهت صلاحية رابط تسجيل الدخول أو استُخدم. حاول مجدداً.'), denied: t('Access was not granted, so nothing was connected.', 'لم يُمنح الوصول، لذلك لم يتم الربط.'), exchange: t('The provider could not complete the connection. Please try again.', 'تعذر على المزوّد إكمال الربط. حاول مجدداً.') }[problem] ?? t('The connection did not complete.', 'لم يكتمل الربط.'), 'error')
    setParams({}, { replace: true })
  }, [params, setParams, toast, t])
  async function act<T>(key: string, fn: () => Promise<T>, success?: string) {
    setBusy(key); setFailure('')
    try { const r = await fn(); if (success) toast(success); reload(); return r } catch (e) { setFailure((e as Error).message); reload() } finally { setBusy(null) }
  }
  async function connect(provider: Provider) {
    const r = await act(provider.provider, () => api<{ authorization_url: string }>(`/api/integrations/${provider.provider}/connect`, 'POST'))
    if (r) window.location.assign(r.authorization_url)
  }
  const ago = (iso: string | null) => iso ? new Date(iso).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' }) : t('Never', 'أبداً')
  const statusLabel = (s: Account['status']) => ({ active: t('Syncing', 'متزامن'), error: t('Sync problem', 'مشكلة مزامنة'), revoked: t('Access revoked', 'أُلغي الوصول') }[s])

  return <div className="settings-stack">
    <section className="panel reveal integration-intro">
      <ShieldCheck size={22} />
      <div><h2>{t('Connected calendars', 'التقويمات المرتبطة')}</h2><p className="muted">{t('LifeOS reads your Google or Outlook events so planning and free-time calculations respect them. Access is read-only: LifeOS never creates, edits or deletes events in your external calendars, and your sign-in tokens are encrypted and never sent to the browser.', 'يقرأ LifeOS مواعيدك في Google أو Outlook لتراعيها الخطط وحساب الوقت المتاح. الوصول للقراءة فقط: لا ينشئ LifeOS أو يعدّل أو يحذف مواعيد في تقويماتك الخارجية، ورموز الدخول مشفرة ولا تُرسل إلى المتصفح.')}</p></div>
    </section>
    <ErrorMessage error={error || failure} />
    {!data ? <Skeleton height={220} /> : <div className="integration-grid">{data.providers.map(provider => <section key={provider.provider} className="panel reveal integration-card">
      <header className="row"><span className={`provider-mark ${provider.provider}`}><CalendarDays size={20} /></span><div><h3>{provider.label}</h3><small className="muted"><Lock size={11} /> {t('Read-only', 'للقراءة فقط')}</small></div></header>
      {!provider.configured ? <div className="not-configured">
        <p className="banner compact"><Server size={15} />{t('Not configured on this server yet.', 'غير مُعدّ على هذا الخادم بعد.')}</p>
        <details><summary>{t('Setup for administrators', 'الإعداد للمسؤولين')}</summary>
          <ol className="setup-list">
            <li>{provider.provider === 'google' ? t('Create an OAuth client (Web application) in Google Cloud Console and enable the Google Calendar API.', 'أنشئ عميل OAuth (تطبيق ويب) في Google Cloud Console وفعّل Google Calendar API.') : t('Register an app in Microsoft Entra ID (Azure) with the delegated permissions Calendars.Read, User.Read and offline_access.', 'سجّل تطبيقاً في Microsoft Entra ID بأذونات Calendars.Read وUser.Read وoffline_access.')}</li>
            <li>{t('Add this redirect URI:', 'أضف عنوان إعادة التوجيه هذا:')} <code dir="ltr">{provider.redirect_uri}</code></li>
            <li>{t('Set these variables in the backend .env and restart:', 'عيّن هذه المتغيرات في ملف .env للخادم وأعد التشغيل:')} <code dir="ltr">{provider.provider === 'google' ? 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET' : 'MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT'}</code></li>
          </ol>
        </details>
      </div> : <>
        {provider.accounts.length === 0 && <p className="muted">{t('No account connected.', 'لا يوجد حساب مرتبط.')}</p>}
        <ul className="account-list">{provider.accounts.map(account => <li key={account.id} className={`status-${account.status}`}>
          <div className="row"><strong dir="ltr">{account.email ?? account.display_name ?? provider.label}</strong><span className={`badge ${account.status === 'active' ? 'status-accepted' : account.status === 'error' ? 'status-pending' : 'status-rejected'}`}>{account.status === 'active' ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />} {statusLabel(account.status)}</span></div>
          <small className="muted">{t(`Last synced ${ago(account.last_synced_at)} · ${account.events_count} upcoming commitments`, `آخر مزامنة ${ago(account.last_synced_at)} · ${account.events_count} التزامات قادمة`)}</small>
          {account.last_error && account.status !== 'active' && <p className="error compact">{account.last_error}</p>}
          <div className="toolbar">
            {account.status === 'revoked' ? <button className="primary" disabled={busy !== null} onClick={() => void connect(provider)}><Link2 size={15} />{t('Reconnect', 'إعادة الربط')}</button> : <button className="quiet" disabled={busy !== null} onClick={() => void act(`sync-${account.id}`, () => api(`/api/integrations/accounts/${account.id}/sync`, 'POST'), t('Calendar synced.', 'تمت المزامنة.'))}><RefreshCw size={15} className={busy === `sync-${account.id}` ? 'spin' : ''} />{t('Sync now', 'مزامنة الآن')}</button>}
            <button className="quiet" disabled={busy !== null} onClick={() => setDisconnecting(account)}><Unplug size={15} />{t('Disconnect', 'فصل')}</button>
          </div>
        </li>)}</ul>
        <button className="primary" disabled={busy !== null} onClick={() => void connect(provider)}><Link2 size={16} />{busy === provider.provider ? t('Opening…', 'جارٍ الفتح…') : provider.accounts.length ? t('Connect another account', 'ربط حساب آخر') : t(`Connect ${provider.label}`, `ربط ${provider.label}`)}</button>
      </>}
    </section>)}</div>}
    {disconnecting && <Dialog title={t('Disconnect this calendar?', 'فصل هذا التقويم؟')} onClose={() => setDisconnecting(null)}>
      <p className="muted">{t('Imported events will be removed from LifeOS. Nothing changes in your external calendar.', 'ستُحذف المواعيد المستوردة من LifeOS. لن يتغير شيء في تقويمك الخارجي.')}</p>
      <div className="toolbar"><button className="quiet" onClick={() => setDisconnecting(null)}>{t('Cancel', 'إلغاء')}</button><button className="danger" disabled={busy !== null} onClick={() => { const a = disconnecting; setDisconnecting(null); void act(`del-${a.id}`, () => api(`/api/integrations/accounts/${a.id}`, 'DELETE'), t('Calendar disconnected.', 'تم فصل التقويم.')) }}>{t('Disconnect', 'فصل')}</button></div>
    </Dialog>}
  </div>
}
