import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import FocusPage from '../features/FocusPage'
import TasksPage from '../features/TasksPage'
import { clock, overdueSeconds, phaseOf } from '../lib/focus'

function Where() { const l = useLocation(); return <output data-testid="where">{l.pathname}{l.search}</output> }
const wrap = (children: ReactNode, path = '/focus') => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[path]}><ToastProvider><AuthProvider><Routes><Route path="*" element={<>{children}<Where /></>} /></Routes></AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
type Rec = Record<string, unknown>
const iso = (ms: number) => new Date(ms).toISOString()
const session = (over: Rec = {}): Rec => ({
  id: 7, status: 'running', kind: 'focus', mode: 'pomodoro', cycle: 1, duration_seconds: 1500, elapsed_seconds: 0, resumed_at: iso(Date.now()), completed_at: null,
  started_at: iso(Date.now()), created_at: iso(Date.now()), notes: null, interruptions: null, task_id: null, project_id: null, ...over,
})

type Handlers = { sessions?: () => Rec[]; task?: () => Response; patch?: (body: Rec) => Response; post?: (body: Rec) => Response }
function server(h: Handlers = {}) {
  const posts: Rec[] = [], patches: Rec[] = []
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET', json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
    if (/\/api\/user$/.test(url)) return json({ id: 1 })
    if (/insights/.test(url)) return json({ sessions: 0, by_day: [], distractions: [], tips: [] })
    if (/\/api\/tasks\/\d+$/.test(url)) return h.task ? h.task() : json({ message: 'Not found' }, 404)
    if (/\/api\/tasks/.test(url)) return json({ data: [], meta: { last_page: 1 } })
    if (/\/api\/focus-sessions\/\d+$/.test(url) && method === 'PATCH') { const body = JSON.parse(init!.body as string); patches.push(body); return h.patch ? h.patch(body) : json({ message: 'no' }, 500) }
    if (/\/api\/focus-sessions$/.test(url) && method === 'POST') { const body = JSON.parse(init!.body as string); posts.push(body); return h.post ? h.post(body) : json({}, 500) }
    if (/\/api\/focus-sessions$/.test(url)) return json({ data: (h.sessions?.() ?? []).map(r => ({ server_time: iso(Date.now()), ...r })) })
    return json({ data: [] })
  })
  vi.stubGlobal('fetch', fetcher)
  return { posts, patches, fetcher }
}
const dial = () => document.querySelector('.dial-time')!.textContent
const finishes = (patches: Rec[]) => patches.filter(p => p.action === 'finish')

beforeEach(() => { localStorage.clear(); localStorage.setItem('lifeos-language', 'en') })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('V47 clock and phases', () => {
  it('shows 25:00, 60:00 for an hour, and 1:30:00 beyond an hour', () => {
    expect(clock(1500)).toBe('25:00')
    expect(clock(3600)).toBe('60:00')
    expect(clock(3599)).toBe('59:59')
    expect(clock(3601)).toBe('1:00:01')
    expect(clock(5400)).toBe('1:30:00')
    expect(clock(-3)).toBe('00:00')
  })
  it('names the phase of a session', () => {
    expect(phaseOf(null)).toBe('idle')
    for (const status of ['running', 'paused', 'completed', 'cancelled'] as const) expect(phaseOf({ status })).toBe(status)
  })
  it('measures how long ago a running session ended by the server clock', () => {
    const base = { status: 'running' as const, elapsed_seconds: 0, duration_seconds: 1500, resumed_at: '2027-03-10T09:00:00Z' }
    const t0 = new Date('2027-03-10T09:00:00Z').getTime()
    expect(overdueSeconds(base, t0 + 600_000)).toBe(0)
    expect(overdueSeconds(base, t0 + 1_500_000 + 90_000)).toBe(90)
    expect(overdueSeconds({ ...base, status: 'paused' as never }, t0 + 99_999_000)).toBe(0)
  })
})

