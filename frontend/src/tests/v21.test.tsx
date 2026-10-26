import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import swSource from '../../public/sw.js?raw'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import QuickActions from '../components/layout/QuickActions'
import { doneNow, notify, openHabitSheet, type Habit } from '../lib/quickActions'
import { localDate } from '../lib/hooks'

function Where() { const l = useLocation(); return <output data-testid="where">{l.pathname}{l.search}</output> }
const wrap = (children: ReactNode, path = '/') => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[path]}><ToastProvider><AuthProvider><Routes><Route path="*" element={<>{children}<Where /></>} /></Routes></AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals() })
afterEach(() => vi.restoreAllMocks())

type Call = [string, RequestInit | undefined]
const habits: Habit[] = [
  { id: 3, title: 'Read', recurrence: 'daily', current_streak: 4, entries: [] } as Habit,
  { id: 4, title: 'Long run', recurrence: 'weekly', remind_time: '07:00', entries: [] } as Habit,
]
const stub = () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const body = /\/api\/user$/.test(url) ? { id: 1, name: 'A', email: 'a@x.io' } : /\/api\/habits\/3$/.test(url) ? { data: habits[0] } : /\/api\/habits\?/.test(url) ? { data: habits } : init?.method === 'POST' ? { data: { id: 9 } } : { message: 'Saved.' }
    return new Response(JSON.stringify(body), { status: init?.method === 'POST' ? 201 : 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const calls = (f: ReturnType<typeof stub>, method: string, path: RegExp) => (f.mock.calls as unknown as Call[]).filter(c => c[1]?.method === method && path.test(String(c[0])))

describe('one-tap actions from links', () => {
  it('logs a habit from a notification button, clears the link and can be undone', async () => {
    const fetcher = stub()
    render(wrap(<QuickActions />, '/?habit=3&done=1'))
    expect(await screen.findByText('Logged “Read”.')).toBeInTheDocument()
    expect(JSON.parse(calls(fetcher, 'PUT', /habits\/3\/entry$/)[0][1]!.body as string)).toEqual({ date: localDate(), completed: true })
    expect(screen.getByTestId('where').textContent).toBe('/')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(calls(fetcher, 'PUT', /habits\/3\/entry$/)).toHaveLength(2))
    expect(JSON.parse(calls(fetcher, 'PUT', /habits\/3\/entry$/)[1][1]!.body as string).completed).toBe(false)
  })

  it('opens the habit sheet from the shortcut and ticks a habit in one tap', async () => {
    const fetcher = stub()
    render(wrap(<QuickActions />, '/?log=habits'))
    const tick = await screen.findByRole('button', { name: 'Log “Read”' })
    expect(screen.getByRole('dialog', { name: 'Log a habit' })).toBeInTheDocument()
    expect(screen.getByText('Weekly · 07:00')).toBeInTheDocument()
    fireEvent.click(tick)
    await waitFor(() => expect(calls(fetcher, 'PUT', /habits\/3\/entry$/)).toHaveLength(1))
    expect(screen.getByTestId('where').textContent).toBe('/')
  })

  it('also opens from inside the app', async () => {
    stub()
    render(wrap(<QuickActions />))
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => openHabitSheet())
    expect(await screen.findByRole('dialog', { name: 'Log a habit' })).toBeInTheDocument()
  })

  it('starts a break or a focus session from a notification button', async () => {
    const fetcher = stub()
    render(wrap(<QuickActions />, '/?focus=break'))
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/focus'))
    expect(JSON.parse(calls(fetcher, 'POST', /focus-sessions$/)[0][1]!.body as string)).toMatchObject({ kind: 'short_break', duration_seconds: 300, task_id: null })
  })

  it('counts weekly habits once per Monday-based week', () => {
    const wed = '2027-01-06'
    expect(doneNow({ ...habits[1], entries: [{ date: '2027-01-04' }] } as Habit, wed)).toBe(true)
    expect(doneNow({ ...habits[1], entries: [{ date: '2027-01-03' }] } as Habit, wed)).toBe(false)
    expect(doneNow({ ...habits[0], entries: [{ date: '2027-01-05' }] } as Habit, wed)).toBe(false)
  })
})

describe('notifications with buttons, only where the browser has them', () => {
  const setup = (maxActions?: number) => {
    const showNotification = vi.fn(async () => {})
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'granted', ...(maxActions === undefined ? {} : { maxActions }) }))
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve({ showNotification }) } })
    return showNotification
  }
  const actions = [{ action: 'focus-break', title: 'Start break', link: '/?focus=break' }]

  it('adds buttons through the service worker when supported', async () => {
    const show = setup(2)
    expect(await notify('Focus session complete', { body: 'Nice work.', link: '/focus', actions })).toBe(true)
    expect(show).toHaveBeenCalledWith('Focus session complete', expect.objectContaining({ actions: [{ action: 'focus-break', title: 'Start break' }], data: { link: '/focus', actions } }))
  })

  it('leaves buttons out where the browser has none', async () => {
    const show = setup()
    await notify('Focus session complete', { link: '/focus', actions })
    expect(show).toHaveBeenCalledWith('Focus session complete', expect.objectContaining({ actions: [], data: { link: '/focus', actions: [] } }))
  })
})

describe('service worker', () => {
  /** Run public/sw.js in a sandbox with a fake `self`, capturing its event listeners. */
  function worker() {
    const listeners: Record<string, (e: unknown) => void> = {}
    const client = { url: 'https://app.test/', focus: vi.fn(async () => {}), navigate: vi.fn(async () => {}) }
    const self = {
      location: { href: 'https://app.test/sw.js?v=1', origin: 'https://app.test' },
      addEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = fn },
      registration: { showNotification: vi.fn(async () => {}) },
      clients: { matchAll: vi.fn(async () => [client]), openWindow: vi.fn(async () => {}), claim: vi.fn() },
    }
    new Function('self', 'caches', swSource)(self, {})
    const fire = async (type: string, event: Record<string, unknown>) => { let done: Promise<unknown> = Promise.resolve(); listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => { done = p } }); await done }
    return { self, client, fire }
  }

  it('shows pushed actions and keeps only same-origin links', async () => {
    const { self, fire } = worker()
    const data = { title: 'Habit: Read', link: '/?habit=7', actions: [{ action: 'habit-done', title: 'Done', link: '/?habit=7&done=1' }, { action: 'evil', title: 'Evil', link: 'https://evil.test/' }] }
    await fire('push', { data: { json: () => data } })
    expect(self.registration.showNotification).toHaveBeenCalledWith('Habit: Read', expect.objectContaining({
      actions: [{ action: 'habit-done', title: 'Done' }],
      data: { link: '/?habit=7', actions: [{ action: 'habit-done', title: 'Done', link: '/?habit=7&done=1' }] },
    }))
  })

  it('opens the button’s link, or the notification’s link on a plain tap', async () => {
    const { client, fire } = worker()
    const notification = { close: vi.fn(), data: { link: '/?habit=7', actions: [{ action: 'habit-done', title: 'Done', link: '/?habit=7&done=1' }] } }
    await fire('notificationclick', { action: 'habit-done', notification })
    expect(client.navigate).toHaveBeenLastCalledWith('https://app.test/?habit=7&done=1')
    await fire('notificationclick', { action: '', notification })
    expect(client.navigate).toHaveBeenLastCalledWith('https://app.test/?habit=7')
    await fire('notificationclick', { action: '', notification: { close: vi.fn(), data: { link: '//evil.test/' } } })
    expect(client.navigate).toHaveBeenLastCalledWith('https://app.test/')
  })
})
