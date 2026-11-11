import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import FocusPage from '../features/FocusPage'
import { TASKS_CHANGED } from '../lib/quickAdd'
import scrollbars from '../styles/scrollbars.css?raw'
import visual from '../styles/visual.css?raw'
import workspace from '../styles/workspace.css?raw'

const wrap = (children: ReactNode, path = '/focus') => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[path]}><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
type Rec = Record<string, unknown>
const iso = (ms: number) => new Date(ms).toISOString()
const running = (over: Rec = {}): Rec => ({
  id: 7, status: 'running', kind: 'focus', mode: 'custom', cycle: null, duration_seconds: 3600, elapsed_seconds: 0, resumed_at: iso(Date.now()), completed_at: null,
  started_at: iso(Date.now()), created_at: iso(Date.now()), notes: null, interruptions: null, task_id: 3, project_id: null,
  task: { id: 3, title: 'Write the report', status: 'todo' }, elapsed_now_seconds: 0, overdue_seconds: 0, ...over,
})

function server(initial: Rec | null, opts: { taskStatus?: string } = {}) {
  let state: Rec | null = initial
  const calls: { method: string; url: string; body?: Rec }[] = []
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET', body = init?.body ? JSON.parse(init.body as string) : undefined
    calls.push({ method, url, body })
    if (/\/api\/user$/.test(url)) return json({ id: 1 })
    if (/insights/.test(url)) return json({ sessions: 0, by_day: [], distractions: [], tips: [] })
    if (/\/api\/tasks\/\d+$/.test(url)) return json({ data: { id: 3, title: 'Write the report', status: opts.taskStatus ?? 'todo', estimated_minutes: 60 } })
    if (/\/api\/tasks/.test(url)) return json({ data: [{ id: 3, title: 'Write the report', status: 'todo' }], meta: { last_page: 1 } })
    if (/complete-task$/.test(url)) { await new Promise(r => setTimeout(r, 40)); return json({ data: { id: 3, status: 'completed' } }) }
    if (/\/api\/focus-sessions\/\d+$/.test(url) && method === 'PATCH') {
      state = { ...state!, status: body.action === 'cancel' ? 'cancelled' : 'completed', elapsed_seconds: 720, resumed_at: null, ...(opts.taskStatus ? { task: { id: 3, title: 'Write the report', status: opts.taskStatus } } : {}) }
      return json({ server_time: iso(Date.now()), ...state })
    }
    // Like the real server: the worked time moves with the clock while the session runs.
    const live = (r: Rec): Rec => r.status === 'running' && typeof r.__start === 'number' ? { ...r, elapsed_now_seconds: Math.min(Number(r.duration_seconds), Math.floor((Date.now() - Number(r.__start)) / 1000)), overdue_seconds: Math.max(0, Math.floor((Date.now() - Number(r.__start)) / 1000) - Number(r.duration_seconds)) } : r
    if (/\/api\/focus-sessions$/.test(url)) return json({ data: state ? [{ server_time: iso(Date.now()), ...live(state) }] : [] })
    return json({ data: [] })
  })
  vi.stubGlobal('fetch', fetcher)
  return { calls, completions: () => calls.filter(c => /complete-task$/.test(c.url)), patches: () => calls.filter(c => c.method === 'PATCH') }
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('lifeos-language', 'en') })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('V49 finishing a focus session on a task', () => {
  it('saves the time and asks; the task stays open until the person confirms', async () => {
    const s = server(running())
    render(wrap(<FocusPage />))
    fireEvent.click(await screen.findByRole('button', { name: /Finish & save/ }))
    expect(await screen.findByText('Saved 12 min on “Write the report”.')).toBeInTheDocument()
    expect(screen.getByText('Is the task done?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Complete task' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep it open' })).toBeInTheDocument()
    expect(s.patches().map(c => c.body?.action)).toEqual(['finish'])
    expect(s.completions()).toHaveLength(0)
  })

  it('"Complete task" asks the server once (even on a double tap), refreshes Tasks and Today at once, and clears the question', async () => {
    const s = server(running())
    const changed = vi.fn(); window.addEventListener(TASKS_CHANGED, changed)
    render(wrap(<FocusPage />))
    fireEvent.click(await screen.findByRole('button', { name: /Finish & save/ }))
    const complete = await screen.findByRole('button', { name: 'Complete task' })
    fireEvent.click(complete); fireEvent.click(complete)
    await waitFor(() => expect(screen.queryByText('Is the task done?')).toBeNull())
    expect(s.completions()).toHaveLength(1)
    expect(s.completions()[0].method).toBe('POST')
    expect(s.completions()[0].url).toMatch(/\/api\/focus-sessions\/7\/complete-task$/)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Task completed: “Write the report”.')).toBeInTheDocument()
    window.removeEventListener(TASKS_CHANGED, changed)
  })

  it('"Keep it open" changes nothing', async () => {
    const s = server(running())
    const changed = vi.fn(); window.addEventListener(TASKS_CHANGED, changed)
    render(wrap(<FocusPage />))
    fireEvent.click(await screen.findByRole('button', { name: /Finish & save/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Keep it open' }))
    await waitFor(() => expect(screen.queryByText('Is the task done?')).toBeNull())
    expect(s.completions()).toHaveLength(0)
    expect(changed).not.toHaveBeenCalled()
    window.removeEventListener(TASKS_CHANGED, changed)
  })

  it('discarding the session asks nothing and completes nothing', async () => {
    const s = server(running())
    render(wrap(<FocusPage />))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard session' }))
    await screen.findByRole('button', { name: /Start/ })
    expect(screen.queryByText('Is the task done?')).toBeNull()
    expect(s.completions()).toHaveLength(0)
  })

  it('the timer running out asks the same question and completes nothing by itself', { timeout: 15_000 }, async () => {
    const s = server(running({ duration_seconds: 60, resumed_at: iso(Date.now() - 59_000), elapsed_now_seconds: 59, __start: Date.now() - 59_000 }))
    render(wrap(<FocusPage />))
    expect(await screen.findByText('Is the task done?', {}, { timeout: 6000 })).toBeInTheDocument()
    expect(s.patches().map(c => c.body)).toEqual([expect.objectContaining({ action: 'finish', auto: true })])
    expect(s.completions()).toHaveLength(0)
  })

  it('does not ask for a session without a task, or when the task is already completed', async () => {
    cleanup(); server(running({ task_id: null, task: null }))
    render(wrap(<FocusPage />))
    fireEvent.click(await screen.findByRole('button', { name: /Finish & save/ }))
    await screen.findByRole('button', { name: /Start/ })
    expect(screen.queryByText('Is the task done?')).toBeNull()

    cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); server(running(), { taskStatus: 'completed' })
    render(wrap(<FocusPage />))
    fireEvent.click(await screen.findByRole('button', { name: /Finish & save/ }))
    await screen.findByRole('button', { name: /Start/ })
    expect(screen.queryByText('Is the task done?')).toBeNull()
  })

  it('the question survives a page refresh until it is answered', async () => {
    server(running())
    const first = render(wrap(<FocusPage />))
    fireEvent.click(await screen.findByRole('button', { name: /Finish & save/ }))
    await screen.findByText('Is the task done?')
    first.unmount()
    render(wrap(<FocusPage />))
    expect(await screen.findByText('Is the task done?')).toBeInTheDocument()
  })

  it('is in Arabic too, with the primary action first', async () => {
    localStorage.setItem('lifeos-language', 'ar')
    server(running())
    render(wrap(<FocusPage />))
    fireEvent.click(await screen.findByRole('button', { name: /إنهاء وحفظ/ }))
    expect(await screen.findByText('هل انتهت المهمة؟')).toBeInTheDocument()
    const buttons = screen.getByRole('alert').querySelectorAll('button')
    expect(buttons[0].textContent).toContain('إكمال المهمة')
    expect(buttons[1].textContent).toContain('إبقاؤها مفتوحة')
  })
})

describe('V49 the sidebar scrollbar', () => {
  const rule = (css: string, selector: string) => [...css.matchAll(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))].map(m => m[1]).join(' ')

  it('is hidden by the global rule (scrollbars.css), while the sidebar still scrolls', () => {
    expect(scrollbars).toMatch(/\*\s*\{[^}]*scrollbar-width:\s*none/)
    const base = rule(visual, '.sidebar')
    expect(base).not.toMatch(/scrollbar-width:\s*(auto|thin)/)
    const all = `${rule(workspace, '.sidebar')} ${base}`
    expect(all).toMatch(/overflow-y:\s*auto/)
    expect(all).not.toMatch(/overflow(-y)?:\s*hidden/)
  })
})
