import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { AuthProvider } from '../contexts/AuthContext'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { ConfirmPasswordProvider } from '../components/ui/ConfirmPasswordProvider'
import ProviderConfiguration from '../features/settings/ProviderConfiguration'
import type { ProviderConfig } from '../lib/integrationsAdmin'

const SECRET = 'my-very-secret-value'
const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  provider: 'google', name: { en: 'Google Calendar', ar: 'تقويم Google' }, docs_url: 'https://developers.google.com/calendar/api',
  scopes: [{ id: 'calendar.readonly', required: true, label: { en: 'Read', ar: 'قراءة' } }, { id: 'calendar.events', required: false, label: { en: 'Write', ar: 'كتابة' } }],
  configured: false, source: 'none', client_id: null, has_secret: false, redirect_uri: null, suggested_redirect_uri: 'https://app.lifeos.test/api/integrations/google/callback',
  rotated_at: null, connections_allowed: true, secret_unreadable: false, updated_at: null, updated_by: null, ...over,
})

type Call = { method: string; url: string; body?: Record<string, unknown> }
let calls: Call[], list: ProviderConfig[], user: Record<string, unknown>, testAnswer: unknown, audit: unknown[]
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
function server() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === '/api/user') return json(user)
    if (/\/credentials$/.test(url)) return json({ data: list })
    if (/\/credentials\/[a-z_]+\/test$/.test(url)) return json({ data: testAnswer })
    if (/\/credentials\/[a-z_]+\/enabled$/.test(url) || /\/credentials\/[a-z_]+$/.test(url)) return json({ data: list[0] })
    if (/\/audit$/.test(url)) return json({ data: audit })
    return json({})
  }))
}
const shell = () => render(<ThemeProvider><LanguageProvider><ToastProvider><AuthProvider><ConfirmPasswordProvider><MemoryRouter><ProviderConfiguration /></MemoryRouter></ConfirmPasswordProvider></AuthProvider></ToastProvider></LanguageProvider></ThemeProvider>)
const writes = () => calls.filter(c => c.method !== 'GET')

