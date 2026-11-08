import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider, useLanguage } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import { ConfirmPasswordProvider } from '../components/ui/ConfirmPasswordProvider'
import SettingsPage from '../features/SettingsPage'
import { useText } from '../lib/i18n'
import { speechLanguage } from '../lib/voice'

function Probe() {
  const t = useText(), { language, setLanguage } = useLanguage()
  return <div>
    <p data-testid="both">{t('English text', 'نص عربي')}</p>
    <p data-testid="three">{t('English text', 'نص عربي', 'Nederlandse tekst')}</p>
    <p data-testid="lang">{language}</p>
    {(['ar', 'en', 'nl'] as const).map(l => <button key={l} onClick={() => setLanguage(l)}>{l}</button>)}
  </div>
}
const shell = (ui: ReactNode) => render(<ThemeProvider><LanguageProvider>{ui}</LanguageProvider></ThemeProvider>)

describe('Dutch as a language', () => {
  beforeEach(() => { cleanup(); localStorage.clear() })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('is read left to right, remembered, and sets the page language', () => {
    localStorage.setItem('lifeos-language', 'nl')
    shell(<Probe />)
    expect(screen.getByTestId('lang')).toHaveTextContent('nl')
    expect(document.documentElement.lang).toBe('nl')
    expect(document.documentElement.dir).toBe('ltr')
    fireEvent.click(screen.getByText('ar'))
    expect(document.documentElement.dir).toBe('rtl')
    fireEvent.click(screen.getByText('nl'))
    expect(document.documentElement.dir).toBe('ltr')
    expect(localStorage.getItem('lifeos-language')).toBe('nl')
  })

  it('ignores an unknown saved language', () => {
    localStorage.setItem('lifeos-language', 'fr')
    shell(<Probe />)
    expect(screen.getByTestId('lang')).toHaveTextContent('ar')
  })

  it('shows a Dutch text where there is one and the English text where there is not', () => {
    localStorage.setItem('lifeos-language', 'nl')
    shell(<Probe />)
    expect(screen.getByTestId('three')).toHaveTextContent('Nederlandse tekst')
    expect(screen.getByTestId('both')).toHaveTextContent('English text')   // no Dutch version: English, not Arabic
    fireEvent.click(screen.getByText('ar'))
    expect(screen.getByTestId('three')).toHaveTextContent('نص عربي')
    fireEvent.click(screen.getByText('en'))
    expect(screen.getByTestId('three')).toHaveTextContent('English text')
  })

  it('dictates in Dutch', () => {
    expect(speechLanguage('nl', [])).toBe('nl-NL')
    expect(speechLanguage('nl', ['en-US', 'nl-BE'])).toBe('nl-BE')
    expect(speechLanguage('en', [])).toBe('en-US')
    expect(speechLanguage('ar', [])).toBe('ar-SA')
  })

  it('can be chosen in Settings and is saved', async () => {
    const saved: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = /\/api\/user$/.test(url) ? { id: 1, name: 'A', email: 'a@x.io' } : /\/api\/settings$/.test(url) && init?.method === 'PUT' ? (saved.push(JSON.parse(String(init.body))), JSON.parse(String(init.body)))
        : /\/api\/settings$/.test(url) ? { language: 'en', theme: 'light', timezone: 'UTC', work_start: '09:00', work_end: '17:00', break_minutes: 10, work_days: [1, 2, 3, 4, 5] } : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    localStorage.setItem('lifeos-language', 'en')
    render(<ThemeProvider><LanguageProvider><ToastProvider><MemoryRouter><AuthProvider><ConfirmPasswordProvider><SettingsPage /></ConfirmPasswordProvider></AuthProvider></MemoryRouter></ToastProvider></LanguageProvider></ThemeProvider>)
    const select = await screen.findByDisplayValue('English')
    expect(screen.getByRole('option', { name: 'Nederlands' })).toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'nl' } })
    expect(document.documentElement.lang).toBe('nl')
    expect(document.documentElement.dir).toBe('ltr')
    fireEvent.click(screen.getAllByRole('button', { name: /Save preferences|Save/ }).find(b => /preferences/i.test(b.textContent ?? '')) ?? screen.getAllByRole('button')[0])
    await waitFor(() => expect(saved.some(s => (s as { language?: string }).language === 'nl')).toBe(true))
  })
})
