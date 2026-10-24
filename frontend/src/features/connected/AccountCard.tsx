import { useState } from 'react'
import { m, AnimatePresence } from 'motion/react'
import { RefreshCw, Unplug, Link2, CheckCircle2, AlertTriangle, ShieldCheck, ShieldAlert, Clock3, History, Hourglass, XCircle, Lock } from 'lucide-react'
import { api } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { ErrorMessage } from '../../components/ui/Shared'

export type Collection = { id: string; name: string; color: string | null; primary: boolean; included: boolean }
export type SyncRunInfo = { id: number; mode: 'full' | 'incremental'; status: 'running' | 'success' | 'partial' | 'failed' | 'rate_limited' | 'revoked'; trigger: string; started_at: string; finished_at: string | null; duration_ms: number | null; upserted: number; removed: number; moved: number; error: string | null }
export type ConnectedAccount = {
  id: number; provider: string; email: string | null; display_name: string | null; status: 'active' | 'error' | 'revoked'
  last_synced_at: string | null; last_attempt_at?: string | null; retry_after?: string | null; consecutive_failures?: number; scopes_ok?: boolean | null
  granted_scopes?: string[]; sync_mode?: 'full' | 'incremental'; last_error: string | null; events_count: number; connected_at: string | null
  collections: Collection[]; collections_managed: boolean; recent_runs?: SyncRunInfo[]
}

