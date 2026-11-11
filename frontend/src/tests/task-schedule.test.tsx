import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import axe from 'axe-core'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import TasksPage from '../features/TasksPage'
import CalendarPage from '../features/CalendarPage'
import { setAccountZone } from '../lib/accountDay'
import { CALENDAR_CHANGED, calendarLink, durationWords, sessionWhen } from '../lib/taskSchedule'
import { TASKS_CHANGED } from '../lib/quickAdd'
import { uniqueById } from '../lib/useCalendar'
import { DueChip } from '../components/visual'
import type { Availability, CalendarOccurrence } from '../lib/api'

type Call = [string, RequestInit | undefined]
const wrap = (children: ReactNode, path = '/') => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[path]}><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>

// "Now" is Wednesday 2026-11-11 11:00 in Amsterdam (10:00 UTC).
const NOW = '2026-11-11T10:00:00Z'
const ZONE = 'Europe/Amsterdam'
const en = (a: string) => a
const ar = (_a: string, b: string) => b
const nl = (a: string, _b: string, c?: string) => c ?? a

describe('the session time: local day, local time, midnight and clock changes', () => {
  const when = (iso: string, now: string, t: (e: string, a: string, n?: string) => string = en, language = 'en') => sessionWhen(iso, language, t, new Date(now), ZONE)

  it('shows the local time of the session in the user’s timezone, never the UTC time', () => {
    expect(when('2026-11-12T08:00:00Z', NOW).text).toBe('Tomorrow 09:00 AM')
    expect(when('2026-11-12T08:00:00Z', NOW, nl, 'nl').text).toBe('Morgen 09:00')
    expect(when('2026-11-12T08:00:00Z', NOW, ar, 'ar').text).toBe('غدًا 09:00')
    expect(when('2026-11-11T13:30:00Z', NOW, ar, 'ar').text).toBe('اليوم 14:30')
  })
  it('says tomorrow only when the local calendar date is tomorrow: just before and just after local midnight', () => {
    const now = '2026-11-11T22:30:00Z'   // 23:30 on the 11th in Amsterdam
    expect(when('2026-11-11T22:45:00Z', now).day).toBe('today')      // 23:45 local, same date
    expect(when('2026-11-11T23:00:00Z', now).day).toBe('tomorrow')   // 00:00 local on the 12th, only 30 minutes later
    expect(when('2026-11-12T22:30:00Z', now).day).toBe('tomorrow')   // 23:30 local on the 12th, 24 hours later
    expect(when('2026-11-12T23:00:00Z', now).day).toBe('date')       // 00:00 on the 13th: no longer tomorrow
  })
  it('stays right across the spring change on 2026-03-29 (a 23-hour day)', () => {
    const now = '2026-03-28T23:30:00Z'   // 00:30 CET on the 29th
    expect(when('2026-03-29T22:30:00Z', now).day).toBe('tomorrow')   // 00:30 CEST on the 30th: 23 hours later
    expect(when('2026-03-29T22:30:00Z', now).text).toBe('Tomorrow 12:30 AM')
    expect(when('2026-03-30T22:30:00Z', now).day).toBe('date')       // the 31st at 00:30
    expect(when('2026-03-29T00:30:00Z', now).day).toBe('today')      // 01:30 CET the same morning
  })
  it('stays right across the autumn change on 2026-10-25 (a 25-hour day)', () => {
    const now = '2026-10-24T22:30:00Z'   // 00:30 CEST on the 25th
    expect(when('2026-10-25T23:30:00Z', now).day).toBe('tomorrow')   // 00:30 CET on the 26th: 25 hours later
    expect(when('2026-10-25T23:30:00Z', now, nl, 'nl').timeText).toBe('00:30')
    expect(when('2026-10-26T22:30:00Z', now).day).toBe('tomorrow')   // 23:30 on the 26th is still tomorrow
    expect(when('2026-10-26T23:30:00Z', now).day).toBe('date')       // 00:30 on the 27th
    expect(when('2026-10-25T01:30:00Z', now).day).toBe('today')      // the repeated hour is still the 25th
  })
  it('names a later day with its weekday and date, and the duration apart from the clock time', () => {
    expect(when('2026-11-14T08:00:00Z', NOW).dayText).toMatch(/Sat/)
    const t = (e: string, a: string, n?: string) => nl(e, a, n)
    expect(durationWords(30, en)).toBe('30 min'); expect(durationWords(30, ar)).toBe('30 دقيقة'); expect(durationWords(90, t)).toBe('1 u 30 min')
  })
  it('links to the calendar on the session’s own local day', () => {
    expect(calendarLink('2026-11-11T23:30:00Z', 55, ZONE)).toBe('/calendar?date=2026-11-12&session=55')   // 00:30 on the 12th locally, still the 11th in UTC
  })
})

