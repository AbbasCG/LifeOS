import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import IntegrationsSettings from '../features/settings/IntegrationsSettings'
import { AccountCard, type ConnectedAccount } from '../features/connected/AccountCard'
import { MoveDialog } from '../features/timeline/MoveDialog'
import { ProposalCard } from '../features/assistant/ProposalCard'
import { zonedParts, zonedToUtc, type TimelineItem } from '../lib/timeline'
import type { AssistantProposal } from '../lib/api'

type Route = { match: RegExp; method?: string; body: unknown; status?: number }
function mockApi(routes: Route[]) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes.find(r => r.match.test(url) && (!r.method || r.method === (init?.method || 'GET')))
    return new Response(JSON.stringify(route ? route.body : {}), { status: route ? route.status ?? 200 : 404 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
const user = { match: /\/api\/user$/, body: { id: 1, name: 'A', email: 'a@x.io' } }
const bodyOf = (fetcher: ReturnType<typeof mockApi>, method: string) => JSON.parse([...fetcher.mock.calls].reverse().find(c => c[1]?.method === method)![1]!.body as string)
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals() })

describe('time zone helpers', () => {
  it('converts wall-clock times across daylight-saving changes', () => {
    expect(zonedToUtc('2027-03-26', '09:00', 'Europe/Amsterdam').toISOString()).toBe('2027-03-26T08:00:00.000Z')
    expect(zonedToUtc('2027-03-29', '09:00', 'Europe/Amsterdam').toISOString()).toBe('2027-03-29T07:00:00.000Z')
    expect(zonedToUtc('2027-03-29', '09:00', 'Asia/Tokyo').toISOString()).toBe('2027-03-29T00:00:00.000Z')
    expect(zonedParts('2027-03-29T07:00:00Z', 'Europe/Amsterdam')).toEqual({ date: '2027-03-29', time: '09:00' })
  })
})

const feedAccount: ConnectedAccount = { id: 9, provider: 'ics', email: 'calendar.example.org', display_name: 'School', status: 'active', last_synced_at: '2027-03-22T08:00:00Z', last_error: null, events_count: 8, connected_at: null, collections: [{ id: 'feed', name: 'calendar.example.org', color: null, primary: true, included: true }], collections_managed: true, recent_runs: [{ id: 1, mode: 'full', status: 'success', trigger: 'connect', started_at: '2027-03-22T08:00:00Z', finished_at: null, duration_ms: null, upserted: 8, removed: 0, moved: 0, error: null, details: { skipped: 1 } }] }

describe('calendar subscriptions', () => {
  const ics = { provider: 'ics', label: 'Calendar subscription (ICS)', category: 'calendars', implemented: true, configured: true, status: 'available', scopes: 'Reads the events in a calendar feed you subscribe to.', env_keys: [], redirect_uri: '', required_scopes: [], connect_mode: 'url', accounts: [] }
  const hub = (accounts: ConnectedAccount[] = []) => ({ providers: [{ ...ics, accounts }], ai_connected_data: false, categories: [{ key: 'calendars', providers: [{ ...ics, accounts }] }] })
  it('subscribes with a link instead of a sign-in and reports server errors', async () => {
    const fetcher = mockApi([user, { match: /\/api\/integrations$/, body: hub() }, { match: /\/api\/integrations\/ics$/, method: 'POST', body: { message: 'This calendar address points to a private network and cannot be used.', errors: { url: ['This calendar address points to a private network and cannot be used.'] } }, status: 422 }])
    render(wrap(<IntegrationsSettings />))
    const input = await screen.findByLabelText('Calendar address (.ics or webcal)')
    expect(screen.queryByRole('button', { name: /Connect Calendar subscription/ })).toBeNull()
    fireEvent.change(input, { target: { value: 'webcal://intranet/feed.ics' } })
    fireEvent.click(screen.getByRole('button', { name: /Subscribe/ }))
    expect(await screen.findByText(/private network/)).toBeInTheDocument()
    expect(bodyOf(fetcher, 'POST')).toEqual({ url: 'webcal://intranet/feed.ics' })
  })
  it('shows a feed without calendar choices, notes skipped rules and asks for a new link when it stops working', () => {
    mockApi([user])
    const onReconnect = vi.fn()
    const { unmount } = render(wrap(<ul><AccountCard account={feedAccount} label="Calendar subscription (ICS)" tasks={false} requiredScopes={[]} busy={null} onSync={vi.fn()} onReconnect={onReconnect} onDisconnect={vi.fn()} onSaved={vi.fn()} /></ul>))
    expect(screen.queryByText('Calendars to include')).toBeNull()
    expect(screen.getByText(/1 repeating event\(s\) use a pattern LifeOS can’t expand yet/)).toBeInTheDocument()
    expect(screen.getByText('Public or secret feed — no account access')).toBeInTheDocument()
    unmount()
    render(wrap(<ul><AccountCard account={{ ...feedAccount, status: 'revoked', last_error: 'The calendar address no longer works (404).' }} label="ICS" tasks={false} requiredScopes={[]} busy={null} onSync={vi.fn()} onReconnect={onReconnect} onDisconnect={vi.fn()} onSaved={vi.fn()} /></ul>))
    fireEvent.click(screen.getByRole('button', { name: /Use a new link/ }))
    expect(onReconnect).toHaveBeenCalled()
  })
})

