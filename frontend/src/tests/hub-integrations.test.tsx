import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import IntegrationsSettings from '../features/settings/IntegrationsSettings'

const run = { id: 1, mode: 'full', status: 'success', trigger: 'manual', started_at: '2027-03-22T08:00:00Z', finished_at: null, duration_ms: 1200, upserted: 4, removed: 2, moved: 1, error: null }
const account = (over: Record<string, unknown> = {}) => ({ id: 3, provider: 'google', email: 'me@gmail.test', display_name: null, status: 'active', last_synced_at: null, last_error: null, events_count: 2, connected_at: null, collections: [], collections_managed: true, recent_runs: [run], ...over })
const google = (acc = account()) => ({ provider: 'google', label: 'Google Calendar', category: 'calendars', implemented: true, configured: true, status: 'available', scopes: 'x', env_keys: [], redirect_uri: '', accounts: [acc] })
let hub: ReturnType<typeof google>, syncAnswer: { status: number; body: unknown }, calls: { method: string; url: string }[]
const payload = () => ({ providers: [hub], ai_connected_data: false, categories: [{ key: 'calendars', providers: [hub] }] })
function server() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(url) })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    if (/\/api\/user$/.test(url)) return json({ id: 1, name: 'A', email: 'a@x.io' })
    if (/\/sync$/.test(url) && method === 'POST') return json(syncAnswer.body, syncAnswer.status)
    if (/\/accounts\/3$/.test(url) && method === 'DELETE') return json({})
    if (/\/api\/integrations$/.test(url)) return json(payload())
    return json({})
  }))
}
/** Alerts of the page itself, not the toaster's screen-reader mirror. */
const pageAlerts = () => screen.queryAllByRole('alert', { hidden: true }).filter(e => !e.closest('.toast-region') && !e.classList.contains('sr-only'))
const shell = () => render(<ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider><AuthProvider><IntegrationsSettings /></AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>)

beforeEach(() => {
  cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); hub = google(); syncAnswer = { status: 200, body: { imported: 1, run } }
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('connected accounts hub: Dutch results', () => {
  it('the sync result toast and the sync history read in Dutch', async () => {
    localStorage.setItem('lifeos-language', 'nl')
    server(); shell()
    fireEvent.click(await screen.findByRole('button', { name: /^Nu synchroniseren/ }))
    expect((await screen.findAllByText('Gesynchroniseerd: 4 bijgewerkt, 2 verwijderd, 1 verplaatst.')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Details van me@gmail.test' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Meer', hidden: true }))
    fireEvent.click(await screen.findByRole('button', { name: 'Synchronisatiegeschiedenis', hidden: true }))
    expect(await screen.findByText('4 bijgewerkt · 2 verwijderd · 1 verplaatst')).toBeInTheDocument()
  })

  it('a partly failed sync says which part in Dutch', async () => {
    localStorage.setItem('lifeos-language', 'nl')
    syncAnswer = { status: 200, body: { imported: 1, run: { ...run, moved: 0, status: 'partial' } } }
    server(); shell()
    fireEvent.click(await screen.findByRole('button', { name: /^Nu synchroniseren/ }))
    expect((await screen.findAllByText(/Gesynchroniseerd: 4 bijgewerkt, 2 verwijderd — sommige agenda’s konden niet worden gelezen\./)).length).toBeGreaterThan(0)
  })
})

describe('connected accounts hub: failures and focus', () => {
  it('a failed Sync now inside the details sheet is announced inside the sheet', async () => {
    syncAnswer = { status: 500, body: { message: 'The provider is down.' } }
    server(); shell()
    fireEvent.click(await screen.findByRole('button', { name: 'Details of me@gmail.test' }))
    const sheet = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(within(sheet).getByRole('button', { name: /Sync now/, hidden: true }))
    await waitFor(() => expect(pageAlerts()).toHaveLength(1))
    const alert = pageAlerts()[0]
    expect(alert).toHaveTextContent('The provider is down.')
    expect(sheet.contains(alert)).toBe(true)
    expect(pageAlerts()).toHaveLength(1)   // not repeated behind the modal sheet
  })

  it('an account that needs attention is announced as an alert, not a polite status', async () => {
    hub = google(account({ status: 'revoked', last_error: 'Access was revoked.' }))
    server(); shell()
    fireEvent.click(await screen.findByRole('button', { name: 'Details of me@gmail.test' }))
    await waitFor(() => expect(pageAlerts().length).toBeGreaterThan(0))
    expect(pageAlerts()[0]).toHaveTextContent('Access was revoked.')
  })

  it('the disconnect confirmation starts on Cancel, describes itself, and focus lands on the heading afterwards', async () => {
    server(); shell()
    fireEvent.click(await screen.findByRole('button', { name: 'Details of me@gmail.test' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect', hidden: true }))
    const cancel = await screen.findByRole('button', { name: 'Cancel', hidden: true })
    expect(cancel).toHaveFocus()
    const described = cancel.getAttribute('aria-describedby') ?? ''
    expect(described).toContain('disconnect-warning')
    expect(document.getElementById('disconnect-warning')).toHaveTextContent(/Imported events and tasks will be removed/)
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect', hidden: true }))
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE')).toBe(true))
    const heading = screen.getByRole('heading', { name: 'Connected accounts', level: 2 })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(heading).toHaveAttribute('tabindex', '-1')
  })
})
