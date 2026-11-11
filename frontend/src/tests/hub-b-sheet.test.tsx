import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import IntegrationsSettings from '../features/settings/IntegrationsSettings'

const perms = { granted: ['read', 'sync'], effective: ['read', 'sync'], capabilities: ['read', 'sync', 'export', 'create'], presets: ['read_only', 'read_create'], preset: 'read_only', legacy: false, blocked: {}, changed_at: null }
const sync = (over = {}) => ({ direction: 'inbound', effective_direction: 'inbound', effective_reason: null, available_directions: ['inbound', 'manual'], conflict_policy: 'ask', paused: false, paused_at: null, copies: 0, copies_pending: 0, open_conflicts: 0, last_outbound: null, ...over })
const write = { available: true, granted: true, enabled: true, calendar_id: 'p', calendar_name: 'Personal', copies: 1 }
let acc: Record<string, unknown>
const account = (over = {}) => ({ id: 3, provider: 'google', email: 'me@gmail.test', display_name: null, status: 'active', last_synced_at: new Date(Date.now() - 180_000).toISOString(), last_error: null, events_count: 2, connected_at: null, collections: [], collections_managed: true, recent_runs: [{ id: 1, mode: 'full', status: 'success', trigger: 'manual', started_at: '2027-03-22T08:00:00Z', finished_at: null, duration_ms: 1000, upserted: 4, removed: 2, moved: 0, error: null }], permissions: perms, sync: sync({ open_conflicts: 2, paused: true }), write, ...over })
const shell = () => render(<ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider><AuthProvider><IntegrationsSettings /></AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>)
function server() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (/\/api\/user$/.test(url)) return json({ id: 1, name: 'A', email: 'a@x.io' })
    if (/\/api\/integrations$/.test(url)) { const p = { provider: 'google', label: 'Google Calendar', category: 'calendars', implemented: true, configured: true, status: 'available', scopes: 'x', env_keys: [], redirect_uri: '', required_scopes: [], accounts: [acc] }; return json({ providers: [p], ai_connected_data: false, categories: [{ key: 'calendars', providers: [p] }] }) }
    if (/calendar-write$/.test(url)) return json({ enabled: true, targets: [], links: [] })
    return json({})
  }))
}
const openSheet = async () => { fireEvent.click(await screen.findByRole('button', { name: 'Details of me@gmail.test' })); return await screen.findByRole('dialog', { hidden: true }) }

beforeEach(() => {
  cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); acc = account()
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('account details sheet: progressive disclosure', () => {
  it('tier 1 shows the state, one quiet action for a healthy account and the calendar picker; the rest is folded', async () => {
    acc = account({ collections: [{ id: 'p', name: 'Personal', color: null, primary: true, included: true }] })
    server(); shell()
    const sheet = await openSheet()
    expect(within(sheet).getByText('Connected')).toHaveClass('st')
    expect(within(sheet).getByText('Synced 3 minutes ago')).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: /Sync now/, hidden: true })).toHaveClass('quiet')
    expect(within(sheet).queryByRole('button', { name: 'Reconnect', hidden: true })).toBeNull()
    expect(within(sheet).getByRole('group', { name: 'Calendars to include', hidden: true })).toBeInTheDocument()
    expect(within(sheet).queryByText('Last successful sync', { ignore: '[hidden] *' })).toBeNull()
  })
  it('a broken account gets the hero Reconnect instead of Sync now', async () => {
    acc = account({ status: 'revoked' })
    server(); shell()
    const sheet = await openSheet()
    expect(within(sheet).getByRole('button', { name: 'Reconnect', hidden: true })).toHaveClass('primary')
    expect(within(sheet).queryByRole('button', { name: /Sync now/, hidden: true })).toBeNull()
  })
  it('tier 2 rows carry one-line summaries and open the existing components', async () => {
    server(); shell()
    const sheet = await openSheet()
    const rows = sheet.querySelectorAll('.tier-row')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('What LifeOS may doRead only')
    expect(rows[1]).toHaveTextContent('How it syncsFrom the service · paused2 to review')
    expect(rows[2]).toHaveTextContent('Add eventsOn · Personal')
    const perm = within(sheet).getByRole('button', { name: /What LifeOS may do/, hidden: true })
    expect(perm).toHaveAttribute('aria-expanded', 'false')
    expect(within(sheet).queryByRole('button', { name: 'Manage permissions', hidden: true })).toBeNull()
    fireEvent.click(perm)
    expect(perm).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Manage permissions', hidden: true }))
    expect(await screen.findByRole('dialog', { name: 'Permissions for Google Calendar', hidden: true })).toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: /How it syncs/, hidden: true }))
    expect(within(sheet).getByRole('button', { name: 'Sync settings', hidden: true })).toBeInTheDocument()
  })
  it('"More" toggles aria-expanded and holds the facts, data access and history', async () => {
    server(); shell()
    const sheet = await openSheet()
    const more = within(sheet).getByRole('button', { name: 'More', hidden: true })
    const body = document.getElementById(more.getAttribute('aria-controls')!)!
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(body).toHaveAttribute('hidden')
    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(body).not.toHaveAttribute('hidden')
    expect(within(body).getByText('Last successful sync')).toBeInTheDocument()
    expect(body.querySelector('time')).toHaveAttribute('title')
    fireEvent.click(within(body).getByRole('button', { name: /Sync history/ }))
    expect(within(body).getByText('4 updated · 2 removed')).toBeInTheDocument()
  })
  it('disconnect sits last in its own titled danger zone and opens the unchanged confirmation with the email', async () => {
    server(); shell()
    const sheet = await openSheet()
    const zone = sheet.querySelector('.danger-zone') as HTMLElement
    expect(within(zone).getByRole('heading', { name: 'Remove this connection', hidden: true })).toBeInTheDocument()
    expect(zone.closest('li')?.lastElementChild).toBe(zone)
    fireEvent.click(within(zone).getByRole('button', { name: 'Disconnect', hidden: true }))
    expect(await screen.findByText('me@gmail.test', { selector: '#disconnect-account bdi' })).toBeInTheDocument()
  })
})
