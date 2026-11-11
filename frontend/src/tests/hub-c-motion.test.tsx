import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import IntegrationsSettings from '../features/settings/IntegrationsSettings'
import { Count } from '../features/connected/Count'

const account = (over: Record<string, unknown> = {}) => ({ id: 3, provider: 'google', email: 'me@gmail.test', display_name: null, status: 'active', last_synced_at: new Date(Date.now() - 180_000).toISOString(), last_error: null, events_count: 2, connected_at: null, collections: [], collections_managed: true, recent_runs: [], ...over })
const provider = (id: string, label: string, accounts: unknown[] = []) => ({ provider: id, label, category: 'calendars', implemented: true, configured: true, status: 'available', scopes: 'x', env_keys: [], redirect_uri: '', accounts })
let providers: ReturnType<typeof provider>[], calls: string[], finishSync: () => void
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
function server() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (/\/api\/user$/.test(url)) return json({ id: 1, name: 'A', email: 'a@x.io' })
    if (/\/api\/integrations$/.test(url)) return json({ providers, ai_connected_data: false, categories: [{ key: 'calendars', providers }] })
    if (/accounts\/\d+\/sync$/.test(url)) return new Promise<Response>(resolve => { finishSync = () => resolve(json({ imported: 1, run: null })) })   // a slow sync, ended by the test
    return json({})
  }))
}
const shell = (entry = '/') => render(<ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[entry]}><ToastProvider><AuthProvider><IntegrationsSettings /></AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>)
const realMatchMedia = window.matchMedia
const reduceMotion = (on: boolean) => { window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches: on && /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} })) as never }

beforeEach(() => {
  cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); reduceMotion(false)
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); window.matchMedia = realMatchMedia })

describe('count-up', () => {
  it('shows the first value as it is and counts only when the value changes later', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout'] })
    const view = render(<LanguageProvider><Count value={5} chip /></LanguageProvider>)
    const shown = () => view.container.querySelector('.num')!.textContent
    expect(shown()).toBe('5')
    expect(view.container.querySelector('.pill')).toBeNull()
    view.rerender(<LanguageProvider><Count value={25} chip /></LanguageProvider>)
    expect(shown()).toBe('5')   // starts from the old number, not the new one
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    const mid = Number(shown())
    expect(mid).toBeGreaterThan(5); expect(mid).toBeLessThan(25)
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(shown()).toBe('25')
    expect(view.container.querySelector('.sr-only')).toHaveTextContent('25')
    expect(view.container.querySelector('.pill')).toHaveTextContent('+20 more than before')
    await act(async () => { await vi.advanceTimersByTimeAsync(6100) })
    expect(view.container.querySelector('.pill')).toBeNull()   // the chip is only there for a few seconds
  })
  it('snaps to the new value under reduced motion and still shows the +N chip', () => {
    reduceMotion(true)
    const view = render(<LanguageProvider><Count value={5} chip /></LanguageProvider>)
    view.rerender(<LanguageProvider><Count value={8} chip /></LanguageProvider>)
    expect(view.container.querySelector('.num')!.textContent).toBe('8')
    expect(view.container.querySelector('.pill')).toHaveTextContent('+3 more than before')
  })
})

