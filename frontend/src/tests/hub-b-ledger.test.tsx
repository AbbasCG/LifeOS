import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import IntegrationsSettings from '../features/settings/IntegrationsSettings'

const NOW = Date.parse('2027-03-22T12:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const ahead = (min: number) => new Date(NOW + min * 60_000 - 1000).toISOString()
const account = (over: Record<string, unknown> = {}) => ({ id: 3, provider: 'google', email: 'me@gmail.test', display_name: null, status: 'active', last_synced_at: ago(3), last_error: null, events_count: 2, connected_at: null, collections: [], collections_managed: true, recent_runs: [], ...over })
const provider = (id: string, label: string, accounts: unknown[] = [], over: Record<string, unknown> = {}) => ({ provider: id, label, category: 'calendars', implemented: true, configured: true, status: 'available', scopes: 'x', env_keys: [], redirect_uri: '', accounts, ...over })
let providers: ReturnType<typeof provider>[], integrations: () => Response | Promise<Response>, fetched: number
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
function server() {
  fetched = 0
  integrations = () => json({ providers, ai_connected_data: false, categories: [{ key: 'calendars', providers }] })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (/\/api\/user$/.test(url)) return json({ id: 1, name: 'A', email: 'a@x.io' })
    if (/\/api\/integrations$/.test(url)) { fetched++; return integrations() }
    return json({})
  }))
}
const shell = () => render(<ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider><AuthProvider><IntegrationsSettings /></AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>)
const lang = (l: string) => localStorage.setItem('lifeos-language', l)
const strip = () => document.querySelector('.attention-strip')

beforeEach(() => {
  cleanup(); localStorage.clear(); lang('en'); providers = [provider('google', 'Google Calendar', [account()])]
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW)
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('hub ledger: one honest sentence per state', () => {
  it.each([
    ['en', 'Synced 3 minutes ago', 'Not synced yet', 'Next try in 7 minutes', 'Access revoked', 'Missing permission'],
    ['nl', 'Gesynchroniseerd 3 minuten geleden', 'Nog niet gesynchroniseerd', 'Volgende poging over 7 minuten', 'Toegang ingetrokken', 'Recht ontbreekt'],
    ['ar', `تمت المزامنة ${new Intl.RelativeTimeFormat('ar', { numeric: 'auto' }).format(-3, 'minute')}`, 'لم تتم المزامنة بعد', `المحاولة التالية ${new Intl.RelativeTimeFormat('ar', { numeric: 'auto' }).format(7, 'minute')}`, 'أُلغي الوصول', 'إذن ناقص'],
  ])('%s: ok, never synced, waiting, revoked and missing permission', async (l, ok, never, waiting, revoked, scope) => {
    lang(l)
    providers = [provider('google', 'Google Calendar', [
      account({ id: 1, email: 'ok@x.test' }), account({ id: 2, email: 'never@x.test', last_synced_at: null }),
      account({ id: 3, email: 'wait@x.test', retry_after: ahead(7), status: 'error' }), account({ id: 4, email: 'rev@x.test', status: 'revoked' }), account({ id: 5, email: 'scope@x.test', scopes_ok: false }),
    ])]
    server(); shell()
    const chip = (email: string) => within(screen.getByText(email, { selector: 'bdi' }).closest('.am-id') as HTMLElement).getByText((_, el) => el?.classList.contains('st') ?? false)
    await screen.findByText('ok@x.test')
    expect(chip('ok@x.test')).toHaveTextContent(ok)
    expect(chip('never@x.test')).toHaveTextContent(never)
    expect(chip('wait@x.test')).toHaveTextContent(waiting)
    expect(chip('rev@x.test')).toHaveTextContent(revoked)
    expect(chip('scope@x.test')).toHaveTextContent(scope)
    expect(chip('ok@x.test')).toHaveAttribute('data-s', 'ok')
    expect(chip('wait@x.test')).toHaveAttribute('data-s', 'warn')
    expect(chip('rev@x.test')).toHaveAttribute('data-s', 'bad')
  })

  it('a failing account says what went wrong and when it last worked, without inventing anything', async () => {
    providers = [provider('google', 'Google Calendar', [account({ status: 'error', last_error: 'Google returned 500.', last_synced_at: ago(120) }), account({ id: 4, email: 'n@x.test', status: 'error', last_synced_at: null })])]
    server(); shell()
    expect(await screen.findByText('Last synced 2 hours ago · Google returned 500.')).toBeInTheDocument()
    expect(screen.getAllByText('Sync problem')).toHaveLength(2)
    expect(screen.getByText('No successful sync yet')).toBeInTheDocument()
  })

  it('only broken accounts get the hero Reconnect; healthy rows stay quiet and show the permission preset', async () => {
    providers = [provider('google', 'Google Calendar', [account({ id: 1, email: 'ok@x.test', permissions: { granted: [], effective: [], capabilities: ['read'], presets: ['read_only', 'read_create'], preset: 'read_create', legacy: false, blocked: {}, changed_at: null } }), account({ id: 2, email: 'rev@x.test', status: 'revoked' })])]
    server(); shell()
    await screen.findByText('ok@x.test')
    expect(document.querySelectorAll('.account-mini button.primary')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /^Reconnect/ })).toHaveClass('primary')
    expect(screen.getByText('Can add events')).toHaveClass('scope-chip')
    expect(screen.getByRole('button', { name: 'Add account for Google Calendar' })).not.toHaveClass('primary')
  })
})

