import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { useState } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { VoiceButton } from '../features/assistant/VoiceButton'
import { speechLanguage, type SpeechRecognitionLike } from '../lib/voice'

/** A stand-in for the browser's speech recognition that the test drives by hand. */
class FakeRecognition implements SpeechRecognitionLike {
  static last: FakeRecognition | null = null
  lang = ''; continuous = true; interimResults = false; maxAlternatives = 0; started = false; stopped = false
  onresult: SpeechRecognitionLike['onresult'] = null
  onerror: SpeechRecognitionLike['onerror'] = null
  onend: SpeechRecognitionLike['onend'] = null
  constructor() { FakeRecognition.last = this }
  start() { this.started = true }
  stop() { this.stopped = true; this.onend?.() }
  abort() { this.onend?.() }
  say(text: string, isFinal: boolean) { this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] }) }
}

function Composer({ disabled }: { disabled?: boolean }) {
  const [message, setMessage] = useState('Plan')
  return <><textarea aria-label="Message" value={message} onChange={e => setMessage(e.target.value)} /><VoiceButton disabled={disabled} onText={text => setMessage(m => `${m} ${text}`)} /></>
}
const page = (disabled?: boolean) => <ThemeProvider><LanguageProvider><Composer disabled={disabled} /></LanguageProvider></ThemeProvider>

beforeEach(() => {
  cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); FakeRecognition.last = null
  // jsdom has no <dialog> methods.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
})
afterEach(() => { delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition })

describe('voice input in Copilot', () => {
  it('is hidden where the browser has no speech recognition', () => {
    render(page())
    expect(screen.queryByRole('button', { name: 'Dictate a message' })).not.toBeInTheDocument()
  })

  it('asks for consent once, then adds what was said to the message without sending it', () => {
    ;(window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition
    render(page())
    fireEvent.click(screen.getByRole('button', { name: 'Dictate a message' }))
    expect(screen.getByText(/some browsers \(for example Chrome and Edge\) send the audio to their own speech service/i)).toBeInTheDocument()
    expect(FakeRecognition.last).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Allow and start' }))
    expect(localStorage.getItem('lifeos-voice-consent')).toBe('yes')

    const recognition = FakeRecognition.last!
    expect(recognition.started).toBe(true)
    expect(recognition.lang).toMatch(/^en-/)
    expect(recognition.interimResults).toBe(true)
    expect(screen.getByRole('button', { name: 'Stop dictation' })).toHaveAttribute('aria-pressed', 'true')
    act(() => recognition.say('my week around', false))
    expect(screen.getByRole('status')).toHaveTextContent('Listening… “my week around”')
    act(() => recognition.say('my week around meetings', true))
    expect(screen.getByLabelText('Message')).toHaveValue('Plan my week around meetings')

    // Escape stops; the next start does not ask again.
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(recognition.stopped).toBe(true)
    expect(screen.getByRole('button', { name: 'Dictate a message' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Dictate a message' }))
    expect(FakeRecognition.last).not.toBe(recognition)
    expect(screen.queryByText('Allow and start')).not.toBeInTheDocument()
  })

  it('declining consent records nothing, and errors are explained in Arabic', () => {
    ;(window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition
    localStorage.setItem('lifeos-language', 'ar')
    render(page())
    fireEvent.click(screen.getByRole('button', { name: 'إملاء رسالة' }))
    fireEvent.click(screen.getByRole('button', { name: 'ليس الآن' }))
    expect(FakeRecognition.last).toBeNull()
    expect(localStorage.getItem('lifeos-voice-consent')).toBeNull()

    localStorage.setItem('lifeos-voice-consent', 'yes')
    fireEvent.click(screen.getByRole('button', { name: 'إملاء رسالة' }))
    expect(FakeRecognition.last!.lang).toMatch(/^ar-/)
    act(() => { FakeRecognition.last!.onerror?.({ error: 'not-allowed' }); FakeRecognition.last!.onend?.() })
    expect(screen.getByRole('status')).toHaveTextContent('تم حظر الوصول إلى الميكروفون')
  })

  it('stops listening when the composer is disabled (a message is being sent)', () => {
    ;(window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition
    localStorage.setItem('lifeos-voice-consent', 'yes')
    const { rerender } = render(page())
    fireEvent.click(screen.getByRole('button', { name: 'Dictate a message' }))
    rerender(page(true))
    expect(FakeRecognition.last!.stopped).toBe(true)
  })

  it('picks the browser’s regional variant for the app language', () => {
    expect(speechLanguage('en', ['nl-NL', 'en-GB'])).toBe('en-GB')
    expect(speechLanguage('ar', ['nl-NL', 'en-GB'])).toBe('ar-SA')
    expect(speechLanguage('ar', ['ar-EG'])).toBe('ar-EG')
  })
})
