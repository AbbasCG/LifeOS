import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import TimelinePage from '../features/timeline/TimelinePage'
import { AccountCard, type ConnectedAccount } from '../features/connected/AccountCard'
import IntegrationsSettings from '../features/settings/IntegrationsSettings'
import { DayDial } from '../features/today/DayDial'
import DayPlanPage from '../features/today/DayPlanPage'
import { isValidZone } from '../lib/dial'
import type { TimelineData } from '../lib/timeline'
import type { TodayData } from '../lib/api'

type Route = { match: RegExp; method?: string; body: unknown; status?: number }
function mockApi(routes: Route[]) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes.find(r => r.match.test(url) && (!r.method || r.method === (init?.method || 'GET')))
    return new Response(JSON.stringify(route ? route.body : {}), { status: route ? route.status ?? 200 : 404 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const wrap = (children: ReactNode, path = '/') => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[path]}><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
const user = { match: /\/api\/user$/, body: { id: 1, name: 'A', email: 'a@x.io' } }
const urls = (fetcher: ReturnType<typeof mockApi>) => fetcher.mock.calls.map(c => String(c[0]))
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals() })

const timeline = (day: string): TimelineData => ({
  range: { from: day, to: day, timezone: 'UTC', day_start: `${day}T00:00:00Z` },
  items: [
    { id: 'ev:x1', kind: 'event', source: 'google', source_label: 'Google Calendar', account_id: 4, account: 'me@gmail.com', title: 'Client call', starts_at: `${day}T10:00:00Z`, ends_at: `${day}T11:00:00Z`, all_day: false, area: null, read_only: true, status: 'confirmed', recurring: false, moved_from: `${day}T09:00:00Z`, link: 'https://calendar.google.com/x', conflict: true, meta: {} },
    { id: 'ev:e2', kind: 'event', source: 'lifeos', source_label: 'LifeOS', account_id: null, account: null, title: 'Write report', starts_at: `${day}T10:30:00Z`, ends_at: `${day}T11:30:00Z`, all_day: false, area: 'work', read_only: false, status: 'confirmed', recurring: false, moved_from: null, link: '/calendar', conflict: true, meta: {} },
    { id: 'xt:5', kind: 'external_task', source: 'todoist', source_label: 'Todoist', account_id: 6, account: 'me@todoist.test', title: 'Call bank', starts_at: `${day}T23:59:00Z`, ends_at: null, all_day: true, area: null, read_only: true, status: 'open', recurring: false, moved_from: null, link: '/tasks', conflict: false, meta: { external_id: 5 } },
  ],
  conflicts: [
    { type: 'busy_task', severity: 'high', at: `${day}T10:30:00Z`, minutes: 30, items: ['ev:e2', 'ev:x1'], titles: ['Write report', 'Client call'] },
    { type: 'moved', severity: 'info', at: `${day}T10:00:00Z`, minutes: 0, items: ['ev:x1'], titles: ['Client call'], from: `${day}T09:00:00Z`, to: `${day}T10:00:00Z` },
  ],
  facets: { sources: [{ key: 'lifeos', label: 'LifeOS', count: 1 }, { key: 'google', label: 'Google Calendar', count: 1 }, { key: 'todoist', label: 'Todoist', count: 1 }], accounts: [{ id: 4, provider: 'google', label: 'me@gmail.com', source_label: 'Google Calendar', status: 'active', count: 1 }], areas: [{ key: 'work', count: 1 }], kinds: [{ key: 'event', count: 2 }, { key: 'external_task', count: 1 }] },
})

