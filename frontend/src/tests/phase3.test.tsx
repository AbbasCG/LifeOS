import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import { findConflict, movePreview, overlappingIds, resizePreview, snap } from '../lib/calendar'
import { moveItem, normalizeLayout, WIDGETS } from '../lib/dashboard'
import { api, ApiError, type Plan, type RecordItem, type WeeklyReviewData } from '../lib/api'
import PlanningPage from '../features/PlanningPage'
import ReviewPage from '../features/ReviewPage'
import DashboardCustomizer from '../features/DashboardCustomizer'
import OfflineBanner from '../components/layout/OfflineBanner'

type Route = { match: RegExp; method?: string; body: unknown; status?: number }
function mockApi(routes: Route[]) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes.find(r => r.match.test(url) && (!r.method || r.method === (init?.method || 'GET')))
    return new Response(JSON.stringify(route ? route.body : {}), { status: route ? route.status ?? 200 : 404 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const bodyOf = (fetcher: ReturnType<typeof mockApi>, url: string, method: string) => JSON.parse(fetcher.mock.calls.find(c => c[0] === url && c[1]?.method === method)![1]!.body as string)
function wrap(children: ReactNode) {
  return <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
}
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals() })

describe('calendar drag math', () => {
  const day = new Date(2027, 0, 4)
  const at = (h: number, m = 0) => new Date(2027, 0, 4, h, m)
  it('snaps to 15 minutes', () => { expect(snap(22)).toBe(15); expect(snap(23)).toBe(30); expect(snap(-8)).toBe(-15) })
  it('moves a block keeping its duration and stays inside the day', () => {
    const moved = movePreview(at(9), at(10, 30), day, new Date(2027, 0, 5), 47)
    expect(moved.start).toEqual(new Date(2027, 0, 5, 9, 45))
    expect(moved.end).toEqual(new Date(2027, 0, 5, 11, 15))
    expect(movePreview(at(23), at(23, 45), day, day, 120).end).toEqual(new Date(2027, 0, 5, 0, 0))
  })
  it('resizes from the bottom edge with a 15 minute minimum', () => {
    expect(resizePreview(at(9), at(10), day, 31).end).toEqual(at(10, 30))
    expect(resizePreview(at(9), at(10), day, -500).end).toEqual(at(9, 15))
  })
  it('detects conflicts but allows touching edges', () => {
    const items = [{ id: 1, title: 'A', starts_at: at(9).toISOString(), ends_at: at(10).toISOString() }, { id: 2, title: 'B', starts_at: at(10).toISOString(), ends_at: at(11).toISOString() }] as RecordItem[]
    expect(findConflict(items, 2, at(10), at(11))).toBeUndefined()
    expect(findConflict(items, 2, at(9, 30), at(10, 30))?.title).toBe('A')
    expect(overlappingIds(items).size).toBe(0)
    expect(overlappingIds([...items, { id: 3, title: 'C', starts_at: at(9, 45).toISOString(), ends_at: at(10, 15).toISOString() } as RecordItem])).toEqual(new Set([1, 3, 2]))
  })
})

