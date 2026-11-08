import { useState, type FormEvent } from 'react'
import { Check, Copy, KeyRound, ShieldAlert, X } from 'lucide-react'
import { Dialog, ErrorMessage, Skeleton } from '../../components/ui/Shared'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { useSensitiveAction } from '../../lib/sensitive'
import { formatDay } from '../../lib/dateTime'
import { configAuditPath, credentialsPath, removeCredentials, saveCredentials, setProviderEnabled, testProvider, type CheckId, type ConfigAudit, type ProviderConfig, type TestResult } from '../../lib/integrationsAdmin'
import '../../styles/provider-config.css'

/**
 * Administrators only. The OAuth client (client id and secret) LifeOS uses with Google, Microsoft or Todoist is entered here once instead of in the server's .env.
 * The secret is write-only: it is sent to the server when saved, kept encrypted there and never shown again, and this component clears it from memory as soon as it was sent.
 * Creating the OAuth app with the provider is still a one-time step done on the provider's own site; this screen only receives its result.
 */
export default function ProviderConfiguration() {
  const auth = useAuth()
  return auth.user?.is_admin ? <Panel /> : null
}

function Panel() {
  const t = useText(), toast = useToast(), sensitive = useSensitiveAction()
  const { language } = useLanguage()
  const { data, error, loading, reload } = useApi<{ data: ProviderConfig[] }>(credentialsPath)
  const [editing, setEditing] = useState<ProviderConfig | null>(null), [removing, setRemoving] = useState<ProviderConfig | null>(null)
  const [busy, setBusy] = useState<string | null>(null), [tests, setTests] = useState<Record<string, TestResult>>({}), [showAudit, setShowAudit] = useState(false)
  const name = (p: ProviderConfig) => language === 'ar' ? p.name.ar : p.name.en

  async function toggle(p: ProviderConfig) {
    setBusy(p.provider)
    try {
      await sensitive(() => setProviderEnabled(p.provider, !p.connections_allowed))
      toast(p.connections_allowed ? t(`New ${name(p)} connections are switched off. Connected accounts keep working.`, `أُوقف الربط الجديد مع ${name(p)}. الحسابات المرتبطة تعمل كما هي.`, `Nieuwe ${name(p)}-koppelingen staan uit. Gekoppelde accounts blijven werken.`) : t(`New ${name(p)} connections are switched on.`, `فُعّل الربط الجديد مع ${name(p)}.`, `Nieuwe ${name(p)}-koppelingen staan aan.`), 'success')
      reload()
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(null) }
  }
  async function test(p: ProviderConfig) {
    setBusy(p.provider)
    try { const result = await sensitive(() => testProvider(p.provider)); setTests(old => ({ ...old, [p.provider]: result })) } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(null) }
  }
  async function remove(p: ProviderConfig) {
    setBusy(p.provider)
    try { await sensitive(() => removeCredentials(p.provider)); toast(t('The saved client was removed.', 'أُزيل العميل المحفوظ.', 'De opgeslagen client is verwijderd.'), 'success'); setRemoving(null); setTests(old => Object.fromEntries(Object.entries(old).filter(([key]) => key !== p.provider))); reload() } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(null) }
  }

  const sourceText = (p: ProviderConfig) => p.source === 'database' ? t('Saved in LifeOS (encrypted)', 'محفوظ في LifeOS (مشفّر)', 'Opgeslagen in LifeOS (versleuteld)')
    : p.source === 'environment' ? t('From the server’s .env (compatibility)', 'من ملف .env على الخادم (توافق)', 'Uit de .env van de server (compatibiliteit)') : t('Not set', 'غير مُعدّ', 'Niet ingesteld')
  const statusOf = (p: ProviderConfig): [string, string] => p.secret_unreadable ? ['warn', t('Secret must be entered again', 'يجب إدخال السر من جديد', 'Geheim opnieuw invoeren')]
    : !p.configured ? ['warn', t('Needs setup', 'يتطلب إعدادًا', 'Instellen nodig')] : !p.connections_allowed ? ['off', t('New connections off', 'الربط الجديد متوقف', 'Nieuwe koppelingen uit')] : ['ok', t('Ready', 'جاهز', 'Klaar')]
  const when = (iso: string | null) => iso ? formatDay(iso, language, { day: 'numeric', month: 'long', year: 'numeric' }) : ''

  return <section className="panel pc-panel" aria-labelledby="pc-title" data-tour="integrations-admin-credentials">
    <h2 id="pc-title"><KeyRound size={18} aria-hidden="true" /> {t('Provider configuration', 'إعداد المزودين', 'Providerconfiguratie')}</h2>
    <p className="muted small">{t('Administrators only. Enter the OAuth client of each provider once here instead of editing the server’s .env. You still create that OAuth app on the provider’s own site one time; the secret is stored encrypted and is never shown again.', 'للمسؤولين فقط. أدخل عميل OAuth لكل مزود مرة واحدة هنا بدل تعديل .env على الخادم. ما زال إنشاء تطبيق OAuth لدى المزود نفسه مطلوبًا مرة واحدة؛ والسر يُخزَّن مشفّرًا ولا يُعرض بعد ذلك.', 'Alleen voor beheerders. Voer de OAuth-client van elke provider hier eenmalig in in plaats van de .env van de server te bewerken. De OAuth-app maak je nog steeds eenmalig aan op de site van de provider zelf; het geheim wordt versleuteld opgeslagen en nooit meer getoond.')}</p>
    <ErrorMessage error={error} />
    {loading ? <Skeleton lines={3} /> : data && <ul className="pc-list">
      {data.data.map(p => {
        const [tone, label] = statusOf(p), result = tests[p.provider]
        return <li key={p.provider} className="pc-item">
          <div className="pc-head"><strong>{name(p)}</strong><span className={`pc-chip ${tone}`}>{label}</span></div>
          <p className="muted small">{sourceText(p)}{p.updated_at && ` · ${t('Last changed', 'آخر تعديل', 'Laatst gewijzigd')} ${when(p.updated_at)}${p.updated_by ? ` ${t('by', 'بواسطة', 'door')} ${p.updated_by}` : ''}`}</p>
          {p.secret_unreadable && <p className="error" role="alert">{t('The saved secret can no longer be read (the server’s encryption key changed). Enter the secret again.', 'لم يعد ممكنًا قراءة السر المحفوظ (تغيّر مفتاح التشفير على الخادم). أدخل السر من جديد.', 'Het opgeslagen geheim is niet meer te lezen (de versleutelingssleutel van de server veranderde). Voer het geheim opnieuw in.')}</p>}
          <div className="pc-actions">
            <button type="button" className="primary compact" onClick={() => setEditing(p)}>{p.source === 'database' ? t('Edit', 'تعديل', 'Bewerken') : t('Set up', 'إعداد', 'Instellen')}<span className="sr-only"> {name(p)}</span></button>
            <button type="button" className="quiet" disabled={busy === p.provider || !p.configured} onClick={() => void test(p)}>{t('Test configuration', 'اختبار الإعداد', 'Configuratie testen')}<span className="sr-only"> {name(p)}</span></button>
            <button type="button" className="quiet" disabled={busy === p.provider} aria-pressed={!p.connections_allowed} onClick={() => void toggle(p)}>{p.connections_allowed ? t('Switch off new connections', 'إيقاف الربط الجديد', 'Nieuwe koppelingen uitzetten') : t('Switch on new connections', 'تفعيل الربط الجديد', 'Nieuwe koppelingen aanzetten')}<span className="sr-only"> {name(p)}</span></button>
            {p.source === 'database' && <button type="button" className="quiet danger-text" disabled={busy === p.provider} onClick={() => setRemoving(p)}>{t('Remove saved client', 'إزالة العميل المحفوظ', 'Opgeslagen client verwijderen')}<span className="sr-only"> {name(p)}</span></button>}
          </div>
          {result && <TestChecks result={result} />}
        </li>
      })}
    </ul>}
    <button type="button" className="quiet pc-audit-toggle" aria-expanded={showAudit} onClick={() => setShowAudit(v => !v)}>{showAudit ? t('Hide the change log', 'إخفاء سجل التغييرات', 'Wijzigingslog verbergen') : t('Show the change log', 'عرض سجل التغييرات', 'Wijzigingslog tonen')}</button>
    {showAudit && <AuditList />}
    {editing && <EditDialog provider={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload() }} />}
    {removing && <Dialog title={t(`Remove the saved ${name(removing)} client?`, `إزالة عميل ${name(removing)} المحفوظ؟`, `De opgeslagen ${name(removing)}-client verwijderen?`)} onClose={() => setRemoving(null)}>
      <p>{t('The client id and secret saved in LifeOS are deleted. If the server’s .env has values for this provider, those are used again. Accounts that are already connected keep their sign-in until it needs a new token.', 'يُحذف معرّف العميل والسر المحفوظان في LifeOS. إن كان في .env على الخادم قيم لهذا المزود فستُستخدم من جديد. الحسابات المرتبطة تبقى متصلة حتى تحتاج رمزًا جديدًا.', 'De client-id en het geheim in LifeOS worden verwijderd. Staan er waarden in de .env van de server, dan worden die weer gebruikt. Gekoppelde accounts blijven werken tot ze een nieuw token nodig hebben.')}</p>
      <div className="rel-actions">
        <button type="button" className="danger" disabled={busy === removing.provider} onClick={() => void remove(removing)}>{t('Remove', 'إزالة', 'Verwijderen')}</button>
        <button type="button" className="quiet" onClick={() => setRemoving(null)}>{t('Cancel', 'إلغاء', 'Annuleren')}</button>
      </div>
    </Dialog>}
  </section>
}

