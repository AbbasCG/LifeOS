import { useId, useState, type ReactNode } from 'react'
import { m, AnimatePresence } from 'motion/react'
import { RefreshCw, Unplug, Link2, CheckCircle2, AlertTriangle, ShieldCheck, ShieldAlert, Clock3, History, XCircle, Lock, ChevronRight } from 'lucide-react'
import { api } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { ErrorMessage } from '../../components/ui/Shared'
import type { WriteState } from '../../lib/calendarWrite'
import type { PermissionState } from '../../lib/connectionPermissions'
import type { SyncState } from '../../lib/syncSettings'
import { useAccountStateLabel } from '../../lib/accountState'
import { relativeTime } from '../../lib/relativeTime'
import { isBroken, usePresetLabel, useStateLine } from './accountLine'
import { Count } from './Count'

export type Collection = { id: string; name: string; color: string | null; primary: boolean; included: boolean }
export type SyncRunInfo = { details?: { skipped?: number }; id: number; mode: 'full' | 'incremental'; status: 'running' | 'success' | 'partial' | 'failed' | 'rate_limited' | 'revoked'; trigger: string; started_at: string; finished_at: string | null; duration_ms: number | null; upserted: number; removed: number; moved: number; error: string | null }
export type ConnectedAccount = {
  id: number; provider: string; email: string | null; display_name: string | null; status: 'active' | 'error' | 'revoked'
  last_synced_at: string | null; last_attempt_at?: string | null; retry_after?: string | null; consecutive_failures?: number; scopes_ok?: boolean | null
  granted_scopes?: string[]; sync_mode?: 'full' | 'incremental'; last_error: string | null; events_count: number; connected_at: string | null
  collections: Collection[]; collections_managed: boolean; recent_runs?: SyncRunInfo[]; write?: WriteState; permissions?: PermissionState; sync?: SyncState
}

