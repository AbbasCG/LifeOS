import { useState, type FormEvent } from 'react'
import { ShieldCheck, ShieldAlert, KeyRound, Copy, Download, Monitor, Smartphone, LogOut, History, Check } from 'lucide-react'
import { api } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { useToast } from '../../lib/toast'
import { useSensitiveAction } from '../../lib/sensitive'
import { useAuth } from '../../contexts/AuthContext'
import { useAuditLabel } from '../../lib/labels'
import QrCode from '../../components/ui/QrCode'
import { Dialog, EmptyState, ErrorMessage, Skeleton } from '../../components/ui/Shared'

type Overview = { two_factor_enabled: boolean; two_factor_pending: boolean; two_factor_confirmed_at: string | null; recovery_codes_remaining: number | null }
type Session = { id: string; ip_address: string | null; device: string; last_activity: string; current: boolean }
type AuditEntry = { id: number; action: string; ip_address: string | null; device: string; meta: Record<string, unknown> | null; created_at: string }

function RecoveryCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const t = useText(), toast = useToast(), [saved, setSaved] = useState(false)
  const text = `LifeOS recovery codes\n${codes.join('\n')}\n`
  return <Dialog title={t('Save your recovery codes', 'احفظ رموز الاسترداد')} onClose={() => { if (saved) onClose() }}>
    <p className="muted">{t('Each code works once if you lose access to your authenticator. They will not be shown again.', 'كل رمز يعمل مرة واحدة إذا فقدت الوصول إلى تطبيق المصادقة. لن تُعرض مرة أخرى.')}</p>
    <ul className="recovery-codes" dir="ltr">{codes.map(c => <li key={c}><code>{c}</code></li>)}</ul>
    <div className="toolbar">
      <button className="quiet" onClick={() => { void navigator.clipboard?.writeText(text).then(() => toast(t('Copied.', 'تم النسخ.'))); setSaved(true) }}><Copy size={15} />{t('Copy', 'نسخ')}</button>
      <button className="quiet" onClick={() => { const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = 'lifeos-recovery-codes.txt'; a.click(); URL.revokeObjectURL(url); setSaved(true) }}><Download size={15} />{t('Download', 'تنزيل')}</button>
    </div>
    <label className="inline"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />{t('I have stored these codes somewhere safe', 'حفظت هذه الرموز في مكان آمن')}</label>
    <button className="primary" disabled={!saved} onClick={onClose}><Check size={16} />{t('Done', 'تم')}</button>
  </Dialog>
}