describe('unified timeline', () => {
  it('shows every source with its label, read-only state, conflicts and changes', async () => {
    const day = new Date().toLocaleDateString('en-CA')
    mockApi([user, { match: /\/api\/timeline\?/, body: timeline(day) }])
    render(wrap(<TimelinePage />))
    const call = (await screen.findByText('Client call', { selector: 'strong' })).closest('li')!
    expect(call).toHaveClass('src-google', 'has-conflict')
    expect(within(call).getByText(/Google Calendar · me@gmail.com/)).toBeInTheDocument()
    expect(within(call).getByText('Read-only')).toBeInTheDocument()
    expect(within(call).getByText(/moved from/)).toBeInTheDocument()
    expect(within(call).getByRole('link', { name: 'Open in Google Calendar' })).toHaveAttribute('target', '_blank')
    expect(screen.getByText('Write report', { selector: 'strong' }).closest('li')).not.toHaveTextContent('Read-only')
    expect(screen.getByText('1 conflict(s) to look at')).toBeInTheDocument()
    expect(screen.getByText(/Planned work “Write report” falls during “Client call”/)).toBeInTheDocument()
    expect(screen.getByText('1 change(s) from connected calendars')).toBeInTheDocument()
  })
  it('filters on the server and copies connected tasks without touching the source', async () => {
    const day = new Date().toLocaleDateString('en-CA')
    const fetcher = mockApi([user, { match: /\/api\/timeline\?/, body: timeline(day) }, { match: /\/api\/connected\/tasks\/5\/copy$/, method: 'POST', body: { task: { id: 9 } }, status: 201 }])
    render(wrap(<TimelinePage />))
    fireEvent.click(await screen.findByRole('button', { name: /Copy to LifeOS/ }))
    await waitFor(() => expect(urls(fetcher)).toContain('/api/connected/tasks/5/copy'))
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Google Calendar/ }))
    await waitFor(() => expect(urls(fetcher).some(u => u.includes('sources=google'))).toBe(true))
    fireEvent.click(screen.getByRole('radio', { name: 'Week' }))
    await waitFor(() => expect(urls(fetcher).some(u => { const q = new URL(u, 'http://x').searchParams; return q.get('from') !== q.get('to') })).toBe(true))
  })
  it('offers next steps when the range is empty', async () => {
    const day = new Date().toLocaleDateString('en-CA')
    mockApi([user, { match: /\/api\/timeline\?/, body: { ...timeline(day), items: [], conflicts: [] } }])
    render(wrap(<TimelinePage />))
    expect(await screen.findByText('A clear stretch')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Connect a calendar' })).toHaveAttribute('href', '/settings/integrations')
  })
})

const account: ConnectedAccount = { id: 4, provider: 'google', email: 'me@gmail.com', display_name: 'Me', status: 'active', last_synced_at: '2027-03-10T08:00:00Z', last_attempt_at: '2027-03-10T08:00:00Z', consecutive_failures: 0, scopes_ok: true, granted_scopes: ['https://www.googleapis.com/auth/calendar.readonly'], sync_mode: 'incremental', last_error: null, events_count: 12, connected_at: null, collections: [], collections_managed: true, recent_runs: [{ id: 1, mode: 'incremental', status: 'partial', trigger: 'manual', started_at: '2027-03-10T08:00:00Z', finished_at: '2027-03-10T08:00:01Z', duration_ms: 1200, upserted: 3, removed: 1, moved: 1, error: 'Could not read Holidays.' }] }
const card = (a: ConnectedAccount, handlers = { onSync: vi.fn(), onReconnect: vi.fn(), onDisconnect: vi.fn(), onSaved: vi.fn() }) => <ul><AccountCard account={a} label="Google Calendar" tasks={false} requiredScopes={['calendar.readonly']} busy={null} {...handlers} /></ul>

