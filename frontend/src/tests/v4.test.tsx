import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import { describeRecurrence } from '../lib/recurrence'
import EventForm from '../features/EventForm'
import AuthPage from '../features/AuthPage'
import { ConfirmPasswordProvider } from '../components/ui/ConfirmPasswordProvider'
import { useSensitiveAction } from '../lib/sensitive'
import { encodeQr } from '../lib/qr'
import { api } from '../lib/api'
import { useState } from 'react'
import IntegrationsSettings from '../features/settings/IntegrationsSettings'
import type { CalendarOccurrence, AssistantProposal } from '../lib/api'
import { ProposalCard } from '../features/assistant/ProposalCard'
import AssistantSettings from '../features/settings/AssistantSettings'
import NotificationSettings from '../features/settings/NotificationSettings'
import AutomationSettings from '../features/settings/AutomationSettings'

type Route = { match: RegExp; method?: string; body: unknown; status?: number }
function mockApi(routes: Route[]) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes.find(r => r.match.test(url) && (!r.method || r.method === (init?.method || 'GET')))
    return new Response(JSON.stringify(route ? route.body : {}), { status: route ? route.status ?? 200 : 404 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const lastBody = (fetcher: ReturnType<typeof mockApi>, method: string) => JSON.parse([...fetcher.mock.calls].reverse().find(c => c[1]?.method === method)![1]!.body as string)
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
const user = { match: /\/api\/user$/, body: { id: 1, name: 'A', email: 'a@x.io' } }
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals() })