function TestChecks({ result }: { result: TestResult }) {
  const t = useText()
  const labels: Record<CheckId, string> = {
    client_id: t('A client id is set', 'معرّف العميل مُعيَّن', 'Er is een client-id'),
    secret_readable: t('The secret is saved and can be read', 'السر محفوظ ويمكن قراءته', 'Het geheim is opgeslagen en leesbaar'),
    redirect_matches: t('The redirect address is the one this site expects', 'عنوان إعادة التوجيه هو ما يتوقعه هذا الموقع', 'Het omleidingsadres is het adres dat deze site verwacht'),
    sign_in_address: t('A valid sign-in address can be built', 'يمكن بناء عنوان تسجيل دخول صالح', 'Er kan een geldig inlogadres worden gemaakt'),
    connections_allowed: t('New connections are switched on', 'الربط الجديد مفعّل', 'Nieuwe koppelingen staan aan'),
  }
  return <div className="pc-test" role="status">
    <strong>{result.ok ? t('The configuration looks right.', 'الإعداد يبدو سليمًا.', 'De configuratie ziet er goed uit.') : t('Something needs attention.', 'يحتاج أمر إلى انتباه.', 'Er is iets dat aandacht nodig heeft.')}</strong>
    <ul>{result.checks.map(c => <li key={c.id}>{c.ok ? <Check size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}<span className="sr-only">{c.ok ? t('OK:', 'سليم:', 'In orde:') : t('Fix:', 'يلزم إصلاح:', 'Aanpassen:')} </span>{labels[c.id]}</li>)}</ul>
    <p className="muted small">{t('This does not contact the provider. Only a real sign-in proves that the provider accepts the client.', 'هذا لا يتصل بالمزود. وحده تسجيل دخول فعلي يثبت أن المزود يقبل العميل.', 'Dit neemt geen contact op met de provider. Alleen een echte aanmelding bewijst dat de provider de client accepteert.')}</p>
  </div>
}

