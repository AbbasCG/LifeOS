import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import { CheckinCard } from '../features/wellbeing/CheckinCard'
import WellbeingSettings from '../features/settings/WellbeingSettings'
import FocusPage from '../features/FocusPage'
import { ProgressPanel } from '../features/progress/ProgressPanel'
import DayPlanPage from '../features/today/DayPlanPage'
import { clock, elapsedNow, nextPomodoroStep } from '../lib/focus'
import { BriefingWidget, CheckinWidget, DeadlinesWidget, FocusTimeWidget, ProgressWidget } from '../features/today/TodayWidgets'
import type { TodayData, AssistantProposal } from '../lib/api'
import { ProposalCard } from '../features/assistant/ProposalCard'
import AssistantPage from '../features/AssistantPage'
import AnalyticsPage from '../features/AnalyticsPage'
import { ConnectedTasksPanel } from '../features/connected/ConnectedTasksPanel'
import type { Analytics } from '../lib/api'

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

describe('daily check-in', () => {
  it('saves only the fields the user filled in, with sleep in minutes', async () => {
    const fetcher = mockApi([user, { match: /\/api\/checkins\/2027-03-10$/, method: 'PUT', body: { date: '2027-03-10', energy: 4 }, status: 201 }])
    const onSaved = vi.fn()
    render(wrap(<CheckinCard initial={null} date="2027-03-10" onSaved={onSaved} />))
    fireEvent.click(screen.getByRole('radio', { name: 'Energised' }).closest('label')!.querySelector('input')!)
    fireEvent.change(screen.getByLabelText('Sleep last night (hours)'), { target: { value: '7.5' } })
    fireEvent.click(screen.getByRole('button', { name: /Save check-in/ }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(lastBody(fetcher, 'PUT')).toEqual({ energy: 5, mood: null, stress: null, workload: null, sleep_minutes: 450, reflection: null })
  })

  it('shows patterns with their sample sizes and the non-medical note, and can be switched off', async () => {
    const fetcher = mockApi([user,
      { match: /\/api\/checkins\?days=30$/, body: { enabled: true, today: null, items: [{ date: '2027-03-09', energy: 4, mood: 3, stress: 2, workload: 3, sleep_minutes: 420, reflection: 'Solid day' }] } },
      { match: /\/api\/checkins\/insights/, body: { enabled: true, days: 60, checked_in_days: 9, averages: {}, trend: {}, series: [], findings: [{ key: 'energy_focus_minutes', type: 'positive', en: 'On the 5 days you rated your energy 4–5 you logged 96 focus minutes on average, versus 4 lower-energy days averaging 41.', ar: '', groups: [] }], note: { en: 'These are patterns in your own entries, not medical advice.', ar: '' } } },
      { match: /\/api\/settings$/, method: 'PUT', body: {} },
    ])
    render(wrap(<WellbeingSettings />))
    expect(await screen.findByText(/versus 4 lower-energy days averaging 41/)).toBeInTheDocument()
    expect(screen.getByText(/These are patterns in your own entries/)).toBeInTheDocument()
    expect(screen.getByText('Solid day')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /Daily check-ins/ }))
    await waitFor(() => expect(lastBody(fetcher, 'PUT')).toEqual({ checkins_enabled: false }))
  })
})

