import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import { IntelligenceBriefing } from '../features/intelligence/IntelligenceBriefing'
import { RecommendationCard } from '../features/intelligence/RecommendationCard'
import { WeeklyInsights } from '../features/intelligence/WeeklyInsights'
import AiControlCenter from '../features/settings/AiControlCenter'
import DayPlanPage from '../features/today/DayPlanPage'
import type { MorningBriefing, Recommendation, IntelligenceSettingsData, WeeklyIntelligenceData } from '../lib/intelligence'

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
const calls = (f: ReturnType<typeof mockApi>, method: string, path: RegExp) => f.mock.calls.filter(c => (c[1]?.method ?? 'GET') === method && path.test(String(c[0]))).map(c => c[1]?.body ? JSON.parse(c[1].body as string) : String(c[0]))
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals() })

const rec = (over: Partial<Recommendation> = {}): Recommendation => ({ id: 7, type: 'deadline', severity: 'high', status: 'active', feedback: null, title: { en: '“Board deck” is due Tue 18:00', ar: '«Board deck» مستحقة' }, detail: { en: 'No time is set aside for it yet.', ar: 'لم يُخصص لها وقت بعد.' },
  confidence: 'high', sources: ['tasks', 'calendar'], evidence: { estimated_minutes: 90, due_at: '2027-03-23T17:00:00Z' }, action: { kind: 'proposal', proposal: 'find_time', task_ids: [3], label: { en: 'Find time', ar: 'اعثر على وقت' } }, proposal_id: null, first_seen_at: '2027-03-23T07:00:00Z', ...over })

const briefing: MorningBriefing = {
  enabled: true, generated_at: '2027-03-23T07:00:00Z', date: '2027-03-23', timezone: 'Europe/Amsterdam', sources: ['calendar', 'goals', 'focus'],
  priorities: [{ id: 3, title: 'Board deck', priority: 'high', status: 'todo', due_at: '2027-03-23T17:00:00Z', estimated_minutes: 90, score: 81, reasons: ['high', 'due_today', 'deadline_risk'], risk: 'high', scheduled: false, postponed_count: 0, confidence: 'medium', sources: ['tasks', 'calendar'] }],
  meetings: [{ title: 'Client call', starts_at: '2027-03-23T09:00:00Z', ends_at: '2027-03-23T10:00:00Z', source: 'google' }], deadlines: [],
  focus: { windows: [{ area: 'work', starts_at: '2027-03-23T12:00:00Z', ends_at: '2027-03-23T14:00:00Z', minutes: 120 }], capacity: { minutes: 120, free_minutes: 300, typical_daily_minutes: 100, daily_limit: null, basis: { sessions: 12, days: 6, window_days: 14 }, confidence: 'high', sources: ['calendar', 'focus'] } },
  overloaded: [{ date: '2027-03-25', load_percent: 125, committed_minutes: 600, capacity_minutes: 480 }], unfinished: [{ id: 9, title: 'Dentist forms', postponed_count: 3, postponed: true }],
  improvements: [{ key: 'fragmented', en: 'Today has no free hour in one piece.', ar: 'لا توجد ساعة متصلة.', sources: ['calendar'] }], suggestions: [rec()],
}

describe('morning intelligence', () => {
  it('explains priorities, focus capacity and watch-outs with their confidence and sources', async () => {
    mockApi([user, { match: /\/api\/intelligence\/briefing$/, body: briefing }])
    render(wrap(<IntelligenceBriefing />))
    expect(await screen.findByText('Morning intelligence')).toBeInTheDocument()
    expect(screen.getByText(/Sources: Calendar, Goals, Focus history/)).toBeInTheDocument()
    const first = screen.getByText('Board deck', { selector: 'strong' }).closest('li')!
    expect(within(first).getByText('May not fit')).toBeInTheDocument()
    expect(within(first).getByText('Medium confidence')).toBeInTheDocument()
    expect(within(first).getByLabelText('Priority score 81 of 100')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /Focus/ }))
    expect(screen.getByText(/Based on 12 focus session\(s\) over the last 14 days/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /Watch-outs/ }))
    expect(screen.getByText(/is 125% booked/)).toBeInTheDocument()
    expect(screen.getByText('“Dentist forms” postponed 3 times.')).toBeInTheDocument()
    expect(screen.getByText('“Board deck” is due Tue 18:00')).toBeInTheDocument()
  })
  it('renders nothing when the user turned the briefing off', async () => {
    const f = mockApi([user, { match: /\/api\/intelligence\/briefing$/, body: { enabled: false } }])
    const { container } = render(wrap(<IntelligenceBriefing />))
    await waitFor(() => expect(calls(f, 'GET', /briefing$/).length).toBe(1))
    await waitFor(() => expect(container.querySelector('.intel-briefing')).toBeNull())
  })
})

