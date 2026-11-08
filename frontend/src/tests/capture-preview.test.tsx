import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import QuickAdd from '../components/layout/QuickAdd'
import { openQuickAdd } from '../lib/quickAdd'

const shell = () => render(<ThemeProvider><LanguageProvider><ToastProvider><MemoryRouter><QuickAdd /></MemoryRouter></ToastProvider></LanguageProvider></ThemeProvider>)

describe('Quick add shows what it understood before saving', () => {
  beforeEach(() => {
    cleanup(); localStorage.clear()
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ voice_allowed: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('shows the time and length from a Dutch phrase, and nothing for plain text', async () => {
    localStorage.setItem('lifeos-language', 'en')
    shell(); act(() => openQuickAdd())
    const input = await screen.findByLabelText('Task')
    fireEvent.change(input, { target: { value: 'buy milk' } })
    expect(screen.queryByText(/Understood:/)).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'bel Ahmed morgen om 17:00 voor 30 minuten' } })
    expect(screen.getByText(/Understood:/)).toHaveTextContent(/Understood:.*(5:00|17:00).*30 min/)
    // Nothing is saved by looking.
    expect(vi.mocked(fetch).mock.calls.some(c => String(c[0]).includes('/api/tasks'))).toBe(false)
  })

  it('says it in Arabic when the app is in Arabic', async () => {
    localStorage.setItem('lifeos-language', 'ar')
    shell(); act(() => openQuickAdd())
    fireEvent.change(await screen.findByLabelText('المهمة'), { target: { value: 'اتصل بأحمد بكرة الساعة 5 مساءً لمدة ساعتين' } })
    expect(screen.getByText(/فُهم:/)).toHaveTextContent(/120 دقيقة/)
  })
})
