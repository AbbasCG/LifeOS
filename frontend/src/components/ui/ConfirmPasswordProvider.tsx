import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'
import { api, ApiError } from '../../lib/api'
import { SensitiveContext, type SensitiveRunner } from '../../lib/sensitive'
import { useText } from '../../lib/i18n'
import { Dialog, ErrorMessage } from './Shared'

type Pending = { resolve: () => void; reject: (e: Error) => void }

export function ConfirmPasswordProvider({ children }: { children: ReactNode }) {
  const t = useText()
  const [open, setOpen] = useState(false), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const pending = useRef<Pending | null>(null)
  const ask = useCallback(() => new Promise<void>((resolve, reject) => { pending.current = { resolve, reject }; setPassword(''); setError(''); setOpen(true) }), [])
  const run = useCallback<SensitiveRunner>(async action => {
    try { return await action() } catch (e) {
      if (!(e instanceof ApiError && e.status === 423)) throw e
      await ask()
      return await action()
    }
  }, [ask])
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('')
    try { await api('/api/security/confirm-password', 'POST', { password }); setOpen(false); pending.current?.resolve() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  function cancel() { setOpen(false); pending.current?.reject(new Error(t('Password confirmation was cancelled.', 'أُلغي تأكيد كلمة المرور.'))) }
  return <SensitiveContext.Provider value={run}>
    {children}
    {open && <Dialog title={t('Confirm it’s you', 'أكّد هويتك')} onClose={cancel}>
      <form onSubmit={submit} className="confirm-password">
        <p className="muted"><ShieldCheck size={16} /> {t('For your security, enter your password to continue. You won’t be asked again for 15 minutes.', 'لأمانك، أدخل كلمة المرور للمتابعة. لن يُطلب منك ذلك مجدداً لمدة ١٥ دقيقة.')}</p>
        <ErrorMessage error={error} />
        <label>{t('Password', 'كلمة المرور')}<input type="password" data-autofocus required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
        <div className="toolbar"><button type="button" className="quiet" onClick={cancel}>{t('Cancel', 'إلغاء')}</button><button className="primary" disabled={busy || !password}>{busy ? t('Checking…', 'جارٍ التحقق…') : t('Confirm', 'تأكيد')}</button></div>
      </form>
    </Dialog>}
  </SensitiveContext.Provider>
}