/** Picks which calendars or task lists of one account LifeOS imports. Nothing is imported from unchecked ones. */
export function CollectionPicker({ account, tasks, onSaved }: { account: ConnectedAccount; tasks: boolean; onSaved: () => void }) {
  const t = useText(), toast = useToast()
  const [chosen, setChosen] = useState(() => account.collections.filter(c => c.included).map(c => c.id)), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const dirty = chosen.slice().sort().join('|') !== account.collections.filter(c => c.included).map(c => c.id).sort().join('|')
  if (!account.collections.length) return null
  async function save() {
    setBusy(true); setError('')
    try { await api(`/api/integrations/accounts/${account.id}`, 'PATCH', { included: chosen }); toast(tasks ? t('Lists updated and synced.', 'تم تحديث القوائم ومزامنتها.', 'Lijsten bijgewerkt en gesynchroniseerd.') : t('Calendars updated and synced.', 'تم تحديث التقويمات ومزامنتها.', 'Agenda’s bijgewerkt en gesynchroniseerd.')); onSaved() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <fieldset className="collection-picker">
    <legend>{tasks ? t('Lists to import', 'القوائم المستوردة', 'Te importeren lijsten') : t('Calendars to include', 'التقويمات المضمّنة', 'Op te nemen agenda’s')}</legend>
    {account.collections.map(c => <label key={c.id} className="inline">
      <input type="checkbox" checked={chosen.includes(c.id)} onChange={() => setChosen(list => list.includes(c.id) ? list.filter(x => x !== c.id) : [...list, c.id])} />
      <i className="swatch" style={{ background: c.color ?? 'var(--color-primary)' }} aria-hidden="true" /><span>{c.name}</span>{c.primary && <small className="muted">{t('primary', 'رئيسي', 'hoofd')}</small>}
    </label>)}
    <ErrorMessage error={error} />
    {dirty && <button className="primary" disabled={busy} onClick={() => void save()}>{busy ? t('Saving…', 'جارٍ الحفظ…', 'Opslaan…') : t('Save and sync', 'حفظ ومزامنة', 'Opslaan en synchroniseren')}</button>}
  </fieldset>
}

/** One second-tier row: a title with a one-line summary that opens the existing component for that topic right below it. */
function Tier({ title, summary, children }: { title: string; summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false), id = useId()
  return <li className="tier-item">
    <button type="button" className="tier-row" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
      <span className="tr-text"><span className="tr-title">{title}</span><span className="tr-sum">{summary}</span></span>
      <ChevronRight size={18} aria-hidden="true" className="flip-rtl" />
    </button>
    <div id={id} className="tier-body" hidden={!open}>{open && children}</div>
  </li>
}

/**
 * One connected account in the hub, as a sheet in three tiers. Always visible: who and how it is, the one action for its state, which calendars are included.
 * One tap away: what LifeOS may do, how it syncs, adding events. Behind "More": facts, data access and history. Last, apart: disconnect.
 */
export function AccountCard({ account, label, tasks, requiredScopes, busy, onSync, onReconnect, onDisconnect, onSaved, perms, sync, write, settled }: {
  account: ConnectedAccount; label: string; tasks: boolean; requiredScopes: string[]; busy: string | null
  onSync: () => void; onReconnect: () => void; onDisconnect: () => void; onSaved: () => void; perms?: ReactNode; sync?: ReactNode; write?: ReactNode
  /** How the sync that just ended went, for one short settle of the status dot. */
  settled?: 'ok' | 'bad'
}) {
  const t = useText(), { language } = useLanguage(), uid = useId()
  const [history, setHistory] = useState(false), [more, setMore] = useState(false)
  const full = (iso: string) => new Date(iso).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })
  /** Compact: "3 minutes ago" while recent, the date after a week; the exact moment is in the tooltip and the machine-readable attribute. */
  const when = (iso: string | null | undefined) => { if (!iso) return t('Never', 'أبداً', 'Nooit'); const r = relativeTime(iso, language); return <time dateTime={iso} title={full(iso)}>{r && r.kind !== 'date' ? r.text : full(iso)}</time> }
  const clock = (iso: string) => new Date(iso).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
  const waiting = account.retry_after ? new Date(account.retry_after) : null
  const syncing = busy === `sync-${account.id}`, who = account.email ?? account.display_name ?? label
  const line = useStateLine()(account, syncing), state = line.state
  const stateLabel = useAccountStateLabel()(state), presetLabel = usePresetLabel()(account)
  const hint = {
    ok: null,
    revoked: t('Access ended (revoked, password changed or expired). Reconnect to resume — your selections are kept.', 'انتهى الوصول (أُلغي أو تغيّرت كلمة المرور أو انتهت صلاحيته). أعد الربط للمتابعة — اختياراتك محفوظة.', 'Toegang beëindigd (ingetrokken, wachtwoord gewijzigd of verlopen). Koppel opnieuw om verder te gaan — je keuzes blijven bewaard.'),
    scope: t('The read permission was not granted on the consent screen. Reconnect and keep the read access ticked.', 'لم يُمنح إذن القراءة في شاشة الموافقة. أعد الربط وأبقِ إذن القراءة محدداً.', 'Het leesrecht is niet verleend op het toestemmingsscherm. Koppel opnieuw en laat leestoegang aangevinkt.'),
    waiting: waiting ? t(`The provider asked LifeOS to slow down. Sync resumes automatically after ${clock(waiting.toISOString())}.`, `طلب المزوّد من LifeOS التمهل. تستأنف المزامنة تلقائياً بعد ${clock(waiting.toISOString())}.`, `De provider vroeg LifeOS om te vertragen. Synchroniseren hervat automatisch na ${clock(waiting.toISOString())}.`) : null,
    error: (account.consecutive_failures ?? 0) >= 3 ? t('Several syncs failed in a row, so LifeOS now retries less often. Try “Sync now”, or reconnect if it keeps failing.', 'فشلت عدة مزامنات متتالية، لذا يعيد LifeOS المحاولة بوتيرة أقل. جرّب «مزامنة الآن» أو أعد الربط إن استمر الفشل.', 'Meerdere synchronisaties mislukten achter elkaar, dus LifeOS probeert het nu minder vaak. Probeer “Nu synchroniseren”, of koppel opnieuw als het blijft mislukken.') : t('Data that was already imported is kept. LifeOS retries automatically.', 'البيانات المستوردة سابقاً محفوظة. يعيد LifeOS المحاولة تلقائياً.', 'Gegevens die al waren geïmporteerd blijven bewaard. LifeOS probeert het automatisch opnieuw.'),
  }[state]
  const granted = (scope: string) => (account.granted_scopes ?? []).some(g => g.toLowerCase().includes(scope.toLowerCase()))
  const runLabel = (r: SyncRunInfo) => ({ success: t('Synced', 'تمت', 'Gesynchroniseerd'), partial: t('Partly synced', 'مزامنة جزئية', 'Deels gesynchroniseerd'), failed: t('Failed', 'فشلت', 'Mislukt'), rate_limited: t('Rate-limited', 'محدودة المعدل', 'Begrensd'), revoked: t('Access revoked', 'أُلغي الوصول', 'Toegang ingetrokken'), running: t('Running', 'جارية', 'Bezig') }[r.status])
  const runs = account.recent_runs ?? []
  // What LifeOS may really send to the service now: the person's choice, when the service has given the access it needs (not merely the old "adding events" switch).
  const sends = account.permissions ? account.permissions.effective.some(o => o === 'create' || o === 'update' || o === 'delete') : !!account.write?.enabled
  const feed = account.provider === 'ics', skipped = runs[0]?.details?.skipped ?? 0
  const subline = state === 'error' ? line.since : isBroken(state) ? null : line.chip
  const direction = account.sync && { inbound: t('From the service', 'من الخدمة', 'Van de dienst'), outbound: t('To the service', 'إلى الخدمة', 'Naar de dienst'), two_way: t('Both ways', 'في الاتجاهين', 'Beide kanten op'), manual: t('Only when I ask', 'عند طلبي فقط', 'Alleen als ik erom vraag') }[account.sync.effective_direction]
  const conflicts = account.sync?.open_conflicts ?? 0
  return <li className={`account-card state-${state}`} data-syncing={syncing || undefined} data-settle={settled}>
    <div className="account-head">
      <div className="account-id">{account.email ? <strong><bdi dir="ltr">{account.email}</bdi></strong> : <strong>{account.display_name ?? label}</strong>}{account.display_name && account.email && <small className="muted">{account.display_name}</small>}</div>
      <span className={`st${syncing ? ' is-syncing' : ''}`} data-s={line.s}><i className="st-dot" aria-hidden="true" />{syncing ? line.chip : stateLabel}</span>
    </div>
    {subline && <p className="muted small account-since">{subline}</p>}
    {(hint || account.last_error) && state !== 'ok' && <div className={`account-alert alert-${state}`} role="alert">
      {state === 'scope' ? <ShieldAlert size={16} /> : <AlertTriangle size={16} />}
      <div>{account.last_error && <p className="small">{account.last_error}</p>}{hint && <p className="small muted">{hint}</p>}</div>
    </div>}
    <div className="toolbar">
      {isBroken(state)
        ? <button className="primary" aria-disabled={busy !== null || undefined} aria-label={`${feed ? t('Use a new link', 'استخدام رابط جديد', 'Een nieuwe link gebruiken') : t('Reconnect', 'إعادة الربط', 'Opnieuw koppelen')} — ${label}, ${who}`} onClick={() => { if (busy === null) onReconnect() }}><Link2 size={15} />{feed ? t('Use a new link', 'استخدام رابط جديد', 'Een nieuwe link gebruiken') : t('Reconnect', 'إعادة الربط', 'Opnieuw koppelen')}</button>
        : <button className="quiet" aria-disabled={busy !== null || state === 'waiting' || undefined} aria-label={`${t('Sync now', 'مزامنة الآن', 'Nu synchroniseren')} — ${label}, ${who}`} onClick={() => { if (busy === null && state !== 'waiting') onSync() }} aria-busy={syncing}><RefreshCw size={15} className={syncing ? 'spin' : ''} />{syncing ? t('Syncing…', 'جارٍ المزامنة…', 'Synchroniseren…') : t('Sync now', 'مزامنة الآن', 'Nu synchroniseren')}</button>}
    </div>
    {skipped > 0 && <p className="muted small account-note">{t(`${skipped} repeating event(s) use a pattern LifeOS can’t expand yet, so they were left out rather than guessed.`, `${skipped} موعد متكرر يستخدم نمطاً لا يستطيع LifeOS توسيعه بعد، لذا تُرك بدلاً من التخمين.`, `${skipped} terugkerende afspraak/afspraken gebruiken een patroon dat LifeOS nog niet kan uitklappen, dus ze zijn weggelaten in plaats van geraden.`)}</p>}
    {account.status !== 'revoked' && !feed && <CollectionPicker key={account.collections.map(c => `${c.id}:${c.included}`).join(',')} account={account} tasks={tasks} onSaved={onSaved} />}
    {((perms && account.permissions) || (sync && account.sync) || (write && account.write)) && <ul className="tier-list" aria-label={t('Settings for this account', 'إعدادات هذا الحساب', 'Instellingen voor dit account')}>
      {perms && account.permissions && <Tier title={t('What LifeOS may do', 'ما يسمح به لـ LifeOS', 'Wat LifeOS mag doen')} summary={presetLabel}>{perms}</Tier>}
      {sync && account.sync && <Tier title={t('How it syncs', 'كيف تتم المزامنة', 'Hoe het synchroniseert')} summary={<>{direction}{account.sync.paused && ` · ${t('paused', 'متوقفة مؤقتًا', 'gepauzeerd')}`}{conflicts > 0 && <b className="tier-badge">{t(`${conflicts} to review`, `${conflicts} للمراجعة`, `${conflicts} te beoordelen`)}</b>}</>}>{sync}</Tier>}
      {write && account.write && <Tier title={t('Add events', 'إضافة مواعيد', 'Afspraken toevoegen')} summary={account.write.enabled ? `${t('On', 'مفعّل', 'Aan')}${account.write.calendar_name ? ` · ${account.write.calendar_name}` : ''}` : t('Off', 'متوقف', 'Uit')}>{write}</Tier>}
    </ul>}
    <button type="button" className="disclosure" aria-expanded={more} aria-controls={`${uid}-more`} onClick={() => setMore(v => !v)}><span>{t('More', 'المزيد', 'Meer')}</span><ChevronRight size={18} aria-hidden="true" /></button>
    <div id={`${uid}-more`} className="disclosure-body account-more" hidden={!more}>
      <dl className="account-facts">
        <div><dt>{t('Last successful sync', 'آخر مزامنة ناجحة', 'Laatste geslaagde synchronisatie')}</dt><dd>{when(account.last_synced_at)}</dd></div>
        <div><dt>{t('Last attempt', 'آخر محاولة', 'Laatste poging')}</dt><dd>{when(account.last_attempt_at)}</dd></div>
        <div><dt>{t('Mode', 'النمط', 'Modus')}</dt><dd>{account.sync_mode === 'incremental' ? t('Incremental (changes only)', 'تدريجي (التغييرات فقط)', 'Stapsgewijs (alleen wijzigingen)') : t('Full read', 'قراءة كاملة', 'Volledig lezen')}</dd></div>
        <div><dt>{tasks ? t('Imported tasks', 'المهام المستوردة', 'Geïmporteerde taken') : t('Upcoming commitments', 'الالتزامات القادمة', 'Komende afspraken')}</dt><dd><Count value={account.events_count} chip /></dd></div>
        {runs[0] && <div><dt>{t('Latest result', 'آخر نتيجة', 'Laatste resultaat')}</dt><dd><Count value={runs[0].upserted} /> {t('updated', 'محدّث', 'bijgewerkt')} · <Count value={runs[0].removed} /> {t('removed', 'محذوف', 'verwijderd')}{runs[0].moved > 0 && <> · <Count value={runs[0].moved} /> {t('moved', 'منقول', 'verplaatst')}</>}</dd></div>}
      </dl>
      <div className="permissions">
        <span className="perm-title"><ShieldCheck size={14} />{t('Data access', 'الوصول إلى البيانات', 'Gegevenstoegang')}</span>
        {requiredScopes.map(scope => <span key={scope} className={`perm ${account.granted_scopes?.length ? (granted(scope) ? 'ok' : 'missing') : ''}`}>{account.granted_scopes?.length ? (granted(scope) ? <CheckCircle2 size={12} /> : <XCircle size={12} />) : <Lock size={12} />}<code dir="ltr">{scope}</code></span>)}
        {feed && <span className="perm ok"><CheckCircle2 size={12} />{t('Public or secret feed — no account access', 'رابط عام أو سري — دون وصول إلى الحساب', 'Openbare of geheime feed — geen accounttoegang')}</span>}
        {sends
          ? <span className="perm"><Lock size={12} />{t('Reads everything; changes only events it added, after you confirm', 'يقرأ كل شيء؛ ولا يغيّر إلا المواعيد التي أضافها بعد تأكيدك', 'Leest alles; wijzigt alleen afspraken die het toevoegde, na jouw bevestiging')}</span>
          : <span className="perm muted"><Lock size={12} />{t('Read-only — LifeOS never writes', 'للقراءة فقط — لا يكتب LifeOS أبداً', 'Alleen lezen — LifeOS schrijft nooit')}</span>}
      </div>
      {runs.length > 0 && <button type="button" className="quiet compact" aria-expanded={history} onClick={() => setHistory(h => !h)}><History size={15} />{t('Sync history', 'سجل المزامنة', 'Synchronisatiegeschiedenis')}</button>}
      <AnimatePresence initial={false}>{history && <m.ol className="sync-history" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 32 }}>
        {runs.map(r => <li key={r.id} className={`run run-${r.status}`}>
          <span className="run-status">{runLabel(r)}</span>
          <span className="muted small"><Clock3 size={11} /> {when(r.started_at)} · {r.mode === 'incremental' ? t('changes', 'تغييرات', 'wijzigingen') : t('full', 'كاملة', 'volledig')}{r.duration_ms !== null ? ` · ${(r.duration_ms / 1000).toFixed(1)}s` : ''}</span>
          <span className="small">{t(`${r.upserted} updated · ${r.removed} removed${r.moved ? ` · ${r.moved} moved` : ''}`, `${r.upserted} محدّث · ${r.removed} محذوف${r.moved ? ` · ${r.moved} منقول` : ''}`, `${r.upserted} bijgewerkt · ${r.removed} verwijderd${r.moved ? ` · ${r.moved} verplaatst` : ''}`)}</span>
          {r.error && <span className="small run-error">{r.error}</span>}
        </li>)}
      </m.ol>}</AnimatePresence>
    </div>
    <section className="danger-zone" aria-labelledby={`${uid}-dz`}>
      <h3 id={`${uid}-dz`} className="dz-title">{t('Remove this connection', 'إزالة هذا الربط', 'Deze koppeling verwijderen')}</h3>
      <p className="dz-text">{t('Imported events and tasks leave LifeOS. Nothing changes in the connected app.', 'تُحذف المواعيد والمهام المستوردة من LifeOS. لا يتغير شيء في التطبيق المرتبط.', 'Geïmporteerde afspraken en taken verdwijnen uit LifeOS. Er verandert niets in de gekoppelde app.')}</p>
      <div><button type="button" className="danger-ghost" disabled={busy !== null} onClick={onDisconnect}><Unplug size={15} aria-hidden="true" />{t('Disconnect', 'فصل', 'Loskoppelen')}</button></div>
    </section>
  </li>
}
