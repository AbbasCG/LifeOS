import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { AlertTriangle, CalendarDays, Check, ChevronRight, Copy, KeyRound, ListChecks, ShieldAlert, X, type LucideIcon } from 'lucide-react'
import { Dialog, ErrorMessage, Skeleton } from '../../components/ui/Shared'
import { ProviderTile } from '../../components/ui/ProviderTile'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { useSensitiveAction } from '../../lib/sensitive'
import { formatDay } from '../../lib/dateTime'
import { relativeTime } from '../../lib/relativeTime'
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
  const [removeError, setRemoveError] = useState(''), [busy, setBusy] = useState<string | null>(null), [tests, setTests] = useState<Record<string, TestResult>>({}), [showAudit, setShowAudit] = useState(false), [open, setOpen] = useState<Record<string, boolean>>({})
  // After an action the focused control may be disabled or gone: give focus back to a sensible control instead of letting it fall to the page.
  const pending = useRef<string | null>(null)
  useEffect(() => { if (busy === null && pending.current) { const el = document.querySelector<HTMLElement>(pending.current); pending.current = null; el?.focus() } })
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
    setBusy(p.provider); setRemoveError('')
    try { await sensitive(() => removeCredentials(p.provider)); pending.current = `[data-pc-primary="${p.provider}"]`; toast(t('The saved client was removed.', 'أُزيل العميل المحفوظ.', 'De opgeslagen client is verwijderd.'), 'success'); setRemoving(null); setTests(old => Object.fromEntries(Object.entries(old).filter(([key]) => key !== p.provider))); reload() } catch (e) { setRemoveError((e as Error).message) } finally { setBusy(null) }
  }
  const closeRemove = () => { setRemoving(null); setRemoveError('') }

  const sourceText = (p: ProviderConfig) => p.source === 'database' ? t('Saved in LifeOS (encrypted)', 'محفوظ في LifeOS (مشفّر)', 'Opgeslagen in LifeOS (versleuteld)')
    : p.source === 'environment' ? t('From the server’s .env (compatibility)', 'من ملف .env على الخادم (توافق)', 'Uit de .env van de server (compatibiliteit)') : t('Not set', 'غير مُعدّ', 'Niet ingesteld')
  // The same words and tones as the Connected Accounts hub. The state is always written; colour only backs it up.
  const statusOf = (p: ProviderConfig): [Tone, string] => p.secret_unreadable ? ['bad', t('Secret must be entered again', 'يجب إدخال السر من جديد', 'Geheim opnieuw invoeren')]
    : !p.configured ? ['warn', t('Setup needed', 'يتطلب إعداداً', 'Instellen nodig')] : !p.connections_allowed ? ['idle', t('Off', 'متوقف', 'Uit')] : ['ok', t('Ready', 'جاهز', 'Klaar')]
  const updatedLine = (p: ProviderConfig) => {
    const r = relativeTime(p.updated_at, language)
    if (!r) return ''
    const by = p.updated_by ? ` ${t('by', 'بواسطة', 'door')} ${p.updated_by}` : ''
    return (r.kind === 'date' ? t(`Last changed on ${r.text}`, `آخر تعديل في ${r.text}`, `Laatst gewijzigd op ${r.text}`) : t(`Last changed ${r.text}`, `آخر تعديل ${r.text}`, `Laatst gewijzigd ${r.text}`)) + by
  }

  return <section className="pc-panel" aria-labelledby="pc-title" data-tour="integrations-admin-credentials">
    <h2 id="pc-title" className="t-section pc-title"><KeyRound size={16} aria-hidden="true" /> {t('Provider configuration', 'إعداد المزودين', 'Providerconfiguratie')}</h2>
    <p className="pc-intro">{t('Administrators only. Enter the OAuth client of each provider once here instead of editing the server’s .env. You still create that OAuth app on the provider’s own site one time; the secret is stored encrypted and is never shown again.', 'للمسؤولين فقط. أدخل عميل OAuth لكل مزود مرة واحدة هنا بدل تعديل .env على الخادم. ما زال إنشاء تطبيق OAuth لدى المزود نفسه مطلوبًا مرة واحدة؛ والسر يُخزَّن مشفّرًا ولا يُعرض بعد ذلك.', 'Alleen voor beheerders. Voer de OAuth-client van elke provider hier eenmalig in in plaats van de .env van de server te bewerken. De OAuth-app maak je nog steeds eenmalig aan op de site van de provider zelf; het geheim wordt versleuteld opgeslagen en nooit meer getoond.')}</p>
    <p className="sr-only" role="status">{loading ? t('Loading the provider configuration…', 'جارٍ تحميل إعداد المزودين…', 'Providerconfiguratie laden…') : ''}</p>
    {data && <ErrorMessage error={error} />}
    {!data && error && <div className="state-card" data-tone="error" role="alert">
      <span className="sc-icon"><AlertTriangle size={22} aria-hidden="true" /></span>
      <h3 className="sc-title">{t('The provider configuration could not be loaded', 'تعذّر تحميل إعداد المزودين', 'De providerconfiguratie kon niet worden geladen')}</h3>
      <p className="sc-text">{error}</p>
      <div className="sc-actions"><button type="button" className="primary" onClick={reload}>{t('Retry', 'إعادة المحاولة', 'Opnieuw proberen')}</button></div>
    </div>}
    {!data && !error && <div className="sk-stack" aria-hidden="true">{[0, 1, 2].map(i => <div className="sk-row" key={i}><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>)}</div>}
    {data && data.data.length === 0 && <div className="state-card"><h3 className="sc-title">{t('No providers to configure', 'لا مزودين للإعداد', 'Geen providers om te configureren')}</h3><p className="sc-text">{t('The server did not list any provider yet.', 'لم يُدرج الخادم أي مزود بعد.', 'De server toont nog geen provider.')}</p></div>}
    {data && data.data.length > 0 && <ul className="pc-list">
      {data.data.map(p => {
        const [tone, label] = statusOf(p), result = tests[p.provider], nm = name(p), id = p.provider, wait = busy === id, primary = !p.configured || p.secret_unreadable
        return <li key={id} className={`pc-card${p.configured ? '' : ' is-unset'}`}>
          <div className="pc-head">
            <ProviderTile id={id} label={nm} icon={ICONS[id] ?? KeyRound} muted={!p.configured || !p.connections_allowed} />
            <div className="pc-id"><h3 className="pc-name">{nm}</h3><p className="pc-sub">{sourceText(p)}</p></div>
            <Chip s={tone}>{label}</Chip>
          </div>
          {p.secret_unreadable && <p className="error" role="alert">{t('The saved secret can no longer be read (the server’s encryption key changed). Enter the secret again.', 'لم يعد ممكنًا قراءة السر المحفوظ (تغيّر مفتاح التشفير على الخادم). أدخل السر من جديد.', 'Het opgeslagen geheim is niet meer te lezen (de versleutelingssleutel van de server veranderde). Voer het geheim opnieuw in.')}</p>}
          <Facts p={p} updated={updatedLine(p)} />
          <div className="pc-actions">
            <button type="button" data-pc-primary={id} className={primary ? 'primary' : 'quiet compact'} onClick={() => setEditing(p)}>{p.source === 'database' ? t('Edit', 'تعديل', 'Bewerken') : t('Set up', 'إعداد', 'Instellen')}{' '}<span className="sr-only">{nm}</span></button>
            {p.configured && <button type="button" data-pc-test={id} className="quiet compact" disabled={wait} onClick={() => { pending.current = `[data-pc-test="${id}"]`; void test(p) }}>{t('Test configuration', 'اختبار الإعداد', 'Configuratie testen')}{' '}<span className="sr-only">{nm}</span></button>}
          </div>
          <div className="pc-result" role="status">{result && <TestChecks result={result} />}</div>
          <button type="button" className="disclosure" aria-expanded={!!open[id]} aria-controls={`pc-more-${id}`} onClick={() => setOpen(o => ({ ...o, [id]: !o[id] }))}><span>{t('More', 'المزيد', 'Meer')}{' '}<span className="sr-only">{nm}</span></span><ChevronRight size={18} aria-hidden="true" /></button>
          <div id={`pc-more-${id}`} className="disclosure-body pc-more" hidden={!open[id]}>
            <p className="pc-hint">{p.connections_allowed ? t('Accounts that are already connected keep working when new connections are off.', 'الحسابات المرتبطة تبقى تعمل عند إيقاف الربط الجديد.', 'Gekoppelde accounts blijven werken als nieuwe koppelingen uit staan.') : t('New connections are off for this provider.', 'الربط الجديد متوقف لهذا المزود.', 'Nieuwe koppelingen staan uit voor deze provider.')}</p>
            <button type="button" data-pc-toggle={id} className="quiet compact" disabled={wait} aria-pressed={!p.connections_allowed} onClick={() => { pending.current = `[data-pc-toggle="${id}"]`; void toggle(p) }}>{p.connections_allowed ? t('Switch off new connections', 'إيقاف الربط الجديد', 'Nieuwe koppelingen uitzetten') : t('Switch on new connections', 'تفعيل الربط الجديد', 'Nieuwe koppelingen aanzetten')}{' '}<span className="sr-only">{nm}</span></button>
            {p.source === 'database' && <div className="pc-danger"><button type="button" className="danger-ghost" disabled={wait} onClick={() => { setRemoveError(''); setRemoving(p) }}>{t('Remove saved client', 'إزالة العميل المحفوظ', 'Opgeslagen client verwijderen')}{' '}<span className="sr-only">{nm}</span></button></div>}
          </div>
        </li>
      })}
    </ul>}
    <button type="button" className="disclosure pc-audit-toggle" aria-expanded={showAudit} aria-controls="pc-audit" onClick={() => setShowAudit(v => !v)}><span>{showAudit ? t('Hide the change log', 'إخفاء سجل التغييرات', 'Wijzigingslog verbergen') : t('Show the change log', 'عرض سجل التغييرات', 'Wijzigingslog tonen')}</span><ChevronRight size={18} aria-hidden="true" /></button>
    <div id="pc-audit" className="disclosure-body" hidden={!showAudit}>{showAudit && <AuditList />}</div>
    {editing && <EditDialog provider={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload() }} />}
    {removing && <Dialog title={t(`Remove the saved ${name(removing)} client?`, `إزالة عميل ${name(removing)} المحفوظ؟`, `De opgeslagen ${name(removing)}-client verwijderen?`)} onClose={closeRemove}>
      <p>{t('The client id and secret saved in LifeOS are deleted. If the server’s .env has values for this provider, those are used again. Accounts that are already connected keep their sign-in until it needs a new token.', 'يُحذف معرّف العميل والسر المحفوظان في LifeOS. إن كان في .env على الخادم قيم لهذا المزود فستُستخدم من جديد. الحسابات المرتبطة تبقى متصلة حتى تحتاج رمزًا جديدًا.', 'De client-id en het geheim in LifeOS worden verwijderd. Staan er waarden in de .env van de server, dan worden die weer gebruikt. Gekoppelde accounts blijven werken tot ze een nieuw token nodig hebben.')}</p>
      <ErrorMessage error={removeError} />
      <div className="rel-actions">
        <button type="button" className="danger" disabled={busy === removing.provider} onClick={() => void remove(removing)}>{t('Remove', 'إزالة', 'Verwijderen')}</button>
        <button type="button" className="quiet" onClick={closeRemove}>{t('Cancel', 'إلغاء', 'Annuleren')}</button>
      </div>
    </Dialog>}
  </section>
}

