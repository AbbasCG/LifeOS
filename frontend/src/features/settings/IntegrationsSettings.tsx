import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useSearchParams } from 'react-router'
import { AlertTriangle, CalendarDays, ChevronRight, Info, X, Link2, ListChecks, Lock, Mail, NotebookPen, Plus, RefreshCw, Rss, Server, ShieldCheck, Sparkles, Bot } from 'lucide-react'
import { api } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { Dialog, ErrorMessage } from '../../components/ui/Shared'
import { AccountCard, type ConnectedAccount, type SyncRunInfo } from '../connected/AccountCard'
import { isBroken, usePresetLabel, useStateLine } from '../connected/accountLine'
import { accountState } from '../../lib/accountState'
import { ProviderTile } from '../../components/ui/ProviderTile'
import { BottomSheet } from '../../components/visual'
import { FeedSubscribe } from '../connected/FeedSubscribe'
import { WriteAccess } from '../connected/WriteAccess'
import { ManagePermissions } from '../connected/ManagePermissions'
import { SyncSettings } from '../connected/SyncSettings'
import type { WriteData } from '../../lib/calendarWrite'
import { prefersReducedMotion } from '../../lib/useCountUp'

export type HubProvider = { provider: string; label: string; category: string; implemented: boolean; configured: boolean; status: 'available' | 'needs_configuration' | 'planned' | 'disabled'; scopes: string; env_keys?: string[]; required_scopes?: string[]; redirect_uri?: string; connect_mode?: 'oauth' | 'url'; note?: { en: string; ar: string }; capabilities?: string[]; presets?: string[]; accounts: ConnectedAccount[] }
type Hub = { providers: HubProvider[]; categories: { key: string; providers: HubProvider[] }[]; ai_connected_data: boolean }

const ICONS: Record<string, typeof CalendarDays> = { calendars: CalendarDays, tasks: ListChecks, productivity: NotebookPen, email: Mail, future: Sparkles }

/** Arabic has six plural forms; the count in "N accounts need attention" must agree with them. */
const arAttention = (n: number, form: Intl.LDMLPluralRule) => form === 'one' ? 'حساب واحد يحتاج إلى انتباه' : form === 'two' ? 'حسابان يحتاجان إلى انتباه' : form === 'few' ? `${n} حسابات تحتاج إلى انتباه` : form === 'many' ? `${n} حسابًا يحتاج إلى انتباه` : `${n} حساب يحتاج إلى انتباه`