export default function SecuritySettings() {
  const t = useText(), { language } = useLanguage(), toast = useToast(), sensitive = useSensitiveAction(), auth = useAuth(), auditLabel = useAuditLabel()
  const overview = useApi<Overview>('/api/security'), sessions = useApi<Session[]>('/api/sessions'), audit = useApi<{ data: AuditEntry[] }>('/api/security/audit-log')
  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null), [code, setCode] = useState(''), [codes, setCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [disabling, setDisabling] = useState(false), [signingOutOthers, setSigningOutOthers] = useState(false), [password, setPassword] = useState('')
  async function run<T>(fn: () => Promise<T>, success?: string) {
    setBusy(true); setError('')
    try { const r = await fn(); if (success) toast(success); return r } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  function refreshAll() { overview.reload(); sessions.reload(); audit.reload(); void auth.refresh() }
  async function start() { const r = await run(() => sensitive(() => api<{ secret: string; otpauth_uri: string }>('/api/security/two-factor', 'POST'))); if (r) { setSetup(r); setCode('') } }
  async function confirm(e: FormEvent) {
    e.preventDefault()
    const r = await run(() => api<{ recovery_codes: string[] }>('/api/security/two-factor/confirm', 'POST', { code }), t('Two-factor authentication is on.', 'تم تفعيل التحقق بخطوتين.'))
    if (r) { setSetup(null); setCodes(r.recovery_codes); refreshAll() }
  }
  const o = overview.data
  const fmt = (iso: string) => new Date(iso).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })
  const grouped = setup?.secret.match(/.{1,4}/g)?.join(' ')

  return <div className="settings-stack">
    <ErrorMessage error={error} />
    <section className="panel reveal">
      <header className="row"><div><h2>{t('Two-factor authentication', 'التحقق بخطوتين')}</h2><p className="muted">{t('Protect your account with a code from an authenticator app (Google Authenticator, 1Password, Authy, Microsoft Authenticator…).', 'احمِ حسابك برمز من تطبيق مصادقة مثل Google Authenticator أو 1Password أو Authy.')}</p></div>
        {o && <span className={`badge ${o.two_factor_enabled ? 'status-accepted' : 'status-pending'}`}>{o.two_factor_enabled ? <><ShieldCheck size={13} /> {t('On', 'مفعّل')}</> : <><ShieldAlert size={13} /> {t('Off', 'غير مفعّل')}</>}</span>}
      </header>
      {!o ? <Skeleton lines={2} /> : o.two_factor_enabled ? <>
        <p>{t(`Enabled ${o.two_factor_confirmed_at ? fmt(o.two_factor_confirmed_at) : ''}. ${o.recovery_codes_remaining} recovery codes left.`, `مفعّل منذ ${o.two_factor_confirmed_at ? fmt(o.two_factor_confirmed_at) : ''}. يتبقى ${o.recovery_codes_remaining} رموز استرداد.`)}</p>
        {(o.recovery_codes_remaining ?? 0) <= 2 && <p className="banner warning compact"><ShieldAlert size={15} />{t('You are running out of recovery codes. Generate new ones.', 'رموز الاسترداد توشك على النفاد. أنشئ رموزاً جديدة.')}</p>}
        <div className="toolbar">
          <button className="quiet" disabled={busy} onClick={() => void run(async () => { const r = await sensitive(() => api<{ recovery_codes: string[] }>('/api/security/two-factor/recovery-codes', 'POST')); setCodes(r.recovery_codes); refreshAll() })}><KeyRound size={15} />{t('New recovery codes', 'رموز استرداد جديدة')}</button>
          <button className="danger" disabled={busy} onClick={() => setDisabling(true)}>{t('Turn off', 'إيقاف')}</button>
        </div>
      </> : setup ? <div className="two-factor-setup">
        <ol className="setup-steps">
          <li><strong>{t('Scan this code', 'امسح هذا الرمز')}</strong><QrCode value={setup.otpauth_uri} label={t('QR code for your authenticator app', 'رمز QR لتطبيق المصادقة')} /><p className="muted">{t('Can’t scan? Enter this key manually:', 'لا يمكنك المسح؟ أدخل هذا المفتاح يدوياً:')}</p><code className="secret" dir="ltr">{grouped}</code><div className="toolbar"><button type="button" className="quiet" onClick={() => void navigator.clipboard?.writeText(setup.secret).then(() => toast(t('Key copied.', 'تم نسخ المفتاح.')))}><Copy size={15} />{t('Copy key', 'نسخ المفتاح')}</button><a className="quiet" href={setup.otpauth_uri}>{t('Open in authenticator app', 'فتح في تطبيق المصادقة')}</a></div></li>
          <li><strong>{t('Enter the 6-digit code', 'أدخل الرمز المكوّن من ٦ أرقام')}</strong>
            <form onSubmit={confirm} className="toolbar code-form"><label className="sr-only" htmlFor="totp-confirm">{t('Code', 'الرمز')}</label><input id="totp-confirm" dir="ltr" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required value={code} onChange={e => setCode(e.target.value)} placeholder="123 456" /><button className="primary" disabled={busy || code.replace(/\s/g, '').length !== 6}>{t('Verify & turn on', 'تحقق وفعّل')}</button><button type="button" className="quiet" onClick={() => setSetup(null)}>{t('Cancel', 'إلغاء')}</button></form>
          </li>
        </ol>
      </div> : <button className="primary" disabled={busy} onClick={() => void start()}><ShieldCheck size={16} />{t('Set up two-factor authentication', 'إعداد التحقق بخطوتين')}</button>}
    </section>

    <section className="panel reveal">
      <header className="row"><div><h2>{t('Where you’re signed in', 'أماكن تسجيل دخولك')}</h2><p className="muted">{t('Sign out devices you don’t recognise.', 'سجّل الخروج من الأجهزة التي لا تعرفها.')}</p></div>{(sessions.data?.length ?? 0) > 1 && <button className="quiet" disabled={busy} onClick={() => setSigningOutOthers(true)}><LogOut size={15} />{t('Sign out all other devices', 'الخروج من كل الأجهزة الأخرى')}</button>}</header>
      {!sessions.data ? <Skeleton lines={2} /> : <ul className="session-list">{sessions.data.map(s => <li key={s.id}>
        {/iOS|Android/.test(s.device) ? <Smartphone size={18} /> : <Monitor size={18} />}
        <span><strong>{s.device}</strong>{s.current && <span className="badge status-accepted">{t('This device', 'هذا الجهاز')}</span>}<small className="muted">{s.ip_address ?? '—'} · {t('Active', 'نشط')} {fmt(s.last_activity)}</small></span>
        {!s.current && <button className="quiet" disabled={busy} onClick={() => void run(async () => { await sensitive(() => api(`/api/sessions/${s.id}`, 'DELETE')); refreshAll() }, t('Device signed out.', 'تم تسجيل خروج الجهاز.'))}><LogOut size={15} />{t('Sign out', 'خروج')}</button>}
      </li>)}</ul>}
    </section>

    <section className="panel reveal">
      <header className="row"><h2><History size={18} /> {t('Security activity', 'نشاط الأمان')}</h2></header>
      {!audit.data ? <Skeleton lines={3} /> : !audit.data.data.length ? <EmptyState title={t('No activity yet', 'لا يوجد نشاط بعد')} /> : <ul className="audit-list">{audit.data.data.map(entry => <li key={entry.id} className={/failed/.test(entry.action) ? 'warn' : ''}><span className="dot" /><span><strong>{auditLabel(entry.action)}</strong><small className="muted">{fmt(entry.created_at)} · {entry.device}{entry.ip_address ? ` · ${entry.ip_address}` : ''}</small></span></li>)}</ul>}
    </section>

    {codes && <RecoveryCodes codes={codes} onClose={() => setCodes(null)} />}
    {signingOutOthers && <Dialog title={t('Sign out all other devices?', 'الخروج من كل الأجهزة الأخرى؟')} onClose={() => setSigningOutOthers(false)}>
      <form onSubmit={e => { e.preventDefault(); void run(async () => { await api('/api/sessions', 'DELETE', { password }); setSigningOutOthers(false); setPassword(''); refreshAll() }, t('Other devices were signed out.', 'تم تسجيل الخروج من الأجهزة الأخرى.')) }}>
        <label>{t('Password', 'كلمة المرور')}<input type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
        <div className="toolbar"><button type="button" className="quiet" onClick={() => setSigningOutOthers(false)}>{t('Cancel', 'إلغاء')}</button><button className="danger" disabled={busy || !password}>{t('Sign out others', 'إخراج الآخرين')}</button></div>
      </form>
    </Dialog>}
    {disabling && <Dialog title={t('Turn off two-factor authentication?', 'إيقاف التحقق بخطوتين؟')} onClose={() => setDisabling(false)}>
      <p className="muted">{t('Your account will be protected by your password only.', 'سيكون حسابك محمياً بكلمة المرور فقط.')}</p>
      <div className="toolbar"><button className="quiet" onClick={() => setDisabling(false)}>{t('Keep it on', 'إبقاؤه مفعّلاً')}</button><button className="danger" disabled={busy} onClick={() => void run(async () => { await sensitive(() => api('/api/security/two-factor', 'DELETE')); setDisabling(false); refreshAll() }, t('Two-factor authentication is off.', 'تم إيقاف التحقق بخطوتين.'))}>{t('Turn off', 'إيقاف')}</button></div>
    </Dialog>}
  </div>
}
