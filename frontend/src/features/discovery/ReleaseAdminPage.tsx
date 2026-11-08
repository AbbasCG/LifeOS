import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { PageHead } from '../../components/visual'
import { Dialog, EmptyState, ErrorMessage, Skeleton } from '../../components/ui/Shared'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useToast } from '../../lib/toast'
import { useAuth } from '../../contexts/AuthContext'
import { useSensitiveAction } from '../../lib/sensitive'
import { ApiError } from '../../lib/api'
import { adminReleasesPath, approveRelease, withdrawRelease, type Activation, type AdminRelease, type Texts } from '../../lib/discovery'

type Lang = 'ar' | 'nl' | 'en'

/**
 * Administrators only: which updates the running code contains, what exactly each says in Arabic, Dutch and English, and the decision to publish or
 * withdraw it. Publishing is deliberate: the text shown here is what the fingerprint covers, the decision names that fingerprint, and the server refuses it
 * if the text changed meanwhile, if the release is not part of a healthy deploy, or without a recent password confirmation and two-factor authentication.
 */
export default function ReleaseAdminPage() {
  const t = useText(), toast = useToast(), auth = useAuth(), sensitive = useSensitiveAction()
  // Only an administrator asks: everybody else would get a 403 for nothing.
  const { data, error, loading, reload } = useApi<{ data: AdminRelease[]; activation: Activation }>(auth.user?.is_admin ? adminReleasesPath : null)
  const [deciding, setDeciding] = useState<{ release: AdminRelease; action: 'approve' | 'withdraw' } | null>(null)
  const [read, setRead] = useState(false), [busy, setBusy] = useState(false), [problem, setProblem] = useState('')

  if (!auth.user?.is_admin) return <section className="page"><PageHead title={t('Approve updates', 'اعتماد التحديثات', 'Updates goedkeuren')} icon={ShieldCheck} />
    <EmptyState title={t('Administrators only', 'للمدراء فقط', 'Alleen voor beheerders')}>{t('This page is only available to LifeOS administrators.', 'هذه الصفحة متاحة لمدراء LifeOS فقط.', 'Deze pagina is alleen beschikbaar voor LifeOS-beheerders.')}</EmptyState></section>

  const reviewLabel = (r: AdminRelease) => r.review_status === 'approved' ? t('Approved', 'معتمد', 'Goedgekeurd') : r.review_status === 'withdrawn' ? t('Withdrawn', 'مسحوب', 'Ingetrokken')
    : r.review_status === 'draft' ? t('Draft', 'مسودة', 'Concept') : t('Not registered yet', 'لم يُسجَّل بعد', 'Nog niet geregistreerd')
  const deployLabel = (r: AdminRelease) => r.deploy_status === 'live' ? t('In the running code', 'في الكود العامل', 'In de draaiende code') : r.deploy_status === 'absent' ? t('No longer in the code', 'لم يعد في الكود', 'Niet meer in de code') : t('Waiting for a healthy deploy', 'بانتظار نشر سليم', 'Wacht op een gezonde deploy')
  /** Why a release cannot be approved right now (null when it can). */
  const cannotApprove = (r: AdminRelease) => !r.registered || r.deploy_status !== 'live'
    ? t('It must first be registered by a healthy deploy.', 'يجب أولًا أن يسجّله نشر سليم.', 'Het moet eerst door een gezonde deploy zijn geregistreerd.')
    : r.review_status === 'approved' && r.approved_hash === r.content_hash ? t('Already approved.', 'معتمد مسبقًا.', 'Al goedgekeurd.')
      : !auth.user?.two_factor_enabled ? t('Turn on two-factor authentication first (Security).', 'فعّل التحقق بخطوتين أولًا (الأمان).', 'Zet eerst tweestapsverificatie aan (Beveiliging).') : null
  const activationText = (a: Activation) => !a.enabled
    ? t('Updates are switched off on the server (DISCOVERY_AUTO_ACTIVATE). Approving now records your decision but nobody sees anything yet.', 'التحديثات متوقفة على الخادم (DISCOVERY_AUTO_ACTIVATE). الاعتماد الآن يسجّل قرارك لكن لا يرى أحد شيئًا بعد.', 'Updates staan uit op de server (DISCOVERY_AUTO_ACTIVATE). Goedkeuren legt je keuze vast, maar niemand ziet al iets.')
    : a.status === 'confirmed' ? t('The running code is the last healthy deploy: approved updates are shown.', 'الكود العامل هو آخر نشر سليم: تُعرض التحديثات المعتمدة.', 'De draaiende code is de laatste gezonde deploy: goedgekeurde updates worden getoond.')
      : t(`Updates are on, but the deploy is not confirmed yet (${a.status}). ${a.detail}`, `التحديثات مفعّلة لكن النشر غير مؤكد بعد (${a.status}). ${a.detail}`, `Updates staan aan, maar de deploy is nog niet bevestigd (${a.status}). ${a.detail}`)

  function open(release: AdminRelease, action: 'approve' | 'withdraw') { setRead(false); setProblem(''); setDeciding({ release, action }) }
  async function decide() {
    if (!deciding) return
    setBusy(true); setProblem('')
    const { release, action } = deciding
    try {
      if (action === 'approve') await sensitive(() => approveRelease(release.key, release.content_hash)); else await withdrawRelease(release.key)
      toast(action === 'approve' ? t('Update approved.', 'اعتُمد التحديث.', 'Update goedgekeurd.') : t('Update withdrawn.', 'سُحب التحديث.', 'Update ingetrokken.'), 'success')
      setDeciding(null); reload()
    } catch (e) {
      const message = e instanceof ApiError ? e.message : (e as Error).message
      setProblem(message)
      // The text moved under the reviewer: show them the current text, never approve what they did not read.
      if (e instanceof ApiError && e.status === 409) { setDeciding(null); reload(); toast(message, 'error') }
    } finally { setBusy(false) }
  }

  return <section className="page release-admin">
    <PageHead title={t('Approve updates', 'اعتماد التحديثات', 'Updates goedkeuren')} icon={ShieldCheck} />
    <ErrorMessage error={error} />
    {loading ? <Skeleton lines={4} /> : data && <>
      <p className={`ra-activation${data.activation.enabled && data.activation.status === 'confirmed' ? ' on' : ''}`} role="status">{activationText(data.activation)}</p>
      {data.data.length === 0
        ? <EmptyState title={t('No updates in the running code', 'لا توجد تحديثات في الكود العامل', 'Geen updates in de draaiende code')}>{t('Release notes are files in the code; when one ships it appears here as a draft.', 'ملاحظات الإصدار ملفات في الكود؛ عند شحن أحدها يظهر هنا كمسودة.', 'Releasenotes zijn bestanden in de code; zodra er een meekomt, verschijnt die hier als concept.')}</EmptyState>
        : data.data.map(r => <ReleaseCard key={r.key} release={r} review={reviewLabel(r)} deploy={deployLabel(r)} blocked={cannotApprove(r)} onApprove={() => open(r, 'approve')} onWithdraw={() => open(r, 'withdraw')} />)}
    </>}
    {deciding && <Dialog title={deciding.action === 'approve' ? t('Approve this update?', 'اعتماد هذا التحديث؟', 'Deze update goedkeuren?') : t('Withdraw this update?', 'سحب هذا التحديث؟', 'Deze update intrekken?')} onClose={() => !busy && setDeciding(null)}>
      <p><strong>{deciding.release.preview.title.en}</strong> <span className="muted small">({deciding.release.key})</span></p>
      {deciding.action === 'approve'
        ? <>
          <p>{t('People will read exactly the text you reviewed, in their language. This is the fingerprint you approve; if the text changes, the server refuses and you review again:', 'سيقرأ الناس النص الذي راجعته بالضبط بلغتهم. هذه هي البصمة التي تعتمدها؛ إن تغيّر النص يرفض الخادم فتراجع من جديد:', 'Mensen lezen precies de tekst die je hebt nagekeken, in hun taal. Dit is de vingerafdruk die je goedkeurt; verandert de tekst, dan weigert de server en kijk je opnieuw na:')}</p>
          <code className="ra-hash" dir="ltr">{deciding.release.content_hash}</code>
          <label className="inline"><input type="checkbox" checked={read} onChange={e => setRead(e.target.checked)} data-autofocus />{t('I read the text in Arabic, Dutch and English.', 'قرأتُ النص بالعربية والهولندية والإنجليزية.', 'Ik heb de tekst in het Arabisch, Nederlands en Engels gelezen.')}</label>
          <p className="muted small">{t('You may be asked for your password.', 'قد يُطلب منك إدخال كلمة المرور.', 'Je wordt mogelijk om je wachtwoord gevraagd.')}</p>
        </>
        : <p>{t('It disappears for everyone at once. You can approve it again later.', 'يختفي عند الجميع فورًا. يمكنك اعتماده مجددًا لاحقًا.', 'Het verdwijnt meteen voor iedereen. Je kunt het later opnieuw goedkeuren.')}</p>}
      <ErrorMessage error={problem} />
      <div className="rel-actions">
        <button type="button" className={deciding.action === 'approve' ? 'primary' : 'danger'} disabled={busy || (deciding.action === 'approve' && !read)} onClick={() => void decide()}>
          {deciding.action === 'approve' ? t('Approve', 'اعتماد', 'Goedkeuren') : t('Withdraw', 'سحب', 'Intrekken')}</button>
        <button type="button" className="quiet" disabled={busy} onClick={() => setDeciding(null)}>{t('Cancel', 'إلغاء', 'Annuleren')}</button>
      </div>
    </Dialog>}
  </section>
}