const task = (over: Record<string, unknown> = {}) => ({ id: 7, title: 'Pay the invoice', status: 'todo', priority: 'high', due_at: '2026-11-20T15:00:00Z', estimated_minutes: 30, schedule: null, ...over })
const session = (over: Record<string, unknown> = {}) => ({ session_id: 55, starts_at: '2026-11-12T08:00:00Z', ends_at: '2026-11-12T08:30:00Z', sessions: 1, split: false, ...over })
const free: Availability = {
  work_start: '09:00', work_end: '17:00',
  days: [
    { date: '2026-11-11', work_day: true, free_minutes: 120, slots: [{ starts_at: '2026-11-11T13:00:00Z', ends_at: '2026-11-11T15:00:00Z', minutes: 120 }] },
    { date: '2026-11-12', work_day: true, free_minutes: 480, slots: [{ starts_at: '2026-11-12T10:00:00Z', ends_at: '2026-11-12T16:00:00Z', minutes: 360 }] },
    { date: '2026-11-13', work_day: true, free_minutes: 480, slots: [{ starts_at: '2026-11-13T08:00:00Z', ends_at: '2026-11-13T16:00:00Z', minutes: 480 }] },
  ],
}
const occurrence = (over: Partial<CalendarOccurrence> = {}): CalendarOccurrence => ({ id: 'e55', event_id: 55, source: 'lifeos', title: 'Pay the invoice', kind: 'flexible', task_id: 7, starts_at: '2026-11-12T08:00:00Z', ends_at: '2026-11-12T08:30:00Z', recurring: false, occurrence_start: null, editable: true, ...over })

type Reply = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>
type Stub = { tasks: unknown[]; calendar: CalendarOccurrence[]; free?: Availability; post?: (init: RequestInit) => Reply; put?: (init: RequestInit) => Reply }
function stub(state: Stub) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const reply = (r: { status: number; body: unknown }) => new Response(JSON.stringify(r.body), { status: r.status })
    if (init?.method === 'POST' && /\/api\/tasks\/\d+\/schedule$/.test(url)) return reply(await (state.post?.(init) ?? { status: 201, body: { data: { id: 99 }, schedule: session({ session_id: 99 }) } }))
    if (init?.method === 'PUT' && /\/api\/tasks\/\d+\/schedule$/.test(url)) return reply(await (state.put?.(init) ?? { status: 200, body: { data: { id: 55 }, schedule: session() } }))
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    const body = /\/api\/user$/.test(url) ? { id: 1, name: 'A', email: 'a@x.io', timezone: ZONE }
      : /\/api\/availability/.test(url) ? (state.free ?? free)
      : /\/api\/calendar/.test(url) ? { data: state.calendar }
      : /\/api\/connected\/tasks/.test(url) ? []
      : /\/api\/tasks/.test(url) ? { data: state.tasks, meta: { last_page: 1 } } : { data: [] }
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const calls = (f: ReturnType<typeof stub>, method: string, match?: RegExp) => (f.mock.calls as unknown as Call[]).filter(c => (c[1]?.method ?? 'GET') === method && (!match || match.test(String(c[0]))))
const taskReads = (f: ReturnType<typeof stub>) => calls(f, 'GET', /\/api\/tasks\?/).length

beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals(); setAccountZone(ZONE); vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) }) })
afterEach(() => { vi.useRealTimers(); setAccountZone(undefined) })