type Tone = 'ok' | 'warn' | 'bad' | 'idle'
const ICONS: Record<string, LucideIcon> = { google: CalendarDays, outlook: CalendarDays, todoist: ListChecks, google_tasks: ListChecks, microsoft_todo: ListChecks }
const Chip = ({ s, children }: { s: Tone; children: ReactNode }) => <span className="st" data-s={s}><span className="st-dot" aria-hidden="true" />{children}</span>

/** The facts an administrator needs from the card: what the redirect address must be, what LifeOS asks for, whether a secret is saved (never its value), the last change and the provider's guide. */
function Facts({ p, updated }: { p: ProviderConfig; updated: string }) {
  const t = useText(), { language } = useLanguage()
  const [copied, setCopied] = useState(false)
  const nm = language === 'ar' ? p.name.ar : p.name.en
  async function copy() {
    try { await navigator.clipboard.writeText(p.suggested_redirect_uri); setCopied(true) } catch { /* the address is on screen and can be selected by hand */ }
  }
  const secret: [Tone, string] = p.secret_unreadable ? ['bad', t('Unreadable', 'غير قابل للقراءة', 'Onleesbaar')] : p.source === 'environment' ? ['ok', t('Set on the server', 'مُعيَّن على الخادم', 'Ingesteld op de server')] : p.has_secret ? ['ok', t('Saved (hidden)', 'محفوظ (مخفي)', 'Opgeslagen (verborgen)')] : ['idle', t('Not set', 'غير مُعدّ', 'Niet ingesteld')]
  return <dl className="pc-facts">
    <div><dt>{t('Secret', 'السر', 'Geheim')}</dt><dd><Chip s={secret[0]}>{secret[1]}</Chip></dd></div>
    <div><dt>{t('Redirect address', 'عنوان إعادة التوجيه', 'Omleidingsadres')}</dt><dd>
      <div className="pc-redirect"><code dir="ltr">{p.suggested_redirect_uri}</code>
        <button type="button" className="quiet compact" onClick={() => void copy()}><Copy size={14} aria-hidden="true" />{copied ? t('Copied', 'نُسخ', 'Gekopieerd') : t('Copy', 'نسخ', 'Kopiëren')}{' '}<span className="sr-only">{t('redirect address', 'عنوان إعادة التوجيه', 'omleidingsadres')} {nm}</span></button></div>
      <p className="pc-hint">{t('This suggested address is the source of truth: register it at the provider exactly as shown.', 'هذا العنوان المقترح هو المرجع: سجّله لدى المزود كما هو بالضبط.', 'Dit voorgestelde adres is leidend: registreer het precies zo bij de provider.')}</p></dd></div>
    <div><dt>{t('Permissions', 'الأذونات', 'Rechten')}</dt><dd><ul className="pc-scopes">{p.scopes.map(s => <li key={s.id} dir="ltr">{s.id}{!s.required && <span className="pc-opt"> · {t('optional', 'اختياري', 'optioneel')}</span>}</li>)}</ul></dd></div>
    {updated && <div><dt>{t('History', 'السجل', 'Geschiedenis')}</dt><dd>{updated}</dd></div>}
    {p.docs_url && <div><dt>{t('Guide', 'الدليل', 'Handleiding')}</dt><dd><a className="link-quiet pc-link" href={p.docs_url} target="_blank" rel="noreferrer noopener">{t('Provider documentation', 'وثائق المزود', 'Documentatie van de provider')}{' '}<span className="sr-only">{nm} {t('(opens in a new tab)', '(تفتح في تبويب جديد)', '(opent in een nieuw tabblad)')}</span></a></dd></div>}
  </dl>
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
  return <div className="pc-test">
    <p className="pc-test-head"><Chip s={result.ok ? 'ok' : 'warn'}>{result.ok ? t('Passed', 'نجح', 'Geslaagd') : t('Needs a fix', 'يلزم إصلاح', 'Aanpassen nodig')}</Chip> <strong>{result.ok ? t('The configuration looks right.', 'الإعداد يبدو سليمًا.', 'De configuratie ziet er goed uit.') : t('Something needs attention.', 'يحتاج أمر إلى انتباه.', 'Er is iets dat aandacht nodig heeft.')}</strong></p>
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
      <p className="muted small">{t('Permissions LifeOS asks for:', 'الأذونات التي يطلبها LifeOS:', 'Rechten die LifeOS vraagt:')} <span dir="ltr">{p.scopes.map(s => `${s.id}${s.required ? '' : ` (${t('optional', 'اختياري', 'optioneel')})`}`).join(', ')}</span></p>
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