describe('V47 a session that ended while nobody was looking', () => {
  it('REGRESSION: is not finished or credited by itself; the person chooses', async () => {
    // An old running session (left from an earlier try or a closed tab) used to be finished the moment the page opened, crediting its full planned time.
    let state: Rec = session({ resumed_at: iso(Date.now() - 3 * 3600_000) })
    const { patches } = server({ sessions: () => [state], patch: body => { state = { ...state, status: body.action === 'cancel' ? 'cancelled' : 'completed', elapsed_seconds: 1500 }; return new Response(JSON.stringify({ server_time: iso(Date.now()), ...state })) } })
    render(wrap(<FocusPage />))
    expect(await screen.findByText('This session ended while you were away.')).toBeInTheDocument()
    await new Promise(r => setTimeout(r, 1200))
    expect(patches).toHaveLength(0)
    expect(screen.queryByText(/Session complete/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(patches.map(p => p.action)).toEqual(['cancel']))
  })

  it('saves the planned time only when the person says so (and never marks it as automatic)', async () => {
    let state: Rec = session({ resumed_at: iso(Date.now() - 3 * 3600_000) })
    const { patches } = server({ sessions: () => [state], patch: () => { state = { ...state, status: 'completed', elapsed_seconds: 1500 }; return new Response(JSON.stringify({ server_time: iso(Date.now()), ...state })) } })
    render(wrap(<FocusPage />))
    fireEvent.click(await screen.findByRole('button', { name: 'Save 25 min' }))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({ action: 'finish' })
  })
})

describe('V47 a session that really runs out while the page is open', () => {
  it('finishes once, asks the server to confirm (auto), and says how much was saved', async () => {
    let state: Rec = session({ duration_seconds: 60, resumed_at: iso(Date.now() - 59_000) })
    const { patches } = server({ sessions: () => [state], patch: () => { state = { ...state, status: 'completed', elapsed_seconds: 60 }; return new Response(JSON.stringify({ server_time: iso(Date.now()), ...state })) } })
    render(wrap(<FocusPage />))
    await waitFor(() => expect(finishes(patches)).toHaveLength(1), { timeout: 5000 })
    await new Promise(r => setTimeout(r, 1200))
    expect(finishes(patches)).toHaveLength(1)
    expect(finishes(patches)[0]).toMatchObject({ action: 'finish', auto: true })
    expect(await screen.findByText(/Session complete — 1 min saved/)).toBeInTheDocument()
  })

  it('does not say "complete" when the server refuses an early finish, and does not hammer it', async () => {
    const state: Rec = session({ duration_seconds: 60, resumed_at: iso(Date.now() - 61_000) })
    const { patches } = server({ sessions: () => [state], patch: () => new Response(JSON.stringify({ message: 'The session is not finished yet.', errors: { action: ['The session is not finished yet.'] } }), { status: 422 }) })
    render(wrap(<FocusPage />))
    await waitFor(() => expect(finishes(patches).length).toBeGreaterThanOrEqual(1), { timeout: 5000 })
    await new Promise(r => setTimeout(r, 1500))
    expect(screen.queryByText(/Session complete/)).toBeNull()
    expect(finishes(patches)).toHaveLength(1)
  })
})

describe('V47 start, refresh and double taps', () => {
  it('two taps on Start in the same instant create one session', async () => {
    let created: Rec | null = null
    const { posts } = server({ sessions: () => created ? [created] : [], post: () => { created = session(); return new Response(JSON.stringify({ server_time: iso(Date.now()), ...created }), { status: 201 }) } })
    render(wrap(<FocusPage />))
    const start = await screen.findByRole('button', { name: /Start 25 min/ })
    fireEvent.click(start); fireEvent.click(start)
    await screen.findByRole('button', { name: /Pause/ })
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ kind: 'focus', duration_seconds: 1500, mode: 'pomodoro' })
    expect(posts[0].client_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('refreshing the page in the middle of a session shows the time that is really left', async () => {
    const state = session({ resumed_at: iso(Date.now() - 10 * 60_000) })
    server({ sessions: () => [state] })
    const first = render(wrap(<FocusPage />))
    await screen.findByRole('button', { name: /Pause/ })
    expect(dial()).toMatch(/^1[45]:\d\d$/)
    first.unmount()
    render(wrap(<FocusPage />))
    await screen.findByRole('button', { name: /Pause/ })
    expect(dial()).toMatch(/^1[45]:\d\d$/)
    expect(screen.queryByText(/ended while you were away/)).toBeNull()
  })

  it('shows what is planned and what is done above the timer', async () => {
    server({ sessions: () => [session({ elapsed_seconds: 600, resumed_at: iso(Date.now()), task: { id: 3, title: 'Write the report' }, task_id: 3 })] })
    render(wrap(<FocusPage />))
    expect((await screen.findAllByText('Write the report')).length).toBeGreaterThan(0)
    expect(screen.getByText(/Planned 25 min · done 10 min/)).toBeInTheDocument()
  })
})

describe('V47 a task chosen with the play button', () => {
  const taskReply = (extra: Rec) => () => new Response(JSON.stringify({ data: { id: 7, title: 'Write the report', status: 'todo', ...extra } }))

  it('shows the task and 60:00 for a 60-minute task, and starts nothing', async () => {
    const { posts } = server({ task: taskReply({ estimated_minutes: 60 }) })
    render(wrap(<FocusPage />, '/focus?task=7'))
    expect(await screen.findByText('Write the report')).toBeInTheDocument()
    await waitFor(() => expect(dial()).toBe('60:00'))
    expect(screen.getByText('Planned 60 min')).toBeInTheDocument()
    await new Promise(r => setTimeout(r, 700))
    expect(dial()).toBe('60:00')
    expect(posts).toHaveLength(0)
  })

  it('shows 1:30:00 for a 90-minute task and starts the session with that task and length only after Start', async () => {
    let created: Rec | null = null
    const { posts } = server({ task: taskReply({ estimated_minutes: 90 }), sessions: () => created ? [created] : [], post: body => { created = session({ ...body, task_id: 7, task: { id: 7, title: 'Write the report' } }); return new Response(JSON.stringify({ server_time: iso(Date.now()), ...created }), { status: 201 }) } })
    render(wrap(<FocusPage />, '/focus?task=7'))
    await waitFor(() => expect(dial()).toBe('1:30:00'))
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }))
    await screen.findByRole('button', { name: /Pause/ })
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ kind: 'focus', task_id: 7, duration_seconds: 5400, mode: 'custom' })
  })

  it('uses 25 minutes when the task has no length', async () => {
    for (const estimated_minutes of [null, 0]) {
      cleanup()
      const { posts } = server({ task: taskReply({ estimated_minutes }) })
      render(wrap(<FocusPage />, '/focus?task=7'))
      expect(await screen.findByText('Write the report')).toBeInTheDocument()
      await waitFor(() => expect(dial()).toBe('25:00'))
      expect(posts).toHaveLength(0)
    }
  })

  it('lets the length be changed before starting', async () => {
    let created: Rec | null = null
    const { posts } = server({ task: taskReply({ estimated_minutes: 60 }), sessions: () => created ? [created] : [], post: body => { created = session({ ...body }); return new Response(JSON.stringify({ server_time: iso(Date.now()), ...created }), { status: 201 }) } })
    render(wrap(<FocusPage />, '/focus?task=7'))
    await waitFor(() => expect(dial()).toBe('60:00'))
    const group = screen.getByRole('group', { name: 'Session length' })
    fireEvent.click(within(group).getByRole('button', { name: '5 minutes less' }))
    expect(dial()).toBe('55:00')
    fireEvent.change(within(group).getByRole('spinbutton'), { target: { value: '45' } })
    expect(dial()).toBe('45:00')
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }))
    await screen.findByRole('button', { name: /Pause/ })
    expect(posts[0]).toMatchObject({ duration_seconds: 2700, task_id: 7 })
  })

  it('says so when the task is not found (or is not yours), and starts without it', async () => {
    const { posts } = server()
    render(wrap(<FocusPage />, '/focus?task=999'))
    expect(await screen.findByText('That task was not found. Pick another or start without one.')).toBeInTheDocument()
    expect(dial()).toBe('25:00')
    expect(posts).toHaveLength(0)
  })

  it('ignores a task id that is not a number', async () => {
    const { fetcher } = server()
    render(wrap(<FocusPage />, '/focus?task=abc'))
    await screen.findByRole('button', { name: /Start 25 min/ })
    expect(fetcher.mock.calls.some(c => /\/api\/tasks\/abc/.test(String(c[0])))).toBe(false)
  })
})

