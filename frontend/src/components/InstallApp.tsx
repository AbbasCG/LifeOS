import { useState } from 'react'
import { CheckCircle2, Download, MoreVertical, Share, Smartphone, SquarePlus, X } from 'lucide-react'
import { Link } from 'react-router'
import { useText } from '../lib/i18n'
import { useToast } from '../lib/toast'
import { useInstallPrompt } from '../lib/pwa'
import { Dialog } from './ui/Shared'

/** The three Share-sheet steps for Safari on iPhone and iPad (no install prompt there). */
export function AppleStepsList() {
  const t = useText()
  return <ol className="install-steps">
    <li><Share size={18} aria-hidden="true" /><span>{t('Tap the Share button (the square with an arrow) in Safari’s toolbar.', 'اضغط زر المشاركة (المربع الذي فيه سهم) في شريط Safari.')}</span></li>
    <li><SquarePlus size={18} aria-hidden="true" /><span>{t('Scroll down and tap “Add to Home Screen”.', 'مرّر للأسفل واضغط «إضافة إلى الشاشة الرئيسية».')}</span></li>
    <li><CheckCircle2 size={18} aria-hidden="true" /><span>{t('Tap “Add”. LifeOS opens from its own icon, full screen.', 'اضغط «إضافة». يُفتح LifeOS من أيقونته الخاصة بملء الشاشة.')}</span></li>
  </ol>
}

/** The steps for Chrome and Edge on Android, when the browser has not handed over its install button. */
export function AndroidStepsList() {
  const t = useText()
  return <ol className="install-steps">
    <li><MoreVertical size={18} aria-hidden="true" /><span>{t('Open the browser menu (the three dots).', 'افتح قائمة المتصفح (النقاط الثلاث).')}</span></li>
    <li><Download size={18} aria-hidden="true" /><span>{t('Tap “Install app” or “Add to Home screen”.', 'اضغط «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».')}</span></li>
    <li><CheckCircle2 size={18} aria-hidden="true" /><span>{t('Tap “Install”. LifeOS opens from its own icon, full screen.', 'اضغط «تثبيت». يُفتح LifeOS من أيقونته الخاصة بملء الشاشة.')}</span></li>
  </ol>
}

/** How to add LifeOS to the home screen where the browser has no install prompt (Safari on iPhone and iPad). */
function AppleSteps({ onClose }: { onClose: () => void }) {
  const t = useText()
  return <Dialog title={t('Add LifeOS to your Home Screen', 'أضف LifeOS إلى الشاشة الرئيسية')} onClose={onClose}>
    <AppleStepsList />
    <p className="muted small">{t('It is the same app and the same account; nothing is installed from a store.', 'هو التطبيق نفسه والحساب نفسه؛ ولا يُثبَّت شيء من متجر.')}</p>
    <div className="toolbar"><button type="button" className="primary" onClick={onClose}>{t('Got it', 'فهمت')}</button></div>
  </Dialog>
}

/** The one button: installs through the browser's own prompt, or shows the steps on iPhone and iPad. Nothing happens until it is tapped. */
function useInstallAction() {
  const installer = useInstallPrompt(), toast = useToast(), t = useText()
  const [steps, setSteps] = useState(false)
  const available = installer.canInstall || installer.apple
  async function go() {
    if (installer.canInstall) {
      if (await installer.install()) toast(t('LifeOS was added to this device.', 'أُضيف LifeOS إلى هذا الجهاز.'))
    } else setSteps(true)
  }
  return { installer, available, go, steps, closeSteps: () => setSteps(false) }
}

/** Settings: always says where this device stands, and installs with one tap where the browser allows it. */
export function InstallCard() {
  const t = useText(), { installer, available, go, steps, closeSteps } = useInstallAction()
  return <section className="panel install-card" aria-label={t('Install the app', 'تثبيت التطبيق')}>
    <h2><Download size={18} aria-hidden="true" />{t('Install the app', 'تثبيت التطبيق')}</h2>
    {installer.installed
      ? <p className="success inline" role="status"><CheckCircle2 size={15} aria-hidden="true" />{t('LifeOS is installed on this device.', 'LifeOS مثبّت على هذا الجهاز.')}</p>
      : <>
        <p className="muted">{t('Open LifeOS from your home screen, full screen, even offline.', 'افتح LifeOS من الشاشة الرئيسية بملء الشاشة، حتى دون اتصال.')}</p>
        {available
          ? <div className="toolbar"><button type="button" className="primary" onClick={() => void go()}><Download size={16} aria-hidden="true" />{installer.canInstall ? t('Install app', 'تثبيت التطبيق') : t('How to install', 'كيف أثبّته')}</button></div>
          : <p className="muted small">{t('No install button here. Try “Install app” or “Add to Home screen” in your browser’s menu.', 'لا يوجد زر تثبيت هنا. جرّب «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية» من قائمة المتصفح.')}</p>}
      </>}
    {steps && <AppleSteps onClose={closeSteps} />}
  </section>
}

const DISMISSED = 'lifeos-install-banner'
/**
 * Today, on a phone, in a browser tab: a quiet offer to install, shown only where it can work (the browser gave an
 * install prompt, or it is an iPhone or iPad). "Not now" hides it for good on this device; Settings keeps the option.
 */
export function InstallBanner() {
  const t = useText(), { available, installer, go, steps, closeSteps } = useInstallAction()
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(DISMISSED) === '1' || !window.matchMedia?.('(pointer: coarse)').matches } catch { return true }
  })
  if (hidden || installer.installed || !available) return null
  return <section className="panel install-banner" aria-label={t('Install the app', 'تثبيت التطبيق')}>
    <Download size={20} aria-hidden="true" />
    <div><strong>{t('Add LifeOS to your home screen', 'أضف LifeOS إلى الشاشة الرئيسية')}</strong><span className="muted small">{t('Opens full screen, like an app.', 'يُفتح بملء الشاشة مثل أي تطبيق.')}</span></div>
    <button type="button" className="primary" onClick={() => void go()}>{installer.canInstall ? t('Install', 'تثبيت') : t('How', 'كيف')}</button>
    <button type="button" className="icon-button" aria-label={t('Not now', 'ليس الآن')} onClick={() => { try { localStorage.setItem(DISMISSED, '1') } catch { /* asked again next time */ } setHidden(true) }}><X size={18} aria-hidden="true" /></button>
    {steps && <AppleSteps onClose={closeSteps} />}
  </section>
}

/**
 * A plain link to the install page, for places everyone sees (the sign-in page, the menu). Hidden once LifeOS runs as an
 * installed app. It goes to a page that works signed out, so the link can also be sent to a phone.
 */
export function InstallLink({ className = 'install-link' }: { className?: string }) {
  const t = useText(), { installed } = useInstallPrompt()
  if (installed) return null
  return <Link className={className} to="/install"><Smartphone size={17} aria-hidden="true" />{t('Get the phone app', 'حمّل تطبيق الجوال')}</Link>
}