describe('connected accounts hub', () => {
  it('shows identity, granted permissions, sync mode and history', () => {
    mockApi([user])
    render(wrap(card(account)))
    expect(screen.getByText('me@gmail.com')).toBeInTheDocument()
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByText('Incremental (changes only)')).toBeInTheDocument()
    expect(screen.getByText('calendar.readonly').closest('.perm')).toHaveClass('ok')
    fireEvent.click(screen.getByRole('button', { name: /Sync history/ }))
    expect(screen.getByText('Partly synced')).toBeInTheDocument()
    expect(screen.getByText('3 updated · 1 removed · 1 moved')).toBeInTheDocument()
    expect(screen.getByText('Could not read Holidays.')).toBeInTheDocument()
  })
  it('never shows success for missing permission, revocation or rate limiting', () => {
    mockApi([user])
    const onReconnect = vi.fn()
    const { unmount } = render(wrap(card({ ...account, scopes_ok: false, granted_scopes: ['openid'], status: 'error', last_error: 'Read access was not granted.' }, { onSync: vi.fn(), onReconnect, onDisconnect: vi.fn(), onSaved: vi.fn() })))
    expect(screen.getByText('Permission missing')).toBeInTheDocument()
    expect(screen.getByText('calendar.readonly').closest('.perm')).toHaveClass('missing')
    expect(screen.queryByRole('button', { name: /Sync now/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Reconnect/ }))
    expect(onReconnect).toHaveBeenCalled()
    unmount()
    render(wrap(card({ ...account, retry_after: new Date(Date.now() + 600_000).toISOString() })))
    expect(screen.getByText('Waiting for provider')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Sync now/ })).toBeDisabled()
  })
  it('reports what a manual sync actually did and explains rate limits', async () => {
    const google = { provider: 'google', label: 'Google Calendar', category: 'calendars', implemented: true, configured: true, status: 'available', scopes: 'Read-only calendars', env_keys: [], redirect_uri: 'https://app/cb', required_scopes: ['calendar.readonly'], accounts: [{ ...account, recent_runs: [] }] }
    mockApi([user, { match: /\/api\/integrations$/, body: { providers: [google], ai_connected_data: false, categories: [{ key: 'calendars', providers: [google] }] } }, { match: /\/api\/integrations\/accounts\/4\/sync$/, method: 'POST', body: { message: 'Google asked LifeOS to slow down.', retry_after: 120 }, status: 429 }])
    render(wrap(<IntegrationsSettings />))
    fireEvent.click(await screen.findByRole('button', { name: /Sync now/ }))
    expect(await screen.findByText(/slow down/)).toBeInTheDocument()
  })
  it('walks new users through connecting their first account', async () => {
    mockApi([user, { match: /\/api\/integrations$/, body: { providers: [], ai_connected_data: false, categories: [] } }])
    render(wrap(<IntegrationsSettings />))
    expect(await screen.findByText('Choose what to include')).toBeInTheDocument()
  })
})

describe('day dial time zone', () => {
  it('labels times in the account time zone, not the browser zone', () => {
    expect(isValidZone('Asia/Tokyo')).toBe(true)
    expect(isValidZone('Not/AZone')).toBe(false)
    const data = { date: '2027-03-10', period: 'morning', briefing: [], reflection_prompt: null, timezone: 'Asia/Tokyo',
      energy: { checkin: null, enabled: true, energy: null, workload: null, load_percent: 40, level: 'moderate' },
      focus_time: { free_minutes: 0, slots: [], peak: null, next_task: null },
      timeline: [{ id: 'e1', title: 'Client call', starts_at: '2027-03-10T01:00:00Z', ends_at: '2027-03-10T02:00:00Z', kind: 'fixed', source: 'lifeos', all_day: false }],
      windows: {}, deadlines: [], progress: { tasks: { done: 0, target: 0 }, focus: { done: 0, target: 0 }, habits: { done: 0, target: 0 }, overall: 0 } } as unknown as TodayData
    mockApi([user])
    render(wrap(<DayDial data={data} />))
    expect(screen.getByLabelText(/^Client call, /).getAttribute('aria-label')).toMatch(/10:00/)
  })
})

describe('day plan deep link', () => {
  it('opens the date and variant Copilot linked to', async () => {
    const fetcher = mockApi([user])
    render(wrap(<DayPlanPage />, '/today/plan?date=2027-03-12&variant=deep'))
    await waitFor(() => expect(urls(fetcher).some(u => u.includes('/api/day-plan?') && u.includes('2027-03-12'))).toBe(true))
  })
})