/** Picks which calendars or task lists of one account LifeOS imports. Nothing is imported from unchecked ones. */
export function CollectionPicker({ account, tasks, onSaved }: { account: ConnectedAccount; tasks: boolean; onSaved: () => void }) {
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

/**
 * One connected account in the hub: identity, honest state, what LifeOS reads, when it last succeeded, what went wrong
 * and what to do about it, and the recent sync history.
 */
export function AccountCard({ account, label, tasks, requiredScopes, busy, onSync, onReconnect, onDisconnect, onSaved }: {
  account: ConnectedAccount; label: string; tasks: boolean; requiredScopes: string[]; busy: string | null
  onSync: () => void; onReconnect: () => void; onDisconnect: () => void; onSaved: () => void
}) {
  const t = useText(), { language } = useLanguage()
  const [history, setHistory] = useState(false)
  const when = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' }) : t('Never', 'أبداً')
  const clock = (iso: string) => new Date(iso).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
  const waiting = account.retry_after ? new Date(account.retry_after) : null
  const state = account.status === 'revoked' ? 'revoked' : account.scopes_ok === false ? 'scope' : waiting ? 'waiting' : account.status === 'error' ? 'error' : 'ok'
  const stateLabel = { ok: t('Connected', 'متصل'), error: t('Sync problem', 'مشكلة مزامنة'), revoked: t('Access revoked', 'أُلغي الوصول'), scope: t('Permission missing', 'إذن ناقص'), waiting: t('Waiting for provider', 'بانتظار المزوّد') }[state]
  const hint = {
    ok: null,
    revoked: t('Access ended (revoked, password changed or expired). Reconnect to resume — your selections are kept.', 'انتهى الوصول (أُلغي أو تغيّرت كلمة المرور أو انتهت صلاحيته). أعد الربط للمتابعة — اختياراتك محفوظة.'),
    scope: t('The read permission was not granted on the consent screen. Reconnect and keep the read access ticked.', 'لم يُمنح إذن القراءة في شاشة الموافقة. أعد الربط وأبقِ إذن القراءة محدداً.'),
    waiting: waiting ? t(`The provider asked LifeOS to slow down. Sync resumes automatically after ${clock(waiting.toISOString())}.`, `طلب المزوّد من LifeOS التمهل. تستأنف المزامنة تلقائياً بعد ${clock(waiting.toISOString())}.`) : null,
    error: (account.consecutive_failures ?? 0) >= 3 ? t('Several syncs failed in a row, so LifeOS now retries less often. Try “Sync now”, or reconnect if it keeps failing.', 'فشلت عدة مزامنات متتالية، لذا يعيد LifeOS المحاولة بوتيرة أقل. جرّب «مزامنة الآن» أو أعد الربط إن استمر الفشل.') : t('Data that was already imported is kept. LifeOS retries automatically.', 'البيانات المستوردة سابقاً محفوظة. يعيد LifeOS المحاولة تلقائياً.'),
  }[state]
  const granted = (scope: string) => (account.granted_scopes ?? []).some(g => g.toLowerCase().includes(scope.toLowerCase()))
  const runLabel = (r: SyncRunInfo) => ({ success: t('Synced', 'تمت'), partial: t('Partly synced', 'مزامنة جزئية'), failed: t('Failed', 'فشلت'), rate_limited: t('Rate-limited', 'محدودة المعدل'), revoked: t('Access revoked', 'أُلغي الوصول'), running: t('Running', 'جارية') }[r.status])
  const runs = account.recent_runs ?? []
  return <li className={`account-card state-${state}`}>
    <div className="account-head">
      <span className={`status-dot dot-${state}`} aria-hidden="true" />
      <div><strong dir="ltr">{account.email ?? account.display_name ?? label}</strong>{account.display_name && account.email && <small className="muted">{account.display_name}</small>}</div>
      <span className={`pill pill-${state}`}>{state === 'ok' ? <CheckCircle2 size={12} /> : state === 'waiting' ? <Hourglass size={12} /> : <AlertTriangle size={12} />}{stateLabel}</span>
    </div>
    <dl className="account-facts">
      <div><dt>{t('Last successful sync', 'آخر مزامنة ناجحة')}</dt><dd>{when(account.last_synced_at)}</dd></div>
      <div><dt>{t('Last attempt', 'آخر محاولة')}</dt><dd>{when(account.last_attempt_at)}</dd></div>
      <div><dt>{t('Mode', 'النمط')}</dt><dd>{account.sync_mode === 'incremental' ? t('Incremental (changes only)', 'تدريجي (التغييرات فقط)') : t('Full read', 'قراءة كاملة')}</dd></div>
      <div><dt>{tasks ? t('Imported tasks', 'المهام المستوردة') : t('Upcoming commitments', 'الالتزامات القادمة')}</dt><dd>{account.events_count}</dd></div>
    </dl>
    {(hint || account.last_error) && state !== 'ok' && <div className={`account-alert alert-${state}`} role="status">
      {state === 'scope' ? <ShieldAlert size={16} /> : <AlertTriangle size={16} />}
      <div>{account.last_error && <p className="small">{account.last_error}</p>}{hint && <p className="small muted">{hint}</p>}</div>
    </div>}
    <div className="permissions">
      <span className="perm-title"><ShieldCheck size={14} />{t('Data access', 'الوصول إلى البيانات')}</span>
      {requiredScopes.map(scope => <span key={scope} className={`perm ${account.granted_scopes?.length ? (granted(scope) ? 'ok' : 'missing') : ''}`}>{account.granted_scopes?.length ? (granted(scope) ? <CheckCircle2 size={12} /> : <XCircle size={12} />) : <Lock size={12} />}<code dir="ltr">{scope}</code></span>)}
      <span className="perm muted"><Lock size={12} />{t('Read-only — LifeOS never writes', 'للقراءة فقط — لا يكتب LifeOS أبداً')}</span>
    </div>
    {account.status !== 'revoked' && <CollectionPicker key={account.collections.map(c => `${c.id}:${c.included}`).join(',')} account={account} tasks={tasks} onSaved={onSaved} />}
    <div className="toolbar">
      {state === 'revoked' || state === 'scope'
        ? <button className="primary" disabled={busy !== null} onClick={onReconnect}><Link2 size={15} />{t('Reconnect', 'إعادة الربط')}</button>
        : <button className="quiet" disabled={busy !== null || state === 'waiting'} onClick={onSync} aria-busy={busy === `sync-${account.id}`}><RefreshCw size={15} className={busy === `sync-${account.id}` ? 'spin' : ''} />{busy === `sync-${account.id}` ? t('Syncing…', 'جارٍ المزامنة…') : t('Sync now', 'مزامنة الآن')}</button>}
      {runs.length > 0 && <button className="quiet" aria-expanded={history} onClick={() => setHistory(h => !h)}><History size={15} />{t('Sync history', 'سجل المزامنة')}</button>}
      <button className="quiet" disabled={busy !== null} onClick={onDisconnect}><Unplug size={15} />{t('Disconnect', 'فصل')}</button>
    </div>
    <AnimatePresence initial={false}>{history && <m.ol className="sync-history" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 32 }}>
      {runs.map(r => <li key={r.id} className={`run run-${r.status}`}>
        <span className="run-status">{runLabel(r)}</span>
        <span className="muted small"><Clock3 size={11} /> {when(r.started_at)} · {r.mode === 'incremental' ? t('changes', 'تغييرات') : t('full', 'كاملة')}{r.duration_ms !== null ? ` · ${(r.duration_ms / 1000).toFixed(1)}s` : ''}</span>
        <span className="small">{t(`${r.upserted} updated · ${r.removed} removed${r.moved ? ` · ${r.moved} moved` : ''}`, `${r.upserted} محدّث · ${r.removed} محذوف${r.moved ? ` · ${r.moved} منقول` : ''}`)}</span>
        {r.error && <span className="small run-error">{r.error}</span>}
      </li>)}
    </m.ol>}</AnimatePresence>
  </li>
}
