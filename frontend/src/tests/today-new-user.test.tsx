import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import Dashboard from '../features/Dashboard'
import { QuickCheckin } from '../features/today/QuickCheckin'
import { PriorityMark } from '../components/visual'
import type { Briefing, TodayData } from '../lib/api'

/** A brand-new account is not asked about its energy before it has anything to plan; ordinary rows carry no priority dash. */
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals(); vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-01-04T10:00:00Z') }) })

type Task = Briefing['focus'][number]
const task = (id: number, title: string, priority: string): Task => ({ id, title, priority, status: 'todo', estimated_minutes: 30, due_at: null, score: 50, reasons: [] })
const briefing = (focus: Task[]): Briefing => ({
  date: '2027-01-04', timezone: 'UTC', period: 'morning',
  stats: { completed_today: 0, focus_minutes_today: 0, open_tasks: focus.length, overdue_tasks: 0, available_minutes: 480, booked_minutes: 0, load_percent: 0 },
  focus, agenda: [], next_event: null, habits: [], goals: [], suggestions: [],
})
const today = (checkin: TodayData['energy']['checkin'] = null): TodayData => ({
  date: '2027-01-04', period: 'morning', briefing: [], reflection_prompt: null, timezone: 'UTC',
  energy: { checkin, enabled: true, energy: null, workload: null, load_percent: 0, level: 'light' },
  timeline: [], focus_time: { free_minutes: 480, slots: [], peak: null, next_task: null }, deadlines: [],
  progress: { tasks: { done: 0, target: 3 }, focus: { done: 0, target: 60 }, habits: { done: 0, target: 0 }, overall: 0 },
})
function stub(b: Briefing, t: TodayData) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = /\/api\/user$/.test(url) ? { id: 1, name: 'New Person', email: 'n@x.io' } : /\/api\/briefing$/.test(url) ? b : /\/api\/today$/.test(url) ? t
      : /\/api\/settings$/.test(url) ? { language: 'en' } : /\/api\/recommendations/.test(url) ? { enabled: false, data: [] } : {}
    return new Response(JSON.stringify(body), { status: /\/api\/(user|briefing|today|settings|recommendations)/.test(url) ? 200 : 404 })
  }))
}
const QUESTION = 'How’s your energy today?'

describe('the energy question on Today', () => {
  it('is not shown to someone with no open tasks and no check-in today', async () => {
    stub(briefing([]), today())
    render(wrap(<Dashboard />))
    expect(await screen.findByText('No open tasks.')).toBeInTheDocument()
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(c => /\/api\/today$/.test(String(c[0])))).toBe(true))
    await new Promise(r => setTimeout(r, 20))
    expect(screen.queryByText(QUESTION)).toBeNull()
  })

  it('is shown as soon as there is one open task, with the line saying what the answer does', async () => {
    stub(briefing([task(7, 'Call the bank', 'medium')]), today())
    render(wrap(<Dashboard />))
    expect(await screen.findByText(QUESTION)).toBeInTheDocument()
    expect(screen.getByText('When your energy is low, new sessions are planned shorter.')).toBeInTheDocument()
  })

  it('is shown with no tasks when today already has a check-in without an energy answer', async () => {
    stub(briefing([]), today({ date: '2027-01-04', mood: 3, energy: null } as unknown as TodayData['energy']['checkin']))
    render(wrap(<Dashboard />))
    expect(await screen.findByText(QUESTION)).toBeInTheDocument()
  })

  it.each([
    ['ar', 'حين تكون طاقتك منخفضة تُخطَّط الجلسات الجديدة أقصر.'],
    ['nl', 'Als je energie laag is, worden nieuwe sessies korter gepland.'],
    ['en', 'When your energy is low, new sessions are planned shorter.'],
  ])('the line is in %s and describes the five answers', (language, line) => {
    localStorage.setItem('lifeos-language', language)
    render(wrap(<QuickCheckin today={today()} onSaved={() => {}} />))
    const text = screen.getByText(line)
    expect(text).toHaveClass('muted')
    expect(screen.getByRole('group')).toHaveAccessibleDescription(line)
  })
})

describe('the default priority has no chip on a row', () => {
  it('a normal task row shows no priority mark; urgent, high and low keep theirs', async () => {
    stub(briefing([task(1, 'Normal one', 'medium'), task(2, 'Urgent one', 'urgent'), task(3, 'Low one', 'low')]), today())
    const { container } = render(wrap(<Dashboard />))
    await screen.findAllByText('Normal one')
    const row = (title: string) => screen.getAllByText(title).map(n => n.closest('.task-item')).find(Boolean) as HTMLElement
    expect(row('Normal one').querySelector('.prio')).toBeNull()
    expect(within(row('Urgent one')).getByText('Urgent')).toHaveClass('sr-only')
    expect(row('Low one').querySelector('.prio-low')).not.toBeNull()
    expect(container.querySelector('.task-item .prio-medium')).toBeNull()
  })

  it('PriorityMark: nothing for medium, null or unknown on a row; the labelled form still says it', () => {
    const { container } = render(wrap(<><PriorityMark priority="medium" /><PriorityMark priority={null} /><PriorityMark /></>))
    expect(container.querySelector('.prio')).toBeNull()
    cleanup()
    render(wrap(<><PriorityMark priority="high" /><PriorityMark priority="medium" labelled /></>))
    expect(screen.getByText('High')).toBeInTheDocument()
    expect(screen.getByText('Medium')).toBeVisible()
  })
})
