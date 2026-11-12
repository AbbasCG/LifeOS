import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import { RecordForm } from '../features/RecordForm'
import TasksPage from '../features/TasksPage'
import QuickActions from '../components/layout/QuickActions'
import { setAccountZone } from '../lib/accountDay'
import { enqueue, pendingItems, sendPending, setOfflineOwner } from '../lib/offline'

// Browser in Auckland, account in Amsterdam.
const BROWSER_TZ = process.env.TZ
process.env.TZ = 'Pacific/Auckland'
afterAll(() => { if (BROWSER_TZ === undefined) delete process.env.TZ; else process.env.TZ = BROWSER_TZ })
const NOW = '2026-11-12T10:00:00Z'   // Thu 12 Nov 11:00 Amsterdam
const wrap = (children: ReactNode, path = '/') => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[path]}><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
type Call = { method: string; url: string; body?: Record<string, unknown> }
const allDay = (over: Record<string, unknown> = {}) => ({ id: 7, title: 'File the report', status: 'todo', priority: 'high', due_at: '2026-11-14T22:59:00Z', due_all_day: true, due_date: '2026-11-14', estimated_minutes: 30, schedule: null, ...over })

function server(row: Record<string, unknown> = allDay()) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET', u = String(url)
    calls.push({ method, url: u, body: init?.body ? JSON.parse(init.body as string) : undefined })
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (method !== 'GET') return json({ data: row })
    if (/\/api\/user$/.test(u)) return json({ id: 1, name: 'A', email: 'a@x.io', timezone: 'Europe/Amsterdam' })
    if (/\/api\/tasks\/7$/.test(u)) return json({ data: row })
    if (/\/api\/connected\/tasks/.test(u)) return json([])
    if (/\/api\/tasks/.test(u)) return json({ data: [row], meta: { last_page: 1 } })
    return json({ data: [], meta: { last_page: 1 } })
  }))
  return calls
}
const patches = (calls: Call[]) => calls.filter(c => c.method === 'PATCH').map(c => c.body!)
const open = (resource = 'tasks', item: Record<string, unknown> = allDay()) => { const onClose = vi.fn(); render(wrap(<RecordForm resource={resource} item={item} onSave={vi.fn()} onClose={onClose} />)); return onClose }
const save = async (calls: Call[]) => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); await waitFor(() => expect(patches(calls)).toHaveLength(1)); return patches(calls)[0] }
const toggle = () => screen.getByRole('checkbox', { name: 'No specific time' }) as HTMLInputElement
const field = () => (document.querySelector('.rf-deadline .dtp-trigger') as HTMLElement)

beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals(); setAccountZone('Europe/Amsterdam'); vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) }) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); setAccountZone(undefined) })