beforeEach(() => {
  cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en')
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
  user = { id: 1, name: 'Admin', email: 'a@example.test', is_admin: true, two_factor_enabled: true }
  list = [provider()]; audit = []
  testAnswer = { provider: 'google', ok: true, contacted_provider: false, checks: [{ id: 'client_id', ok: true }, { id: 'secret_readable', ok: true }, { id: 'redirect_matches', ok: true }, { id: 'sign_in_address', ok: true }, { id: 'connections_allowed', ok: true }] }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('provider configuration', () => {
  it('is for administrators only and asks the server for nothing otherwise', async () => {
    user = { ...user, is_admin: false }
    server()
    shell()
    await waitFor(() => expect(calls.some(c => c.url === '/api/user')).toBe(true))
    await new Promise(r => setTimeout(r, 20))
    expect(screen.queryByRole('heading', { name: 'Provider configuration' })).toBeNull()
    expect(calls.some(c => /admin\/integrations/.test(c.url))).toBe(false)
  })

  it('lists each provider with its state, where the client comes from and the last change', async () => {
    list = [provider({ configured: true, source: 'database', client_id: 'cid', has_secret: true, updated_at: '2026-11-08T10:00:00+00:00', updated_by: 'Ada' }),
      provider({ provider: 'todoist', name: { en: 'Todoist', ar: 'Todoist' }, configured: true, source: 'environment', connections_allowed: false })]
    server()
    shell()
    expect(await screen.findByRole('heading', { name: 'Provider configuration' })).toBeInTheDocument()
    const google = (await screen.findByRole('heading', { level: 3, name: 'Google Calendar' })).closest('li') as HTMLElement
    expect(within(google).getByText('Ready').closest('.st')).toHaveAttribute('data-s', 'ok')
    expect(within(google).getByText('Saved (hidden)')).toBeInTheDocument()
    expect(within(google).getByText(/Saved in LifeOS \(encrypted\)/)).toBeInTheDocument()
    expect(within(google).getByText(/Last changed.*by Ada/)).toBeInTheDocument()
    const todoist = screen.getByRole('heading', { level: 3, name: 'Todoist' }).closest('li') as HTMLElement
    expect(within(todoist).getByText('Off')).toHaveClass('st')
    expect(within(todoist).getByText('Off')).toHaveAttribute('data-s', 'idle')
    expect(within(todoist).getByText(/From the server’s \.env \(compatibility\)/)).toBeInTheDocument()
  })

  it('saves the client: the redirect address is the generated one, the secret field is a password field, and the secret is gone from the page afterwards', async () => {
    server()
    shell()
    fireEvent.click(await screen.findByRole('button', { name: /Set up/ }))
    const dialog = await screen.findByRole('dialog', { hidden: true })
    expect(within(dialog).getByText('https://app.lifeos.test/api/integrations/google/callback')).toBeInTheDocument()
    const secret = within(dialog).getByLabelText('Client secret') as HTMLInputElement
    expect(secret.type).toBe('password')
    expect(secret.autocomplete).toBe('new-password')
    fireEvent.change(within(dialog).getByLabelText('Client ID'), { target: { value: 'client-1' } })
    fireEvent.change(secret, { target: { value: SECRET } })
    fireEvent.submit(secret.closest('form') as HTMLFormElement)
    await waitFor(() => expect(writes().some(c => c.method === 'PUT')).toBe(true))
    expect(writes().find(c => c.method === 'PUT')?.body).toEqual({ client_id: 'client-1', client_secret: SECRET, redirect_uri: 'https://app.lifeos.test/api/integrations/google/callback' })
    expect(secret.value).toBe('')
    expect(document.body.innerHTML).not.toContain(SECRET)
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain(SECRET)
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain(SECRET)
  })

  it('keeps the stored secret when the field is left empty, and does not require it', async () => {
    list = [provider({ configured: true, source: 'database', client_id: 'cid', has_secret: true })]
    server()
    shell()
    fireEvent.click(await screen.findByRole('button', { name: /Edit/ }))
    const dialog = await screen.findByRole('dialog', { hidden: true })
    const secret = within(dialog).getByLabelText('Client secret') as HTMLInputElement
    expect(secret.required).toBe(false)
    expect(secret.placeholder).toMatch(/Leave empty to keep it/)
    expect(within(dialog).getByText(/To rotate the secret/)).toBeInTheDocument()
    fireEvent.submit(secret.closest('form') as HTMLFormElement)
    await waitFor(() => expect(writes().some(c => c.method === 'PUT')).toBe(true))
    expect(writes().find(c => c.method === 'PUT')?.body).toEqual({ client_id: 'cid', redirect_uri: 'https://app.lifeos.test/api/integrations/google/callback' })
  })

  it('asks for the secret again when it can no longer be read', async () => {
    list = [provider({ configured: false, source: 'none', client_id: 'cid', has_secret: false, secret_unreadable: true })]
    server()
    shell()
    expect(await screen.findByRole('alert')).toHaveTextContent(/can no longer be read/)
    expect(screen.getByText('Secret must be entered again').closest('.st')).toHaveAttribute('data-s', 'bad')
    fireEvent.click(screen.getByRole('button', { name: /Set up/ }))
    expect(((await screen.findByLabelText('Client secret')) as HTMLInputElement).required).toBe(true)
  })

  it('shows the server’s message when saving fails and keeps the dialog open', async () => {
    server()
    const original = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', vi.fn(async (u: string, i?: RequestInit) => (i?.method === 'PUT' ? json({ message: 'The redirect address must be this site’s https address.' }, 422) : original(u, i))))
    shell()
    fireEvent.click(await screen.findByRole('button', { name: /Set up/ }))
    const dialog = await screen.findByRole('dialog', { hidden: true })
    fireEvent.change(within(dialog).getByLabelText('Client ID'), { target: { value: 'client-1' } })
    fireEvent.change(within(dialog).getByLabelText('Client secret'), { target: { value: SECRET } })
    fireEvent.submit(within(dialog).getByLabelText('Client secret').closest('form') as HTMLFormElement)
    expect(await within(dialog).findByText(/must be this site’s https address/)).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain(SECRET)
  })

  it('tests the configuration and says what each check found, without claiming the provider was contacted', async () => {
    list = [provider({ configured: true, source: 'database', client_id: 'cid', has_secret: true })]
    testAnswer = { provider: 'google', ok: false, contacted_provider: false, checks: [{ id: 'client_id', ok: true }, { id: 'secret_readable', ok: true }, { id: 'redirect_matches', ok: false }, { id: 'sign_in_address', ok: true }, { id: 'connections_allowed', ok: true }] }
    server()
    shell()
    fireEvent.click(await screen.findByRole('button', { name: /Test configuration/ }))
    expect(await screen.findByText('Something needs attention.')).toBeInTheDocument()
    expect(screen.getByText(/Fix:/).parentElement).toHaveTextContent('The redirect address is the one this site expects')
    expect(screen.getAllByText(/OK:/)).toHaveLength(4)
    expect(screen.getByText(/does not contact the provider/)).toBeInTheDocument()
    expect(calls.some(c => c.method === 'POST' && /google\/test$/.test(c.url))).toBe(true)
  })

  it('switches new connections off and on, and says connected accounts keep working', async () => {
    list = [provider({ configured: true, source: 'database', client_id: 'cid', has_secret: true })]
    server()
    shell()
    fireEvent.click(await screen.findByRole('button', { name: /^More/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Switch off new connections/ }))
    await waitFor(() => expect(writes().some(c => c.method === 'PATCH')).toBe(true))
    expect(writes().find(c => c.method === 'PATCH')?.body).toEqual({ enabled: false })
    expect(await screen.findByText(/Connected accounts keep working/)).toBeInTheDocument()
  })

  it('asks before removing the saved client', async () => {
    list = [provider({ configured: true, source: 'database', client_id: 'cid', has_secret: true })]
    server()
    shell()
    fireEvent.click(await screen.findByRole('button', { name: /^More/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Remove saved client/ }))
    expect(writes()).toHaveLength(0)
    const dialog = await screen.findByRole('dialog', { hidden: true })
    expect(within(dialog).getByText(/used again/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove', hidden: true }))
    await waitFor(() => expect(writes().some(c => c.method === 'DELETE')).toBe(true))
  })

  it('a failed removal is shown inside the open dialog as an alert, and is cleared when the dialog is reopened', async () => {
    list = [provider({ configured: true, source: 'database', client_id: 'cid', has_secret: true })]
    server()
    const base = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', vi.fn(async (u: string, i?: RequestInit) => i?.method === 'DELETE' ? json({ message: 'The server refused.' }, 500) : base(u, i)))
    shell()
    fireEvent.click(await screen.findByRole('button', { name: /^More/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Remove saved client/ }))
    const dialog = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove', hidden: true }))
    const alert = await within(dialog).findByRole('alert', { hidden: true })
    expect(alert).toHaveTextContent('The server refused.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel', hidden: true }))
    fireEvent.click(screen.getByRole('button', { name: /Remove saved client/ }))
    const again = await screen.findByRole('dialog', { hidden: true })
    expect(within(again).queryByRole('alert', { hidden: true })).toBeNull()
  })

  it('shows the change log on request, with who did what and no secret', async () => {
    audit = [{ id: 2, action: 'integration_credentials_set', at: '2026-11-08T10:00:00+00:00', actor: 'Ada', provider: 'google', secret_changed: true, ok: null },
      { id: 1, action: 'integration_provider_disabled', at: '2026-11-07T10:00:00+00:00', actor: 'Ada', provider: 'todoist', secret_changed: null, ok: null }]
    server()
    shell()
    expect(calls.some(c => /admin\/integrations\/audit/.test(c.url))).toBe(false)
    fireEvent.click(await screen.findByRole('button', { name: 'Show the change log' }))
    expect(await screen.findByText('Saved the client')).toBeInTheDocument()
    expect(screen.getByText('Switched new connections off')).toBeInTheDocument()
    expect(screen.getByText(/secret changed/)).toBeInTheDocument()
  })

  it('speaks Arabic and Dutch', async () => {
    server()
    shell()
    expect(await screen.findByRole('heading', { name: 'Provider configuration' })).toBeInTheDocument()
    cleanup()
    localStorage.setItem('lifeos-language', 'ar')
    server()
    shell()
    expect(await screen.findByRole('heading', { name: 'إعداد المزودين' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { level: 3, name: 'تقويم Google' })).toBeInTheDocument()
    expect(screen.getByText('يتطلب إعداداً')).toBeInTheDocument()
    cleanup()
    localStorage.setItem('lifeos-language', 'nl')
    server()
    shell()
    expect(await screen.findByRole('heading', { name: 'Providerconfiguratie' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { level: 3, name: 'Google Calendar' })).toBeInTheDocument()
    expect(screen.getByText('Instellen nodig')).toBeInTheDocument()
    expect(screen.queryByText('Needs setup')).toBeNull()
  })
})