describe('dashboard layout', () => {
  it('drops unknown widgets, de-duplicates and appends new ones', () => {
    const layout = normalizeLayout({ order: ['agenda', 'agenda', 'bogus' as never, 'stats'], hidden: ['goals', 'nope' as never] })
    expect(layout.order.slice(0, 2)).toEqual(['agenda', 'stats'])
    expect(layout.order).toHaveLength(WIDGETS.length)
    expect(layout.hidden).toEqual(['goals'])
  })
  it('moves items', () => { expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']) })
  it('saves visibility and order from the customization drawer', async () => {
    const fetcher = mockApi([{ match: /\/api\/user$/, body: { id: 1, name: 'A', email: 'a@x.io' } }, { match: /\/api\/settings$/, method: 'PUT', body: {} }])
    const onSaved = vi.fn()
    render(wrap(<DashboardCustomizer layout={normalizeLayout(null)} onClose={() => {}} onSaved={onSaved} />))
    fireEvent.click(screen.getByRole('switch', { name: 'Show Goals in motion' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move Today at a glance up' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const body = bodyOf(fetcher, '/api/settings', 'PUT')
    expect(body.dashboard.hidden).toEqual(['goals'])
    expect(body.dashboard.order.slice(0, 2)).toEqual(['stats', 'suggestions'])
    expect(await screen.findByText('Dashboard updated.')).toBeInTheDocument()
  })
})

const future = (h: number) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, 0, 0, 0); return d.toISOString() }
const plan: Plan = {
  id: 5, status: 'pending', starts_on: '2027-01-04', days: 7, created_at: new Date().toISOString(), accepted_at: null,
  items: [
    { key: 'a', task_id: 1, title: 'Thesis', priority: 'high', starts_at: future(9), ends_at: future(10), minutes: 60, part: 1, parts: 2, manual: false, reasons: ['high'], explanation: { en: 'High priority · focus block 1 of 2', ar: 'أولوية عالية' } },
    { key: 'b', task_id: 1, title: 'Thesis', priority: 'high', starts_at: future(11), ends_at: future(12), minutes: 60, part: 2, parts: 2, manual: false, reasons: ['high'], explanation: { en: 'High priority · focus block 2 of 2', ar: 'أولوية عالية' } },
  ],
  warnings: [{ task_id: 2, title: 'Huge report', priority: 'medium', needed_minutes: 900, due_at: null, reason: 'Not enough free working time in this window. No partial task was scheduled.', reason_ar: '…', alternatives: [{ type: 'manual', en: 'Add a block manually, even outside working hours.', ar: '…' }] }],
  summary: { days: [{ date: '2027-01-04', work_day: true, capacity_minutes: 480, fixed_minutes: 400, existing_flexible_minutes: 0, planned_minutes: 60, free_minutes: 20, load_percent: 96, overloaded: true }], totals: { planned_minutes: 120, blocks: 2, tasks_scheduled: 1, tasks_unscheduled: 1, unscheduled_minutes: 900, capacity_minutes: 480 }, overload: [{ date: '2027-01-04', load_percent: 96, en: '2027-01-04 is 96% booked. Consider moving a flexible block to 2027-01-05 (10%).', ar: '…', suggested_date: '2027-01-05' }] },
}

describe('weekly planning', () => {
  it('previews, explains, edits and then accepts a proposal', async () => {
    const fetcher = mockApi([
      { match: /\/api\/user$/, body: { id: 1, name: 'A', email: 'a@x.io' } },
      { match: /\/api\/plans$/, method: 'GET', body: [plan] },
      { match: /\/api\/plans\/missed$/, body: { data: [] } },
      { match: /\/api\/plans\/insights/, body: { from: '2027-01-04', days: [], tasks: [], totals: { planned_minutes: 0, actual_minutes: 0, ratio: null, planned_tasks: 0, completed_planned_tasks: 0, completion_rate: null } } },
      { match: /\/api\/tasks\?/, body: { data: [] } },
      { match: /\/api\/plans\/5$/, method: 'PATCH', body: { ...plan, items: [plan.items[0]] } },
      { match: /\/api\/plans\/5\/accept$/, method: 'POST', body: { ...plan, items: [plan.items[0]], status: 'accepted' } },
    ])
    render(wrap(<PlanningPage />))
    expect(await screen.findByText('High priority · focus block 1 of 2')).toBeInTheDocument()
    expect(screen.getByText(/96% booked/)).toBeInTheDocument()
    expect(screen.getByText('Huge report')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove block' })[1])
    expect(screen.getByText('You have unsaved changes.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Save & accept/ }))
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/plans/5/accept', expect.objectContaining({ method: 'POST' })))
    expect(bodyOf(fetcher, '/api/plans/5', 'PATCH').items).toEqual([{ key: 'a', task_id: 1, starts_at: plan.items[0].starts_at, ends_at: plan.items[0].ends_at }])
    expect(await screen.findByText('These blocks are on your calendar.')).toBeInTheDocument()
  })
})

const review: WeeklyReviewData = {
  week_start: '2027-01-04', week_end: '2027-01-10', timezone: 'UTC',
  metrics: { completed: 4, unfinished: 1, focus_minutes: 300, previous_focus_minutes: 200, focus_change: 50, on_time_rate: 100, habit_consistency: 80, estimate_overruns: 0 },
  completed: [], unfinished: [{ id: 9, title: 'Write report', priority: 'high', status: 'inbox', due_at: '2027-01-07T10:00:00Z', overdue: true, estimated_minutes: 60 }],
  focus_by_day: [], planned_vs_actual: { from: '2027-01-04', days: [], tasks: [], totals: { planned_minutes: 0, actual_minutes: 0, ratio: null, planned_tasks: 0, completed_planned_tasks: 0, completion_rate: null } },
  goals: [], habits: [], achievements: [{ key: 'deep_work', en: '5 hours of focused work.', ar: '…' }], improvements: [],
  suggested_priorities: [{ id: 9, title: 'Write report', priority: 'high', estimated_minutes: 60, due_at: null, reasons: ['overdue'] }],
  review: { status: 'new', reflection: { wins: '', challenges: '', lessons: '', rating: null }, decisions: {}, priorities: [], completed_at: null },
}

describe('weekly review', () => {
  it('walks through the steps, records decisions and completes the review', async () => {
    const fetcher = mockApi([
      { match: /\/api\/user$/, body: { id: 1, name: 'A', email: 'a@x.io' } },
      { match: /\/api\/reviews\/\d{4}-\d{2}-\d{2}$/, method: 'GET', body: review },
      { match: /\/api\/reviews\/\d{4}-\d{2}-\d{2}$/, method: 'PUT', body: review },
      { match: /\/api\/reviews\/.*\/complete$/, method: 'POST', body: { ...review, review: { ...review.review, status: 'completed' }, applied: { done: 0, carry: 1, drop: 0 } } },
    ])
    render(wrap(<ReviewPage />))
    expect(await screen.findByText('5 hours of focused work.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    const group = await screen.findByRole('radiogroup', { name: 'Write report' })
    fireEvent.click(within(group).getByRole('radio', { name: /Carry over/ }))
    for (let i = 0; i < 3; i++) { fireEvent.click(screen.getByRole('button', { name: /Continue/ })); await new Promise(r => setTimeout(r, 0)) }
    fireEvent.click(await screen.findByRole('button', { name: /Complete review/ }))
    await waitFor(() => expect(fetcher.mock.calls.some(c => String(c[0]).endsWith('/complete'))).toBe(true))
    const url = fetcher.mock.calls.find(c => String(c[0]).endsWith('/complete'))![0] as string
    const body = bodyOf(fetcher, url, 'POST')
    expect(body.decisions).toEqual({ 9: 'carry' })
    expect(body.priorities).toEqual([9])
    expect(await screen.findByText(/Review completed\. 0 done, 1 carried over, 0 dropped\./)).toBeInTheDocument()
  })
})

describe('offline behaviour', () => {
  it('turns network failures into a friendly ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(api('/api/tasks')).rejects.toMatchObject({ status: 0 })
    await expect(api('/api/tasks')).rejects.toBeInstanceOf(ApiError)
  })
  it('shows an offline banner', () => {
    const spy = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    render(wrap(<OfflineBanner />))
    expect(screen.getByText(/You’re offline\. You can browse/)).toBeInTheDocument()
    spy.mockRestore()
  })
})