describe('the deadline toggle "No specific time"', () => {
  it('an existing date-only task opens with the toggle ON, the date shown and no time', () => {
    server(); open()
    expect(toggle().checked).toBe(true)
    expect(field().dataset.value).toBe('2026-11-14'); expect(field().textContent).not.toMatch(/\d{2}:\d{2}/)
  })
  it('saving it untouched sends no deadline at all (the flag survives)', async () => {
    const calls = server(); open()
    const body = await save(calls)
    expect(body).not.toHaveProperty('due_at'); expect(body).not.toHaveProperty('due_date')
  })
  it('a new day on a date-only task posts exactly { due_date }', async () => {
    const calls = server(); open()
    fireEvent.click(screen.getByRole('radio', { name: 'Tomorrow' }))
    const body = await save(calls)
    expect(body.due_date).toBe('2026-11-13'); expect(body).not.toHaveProperty('due_at')
  })
  it('switching it OFF gives a timed deadline at 17:00 and posts only { due_at }', async () => {
    const calls = server(); open()
    fireEvent.click(toggle())
    expect(toggle().checked).toBe(false); expect(field().dataset.value).toBe('2026-11-14T17:00')
    const body = await save(calls)
    expect(body.due_at).toBe('2026-11-14T16:00:00.000Z'); expect(body).not.toHaveProperty('due_date')
  })
  it('switching it ON for a timed task posts { due_date } and drops the time', async () => {
    const calls = server(); open('tasks', allDay({ due_at: '2026-11-14T08:30:00Z', due_all_day: false, due_date: null }))
    expect(toggle().checked).toBe(false); expect(field().dataset.value).toBe('2026-11-14T09:30')
    fireEvent.click(toggle())
    expect(field().dataset.value).toBe('2026-11-14')
    const body = await save(calls)
    expect(body.due_date).toBe('2026-11-14'); expect(body).not.toHaveProperty('due_at')
  })
  it('a new task defaults to timed; ON then Save posts due_date', async () => {
    const calls = server(); render(wrap(<RecordForm resource="tasks" item={{}} onSave={vi.fn()} onClose={vi.fn()} />))
    expect(toggle().checked).toBe(false)
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Tomorrow' })); fireEvent.click(toggle())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true))
    const body = calls.find(c => c.method === 'POST')!.body!
    expect(body.due_date).toBe('2026-11-13'); expect(body).not.toHaveProperty('due_at')
  })
  it('has a label in Arabic and Dutch', () => {
    localStorage.setItem('lifeos-language', 'ar'); server(); open()
    expect(screen.getByRole('checkbox', { name: 'بدون وقت محدد' })).toBeInTheDocument()
    cleanup(); localStorage.setItem('lifeos-language', 'nl'); open()
    expect(screen.getByRole('checkbox', { name: 'Geen vaste tijd' })).toBeInTheDocument()
  })
})

describe('saving untouched in the repeated autumn hour (2026-10-25 02:30, the second one is 01:30Z)', () => {
  const REPEATED = '2026-10-25T01:30:00Z'
  it('a task deadline is not sent', async () => {
    const calls = server(); open('tasks', allDay({ due_at: REPEATED, due_all_day: false, due_date: null }))
    const body = await save(calls); expect(body).not.toHaveProperty('due_at')
  })
  it('a task reminder keeps its saved instant', async () => {
    const calls = server(); open('tasks', allDay({ due_at: null, due_all_day: false, due_date: null, remind_at: REPEATED }))
    const body = await save(calls); expect(body.remind_at).toBe(REPEATED)
  })
  it('a project deadline keeps its saved instant', async () => {
    const calls = server(); open('projects', { id: 3, title: 'P', status: 'active', due_at: REPEATED })
    const body = await save(calls); expect(body.due_at).toBe(REPEATED)
  })
})

describe('moves and undo keep a date-only deadline date-only', () => {
  it('list "Move to Tomorrow" sends { due_date }, and Undo sends the old { due_date }', async () => {
    const calls = server(); render(wrap(<TasksPage />, '/tasks?task=7'))
    expect(await screen.findByText(/Sat, Nov 14/)).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Tomorrow' }))
    await waitFor(() => expect(patches(calls)).toEqual([{ due_date: '2026-11-13' }]))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(patches(calls).at(-1)).toEqual({ due_date: '2026-11-14' }))
  })
  it('QuickActions snooze to tomorrow sends { due_date }, and its Undo restores { due_date }', async () => {
    const calls = server(); render(wrap(<QuickActions />, '/?task=7&snooze=tomorrow'))
    expect(await screen.findByText('“File the report” moved to tomorrow.')).toBeInTheDocument()
    expect(patches(calls)).toEqual([{ due_date: '2026-11-13' }])
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(patches(calls).at(-1)).toEqual({ due_date: '2026-11-14' }))
  })
})

describe('the offline queue', () => {
  it('a queued task create is posted with exactly the due field it was queued with', async () => {
    setOfflineOwner(1)
    const calls = server()
    enqueue({ kind: 'task.create', label: 'Offline', payload: { title: 'Offline', due_date: '2026-11-14', client_id: 'c1' } })
    const item = pendingItems()[0]
    await sendPending(item)
    const post = calls.find(c => c.method === 'POST')!.body!
    expect(post.due_date).toBe('2026-11-14'); expect(post).not.toHaveProperty('due_at')
    setOfflineOwner(null)
  })
})
