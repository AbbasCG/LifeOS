import { useState } from 'react'
import { Link } from 'react-router'
import { CheckCircle2, Copy, Download, Languages, Smartphone } from 'lucide-react'
import { useText } from '../lib/i18n'
import { useLanguage } from '../contexts/LanguageContext'
import { useToast } from '../lib/toast'
import { useInstallPrompt } from '../lib/pwa'
import { AndroidStepsList, AppleStepsList } from '../components/InstallApp'

/**
 * Get LifeOS on a phone as a web app, from the site itself. Works signed out, so the address can be sent to a phone.
 * One button installs through the browser's own prompt where it offers one; otherwise the steps for Android and for
 * iPhone and iPad are shown (the one for this device first). Nothing installs until a tap.
 */
export default function InstallPage() {
  const t = useText(), toast = useToast(), { language, setLanguage } = useLanguage(), installer = useInstallPrompt()
  const [busy, setBusy] = useState(false)
  async function install() {
    setBusy(true)
    try { if (await installer.install()) toast(t('LifeOS was added to this device.', 'أُضيف LifeOS إلى هذا الجهاز.')) } finally { setBusy(false) }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(`${location.origin}/install`); toast(t('Link copied. Open it on your phone.', 'نُسخ الرابط. افتحه على جوالك.')) } catch { toast(t('Could not copy. Select the address in the browser bar.', 'تعذّر النسخ. حدّد العنوان من شريط المتصفح.'), 'error') }
  }
  const apple = <section key="apple" className="panel install-platform" aria-labelledby="install-apple"><h2 id="install-apple">{t('iPhone and iPad (Safari)', 'iPhone وiPad (Safari)')}</h2><AppleStepsList /></section>
  const android = <section key="android" className="panel install-platform" aria-labelledby="install-android"><h2 id="install-android">{t('Android (Chrome or Edge)', 'Android (‏Chrome أو Edge)')}</h2><AndroidStepsList /></section>
  return <main className="install-page">
    <header className="install-top">
      <Link to="/" className="brand">LifeOS<span>◈</span></Link>
      <button type="button" className="icon-button" aria-label={language === 'ar' ? 'English' : 'العربية'} onClick={() => setLanguage(language === 'ar' ? 'en' : 'ar')}><Languages size={20} /></button>
    </header>
    <section className="install-hero">
      <Smartphone size={34} aria-hidden="true" />
      <h1>{t('Get LifeOS on your phone', 'حمّل LifeOS على جوالك')}</h1>
      <p className="muted">{t('It is a web app: no store, the same account. It opens from your home screen, full screen.', 'تطبيق ويب: دون متجر وبالحساب نفسه. يُفتح من الشاشة الرئيسية بملء الشاشة.')}</p>
      {installer.installed
        ? <p className="success inline" role="status"><CheckCircle2 size={16} aria-hidden="true" />{t('LifeOS is installed on this device.', 'LifeOS مثبّت على هذا الجهاز.')}</p>
        : installer.canInstall && <button type="button" className="primary install-big" disabled={busy} onClick={() => void install()}><Download size={18} aria-hidden="true" />{t('Install app', 'تثبيت التطبيق')}</button>}
      <div className="toolbar">
        <Link className="quiet" to="/">{t('Open the app', 'افتح التطبيق')}</Link>
        <button type="button" className="quiet" onClick={() => void copy()}><Copy size={16} aria-hidden="true" />{t('Copy link', 'نسخ الرابط')}</button>
      </div>
    </section>
    {!installer.installed && (installer.apple ? [apple, android] : [android, apple])}
  </main>
}
