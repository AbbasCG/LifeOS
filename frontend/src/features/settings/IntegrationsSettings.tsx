import { useEffect, useRef, useState } from 'react'
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
import { ManagePermissions } from '../connected/ManagePermissions'
import { SyncSettings } from '../connected/SyncSettings'
import type { WriteData } from '../../lib/calendarWrite'

export type HubProvider = { provider: string; label: string; category: string; implemented: boolean; configured: boolean; status: 'available' | 'needs_configuration' | 'planned' | 'disabled'; scopes: string; env_keys?: string[]; required_scopes?: string[]; redirect_uri?: string; connect_mode?: 'oauth' | 'url'; note?: { en: string; ar: string }; capabilities?: string[]; presets?: string[]; accounts: ConnectedAccount[] }
type Hub = { providers: HubProvider[]; categories: { key: string; providers: HubProvider[] }[]; ai_connected_data: boolean }

const ICONS: Record<string, typeof CalendarDays> = { calendars: CalendarDays, tasks: ListChecks, productivity: NotebookPen, email: Mail, future: Sparkles }

export default function IntegrationsSettings() {
  const t = useText(), { language } = useLanguage(), toast = useToast(), ar = language === 'ar'
  const [params, setParams] = useSearchParams()
  const { data, error, reload } = useApi<Hub>('/api/integrations')
  const writes = useApi<WriteData>('/api/calendar-write')
  const refresh = () => { reload(); writes.reload() }
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [busy, setBusy] = useState<string | null>(null), [failure, setFailure] = useState(''), [disconnecting, setDisconnecting] = useState<ConnectedAccount | null>(null), [replacingFeed, setReplacingFeed] = useState(false)
  const labelOf = (provider: string) => data?.providers.find(p => p.provider === provider)?.label ?? provider
  useEffect(() => {
    const connected = params.get('connected'), problem = params.get('error'), granted = params.get('write_granted')
    if (!connected && !problem && !granted) return
    if (granted) toast(t('Permission granted. Pick the calendar LifeOS may add events to — nothing is added until you confirm each one.', 'تم منح الإذن. اختر التقويم الذي يضيف إليه LifeOS المواعيد — لا يُضاف شيء قبل تأكيدك لكل موعد.', 'Toestemming gegeven. Kies de agenda waaraan LifeOS afspraken mag toevoegen — er wordt niets toegevoegd tot je elke afspraak bevestigt.'))
    if (connected) toast(t(`${connected} connected. Only the primary calendar or list is included — choose more below.`, `تم الربط. يُضمَّن التقويم أو القائمة الرئيسية فقط — اختر المزيد أدناه.`, `${connected} verbonden. Alleen de hoofdagenda of -lijst is meegenomen — kies hieronder meer.`))
    if (problem) toast({ state: t('The sign-in link expired or was already used. Please try again.', 'انتهت صلاحية رابط تسجيل الدخول أو استُخدم. حاول مجدداً.', 'De inloglink is verlopen of al gebruikt. Probeer het opnieuw.'), denied: t('Access was not granted, so nothing was connected.', 'لم يُمنح الوصول، لذلك لم يتم الربط.', 'Toegang is niet verleend, dus er is niets verbonden.'), scope: t('Connected, but the read permission was not granted, so nothing can be imported. Reconnect and keep read access ticked.', 'تم الربط لكن لم يُمنح إذن القراءة، فلا يمكن استيراد شيء. أعد الربط وأبقِ إذن القراءة محدداً.', 'Verbonden, maar het leesrecht is niet verleend, dus er kan niets worden geïmporteerd. Koppel opnieuw en laat leestoegang aangevinkt.'), exchange: t('The provider could not complete the connection. Please try again.', 'تعذر على المزوّد إكمال الربط. حاول مجدداً.', 'De provider kon de koppeling niet voltooien. Probeer het opnieuw.'), write_scope: t('The permission to add events was not granted, so nothing changed.', 'لم يُمنح إذن إضافة المواعيد، فلم يتغير شيء.', 'Het recht om afspraken toe te voegen is niet verleend, dus er is niets veranderd.'), write_account: t('A different account signed in. Allow adding events with the same account that is connected here.', 'سجّل حساب مختلف الدخول. اسمح بإضافة المواعيد بالحساب نفسه المرتبط هنا.', 'Er is met een ander account ingelogd. Sta het toevoegen van afspraken toe met hetzelfde account dat hier gekoppeld is.'),
      not_configured: t('This connection is not set up on this server. Ask an administrator.', 'هذا الربط غير مُعدّ على هذا الخادم. اطلب من المسؤول إعداده.', 'Deze koppeling is op deze server niet ingesteld. Vraag het een beheerder.'),
      provider_disabled: t('New connections to this service are switched off by an administrator.', 'أوقف المسؤول الربط الجديد مع هذه الخدمة.', 'Nieuwe koppelingen met deze dienst zijn door een beheerder uitgezet.') }[problem] ?? t('The connection did not complete.', 'لم يكتمل الربط.', 'De koppeling is niet voltooid.'), 'error')
    setParams({}, { replace: true })
  }, [params, setParams, toast, t])
  async function act<T>(key: string, fn: () => Promise<T>, success?: string, after?: () => void) {
    setBusy(key); setFailure('')
    try { const r = await fn(); if (success) toast(success); reload(); after?.(); return r } catch (e) { setFailure((e as Error).message); reload() } finally { setBusy(null) }
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
      toast(run ? t(`Synced: ${run.upserted} updated, ${run.removed} removed${run.moved ? `, ${run.moved} moved` : ''}${run.status === 'partial' ? ' — some calendars could not be read' : ''}.`, `تمت المزامنة: ${run.upserted} محدّث، ${run.removed} محذوف${run.moved ? `، ${run.moved} منقول` : ''}${run.status === 'partial' ? ' — تعذّرت قراءة بعض التقويمات' : ''}.`, `Gesynchroniseerd: ${run.upserted} bijgewerkt, ${run.removed} verwijderd${run.moved ? `, ${run.moved} verplaatst` : ''}${run.status === 'partial' ? ' — sommige agenda’s konden niet worden gelezen' : ''}.`) : t('Synced.', 'تمت المزامنة.', 'Gesynchroniseerd.'), run?.status === 'partial' ? 'error' : undefined)
    } catch (e) { setFailure((e as Error).message) } finally { setBusy(null); reload() }
  }
  const categoryLabel: Record<string, [string, string]> = {
    calendars: [t('Calendars', 'التقويمات', 'Agenda’s'), t('Busy time from your other calendars, so plans never collide.', 'الوقت المشغول من تقويماتك الأخرى، حتى لا تتعارض الخطط.', 'Bezette tijd uit je andere agenda’s, zodat plannen nooit botsen.')],
    tasks: [t('Tasks', 'المهام', 'Taken'), t('Read-only to-dos from other apps, shown with their source. Copy one into LifeOS to plan it.', 'مهام للقراءة فقط من تطبيقات أخرى مع مصدرها. انسخ مهمة إلى LifeOS لتخطط لها.', 'Alleen-lezen taken uit andere apps, met hun bron. Kopieer er een naar LifeOS om hem in te plannen.')],
    productivity: [t('Productivity', 'الإنتاجية', 'Productiviteit'), t('Knowledge and project tools.', 'أدوات المعرفة والمشاريع.', 'Kennis- en projecttools.')],
    email: [t('Email', 'البريد', 'E-mail'), t('Privacy-first: never message bodies, never sent to AI without consent.', 'الخصوصية أولاً: دون نص الرسائل، ولا مشاركة مع الذكاء الاصطناعي دون موافقة.', 'Privacy eerst: nooit berichtteksten, nooit zonder toestemming naar AI gestuurd.')],
    future: [t('Coming later', 'لاحقاً', 'Later beschikbaar'), t('Integrations we plan to support through open standards.', 'تكاملات نخطط لدعمها عبر معايير مفتوحة.', 'Koppelingen die we via open standaarden willen ondersteunen.')],
  }

  const [info, setInfo] = useState<null | { kind: 'about' } | { kind: 'provider'; provider: string } | { kind: 'account'; id: number } | { kind: 'feed' }>(null)
  const closeInfo = () => { setInfo(null); setReplacingFeed(false) }
  const stateLabelOf = useAccountStateLabel()
  const providerList = data ? [...new Map([...data.providers, ...data.categories.flatMap(c => c.providers)].map(p => [p.provider, p])).values()] : []
  const detail = info?.kind === 'account' ? providerList.flatMap(p => p.accounts.map(a => ({ a, p }))).find(x => x.a.id === info.id) : undefined
  const aboutProvider = info?.kind === 'provider' ? providerList.find(p => p.provider === info.provider) : undefined
  const pillText = (status: HubProvider['status']) => ({ available: t('Available', 'متاح', 'Beschikbaar'), needs_configuration: t('Setup needed', 'يتطلب إعداداً', 'Instellen nodig'), planned: t('Soon', 'قريباً', 'Binnenkort'), disabled: t('Off', 'متوقف', 'Uit') }[status])
  const none = !!data && data.providers.every(p => p.accounts.length === 0)

  const accountRow = (account: ConnectedAccount, provider: HubProvider) => {
    const st = accountState(account), feed = provider.connect_mode === 'url', syncing = busy === `sync-${account.id}`
    return <div key={account.id} className={`account-mini state-${st}`}>
      <span className={`status-dot dot-${st}`} aria-hidden="true" />
      <span className="account-mini-text"><span dir="ltr" className="account-email">{account.email ?? account.display_name ?? provider.label}</span><small className="muted">{stateLabelOf(st)}</small></span>
      {st === 'revoked' || st === 'scope'
        ? <button type="button" className="primary compact" disabled={busy !== null} onClick={() => feed ? (setReplacingFeed(true), setInfo({ kind: 'feed' })) : void connect(provider)}><Link2 size={15} aria-hidden="true" />{feed ? t('Use a new link', 'استخدام رابط جديد', 'Een nieuwe link gebruiken') : t('Reconnect', 'إعادة الربط', 'Opnieuw koppelen')}</button>
        : <button type="button" className="icon-button" disabled={busy !== null || st === 'waiting'} aria-busy={syncing} aria-label={t('Sync now', 'مزامنة الآن', 'Nu synchroniseren')} title={t('Sync now', 'مزامنة الآن', 'Nu synchroniseren')} onClick={() => void syncNow(account)}><RefreshCw size={17} className={syncing ? 'spin' : ''} aria-hidden="true" /></button>}
      <button type="button" className="icon-button" aria-label={t(`Details of ${account.email ?? provider.label}`, `تفاصيل ${account.email ?? provider.label}`, `Details van ${account.email ?? provider.label}`)} onClick={() => setInfo({ kind: 'account', id: account.id })}><ChevronRight size={18} aria-hidden="true" className="flip-rtl" /></button>
    </div>
  }
  const providerRow = (provider: HubProvider, Icon: typeof CalendarDays) => <li key={provider.provider} className={`integration-card hub-item state-${provider.status}`}>
    <div className="hub-item-main">
      <span className={`provider-mark ${provider.provider}`}><Icon size={20} aria-hidden="true" /></span>
      <span className="hub-item-name"><strong>{provider.label}</strong></span>
      {provider.status !== 'available' && <span className={`pill pill-${provider.status}`}>{pillText(provider.status)}</span>}
      {provider.status !== 'available' && <button type="button" className="icon-button" aria-label={t(`About ${provider.label}`, `عن ${provider.label}`, `Over ${provider.label}`)} onClick={() => setInfo({ kind: 'provider', provider: provider.provider })}><Info size={18} aria-hidden="true" /></button>}
      {provider.status === 'available' && provider.connect_mode === 'url' && <button type="button" className="primary compact" onClick={() => setInfo({ kind: 'feed' })}><Rss size={15} aria-hidden="true" />{t('Add link', 'إضافة رابط', 'Link toevoegen')}</button>}
      {provider.status === 'available' && provider.connect_mode !== 'url' && (provider.accounts.length === 0
        ? <button type="button" className="primary compact" disabled={busy !== null} aria-label={t(`Connect ${provider.label}`, `ربط ${provider.label}`, `${provider.label} koppelen`)} onClick={() => void connect(provider)}><Link2 size={15} aria-hidden="true" />{t('Connect', 'ربط', 'Koppelen')}</button>
        : <button type="button" className="icon-button" disabled={busy !== null} aria-label={t(`Connect another ${provider.label} account`, `ربط حساب ${provider.label} آخر`, `Nog een ${provider.label}-account koppelen`)} title={t('Connect another account', 'ربط حساب آخر', 'Nog een account koppelen')} onClick={() => void connect(provider)}><Plus size={18} aria-hidden="true" /></button>)}
    </div>
    {provider.accounts.map(account => accountRow(account, provider))}
  </li>

  return <div className="settings-stack hub hub-compact">
    <header className="hub-head">
      <ShieldCheck size={22} aria-hidden="true" />
      <h2 ref={headingRef} tabIndex={-1}>{t('Connected accounts', 'الحسابات المرتبطة', 'Gekoppelde accounts')}</h2>
      <span className="chip"><Lock size={12} aria-hidden="true" />{t('Read-only by default', 'للقراءة فقط افتراضيًا', 'Standaard alleen lezen')}</span>
      <button type="button" className="icon-button" aria-label={t('About connections', 'عن الربط', 'Over koppelingen')} title={t('About connections', 'عن الربط', 'Over koppelingen')} onClick={() => setInfo({ kind: 'about' })}><Info size={19} aria-hidden="true" /></button>
    </header>
    {data && <div className="hub-row consent-row">
      <Bot size={20} aria-hidden="true" />
      <span className="hub-row-text"><strong id="share-ai-label">{t('Share with external AI', 'مشاركة مع ذكاء خارجي', 'Delen met externe AI')}</strong><small className="muted">{data.ai_connected_data ? t('On', 'مفعّل', 'Aan') : t('Off', 'متوقف', 'Uit')}</small><span id="share-ai-desc" className="sr-only">{t('Share connected data with an external AI provider', 'مشاركة البيانات المرتبطة مع مزود ذكاء اصطناعي خارجي', 'Gekoppelde gegevens delen met een externe AI-provider')}</span></span>
      <label className="switch"><input type="checkbox" role="switch" checked={data.ai_connected_data} disabled={busy !== null} aria-labelledby="share-ai-label" aria-describedby="share-ai-desc" onChange={() => void act('consent', () => api('/api/settings', 'PUT', { ai_connected_data: !data.ai_connected_data }), t('Preference saved.', 'تم حفظ التفضيل.', 'Voorkeur opgeslagen.'))} /><span aria-hidden="true" /></label>
    </div>}
    {none && <ol className="onboarding-mini" aria-label={t('Bring your calendars and to-dos together', 'اجمع تقويماتك ومهامك في مكان واحد', 'Breng je agenda’s en to-do’s samen')}>
      <li><span>1</span>{t('Pick an app below', 'اختر تطبيقاً أدناه', 'Kies hieronder een app')}</li>
      <li><span>2</span>{t('Approve read-only access', 'وافق على الوصول للقراءة فقط', 'Keur alleen-lezen toegang goed')}</li>
      <li><span>3</span>{t('Choose what to include', 'اختر ما تريد تضمينه', 'Kies wat je wilt opnemen')}</li>
    </ol>}
    <ErrorMessage error={error || (detail ? '' : failure)} />
    {!data ? <Skeleton height={220} /> : data.categories.filter(c => c.providers.length > 0).map(category => { const Icon = ICONS[category.key] ?? Sparkles; return <section key={category.key} className="hub-category" aria-labelledby={`hub-${category.key}`}>
      <h2 id={`hub-${category.key}`} className="hub-cat-title"><span className="hub-icon"><Icon size={16} aria-hidden="true" /></span>{categoryLabel[category.key]?.[0] ?? category.key}</h2>
      <ul className="hub-list">{category.providers.map(provider => providerRow(provider, Icon))}</ul>
    </section> })}
    {info?.kind === 'about' && <BottomSheet title={t('About connections', 'عن الربط', 'Over koppelingen')} onClose={closeInfo}>
      <div className="hub-info">
        <p>{t('Bring your other calendars and to-do apps into one timeline. By default every connection is read-only: LifeOS creates, changes or deletes nothing there unless you allow it for that connection under Manage permissions. Sign-in tokens are encrypted and never reach the browser, and you choose exactly which calendars and lists are imported.', 'اجمع تقويماتك وتطبيقات مهامك في خط زمني واحد. كل ربط للقراءة فقط افتراضيًا: لا ينشئ LifeOS ولا يغيّر ولا يحذف شيئاً فيها إلا إذا سمحت بذلك لهذا الاتصال ضمن «إدارة الصلاحيات». رموز الدخول مشفرة ولا تصل إلى المتصفح، وأنت تختار بالضبط التقويمات والقوائم المستوردة.', 'Breng je andere agenda’s en to-do-apps samen in één tijdlijn. Standaard leest LifeOS alleen: het maakt, wijzigt of verwijdert niets bij de dienst, tenzij jij dat per koppeling toestaat onder Rechten beheren. Inlogtokens zijn versleuteld en bereiken nooit de browser, en jij kiest precies welke agenda’s en lijsten worden geïmporteerd.')}</p>
        <h3>{t('Share connected data with an external AI provider', 'مشاركة البيانات المرتبطة مع مزود ذكاء اصطناعي خارجي', 'Gekoppelde gegevens delen met een externe AI-provider')}</h3>
        <p className="muted">{t('Off by default. When off, Copilot sees connected events only as “Busy” and never sees imported tasks. The local assistant always works on this server.', 'متوقف افتراضياً. عند إيقافه يرى المساعد المواعيد المرتبطة كـ«مشغول» فقط ولا يرى المهام المستوردة. المساعد المحلي يعمل دائماً على هذا الخادم.', 'Standaard uit. Als het uit staat, ziet Copilot gekoppelde afspraken alleen als “Bezet” en nooit geïmporteerde taken. De lokale assistent werkt altijd op deze server.')}</p>
        <ol className="onboarding-steps">
        <li><span>1</span><div><strong>{t('Pick an app below', 'اختر تطبيقاً أدناه', 'Kies hieronder een app')}</strong><p className="muted small">{t('Google Calendar, Outlook, Google Tasks, Microsoft To Do, Todoist — or any .ics calendar link.', 'تقويم Google أو Outlook أو مهام Google أو Microsoft To Do أو Todoist — أو أي رابط تقويم .ics.', 'Google Agenda, Outlook, Google Tasks, Microsoft To Do, Todoist — of elke .ics-agendalink.')}</p></div></li>
        <li><span>2</span><div><strong>{t('Approve read-only access', 'وافق على الوصول للقراءة فقط', 'Keur alleen-lezen toegang goed')}</strong><p className="muted small">{t('You sign in on the provider’s own page. LifeOS never sees your password and can never change your data there.', 'تسجّل الدخول في صفحة المزوّد نفسه. لا يرى LifeOS كلمة مرورك ولا يمكنه تغيير بياناتك هناك.', 'Je logt in op de pagina van de provider zelf. LifeOS ziet je wachtwoord nooit en kan daar nooit je gegevens wijzigen.')}</p></div></li>
        <li><span>3</span><div><strong>{t('Choose what to include', 'اختر ما تريد تضمينه', 'Kies wat je wilt opnemen')}</strong><p className="muted small">{t('Only your primary calendar or list is imported at first. Add more any time, or disconnect to remove everything.', 'يُستورد تقويمك أو قائمتك الرئيسية فقط في البداية. أضف المزيد متى شئت، أو افصل لحذف كل شيء.', 'In het begin wordt alleen je hoofdagenda of -lijst geïmporteerd. Voeg altijd meer toe, of koppel los om alles te verwijderen.')}</p></div></li>
      </ol>
        <dl className="hub-glossary">{Object.entries(categoryLabel).map(([key, [title, text]]) => <div key={key}><dt>{title}</dt><dd className="muted">{text}</dd></div>)}</dl>
      </div>
    </BottomSheet>}
    {aboutProvider && <BottomSheet title={aboutProvider.label} onClose={closeInfo}>
      {aboutProvider.status === 'planned' ? <p className="muted">{aboutProvider.note?.[ar ? 'ar' : 'en']}</p>
        : aboutProvider.status === 'disabled' ? <p className="banner compact"><Server size={15} aria-hidden="true" />{t('New connections to this service are switched off by an administrator. Accounts that are already connected keep working.', 'أوقف المسؤول الربط الجديد مع هذه الخدمة. الحسابات المرتبطة تبقى تعمل.', 'Nieuwe koppelingen met deze dienst zijn door een beheerder uitgezet. Gekoppelde accounts blijven werken.')}</p>
        : <div className="not-configured">
          <p className="banner compact"><Server size={15} aria-hidden="true" />{t('Not set up on this server yet.', 'غير مُعدّ على هذا الخادم بعد.', 'Nog niet ingesteld op deze server.')}</p>
          {aboutProvider.env_keys && aboutProvider.env_keys.length > 0
            ? <>
              <h3>{t('Setup for administrators', 'الإعداد للمسؤولين', 'Instellen voor beheerders')}</h3>
              <ol className="setup-list">
                <li>{t('Permissions requested:', 'الأذونات المطلوبة:', 'Gevraagde rechten:')} <span dir="ltr">{aboutProvider.scopes}</span></li>
                <li>{t('Create the OAuth app at the provider once and register this redirect address:', 'أنشئ تطبيق OAuth لدى المزود مرة واحدة وسجّل عنوان إعادة التوجيه هذا:', 'Maak de OAuth-app eenmalig aan bij de provider en registreer dit omleidingsadres:')} <code dir="ltr">{aboutProvider.redirect_uri}</code></li>
                <li>{t('Enter the client ID and secret under “Provider configuration” on this page (no server access needed). The server’s .env variables still work:', 'أدخل معرّف العميل والسر ضمن «إعداد المزودين» في هذه الصفحة (دون الحاجة إلى الخادم). ومتغيرات .env ما زالت تعمل:', 'Voer de client-id en het geheim in onder “Providerconfiguratie” op deze pagina (geen servertoegang nodig). De .env-variabelen van de server werken nog steeds:')} <code dir="ltr">{aboutProvider.env_keys.join(', ')}</code></li>
              </ol>
            </>
            : <p className="muted">{t('You do not need to enter any keys. Ask a LifeOS administrator to set this connection up; then you can connect your account here.', 'لا تحتاج إلى إدخال أي مفاتيح. اطلب من مسؤول LifeOS إعداد هذا الربط، ثم تستطيع ربط حسابك من هنا.', 'Je hoeft geen sleutels in te voeren. Vraag een LifeOS-beheerder deze koppeling in te stellen; daarna kun je hier je account koppelen.')}</p>}
        </div>}
    </BottomSheet>}
    {info?.kind === 'feed' && <BottomSheet title={t('Calendar subscription', 'اشتراك في تقويم', 'Agenda-abonnement')} onClose={closeInfo}>
      <FeedSubscribe replacing={replacingFeed} onDone={() => { closeInfo(); reload() }} />
    </BottomSheet>}
    {detail && <BottomSheet tall title={detail.a.email ?? detail.p.label} onClose={closeInfo}>
      <ErrorMessage error={failure} />
      <ul className="account-list"><AccountCard account={detail.a} label={detail.p.label} tasks={detail.p.category === 'tasks'} requiredScopes={detail.p.required_scopes ?? []} busy={busy}
        onSync={() => void syncNow(detail.a)} onReconnect={() => detail.p.connect_mode === 'url' ? (setReplacingFeed(true), setInfo({ kind: 'feed' })) : void connect(detail.p)} onDisconnect={() => { setDisconnecting(detail.a); setInfo(null) }} onSaved={refresh}>
        {detail.a.permissions && detail.a.permissions.capabilities.length > 0 && <ManagePermissions accountId={detail.a.id} label={detail.p.label} state={detail.a.permissions} onChanged={refresh} />}
        {detail.a.sync && <SyncSettings accountId={detail.a.id} label={detail.p.label} state={detail.a.sync} onChanged={refresh} />}
        {detail.a.write && <WriteAccess accountId={detail.a.id} label={detail.p.label} write={detail.a.write} orphans={(writes.data?.links ?? []).filter(l => l.orphan && l.account_id === detail.a.id)} onChanged={refresh} />}
      </AccountCard></ul>
    </BottomSheet>}
    {disconnecting && <Dialog title={t(`Disconnect ${labelOf(disconnecting.provider)}?`, `فصل ${labelOf(disconnecting.provider)}؟`, `${labelOf(disconnecting.provider)} loskoppelen?`)} onClose={() => setDisconnecting(null)}>
      <p id="disconnect-warning" className="muted">{t('Imported events and tasks will be removed from LifeOS; tasks you copied into LifeOS stay. Nothing changes in the connected app.', 'ستُحذف المواعيد والمهام المستوردة من LifeOS؛ وتبقى المهام التي نسختها إلى LifeOS. لن يتغير شيء في التطبيق المرتبط.', 'Geïmporteerde afspraken en taken worden uit LifeOS verwijderd; taken die je naar LifeOS kopieerde blijven. Er verandert niets in de gekoppelde app.')}</p>
      {(disconnecting.write?.copies ?? 0) > 0 && <p id="disconnect-copies" className="banner compact">{t(`${disconnecting.write?.copies} event(s) LifeOS added stay in ${labelOf(disconnecting.provider)}. Remove them first if you don’t want them.`, `تبقى ${disconnecting.write?.copies} مواعيد أضافها LifeOS في ${labelOf(disconnecting.provider)}. أزلها أولاً إن لم تكن تريدها.`, `${disconnecting.write?.copies} afspraak/afspraken die LifeOS toevoegde, blijven in ${labelOf(disconnecting.provider)}. Verwijder ze eerst als je ze niet wilt.`)}</p>}
      <div className="toolbar"><button className="quiet" data-autofocus aria-describedby={(disconnecting.write?.copies ?? 0) > 0 ? 'disconnect-warning disconnect-copies' : 'disconnect-warning'} onClick={() => setDisconnecting(null)}>{t('Cancel', 'إلغاء', 'Annuleren')}</button><button className="danger" disabled={busy !== null} onClick={() => { const a = disconnecting; setDisconnecting(null); void act(`del-${a.id}`, () => api(`/api/integrations/accounts/${a.id}`, 'DELETE'), t('Disconnected.', 'تم الفصل.', 'Losgekoppeld.'), () => headingRef.current?.focus()) }}>{t('Disconnect', 'فصل', 'Loskoppelen')}</button></div>
    </Dialog>}
  </div>
}