export default function IntegrationsSettings() {
  const t = useText(), { language } = useLanguage(), toast = useToast(), ar = language === 'ar'
  const [params, setParams] = useSearchParams()
  const { data, error, reload } = useApi<Hub>('/api/integrations')
  const writes = useApi<WriteData>('/api/calendar-write')
  const refresh = () => { reload(); writes.reload() }
  const headingRef = useRef<HTMLHeadingElement>(null), hubRef = useRef<HTMLDivElement>(null), [moreServices, setMoreServices] = useState(false)
  const [busy, setBusy] = useState<string | null>(null), [failure, setFailure] = useState(''), [disconnecting, setDisconnecting] = useState<ConnectedAccount | null>(null), [replacingFeed, setReplacingFeed] = useState(false), [notices, setNotices] = useState<{ text: string; error: boolean }[]>([]), handled = useRef('')
  // Motion state: all of it is short-lived and only ever marks a real event (a sync that ended, an account just connected, a row on its way out, the first reveal).
  const [settled, setSettled] = useState<{ id: number; ok: boolean } | null>(null), [justProvider, setJustProvider] = useState<string | null>(null), [justId, setJustId] = useState<number | null>(null)
  const [leaving, setLeaving] = useState<number | null>(null), [armedFor, setArmedFor] = useState<number | null>(null), [rise, setRise] = useState<boolean | null>(null)
  const labelOf = (provider: string) => data?.providers.find(p => p.provider === provider)?.label ?? provider
  useEffect(() => {
    const connected = params.get('connected'), problem = params.get('error'), granted = params.get('write_granted')
    if (!connected && !problem && !granted) return
    const key = params.toString()
    if (handled.current === key) return   // `t` changes every render: handle each return once
    handled.current = key
    const said: { text: string; error: boolean }[] = []
    const say = (text: string, kind?: 'error') => { said.push({ text, error: kind === 'error' }) }   // the persistent banner is the one announcement; no toast
    if (granted) say(t('Permission granted. Pick the calendar LifeOS may add events to — nothing is added until you confirm each one.', 'تم منح الإذن. اختر التقويم الذي يضيف إليه LifeOS المواعيد — لا يُضاف شيء قبل تأكيدك لكل موعد.', 'Toestemming gegeven. Kies de agenda waaraan LifeOS afspraken mag toevoegen — er wordt niets toegevoegd tot je elke afspraak bevestigt.'))
    if (connected) say(t(`${connected} connected. Only the primary calendar or list is included — choose more below.`, `تم الربط. يُضمَّن التقويم أو القائمة الرئيسية فقط — اختر المزيد أدناه.`, `${connected} verbonden. Alleen de hoofdagenda of -lijst is meegenomen — kies hieronder meer.`))
    if (problem) say({ state: t('The sign-in link expired or was already used. Please try again.', 'انتهت صلاحية رابط تسجيل الدخول أو استُخدم. حاول مجدداً.', 'De inloglink is verlopen of al gebruikt. Probeer het opnieuw.'), denied: t('Access was not granted, so nothing was connected.', 'لم يُمنح الوصول، لذلك لم يتم الربط.', 'Toegang is niet verleend, dus er is niets verbonden.'), scope: t('Connected, but the read permission was not granted, so nothing can be imported. Reconnect and keep read access ticked.', 'تم الربط لكن لم يُمنح إذن القراءة، فلا يمكن استيراد شيء. أعد الربط وأبقِ إذن القراءة محدداً.', 'Verbonden, maar het leesrecht is niet verleend, dus er kan niets worden geïmporteerd. Koppel opnieuw en laat leestoegang aangevinkt.'), exchange: t('The provider could not complete the connection. Please try again.', 'تعذر على المزوّد إكمال الربط. حاول مجدداً.', 'De provider kon de koppeling niet voltooien. Probeer het opnieuw.'), write_scope: t('The permission to add events was not granted, so nothing changed.', 'لم يُمنح إذن إضافة المواعيد، فلم يتغير شيء.', 'Het recht om afspraken toe te voegen is niet verleend, dus er is niets veranderd.'), write_account: t('A different account signed in. Allow adding events with the same account that is connected here.', 'سجّل حساب مختلف الدخول. اسمح بإضافة المواعيد بالحساب نفسه المرتبط هنا.', 'Er is met een ander account ingelogd. Sta het toevoegen van afspraken toe met hetzelfde account dat hier gekoppeld is.'),
      not_configured: t('This connection is not set up on this server. Ask an administrator.', 'هذا الربط غير مُعدّ على هذا الخادم. اطلب من المسؤول إعداده.', 'Deze koppeling is op deze server niet ingesteld. Vraag het een beheerder.'),
      provider_disabled: t('New connections to this service are switched off by an administrator.', 'أوقف المسؤول الربط الجديد مع هذه الخدمة.', 'Nieuwe koppelingen met deze dienst zijn door een beheerder uitgezet.') }[problem] ?? t('The connection did not complete.', 'لم يكتمل الربط.', 'De koppeling is niet voltooid.'), 'error')
    queueMicrotask(() => { setNotices(said); if (connected) setJustProvider(connected) })
    setParams({}, { replace: true })
  }, [params, setParams, t])
  // The account that was just connected is the newest one of that provider: mark its row once, bring it into view if it is off-screen, and clear the mark.
  useEffect(() => {
    if (!justProvider || !data) return
    const ids = [...data.providers, ...data.categories.flatMap(c => c.providers)].filter(p => p.provider === justProvider).flatMap(p => p.accounts.map(a => a.id))
    if (!ids.length) return
    queueMicrotask(() => { setJustId(Math.max(...ids)); setJustProvider(null) })
  }, [justProvider, data])
  useEffect(() => {
    if (justId === null) return
    const row = hubRef.current?.querySelector<HTMLElement>(`[data-account="${justId}"]`), box = row?.getBoundingClientRect()
    if (row && box && (box.top < 0 || box.bottom > window.innerHeight)) row.scrollIntoView?.({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    const id = setTimeout(() => setJustId(null), prefersReducedMotion() ? 2500 : 2200)
    return () => clearTimeout(id)
  }, [justId])
  useEffect(() => { if (!settled) return; const id = setTimeout(() => setSettled(null), 700); return () => clearTimeout(id) }, [settled])
  // The destructive button is clickable from the first frame; it only starts outlined and fills once the person has had a moment to read.
  useEffect(() => { if (!disconnecting) return; const id = setTimeout(() => setArmedFor(disconnecting.id), 400); return () => clearTimeout(id) }, [disconnecting])
  const rows = data && !data.providers.every(p => p.accounts.length === 0) ? data.categories.reduce((n, c) => n + c.providers.length, 0) : 0
  if (data && rise === null) setRise(rows >= 3)   // decided once, from the first data: later reloads never replay the entrance
  useEffect(() => { if (!rise) return; const id = setTimeout(() => setRise(false), 1200); return () => clearTimeout(id) }, [rise])
  const order = new Map<string, number>((data?.categories.flatMap(c => c.providers) ?? []).map((p, i) => [p.provider, i]))
  const closeDisconnect = () => { setDisconnecting(null); setArmedFor(null) }
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
    let ok = false
    try {
      const r = await api<{ imported: number; run: SyncRunInfo | null }>(`/api/integrations/accounts/${account.id}/sync`, 'POST')
      const run = r.run
      ok = !run || run.status === 'success' || run.status === 'partial'
      toast(run ? t(`Synced: ${run.upserted} updated, ${run.removed} removed${run.moved ? `, ${run.moved} moved` : ''}${run.status === 'partial' ? ' — some calendars could not be read' : ''}.`, `تمت المزامنة: ${run.upserted} محدّث، ${run.removed} محذوف${run.moved ? `، ${run.moved} منقول` : ''}${run.status === 'partial' ? ' — تعذّرت قراءة بعض التقويمات' : ''}.`, `Gesynchroniseerd: ${run.upserted} bijgewerkt, ${run.removed} verwijderd${run.moved ? `, ${run.moved} verplaatst` : ''}${run.status === 'partial' ? ' — sommige agenda’s konden niet worden gelezen' : ''}.`) : t('Synced.', 'تمت المزامنة.', 'Gesynchroniseerd.'), run?.status === 'partial' ? 'error' : undefined)
    } catch (e) { setFailure((e as Error).message) } finally { setBusy(null); setSettled({ id: account.id, ok }); reload() }
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
  const stateLine = useStateLine(), presetLabel = usePresetLabel()
  const providerList = data ? [...new Map([...data.providers, ...data.categories.flatMap(c => c.providers)].map(p => [p.provider, p])).values()] : []
  const detail = info?.kind === 'account' ? providerList.flatMap(p => p.accounts.map(a => ({ a, p }))).find(x => x.a.id === info.id) : undefined
  const aboutProvider = info?.kind === 'provider' ? providerList.find(p => p.provider === info.provider) : undefined
  const pillText = (status: HubProvider['status']) => ({ available: t('Available', 'متاح', 'Beschikbaar'), needs_configuration: t('Setup needed', 'يتطلب إعداداً', 'Instellen nodig'), planned: t('Soon', 'قريباً', 'Binnenkort'), disabled: t('Off', 'متوقف', 'Uit') }[status])
  const none = !!data && data.providers.every(p => p.accounts.length === 0)

  const tileOf = (provider: HubProvider, health?: 'ok' | 'warn' | 'bad' | 'idle') => <ProviderTile id={provider.provider} label={provider.label} icon={ICONS[provider.category] ?? Sparkles} health={health} muted={provider.status !== 'available'} />
  const accountRow = (account: ConnectedAccount, provider: HubProvider) => {
    const syncing = busy === `sync-${account.id}`, line = stateLine(account, syncing), st = line.state, broken = isBroken(st), feed = provider.connect_mode === 'url'
    const who = account.email ?? account.display_name ?? provider.label
    return <div key={account.id} className={`am-wrap${leaving === account.id ? ' is-leaving' : ''}`}><div className="am-clip"><div className={`account-mini state-${st}${broken ? ' is-broken' : ''}${justId === account.id ? ' just-connected' : ''}`} role="group" aria-label={`${provider.label}, ${who}${st !== 'ok' ? `, ${line.chip}` : ''}`} tabIndex={-1} data-attention={st !== 'ok' || undefined} data-account={account.id} data-syncing={syncing || undefined} data-settle={settled?.id === account.id ? (settled.ok ? 'ok' : 'bad') : undefined}>
      {tileOf(provider, line.s)}
      <span className="am-id">
        {account.email ? <><small className="am-prov">{provider.label}</small><span className="account-email" title={account.email}><bdi dir="ltr">{account.email}</bdi></span></> : <span className="account-email" title={who}>{who}</span>}
        <span className={`st${syncing ? ' is-syncing' : ''}`} data-s={line.s}><i className="st-dot" aria-hidden="true" />{line.chip}</span>
        {st === 'error' && <small className="muted am-cause" title={account.last_error ?? undefined}>{line.since}{account.last_error && ` · ${account.last_error}`}</small>}
      </span>
      <span className="scope-chip">{presetLabel(account)}</span>
      {broken
        ? <button type="button" className="primary compact am-act" aria-disabled={busy !== null || undefined} aria-label={`${feed ? t('Use a new link', 'استخدام رابط جديد', 'Een nieuwe link gebruiken') : t('Reconnect', 'إعادة الربط', 'Opnieuw koppelen')} — ${provider.label}, ${who}`} onClick={() => { if (busy !== null) return; if (feed) { setReplacingFeed(true); setInfo({ kind: 'feed' }) } else void connect(provider) }}><Link2 size={15} aria-hidden="true" />{feed ? t('Use a new link', 'استخدام رابط جديد', 'Een nieuwe link gebruiken') : t('Reconnect', 'إعادة الربط', 'Opnieuw koppelen')}</button>
        : <button type="button" className="icon-button am-act" aria-disabled={busy !== null || st === 'waiting' || undefined} aria-busy={syncing} aria-label={`${t('Sync now', 'مزامنة الآن', 'Nu synchroniseren')} — ${provider.label}, ${who}`} title={t('Sync now', 'مزامنة الآن', 'Nu synchroniseren')} onClick={() => { if (busy === null && st !== 'waiting') void syncNow(account) }}><RefreshCw size={17} className={syncing ? 'spin' : ''} aria-hidden="true" /></button>}
      <button type="button" className="icon-button am-chev" aria-label={t(`Details of ${who}`, `تفاصيل ${who}`, `Details van ${who}`)} onClick={() => setInfo({ kind: 'account', id: account.id })}><ChevronRight size={18} aria-hidden="true" className="flip-rtl" /></button>
    </div></div></div>
  }
  const addButton = (provider: HubProvider) => provider.connect_mode === 'url'
    ? <button type="button" className="quiet compact" onClick={() => setInfo({ kind: 'feed' })}><Rss size={15} aria-hidden="true" />{t('Add link', 'إضافة رابط', 'Link toevoegen')}</button>
    : <button type="button" className="quiet compact" disabled={busy !== null} onClick={() => void connect(provider)}>{provider.accounts.length ? <Plus size={15} aria-hidden="true" /> : <Link2 size={15} aria-hidden="true" />}
      {provider.accounts.length ? <>{t('Add account', 'إضافة حساب', 'Account toevoegen')}{' '}<span className="sr-only">{t(`for ${provider.label}`, `لـ ${provider.label}`, `voor ${provider.label}`)}</span></> : <>{t('Connect', 'ربط', 'Koppelen')}{' '}<span className="sr-only">{provider.label}</span></>}</button>
  const providerRow = (provider: HubProvider, index = 0) => {
    const listed = provider.status !== 'available' || provider.accounts.length === 0
    return <li key={provider.provider} className={`integration-card hub-item state-${provider.status}${rise ? ' hub-rise stagger' : ''}`} style={rise ? { '--i': Math.min(index, 8) } as CSSProperties : undefined}>
      {listed && <div className="hub-item-main">
        {tileOf(provider)}
        <span className="hub-item-name"><strong>{provider.label}</strong></span>
        {provider.status !== 'available' && <span className={`pill pill-${provider.status}`}>{pillText(provider.status)}</span>}
        {provider.status !== 'available' && <button type="button" className="icon-button" aria-label={t(`About ${provider.label}`, `عن ${provider.label}`, `Over ${provider.label}`)} onClick={() => setInfo({ kind: 'provider', provider: provider.provider })}><Info size={18} aria-hidden="true" /></button>}
        {provider.status === 'available' && provider.accounts.length === 0 && addButton(provider)}
      </div>}
      {provider.accounts.map(account => accountRow(account, provider))}
      {provider.status === 'available' && provider.accounts.length > 0 && <div className="account-add">{addButton(provider)}</div>}
    </li>
  }
  const accounts = providerList.flatMap(p => p.accounts)
  const attention = accounts.filter(a => accountState(a) !== 'ok').length
  const attentionText = t(attention === 1 ? 'One account needs attention' : `${attention} accounts need attention`, arAttention(attention, new Intl.PluralRules(language).select(attention)), attention === 1 ? 'Eén account heeft aandacht nodig' : `${attention} accounts hebben aandacht nodig`)
  /** Moves focus to the first account that needs attention, scrolling gently unless the person asked for less motion. */
  function reviewFirst() {
    const row = hubRef.current?.querySelector<HTMLElement>('[data-attention]')
    if (!row) return
    row.scrollIntoView?.({ block: 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    row.focus({ preventScroll: true })
  }
  const syncingAcc = accounts.find(a => busy === `sync-${a.id}`), syncingWho = syncingAcc ? `${labelOf(syncingAcc.provider)}, ${syncingAcc.email ?? syncingAcc.display_name ?? ''}` : ''
  const available = providerList.filter(p => p.status === 'available'), unavailable = providerList.filter(p => p.status !== 'available')
  const hero = available.find(p => p.provider === 'google') ?? available.find(p => p.provider === 'outlook') ?? available.find(p => p.connect_mode !== 'url') ?? available[0]
  const startWith = (provider: HubProvider) => provider.connect_mode === 'url' ? setInfo({ kind: 'feed' }) : void connect(provider)
  const loadingSections = ['calendars', 'tasks', 'productivity']

  const consent = data && <div className="hub-row consent-row">
      <Bot size={20} aria-hidden="true" />
      <span className="hub-row-text"><strong id="share-ai-label">{t('Share with external AI', 'مشاركة مع ذكاء خارجي', 'Delen met externe AI')}</strong><small className="muted">{data.ai_connected_data ? t('On', 'مفعّل', 'Aan') : t('Off', 'متوقف', 'Uit')}</small><span id="share-ai-desc" className="sr-only">{t('Share connected data with an external AI provider', 'مشاركة البيانات المرتبطة مع مزود ذكاء اصطناعي خارجي', 'Gekoppelde gegevens delen met een externe AI-provider')}</span></span>
      <label className="switch"><input type="checkbox" role="switch" checked={data.ai_connected_data} disabled={busy !== null} aria-labelledby="share-ai-label" aria-describedby="share-ai-desc" onChange={() => void act('consent', () => api('/api/settings', 'PUT', { ai_connected_data: !data.ai_connected_data }), t('Preference saved.', 'تم حفظ التفضيل.', 'Voorkeur opgeslagen.'))} /><span aria-hidden="true" /></label>
    </div>
  return <div ref={hubRef} className="settings-stack hub hub-compact">
    <header className="hub-head">
      <ShieldCheck size={22} aria-hidden="true" />
      <h2 ref={headingRef} tabIndex={-1} className="display-heading">{t('Connected accounts', 'الحسابات المرتبطة', 'Gekoppelde accounts')}</h2>
      <span className="chip"><Lock size={12} aria-hidden="true" />{t('Read-only by default', 'للقراءة فقط افتراضيًا', 'Standaard alleen lezen')}</span>
      <button type="button" className="icon-button" aria-label={t('About connections', 'عن الربط', 'Over koppelingen')} title={t('About connections', 'عن الربط', 'Over koppelingen')} onClick={() => setInfo({ kind: 'about' })}><Info size={19} aria-hidden="true" /></button>
    </header>
    <p className="sr-only" role="status">{data || error ? (busy?.startsWith('sync-') ? `${t('Syncing…', 'جارٍ المزامنة…', 'Synchroniseren…')} ${syncingWho}` : attention > 0 ? attentionText : '') : t('Loading your connections', 'جارٍ تحميل اتصالاتك', 'Je koppelingen worden geladen')}</p>
    {attention > 0 && <div className="attention-strip" data-s={accounts.some(a => isBroken(accountState(a))) ? 'bad' : 'warn'}>
      <span className="as-icon"><AlertTriangle size={18} aria-hidden="true" /></span>
      <span className="as-text" aria-hidden="true">{attentionText}</span>
      <span className="as-action"><button type="button" className="quiet compact" onClick={reviewFirst}>{t('Review', 'مراجعة', 'Bekijken')}</button></span>
    </div>}
    {notices.map((n, i) => <div key={i} className={`banner compact hub-notice${n.error ? ' is-error' : ''}`} role={n.error ? 'alert' : 'status'}><span>{n.text}</span><button type="button" className="icon-button" aria-label={t('Dismiss message', 'إغلاق الرسالة', 'Bericht sluiten')} onClick={() => setNotices(list => list.filter((_, k) => k !== i))}><X size={16} aria-hidden="true" /></button></div>)}
    <ErrorMessage error={(data ? error : '') || (detail ? '' : failure)} />
    {!data && error && <div className="state-card" data-tone="error" role="alert">
      <span className="sc-icon"><AlertTriangle size={22} aria-hidden="true" /></span>
      <h3 className="sc-title">{t('Your connections could not be loaded', 'تعذّر تحميل اتصالاتك', 'Je koppelingen konden niet worden geladen')}</h3>
      <p className="sc-text">{error}</p>
      <div className="sc-actions"><button type="button" className="primary" onClick={reload}>{t('Retry', 'إعادة المحاولة', 'Opnieuw proberen')}</button></div>
    </div>}
    {!data && !error && <div className="sk-stack" aria-hidden="true">{loadingSections.map(key => <section key={key} className="hub-category">
      <h3 className="t-section hub-cat-title"><span className="hub-icon">{(() => { const Icon = ICONS[key]; return <Icon size={16} aria-hidden="true" /> })()}</span>{categoryLabel[key][0]}</h3>
      <div className="sk-row"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>
    </section>)}</div>}
    {data && none && <div className="state-card">
      <h3 className="sc-title">{t('Your calendars and tasks, on one timeline', 'تقاويمك ومهامك في خط زمني واحد', 'Je agenda’s en taken op één tijdlijn')}</h3>
      <p className="sc-text">{t('LifeOS only reads at first: it never creates, changes or deletes anything in your accounts unless you allow it later.', 'يقرأ LifeOS فقط في البداية: لا ينشئ ولا يغيّر ولا يحذف شيئًا في حساباتك إلا إذا سمحت بذلك لاحقًا.', 'LifeOS leest eerst alleen: het maakt, wijzigt of verwijdert niets in je accounts, tenzij je dat later toestaat.')}</p>
      {hero && <div className="sc-actions">
        <button type="button" className="primary" disabled={busy !== null} onClick={() => startWith(hero)}>{hero.connect_mode === 'url' ? <Rss size={16} aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />}{hero.connect_mode === 'url' ? t('Add link', 'إضافة رابط', 'Link toevoegen') : t(`Connect ${hero.label}`, `ربط ${hero.label}`, `${hero.label} koppelen`)}{hero.connect_mode === 'url' && <span className="sr-only"> {hero.label}</span>}</button>
        {available.filter(p => p !== hero).map(p => <button key={p.provider} type="button" className="quiet compact" disabled={busy !== null} onClick={() => startWith(p)}>{p.connect_mode === 'url' ? <><Rss size={15} aria-hidden="true" />{t('Add link', 'إضافة رابط', 'Link toevoegen')}{' '}<span className="sr-only">{p.label}</span></> : <><span className="sr-only">{t('Connect', 'ربط', 'Koppel')}</span>{' '}{p.label}</>}</button>)}
      </div>}
    </div>}
    {data && none && unavailable.length > 0 && <div className="hub-more">
      <button type="button" className="disclosure" aria-expanded={moreServices} aria-controls="hub-more-list" onClick={() => setMoreServices(v => !v)}><span>{t('More services', 'خدمات أخرى', 'Meer diensten')}</span><ChevronRight size={18} aria-hidden="true" /></button>
      <div id="hub-more-list" className="disclosure-body" hidden={!moreServices}><ul className="hub-list">{unavailable.map(p => providerRow(p))}</ul></div>
    </div>}
    {data && !none && data.categories.filter(c => c.providers.length > 0).map(category => { const Icon = ICONS[category.key] ?? Sparkles; return <section key={category.key} className="hub-category" aria-labelledby={`hub-${category.key}`}>
      <h3 id={`hub-${category.key}`} className="t-section hub-cat-title"><span className="hub-icon"><Icon size={16} aria-hidden="true" /></span>{categoryLabel[category.key]?.[0] ?? category.key}</h3>
      <ul className="hub-list">{category.providers.map(provider => providerRow(provider, order.get(provider.provider)))}</ul>
    </section> })}
    {consent}
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
    {detail && <BottomSheet tall title={detail.p.label} onClose={closeInfo}>
      <ErrorMessage error={failure} />
      <ul className="account-list"><AccountCard account={detail.a} label={detail.p.label} tasks={detail.p.category === 'tasks'} requiredScopes={detail.p.required_scopes ?? []} busy={busy} settled={settled?.id === detail.a.id ? (settled.ok ? 'ok' : 'bad') : undefined}
        onSync={() => void syncNow(detail.a)} onReconnect={() => detail.p.connect_mode === 'url' ? (setReplacingFeed(true), setInfo({ kind: 'feed' })) : void connect(detail.p)} onDisconnect={() => { setDisconnecting(detail.a); setInfo(null) }} onSaved={refresh}
        perms={detail.a.permissions && detail.a.permissions.capabilities.length > 0 ? <ManagePermissions accountId={detail.a.id} label={detail.p.label} state={detail.a.permissions} onChanged={refresh} /> : undefined}
        sync={detail.a.sync ? <SyncSettings accountId={detail.a.id} label={detail.p.label} state={detail.a.sync} onChanged={refresh} /> : undefined}
        write={detail.a.write ? <WriteAccess accountId={detail.a.id} label={detail.p.label} write={detail.a.write} orphans={(writes.data?.links ?? []).filter(l => l.orphan && l.account_id === detail.a.id)} onChanged={refresh} /> : undefined} /></ul>
    </BottomSheet>}
    {disconnecting && <Dialog title={t(`Disconnect ${labelOf(disconnecting.provider)}?`, `فصل ${labelOf(disconnecting.provider)}؟`, `${labelOf(disconnecting.provider)} loskoppelen?`)} onClose={closeDisconnect}>
      {(disconnecting.email ?? disconnecting.display_name) && <p id="disconnect-account" className="hub-account-line"><bdi dir="ltr">{disconnecting.email ?? disconnecting.display_name}</bdi></p>}
      <p id="disconnect-warning" className="muted">{t('Imported events and tasks will be removed from LifeOS; tasks you copied into LifeOS stay. Nothing changes in the connected app.', 'ستُحذف المواعيد والمهام المستوردة من LifeOS؛ وتبقى المهام التي نسختها إلى LifeOS. لن يتغير شيء في التطبيق المرتبط.', 'Geïmporteerde afspraken en taken worden uit LifeOS verwijderd; taken die je naar LifeOS kopieerde blijven. Er verandert niets in de gekoppelde app.')}</p>
      {(disconnecting.write?.copies ?? 0) > 0 && <p id="disconnect-copies" className="banner compact">{t(`${disconnecting.write?.copies} event(s) LifeOS added stay in ${labelOf(disconnecting.provider)}. Remove them first if you don’t want them.`, `تبقى ${disconnecting.write?.copies} مواعيد أضافها LifeOS في ${labelOf(disconnecting.provider)}. أزلها أولاً إن لم تكن تريدها.`, `${disconnecting.write?.copies} afspraak/afspraken die LifeOS toevoegde, blijven in ${labelOf(disconnecting.provider)}. Verwijder ze eerst als je ze niet wilt.`)}</p>}
      <div className="toolbar"><button className="quiet" data-autofocus aria-describedby={`${disconnecting.email ?? disconnecting.display_name ? 'disconnect-account ' : ''}disconnect-warning${(disconnecting.write?.copies ?? 0) > 0 ? ' disconnect-copies' : ''}`} onClick={closeDisconnect}>{t('Cancel', 'إلغاء', 'Annuleren')}</button><button className="danger danger-armed" data-armed={armedFor === disconnecting.id || undefined} disabled={busy !== null} onClick={() => { const a = disconnecting; closeDisconnect(); void act(`del-${a.id}`, async () => { await api(`/api/integrations/accounts/${a.id}`, 'DELETE'); if (!prefersReducedMotion()) { setLeaving(a.id); await new Promise(r => setTimeout(r, 260)) } }, t('Disconnected.', 'تم الفصل.', 'Losgekoppeld.'), () => headingRef.current?.focus()) }}>{t('Disconnect', 'فصل', 'Loskoppelen')}</button></div>
    </Dialog>}
  </div>
}