describe('V47 the play button on the Tasks page', () => {
  it('opens Focus for that task and does not start a session', async () => {
    const task = { id: 7, title: 'Call the bank', status: 'todo', priority: 'high', due_at: null, estimated_minutes: 60 }
    const { posts } = server()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push({}); return new Response('{}', { status: 201 }) }
      const body = /\/api\/user$/.test(url) ? { id: 1, name: 'A', email: 'a@x.io', timezone: 'UTC' } : /connected\/tasks/.test(url) ? [] : /\/api\/tasks/.test(url) ? { data: [task], meta: { last_page: 1 } } : /availability/.test(url) ? { work_start: '09:00', work_end: '17:00', days: [] } : /connected\/tasks/.test(url) ? [] : { data: [] }
      return new Response(JSON.stringify(body), { status: 200 })
    }))
    render(wrap(<TasksPage />, '/tasks'))
    fireEvent.click(await screen.findByRole('button', { name: /Focus on “Call the bank”/ }))
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/focus?task=7'))
    expect(posts).toHaveLength(0)
  })
})

describe('V48 a database whose time zone is not UTC', () => {
  // REGRESSION (the reported bug): the server stored resumed_at an hour early (PostgreSQL set to Europe/Amsterdam), so a 60-minute session
  // looked 60 minutes old the moment it started: the timer jumped from 60:00 to 00:00 and "60 min saved" appeared.
  it('shows 60:00 after Start, counts down, and finishes nothing, even if resumed_at is an hour early', async () => {
    let created: Rec | null = null
    const early = () => iso(Date.now() - 3600_000)
    const { posts, patches } = server({
      task: () => new Response(JSON.stringify({ data: { id: 7, title: 'Write the report', status: 'todo', estimated_minutes: 60 } })),
      sessions: () => created ? [created] : [],
      post: body => { created = session({ ...body, task_id: 7, resumed_at: early(), started_at: early(), elapsed_now_seconds: 0, overdue_seconds: 0 }); return new Response(JSON.stringify({ server_time: iso(Date.now()), ...created }), { status: 201 }) },
    })
    render(wrap(<FocusPage />, '/focus?task=7'))
    await waitFor(() => expect(dial()).toBe('60:00'))
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }))
    await screen.findByRole('button', { name: /Pause/ })
    expect(posts).toHaveLength(1)
    expect(dial()).toMatch(/^(60:00|59:5\d)$/)
    await new Promise(r => setTimeout(r, 1500))
    expect(dial()).toMatch(/^59:5\d$/)
    expect(screen.queryByText(/Session complete/)).toBeNull()
    expect(screen.queryByText(/ended while you were away/)).toBeNull()
    expect(patches).toHaveLength(0)
  })
})
