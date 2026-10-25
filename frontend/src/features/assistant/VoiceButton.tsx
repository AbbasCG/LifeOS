import { useEffect, useRef, useState } from 'react'
import { Mic, Square } from 'lucide-react'
import { useText } from '../../lib/i18n'
import { useLanguage } from '../../contexts/LanguageContext'
import { Dialog } from '../../components/ui/Shared'
import { dictate, hasVoiceConsent, setVoiceConsent, speechLanguage, speechSupported, type DictationError } from '../../lib/voice'

/**
 * Microphone button for the Copilot composer. Dictated text is added to the message box for the user to read, edit
 * and send; nothing is ever sent by voice alone. The first use on a device explains that the browser may send the
 * audio to its own speech service, and asks for consent.
 */
export function VoiceButton({ disabled, onText }: { disabled?: boolean; onText: (text: string) => void }) {
  const t = useText(), { language } = useLanguage()
  const [listening, setListening] = useState(false), [interim, setInterim] = useState(''), [error, setError] = useState<DictationError | null>(null), [asking, setAsking] = useState(false)
  const stop = useRef<(() => void) | null>(null)
  // Stop listening when the page goes away or the composer is disabled (e.g. while a message is being sent).
  useEffect(() => () => stop.current?.(), [])
  useEffect(() => { if (disabled) stop.current?.() }, [disabled])
  useEffect(() => {
    if (!listening) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') stop.current?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [listening])
  if (!speechSupported()) return null

  function start() {
    setError(null); setInterim(''); setListening(true)
    stop.current = dictate(speechLanguage(language === 'ar' ? 'ar' : 'en'), {
      onInterim: setInterim,
      onFinal: text => { if (text) onText(text) },
      onError: setError,
      onEnd: () => { setListening(false); setInterim(''); stop.current = null },
    })
  }
  function toggle() {
    if (listening) { stop.current?.(); return }
    if (!hasVoiceConsent()) { setAsking(true); return }
    start()
  }
  const messages: Record<DictationError, string> = {
    denied: t('Microphone access was blocked. Allow it in your browser’s site settings to dictate.', 'تم حظر الوصول إلى الميكروفون. اسمح به من إعدادات الموقع في متصفحك للإملاء.'),
    'no-speech': t('Didn’t catch anything. Try again a little closer to the microphone.', 'لم يُلتقط أي كلام. حاول مجدداً بالقرب من الميكروفون.'),
    'no-microphone': t('No microphone was found.', 'لم يُعثر على ميكروفون.'),
    network: t('Your browser’s speech service could not be reached. You can still type.', 'تعذّر الوصول إلى خدمة الكلام في متصفحك. يمكنك الكتابة بدلاً من ذلك.'),
    language: t('Your browser can’t take dictation in this language.', 'لا يدعم متصفحك الإملاء بهذه اللغة.'),
    failed: t('Dictation stopped unexpectedly. You can still type.', 'توقف الإملاء بشكل غير متوقع. يمكنك الكتابة بدلاً من ذلك.'),
  }
  return <>
    <button type="button" className={`quiet voice-button${listening ? ' listening' : ''}`} disabled={disabled && !listening} aria-pressed={listening} onClick={toggle}
      aria-label={listening ? t('Stop dictation', 'إيقاف الإملاء') : t('Dictate a message', 'إملاء رسالة')} title={listening ? t('Stop (Esc)', 'إيقاف (Esc)') : t('Dictate', 'إملاء')}>
      {listening ? <Square size={15} /> : <Mic size={17} />}
    </button>
    <p className="voice-status muted small" role="status" aria-live="polite">
      {listening ? (interim ? `${t('Listening…', 'جارٍ الاستماع…')} “${interim}”` : t('Listening… speak now. The text goes into the message box; nothing is sent until you press send.', 'جارٍ الاستماع… تحدّث الآن. يُضاف النص إلى مربع الرسالة؛ لا يُرسل شيء حتى تضغط إرسال.')) : error ? messages[error] : ''}
    </p>
    {asking && <Dialog title={t('Dictate with your browser?', 'الإملاء عبر متصفحك؟')} onClose={() => setAsking(false)}>
      <p>{t('Dictation uses your browser’s speech recognition. Some browsers (for example Chrome and Edge) send the audio to their own speech service to turn it into text; LifeOS never receives or stores audio.', 'يستخدم الإملاء التعرّف على الكلام في متصفحك. بعض المتصفحات (مثل Chrome وEdge) ترسل الصوت إلى خدمة الكلام الخاصة بها لتحويله إلى نص؛ لا يستقبل LifeOS أي صوت ولا يخزّنه.')}</p>
      <p className="muted small">{t('The text appears in the message box so you can check it before sending. You can turn voice input off in the AI Control Center.', 'يظهر النص في مربع الرسالة لتراجعه قبل الإرسال. يمكنك إيقاف الإدخال الصوتي من مركز التحكم بالذكاء الاصطناعي.')}</p>
      <div className="toolbar"><button type="button" className="quiet" onClick={() => setAsking(false)}>{t('Not now', 'ليس الآن')}</button>
        <button type="button" className="primary" onClick={() => { setVoiceConsent(true); setAsking(false); start() }}><Mic size={15} />{t('Allow and start', 'السماح والبدء')}</button></div>
    </Dialog>}
  </>
}