function EditDialog({ provider: p, onClose, onSaved }: { provider: ProviderConfig; onClose: () => void; onSaved: () => void }) {
  const t = useText(), toast = useToast(), sensitive = useSensitiveAction(), { language } = useLanguage()
  const [clientId, setClientId] = useState(p.client_id ?? ''), [secret, setSecret] = useState(''), [busy, setBusy] = useState(false), [problem, setProblem] = useState(''), [copied, setCopied] = useState(false)
  const name = language === 'ar' ? p.name.ar : p.name.en
  // The redirect address is generated from the site's own trusted address and is not typed by hand; the server accepts nothing else.
  const redirect = p.suggested_redirect_uri
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setProblem('')
    const sent = secret
    setSecret('')   // gone from the page as soon as it is on its way
    try {
      await sensitive(() => saveCredentials(p.provider, { client_id: clientId.trim(), ...(sent.trim() ? { client_secret: sent.trim() } : {}), redirect_uri: redirect }))
      toast(t('Saved. The secret is stored encrypted and will not be shown again.', 'تم الحفظ. السر مخزَّن مشفّرًا ولن يُعرض مجددًا.', 'Opgeslagen. Het geheim is versleuteld bewaard en wordt niet meer getoond.'), 'success')
      onSaved()
    } catch (err) { setProblem((err as Error).message) } finally { setBusy(false) }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(redirect); setCopied(true) } catch { /* the address is on screen and can be selected by hand */ }
  }
  const needsSecret = !p.has_secret || p.secret_unreadable
  return <Dialog title={t(`${name} sign-in client`, `عميل تسجيل الدخول لـ ${name}`, `${name}-inlogclient`)} onClose={() => !busy && onClose()}>
    <form className="pc-form" onSubmit={e => void submit(e)}>
      <ol className="pc-steps small">
        <li>{t('At the provider, create an OAuth app (once).', 'أنشئ تطبيق OAuth لدى المزود (مرة واحدة).', 'Maak bij de provider eenmalig een OAuth-app aan.')} {p.docs_url && <a href={p.docs_url} target="_blank" rel="noreferrer noopener">{t('Provider documentation', 'وثائق المزود', 'Documentatie van de provider')}</a>}</li>
        <li>{t('Register this redirect address there exactly as shown:', 'سجّل عنوان إعادة التوجيه هذا هناك كما هو بالضبط:', 'Registreer daar dit omleidingsadres precies zoals getoond:')}</li>
      </ol>
      <div className="pc-redirect"><code dir="ltr">{redirect}</code><button type="button" className="quiet" onClick={() => void copy()}><Copy size={14} aria-hidden="true" />{copied ? t('Copied', 'نُسخ', 'Gekopieerd') : t('Copy', 'نسخ', 'Kopiëren')}</button></div>
      <p className="muted small">{t('Permissions LifeOS asks for:', 'الأذونات التي يطلبها LifeOS:', 'Rechten die LifeOS vraagt:')} <span dir="ltr">{p.scopes.map(s => `${s.id}${s.required ? '' : ' (optional)'}`).join(', ')}</span></p>
      <label><span>{t('Client ID', 'معرّف العميل', 'Client-id')}</span><input value={clientId} onChange={e => setClientId(e.target.value)} required minLength={3} maxLength={255} autoComplete="off" dir="ltr" spellCheck={false} data-autofocus /></label>
      <label><span>{t('Client secret', 'سر العميل', 'Clientgeheim')}</span>
        <input type="password" value={secret} onChange={e => setSecret(e.target.value)} required={needsSecret} maxLength={2000} autoComplete="new-password" dir="ltr" spellCheck={false}
          placeholder={p.has_secret && !p.secret_unreadable ? t('Saved. Leave empty to keep it.', 'محفوظ. اتركه فارغًا للإبقاء عليه.', 'Opgeslagen. Laat leeg om te behouden.') : ''} aria-describedby="pc-secret-help" />
      </label>
      <p id="pc-secret-help" className="muted small">{p.has_secret && !p.secret_unreadable
        ? t('To rotate the secret: create the new one at the provider first, paste it here, save and test, then delete the old one at the provider. Connected accounts keep working.', 'لتدوير السر: أنشئ السر الجديد لدى المزود أولًا، والصقه هنا، احفظ ثم اختبر، ثم احذف القديم لدى المزود. الحسابات المرتبطة تبقى تعمل.', 'Geheim vernieuwen: maak eerst het nieuwe geheim bij de provider, plak het hier, sla op en test, en verwijder daarna het oude bij de provider. Gekoppelde accounts blijven werken.')
        : t('The secret is stored encrypted and never shown again.', 'يُخزَّن السر مشفّرًا ولا يُعرض مجددًا.', 'Het geheim wordt versleuteld opgeslagen en nooit meer getoond.')}</p>
      <ErrorMessage error={problem} />
      <div className="rel-actions">
        <button type="submit" className="primary" disabled={busy}>{t('Save', 'حفظ', 'Opslaan')}</button>
        <button type="button" className="quiet" disabled={busy} onClick={onClose}>{t('Cancel', 'إلغاء', 'Annuleren')}</button>
      </div>
      <p className="muted small"><ShieldAlert size={13} aria-hidden="true" /> {t('You may be asked for your password.', 'قد يُطلب منك إدخال كلمة المرور.', 'Je wordt mogelijk om je wachtwoord gevraagd.')}</p>
    </form>
  </Dialog>
}

