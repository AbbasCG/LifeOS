import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import QuickActions from '../components/layout/QuickActions'
import TasksPage from '../features/TasksPage'
import { dueFor } from '../lib/quickAdd'
import { setAccountZone } from '../lib/accountDay'

function Where() { const l = useLocation(); return <output data-testid="where">{l.pathname}{l.search}</output> }
const wrap = (children: ReactNode, path = '/') => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[path]}><ToastProvider><AuthProvider><Routes><Route path="*" element={<>{children}<Where /></>} /></Routes></AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
type Call = [string, RequestInit | undefined]
const task = { id: 7, title: 'Call the bank', status: 'todo', priority: 'high', due_at: '2027-03-09T10:00:00Z', remind_at: '2027-03-09T08:00:00Z', estimated_minutes: 30 }

function stub(status = 'todo') {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return new Response(JSON.stringify({ data: task }), { status: 200 })
    const body = /\/api\/user$/.test(url) ? { id: 1, name: 'A', email: 'a@x.io', timezone: 'Europe/Amsterdam' }
      : /\/api\/tasks\/7$/.test(url) ? { data: { ...task, status } }
      : /\/api\/availability/.test(url) ? { work_start: '09:00', work_end: '17:00', days: [] }
      : /\/api\/connected\/tasks/.test(url) ? []
      : /\/api\/tasks/.test(url) ? { data: [task], meta: { last_page: 1 } } : { data: [] }
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const patches = (f: ReturnType<typeof stub>) => (f.mock.calls as unknown as Call[]).filter(c => c[1]?.method === 'PATCH').map(c => JSON.parse(c[1]!.body as string))

beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals(); setAccountZone('Europe/Amsterdam'); vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-03-09T08:00:00Z') }) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); setAccountZone(undefined) })

describe('buttons on a task reminder', () => {
  it('Done completes that task, clears the link and can be undone', async () => {
    const fetcher = stub()
    render(wrap(<QuickActions />, '/?task=7&done=1'))
    expect(await screen.findByText('Done: “Call the bank”.')).toBeInTheDocument()
    expect(patches(fetcher)).toEqual([{ status: 'completed' }])
    expect(screen.getByTestId('where').textContent).toBe('/')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(patches(fetcher)).toEqual([{ status: 'completed' }, { status: 'todo' }]))
  })

  it('says so, and changes nothing, when the task was already done', async () => {
    const fetcher = stub('completed')
    render(wrap(<QuickActions />, '/?task=7&done=1'))
    expect(await screen.findByText('“Call the bank” is already done.')).toBeInTheDocument()
    expect(patches(fetcher)).toEqual([])
  })

  it('"In 1 hour" sets the reminder an hour ahead, and Undo puts the old reminder back', async () => {
    const fetcher = stub()
    render(wrap(<QuickActions />, '/?task=7&snooze=hour'))
    expect(await screen.findByText('“Call the bank” will remind you again in an hour.')).toBeInTheDocument()
    expect(patches(fetcher)).toEqual([{ remind_at: '2027-03-09T09:00:00.000Z' }])
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(patches(fetcher).at(-1)).toEqual({ remind_at: '2027-03-09T08:00:00Z' }))
  })

  it('"Tomorrow" moves the due date to tomorrow at 17:00, and Undo restores it', async () => {
    const fetcher = stub()
    render(wrap(<QuickActions />, '/?task=7&snooze=tomorrow'))
    expect(await screen.findByText('“Call the bank” moved to tomorrow.')).toBeInTheDocument()
    expect(patches(fetcher)).toEqual([{ due_at: dueFor('tomorrow') }])
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(patches(fetcher).at(-1)).toEqual({ due_at: '2027-03-09T10:00:00Z' }))
  })

  it('ignores an unknown snooze and a task link with no action', async () => {
    const fetcher = stub()
    render(wrap(<QuickActions />, '/tasks?task=7&snooze=forever'))
    await new Promise(r => setTimeout(r, 50))
    expect(patches(fetcher)).toEqual([])
    expect(screen.getByTestId('where').textContent).toBe('/tasks?task=7&snooze=forever')
  })
})

describe('opening the task a notification points to', () => {
  it('opens that row on the Tasks page', async () => {
    stub()
    render(wrap(<TasksPage />, '/tasks?task=7'))
    expect(await screen.findByRole('group', { name: 'Move to' })).toBeInTheDocument()
    expect(document.querySelector('[data-task="7"]')?.classList.contains('expanded')).toBe(true)
  })
})