describe('recommendation card', () => {
  it('can be dismissed, snoozed and rated, and shows why', async () => {
    const f = mockApi([user, { match: /\/recommendations\/7\/(dismiss|feedback)$/, method: 'POST', body: { id: 7 } }])
    const onChange = vi.fn()
    render(wrap(<ul><RecommendationCard rec={rec()} onChange={onChange} /></ul>))
    fireEvent.click(screen.getByRole('button', { name: 'Why?' }))
    expect(screen.getByText('estimated minutes')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Not useful' }))
    await waitFor(() => expect(calls(f, 'POST', /feedback$/)).toEqual([{ useful: false }]))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss or snooze' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Snooze 3 day(s)' }))
    await waitFor(() => expect(calls(f, 'POST', /dismiss$/)).toEqual([{ snooze_days: 3 }]))
    expect(onChange).toHaveBeenCalledWith(7, true)
  })
  it('turns into a proposal that still needs approval', async () => {
    const proposal = { id: 'p1', kind: 'find_time', provider: 'local', status: 'pending', summary: 'Time found', explanation: [], actions: [{ id: 'a1', type: 'create_event', title: 'Board deck', starts_at: '2027-03-23T12:00:00Z', ends_at: '2027-03-23T13:30:00Z', minutes: 90, task_id: 3 }], results: null, expires_at: '2027-03-23T10:00:00Z', applied_at: null }
    const f = mockApi([user, { match: /\/recommendations\/7\/act$/, method: 'POST', body: proposal, status: 201 }])
    render(wrap(<ul><RecommendationCard rec={rec()} onChange={vi.fn()} /></ul>))
    fireEvent.click(screen.getByRole('button', { name: /Find time/ }))
    expect(await screen.findByText('Needs your approval')).toBeInTheDocument()
    expect(calls(f, 'POST', /apply$/)).toEqual([])
  })
  it('links only navigate', () => {
    mockApi([user])
    render(wrap(<ul><RecommendationCard rec={rec({ type: 'conflict', action: { kind: 'link', to: '/timeline?date=2027-03-24', label: { en: 'Open timeline', ar: 'فتح' } } })} onChange={vi.fn()} /></ul>))
    expect(screen.getByRole('link', { name: /Open timeline/ })).toHaveAttribute('href', '/timeline?date=2027-03-24')
  })
})

const settings: IntelligenceSettingsData = {
  settings: { enabled: true, features: { briefing: true, recommendations: true, weekly: true, planner: true, ai_narrative: false, conversation_personalization: false }, sources: { calendar: true, connected: true, goals: true, habits: true, focus: true, checkins: true }, frequency: 'quiet', personalization: false, retention_days: 90, planning_strategy: null },
  options: { retention_days: [30, 90, 180], strategies: ['balanced', 'deep', 'light', 'deadlines'] },
  external_ai: { allowed: true, connected_data: false, provider: null, in_use: false }, counts: { recommendations: 4, feedback: 2, proposals: 3 },
}
describe('AI Control Center', () => {
  it('saves granular switches, consent and frequency, and deletes AI data only after confirmation', async () => {
    const f = mockApi([user, { match: /\/api\/intelligence\/settings$/, body: settings }, { match: /\/api\/intelligence\/settings$/, method: 'PUT', body: { settings: settings.settings } },
      { match: /\/api\/settings$/, method: 'PUT', body: {} }, { match: /\/api\/intelligence\/activity$/, body: { proposals: [{ id: 'p', kind: 'schedule', provider: 'local', status: 'undone', summary: 'Plan for Monday', actions: 2, created_at: '2027-03-22T08:00:00Z', applied_at: null }], recommendations: [], events: [{ action: 'ai_action_undone', at: '2027-03-22T09:00:00Z', meta: {} }] } },
      { match: /\/api\/intelligence\/data$/, method: 'DELETE', body: { deleted: { recommendations: 4, proposals: 3 } } }])
    render(wrap(<AiControlCenter />))
    fireEvent.click(await screen.findByLabelText('Focus history'))
    await waitFor(() => expect(calls(f, 'PUT', /intelligence\/settings$/)).toEqual([{ sources: { focus: false } }]))
    fireEvent.click(screen.getByRole('radio', { name: 'Daily digest' }))
    await waitFor(() => expect(calls(f, 'PUT', /intelligence\/settings$/).at(-1)).toEqual({ frequency: 'daily' }))
    fireEvent.click(screen.getByLabelText('Share connected-calendar details with it'))
    await waitFor(() => expect(calls(f, 'PUT', /\/api\/settings$/)).toEqual([{ ai_connected_data: true }]))
    expect(await screen.findByText('Plan for Monday')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Delete AI data/ }))
    expect(screen.getByText(/permanently deletes 4 suggestion\(s\) with your ratings, 3 Copilot proposal\(s\) and 0 conversation\(s\)/)).toBeInTheDocument()
    expect(calls(f, 'DELETE', /data$/)).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))
    await waitFor(() => expect(calls(f, 'DELETE', /intelligence\/data$/).length).toBe(1))
  })
})

