import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { layoutLanes } from '../lib/calendar'
import NotificationCenter from '../components/layout/NotificationCenter'
import Dashboard from '../features/Dashboard'
import AssistantPage from '../features/AssistantPage'
import type { Briefing, RecordItem } from '../lib/api'

type Route = { match: RegExp; method?: string; body: unknown }
function mockApi(routes: Route[]) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes.find(r => r.match.test(url) && (!r.method || r.method === (init?.method || 'GET')))
    return new Response(JSON.stringify(route ? route.body : {}), { status: route ? 200 : 404 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
function wrap(children: ReactNode) {
  return <ThemeProvider><LanguageProvider><MemoryRouter><AuthProvider>{children}</AuthProvider></MemoryRouter></LanguageProvider></ThemeProvider>
}

beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals() })

describe('calendar lanes', () => {
  const event = (id: number, start: string, end: string) => ({ id, title: `E${id}`, starts_at: `2027-01-04T${start}:00Z`, ends_at: `2027-01-04T${end}:00Z` }) as RecordItem
  it('places overlapping events side by side and separate clusters full width', () => {
    const lanes = layoutLanes([event(1, '09:00', '10:00'), event(2, '09:30', '11:00'), event(3, '12:00', '13:00')])
    const byId = Object.fromEntries(lanes.map(l => [l.item.id, l]))
    expect(byId[1]).toMatchObject({ lane: 0, lanes: 2 })
    expect(byId[2]).toMatchObject({ lane: 1, lanes: 2 })
    expect(byId[3]).toMatchObject({ lane: 0, lanes: 1 })
  })
  it('treats back-to-back events as non-overlapping', () => {
    const lanes = layoutLanes([event(1, '09:00', '10:00'), event(2, '10:00', '11:00')])
    expect(lanes.every(l => l.lanes === 1 && l.lane === 0)).toBe(true)
  })
})

describe('notification center', () => {
  it('shows the unread badge and marks everything read', async () => {
    const fetcher = mockApi([
      { match: /notifications\/unread$/, body: { unread_count: 2 } },
      { match: /notifications\/read-all$/, method: 'POST', body: { unread_count: 0 } },
      { match: /notifications$/, body: { data: [{ id: 1, title: 'Reminder: Call', kind: 'reminder', link: '/tasks', read_at: null, created_at: new Date().toISOString() }], unread_count: 2 } },
    ])
    render(wrap(<NotificationCenter />))
    const bell = await screen.findByRole('button', { name: 'Notifications, 2 unread' })
    expect(screen.getByText('2')).toBeInTheDocument()
    fireEvent.click(bell)
    expect(await screen.findByText('Reminder: Call')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Mark all read/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument())
    expect(fetcher).toHaveBeenCalledWith('/api/notifications/read-all', expect.objectContaining({ method: 'POST' }))
  })
})

const briefing: Briefing = {
  date: '2027-01-04', timezone: 'UTC', period: 'afternoon',
  stats: { completed_today: 2, focus_minutes_today: 50, open_tasks: 4, overdue_tasks: 1, available_minutes: 480, booked_minutes: 120, load_percent: 25 },
  focus: [{ id: 7, title: 'Ship the report', priority: 'urgent', status: 'todo', estimated_minutes: 45, due_at: null, score: 70, reasons: ['urgent', 'overdue'] }],
  agenda: [], next_event: null,
  habits: [{ id: 3, title: 'Read', color: '#6366f1', recurrence: 'daily', current_streak: 4, longest_streak: 9, done_today: false, done_this_period: false, at_risk: true }],
  goals: [{ id: 2, title: 'Run 100km', color: '#059669', progress: 40, target: 100, percent: 40, due_at: null }],
  suggestions: [{ type: 'warning', en: 'You have 1 overdue task(s).', ar: 'لديك مهمة متأخرة', action: '/tasks?due=overdue' }],
}

describe('dashboard', () => {
  it('renders the briefing and logs a habit for today', async () => {
    const fetcher = mockApi([
      { match: /\/api\/user$/, body: { id: 1, name: 'Abbas Test', email: 'a@example.com' } },
      { match: /\/api\/briefing$/, body: briefing },
      { match: /\/api\/overview$/, body: { total_tasks: 4, completed_tasks: 2, completion_rate: 50, overdue_tasks: 1, focus_minutes: 120, estimated_minutes: 0, actual_minutes: 0, days: [] } },
      { match: /\/api\/habits\/3\/entry$/, method: 'PUT', body: { message: 'Saved.' } },
    ])
    render(wrap(<Dashboard />))
    expect(await screen.findByText('Ship the report')).toBeInTheDocument()
    expect(screen.getByText('Good afternoon', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('Overdue', { selector: '.chip' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /1 overdue task/ })).toHaveAttribute('href', '/tasks?due=overdue')
    expect(screen.getByText('Run 100km')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Read/ }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/habits/3/entry', expect.objectContaining({ method: 'PUT' })))
    const body = JSON.parse(fetcher.mock.calls.find(c => c[0] === '/api/habits/3/entry')![1]!.body as string)
    expect(body.completed).toBe(true)
  })
})

describe('assistant', () => {
  it('sends a prompt chip and renders the local reply with actionable steps', async () => {
    const reply = { id: 2, role: 'assistant', content: 'Here’s a suggested breakdown.', intent: 'breakdown', provider: 'local', created_at: '2027-01-04T10:00:00Z', subtasks: [{ title: 'Define the outcome', estimated_minutes: 10 }, { title: 'Do the core work', estimated_minutes: 45 }], tasks: [{ id: 9, title: 'Thesis', priority: 'high', estimated_minutes: 60, due_at: null }], context: { shared: false, sources: [{ source: 'tasks' }] } }
    const asked = { id: 1, role: 'user', content: 'Break down my top task into steps', intent: null, provider: null, created_at: '2027-01-04T10:00:00Z' }
    const conversation = { id: '9b2c6f5e-0000-4000-8000-000000000001', title: 'Break down my top task into steps', language: 'en', last_message_at: '2027-01-04T10:00:00Z', created_at: '2027-01-04T10:00:00Z' }
    const fetcher = mockApi([
      { match: /\/api\/user$/, body: { id: 1, name: 'A', email: 'a@example.com' } },
      { match: /\/api\/copilot\/conversations\?/, body: { conversations: [], suggestions: ['Break down my top task into steps', 'How was my week?'], personalization: false, retention_days: 90 } },
      { match: /\/api\/copilot\/conversations\/[0-9a-f-]+$/, body: { conversation, messages: [asked, reply] } },
      { match: /\/api\/copilot\/messages$/, method: 'POST', body: { conversation, user_message: asked, message: reply, replayed: false } },
    ])
    render(wrap(<AssistantPage />))
    fireEvent.click(await screen.findByRole('button', { name: 'Break down my top task into steps' }))
    expect(await screen.findByText('Here’s a suggested breakdown.')).toBeInTheDocument()
    expect(screen.getByText(/Rule-based · Local assistant/)).toBeInTheDocument()
    expect(screen.getByText('Used on this server:')).toBeInTheDocument()
    expect(screen.getByText('Do the core work')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add as steps to this task/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'How was my week?' })).toBeInTheDocument()
    const body = JSON.parse(fetcher.mock.calls.find(c => String(c[0]).endsWith('/api/copilot/messages'))![1]!.body as string)
    expect(body).toMatchObject({ message: 'Break down my top task into steps', language: 'en' })
    expect(body.client_id).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})
