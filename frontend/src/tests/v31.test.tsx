import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import QuickAdd from '../components/layout/QuickAdd'
import { openQuickAddByVoice, spokenHints } from '../lib/quickAdd'
import type { SpeechRecognitionLike } from '../lib/voice'

class FakeRecognition implements SpeechRecognitionLike {
  static last: FakeRecognition | null = null
  lang = ''; continuous = true; interimResults = false; maxAlternatives = 0; started = false
  onresult: SpeechRecognitionLike['onresult'] = null
  onerror: SpeechRecognitionLike['onerror'] = null
  onend: SpeechRecognitionLike['onend'] = null
  constructor() { FakeRecognition.last = this }
  start() { this.started = true }
  stop() { this.onend?.() }
  abort() { this.onend?.() }
  say(text: string) { this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] }) }
}

describe('what a dictated phrase says about when and how important', () => {
  it('reads English', () => {
    expect(spokenHints('call the bank tomorrow, urgent')).toEqual({ when: 'tomorrow', priority: 'urgent' })
    expect(spokenHints('send the report next week')).toEqual({ when: 'nextweek' })
    expect(spokenHints('water the plants whenever')).toEqual({ priority: 'low' })
    expect(spokenHints('buy milk')).toEqual({})
  })
  it('reads Arabic, ignoring hamza and diacritics', () => {
    expect(spokenHints('اتصل بالبنك غداً عاجل')).toEqual({ when: 'tomorrow', priority: 'urgent' })
    expect(spokenHints('ارسل التقرير الأسبوع القادم')).toEqual({ when: 'nextweek' })
    expect(spokenHints('مهمة مهم اليوم')).toEqual({ when: 'today', priority: 'high' })
  })
})

describe('Quick add by voice', () => {
  beforeEach(() => {
    cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); localStorage.setItem('lifeos-voice-consent', 'yes'); FakeRecognition.last = null
    ;(window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes('/api/assistant/status') ? { voice_allowed: true } : {}), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  })
  afterEach(() => { delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition; vi.unstubAllGlobals() })
  const shell = () => render(<ThemeProvider><LanguageProvider><ToastProvider><MemoryRouter><QuickAdd /></MemoryRouter></ToastProvider></LanguageProvider></ThemeProvider>)

  it('opens already listening, and a spoken phrase fills the text and the chips for the user to check', async () => {
    shell()
    act(() => openQuickAddByVoice())
    await waitFor(() => expect(FakeRecognition.last?.started).toBe(true))
    act(() => FakeRecognition.last!.say('call the bank tomorrow urgent'))
    expect(screen.getByLabelText('Task')).toHaveValue('call the bank tomorrow urgent')
    expect(screen.getByRole('radio', { name: 'Tomorrow' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Urgent' })).toHaveAttribute('aria-checked', 'true')
    // Nothing is saved until the user taps Add.
    expect(vi.mocked(fetch).mock.calls.some(c => String(c[0]).includes('/api/tasks'))).toBe(false)
  })

  it('asks before listening the first time on a device', async () => {
    localStorage.removeItem('lifeos-voice-consent')
    shell()
    act(() => openQuickAddByVoice())
    expect(await screen.findByRole('button', { name: 'Allow and start' })).toBeInTheDocument()
    expect(FakeRecognition.last).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Allow and start' }))
    expect(FakeRecognition.last?.started).toBe(true)
  })

  it('does not offer the microphone when the account has switched voice input off', async () => {
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes('/api/assistant/status') ? { voice_allowed: false } : {}), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    shell()
    act(() => openQuickAddByVoice())
    await waitFor(() => expect(screen.queryByRole('button', { name: /Dictate a message|Stop dictation/ })).not.toBeInTheDocument())
  })
})
