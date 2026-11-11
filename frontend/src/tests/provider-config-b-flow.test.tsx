import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { AuthProvider } from '../contexts/AuthContext'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { ConfirmPasswordProvider } from '../components/ui/ConfirmPasswordProvider'
import ProviderConfiguration from '../features/settings/ProviderConfiguration'
import type { ProviderConfig } from '../lib/integrationsAdmin'

const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  provider: 'google', name: { en: 'Google Calendar', ar: 'تقويم Google' }, docs_url: 'https://developers.google.com/calendar/api',
  scopes: [{ id: 'calendar.readonly', required: true, label: { en: 'Read', ar: 'قراءة' } }, { id: 'calendar.events', required: false, label: { en: 'Write', ar: 'كتابة' } }],
  configured: false, source: 'none', client_id: null, has_secret: false, redirect_uri: null, suggested_redirect_uri: 'https://app.lifeos.test/api/integrations/google/callback',
  rotated_at: null, connections_allowed: true, secret_unreadable: false, updated_at: null, updated_by: null, ...over,
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let list: ProviderConfig[], failLoads: number
function server() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/user') return json({ id: 1, name: 'Admin', email: 'a@example.test', is_admin: true, two_factor_enabled: true })
    if (/\/credentials$/.test(url)) return failLoads-- > 0 ? json({ message: 'The server is busy.' }, 500) : json({ data: list })
    return json({})
  }))
}
const shell = () => render(<ThemeProvider><LanguageProvider><ToastProvider><AuthProvider><ConfirmPasswordProvider><MemoryRouter><ProviderConfiguration /></MemoryRouter></ConfirmPasswordProvider></AuthProvider></ToastProvider></LanguageProvider></ThemeProvider>)

beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); failLoads = 0; list = [provider()] })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('provider configuration: states and structure', () => {
  it('shows skeleton rows with a live region first, then the cards in the same place', async () => {
    server()
    const { container } = shell()
    expect(await screen.findByRole('status')).toBeInTheDocument()
    await screen.findByRole('heading', { level: 3, name: 'Google Calendar' })
    expect(container.querySelector('.sk-row')).toBeNull()
    expect(container.querySelectorAll('.pc-card')).toHaveLength(1)
  })

  it('a failed load is an error state card whose Retry loads again and shows the list', async () => {
    failLoads = 1
    server()
    shell()
    const alert = await screen.findByText('The provider configuration could not be loaded')
    expect(alert.closest('.state-card')).toHaveAttribute('data-tone', 'error')
    expect(screen.getByText('The server is busy.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { level: 3, name: 'Google Calendar' })).toBeInTheDocument()
    expect(screen.queryByText('The server is busy.')).toBeNull()
  })

  it('an empty list is a short state card', async () => {
    list = []
    server()
    shell()
    expect(await screen.findByText('No providers to configure')).toBeInTheDocument()
  })

  it('has exactly one primary action per state: Set up when not configured, none when configured', async () => {
    list = [provider(), provider({ provider: 'todoist', name: { en: 'Todoist', ar: 'Todoist' }, configured: true, source: 'database', has_secret: true, client_id: 'c' })]
    server()
    const { container } = shell()
    await screen.findByRole('heading', { level: 3, name: 'Todoist' })
    const [unset, ready] = Array.from(container.querySelectorAll('.pc-card')) as HTMLElement[]
    expect(unset.querySelectorAll('button.primary')).toHaveLength(1)
    expect(within(unset).getByRole('button', { name: /Set up/ })).toHaveClass('primary')
    expect(within(unset).queryByRole('button', { name: /Test configuration/ })).toBeNull()
    expect(within(unset).getByText('Setup needed').closest('.st')).toHaveAttribute('data-s', 'warn')
    expect(ready.querySelectorAll('button.primary')).toHaveLength(0)
    expect(within(ready).getByRole('button', { name: /Edit/ })).toHaveClass('quiet', 'compact')
  })

  it('keeps the switch and the removal behind a More region that toggles aria-expanded', async () => {
    list = [provider({ configured: true, source: 'database', has_secret: true, client_id: 'c' })]
    server()
    shell()
    const more = await screen.findByRole('button', { name: /^More/ })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: /Remove saved client/ })).toBeNull()
    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /Remove saved client/ })).toHaveClass('danger-ghost')
    expect(screen.getByRole('button', { name: /Switch off new connections Google Calendar/ })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows the redirect address left-to-right with a named copy button, scopes as chips and only a masked secret', async () => {
    list = [provider({ configured: true, source: 'database', has_secret: true, client_id: 'c' })]
    server()
    shell()
    const card = (await screen.findByRole('heading', { level: 3, name: 'Google Calendar' })).closest('li') as HTMLElement
    expect(within(card).getByText('https://app.lifeos.test/api/integrations/google/callback')).toHaveAttribute('dir', 'ltr')
    expect(within(card).getByRole('button', { name: /Copy.*redirect address.*Google Calendar/ })).toBeInTheDocument()
    expect(within(card).getByText('calendar.readonly')).toBeInTheDocument()
    expect(within(card).getByText(/optional/)).toBeInTheDocument()
    expect(within(card).getByText('Saved (hidden)')).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: /Provider documentation/ })).toHaveAttribute('href', 'https://developers.google.com/calendar/api')
    expect(card.querySelector('input')).toBeNull()
  })

  it('orders headings h2 then h3 per provider', async () => {
    server()
    shell()
    const h2 = await screen.findByRole('heading', { level: 2, name: 'Provider configuration' })
    expect(h2).toBeInTheDocument()
    expect((await screen.findAllByRole('heading', { level: 3 })).map(h => h.textContent)).toEqual(['Google Calendar'])
  })
})