describe('move with conflict preview', () => {
  const item: TimelineItem = { id: 'ev:e12', kind: 'event', source: 'lifeos', source_label: 'LifeOS', account_id: null, account: null, title: 'Stand-up', starts_at: '2027-03-23T08:00:00Z', ends_at: '2027-03-23T08:15:00Z', all_day: false, area: null, read_only: false, status: 'flexible', recurring: true, moved_from: null, link: '/calendar', conflict: false, meta: { event_id: 12, occurrence_start: '2027-03-23T08:00:00+00:00' } }
  it('blocks a clashing time, then moves only this occurrence to a free one', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/timeline/preview')) {
        const clash = new URL(url, 'http://x').searchParams.get('starts_at') === '2027-03-23T09:00:00.000Z'
        return new Response(JSON.stringify({ fixed: false, recurring: true, conflicts: clash ? [{ title: 'Client call', source: 'google', source_label: 'Google Calendar', starts_at: '2027-03-23T09:00:00Z', ends_at: '2027-03-23T10:00:00Z', read_only: true, minutes: 15 }] : [] }))
      }
      if (url.endsWith('/api/events/12') && init?.method === 'PATCH') return new Response(JSON.stringify({ data: {} }))
      return new Response(JSON.stringify(url.endsWith('/api/user') ? user.body : {}), { status: url.endsWith('/api/user') ? 200 : 404 })
    })
    vi.stubGlobal('fetch', fetcher)
    const onMoved = vi.fn()
    render(wrap(<MoveDialog item={item} timeZone="Europe/Amsterdam" onClose={vi.fn()} onMoved={onMoved} />))
    expect(screen.getByText('Only this occurrence moves; the rest of the series stays.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '10:00' } })
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '10:15' } })
    expect(await screen.findByText('Client call')).toBeInTheDocument()
    expect(screen.getByText('Google Calendar')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '11:00' } })
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '11:15' } })
    expect(await screen.findByText('This time is free.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    await waitFor(() => expect(onMoved).toHaveBeenCalled())
    const patch = JSON.parse(fetcher.mock.calls.find(c => c[1]?.method === 'PATCH')![1]!.body as string)
    expect(patch).toEqual({ starts_at: '2027-03-23T10:00:00.000Z', ends_at: '2027-03-23T10:15:00.000Z', scope: 'occurrence', occurrence_start: '2027-03-23T08:00:00+00:00' })
  })
})

describe('copilot undo', () => {
  const applied: AssistantProposal = { id: '0b0b0b0b-0000-4000-8000-000000000001', kind: 'schedule', provider: 'local', status: 'applied', summary: '', explanation: [], expires_at: '2027-03-23T10:00:00Z', applied_at: '2027-03-22T10:00:00Z', undo_until: '2027-03-23T10:00:00Z',
    actions: [{ id: 'a1', type: 'create_event', title: 'Studying', starts_at: '2027-03-23T08:00:00Z', ends_at: '2027-03-23T09:00:00Z', minutes: 60, task_id: null }, { id: 'a2', type: 'create_event', title: 'Exercise', starts_at: '2027-03-23T10:00:00Z', ends_at: '2027-03-23T11:00:00Z', minutes: 60, task_id: null }] as AssistantProposal['actions'],
    results: [{ action_id: 'a1', type: 'create_event', event_id: 1 }, { action_id: 'a2', type: 'create_event', event_id: 2 }] }
  it('undoes applied changes and explains what was kept', async () => {
    const undone = { ...applied, status: 'undone', undo_until: null, results: [{ action_id: 'a1', type: 'create_event', event_id: 1, undo: { done: true } }, { action_id: 'a2', type: 'create_event', event_id: 2, undo: { done: false, reason: 'changed since' } }] }
    const fetcher = mockApi([user, { match: /\/undo$/, method: 'POST', body: undone }])
    render(wrap(<ProposalCard proposal={applied} />))
    fireEvent.click(screen.getByRole('button', { name: /Undo these changes/ }))
    expect(await screen.findByText('Undone')).toBeInTheDocument()
    expect(screen.getByText('kept — you changed it')).toBeInTheDocument()
    expect(screen.getByText('Studying').closest('li')).toHaveClass('reverted')
    expect(screen.queryByRole('button', { name: /Undo these changes/ })).toBeNull()
    expect(fetcher.mock.calls.some(c => String(c[0]).endsWith(`/api/assistant/proposals/${applied.id}/undo`))).toBe(true)
  })
})