describe('weekly intelligence', () => {
  const weekly: Extract<WeeklyIntelligenceData, { enabled: true }> = { enabled: true, narrative_available: false,
    facts: [{ key: 'completed', value: 3, unit: 'tasks', source: 'tasks' }, { key: 'focus_minutes', value: 100, unit: 'minutes', source: 'focus', previous: 300, change_percent: -67 }],
    interpretations: [{ key: 'focus_trend', en: 'Focus time fell 67% compared with last week.', ar: 'انخفض وقت التركيز.', evidence: ['focus_minutes'], confidence: 'high', kind: 'rule' }],
    workload: [{ date: '2027-03-15', committed_minutes: 120, capacity_minutes: 480, load_percent: 25, focus_minutes: 60, completed: 1 }], suggestions: [{ key: 'buffer', en: 'Add about 30% to estimates.', ar: 'أضف ٣٠٪.', link: null }] }
  it('separates measured facts from rule-based interpretations and labels the summary honestly', async () => {
    mockApi([user, { match: /\/narrative$/, method: 'POST', body: { kind: 'rules', text: 'You completed 3 task(s).', fallback_reason: 'provider_error' } }])
    render(wrap(<WeeklyInsights week="2027-03-15" data={weekly} />))
    expect(screen.getByText('Measured')).toBeInTheDocument()
    expect(screen.getByText('-67%')).toBeInTheDocument()
    expect(screen.getByText('Interpretations · rule-based')).toBeInTheDocument()
    expect(screen.getByText('From: Focus minutes')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Summarise my week/ }))
    expect(await screen.findByText('Rule-based summary')).toBeInTheDocument()
    expect(screen.getByText(/did not answer, so this rule-based summary was used instead/)).toBeInTheDocument()
  })
})

describe('re-planning after an interruption', () => {
  it('recalculates from the real calendar with the reported interruption', async () => {
    const plan = { date: '2027-03-23', timezone: 'UTC', replan: false, energy: null, estimate_ratio: 1, recommended: 'deadlines', budget: { window_minutes: 480, committed_minutes: 0, free_minutes: 480, capacity_minutes: 480, must_do_minutes: 0, buffer_minutes: 10 }, boundaries: {}, peak: null, commitments: [], overload: null, recovery: [], explanation: [], alternatives: [{ key: 'deadlines', title: { en: 'Deadlines first', ar: '' }, description: { en: 'By due date.', ar: '' }, items: [], warnings: [], breaks: [], metrics: { planned_minutes: 0, tasks: 0, switches: 0, load_percent: 0, unscheduled_must_do: 0 }, explanation: [] }] }
    const f = mockApi([user, { match: /\/api\/day-plan\?/, body: plan }, { match: /\/api\/settings$/, body: {} }])
    render(wrap(<DayPlanPage />))
    expect(await screen.findByRole('radio', { name: /Deadlines first/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: /Something came up/ }))
    fireEvent.change(screen.getByLabelText('Busy until'), { target: { value: '13:00' } })
    fireEvent.change(screen.getByLabelText('Time lost (minutes)'), { target: { value: '30' } })
    await waitFor(() => expect(calls(f, 'GET', /day-plan\?/).some(u => String(u).includes('busy_until=13%3A00') && String(u).includes('lost_minutes=30'))).toBe(true))
  })
})