describe('focus experience', () => {
  it('suggests breaks and rounds in a Pomodoro cycle', () => {
    expect(nextPomodoroStep({ kind: 'focus', mode: 'pomodoro', cycle: 1, status: 'completed' })).toEqual({ kind: 'short_break', minutes: 5, cycle: 1 })
    expect(nextPomodoroStep({ kind: 'focus', mode: 'pomodoro', cycle: 4, status: 'completed' })).toEqual({ kind: 'long_break', minutes: 15, cycle: 4 })
    expect(nextPomodoroStep({ kind: 'short_break', mode: null, cycle: 2, status: 'completed' })).toEqual({ kind: 'focus', minutes: 25, cycle: 3 })
    expect(nextPomodoroStep({ kind: 'long_break', mode: null, cycle: 4, status: 'completed' })).toEqual({ kind: 'focus', minutes: 25, cycle: 1 })
    expect(nextPomodoroStep({ kind: 'focus', mode: 'deep', cycle: null, status: 'completed' })).toBeNull()
    expect(nextPomodoroStep({ kind: 'focus', mode: 'pomodoro', cycle: 1, status: 'cancelled' })).toBeNull()
  })
  it('computes live elapsed time without exceeding the duration', () => {
    const now = Date.parse('2027-03-10T09:10:00Z')
    expect(elapsedNow({ status: 'running', elapsed_seconds: 60, resumed_at: '2027-03-10T09:05:00Z', duration_seconds: 1500 }, now)).toBe(360)
    expect(elapsedNow({ status: 'paused', elapsed_seconds: 60, resumed_at: null, duration_seconds: 1500 }, now)).toBe(60)
    expect(elapsedNow({ status: 'running', elapsed_seconds: 1400, resumed_at: '2027-03-10T09:00:00Z', duration_seconds: 1500 }, now)).toBe(1500)
    expect(clock(5400)).toBe('1:30:00')
    expect(clock(65)).toBe('01:05')
  })
  it('starts a deep-work session with an idempotency key and logs distractions on the running session', async () => {
    const running = { id: 7, status: 'running', kind: 'focus', mode: 'deep', cycle: null, duration_seconds: 5400, elapsed_seconds: 0, resumed_at: new Date().toISOString(), completed_at: null, started_at: new Date().toISOString(), created_at: new Date().toISOString(), notes: null, interruptions: [], task_id: null, project_id: null }
    let sessions: unknown[] = []
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method || 'GET'
      if (/\/api\/user$/.test(url)) return new Response(JSON.stringify({ id: 1 }))
      if (/\/api\/focus-sessions\/insights/.test(url)) return new Response(JSON.stringify({ sessions: 0, by_day: [], distractions: [], tips: [] }))
      if (/\/api\/focus-sessions$/.test(url) && method === 'POST') { sessions = [running]; return new Response(JSON.stringify(running), { status: 201 }) }
      if (/\/api\/focus-sessions$/.test(url)) return new Response(JSON.stringify({ data: sessions }))
      if (/\/api\/focus-sessions\/7$/.test(url)) return new Response(JSON.stringify({ ...running, interruptions: [{ at: 'x', reason: 'phone' }] }))
      return new Response(JSON.stringify({ data: [] }))
    })
    vi.stubGlobal('fetch', fetcher)
    render(wrap(<FocusPage />))
    fireEvent.click(await screen.findByRole('tab', { name: /Deep work/ }))
    fireEvent.click(screen.getByRole('button', { name: /Start 90 min deep work/ }))
    await screen.findByRole('button', { name: /Log a distraction/ })
    const start = JSON.parse(fetcher.mock.calls.find(c => c[1]?.method === 'POST')![1]!.body as string)
    expect(start).toMatchObject({ kind: 'focus', mode: 'deep', duration_seconds: 5400 })
    expect(start.client_id).toMatch(/^[0-9a-f-]{36}$/)
    fireEvent.click(screen.getByRole('button', { name: /Log a distraction/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Phone' }))
    await waitFor(() => expect(JSON.parse(fetcher.mock.calls.find(c => c[1]?.method === 'PATCH')![1]!.body as string)).toEqual({ action: 'interrupt', reason: 'phone', note: null }))
  })
})

describe('goal intelligence', () => {
  const goal = { id: 3, title: 'Run a half marathon', color: '#16a34a', percent: 30, expected_percent: 70, days_left: 12, status: 'at_risk', reasons: [{ en: '30% done with 70% of the time used.', ar: '' }], milestones: { done: 1, total: 3, next: 'Tempo block' }, tasks: { open: 1, done: 2, overdue: 0 }, trend: { recent: 0, previous: 2, direction: 'down' }, focus_minutes_30d: 120, next_actions: [{ id: 9, title: '16 km long run' }], suggested_tasks: [{ title: 'Tempo block' }], recommendations: [{ type: 'schedule', en: 'Block time for “16 km long run” this week.', ar: '' }] }
  it('explains at-risk goals and turns milestones into tasks on request', async () => {
    const fetcher = mockApi([user, { match: /\/api\/insights\/progress$/, body: { goals: [goal], projects: [], habits: [] } }, { match: /\/api\/tasks$/, method: 'POST', body: { data: { id: 10 } }, status: 201 }])
    render(wrap(<ProgressPanel resource="goals" />))
    expect(await screen.findByText('At risk')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Why?'))
    expect(await screen.findByText('30% done with 70% of the time used.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /16 km long run/ })).toHaveAttribute('href', '/focus?task=9')
    fireEvent.click(screen.getByRole('button', { name: /Tempo block/ }))
    await waitFor(() => expect(lastBody(fetcher, 'POST')).toEqual({ title: 'Tempo block', goal_id: 3, status: 'todo' }))
  })
})

describe('plan my day', () => {
  const item = { key: '1-1-1', task_id: 1, title: 'Write proposal', priority: 'high', starts_at: '2027-03-10T09:30:00Z', ends_at: '2027-03-10T10:30:00Z', minutes: 60, reasons: ['high', 'focus_window'], explanation: { en: 'High priority; placed in your peak focus hours.', ar: '' }, area: 'work', part: 1, parts: 1, manual: false }
  const alt = (key: string, title: string) => ({ key, title: { en: title, ar: title }, description: { en: `${title} description`, ar: '' }, items: [item], warnings: [], breaks: [], metrics: { planned_minutes: 60, tasks: 1, switches: 0, load_percent: 20, unscheduled_must_do: 0 }, explanation: [] })
  const plan = { date: '2027-03-10', timezone: 'UTC', replan: false, energy: 2, estimate_ratio: 1.25, recommended: 'light', budget: { window_minutes: 480, committed_minutes: 90, free_minutes: 330, capacity_minutes: 231, must_do_minutes: 300, buffer_minutes: 15 }, boundaries: { work: { start: '09:00', end: '17:00' } }, peak: { start: '09:00', end: '11:00', source: 'history' }, commitments: [{ title: 'Stand-up', kind: 'fixed', source: 'lifeos', recurring: true, starts_at: '2027-03-10T09:30:00Z', ends_at: '2027-03-10T10:00:00Z' }], overload: { en: 'Must-do work needs 5h but only 3h 51m fits.', ar: '', flexible_events: [] }, recovery: [{ task_id: 4, title: 'Missed task', missed_at: '2027-03-09T10:00:00Z' }], explanation: [{ en: 'You rated your energy 2/5, so plans use about 70% of your free time.', ar: '' }], alternatives: [alt('balanced', 'Balanced'), alt('deep', 'Deep focus first'), alt('light', 'Light day')] }
  it('explains the budget, preselects the suggested plan and only changes the calendar after confirmation', async () => {
    const fetcher = mockApi([user, { match: /\/api\/day-plan\?/, body: plan }, { match: /\/api\/day-plan$/, method: 'POST', body: { id: 42, status: 'pending', items: [item] }, status: 201 }, { match: /\/api\/plans\/42\/accept$/, method: 'POST', body: { id: 42, status: 'accepted' } }])
    render(wrap(<DayPlanPage />))
    expect(await screen.findByText(/Must-do work needs 5h/)).toBeInTheDocument()
    expect(screen.getByText(/Recovering 1 missed block/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Light day/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('High priority; placed in your peak focus hours.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Deep focus first/ }))
    fireEvent.click(screen.getByRole('button', { name: /Use this plan/ }))
    await waitFor(() => expect(lastBody(fetcher, 'POST')).toMatchObject({ variant: 'deep' }))
    expect(fetcher.mock.calls.some(c => String(c[0]).includes('/accept'))).toBe(false)
    fireEvent.click(await screen.findByRole('button', { name: /Add 1 blocks to calendar/ }))
    await waitFor(() => expect(fetcher.mock.calls.some(c => String(c[0]).endsWith('/api/plans/42/accept'))).toBe(true))
  })
})

describe('today dashboard widgets', () => {
  const today: TodayData = {
    date: '2027-03-10', period: 'morning', reflection_prompt: null, timeline: [{ id: 'e1', title: 'Client call', starts_at: '2027-03-10T10:00:00Z', ends_at: '2027-03-10T11:00:00Z', kind: 'fixed', source: 'lifeos', all_day: false }, { id: 'x2', title: 'Board sync', starts_at: '2027-03-10T14:00:00Z', ends_at: '2027-03-10T14:30:00Z', kind: 'fixed', source: 'outlook', all_day: false }], windows: { work: { start: '2027-03-10T09:00:00Z', end: '2027-03-10T17:00:00Z' } },
    briefing: [{ en: 'You have 2 commitments today and 6h 50m of free time.', ar: '' }, { en: 'Top priority: Ship release notes.', ar: '' }],
    energy: { checkin: null, enabled: true, energy: null, workload: null, load_percent: 64, level: 'moderate' },
    focus_time: { free_minutes: 410, slots: [{ area: 'work', starts_at: '2027-03-10T11:10:00Z', ends_at: '2027-03-10T13:00:00Z', minutes: 110 }], peak: null, next_task: { id: 7, title: 'Ship release notes' } },
    deadlines: [{ id: 3, title: 'Tax filing', priority: 'high', due_at: '2027-03-09T09:00:00Z', type: 'task', bucket: 'overdue' }],
    progress: { tasks: { done: 1, target: 4 }, focus: { done: 60, target: 240 }, habits: { done: 0, target: 0 }, overall: 25 },
  }
  it('shows the briefing, progress, free slots with a focus shortcut, and bucketed deadlines', () => {
    mockApi([user])
    render(wrap(<><BriefingWidget data={today} /><ProgressWidget data={today} /><FocusTimeWidget data={today} /><DeadlinesWidget data={today} /></>))
    expect(screen.getByText(/2 commitments today/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Tasks: 1/4' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /Habits: None yet/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Focus on “Ship release notes”/ })).toHaveAttribute('href', '/focus?task=7')
    expect(screen.getByText('Overdue')).toBeInTheDocument()
    expect(screen.getByText('Tax filing')).toBeInTheDocument()
  })
  it('switches to the evening summary with a reflection prompt and hides the check-in when disabled', () => {
    mockApi([user])
    const evening = { ...today, period: 'evening' as const, reflection_prompt: { en: 'What went well today?', ar: '' }, energy: { ...today.energy, enabled: false } }
    const { container } = render(wrap(<><BriefingWidget data={evening} /><CheckinWidget data={evening} /></>))
    expect(screen.getByRole('heading', { name: /Evening summary/ })).toBeInTheDocument()
    expect(screen.getByText('What went well today?')).toBeInTheDocument()
    expect(container.querySelector('.checkin-widget')).toBeNull()
  })
})

describe('copilot v3', () => {
  const proposal: AssistantProposal = { id: '0b5c1c0e-1111-4222-8333-944455556666', kind: 'goal_plan', provider: 'local', status: 'pending', summary: 'Plan', explanation: ['Turned this goal’s unfinished milestones into tasks.'], results: null, expires_at: '2027-03-11T10:00:00Z', applied_at: null,
    actions: [
      { id: 'a1', type: 'create_task', title: 'Hold a conversation', minutes: 60, estimated_minutes: 60, priority: 'high', goal_id: 4, due_at: '2027-03-15T16:00:00Z' },
      { id: 'a2', type: 'create_task', title: 'Read a short story', minutes: 60, estimated_minutes: 60, priority: 'high', goal_id: 4, due_at: '2027-03-25T16:00:00Z' },
    ] }
  it('creates only the tasks the user keeps selected', async () => {
    const fetcher = mockApi([user, { match: /\/apply$/, method: 'POST', body: { ...proposal, status: 'applied', results: [{ action_id: 'a2', type: 'create_task', task_id: 9 }] } }])
    render(wrap(<ProposalCard proposal={proposal} />))
    expect(screen.getByText('Proposed tasks')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: /Create 1 task\(s\)/ }))
    expect(await screen.findByText('Applied')).toBeInTheDocument()
    expect(lastBody(fetcher, 'POST')).toEqual({ action_ids: ['a2'] })
    expect(screen.getByRole('link', { name: 'Open tasks' })).toBeInTheDocument()
  })
  it('shows conflict findings as linked items', async () => {
    mockApi([user, { match: /\/api\/assistant\/status$/, body: { active: { provider: 'local', label: 'Local assistant', model: null }, selected: 'disabled', external_allowed: true, providers: [] } }, { match: /\/api\/assistant\/proposals$/, body: [] },
      { match: /\/api\/copilot\/messages$/, method: 'POST', body: { conversation: { id: 'c0ffee00-0000-4000-8000-000000000001', title: 'Do I have any conflicts?', language: 'en', last_message_at: '2027-01-04T10:00:00Z', created_at: '2027-01-04T10:00:00Z' }, replayed: false,
        user_message: { id: 1, role: 'user', content: 'Do I have any conflicts?', intent: null, provider: null, created_at: '2027-01-04T10:00:00Z' },
        message: { id: 2, role: 'assistant', provider: 'local', intent: 'conflicts', content: 'In the next 7 days I found 1 calendar overlap(s).', created_at: '2027-01-04T10:00:00Z', subtasks: [], tasks: [], proposal: null, items: [{ type: 'overlap', title: 'Client call ↔ Team sync', detail: 'Mon 10:30 · overlap 30 min', link: '/calendar' }] } } }])
    render(wrap(<AssistantPage />))
    fireEvent.click(screen.getByRole('button', { name: 'Do I have any conflicts?' }))
    expect(await screen.findByRole('link', { name: 'Client call ↔ Team sync' })).toHaveAttribute('href', '/calendar')
    expect(screen.getByText('Mon 10:30 · overlap 30 min')).toBeInTheDocument()
  })
})

describe('personal analytics', () => {
  const zero = { completed: 0, focus_minutes: 0 }
  const analytics: Analytics = {
    range: { days: 7, from: '2027-03-01', to: '2027-03-07', timezone: 'UTC', previous_from: '2027-02-22', previous_to: '2027-02-28', custom: true }, project: null,
    totals: { completed: 4, created: 2, focus_minutes: 300, sessions: 5, average_session_minutes: 60, on_time_rate: null, estimated_minutes: 0, actual_minutes: 0, estimate_ratio: null },
    comparison: { completed: { previous: 1, change: 300, small_base: true }, focus_minutes: { previous: 0, change: null, small_base: true } },
    series: [{ date: '2027-03-01', completed: 4, created: 2, focus_minutes: 300 }], by_project: [], by_priority: [], focus_by_hour: [], focus_by_weekday: [], habits: [], insights: [],
    energy: { enabled: true, checked_in_days: 4, reliable: false, min_days_per_group: 3, groups: [{ level: 'low', days: 1, avg_focus_minutes: 30, avg_completed: 0, reliable: false }, { level: 'medium', days: 0, avg_focus_minutes: null, avg_completed: null, reliable: false }, { level: 'high', days: 3, avg_focus_minutes: 90, avg_completed: 1.3, reliable: true }], days: [] },
    consistency: { days: 7, focus_days: 5, percent: 71, longest_streak: 4, current_streak: 2, weekly_variation: null, weeks: [{ start: '2027-03-01', focus_minutes: 300, completed: 4, days: 7 }] },
    workload: { by_area: [{ area: 'work', completed: 3, focus_minutes: 240, share: 80 }, { area: 'study', completed: 1, focus_minutes: 60, share: 20 }, { area: 'personal', completed: 0, focus_minutes: 0, share: 0 }], completed_by_weekday: Array.from({ length: 7 }, (_, weekday) => ({ weekday, completed: weekday === 1 ? 4 : 0 })), due_next_7_days: { tasks: 2, overdue: 1, remaining_minutes: 90 } },
    goals: [{ id: 1, title: 'Thesis', color: '#16a34a', percent: 40, expected_percent: 60, status: 'at_risk', days_left: 20, trend: 'down' }],
    periods: { week: { from: '2027-03-08', previous_from: '2027-03-01', current: { completed: 6, focus_minutes: 400 }, previous: { completed: 5, focus_minutes: 300 }, change: { completed: 20, focus_minutes: 33 }, small_base: { completed: false, focus_minutes: false } }, month: { from: '2027-03-01', previous_from: '2027-02-01', current: { completed: 2, focus_minutes: 60 }, previous: zero, change: { completed: null, focus_minutes: null }, small_base: { completed: true, focus_minutes: true } } },
  }
  it('applies a custom range and project filter, and never shows percentages on tiny baselines', async () => {
    const fetcher = mockApi([user, { match: /\/api\/projects\?/, body: { data: [{ id: 5, title: 'Site' }] } }, { match: /\/api\/analytics\?/, body: analytics }])
    render(wrap(<AnalyticsPage />))
    // Headline numbers first; the deeper patterns and the filters open on request.
    fireEvent.click(await screen.findByText('More patterns'))
    fireEvent.click(screen.getByText('Custom range & project'))
    expect(await screen.findByText('Energy vs productivity')).toBeInTheDocument()
    expect(screen.getByText('+20% · was 5')).toBeInTheDocument()
    expect(screen.getAllByText(/too little to compare/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/\+300%/)).toBeNull()
    expect(screen.getByText(/Comparisons appear once at least two groups have 3\+ days/)).toBeInTheDocument()
    expect(screen.getByText('At risk')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-01-07' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply range' }))
    await waitFor(() => expect(fetcher.mock.calls.some(c => String(c[0]).includes('/api/analytics?from=2026-01-01&to=2026-01-07'))).toBe(true))
    fireEvent.change(await screen.findByRole('combobox', { name: 'Project' }), { target: { value: '5' } })
    await waitFor(() => expect(fetcher.mock.calls.some(c => String(c[0]).includes('from=2026-01-01&to=2026-01-07&project_id=5'))).toBe(true))
  })
})

describe('connected tasks', () => {
  it('shows imported tasks with their source and copies one into LifeOS', async () => {
    const tasks = [{ id: 7, provider: 'todoist', source: 'Todoist', account: 'me@todoist.test', list: 'Inbox', title: 'Call bank', due_at: '2027-01-06T22:59:00Z', due_is_date: true, priority: 'urgent', url: 'https://app.todoist.com/app/task/1' }]
    const fetcher = mockApi([user, { match: /\/api\/connected\/tasks$/, body: tasks }, { match: /\/api\/connected\/tasks\/7\/copy$/, method: 'POST', body: { id: 99 }, status: 201 }])
    const onCopied = vi.fn()
    render(wrap(<ConnectedTasksPanel onCopied={onCopied} />))
    expect(await screen.findByText('Call bank')).toBeInTheDocument()
    expect(screen.getByText('Todoist')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open in Todoist' })).toHaveAttribute('href', 'https://app.todoist.com/app/task/1')
    fireEvent.click(screen.getByRole('button', { name: 'Copy to LifeOS' }))
    await waitFor(() => expect(onCopied).toHaveBeenCalled())
    expect(fetcher.mock.calls.some(c => String(c[0]).endsWith('/api/connected/tasks/7/copy') && c[1]?.method === 'POST')).toBe(true)
  })
})
