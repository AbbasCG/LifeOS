import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { CalendarDays, Link2, ShieldCheck, Lock, Server, ListChecks, NotebookPen, Mail, Sparkles, Clock3, Bot } from 'lucide-react'
import { api } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { Dialog, ErrorMessage, Skeleton } from '../../components/ui/Shared'
import { AccountCard, type ConnectedAccount, type SyncRunInfo } from '../connected/AccountCard'
import { FeedSubscribe } from '../connected/FeedSubscribe'
import { WriteAccess } from '../connected/WriteAccess'
import type { WriteData } from '../../lib/calendarWrite'

export type HubProvider = { provider: string; label: string; category: string; implemented: boolean; configured: boolean; status: 'available' | 'needs_configuration' | 'planned'; scopes: string; env_keys?: string[]; required_scopes?: string[]; redirect_uri?: string; connect_mode?: 'oauth' | 'url'; note?: { en: string; ar: string }; accounts: ConnectedAccount[] }
type Hub = { providers: HubProvider[]; categories: { key: string; providers: HubProvider[] }[]; ai_connected_data: boolean }

const ICONS: Record<string, typeof CalendarDays> = { calendars: CalendarDays, tasks: ListChecks, productivity: NotebookPen, email: Mail, future: Sparkles }

export default function IntegrationsSettings() {
  const t = useText(), { language } = useLanguage(), toast = useToast(), ar = language === 'ar'
  const [params, setParams] = useSearchParams()
  const { data, error, reload } = useApi<Hub>('/api/integrations')
  const writes = useApi<WriteData>('/api/calendar-write')
  const refresh = () => { reload(); writes.reload() }
  const [busy, setBusy] = useState<string | null>(null), [failure, setFailure] = useState(''), [disconnecting, setDisconnecting] = useState<ConnectedAccount | null>(null), [replacingFeed, setReplacingFeed] = useState(false)
  const labelOf = (provider: string) => data?.providers.find(p => p.provider === provider)?.label ?? provider
  useEffect(() => {
    const connected = params.get('connected'), problem = params.get('error'), granted = params.get('write_granted')
    if (!connected && !problem && !granted) return
    if (granted) toast(t('Permission granted. Pick the calendar LifeOS may add events to — nothing is added until you confirm each one.', 'تم منح الإذن. اختر التقويم الذي يضيف إليه LifeOS المواعيد — لا يُضاف شيء قبل تأكيدك لكل موعد.'))
    if (connected) toast(t(`${connected} connected. Only the primary calendar or list is included — choose more below.`, `تم الربط. يُضمَّن التقويم أو القائمة الرئيسية فقط — اختر المزيد أدناه.`))
    if (problem) toast({ state: t('The sign-in link expired or was already used. Please try again.', 'انتهت صلاحية رابط تسجيل الدخول أو استُخدم. حاول مجدداً.'), denied: t('Access was not granted, so nothing was connected.', 'لم يُمنح الوصول، لذلك لم يتم الربط.'), scope: t('Connected, but the read permission was not granted, so nothing can be imported. Reconnect and keep read access ticked.', 'تم الربط لكن لم يُمنح إذن القراءة، فلا يمكن استيراد شيء. أعد الربط وأبقِ إذن القراءة محدداً.'), exchange: t('The provider could not complete the connection. Please try again.', 'تعذر على المزوّد إكمال الربط. حاول مجدداً.'), write_scope: t('The permission to add events was not granted, so nothing changed.', 'لم يُمنح إذن إضافة المواعيد، فلم يتغير شيء.'), write_account: t('A different account signed in. Allow adding events with the same account that is connected here.', 'سجّل حساب مختلف الدخول. اسمح بإضافة المواعيد بالحساب نفسه المرتبط هنا.') }[problem] ?? t('The connection did not complete.', 'لم يكتمل الربط.'), 'error')
    setParams({}, { replace: true })
  }, [params, setParams, toast, t])
  async function act<T>(key: string, fn: () => Promise<T>, success?: string) {
    setBusy(key); setFailure('')
    try { const r = await fn(); if (success) toast(success); reload(); return r } catch (e) { setFailure((e as Error).message); reload() } finally { setBusy(null) }
  }
  async function connect(provider: HubProvider) {
    const r = await act(provider.provider, () => api<{ authorization_url: string }>(`/api/integrations/${provider.provider}/connect`, 'POST'))
    if (r) window.location.assign(r.authorization_url)
  }
  async function syncNow(account: ConnectedAccount) {
    setBusy(`sync-${account.id}`); setFailure('')
    try {
      const r = await api<{ imported: number; run: SyncRunInfo | null }>(`/api/integrations/accounts/${account.id}/sync`, 'POST')
      const run = r.run
      toast(run ? t(`Synced: ${run.upserted} updated, ${run.removed} removed${run.moved ? `, ${run.moved} moved` : ''}${run.status === 'partial' ? ' — some calendars could not be read' : ''}.`, `تمت المزامنة: ${run.upserted} محدّث، ${run.removed} محذوف${run.moved ? `، ${run.moved} منقول` : ''}${run.status === 'partial' ? ' — تعذّرت قراءة بعض التقويمات' : ''}.`) : t('Synced.', 'تمت المزامنة.'), run?.status === 'partial' ? 'error' : undefined)
    } catch (e) { setFailure((e as Error).message) } finally { setBusy(null); reload() }
  }
  const categoryLabel: Record<string, [string, string]> = {
    calendars: [t('Calendars', 'التقويمات'), t('Busy time from your other calendars, so plans never collide.', 'الوقت المشغول من تقويماتك الأخرى، حتى لا تتعارض الخطط.')],
    tasks: [t('Tasks', 'المهام'), t('Read-only to-dos from other apps, shown with their source. Copy one into LifeOS to plan it.', 'مهام للقراءة فقط من تطبيقات أخرى مع مصدرها. انسخ مهمة إلى LifeOS لتخطط لها.')],
    productivity: [t('Productivity', 'الإنتاجية'), t('Knowledge and project tools.', 'أدوات المعرفة والمشاريع.')],
    email: [t('Email', 'البريد'), t('Privacy-first: never message bodies, never sent to AI without consent.', 'الخصوصية أولاً: دون نص الرسائل، ولا مشاركة مع الذكاء الاصطناعي دون موافقة.')],
    future: [t('Coming later', 'لاحقاً'), t('Integrations we plan to support through open standards.', 'تكاملات نخطط لدعمها عبر معايير مفتوحة.')],
  }

  return <div className="settings-stack hub">
    <section className="panel reveal integration-intro">
      <ShieldCheck size={22} />
      <div><h2>{t('Connected accounts', 'الحسابات المرتبطة')}</h2><p className="muted">{t('Bring your other calendars and to-do apps into one timeline. Every connection is read-only: LifeOS never creates, edits or deletes anything in them. Sign-in tokens are encrypted and never reach the browser, and you choose exactly which calendars and lists are imported.', 'اجمع تقويماتك وتطبيقات مهامك في خط زمني واحد. كل ربط للقراءة فقط: لا ينشئ LifeOS أو يعدّل أو يحذف شيئاً فيها. رموز الدخول مشفرة ولا تصل إلى المتصفح، وأنت تختار بالضبط التقويمات والقوائم المستوردة.')}</p></div>
    </section>
    {data && <section className="panel reveal consent-row">
      <Bot size={20} />
      <div><h3>{t('Share connected data with an external AI provider', 'مشاركة البيانات المرتبطة مع مزود ذكاء اصطناعي خارجي')}</h3><p className="muted">{t('Off by default. When off, Copilot sees connected events only as “Busy” and never sees imported tasks. The local assistant always works on this server.', 'متوقف افتراضياً. عند إيقافه يرى المساعد المواعيد المرتبطة كـ«مشغول» فقط ولا يرى المهام المستوردة. المساعد المحلي يعمل دائماً على هذا الخادم.')}</p></div>
      <label className="switch"><input type="checkbox" role="switch" checked={data.ai_connected_data} disabled={busy !== null} aria-label={t('Share connected data with an external AI provider', 'مشاركة البيانات المرتبطة مع مزود ذكاء اصطناعي خارجي')} onChange={() => void act('consent', () => api('/api/settings', 'PUT', { ai_connected_data: !data.ai_connected_data }), t('Preference saved.', 'تم حفظ التفضيل.'))} /><span aria-hidden="true" /></label>
    </section>}
    {data && data.providers.every(p => p.accounts.length === 0) && <section className="panel reveal hub-onboarding" aria-labelledby="hub-onboarding-title">
      <h2 id="hub-onboarding-title">{t('Bring your calendars and to-dos together', 'اجمع تقويماتك ومهامك في مكان واحد')}</h2>
      <ol className="onboarding-steps">
        <li><span>1</span><div><strong>{t('Pick an app below', 'اختر تطبيقاً أدناه')}</strong><p className="muted small">{t('Google Calendar, Outlook, Google Tasks, Microsoft To Do, Todoist — or any .ics calendar link.', 'تقويم Google أو Outlook أو مهام Google أو Microsoft To Do أو Todoist — أو أي رابط تقويم .ics.')}</p></div></li>
        <li><span>2</span><div><strong>{t('Approve read-only access', 'وافق على الوصول للقراءة فقط')}</strong><p className="muted small">{t('You sign in on the provider’s own page. LifeOS never sees your password and can never change your data there.', 'تسجّل الدخول في صفحة المزوّد نفسه. لا يرى LifeOS كلمة مرورك ولا يمكنه تغيير بياناتك هناك.')}</p></div></li>
        <li><span>3</span><div><strong>{t('Choose what to include', 'اختر ما تريد تضمينه')}</strong><p className="muted small">{t('Only your primary calendar or list is imported at first. Add more any time, or disconnect to remove everything.', 'يُستورد تقويمك أو قائمتك الرئيسية فقط في البداية. أضف المزيد متى شئت، أو افصل لحذف كل شيء.')}</p></div></li>
      </ol>
    </section>}
    <ErrorMessage error={error || failure} />
    {!data ? <Skeleton height={220} /> : data.categories.map(category => { const Icon = ICONS[category.key] ?? Sparkles; return <section key={category.key} className="hub-category reveal" aria-labelledby={`hub-${category.key}`}>
      <header><span className="hub-icon"><Icon size={18} /></span><div><h2 id={`hub-${category.key}`}>{categoryLabel[category.key]?.[0] ?? category.key}</h2><p className="muted">{categoryLabel[category.key]?.[1]}</p></div></header>
      <div className="integration-grid">{category.providers.map(provider => <section key={provider.provider} className={`panel integration-card state-${provider.status}`}>
        <header className="row"><span className={`provider-mark ${provider.provider}`}>{(ICONS[category.key] && <Icon size={20} />)}</span><div><h3>{provider.label}</h3><small className="muted">{provider.status === 'planned' ? <><Clock3 size={11} /> {t('Planned', 'مخطط')}</> : <><Lock size={11} /> {t('Read-only', 'للقراءة فقط')}</>}</small></div>
          <span className={`pill pill-${provider.status}`}>{{ available: t('Available', 'متاح'), needs_configuration: t('Needs server setup', 'يتطلب إعداد الخادم'), planned: t('Not yet available', 'غير متاح بعد') }[provider.status]}</span></header>
        {provider.status === 'planned' ? <p className="muted small">{provider.note?.[ar ? 'ar' : 'en']}</p>
          : provider.status === 'needs_configuration' ? <div className="not-configured">
            <p className="banner compact"><Server size={15} />{t('Not configured on this server yet.', 'غير مُعدّ على هذا الخادم بعد.')}</p>
            <details><summary>{t('Setup for administrators', 'الإعداد للمسؤولين')}</summary>
              <ol className="setup-list">
                <li>{t('Permissions requested:', 'الأذونات المطلوبة:')} <span dir="ltr">{provider.scopes}</span></li>
                <li>{t('Add this redirect URI to the OAuth app:', 'أضف عنوان إعادة التوجيه هذا إلى تطبيق OAuth:')} <code dir="ltr">{provider.redirect_uri}</code></li>
                <li>{t('Set these variables in the backend .env and restart:', 'عيّن هذه المتغيرات في ملف .env للخادم وأعد التشغيل:')} <code dir="ltr">{provider.env_keys?.join(', ')}</code></li>
                <li>{t('Full instructions: docs/IMPLEMENTATION_STATUS.md, section “Connected Life”.', 'التعليمات الكاملة: docs/IMPLEMENTATION_STATUS.md، قسم «Connected Life».')}</li>
              </ol>
            </details>
          </div> : <>
            <p className="muted small scopes">{provider.scopes}</p>
            {provider.accounts.length === 0 && <p className="muted">{t('No account connected.', 'لا يوجد حساب مرتبط.')}</p>}
            <ul className="account-list">{provider.accounts.map(account => <AccountCard key={account.id} account={account} label={provider.label} tasks={category.key === 'tasks'} requiredScopes={provider.required_scopes ?? []} busy={busy}
              onSync={() => void syncNow(account)} onReconnect={() => provider.connect_mode === 'url' ? setReplacingFeed(true) : void connect(provider)} onDisconnect={() => setDisconnecting(account)} onSaved={refresh}>
              {account.write && <WriteAccess accountId={account.id} label={provider.label} write={account.write} orphans={(writes.data?.links ?? []).filter(l => l.orphan && l.account_id === account.id)} onChanged={refresh} />}
            </AccountCard>)}</ul>
            {provider.connect_mode === 'url' ? <FeedSubscribe replacing={replacingFeed} onDone={() => { setReplacingFeed(false); reload() }} /> : <button className="primary" disabled={busy !== null} aria-label={provider.accounts.length ? t(`Connect another ${provider.label} account`, `ربط حساب ${provider.label} آخر`) : undefined} onClick={() => void connect(provider)}><Link2 size={16} />{busy === provider.provider ? t('Opening…', 'جارٍ الفتح…') : provider.accounts.length ? t('Connect another account', 'ربط حساب آخر') : t(`Connect ${provider.label}`, `ربط ${provider.label}`)}</button>}
          </>}
      </section>)}</div>
    </section> })}
    {disconnecting && <Dialog title={t(`Disconnect ${labelOf(disconnecting.provider)}?`, `فصل ${labelOf(disconnecting.provider)}؟`)} onClose={() => setDisconnecting(null)}>
      <p className="muted">{t('Imported events and tasks will be removed from LifeOS; tasks you copied into LifeOS stay. Nothing changes in the connected app.', 'ستُحذف المواعيد والمهام المستوردة من LifeOS؛ وتبقى المهام التي نسختها إلى LifeOS. لن يتغير شيء في التطبيق المرتبط.')}</p>
      {(disconnecting.write?.copies ?? 0) > 0 && <p className="banner compact">{t(`${disconnecting.write?.copies} event(s) LifeOS added stay in ${labelOf(disconnecting.provider)}. Remove them first if you don’t want them.`, `تبقى ${disconnecting.write?.copies} مواعيد أضافها LifeOS في ${labelOf(disconnecting.provider)}. أزلها أولاً إن لم تكن تريدها.`)}</p>}
      <div className="toolbar"><button className="quiet" onClick={() => setDisconnecting(null)}>{t('Cancel', 'إلغاء')}</button><button className="danger" disabled={busy !== null} onClick={() => { const a = disconnecting; setDisconnecting(null); void act(`del-${a.id}`, () => api(`/api/integrations/accounts/${a.id}`, 'DELETE'), t('Disconnected.', 'تم الفصل.')) }}>{t('Disconnect', 'فصل')}</button></div>
    </Dialog>}
  </div>
}
