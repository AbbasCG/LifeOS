import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Pause, Play } from 'lucide-react'
import { Dialog, ErrorMessage } from '../../components/ui/Shared'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { useSensitiveAction } from '../../lib/sensitive'
import { DIRECTIONS, POLICIES, loadConflicts, previewPush, pushNow, resolveConflict, saveSync, type Conflict, type ConflictPolicy, type PushResult, type Resolution, type SyncDirection, type SyncState } from '../../lib/syncSettings'
import '../../styles/permissions.css'

/**
 * How one connection is synchronised: the direction, what to do when both sides changed the same event, pausing, a dry run of what would be sent, and the conflicts that
 * wait for a decision. The numbers are the ones the server can prove from its own records. Sending is only ever an UPDATE of copies LifeOS added; creating and removing stay
 * explicit and confirmed, and a direction that sends is only in effect while the person's permissions allow it (the server asks again before every write).
 */
export function SyncSettings({ accountId, label, state, onChanged }: { accountId: number; label: string; state: SyncState; onChanged: () => void }) {
  const t = useText(), toast = useToast(), sensitive = useSensitiveAction(), { language } = useLanguage()
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [problem, setProblem] = useState('')
  const [direction, setDirection] = useState<SyncDirection>(state.direction), [policy, setPolicy] = useState<ConflictPolicy>(state.conflict_policy)
  const [plan, setPlan] = useState<PushResult | null>(null), [conflicts, setConflicts] = useState<Conflict[]>([]), [overwrite, setOverwrite] = useState<number | null>(null), [confirmed, setConfirmed] = useState(false)
  const overwriteBox = useRef<HTMLInputElement>(null), headingRef = useRef<HTMLHeadingElement>(null), focusAfter = useRef<number | 'none' | null>(null)
  const sends = state.effective_direction === 'outbound' || state.effective_direction === 'two_way'
  const when = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' }) : t('Never', 'أبداً', 'Nooit')

  const names: Record<SyncDirection, [string, string]> = {
    inbound: [t('From the service into LifeOS', 'من الخدمة إلى LifeOS', 'Van de dienst naar LifeOS'), t('LifeOS reads the service on a schedule. It never sends anything by itself.', 'يقرأ LifeOS الخدمة دوريًا. ولا يرسل شيئًا من تلقاء نفسه.', 'LifeOS leest de dienst volgens schema. Het stuurt nooit uit zichzelf iets.')],
    outbound: [t('From LifeOS to the service', 'من LifeOS إلى الخدمة', 'Van LifeOS naar de dienst'), t('LifeOS keeps the events it added up to date there. It does not read on a schedule.', 'يُبقي LifeOS المواعيد التي أضافها محدّثة هناك. ولا يقرأ دوريًا.', 'LifeOS houdt de afspraken die het toevoegde daar actueel. Het leest niet volgens schema.')],
    two_way: [t('Both ways', 'في الاتجاهين', 'Beide kanten op'), t('Reads on a schedule and keeps the events LifeOS added up to date.', 'يقرأ دوريًا ويُبقي المواعيد التي أضافها LifeOS محدّثة.', 'Leest volgens schema en houdt de door LifeOS toegevoegde afspraken actueel.')],
    manual: [t('Only when I ask', 'عند طلبي فقط', 'Alleen als ik erom vraag'), t('Nothing runs on a schedule. “Sync now” reads once.', 'لا يعمل شيء دوريًا. «مزامنة الآن» تقرأ مرة واحدة.', 'Er draait niets volgens schema. “Nu synchroniseren” leest één keer.')],
  }
  const policyNames: Record<ConflictPolicy, [string, string]> = {
    ask: [t('Ask me', 'اسألني', 'Vraag het mij'), t('Nothing is overwritten. I decide for each one.', 'لا يُستبدل شيء. أقرر في كل حالة.', 'Er wordt niets overschreven. Ik beslis per geval.')],
    prefer_external: [t('Keep what is at the service', 'أبقِ ما في الخدمة', 'Behoud wat bij de dienst staat'), t('LifeOS does not send its version.', 'لا يرسل LifeOS نسخته.', 'LifeOS stuurt zijn versie niet.')],
    prefer_lifeos: [t('Keep the LifeOS version', 'أبقِ نسخة LifeOS', 'Behoud de LifeOS-versie'), t('LifeOS overwrites what was changed at the service.', 'يستبدل LifeOS ما تغيّر في الخدمة.', 'LifeOS overschrijft wat bij de dienst is gewijzigd.')],
    keep_both: [t('Keep both', 'أبقِ النسختين', 'Behoud beide'), t('The version at the service stays; LifeOS adds its version as a new event.', 'تبقى نسخة الخدمة ويضيف LifeOS نسخته كموعد جديد.', 'De versie bij de dienst blijft; LifeOS voegt zijn versie als nieuwe afspraak toe.')],
  }
  const reason = state.effective_reason === 'permissions'
    ? t('Sending is switched off in this connection’s permissions, so LifeOS only reads. Allow sending and updating under Manage permissions to use this direction.', 'الإرسال متوقف في صلاحيات هذا الاتصال، لذلك يقرأ LifeOS فقط. اسمح بالإرسال والتعديل ضمن «إدارة الصلاحيات» لاستخدام هذا الاتجاه.', 'Verzenden staat uit in de rechten van deze koppeling, dus LifeOS leest alleen. Sta verzenden en bijwerken toe onder Rechten beheren om deze richting te gebruiken.')
    : state.effective_reason === 'unsupported' ? t('This service cannot be sent changes through LifeOS.', 'لا يمكن إرسال تغييرات إلى هذه الخدمة عبر LifeOS.', 'Deze dienst kan via LifeOS geen wijzigingen ontvangen.') : null

  const loadList = useCallback(() => { loadConflicts(accountId).then(list => setConflicts(list.filter(c => c.status === 'open'))).catch(() => setConflicts([])) }, [accountId])
  useEffect(() => { if (state.open_conflicts > 0) loadList() }, [state.open_conflicts, loadList])
  // Nothing is shown for conflicts the server no longer counts as open, even before the list is reloaded.
  const waiting = state.open_conflicts > 0 ? conflicts : []
  // The reveal of the overwrite confirmation moves focus to its checkbox, so a keyboard or screen-reader user lands on what must be decided.
  useEffect(() => { if (overwrite !== null) overwriteBox.current?.focus() }, [overwrite])
  // After a conflict is resolved its buttons disappear: focus goes to the next conflict, or to the section heading when none is left, never to the page body.
  useEffect(() => {
    const target = focusAfter.current
    if (target === null) return
    if (target !== 'none' && conflicts.some(c => c.id === target) && state.open_conflicts > 0) { document.querySelector<HTMLElement>(`[data-conflict="${target}"] button`)?.focus(); focusAfter.current = null }
    else if (target === 'none' || state.open_conflicts === 0) { headingRef.current?.focus(); focusAfter.current = null }
  }, [conflicts, state.open_conflicts])
  async function run<T>(fn: () => Promise<T>, done?: string): Promise<T | undefined> {
    setBusy(true); setProblem('')
    try { const r = await fn(); if (done) toast(done, 'success'); return r } catch (e) { setProblem((e as Error).message) } finally { setBusy(false) }
  }
  async function save() {
    const ok = await run(() => sensitive(() => saveSync(accountId, { direction, ...(direction === 'outbound' || direction === 'two_way' ? { conflict_policy: policy } : {}) })), t('Sync settings saved.', 'تم حفظ إعدادات المزامنة.', 'Synchronisatie-instellingen opgeslagen.'))
    if (ok) { setOpen(false); onChanged() }
  }
  async function togglePause() { const ok = await run(() => sensitive(() => saveSync(accountId, { paused: !state.paused })), state.paused ? t('Sync resumed.', 'استؤنفت المزامنة.', 'Synchronisatie hervat.') : t('Sync paused.', 'أُوقفت المزامنة مؤقتًا.', 'Synchronisatie gepauzeerd.')); if (ok) onChanged() }
  async function preview() { const r = await run(() => previewPush(accountId)); if (r) setPlan(r) }
  async function push() {
    const r = await run(() => pushNow(accountId))
    if (r) { setPlan(null); toast(t(`Sent ${r.pushed} update(s).${r.conflicts ? ` ${r.conflicts} conflict(s) found.` : ''}`, `أُرسل ${r.pushed} تحديث.${r.conflicts ? ` وُجد ${r.conflicts} تعارض.` : ''}`, `${r.pushed} update(s) verstuurd.${r.conflicts ? ` ${r.conflicts} conflict(en) gevonden.` : ''}`), 'success'); onChanged() }
  }
  async function resolve(c: Conflict, how: Resolution) {
    const ok = await run(() => sensitive(() => resolveConflict(c.id, how, how === 'keep_lifeos')), t('Conflict resolved.', 'حُلّ التعارض.', 'Conflict opgelost.'))
    if (ok !== undefined) {
      const index = waiting.findIndex(x => x.id === c.id), next = waiting[index + 1] ?? waiting[index - 1]
      focusAfter.current = next ? next.id : 'none'
      setOverwrite(null); setConfirmed(false); onChanged(); loadList() }
  }
  const run0 = state.last_outbound
  const status = (s: string) => ({ success: t('Sent', 'أُرسل', 'Verstuurd'), partial: t('Partly sent', 'أُرسل جزئيًا', 'Deels verstuurd'), failed: t('Failed', 'فشل', 'Mislukt'), rate_limited: t('Waiting (rate limit)', 'انتظار (حد المعدل)', 'Wachten (limiet)'), revoked: t('Access ended', 'انتهى الوصول', 'Toegang beëindigd'), running: t('Running', 'قيد التشغيل', 'Bezig') }[s] ?? s)

  return <section className="perms-summary" aria-labelledby={`sync-${accountId}`}>
    <h3 id={`sync-${accountId}`} ref={headingRef} tabIndex={-1}><RefreshCw size={15} aria-hidden="true" />{t('How it syncs', 'كيف تتم المزامنة', 'Hoe het synchroniseert')}</h3>
    <dl className="account-facts">
      <div><dt>{t('Direction', 'الاتجاه', 'Richting')}</dt><dd>{names[state.effective_direction][0]}{state.paused && ` · ${t('paused', 'متوقفة مؤقتًا', 'gepauzeerd')}`}</dd></div>
      <div><dt>{t('Events LifeOS added', 'مواعيد أضافها LifeOS', 'Door LifeOS toegevoegd')}</dt><dd>{state.copies} · {t(`${state.copies_pending} waiting to be updated`, `${state.copies_pending} بانتظار التحديث`, `${state.copies_pending} wachten op bijwerken`)}</dd></div>
      <div><dt>{t('Conflicts waiting for you', 'تعارضات تنتظر قرارك', 'Conflicten die op jou wachten')}</dt><dd>{state.open_conflicts}</dd></div>
      <div><dt>{t('Last time LifeOS sent changes', 'آخر إرسال للتغييرات', 'Laatst verstuurd')}</dt><dd>{run0 ? `${when(run0.started_at)} · ${status(run0.status)} · ${run0.upserted}` : t('Never', 'أبداً', 'Nooit')}</dd></div>
    </dl>
    {run0?.error && <p className="error small" role="alert">{run0.error}</p>}
    {reason && <p className="muted small perms-note" role="note">{reason}</p>}

    {waiting.length > 0 && <div className="perms-warn" role="group" aria-label={t('Conflicts', 'التعارضات', 'Conflicten')}>
      <strong>{t(`${label}: an event was changed there and in LifeOS`, `${label}: تغيّر موعد هناك وفي LifeOS`, `${label}: een afspraak is daar en in LifeOS gewijzigd`)}</strong>
      <ul className="perms-form" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {waiting.map(c => <li key={c.id} className="perms-form" data-conflict={c.id}>
          <span>{c.title}<span className="muted small"> · {when(c.starts_at)}</span></span>
          <div className="rel-actions">
            <button type="button" className="quiet" disabled={busy} onClick={() => void resolve(c, 'keep_external')}>{t('Keep the one at the service', 'أبقِ ما في الخدمة', 'Behoud die bij de dienst')}</button>
            <button type="button" className="quiet" disabled={busy} onClick={() => void resolve(c, 'keep_both')}>{t('Keep both', 'أبقِ النسختين', 'Behoud beide')}</button>
            <button type="button" className="quiet" disabled={busy} onClick={() => { setOverwrite(c.id); setConfirmed(false) }}>{t('Use the LifeOS version…', 'استخدم نسخة LifeOS…', 'Gebruik de LifeOS-versie…')}</button>
          </div>
          {overwrite === c.id && <div className="perms-warn" role="group" aria-labelledby={`overwrite-note-${c.id}`}>
            <span id={`overwrite-note-${c.id}`}>{t('This replaces what is at the service with the LifeOS version. It cannot be undone from LifeOS.', 'هذا يستبدل ما في الخدمة بنسخة LifeOS ولا يمكن التراجع عنه من LifeOS.', 'Dit vervangt wat bij de dienst staat door de LifeOS-versie. Het kan niet vanuit LifeOS ongedaan worden.')}</span>
            <label><input ref={overwriteBox} type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t('I understand and want to overwrite it.', 'أفهم وأريد الاستبدال.', 'Ik begrijp het en wil overschrijven.')}</label>
            <button type="button" className="danger" disabled={busy || !confirmed} onClick={() => void resolve(c, 'keep_lifeos')}>{t('Overwrite', 'استبدال', 'Overschrijven')}</button>
          </div>}
        </li>)}
      </ul>
    </div>}

    <ErrorMessage error={problem} />
    <div className="rel-actions">
      <button type="button" className="quiet" aria-haspopup="dialog" onClick={() => { setDirection(state.direction); setPolicy(state.conflict_policy); setProblem(''); setOpen(true) }}>{t('Sync settings', 'إعدادات المزامنة', 'Synchronisatie-instellingen')}</button>
      <button type="button" className="quiet" disabled={busy} onClick={() => void togglePause()}>{state.paused ? <><Play size={14} aria-hidden="true" />{t('Resume sync', 'استئناف المزامنة', 'Synchronisatie hervatten')}</> : <><Pause size={14} aria-hidden="true" />{t('Pause sync', 'إيقاف المزامنة مؤقتًا', 'Synchronisatie pauzeren')}</>}</button>
      {sends && <button type="button" className="quiet" disabled={busy} onClick={() => void preview()}>{t('Preview what would be sent', 'معاينة ما سيُرسل', 'Bekijk wat er verstuurd zou worden')}</button>}
    </div>
    {plan && <div className="perms-warn" role="status">
      {plan.pending === 0 ? <span>{t('Nothing is waiting: every event LifeOS added matches.', 'لا شيء ينتظر: كل موعد أضافه LifeOS مطابق.', 'Er wacht niets: elke door LifeOS toegevoegde afspraak komt overeen.')}</span>
        : <><span>{t(`${plan.pending} update(s) would be sent. Nothing has been sent yet.`, `سيُرسل ${plan.pending} تحديث. لم يُرسل شيء بعد.`, `${plan.pending} update(s) zouden worden verstuurd. Er is nog niets verstuurd.`)}</span>
          <ul>{plan.planned.map(p => <li key={p.link_id}>{p.from} → {p.to}</li>)}</ul>
          <button type="button" className="primary" disabled={busy} onClick={() => void push()}>{t('Send these updates now', 'أرسل هذه التحديثات الآن', 'Verstuur deze updates nu')}</button></>}
    </div>}

    {open && <Dialog title={t(`Sync settings for ${label}`, `إعدادات مزامنة ${label}`, `Synchronisatie-instellingen voor ${label}`)} onClose={() => !busy && setOpen(false)}>
      <form className="perms-form" onSubmit={e => { e.preventDefault(); void save() }}>
        <p className="muted small perms-note">{t('The direction can never go beyond what you allowed under Manage permissions. Sending only ever updates events LifeOS added; adding and removing stay explicit.', 'لا يتجاوز الاتجاه أبدًا ما سمحت به ضمن «إدارة الصلاحيات». والإرسال يحدّث فقط المواعيد التي أضافها LifeOS؛ أما الإضافة والحذف فيبقيان صريحين.', 'De richting gaat nooit verder dan wat je toestond onder Rechten beheren. Verzenden werkt alleen afspraken bij die LifeOS toevoegde; toevoegen en verwijderen blijven expliciet.')}</p>
        <fieldset className="perms-form" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend><strong>{t('Direction', 'الاتجاه', 'Richting')}</strong></legend>
          {DIRECTIONS.filter(d => state.available_directions.includes(d)).map(d => <label key={d} className="perms-choice"><input type="radio" name={`dir-${accountId}`} checked={direction === d} onChange={() => setDirection(d)} data-autofocus={direction === d || undefined} /><strong>{names[d][0]}</strong><span className="muted small">{names[d][1]}</span></label>)}
        </fieldset>
        {(direction === 'outbound' || direction === 'two_way') && <fieldset className="perms-form" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend><strong>{t('If an event changed in both places', 'إذا تغيّر الموعد في المكانين', 'Als een afspraak op beide plekken veranderde')}</strong></legend>
          {POLICIES.map(p => <label key={p} className="perms-choice"><input type="radio" name={`pol-${accountId}`} checked={policy === p} onChange={() => setPolicy(p)} /><strong>{policyNames[p][0]}</strong><span className="muted small">{policyNames[p][1]}</span></label>)}
          {policy === 'prefer_lifeos' && <p className="perms-warn" role="note">{t('LifeOS will overwrite changes you made at the service. Choose “Ask me” if you are not sure.', 'سيستبدل LifeOS التغييرات التي أجريتها في الخدمة. اختر «اسألني» إن لم تكن متأكدًا.', 'LifeOS overschrijft wijzigingen die je bij de dienst deed. Kies “Vraag het mij” als je het niet zeker weet.')}</p>}
        </fieldset>}
        <ErrorMessage error={problem} />
        <p className="muted small perms-note">{t('You may be asked for your password.', 'قد يُطلب منك إدخال كلمة المرور.', 'Je wordt mogelijk om je wachtwoord gevraagd.')}</p>
        <div className="perms-footer">
          <div className="rel-actions">
            <button type="submit" className="primary" disabled={busy}>{t('Save', 'حفظ', 'Opslaan')}</button>
            <button type="button" className="quiet" disabled={busy} onClick={() => setOpen(false)}>{t('Cancel', 'إلغاء', 'Annuleren')}</button>
          </div>
        </div>
      </form>
    </Dialog>}
  </section>
}
