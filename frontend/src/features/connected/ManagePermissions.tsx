import { useState } from 'react'
import { ShieldCheck, TriangleAlert } from 'lucide-react'
import { Dialog, ErrorMessage } from '../../components/ui/Shared'
import { api } from '../../lib/api'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { useSensitiveAction } from '../../lib/sensitive'
import { PRESET_OPS, PRESET_ORDER, savePermissions, type PermissionOp, type PermissionPreset, type PermissionState } from '../../lib/connectionPermissions'
import '../../styles/permissions.css'

/**
 * What LifeOS may do with one connected account. The choices offered are the ones this service can actually do (a task service offers no choice that sends
 * changes). The limits are enforced by the server before anything is sent to the provider; they do not change the access the provider gave, which this screen says.
 * Turning Delete on asks separately, in words, and the server insists on that confirmation too.
 */
export function ManagePermissions({ accountId, label, state, onChanged }: { accountId: number; label: string; state: PermissionState; onChanged: () => void }) {
  const t = useText(), toast = useToast(), sensitive = useSensitiveAction()
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [problem, setProblem] = useState('')
  const offered = PRESET_ORDER.filter(p => state.presets.includes(p))
  const initial = (): { mode: PermissionPreset | 'custom'; ops: PermissionOp[] } => state.preset ? { mode: state.preset, ops: state.granted } : { mode: 'custom', ops: state.granted }
  const [mode, setMode] = useState<PermissionPreset | 'custom'>(initial().mode), [ops, setOps] = useState<PermissionOp[]>(initial().ops), [confirmDelete, setConfirmDelete] = useState(false)

  const names: Record<PermissionOp, string> = {
    read: t('Read', 'قراءة', 'Lezen'), sync: t('Sync in the background', 'مزامنة في الخلفية', 'Op de achtergrond synchroniseren'), import: t('Import into LifeOS', 'استيراد إلى LifeOS', 'Importeren in LifeOS'),
    export: t('Send changes to the service', 'إرسال التغييرات إلى الخدمة', 'Wijzigingen naar de dienst sturen'), create: t('Create', 'إنشاء', 'Aanmaken'), update: t('Update', 'تعديل', 'Bijwerken'), delete: t('Delete', 'حذف', 'Verwijderen'),
  }
  const presetText: Record<PermissionPreset, [string, string]> = {
    read_only: [t('Read only', 'قراءة فقط', 'Alleen lezen'), t('LifeOS reads and syncs. It never sends anything to the service.', 'يقرأ LifeOS ويزامن. ولا يرسل أي شيء إلى الخدمة أبدًا.', 'LifeOS leest en synchroniseert. Het stuurt nooit iets naar de dienst.')],
    read_create: [t('Read + Create', 'قراءة + إنشاء', 'Lezen + Aanmaken'), t('LifeOS can add events you confirm.', 'يستطيع LifeOS إضافة المواعيد التي تؤكدها.', 'LifeOS kan afspraken toevoegen die je bevestigt.')],
    read_create_update: [t('Read + Create + Update', 'قراءة + إنشاء + تعديل', 'Lezen + Aanmaken + Bijwerken'), t('It can also change the events it added.', 'ويستطيع أيضًا تعديل المواعيد التي أضافها.', 'Het kan ook de afspraken wijzigen die het toevoegde.')],
    full: [t('Full access including Delete', 'وصول كامل مع الحذف', 'Volledige toegang inclusief verwijderen'), t('It can also remove the events it added.', 'ويستطيع أيضًا حذف المواعيد التي أضافها.', 'Het kan ook de afspraken verwijderen die het toevoegde.')],
  }
  const chosen: PermissionOp[] = mode === 'custom' ? ops : PRESET_OPS[mode].filter(o => state.capabilities.includes(o))
  const wasDelete = state.granted.includes('delete'), wantsDelete = chosen.includes('delete')
  const needsConfirm = wantsDelete && !wasDelete
  const customOps = state.capabilities
  const writeOps: PermissionOp[] = ['create', 'update', 'delete']
  const toggle = (op: PermissionOp) => setOps(old => {
    const next = old.includes(op) ? old.filter(o => o !== op) : [...old, op]
    // Sending changes is switched on and off together with what is sent, so the choice always makes sense.
    const withoutExport: PermissionOp[] = next.filter(o => o !== 'export')
    return withoutExport.some(o => writeOps.includes(o)) ? [...withoutExport, 'export'] : withoutExport
  })
  const reconsent = Object.entries(state.blocked).some(([, why]) => why === 'reconsent_required')

  function show(op: PermissionOp) { return state.effective.includes(op) }
  async function save() {
    setBusy(true); setProblem('')
    try {
      const body = mode === 'custom' ? { permissions: customOps.filter(o => ops.includes(o) || o === 'read') } : { preset: mode }
      await sensitive(() => savePermissions(accountId, body, needsConfirm && confirmDelete))
      toast(t('Permissions saved.', 'تم حفظ الصلاحيات.', 'Rechten opgeslagen.'), 'success')
      setOpen(false); setConfirmDelete(false); onChanged()
    } catch (e) { setProblem((e as Error).message) } finally { setBusy(false) }
  }
  async function allowAgain() {
    setBusy(true); setProblem('')
    try { const r = await api<{ authorization_url: string }>(`/api/integrations/accounts/${accountId}/write/connect`, 'POST'); window.location.assign(r.authorization_url) } catch (e) { setProblem((e as Error).message); setBusy(false) }
  }

  return <section className="perms-summary" aria-labelledby={`perms-${accountId}`}>
    <h3 id={`perms-${accountId}`}><ShieldCheck size={15} aria-hidden="true" />{t('What LifeOS may do', 'ما يسمح به لـ LifeOS', 'Wat LifeOS mag doen')}</h3>
    <ul className="perms-list" aria-label={t('Allowed now', 'المسموح الآن', 'Nu toegestaan')}>
      {state.capabilities.map(op => <li key={op} className={show(op) ? '' : 'off'}><span className="sr-only">{show(op) ? t('Allowed: ', 'مسموح: ', 'Toegestaan: ') : t('Not allowed: ', 'غير مسموح: ', 'Niet toegestaan: ')}</span>{names[op]}</li>)}
    </ul>
    {state.legacy && <p className="muted small perms-note">{t('This connection was made before these choices existed. It keeps what it could do, and Delete is off until you turn it on.', 'تم هذا الربط قبل وجود هذه الخيارات. يحتفظ بما كان يستطيعه، والحذف متوقف حتى تفعّله.', 'Deze koppeling is gemaakt voordat deze keuzes bestonden. Ze behoudt wat ze kon; verwijderen staat uit tot je het aanzet.')}</p>}
    {reconsent && <p className="perms-warn" role="status"><span>{t(`${label} has not given LifeOS the access needed to send changes. Allow it once, then LifeOS can use the permissions you chose.`, `لم تمنح ${label} لـ LifeOS الوصول اللازم لإرسال التغييرات. اسمح به مرة واحدة ثم يستخدم LifeOS الصلاحيات التي اخترتها.`, `${label} heeft LifeOS niet de toegang gegeven die nodig is om wijzigingen te sturen. Sta het eenmalig toe; daarna kan LifeOS de gekozen rechten gebruiken.`)}</span>
      <button type="button" className="primary" disabled={busy} onClick={() => void allowAgain()}>{t('Allow at the service', 'السماح لدى الخدمة', 'Toestaan bij de dienst')}</button></p>}
    <div><button type="button" className="quiet" aria-haspopup="dialog" onClick={() => { const i = initial(); setMode(i.mode); setOps(i.ops); setConfirmDelete(false); setProblem(''); setOpen(true) }}>{t('Manage permissions', 'إدارة الصلاحيات', 'Rechten beheren')}</button></div>
    {open && <Dialog title={t(`Permissions for ${label}`, `صلاحيات ${label}`, `Rechten voor ${label}`)} onClose={() => !busy && setOpen(false)}>
      <form className="perms-form" onSubmit={e => { e.preventDefault(); if (!(needsConfirm && !confirmDelete)) void save() }}>
        <p className="muted small perms-note">{t('LifeOS enforces these limits itself. They do not change the access the service already gave: even if the service would allow more, LifeOS will not ask for it.', 'يفرض LifeOS هذه الحدود بنفسه. هي لا تغيّر الوصول الذي منحته الخدمة: حتى لو سمحت الخدمة بأكثر فلن يطلبه LifeOS.', 'LifeOS dwingt deze grenzen zelf af. Ze veranderen de toegang die de dienst al gaf niet: ook als de dienst meer zou toestaan, vraagt LifeOS er niet om.')}</p>
        <fieldset className="perms-form" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sr-only">{t('Choose what LifeOS may do', 'اختر ما يسمح به لـ LifeOS', 'Kies wat LifeOS mag doen')}</legend>
          {offered.map(p => <label key={p} className="perms-choice"><span><input type="radio" name={`preset-${accountId}`} checked={mode === p} onChange={() => setMode(p)} data-autofocus={mode === p || undefined} />{presetText[p][0]}</span><span className="muted small">{presetText[p][1]}</span></label>)}
          {offered.length > 1 && <label className="perms-choice"><span><input type="radio" name={`preset-${accountId}`} checked={mode === 'custom'} onChange={() => { setMode('custom'); setOps(chosen) }} />{t('Custom', 'مخصص', 'Aangepast')}</span><span className="muted small">{t('Pick each permission yourself.', 'اختر كل صلاحية بنفسك.', 'Kies zelf elk recht.')}</span></label>}
          {mode === 'custom' && <div className="perms-custom">
            {customOps.map(op => op === 'read' ? <label key={op}><input type="checkbox" checked disabled />{names.read} <span className="muted small">{t('(always on)', '(دائم)', '(altijd aan)')}</span></label>
              : op === 'export' ? null : <label key={op}><input type="checkbox" checked={ops.includes(op)} onChange={() => toggle(op)} />{names[op]}</label>)}
          </div>}
        </fieldset>
        {needsConfirm && <div className="perms-warn" role="group" aria-labelledby={`del-${accountId}`}>
          <strong id={`del-${accountId}`}><TriangleAlert size={15} aria-hidden="true" /> {t('Delete cannot be undone', 'الحذف لا يمكن التراجع عنه', 'Verwijderen kan niet ongedaan worden')}</strong>
          <span>{t('With Delete on, LifeOS can remove the events it added to this calendar, after you confirm each one. It never removes events it did not add.', 'عند تفعيل الحذف يستطيع LifeOS حذف المواعيد التي أضافها إلى هذا التقويم بعد أن تؤكد كل واحد. ولا يحذف أبدًا ما لم يضفه.', 'Met verwijderen aan kan LifeOS afspraken verwijderen die het aan deze agenda toevoegde, na jouw bevestiging van elke. Het verwijdert nooit afspraken die het niet toevoegde.')}</span>
          <label><input type="checkbox" checked={confirmDelete} onChange={e => setConfirmDelete(e.target.checked)} />{t('I understand and want to turn Delete on.', 'أفهم وأريد تفعيل الحذف.', 'Ik begrijp het en wil verwijderen aanzetten.')}</label>
        </div>}
        <ErrorMessage error={problem} />
        <div className="rel-actions">
          <button type="submit" className="primary" disabled={busy || (needsConfirm && !confirmDelete)}>{t('Save', 'حفظ', 'Opslaan')}</button>
          <button type="button" className="quiet" disabled={busy} onClick={() => setOpen(false)}>{t('Cancel', 'إلغاء', 'Annuleren')}</button>
        </div>
        <p className="muted small perms-note">{t('You may be asked for your password.', 'قد يُطلب منك إدخال كلمة المرور.', 'Je wordt mogelijk om je wachtwoord gevraagd.')}</p>
      </form>
    </Dialog>}
  </section>
}