describe('hub motion state', () => {
  it('marks the row and its status only while the sync runs, then settles once', async () => {
    providers = [provider('google', 'Google Calendar', [account()])]; server(); shell()
    const row = (await screen.findByRole('group', { name: /me@gmail.test/ }))
    expect(row).not.toHaveAttribute('data-syncing')
    fireEvent.click(within(row).getByRole('button', { name: /^Sync now/ }))
    await waitFor(() => expect(row).toHaveAttribute('data-syncing'))
    expect(row.querySelector('.st')).toHaveClass('is-syncing')
    expect(row.querySelector('.st')).toHaveTextContent('Syncing…')
    await act(async () => { finishSync() })
    await waitFor(() => expect(row).not.toHaveAttribute('data-syncing'))
    expect(row.querySelector('.st')).not.toHaveClass('is-syncing')
    expect(row).toHaveAttribute('data-settle', 'ok')
    await waitFor(() => expect(row).not.toHaveAttribute('data-settle'), { timeout: 2000 })   // one settle, then nothing moves
  })

  it('keeps focus on the Sync button while it runs (aria-disabled, not disabled), names the account and announces the start', async () => {
    providers = [provider('google', 'Google Calendar', [account()])]; server(); shell()
    const row = await screen.findByRole('group', { name: /me@gmail.test/ })
    const sync = within(row).getByRole('button', { name: 'Sync now — Google Calendar, me@gmail.test' })
    sync.focus()
    fireEvent.click(sync)
    await waitFor(() => expect(sync).toHaveAttribute('aria-busy', 'true'))
    expect(sync).toHaveAttribute('aria-disabled', 'true')
    expect(sync).not.toBeDisabled()
    expect(sync).toHaveFocus()
    expect(screen.getAllByRole('status').some(e => e.textContent === 'Syncing… Google Calendar, me@gmail.test')).toBe(true)
    fireEvent.click(sync)   // a click while busy does nothing
    expect(calls.filter(c => /sync$/.test(c))).toHaveLength(1)
    await act(async () => { finishSync() })
    await waitFor(() => expect(sync).toHaveAttribute('aria-busy', 'false'))
    expect(sync).toHaveFocus()
  })

  it('marks exactly one row after a connect, the newest of that provider, and clears it', async () => {
    providers = [provider('google', 'Google Calendar', [account({ id: 3 }), account({ id: 9, email: 'new@gmail.test' })]), provider('outlook', 'Outlook', [account({ id: 4, provider: 'outlook', email: 'o@x.test' })])]
    server(); shell('/?connected=google')
    await screen.findByText('new@gmail.test')
    await waitFor(() => expect(document.querySelectorAll('.just-connected')).toHaveLength(1))
    expect(document.querySelector('.just-connected')).toHaveAttribute('data-account', '9')
    await waitFor(() => expect(document.querySelector('.just-connected')).toBeNull(), { timeout: 4000 })
  }, 8000)

  it('staggers the first reveal only when there are three or more rows, and a reload never replays it', async () => {
    providers = [provider('google', 'Google Calendar', [account()]), provider('outlook', 'Outlook', [account({ id: 4, provider: 'outlook', email: 'o@x.test' })])]
    server(); shell()
    await screen.findByText('o@x.test')
    expect(document.querySelectorAll('.hub-rise')).toHaveLength(0)
    cleanup()
    providers = [provider('google', 'Google Calendar', [account()]), provider('outlook', 'Outlook', [account({ id: 4, provider: 'outlook', email: 'o@x.test' })]), provider('todoist', 'Todoist', [account({ id: 5, provider: 'todoist', email: 't@x.test' })])]
    server(); shell()
    await screen.findByText('t@x.test')
    const items = [...document.querySelectorAll<HTMLElement>('.hub-rise')]
    expect(items).toHaveLength(3)
    expect(items.map(i => i.style.getPropertyValue('--i'))).toEqual(['0', '1', '2'])
    // A reload (a sync ends) keeps the same elements, so the entrance cannot run again.
    fireEvent.click(within(screen.getByRole('group', { name: /me@gmail.test/ })).getByRole('button', { name: /^Sync now/ }))
    await act(async () => { finishSync() })
    await waitFor(() => expect(calls.filter(c => c === 'GET /api/integrations').length).toBeGreaterThan(1))
    expect([...document.querySelectorAll('.hub-item')].slice(0, 3)).toEqual(items)
  })

  it('arms the destructive button after 400 ms but keeps it clickable from the first frame', async () => {
    providers = [provider('google', 'Google Calendar', [account()])]; server(); shell()
    fireEvent.click(await screen.findByRole('button', { name: /Details of me@gmail.test/ }))
    const zone = (await screen.findByText('Remove this connection', { selector: 'h3' })).closest('.danger-zone') as HTMLElement
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fireEvent.click(within(zone).getByRole('button', { name: 'Disconnect', hidden: true }))
    const confirm = document.querySelector<HTMLButtonElement>('button.danger-armed')!
    expect(confirm).toHaveClass('danger-armed')
    expect(confirm).toBeEnabled()
    expect(confirm).not.toHaveAttribute('data-armed')
    expect(document.querySelector('[data-autofocus]')).toHaveTextContent('Cancel')
    await act(async () => { await vi.advanceTimersByTimeAsync(390) })
    expect(confirm).not.toHaveAttribute('data-armed')
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(confirm).toHaveAttribute('data-armed')
    // Clicking collapses the row first (not under reduced motion) and then removes it with the reload.
    providers = [provider('google', 'Google Calendar', [])]
    fireEvent.click(confirm)
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(document.querySelector('.am-wrap')).toHaveClass('is-leaving')
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(calls).toContain('DELETE /api/integrations/accounts/3')
  })
})