describe('the badge on a task row', () => {
  it('shows “Scheduled · Tomorrow 09:00” for a scheduled task, with the length and the deadline apart from it', async () => {
    stub({ tasks: [task({ schedule: session() })], calendar: [] })
    const { container } = render(wrap(<TasksPage />))
    await screen.findByText('Pay the invoice')
    const badge = container.querySelector('.sched-badge')!
    expect(badge).toHaveTextContent(/^Scheduled\s*Tomorrow 09:00 AM$/)
    expect(badge.querySelector('time')).toHaveAttribute('datetime', '2026-11-12T08:00:00Z')
    // the deadline has its own label and its own time (the 20th, 16:00), not the session's
    const meta = container.querySelector('.meta-row')!
    const due = meta.querySelector('.due')!
    expect(due).toHaveTextContent(/^Due/); expect(due.querySelector('time')).toHaveAttribute('datetime', '2026-11-20T15:00:00Z')
    expect(badge).not.toContainElement(due as HTMLElement)
    // the estimated length is separate and says what it is
    const duration = meta.querySelector('.sched-duration')!
    expect(duration).toHaveTextContent('Estimated time: 30 min'); expect(badge).not.toContainElement(duration as HTMLElement)
  })
  it('shows no badge, no “Due” label and a Schedule action for an unscheduled task', async () => {
    stub({ tasks: [task()], calendar: [] })
    const { container } = render(wrap(<TasksPage />))
    fireEvent.click(await screen.findByText('Pay the invoice'))
    expect(container.querySelector('.sched-badge')).toBeNull()
    expect(container.querySelector('.due-label')).toBeNull()
    expect(await screen.findByRole('group', { name: 'Schedule' })).toBeInTheDocument()
  })
  it('uses the session time, not the deadline, even when the deadline is earlier than the session', async () => {
    stub({ tasks: [task({ due_at: '2026-11-11T09:00:00Z', schedule: session({ starts_at: '2026-11-13T07:00:00Z', ends_at: '2026-11-13T07:30:00Z' }) })], calendar: [] })
    const { container } = render(wrap(<TasksPage />))
    await screen.findByText('Pay the invoice')
    expect(container.querySelector('.sched-badge time')).toHaveTextContent(/08:00 AM/)
    expect(container.querySelector('.sched-badge')).not.toHaveTextContent(/Today/)
  })
  it('says “N sessions” for a split task', async () => {
    stub({ tasks: [task({ schedule: session({ sessions: 3, split: true }) })], calendar: [] })
    const { container } = render(wrap(<TasksPage />))
    await screen.findByText('Pay the invoice')
    expect(container.querySelector('.sched-badge')).toHaveTextContent('3 sessions')
  })
  it.each([
    ['ar', 'مجدولة', 'غدًا 09:00', 'الاستحقاق', '30 دقيقة', 'عرض في التقويم', 'إعادة الجدولة', 'rtl'],
    ['nl', 'Gepland', 'Morgen 09:00', 'Deadline', '30 min', 'Bekijk in agenda', 'Opnieuw inplannen', 'ltr'],
    ['en', 'Scheduled', 'Tomorrow 09:00 AM', 'Due', '30 min', 'View in calendar', 'Reschedule', 'ltr'],
  ])('is complete in %s (%s) and reads in the right direction', async (lang, scheduled, when, due, minutes, view, again, dir) => {
    localStorage.setItem('lifeos-language', lang)
    stub({ tasks: [task({ schedule: session() })], calendar: [] })
    const { container } = render(wrap(<TasksPage />))
    await screen.findByText('Pay the invoice')
    expect(document.documentElement.dir).toBe(dir)
    expect(container.querySelector('.sched-badge')).toHaveTextContent(`${scheduled} ${when}`)
    expect(container.querySelector('.due-label')).toHaveTextContent(due)
    expect(container.querySelector('.sched-duration')).toHaveTextContent(minutes)
    fireEvent.click(container.querySelector('.task-body')!)
    expect(await screen.findByRole('link', { name: view })).toHaveAttribute('href', '/calendar?date=2026-11-12&session=55')
    expect(screen.getByRole('button', { name: again })).toBeInTheDocument()
  })
  it('is drawn with the app’s own colour tokens only (so light and dark both follow), and renders under the dark theme', async () => {
    localStorage.setItem('lifeos-theme', 'dark')
    stub({ tasks: [task({ schedule: session() })], calendar: [] })
    const { container } = render(wrap(<TasksPage />))
    await screen.findByText('Pay the invoice')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(container.querySelector('.sched-badge')).toBeInTheDocument()
    const css = readFileSync(resolve(__dirname, '../styles/visual.css'), 'utf8')
    const rules = css.split('\n').filter(l => /^(\.sched-|\.due-label|a\.filter-chip)/.test(l)).join('\n')
    expect(rules).toContain('var(--color-primary)')
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)   // no colour of its own: tokens, so light and dark both follow
    expect(rules).not.toMatch(/animation|transition/)   // nothing moves, so reduced motion has nothing to switch off
    // (real contrast in light and dark is measured in the browser run: e2e/task-scheduling.spec.ts)
  })
  it('has no accessibility violations (structure, names, roles) on a scheduled row that is open', async () => {
    stub({ tasks: [task({ schedule: session() })], calendar: [] })
    const { container } = render(wrap(<main><TasksPage /></main>))
    fireEvent.click(await screen.findByText('Pay the invoice'))
    await screen.findByRole('link', { name: 'View in calendar' })
    const row = container.querySelector('.task-item') as HTMLElement
    const result = await axe.run(row, { rules: { 'color-contrast': { enabled: false } } })   // contrast is measured in the browser run (e2e/task-scheduling.spec.ts)
    expect(result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)).toEqual([])
  })
})

