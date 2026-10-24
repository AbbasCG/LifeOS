import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { CalendarDays, RefreshCw, Unplug, Link2, ShieldCheck, AlertTriangle, CheckCircle2, Lock, Server, ListChecks, NotebookPen, Mail, Sparkles, Clock3, Bot } from 'lucide-react'
import { api } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { Dialog, ErrorMessage, Skeleton } from '../../components/ui/Shared'

export type Collection = { id: string; name: string; color: string | null; primary: boolean; included: boolean }
export type ConnectedAccount = { id: number; provider: string; email: string | null; display_name: string | null; status: 'active' | 'error' | 'revoked'; last_synced_at: string | null; last_error: string | null; events_count: number; connected_at: string | null; collections: Collection[]; collections_managed: boolean }
export type HubProvider = { provider: string; label: string; category: string; implemented: boolean; configured: boolean; status: 'available' | 'needs_configuration' | 'planned'; scopes: string; env_keys?: string[]; redirect_uri?: string; note?: { en: string; ar: string }; accounts: ConnectedAccount[] }
type Hub = { providers: HubProvider[]; categories: { key: string; providers: HubProvider[] }[]; ai_connected_data: boolean }

const ICONS: Record<string, typeof CalendarDays> = { calendars: CalendarDays, tasks: ListChecks, productivity: NotebookPen, email: Mail, future: Sparkles }

