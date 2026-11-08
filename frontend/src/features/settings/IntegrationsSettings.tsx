import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { CalendarDays, ChevronRight, Info, Link2, ListChecks, Lock, Mail, NotebookPen, Plus, RefreshCw, Rss, Server, ShieldCheck, Sparkles, Bot } from 'lucide-react'
import { api } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { Dialog, ErrorMessage, Skeleton } from '../../components/ui/Shared'
import { AccountCard, type ConnectedAccount, type SyncRunInfo } from '../connected/AccountCard'
import { accountState, useAccountStateLabel } from '../../lib/accountState'
import { BottomSheet } from '../../components/visual'
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

  const [info, setInfo] = useState<null | { kind: 'about' } | { kind: 'provider'; provider: string } | { kind: 'account'; id: number } | { kind: 'feed' }>(null)
  const closeInfo = () => { setInfo(null); setReplacingFeed(false) }
  const stateLabelOf = useAccountStateLabel()
  const providerList = data ? [...new Map([...data.providers, ...data.categories.flatMap(c => c.providers)].map(p => [p.provider, p])).values()] : []
  const detail = info?.kind === 'account' ? providerList.flatMap(p => p.accounts.map(a => ({ a, p }))).find(x => x.a.id === info.id) : undefined
  const aboutProvider = info?.kind === 'provider' ? providerList.find(p => p.provider === info.provider) : undefined
  const pillText = (status: HubProvider['status']) => ({ available: t('Available', 'متاح'), needs_configuration: t('Setup needed', 'يتطلب إعداداً'), planned: t('Soon', 'قريباً') }[status])
  const none = !!data && data.providers.every(p => p.accounts.length === 0)

  const accountRow = (account: ConnectedAccount, provider: HubProvider) => {
    const st = accountState(account), feed = provider.connect_mode === 'url', syncing = busy === `sync-${account.id}`
    return <div key={account.id} className={`account-mini state-${st}`}>
      <span className={`status-dot dot-${st}`} aria-hidden="true" />
      <span className="account-mini-text"><span dir="ltr" className="account-email">{account.email ?? account.display_name ?? provider.label}</span><small className="muted">{stateLabelOf(st)}</small></span>
      {st === 'revoked' || st === 'scope'
        ? <button type="button" className="primary compact" disabled={busy !== null} onClick={() => feed ? (setReplacingFeed(true), setInfo({ kind: 'feed' })) : void connect(provider)}><Link2 size={15} aria-hidden="true" />{feed ? t('Use a new link', 'استخدام رابط جديد') : t('Reconnect', 'إعادة الربط')}</button>
        : <button type="button" className="icon-button" disabled={busy !== null || st === 'waiting'} aria-busy={syncing} aria-label={t('Sync now', 'مزامنة الآن')} title={t('Sync now', 'مزامنة الآن')} onClick={() => void syncNow(account)}><RefreshCw size={17} className={syncing ? 'spin' : ''} aria-hidden="true" /></button>}
      <button type="button" className="icon-button" aria-label={t(`Details of ${account.email ?? provider.label}`, `تفاصيل ${account.email ?? provider.label}`)} onClick={() => setInfo({ kind: 'account', id: account.id })}><ChevronRight size={18} aria-hidden="true" className="flip-rtl" /></button>
    </div>
  }
  const providerRow = (provider: HubProvider, Icon: typeof CalendarDays) => <li key={provider.provider} className={`integration-card hub-item state-${provider.status}`}>
    <div className="hub-item-main">
      <span className={`provider-mark ${provider.provider}`}><Icon size={20} aria-hidden="true" /></span>
      <span className="hub-item-name"><strong>{provider.label}</strong></span>
      {provider.status !== 'available' && <span className={`pill pill-${provider.status}`}>{pillText(provider.status)}</span>}
      {provider.status !== 'available' && <button type="button" className="icon-button" aria-label={t(`About ${provider.label}`, `عن ${provider.label}`)} onClick={() => setInfo({ kind: 'provider', provider: provider.provider })}><Info size={18} aria-hidden="true" /></button>}
      {provider.status === 'available' && provider.connect_mode === 'url' && <button type="button" className="primary compact" onClick={() => setInfo({ kind: 'feed' })}><Rss size={15} aria-hidden="true" />{t('Add link', 'إضافة رابط')}</button>}
      {provider.status === 'available' && provider.connect_mode !== 'url' && (provider.accounts.length === 0
        ? <button type="button" className="primary compact" disabled={busy !== null} aria-label={t(`Connect ${provider.label}`, `ربط ${provider.label}`)} onClick={() => void connect(provider)}><Link2 size={15} aria-hidden="true" />{t('Connect', 'ربط')}</button>
        : <button type="button" className="icon-button" disabled={busy !== null} aria-label={t(`Connect another ${provider.label} account`, `ربط حساب ${provider.label} آخر`)} title={t('Connect another account', 'ربط حساب آخر')} onClick={() => void connect(provider)}><Plus size={18} aria-hidden="true" /></button>)}
    </div>
    {provider.accounts.map(account => accountRow(account, provider))}
  </li>

  return <div className="settings-stack hub hub-compact">
    <header className="hub-head">
      <ShieldCheck size={22} aria-hidden="true" />
      <h2>{t('Connected accounts', 'الحسابات المرتبطة')}</h2>
      <span className="chip"><Lock size={12} aria-hidden="true" />{t('Read-only', 'للقراءة فقط')}</span>
      <button type="button" className="icon-button" aria-label={t('About connections', 'عن الربط')} title={t('About connections', 'عن الربط')} onClick={() => setInfo({ kind: 'about' })}><Info size={19} aria-hidden="true" /></button>
    </header>
    {data && <div className="hub-row consent-row">
      <Bot size={20} aria-hidden="true" />
      <span className="hub-row-text"><strong id="share-ai-label">{t('Share with external AI', 'مشاركة مع ذكاء خارجي')}</strong><small className="muted">{data.ai_connected_data ? t('On', 'مفعّل') : t('Off', 'متوقف')}</small><span id="share-ai-desc" className="sr-only">{t('Share connected data with an external AI provider', 'مشاركة البيانات المرتبطة مع مزود ذكاء اصطناعي خارجي')}</span></span>
      <label className="switch"><input type="checkbox" role="switch" checked={data.ai_connected_data} disabled={busy !== null} aria-labelledby="share-ai-label" aria-describedby="share-ai-desc" onChange={() => void act('consent', () => api('/api/settings', 'PUT', { ai_connected_data: !data.ai_connected_data }), t('Preference saved.', 'تم حفظ التفضيل.'))} /><span aria-hidden="true" /></label>
    </div>}
    {none && <ol className="onboarding-mini" aria-label={t('Bring your calendars and to-dos together', 'اجمع تقويماتك ومهامك في مكان واحد')}>
      <li><span>1</span>{t('Pick an app below', 'اختر تطبيقاً أدناه')}</li>
      <li><span>2</span>{t('Approve read-only access', 'وافق على الوصول للقراءة فقط')}</li>
      <li><span>3</span>{t('Choose what to include', 'اختر ما تريد تضمينه')}</li>
    </ol>}
    <ErrorMessage error={error || failure} />
    {!data ? <Skeleton height={220} /> : data.categories.filter(c => c.providers.length > 0).map(category => { const Icon = ICONS[category.key] ?? Sparkles; return <section key={category.key} className="hub-category" aria-labelledby={`hub-${category.key}`}>
      <h2 id={`hub-${category.key}`} className="hub-cat-title"><span className="hub-icon"><Icon size={16} aria-hidden="true" /></span>{categoryLabel[category.key]?.[0] ?? category.key}</h2>
      <ul className="hub-list">{category.providers.map(provider => providerRow(provider, Icon))}</ul>
    </section> })}
    {info?.kind === 'about' && <BottomSheet title={t('About connections', 'عن الربط')} onClose={closeInfo}>
      <div className="hub-info">
        <p>{t('Bring your other calendars and to-do apps into one timeline. Every connection is read-only: LifeOS never creates, edits or deletes anything in them. Sign-in tokens are encrypted and never reach the browser, and you choose exactly which calendars and lists are imported.', 'اجمع تقويماتك وتطبيقات مهامك في خط زمني واحد. كل ربط للقراءة فقط: لا ينشئ LifeOS أو يعدّل أو يحذف شيئاً فيها. رموز الدخول مشفرة ولا تصل إلى المتصفح، وأنت تختار بالضبط التقويمات والقوائم المستوردة.')}</p>
        <h3>{t('Share connected data with an external AI provider', 'مشاركة البيانات المرتبطة مع مزود ذكاء اصطناعي خارجي')}</h3>
        <p className="muted">{t('Off by default. When off, Copilot sees connected events only as “Busy” and never sees imported tasks. The local assistant always works on this server.', 'متوقف افتراضياً. عند إيقافه يرى المساعد المواعيد المرتبطة كـ«مشغول» فقط ولا يرى المهام المستوردة. المساعد المحلي يعمل دائماً على هذا الخادم.')}</p>
        <ol className="onboarding-steps">
        <li><span>1</span><div><strong>{t('Pick an app below', 'اختر تطبيقاً أدناه')}</strong><p className="muted small">{t('Google Calendar, Outlook, Google Tasks, Microsoft To Do, Todoist — or any .ics calendar link.', 'تقويم Google أو Outlook أو مهام Google أو Microsoft To Do أو Todoist — أو أي رابط تقويم .ics.')}</p></div></li>
        <li><span>2</span><div><strong>{t('Approve read-only access', 'وافق على الوصول للقراءة فقط')}</strong><p className="muted small">{t('You sign in on the provider’s own page. LifeOS never sees your password and can never change your data there.', 'تسجّل الدخول في صفحة المزوّد نفسه. لا يرى LifeOS كلمة مرورك ولا يمكنه تغيير بياناتك هناك.')}</p></div></li>
        <li><span>3</span><div><strong>{t('Choose what to include', 'اختر ما تريد تضمينه')}</strong><p className="muted small">{t('Only your primary calendar or list is imported at first. Add more any time, or disconnect to remove everything.', 'يُستورد تقويمك أو قائمتك الرئيسية فقط في البداية. أضف المزيد متى شئت، أو افصل لحذف كل شيء.')}</p></div></li>
      </ol>
        <dl className="hub-glossary">{Object.entries(categoryLabel).map(([key, [title, text]]) => <div key={key}><dt>{title}</dt><dd className="muted">{text}</dd></div>)}</dl>
      </div>
    </BottomSheet>}
    {aboutProvider && <BottomSheet title={aboutProvider.label} onClose={closeInfo}>
      {aboutProvider.status === 'planned' ? <p className="muted">{aboutProvider.note?.[ar ? 'ar' : 'en']}</p>
        : <div className="not-configured">
          <p className="banner compact"><Server size={15} aria-hidden="true" />{t('Not configured on this server yet.', 'غير مُعدّ على هذا الخادم بعد.')}</p>
          <h3>{t('Setup for administrators', 'الإعداد للمسؤولين')}</h3>
          <ol className="setup-list">
                <li>{t('Permissions requested:', 'الأذونات المطلوبة:')} <span dir="ltr">{aboutProvider.scopes}</span></li>
                <li>{t('Add this redirect URI to the OAuth app:', 'أضف عنوان إعادة التوجيه هذا إلى تطبيق OAuth:')} <code dir="ltr">{aboutProvider.redirect_uri}</code></li>
                <li>{t('Set these variables in the backend .env and restart:', 'عيّن هذه المتغيرات في ملف .env للخادم وأعد التشغيل:')} <code dir="ltr">{aboutProvider.env_keys?.join(', ')}</code></li>
                <li>{t('Full instructions: docs/IMPLEMENTATION_STATUS.md, section “Connected Life”.', 'التعليمات الكاملة: docs/IMPLEMENTATION_STATUS.md، قسم «Connected Life».')}</li>
              </ol>
        </div>}
    </BottomSheet>}
    {info?.kind === 'feed' && <BottomSheet title={t('Calendar subscription', 'اشتراك في تقويم')} onClose={closeInfo}>
      <FeedSubscribe replacing={replacingFeed} onDone={() => { closeInfo(); reload() }} />
    </BottomSheet>}
    {detail && <BottomSheet tall title={detail.a.email ?? detail.p.label} onClose={closeInfo}>
      <ul className="account-list"><AccountCard account={detail.a} label={detail.p.label} tasks={detail.p.category === 'tasks'} requiredScopes={detail.p.required_scopes ?? []} busy={busy}
        onSync={() => void syncNow(detail.a)} onReconnect={() => detail.p.connect_mode === 'url' ? (setReplacingFeed(true), setInfo({ kind: 'feed' })) : void connect(detail.p)} onDisconnect={() => { setDisconnecting(detail.a); setInfo(null) }} onSaved={refresh}>
        {detail.a.write && <WriteAccess accountId={detail.a.id} label={detail.p.label} write={detail.a.write} orphans={(writes.data?.links ?? []).filter(l => l.orphan && l.account_id === detail.a.id)} onChanged={refresh} />}
      </AccountCard></ul>
    </BottomSheet>}
    {disconnecting && <Dialog title={t(`Disconnect ${labelOf(disconnecting.provider)}?`, `فصل ${labelOf(disconnecting.provider)}؟`)} onClose={() => setDisconnecting(null)}>
      <p className="muted">{t('Imported events and tasks will be removed from LifeOS; tasks you copied into LifeOS stay. Nothing changes in the connected app.', 'ستُحذف المواعيد والمهام المستوردة من LifeOS؛ وتبقى المهام التي نسختها إلى LifeOS. لن يتغير شيء في التطبيق المرتبط.')}</p>
      {(disconnecting.write?.copies ?? 0) > 0 && <p className="banner compact">{t(`${disconnecting.write?.copies} event(s) LifeOS added stay in ${labelOf(disconnecting.provider)}. Remove them first if you don’t want them.`, `تبقى ${disconnecting.write?.copies} مواعيد أضافها LifeOS في ${labelOf(disconnecting.provider)}. أزلها أولاً إن لم تكن تريدها.`)}</p>}
      <div className="toolbar"><button className="quiet" onClick={() => setDisconnecting(null)}>{t('Cancel', 'إلغاء')}</button><button className="danger" disabled={busy !== null} onClick={() => { const a = disconnecting; setDisconnecting(null); void act(`del-${a.id}`, () => api(`/api/integrations/accounts/${a.id}`, 'DELETE'), t('Disconnected.', 'تم الفصل.')) }}>{t('Disconnect', 'فصل')}</button></div>
    </Dialog>}
  </div>
}