describe('needs-attention strip', () => {
  const many = (n: number) => provider('google', 'Google Calendar', Array.from({ length: n }, (_, i) => account({ id: i + 1, email: `a${i}@x.test`, status: 'revoked' })))
  it('is absent when every account is fine', async () => {
    server(); shell(); await screen.findByText('me@gmail.test')
    expect(strip()).toBeNull()
  })
  it.each([[1, 'حساب واحد يحتاج إلى انتباه'], [2, 'حسابان يحتاجان إلى انتباه'], [3, '3 حسابات تحتاج إلى انتباه'], [10, '10 حسابات تحتاج إلى انتباه'], [11, '11 حسابًا يحتاج إلى انتباه'], [100, '100 حساب يحتاج إلى انتباه']])('Arabic plural for %s', async (n, text) => {
    lang('ar'); providers = [many(n)]; server(); shell()
    await waitFor(() => expect(strip()).toHaveTextContent(text))
    expect(screen.getAllByRole('status').some(e => e.textContent === text)).toBe(true)   // announced by the one persistent live region
  })
  it('English and Dutch use one / other', async () => {
    providers = [many(1)]; server(); shell()
    await waitFor(() => expect(strip()).toHaveTextContent('One account needs attention'))
    cleanup(); lang('nl'); providers = [many(4)]; server(); shell()
    await waitFor(() => expect(strip()).toHaveTextContent('4 accounts hebben aandacht nodig'))
  })
  it('its button moves focus to the first account that needs attention', async () => {
    providers = [provider('google', 'Google Calendar', [account({ id: 1, email: 'fine@x.test' }), account({ id: 2, email: 'first@x.test', status: 'revoked' }), account({ id: 3, email: 'second@x.test', status: 'revoked' })])]
    server(); shell()
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }))
    expect(document.activeElement).toHaveAttribute('aria-label', expect.stringMatching(/^Google Calendar, first@x.test/))
  })
  it('the AI-sharing consent row is the last thing on the page', async () => {
    server(); shell(); await screen.findByText('me@gmail.test')
    const consent = document.querySelector('.consent-row')!
    expect(consent.nextElementSibling).toBeNull()
    expect(screen.getByRole('switch', { name: 'Share with external AI' })).not.toBeChecked()
  })
})

describe('loading, error and empty', () => {
  it('shows three skeleton rows and a polite loading message, then the content with no skeleton left', async () => {
    server()
    let release: (r: Response) => void = () => {}
    integrations = () => new Promise<Response>(res => { release = res })
    shell()
    await waitFor(() => expect(document.querySelectorAll('.sk-row')).toHaveLength(3))
    expect(screen.getByText('Loading your connections')).toBeInTheDocument()
    expect(screen.getByText('Loading your connections').getAttribute('role')).toBe('status')
    release(json({ providers, ai_connected_data: false, categories: [{ key: 'calendars', providers }] }))
    await screen.findByText('me@gmail.test')
    expect(document.querySelectorAll('.sk-row')).toHaveLength(0)
    expect(screen.queryByText('Loading your connections')).toBeNull()
  })
  it('an error is a specific card with Retry that reloads and leaves no skeleton behind', async () => {
    server(); integrations = () => json({ message: 'The server is down.' }, 500)
    shell()
    const card = await screen.findByRole('alert')
    expect(card).toHaveClass('state-card')
    expect(card).toHaveTextContent('The server is down.')
    expect(document.querySelectorAll('.sk-row')).toHaveLength(0)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    integrations = () => json({ providers, ai_connected_data: false, categories: [{ key: 'calendars', providers }] })
    const before = fetched
    fireEvent.click(within(card).getByRole('button', { name: 'Retry' }))
    await screen.findByText('me@gmail.test')
    expect(fetched).toBeGreaterThan(before)
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('nothing connected: a headline, the read-only promise, exactly one hero and the unavailable services folded away', async () => {
    providers = [provider('google', 'Google Calendar'), provider('outlook', 'Outlook Calendar'), provider('notion', 'Notion', [], { status: 'planned', implemented: false }), provider('microsoft_todo', 'Microsoft To Do', [], { status: 'needs_configuration', configured: false })]
    server(); shell()
    expect(await screen.findByText('Your calendars and tasks, on one timeline')).toBeInTheDocument()
    expect(screen.getByText(/only reads at first/)).toBeInTheDocument()
    expect(document.querySelectorAll('button.primary')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Connect Google Calendar' })).toHaveClass('primary')
    expect(screen.getByRole('button', { name: 'Connect Outlook Calendar' })).toHaveClass('quiet')
    expect(document.querySelector('.onboarding-mini')).toBeNull()
    const more = screen.getByRole('button', { name: 'More services' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'About Notion' })).toBeNull()
    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'About Notion' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About Microsoft To Do' })).toBeInTheDocument()
  })
  it('the empty headline reads in Arabic', async () => {
    lang('ar'); providers = [provider('google', 'Google Calendar')]; server(); shell()
    expect(await screen.findByText('تقاويمك ومهامك في خط زمني واحد')).toBeInTheDocument()
  })
})