/** Picks which calendars or task lists of one account LifeOS imports. Nothing is imported from unchecked ones. */
function CollectionPicker({ account, tasks, onSaved }: { account: ConnectedAccount; tasks: boolean; onSaved: () => void }) {
  const t = useText(), toast = useToast()
  const [chosen, setChosen] = useState(() => account.collections.filter(c => c.included).map(c => c.id)), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const dirty = chosen.slice().sort().join('|') !== account.collections.filter(c => c.included).map(c => c.id).sort().join('|')
  if (!account.collections.length) return null
  async function save() {
    setBusy(true); setError('')
    try { await api(`/api/integrations/accounts/${account.id}`, 'PATCH', { included: chosen }); toast(tasks ? t('Lists updated and synced.', 'تم تحديث القوائم ومزامنتها.') : t('Calendars updated and synced.', 'تم تحديث التقويمات ومزامنتها.')); onSaved() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <fieldset className="collection-picker">
    <legend>{tasks ? t('Lists to import', 'القوائم المستوردة') : t('Calendars to include', 'التقويمات المضمّنة')}</legend>
    {account.collections.map(c => <label key={c.id} className="inline">
      <input type="checkbox" checked={chosen.includes(c.id)} onChange={() => setChosen(list => list.includes(c.id) ? list.filter(x => x !== c.id) : [...list, c.id])} />
      <i className="swatch" style={{ background: c.color ?? 'var(--color-primary)' }} aria-hidden="true" /><span>{c.name}</span>{c.primary && <small className="muted">{t('primary', 'رئيسي')}</small>}
    </label>)}
    <ErrorMessage error={error} />
    {dirty && <button className="primary" disabled={busy} onClick={() => void save()}>{busy ? t('Saving…', 'جارٍ الحفظ…') : t('Save and sync', 'حفظ ومزامنة')}</button>}
  </fieldset>
}

export default function IntegrationsSettings() {
  const t = useText(), { language } = useLanguage(), toast = useToast(), ar = language === 'ar'
  const [params, setParams] = useSearchParams()
  const { data, error, reload } = useApi<Hub>('/api/integrations')
  const [busy, setBusy] = useState<string | null>(null), [failure, setFailure] = useState(''), [disconnecting, setDisconnecting] = useState<ConnectedAccount | null>(null)
  const labelOf = (provider: string) => data?.providers.find(p => p.provider === provider)?.label ?? provider
  useEffect(() => {
    const connected = params.get('connected'), problem = params.get('error')
    if (!connected && !problem) return
    if (connected) toast(t(`${connected} connected. Only the primary calendar or list is included — choose more below.`, `تم الربط. يُضمَّن التقويم أو القائمة الرئيسية فقط — اختر المزيد أدناه.`))
    if (problem) toast({ state: t('The sign-in link expired or was already used. Please try again.', 'انتهت صلاحية رابط تسجيل الدخول أو استُخدم. حاول مجدداً.'), denied: t('Access was not granted, so nothing was connected.', 'لم يُمنح الوصول، لذلك لم يتم الربط.'), exchange: t('The provider could not complete the connection. Please try again.', 'تعذر على المزوّد إكمال الربط. حاول مجدداً.') }[problem] ?? t('The connection did not complete.', 'لم يكتمل الربط.'), 'error')
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
  const ago = (iso: string | null) => iso ? new Date(iso).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' }) : t('Never', 'أبداً')
  const statusLabel = (s: ConnectedAccount['status']) => ({ active: t('Syncing', 'متزامن'), error: t('Sync problem', 'مشكلة مزامنة'), revoked: t('Access revoked', 'أُلغي الوصول') }[s])
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
            <ul className="account-list">{provider.accounts.map(account => <li key={account.id} className={`status-${account.status}`}>
              <div className="row"><strong dir="ltr">{account.email ?? account.display_name ?? provider.label}</strong><span className={`badge ${account.status === 'active' ? 'status-accepted' : account.status === 'error' ? 'status-pending' : 'status-rejected'}`}>{account.status === 'active' ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />} {statusLabel(account.status)}</span></div>
              <small className="muted">{category.key === 'tasks' ? t(`Last synced ${ago(account.last_synced_at)} · ${account.events_count} open tasks`, `آخر مزامنة ${ago(account.last_synced_at)} · ${account.events_count} مهام مفتوحة`) : t(`Last synced ${ago(account.last_synced_at)} · ${account.events_count} upcoming commitments`, `آخر مزامنة ${ago(account.last_synced_at)} · ${account.events_count} التزامات قادمة`)}</small>
              {account.last_error && account.status !== 'active' && <p className="error compact">{account.last_error}</p>}
              {account.status !== 'revoked' && <CollectionPicker key={account.collections.map(c => `${c.id}:${c.included}`).join(',')} account={account} tasks={category.key === 'tasks'} onSaved={reload} />}
              <div className="toolbar">
                {account.status === 'revoked' ? <button className="primary" disabled={busy !== null} onClick={() => void connect(provider)}><Link2 size={15} />{t('Reconnect', 'إعادة الربط')}</button> : <button className="quiet" disabled={busy !== null} onClick={() => void act(`sync-${account.id}`, () => api(`/api/integrations/accounts/${account.id}/sync`, 'POST'), t('Synced.', 'تمت المزامنة.'))}><RefreshCw size={15} className={busy === `sync-${account.id}` ? 'spin' : ''} />{t('Sync now', 'مزامنة الآن')}</button>}
                <button className="quiet" disabled={busy !== null} onClick={() => setDisconnecting(account)}><Unplug size={15} />{t('Disconnect', 'فصل')}</button>
              </div>
            </li>)}</ul>
            <button className="primary" disabled={busy !== null} aria-label={provider.accounts.length ? t(`Connect another ${provider.label} account`, `ربط حساب ${provider.label} آخر`) : undefined} onClick={() => void connect(provider)}><Link2 size={16} />{busy === provider.provider ? t('Opening…', 'جارٍ الفتح…') : provider.accounts.length ? t('Connect another account', 'ربط حساب آخر') : t(`Connect ${provider.label}`, `ربط ${provider.label}`)}</button>
          </>}
      </section>)}</div>
    </section> })}
    {disconnecting && <Dialog title={t(`Disconnect ${labelOf(disconnecting.provider)}?`, `فصل ${labelOf(disconnecting.provider)}؟`)} onClose={() => setDisconnecting(null)}>
      <p className="muted">{t('Imported events and tasks will be removed from LifeOS; tasks you copied into LifeOS stay. Nothing changes in the connected app.', 'ستُحذف المواعيد والمهام المستوردة من LifeOS؛ وتبقى المهام التي نسختها إلى LifeOS. لن يتغير شيء في التطبيق المرتبط.')}</p>
      <div className="toolbar"><button className="quiet" onClick={() => setDisconnecting(null)}>{t('Cancel', 'إلغاء')}</button><button className="danger" disabled={busy !== null} onClick={() => { const a = disconnecting; setDisconnecting(null); void act(`del-${a.id}`, () => api(`/api/integrations/accounts/${a.id}`, 'DELETE'), t('Disconnected.', 'تم الفصل.')) }}>{t('Disconnect', 'فصل')}</button></div>
    </Dialog>}
  </div>
}