function ReleaseCard({ release: r, review, deploy, blocked, onApprove, onWithdraw }: { release: AdminRelease; review: string; deploy: string; blocked: string | null; onApprove: () => void; onWithdraw: () => void }) {
  const t = useText(), [lang, setLang] = useState<Lang>('en'), p = r.preview
  const changed = r.review_status === 'approved' && r.approved_hash !== r.content_hash
  const pick = (x: Texts | undefined | null) => x?.[lang] ?? ''
  const langs: [Lang, string][] = [['en', 'English'], ['ar', 'العربية'], ['nl', 'Nederlands']]
  return <article className="panel ra-card" aria-labelledby={`ra-${r.key}`}>
    <h2 id={`ra-${r.key}`}>{p.title.en} <span className="muted small">{r.key}</span></h2>
    <ul className="ra-status" aria-label={t('Status', 'الحالة', 'Status')}>
      <li className={`ra-chip ${r.review_status ?? 'none'}`}>{review}</li>
      <li className="ra-chip">{deploy}</li>
      <li className={`ra-chip${r.visible ? ' on' : ''}`}>{r.visible ? t('Visible to people', 'ظاهر للناس', 'Zichtbaar voor mensen') : t('Not visible', 'غير ظاهر', 'Niet zichtbaar')}</li>
      {r.importance === 'important' && <li className="ra-chip warn">{t('Important', 'مهم', 'Belangrijk')}</li>}
    </ul>
    {changed && <p className="error" role="alert">{t('The text changed after it was approved, so the approval no longer applies and nobody sees it. Review and approve again.', 'تغيّر النص بعد اعتماده، فلم ينطبق الاعتماد ولا يراه أحد. راجعه واعتمده من جديد.', 'De tekst is na het goedkeuren veranderd; de goedkeuring geldt niet meer en niemand ziet hem. Kijk opnieuw na en keur opnieuw goed.')}</p>}
    <p className="muted small">{t('Fingerprint', 'البصمة', 'Vingerafdruk')}: <code dir="ltr">{r.content_hash.slice(0, 16)}…</code></p>
    <details className="ra-preview">
      <summary>{t('Read the exact text', 'اقرأ النص بالضبط', 'Lees de exacte tekst')}</summary>
      <div role="group" aria-label={t('Language', 'اللغة', 'Taal')} className="ra-langs">
        {langs.map(([code, label]) => <button key={code} type="button" className={lang === code ? 'primary' : 'quiet'} aria-pressed={lang === code} onClick={() => setLang(code)}>{label}</button>)}
      </div>
      <div lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'} className="ra-text">
        <h3>{pick(p.title)}</h3>
        <p>{pick(p.summary)}</p>
        <ul>{p.items.map((item, i) => {
          const feature = item.feature ? p.features.find(f => f.id === item.feature) : undefined
          return <li key={i}><strong>[{item.type}]</strong> {pick(item.title) || pick(feature?.name)}: {pick(item.body) || pick(feature?.description)}{item.link ? ` → ${item.link}` : ''}{feature ? ` → ${feature.route}` : ''}</li>
        })}</ul>
        {p.tours.map(tour => <div key={tour.id}><h4>{pick(tour.title)}</h4><ol>{tour.steps.map((s, i) => <li key={i}><strong>{pick(s.title)}</strong>: {pick(s.body)} <span className="muted small" dir="ltr">({s.target})</span></li>)}</ol></div>)}
      </div>
    </details>
    <div className="rel-actions">
      <button type="button" className="primary" disabled={blocked !== null} onClick={onApprove}>{r.review_status === 'approved' ? t('Approve the new text', 'اعتماد النص الجديد', 'Nieuwe tekst goedkeuren') : t('Approve', 'اعتماد', 'Goedkeuren')}</button>
      {r.review_status === 'approved' && <button type="button" className="danger" onClick={onWithdraw}>{t('Withdraw', 'سحب', 'Intrekken')}</button>}
    </div>
    {blocked && <p className="muted small" role="note">{blocked}</p>}
  </article>
}