describe('actions on a scheduled task', () => {
  it('replaces the Schedule choices with “View in calendar” and “Reschedule”', async () => {
    stub({ tasks: [task({ schedule: session() })], calendar: [] })
    render(wrap(<TasksPage />))
    fireEvent.click(await screen.findByText('Pay the invoice'))
    expect(await screen.findByRole('link', { name: 'View in calendar' })).toHaveAttribute('href', '/calendar?date=2026-11-12&session=55')
    expect(screen.getByRole('button', { name: 'Reschedule' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('group', { name: 'Schedule' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()   // the details stay one tap away
  })

  it('moves the existing session with PUT (never a second booking) and refreshes the tasks and the calendar', async () => {
    const f = stub({ tasks: [task({ schedule: session() })], calendar: [] })
    const changed = vi.fn(), calendar = vi.fn()
    window.addEventListener(TASKS_CHANGED, changed); window.addEventListener(CALENDAR_CHANGED, calendar)
    render(wrap(<TasksPage />))
    fireEvent.click(await screen.findByText('Pay the invoice'))
    fireEvent.click(await screen.findByRole('button', { name: 'Reschedule' }))
    const group = await screen.findByRole('group', { name: 'Reschedule' })
    const before = taskReads(f)
    fireEvent.click(within(group).getAllByRole('button')[0])
    await waitFor(() => expect(calls(f, 'PUT')).toHaveLength(1))
    expect(calls(f, 'PUT')[0][0]).toMatch(/\/api\/tasks\/7\/schedule$/)
    expect(JSON.parse(calls(f, 'PUT')[0][1]!.body as string)).toEqual({ starts_at: '2026-11-11T13:00:00.000Z', ends_at: '2026-11-11T13:30:00.000Z', session_id: 55 })
    expect(calls(f, 'POST')).toHaveLength(0)
    await screen.findByText(/moved to Today/)
    await waitFor(() => expect(taskReads(f)).toBeGreaterThan(before))   // the list reads the server again
    expect(changed).toHaveBeenCalled(); expect(calendar).toHaveBeenCalled()   // and so does every open calendar
    window.removeEventListener(TASKS_CHANGED, changed); window.removeEventListener(CALENDAR_CHANGED, calendar)
  })

  it('asks which session to move when a task has several, then moves that one', async () => {
    const f = stub({ tasks: [task({ schedule: session({ sessions: 2, split: true }) })], calendar: [occurrence(), occurrence({ id: 'e56', event_id: 56, starts_at: '2026-11-13T08:00:00Z', ends_at: '2026-11-13T08:30:00Z' }), occurrence({ id: 'x1', event_id: 70, task_id: 9 })] })
    render(wrap(<TasksPage />))
    fireEvent.click(await screen.findByText('Pay the invoice'))
    fireEvent.click(await screen.findByRole('button', { name: 'Reschedule' }))
    const which = await screen.findByRole('group', { name: 'Which session?' })
    expect(within(which).queryAllByRole('radio')).toHaveLength(0)   // plain buttons, not a fake radio group
    const options = within(which).getAllByRole('button').filter(b => b.textContent !== 'Cancel')
    expect(options).toHaveLength(2)   // only this task's sessions
    await waitFor(() => expect(options[0]).toHaveFocus())
    fireEvent.click(options[1])
    const group = await screen.findByRole('group', { name: 'Reschedule' })
    fireEvent.click(within(group).getAllByRole('button')[0])
    await waitFor(() => expect(calls(f, 'PUT')).toHaveLength(1))
    expect(JSON.parse(calls(f, 'PUT')[0][1]!.body as string).session_id).toBe(56)
  })

  it('works from the keyboard: Tab to Reschedule, Enter opens the choices with focus inside, Escape closes and returns focus', async () => {
    stub({ tasks: [task({ schedule: session() })], calendar: [] })
    const user = userEvent.setup({ advanceTimers: () => {} })
    render(wrap(<TasksPage />))
    const title = (await screen.findByText('Pay the invoice')).closest('button')!
    title.focus(); await user.keyboard('{Enter}')
    const link = await screen.findByRole('link', { name: 'View in calendar' }), reschedule = screen.getByRole('button', { name: 'Reschedule' })
    link.focus(); await user.tab()
    expect(reschedule).toHaveFocus()
    await user.keyboard('{Enter}')
    const group = await screen.findByRole('group', { name: 'Reschedule' })
    await waitFor(() => expect(within(group).getAllByRole('button')[0]).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Reschedule' })).toBeNull())
    await waitFor(() => expect(reschedule).toHaveFocus())
  })
})

const chips = async () => within(await screen.findByRole('group', { name: 'Schedule' })).getAllByRole('button')

describe('booking an unscheduled task', () => {

  it('two rapid real clicks on the same enabled chip send one request; the chip is aria-disabled (not disabled) and keeps focus while it runs', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const f = stub({ tasks: [task()], calendar: [], post: async () => { await gate; return { status: 201, body: { data: { id: 99 }, schedule: session({ session_id: 99 }) } } } })
    const user = userEvent.setup({ advanceTimers: () => {} })
    render(wrap(<TasksPage />))
    fireEvent.click(await screen.findByText('Pay the invoice'))
    const group = await screen.findByRole('group', { name: 'Schedule' }), [first] = await chips()
    const status = within(group).getByRole('status')
    expect(status).toBeEmptyDOMElement()                 // the live region exists before anything is busy
    expect(first).not.toHaveAttribute('aria-disabled')
    await user.dblClick(first)                           // pointer down/up/click, twice, on a chip that was enabled when the first one started
    await waitFor(() => expect(calls(f, 'POST')).toHaveLength(1))
    expect(first).toHaveAttribute('aria-disabled', 'true'); expect(first).not.toBeDisabled(); expect(first).toHaveFocus()
    expect(group).toHaveAttribute('aria-busy', 'true')
    expect(status).toHaveTextContent('Saving…')
    await user.click(within(group).getAllByRole('button')[1])
    release()
    await screen.findByText(/scheduled Today/)
    expect(calls(f, 'POST')).toHaveLength(1)
    expect((calls(f, 'POST')[0][1]!.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('the guard itself (not only aria-disabled) swallows two activations that land before React re-renders', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const f = stub({ tasks: [task()], calendar: [], post: async () => { await gate; return { status: 201, body: { data: { id: 99 }, schedule: session({ session_id: 99 }) } } } })
    render(wrap(<TasksPage />))
    fireEvent.click(await screen.findByText('Pay the invoice'))
    const [first] = await chips()
    act(() => { first.click(); first.click() })
    await waitFor(() => expect(calls(f, 'POST')).toHaveLength(1))
    release()
    await screen.findByText(/scheduled Today/)
    expect(calls(f, 'POST')).toHaveLength(1)
  })

  it('shows the row as scheduled at once after success, with the booking choices gone, and reads tasks and calendar again', async () => {
    const f = stub({ tasks: [task()], calendar: [] })
    const calendar = vi.fn()
    window.addEventListener(CALENDAR_CHANGED, calendar)
    const { container } = render(wrap(<TasksPage />))
    fireEvent.click(await screen.findByText('Pay the invoice'))
    const before = taskReads(f)
    fireEvent.click((await chips())[0])
    await waitFor(() => expect(container.querySelector('.sched-badge')).toBeInTheDocument())
    expect(screen.queryByRole('group', { name: 'Schedule' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reschedule' })).toBeInTheDocument()
    await waitFor(() => expect(taskReads(f)).toBeGreaterThan(before))
    expect(calendar).toHaveBeenCalled()
    window.removeEventListener(CALENDAR_CHANGED, calendar)
  })

  it('treats 409 “already scheduled” as a conflict: says so, offers both ways forward, refreshes, and never claims success', async () => {
    const f = stub({
      tasks: [task()], calendar: [],
      post: () => ({ status: 409, body: { message: 'Task is already scheduled.', code: 'task_already_scheduled', session: { id: 55, task_id: 7, starts_at: '2026-11-12T08:00:00Z', ends_at: '2026-11-12T08:30:00Z' } } }),
    })
    render(wrap(<TasksPage />))
    fireEvent.click(await screen.findByText('Pay the invoice'))
    const before = taskReads(f)
    fireEvent.click((await chips())[0])
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This task is already scheduled.')
    expect(within(alert).getByRole('link', { name: 'View in calendar' })).toHaveAttribute('href', '/calendar?date=2026-11-12&session=55')
    expect(within(alert).getByRole('button', { name: 'Reschedule' })).toBeInTheDocument()
    await waitFor(() => expect(taskReads(f)).toBeGreaterThan(before))
    expect(screen.queryByText(/scheduled (Today|Tomorrow)/i)).toBeNull()   // no success toast
    expect(calls(f, 'POST')).toHaveLength(1)
  })

  it('the swipe-to-schedule path asks nothing of the server for a task that is already scheduled', async () => {
    localStorage.setItem('lifeos-swipe-actions', JSON.stringify({ right: 'complete', left: 'schedule' }))
    const f = stub({ tasks: [task({ schedule: session() })], calendar: [] })
    const { container } = render(wrap(<TasksPage />))
    await screen.findByText('Pay the invoice')
    const line = container.querySelector('.task-line')!
    fireEvent.pointerDown(line, { pointerType: 'touch', pointerId: 1, clientX: 300, clientY: 10 })
    fireEvent.pointerMove(line, { pointerType: 'touch', pointerId: 1, clientX: 150, clientY: 10 })
    fireEvent.pointerUp(line, { pointerType: 'touch', pointerId: 1 })
    expect(await screen.findByRole('alert')).toHaveTextContent('This task is already scheduled.')
    expect(calls(f, 'POST')).toHaveLength(0)
  })

  it('a dropped connection keeps the idempotency key, so trying again cannot book twice', async () => {
    let attempt = 0
    const f = stub({ tasks: [task()], calendar: [], post: () => { attempt++; if (attempt === 1) throw new TypeError('network'); return { status: 200, body: { data: { id: 99 }, schedule: session({ session_id: 99 }) } } } })
    render(wrap(<TasksPage />))
    fireEvent.click(await screen.findByText('Pay the invoice'))
    fireEvent.click((await chips())[0])
    await waitFor(() => expect(calls(f, 'POST')).toHaveLength(1))
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Schedule' })).getAllByRole('button')[0]).not.toBeDisabled())
    fireEvent.click((await chips())[0])
    await waitFor(() => expect(calls(f, 'POST')).toHaveLength(2))
    const keys = calls(f, 'POST').map(c => (c[1]!.headers as Record<string, string>)['Idempotency-Key'])
    expect(keys[0]).toBe(keys[1])
  })
})

describe('the calendar', () => {
  const weekOf = '/calendar?date=2026-11-12&session=55'

  it('opens on the session’s day with that session focused', async () => {
    stub({ tasks: [task({ schedule: session() })], calendar: [occurrence()] })
    render(wrap(<CalendarPage />, weekOf))
    await waitFor(() => expect(document.querySelector('[data-session="55"]')).toHaveFocus())
    expect(document.querySelector('[data-session="55"]')).toHaveAttribute('data-task-id', '7')
  })

  it('draws one session once, even if the same occurrence id comes twice, but keeps two real rows that look alike', async () => {
    expect(uniqueById([occurrence(), occurrence()])).toHaveLength(1)
    stub({ tasks: [], calendar: [occurrence(), occurrence(), occurrence({ id: 'e56', event_id: 56 })] })
    render(wrap(<CalendarPage />, weekOf))
    await waitFor(() => expect(document.querySelectorAll('[data-session]').length).toBe(2))
    expect(document.querySelectorAll('[data-session="55"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-session="56"]')).toHaveLength(1)   // same title and time, different stored event: not hidden
  })

  it('reads the server again when a booking changes elsewhere', async () => {
    const f = stub({ tasks: [], calendar: [occurrence()] })
    render(wrap(<CalendarPage />, weekOf))
    await waitFor(() => expect(document.querySelector('[data-session="55"]')).toBeInTheDocument())
    const reads = () => calls(f, 'GET', /\/api\/calendar\?/).length, before = reads(), tasks = taskReads(f)
    act(() => { window.dispatchEvent(new Event(CALENDAR_CHANGED)) })
    await waitFor(() => expect(reads()).toBeGreaterThan(before))
    act(() => { window.dispatchEvent(new Event(TASKS_CHANGED)) })
    await waitFor(() => expect(taskReads(f)).toBeGreaterThan(tasks))
  })

  it('keeps a scheduled task out of the Unscheduled tray, even when its session is outside the days shown', async () => {
    stub({ tasks: [task({ schedule: session({ starts_at: '2026-12-20T08:00:00Z', ends_at: '2026-12-20T08:30:00Z' }) }), task({ id: 8, title: 'Water the plants' })], calendar: [] })
    render(wrap(<CalendarPage />, weekOf))
    const tray = await screen.findByRole('complementary', { name: 'Unscheduled tasks' })
    await within(tray).findByText('Water the plants')
    expect(within(tray).queryByText('Pay the invoice')).toBeNull()
  })

  it('opening a task’s session shows time, length and a link to the task, and Reschedule moves that same session', async () => {
    const f = stub({ tasks: [task({ schedule: session() })], calendar: [occurrence()] })
    render(wrap(<CalendarPage />, weekOf))
    fireEvent.click(await waitFor(() => { const el = document.querySelector('[data-session="55"]'); if (!el) throw new Error('not drawn'); return el }))
    const panel = await screen.findByRole('region', { name: 'Task session' })
    expect(within(panel).getByRole('link', { name: 'Pay the invoice' })).toHaveAttribute('href', '/tasks?task=7')
    expect(panel).toHaveTextContent('09:00 AM – 09:30 AM'); expect(panel).toHaveTextContent('30 min')
    fireEvent.click(within(panel).getByRole('button', { name: 'Reschedule' }))
    const group = await within(panel).findByRole('group', { name: 'Reschedule' })
    fireEvent.click(within(group).getAllByRole('button')[0])
    await waitFor(() => expect(calls(f, 'PUT')).toHaveLength(1))
    expect(calls(f, 'PUT')[0][0]).toMatch(/\/api\/tasks\/7\/schedule$/)
    expect(JSON.parse(calls(f, 'PUT')[0][1]!.body as string).session_id).toBe(55)
    expect(calls(f, 'POST')).toHaveLength(0)
  })

  it('placing an unscheduled task goes through the schedule endpoint and a 409 is a plain message, not a success', async () => {
    const f = stub({ tasks: [task({ id: 8, title: 'Water the plants' })], calendar: [], post: () => ({ status: 409, body: { message: 'x', code: 'task_already_scheduled', session: null } }) })
    render(wrap(<CalendarPage />, weekOf))
    const tray = await screen.findByRole('complementary', { name: 'Unscheduled tasks' })
    fireEvent.click(await within(tray).findByRole('button', { name: 'Place' }))
    fireEvent.click((await screen.findAllByRole('button', { name: 'Schedule at 15:00' }))[0])
    await waitFor(() => expect(calls(f, 'POST')).toHaveLength(1))
    expect(calls(f, 'POST')[0][0]).toMatch(/\/api\/tasks\/8\/schedule$/)
    expect(await screen.findByText('This task is already scheduled.')).toBeInTheDocument()
    expect(screen.queryByText(/Time blocked/)).toBeNull()
  })
})

// ---- focus, Escape, wording, accessibility --------------------------------------------------------------------------------------

/** Escape as a browser treats it: a keydown, and when nobody prevented it, the dialog's own "cancel" (which closes it). */
function pressEscape(el: Element) {
  const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  act(() => { el.dispatchEvent(ev) })
  if (!ev.defaultPrevented) act(() => { el.closest('dialog')?.dispatchEvent(new Event('cancel', { cancelable: true })) })
  return ev
}
async function axeClean(el: Element) {
  const result = await axe.run(el as HTMLElement, { rules: { 'color-contrast': { enabled: false } } })   // jsdom cannot measure contrast: the browser run covers it
  expect(result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html.slice(0, 120)).join(' | ')}`)).toEqual([])
}
const openSessionDialog = async () => {
  fireEvent.click(await waitFor(() => { const el = document.querySelector('[data-session="55"]'); if (!el) throw new Error('not drawn'); return el }))
  return screen.findByRole('region', { name: 'Task session' })
}

describe('Escape and focus', () => {
  it('Escape inside the event dialog closes only the choices: the dialog and its form stay, and focus returns to Reschedule', async () => {
    stub({ tasks: [task({ schedule: session() })], calendar: [occurrence()] })
    render(wrap(<CalendarPage />, '/calendar?date=2026-11-12'))
    const panel = await openSessionDialog()
    const trigger = within(panel).getByRole('button', { name: 'Reschedule' })
    fireEvent.click(trigger)
    const group = await within(panel).findByRole('group', { name: 'Reschedule' })
    await waitFor(() => expect(within(group).getAllByRole('button')[0]).toHaveFocus())
    const ev = pressEscape(document.activeElement!)
    expect(ev.defaultPrevented).toBe(true)   // so the browser never fires the dialog's cancel
    await waitFor(() => expect(within(panel).queryByRole('group', { name: 'Reschedule' })).toBeNull())
    expect(screen.getByRole('region', { name: 'Task session' })).toBeInTheDocument()
    expect(document.querySelector('dialog')).toHaveAttribute('open')
    expect(screen.getByLabelText('Title')).toBeInTheDocument()
    expect(trigger).toHaveFocus()
    // with the choices gone, Escape is the dialog's again
    pressEscape(trigger)
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Task session' })).toBeNull())
  })

  it('after moving a session from its dialog the dialog closes and focus lands on that session at its new time', async () => {
    const state: Stub = { tasks: [task({ schedule: session() })], calendar: [occurrence()], put: init => { const b = JSON.parse(init.body as string); state.calendar = [occurrence({ starts_at: b.starts_at, ends_at: b.ends_at })]; return { status: 200, body: { data: { id: 55 }, schedule: session({ starts_at: b.starts_at, ends_at: b.ends_at }) } } } }
    stub(state)
    render(wrap(<CalendarPage />, '/calendar?date=2026-11-12'))
    const panel = await openSessionDialog()
    fireEvent.click(within(panel).getByRole('button', { name: 'Reschedule' }))
    const group = await within(panel).findByRole('group', { name: 'Reschedule' })
    fireEvent.click(within(group).getAllByRole('button')[0])
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Task session' })).toBeNull())
    await waitFor(() => expect(document.querySelector('[data-session="55"]')).toHaveFocus())
    expect(document.querySelector('[data-session="55"]')).toHaveTextContent('2:00 PM')   // 14:00 in Amsterdam: the new time
  })

  it('when the moved session is no longer in the period shown, focus goes to the calendar heading, never to the page', async () => {
    const later: Availability = { work_start: '09:00', work_end: '17:00', days: [{ date: '2026-12-20', work_day: true, free_minutes: 480, slots: [{ starts_at: '2026-12-20T08:00:00Z', ends_at: '2026-12-20T16:00:00Z', minutes: 480 }] }] }
    stub({ tasks: [task({ schedule: session() })], calendar: [occurrence()], free: later })
    render(wrap(<CalendarPage />, '/calendar?date=2026-11-12'))
    const panel = await openSessionDialog()
    fireEvent.click(within(panel).getByRole('button', { name: 'Reschedule' }))
    const group = await within(panel).findByRole('group', { name: 'Reschedule' })
    fireEvent.click(within(group).getAllByRole('button')[0])
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Task session' })).toBeNull())
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus())
  })

  it('a booking leaves focus on the new Reschedule button, not on nothing', async () => {
    const state: Stub = { tasks: [task()], calendar: [], post: () => { state.tasks = [task({ schedule: session({ session_id: 99 }) })]; return { status: 201, body: { data: { id: 99 }, schedule: session({ session_id: 99 }) } } } }
    stub(state)
    const user = userEvent.setup({ advanceTimers: () => {} })
    render(wrap(<TasksPage />))
    await user.click(await screen.findByText('Pay the invoice'))
    await user.click((await chips())[0])
    const reschedule = await screen.findByRole('button', { name: 'Reschedule' })
    await waitFor(() => expect(reschedule).toHaveFocus())
    expect(document.body).not.toHaveFocus()
  })

  it('a 409 moves focus to the notice, and Escape returns it to the task row', async () => {
    const state: Stub = { tasks: [task()], calendar: [], post: () => { state.tasks = [task({ schedule: session() })]; return { status: 409, body: { code: 'task_already_scheduled', message: 'x', session: null } } } }
    stub(state)
    const user = userEvent.setup({ advanceTimers: () => {} })
    const { container } = render(wrap(<TasksPage />))
    await user.click(await screen.findByText('Pay the invoice'))
    await user.click((await chips())[0])
    const notice = await screen.findByRole('alert')
    await waitFor(() => expect(notice).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(container.querySelector('.task-body')).toHaveFocus()
  })

  it('Dismiss and Reschedule on the notice both hand focus to a real control', async () => {
    localStorage.setItem('lifeos-swipe-actions', JSON.stringify({ right: 'complete', left: 'schedule' }))
    stub({ tasks: [task({ schedule: session() })], calendar: [] })
    const user = userEvent.setup({ advanceTimers: () => {} })
    const { container } = render(wrap(<TasksPage />))
    await screen.findByText('Pay the invoice')
    const swipe = () => {
      const line = container.querySelector('.task-line')!
      fireEvent.pointerDown(line, { pointerType: 'touch', pointerId: 1, clientX: 300, clientY: 10 }); fireEvent.pointerMove(line, { pointerType: 'touch', pointerId: 1, clientX: 150, clientY: 10 }); fireEvent.pointerUp(line, { pointerType: 'touch', pointerId: 1 })
    }
    swipe()
    const notice = await screen.findByRole('alert')
    await waitFor(() => expect(notice).toHaveFocus())
    await user.click(within(notice).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(container.querySelector('.task-body')).toHaveFocus()

    swipe()
    const again = await screen.findByRole('alert')
    await user.click(within(again).getByRole('button', { name: 'Reschedule' }))
    expect(screen.queryByRole('alert')).toBeNull()
    const group = await screen.findByRole('group', { name: 'Reschedule' })
    await waitFor(() => expect(within(group).getAllByRole('button')[0]).toHaveFocus())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reschedule' })).toHaveFocus())
  })
})

describe('wording and direction', () => {
  it('lengths read as proper words in every language', () => {
    const w = (n: number, t: (e: string, a: string, nn?: string) => string) => durationWords(n, t)
    expect([1, 2, 5, 10, 11, 30, 60, 90, 120, 180, 135].map(n => w(n, ar))).toEqual(['دقيقة', 'دقيقتان', '5 دقائق', '10 دقائق', '11 دقيقة', '30 دقيقة', 'ساعة', 'ساعة و30 دقيقة', 'ساعتان', '3 ساعات', 'ساعتان و15 دقيقة'])
    expect([5, 60, 90, 135].map(n => w(n, en))).toEqual(['5 min', '1 h', '1 h 30 min', '2 h 15 min'])
    expect([5, 60, 90].map(n => w(n, nl))).toEqual(['5 min', '1 u', '1 u 30 min'])
  })
  it('spells tomorrow «غدًا» on the due chip, the move-to chips and the slot chips', async () => {
    localStorage.setItem('lifeos-language', 'ar')
    const { unmount } = render(wrap(<DueChip due="2026-11-12T10:00:00Z" />))
    expect(document.querySelector('.due')).toHaveTextContent('غدًا'); expect(document.querySelector('.due')).not.toHaveTextContent('غداً')
    unmount()
    stub({ tasks: [task()], calendar: [] })
    render(wrap(<TasksPage />))
    fireEvent.click(await screen.findByText('Pay the invoice'))
    expect(await screen.findByRole('button', { name: 'غدًا' })).toBeInTheDocument()
    const chipsText = within(await screen.findByRole('group', { name: 'جدولة' })).getAllByRole('button').map(b => b.textContent).join(' ')
    expect(chipsText).toContain('غدًا'); expect(chipsText).not.toContain('غداً')
  })
  it('keeps times and titles in their own direction inside Arabic text: <bdi> in the badge, isolates in the toast', async () => {
    localStorage.setItem('lifeos-language', 'ar')
    stub({ tasks: [task()], calendar: [] })
    const { container } = render(wrap(<TasksPage />))
    fireEvent.click(await screen.findByText('Pay the invoice'))
    fireEvent.click(within(await screen.findByRole('group', { name: 'جدولة' })).getAllByRole('button')[0])
    await waitFor(() => expect(container.querySelector('.sched-badge')).toBeInTheDocument())
    expect(container.querySelector('.sched-badge bdi time')).toBeInTheDocument()
    expect(container.querySelector('.sched-actions bdi')).toBeInTheDocument()
    expect(await screen.findByText(/جُدولت «\u2068Pay the invoice\u2069» \u2068/)).toBeInTheDocument()
  })
})

describe('accessibility checks (structure, names and roles; contrast is measured in the browser run)', () => {
  it.each(['ar', 'nl'])('the 409 notice, the busy state and an open row have no violations in %s', async lang => {
    localStorage.setItem('lifeos-language', lang)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const reply = 409
    stub({ tasks: [task()], calendar: [], post: async () => { await gate; return reply === 409 ? { status: 409, body: { code: 'task_already_scheduled', message: 'x', session: null } } : { status: 201, body: { data: { id: 9 } } } } })
    const { container } = render(wrap(<main><TasksPage /></main>))
    fireEvent.click(await waitFor(() => { const el = container.querySelector('.task-body'); if (!el) throw new Error('no row'); return el }))
    const group = await waitFor(() => { const g = container.querySelector('.task-quick[aria-busy]'); if (!g) throw new Error('no chips'); return g as HTMLElement })
    fireEvent.click(within(group).getAllByRole('button')[0])
    await waitFor(() => expect(group).toHaveAttribute('aria-busy', 'true'))
    await axeClean(container.querySelector('.task-item')!)          // busy
    release()
    const notice = await screen.findByRole('alert')
    await axeClean(notice)                                          // notice
    await axeClean(container.querySelector('.task-item')!)
  })
  it.each(['ar', 'nl'])('the task-session panel in its dialog has no violations in %s', async lang => {
    localStorage.setItem('lifeos-language', lang)
    stub({ tasks: [task({ schedule: session() })], calendar: [occurrence()] })
    render(wrap(<CalendarPage />, '/calendar?date=2026-11-12'))
    fireEvent.click(await waitFor(() => { const el = document.querySelector('[data-session="55"]'); if (!el) throw new Error('not drawn'); return el }))
    const panel = await screen.findByRole('region')
    await axeClean(document.querySelector('dialog')!)
    expect(panel).toBeInTheDocument()
  })
})