function AuditList() {
  const t = useText(), { language } = useLanguage()
  const { data, error, loading } = useApi<{ data: ConfigAudit[] }>(configAuditPath)
  const words: Record<string, string> = {
    integration_credentials_set: t('Saved the client', 'حفظ العميل', 'Client opgeslagen'), integration_credentials_removed: t('Removed the client', 'أزال العميل', 'Client verwijderd'),
    integration_provider_enabled: t('Switched new connections on', 'فعّل الربط الجديد', 'Nieuwe koppelingen aangezet'), integration_provider_disabled: t('Switched new connections off', 'أوقف الربط الجديد', 'Nieuwe koppelingen uitgezet'),
    integration_config_tested: t('Tested the configuration', 'اختبر الإعداد', 'Configuratie getest'),
  }
  if (loading) return <Skeleton lines={2} />
  return <div className="pc-audit"><ErrorMessage error={error} />
    {data?.data.length === 0 ? <p className="muted small">{t('No changes yet.', 'لا تغييرات بعد.', 'Nog geen wijzigingen.')}</p>
      : <ul>{data?.data.map(a => <li key={a.id}><span>{words[a.action] ?? a.action}</span> <span className="muted small">{a.provider} · {a.actor ?? '—'} · {a.at ? formatDay(a.at, language, { day: 'numeric', month: 'short', year: 'numeric' }) : ''}
        {a.secret_changed ? ` · ${t('secret changed', 'السر تغيّر', 'geheim gewijzigd')}` : ''}</span></li>)}</ul>}
  </div>
}