describe('recurrence', () => {
  const t = (en: string) => en
  it('describes rules in plain language', () => {
    expect(describeRecurrence({ freq: 'weekly', interval: 2, by_weekday: [4, 1], count: 10 }, 'en', t)).toBe('Every 2 weeks · Mon, Thu · 10 times')
    expect(describeRecurrence({ freq: 'daily' }, 'en', t)).toBe('Every day')
  })

  it('creates a weekly series with selected weekdays and an end date', async () => {
    const fetcher = mockApi([user, { match: /\/api\/events$/, method: 'POST', body: { data: { id: 1 } }, status: 201 }])
    const onSaved = vi.fn()
    render(wrap(<EventForm item={{ starts_at: '2027-01-04T09:00:00.000Z', ends_at: '2027-01-04T10:00:00.000Z' }} tasks={[]} onSaved={onSaved} onClose={() => {}} />))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Language class' } })
    fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: 'weekly' } })
    fireEvent.click(screen.getByRole('button', { name: new Date(2026, 0, 7).toLocaleDateString('en', { weekday: 'narrow' }), pressed: false }))
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: 'until' } })
    fireEvent.change(screen.getByLabelText('Last date'), { target: { value: '2027-03-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const body = lastBody(fetcher, 'POST')
    expect(body.recurrence.freq).toBe('weekly')
    expect(body.recurrence.until).toBe('2027-03-01')
    expect(body.recurrence.by_weekday).toHaveLength(2)
    expect(body.timezone).toBeTruthy()
  })

  it('edits a single occurrence by default and offers to save a conflicting series anyway', async () => {
    const occurrence: CalendarOccurrence = { id: 'e7:1', event_id: 7, source: 'lifeos', title: 'Gym', kind: 'flexible', starts_at: '2027-01-05T18:00:00.000Z', ends_at: '2027-01-05T19:00:00.000Z', recurring: true, occurrence_start: '2027-01-05T18:00:00+00:00', recurrence: { freq: 'daily' }, editable: true }
    const fetcher = mockApi([user, { match: /\/api\/events\/7$/, method: 'GET', body: { data: { starts_at: '2027-01-04T18:00:00Z', ends_at: '2027-01-04T19:00:00Z' } } }, { match: /\/api\/events\/7$/, method: 'PATCH', body: { message: 'This series overlaps existing events', errors: { recurrence_conflicts: ['This series overlaps existing events: 2027-01-08: “Dinner”.'] } }, status: 422 }])
    render(wrap(<EventForm item={occurrence} tasks={[]} onSaved={() => {}} onClose={() => {}} />))
    expect(screen.getByRole('radio', { name: 'This event only' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(lastBody(fetcher, 'PATCH')).toMatchObject({ scope: 'occurrence', occurrence_start: '2027-01-05T18:00:00+00:00' }))

    fireEvent.click(screen.getByRole('radio', { name: 'All events in the series' }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/events/7', expect.anything()))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/overlaps existing events: 2027-01-08/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }))
    await waitFor(() => expect(lastBody(fetcher, 'PATCH')).toMatchObject({ ignore_conflicts: true, recurrence: { freq: 'daily' } }))
    expect(lastBody(fetcher, 'PATCH').scope).toBeUndefined()
  })

  it('shows external events read-only', () => {
    mockApi([user])
    render(wrap(<EventForm item={{ id: 'g1', event_id: null, source: 'google', title: 'Board meeting', kind: 'fixed', starts_at: '2027-01-05T18:00:00.000Z', ends_at: '2027-01-05T19:00:00.000Z', recurring: false, occurrence_start: null, editable: false, account_label: 'me@gmail.com' }} tasks={[]} onSaved={() => {}} onClose={() => {}} />))
    expect(screen.getByText(/Synced read-only from Google Calendar/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })
})

describe('security', () => {
  it('encodes QR codes with the right size for the payload', () => {
    expect(encodeQr('hello', 'M')).toHaveLength(21)
    const uri = 'otpauth://totp/LifeOS:a%40b.io?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=LifeOS&algorithm=SHA1&digits=6&period=30'
    expect(encodeQr(uri, 'M').length).toBeGreaterThanOrEqual(41)
  })

  it('asks for the password on 423 and retries the sensitive action once', async () => {
    let first = true
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/security/two-factor') { if (first) { first = false; return new Response(JSON.stringify({ message: 'Password confirmation required.' }), { status: 423 }) } return new Response(JSON.stringify({ secret: 'ABC', otpauth_uri: 'otpauth://x' }), { status: 200 }) }
      if (url === '/api/security/confirm-password') return new Response(JSON.stringify({}), { status: 200 })
      return new Response(JSON.stringify({ id: 1, name: 'A', email: 'a@x.io' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetcher)
    function Probe() { const run = useSensitiveAction(); const [out, setOut] = useState(''); return <button onClick={() => void run(() => api<{ secret: string }>('/api/security/two-factor', 'POST')).then(r => setOut(r.secret))}>start {out}</button> }
    render(wrap(<ConfirmPasswordProvider><Probe /></ConfirmPasswordProvider>))
    fireEvent.click(screen.getByRole('button', { name: /start/ }))
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'secret-pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByRole('button', { name: 'start ABC' })).toBeInTheDocument()
    expect(fetcher.mock.calls.filter(c => c[0] === '/api/security/two-factor')).toHaveLength(2)
  })

  it('shows the two-step verification form after a correct password', async () => {
    const fetcher = mockApi([{ match: /\/sanctum\/csrf-cookie$/, body: {} }, { match: /\/api\/user$/, body: { message: 'Unauthenticated.' }, status: 401 }, { match: /\/api\/login$/, method: 'POST', body: { two_factor: true } }, { match: /\/api\/two-factor-challenge$/, method: 'POST', body: { message: 'That code is not valid.', errors: { code: ['That code is not valid.'] } }, status: 422 }])
    render(wrap(<AuthPage />))
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@x.io' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'very-strong-pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Welcome back' }))
    fireEvent.change(await screen.findByLabelText('Authentication code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }))
    expect(await screen.findByText('That code is not valid.')).toBeInTheDocument()
    expect(lastBody(fetcher, 'POST')).toEqual({ code: '123456' })
    fireEvent.click(screen.getByRole('button', { name: 'Use a recovery code' }))
    expect(screen.getByLabelText('Recovery code')).toBeInTheDocument()
  })
})

describe('calendar integrations', () => {
  const providers = { providers: [
    { provider: 'google', label: 'Google Calendar', configured: false, redirect_uri: 'https://app/api/integrations/google/callback', accounts: [] },
    { provider: 'outlook', label: 'Outlook Calendar', configured: true, redirect_uri: 'https://app/api/integrations/outlook/callback', accounts: [{ id: 3, provider: 'outlook', email: 'me@outlook.com', display_name: null, status: 'revoked', last_synced_at: null, last_error: 'Outlook Calendar access was revoked or has expired.', events_count: 0, connected_at: null }] },
  ] }
  it('explains setup for unconfigured providers and never pretends to be connected', async () => {
    mockApi([user, { match: /\/api\/integrations$/, body: providers }])
    render(wrap(<IntegrationsSettings />))
    expect(await screen.findByText('Not configured on this server yet.')).toBeInTheDocument()
    expect(screen.getByText('https://app/api/integrations/google/callback')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect Google Calendar' })).not.toBeInTheDocument()
    expect(screen.getByText('Access revoked')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
  })
  it('starts OAuth by navigating to the provider URL returned by the server', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    mockApi([user, { match: /\/api\/integrations$/, body: providers }, { match: /\/api\/integrations\/outlook\/connect$/, method: 'POST', body: { authorization_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=abc' } }])
    render(wrap(<IntegrationsSettings />))
    fireEvent.click(await screen.findByRole('button', { name: 'Connect another account' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=abc'))
  })
})

describe('assistant proposals', () => {
  const proposal: AssistantProposal = { id: '6f1c2b8a-1111-4222-8333-944455556666', kind: 'schedule', provider: 'local', status: 'pending', summary: 'Proposed plan', explanation: ['Worked around what’s already booked: Dentist.'], expires_at: '2027-01-05T10:00:00Z', applied_at: null, results: null, actions: [
    { id: 'a1', type: 'create_event', title: 'Studying', starts_at: '2027-01-05T09:00:00Z', ends_at: '2027-01-05T10:15:00Z', minutes: 75, task_id: null },
    { id: 'a2', type: 'create_event', title: 'Programming', starts_at: '2027-01-05T10:25:00Z', ends_at: '2027-01-05T11:40:00Z', minutes: 75, task_id: null },
  ] }
  it('applies only the changes the user keeps selected', async () => {
    const fetcher = mockApi([user, { match: /\/apply$/, method: 'POST', body: { ...proposal, status: 'applied', results: [{ action_id: 'a2', type: 'create_event', event_id: 9 }] } }])
    render(wrap(<ProposalCard proposal={proposal} />))
    expect(screen.getByText('Needs your approval')).toBeInTheDocument()
    expect(screen.getByText('Worked around what’s already booked: Dentist.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Studying' }))
    fireEvent.click(screen.getByRole('button', { name: /Add 1 to calendar/ }))
    await screen.findByText('Applied')
    expect(lastBody(fetcher, 'POST')).toEqual({ action_ids: ['a2'] })
  })
  it('never sends a request until the user approves', () => {
    const fetcher = mockApi([user])
    render(wrap(<ProposalCard proposal={proposal} />))
    expect(fetcher.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(0)
  })
  it('shows provider status without credentials and lets users opt out of external AI', async () => {
    const fetcher = mockApi([user, { match: /\/api\/assistant\/status$/, body: { active: { provider: 'anthropic', label: 'Anthropic Claude', model: 'claude-opus-5-5' }, selected: 'anthropic', external_allowed: true, providers: [{ provider: 'openai', label: 'OpenAI', configured: false, selected: false, model: 'gpt-4.1-mini' }, { provider: 'anthropic', label: 'Anthropic Claude', configured: true, selected: true, model: 'claude-opus-5-5' }] } }, { match: /\/api\/settings$/, method: 'PUT', body: {} }])
    render(wrap(<AssistantSettings />))
    expect(await screen.findByText('Configured · selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /Allow the external AI provider/ }))
    await waitFor(() => expect(lastBody(fetcher, 'PUT')).toEqual({ assistant_external: false }))
  })
})

describe('notification settings', () => {
  const channels = { reminders: { enabled: true, push: true }, deadlines: { enabled: true, push: true }, calendar: { enabled: true, push: true }, focus: { enabled: true, push: true }, planning: { enabled: true, push: false }, review: { enabled: true, push: false }, system: { enabled: true, push: false } }
  const routes = (configured: boolean) => [user,
    { match: /\/api\/push\/config$/, body: { configured, public_key: configured ? 'BPk' : null, channels } },
    { match: /\/api\/settings$/, method: 'GET', body: { quiet_start: '22:00', quiet_end: '07:00', event_remind_minutes: 15 } },
    { match: /\/api\/settings$/, method: 'PUT', body: {} },
    { match: /\/api\/push\/subscriptions$/, body: [] },
    { match: /\/api\/notifications$/, body: { data: [{ id: 1, title: 'Upcoming: Standup', kind: 'event', category: 'calendar', link: '/calendar', push_status: 'failed', push_error: 'Push service rejected the message (400).', read_at: null, created_at: '2027-01-04T08:00:00Z' }] } },
  ]
  it('falls back gracefully when the browser has no push support and never offers to enable it', async () => {
    mockApi(routes(true))
    render(wrap(<NotificationSettings />))
    expect(await screen.findByText(/doesn’t support push notifications/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Turn on push' })).not.toBeInTheDocument()
    expect(await screen.findByText('Push failed')).toBeInTheDocument()
    expect(screen.getByText(/Quiet hours 22:00–07:00/)).toBeInTheDocument()
  })
  it('saves per-category channels and the event reminder lead time', async () => {
    const fetcher = mockApi(routes(false))
    render(wrap(<NotificationSettings />))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Daily planning — in app' }))
    fireEvent.change(screen.getByLabelText('Remind me before events'), { target: { value: '60' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }))
    await waitFor(() => expect(lastBody(fetcher, 'PUT')).toMatchObject({ event_remind_minutes: 60, notification_channels: { planning: { enabled: false, push: false }, calendar: { enabled: true, push: true } } }))
  })
})

describe('automations', () => {
  const catalogue = { task_overdue: ['suggest_time_block', 'notify'], focus_completed: ['update_focus_stats', 'notify'], recurring_task_due: ['create_next_occurrence', 'notify'], weekly_review_completed: ['offer_next_week_plan', 'notify'], day_overloaded: ['suggest_rebalance', 'notify'] }
  const templates = [{ key: 'overload_rebalance', trigger: 'day_overloaded', action: 'suggest_rebalance', conditions: { threshold: 90, days_ahead: 2 }, en: 'Suggest moving flexible tasks off overloaded days', ar: 'x' }]
  const rule = { id: 4, name: 'Overdue helper', trigger: 'task_overdue', action: 'suggest_time_block', conditions: { min_priority: 'high' }, action_config: {}, enabled: true, run_count: 2, last_run_at: '2027-01-04T10:00:00Z', failed_runs: 1 }
  it('lists rules with status, toggles them and adds templates', async () => {
    const fetcher = mockApi([user, { match: /\/api\/automations$/, method: 'GET', body: { rules: [rule], catalogue, templates, limit: 20 } }, { match: /\/api\/automations\/4$/, method: 'PATCH', body: {} }, { match: /\/api\/automations$/, method: 'POST', body: { id: 5 }, status: 201 }])
    render(wrap(<AutomationSettings />))
    expect(await screen.findByText('Overdue helper')).toBeInTheDocument()
    expect(screen.getByText('1 failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: /Overdue helper/ }))
    await waitFor(() => expect(lastBody(fetcher, 'PATCH')).toEqual({ enabled: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(lastBody(fetcher, 'POST')).toMatchObject({ trigger: 'day_overloaded', action: 'suggest_rebalance' }))
  })
  it('builds a rule, limits actions to the trigger and previews without saving', async () => {
    const fetcher = mockApi([user, { match: /\/api\/automations$/, method: 'GET', body: { rules: [], catalogue, templates: [], limit: 20 } }, { match: /\/api\/automations\/preview$/, method: 'POST', body: { matches: [{ subject: 'Water plants', description: 'Create the next occurrence (the missed one stays as is)' }] } }, { match: /\/api\/automations$/, method: 'POST', body: { id: 1 }, status: 201 }])
    render(wrap(<AutomationSettings />))
    fireEvent.click(await screen.findByRole('button', { name: 'New automation' }))
    fireEvent.change(screen.getByLabelText('Trigger'), { target: { value: 'recurring_task_due' } })
    expect([...(screen.getByLabelText('Action') as HTMLSelectElement).options].map(o => o.value)).toEqual(['create_next_occurrence', 'notify'])
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByText('Water plants')).toBeInTheDocument()
    expect(fetcher.mock.calls.filter(c => c[1]?.method === 'POST' && String(c[0]).endsWith('/api/automations'))).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Save automation' }))
    await waitFor(() => expect(lastBody(fetcher, 'POST')).toMatchObject({ trigger: 'recurring_task_due', action: 'create_next_occurrence', conditions: { grace_hours: 12 } }))
  })
})
