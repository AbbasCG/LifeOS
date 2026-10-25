/**
 * Dictation for Copilot through the browser's built-in speech recognition (Web Speech API). No library and no LifeOS
 * server is involved: the browser records and transcribes, and some browsers send the audio to their own speech
 * service to do so. LifeOS only receives the text the user then chooses to send.
 */

/** The parts of the Web Speech API that dictation uses (not in the TypeScript DOM library). */
export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
}
type Constructor = new () => SpeechRecognitionLike

function constructor(): Constructor | null {
  const w = window as unknown as { SpeechRecognition?: Constructor; webkitSpeechRecognition?: Constructor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const speechSupported = () => typeof window !== 'undefined' && constructor() !== null

/**
 * The recognition language for the app language: the browser's own regional variant when it matches (e.g. en-GB,
 * ar-EG), otherwise a common default.
 */
export function speechLanguage(language: 'en' | 'ar', preferred: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]): string {
  return preferred.find(l => l.toLowerCase().startsWith(`${language}-`)) ?? (language === 'ar' ? 'ar-SA' : 'en-US')
}

/** Per-device consent to the browser's speech service (asked once, before the first dictation on this device). */
const CONSENT_KEY = 'lifeos-voice-consent'
export function hasVoiceConsent(): boolean {
  try { return localStorage.getItem(CONSENT_KEY) === 'yes' } catch { return false }
}
export function setVoiceConsent(given: boolean) {
  try { if (given) localStorage.setItem(CONSENT_KEY, 'yes'); else localStorage.removeItem(CONSENT_KEY) } catch { /* storage unavailable: ask again next time */ }
}

export type DictationError = 'denied' | 'no-speech' | 'no-microphone' | 'network' | 'language' | 'failed'

/**
 * Start one dictation: interim text is reported while speaking, final text as each phrase ends. It stops by itself
 * after a pause, or with the returned stop function.
 */
export function dictate(lang: string, handlers: { onInterim: (text: string) => void; onFinal: (text: string) => void; onError: (error: DictationError) => void; onEnd: () => void }): () => void {
  const Recognition = constructor()
  if (!Recognition) { handlers.onError('failed'); handlers.onEnd(); return () => {} }
  const recognition = new Recognition()
  recognition.lang = lang
  recognition.continuous = false
  recognition.interimResults = true
  recognition.maxAlternatives = 1
  recognition.onresult = event => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i], text = result[0]?.transcript ?? ''
      if (result.isFinal) handlers.onFinal(text.trim()); else interim += text
    }
    handlers.onInterim(interim.trim())
  }
  const errors: Record<string, DictationError> = { 'not-allowed': 'denied', 'service-not-allowed': 'denied', 'no-speech': 'no-speech', 'audio-capture': 'no-microphone', network: 'network', 'language-not-supported': 'language' }
  // "aborted" is the user (or the page) stopping on purpose.
  recognition.onerror = event => { if (event.error !== 'aborted') handlers.onError(errors[event.error] ?? 'failed') }
  recognition.onend = handlers.onEnd
  try { recognition.start() } catch { handlers.onError('failed'); handlers.onEnd() }
  return () => recognition.stop()
}
