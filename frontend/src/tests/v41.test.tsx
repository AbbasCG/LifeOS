import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import TasksPage from '../features/TasksPage'
import { setAccountZone } from '../lib/accountDay'
import { slotWords, suggestSlots } from '../lib/scheduleSlots'
import type { Availability } from '../lib/api'

type Call = [string, RequestInit | undefined]
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
const task = { id: 7, title: 'Pay the invoice', status: 'todo', priority: 'high', due_at: '2027-03-09T10:00:00Z', estimated_minutes: 45 }
// "Now" is Tue 2027-03-09 09:07 in Amsterdam (08:07 UTC). Today has a free stretch from 10:00 to 10:30 (too short) and from 14:00 to 16:00.
const NOW = '2027-03-09T08:07:00Z'
const free: Availability = {
  work_start: '09:00', work_end: '17:00',
  days: [
    { date: '2027-03-09', work_day: true, free_minutes: 150, slots: [{ starts_at: '2027-03-09T09:00:00Z', ends_at: '2027-03-09T09:30:00Z', minutes: 30 }, { starts_at: '2027-03-09T13:00:00Z', ends_at: '2027-03-09T15:00:00Z', minutes: 120 }] },
    { date: '2027-03-10', work_day: true, free_minutes: 480, slots: [{ starts_at: '2027-03-10T08:00:00Z', ends_at: '2027-03-10T16:00:00Z', minutes: 480 }] },
    { date: '2027-03-11', work_day: false, free_minutes: 0, slots: [] },
    { date: '2027-03-12', work_day: true, free_minutes: 60, slots: [{ starts_at: '2027-03-12T08:00:00Z', ends_at: '2027-03-12T09:00:00Z', minutes: 60 }] },
  ],
}

describe('which free times are suggested for a task', () => {
  const now = new Date(NOW)
  it('takes the first stretch long enough on each working day, never in the past, one per day', () => {
    const slots = suggestSlots(free, 45, now)
    expect(slots.map(s => [s.day, s.starts_at, s.ends_at])).toEqual([
      ['2027-03-09', '2027-03-09T13:00:00.000Z', '2027-03-09T13:45:00.000Z'],      // 09:00–09:30 is too short for 45 minutes
      ['2027-03-10', '2027-03-10T08:00:00.000Z', '2027-03-10T08:45:00.000Z'],
      ['2027-03-12', '2027-03-12T08:00:00.000Z', '2027-03-12T08:45:00.000Z'],      // the 11th is not a working day
    ])
  })
  it('starts no earlier than the next quarter hour, and gives nothing when nothing fits', () => {
    const early = suggestSlots({ ...free, days: [{ date: '2027-03-09', work_day: true, free_minutes: 120, slots: [{ starts_at: '2027-03-09T07:00:00Z', ends_at: '2027-03-09T12:00:00Z', minutes: 300 }] }] }, 30, now)
    expect(early[0].starts_at).toBe('2027-03-09T08:15:00.000Z')
    expect(suggestSlots(free, 600, now)).toEqual([])
    expect(suggestSlots(null, 30, now)).toEqual([])
  })
  it('says the day and the time in the account’s timezone', () => {
    setAccountZone('Europe/Amsterdam')
    const t = (en: string) => en
    expect(slotWords({ day: '2027-03-09', starts_at: '2027-03-09T13:00:00Z', ends_at: '' }, 'en', t, now)).toBe('Today 14:00')
    expect(slotWords({ day: '2027-03-10', starts_at: '2027-03-10T08:00:00Z', ends_at: '' }, 'en', t, now)).toBe('Tomorrow 09:00')
    setAccountZone(undefined)
  })
})

function stub() {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && /\/api\/tasks\/7\/schedule$/.test(url)) return new Response(JSON.stringify({ data: { id: 99 } }), { status: 201 })
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    const body = /\/api\/user$/.test(url) ? { id: 1, name: 'A', email: 'a@x.io', timezone: 'Europe/Amsterdam' }
      : /\/api\/availability/.test(url) ? free
      : /\/api\/connected\/tasks/.test(url) ? []
      : /\/api\/tasks/.test(url) ? { data: [task], meta: { last_page: 1 } } : { data: [] }
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const calls = (f: ReturnType<typeof stub>, method: string) => (f.mock.calls as unknown as Call[]).filter(c => c[1]?.method === method)

beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals(); setAccountZone('Europe/Amsterdam'); vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) }) })
afterEach(() => { vi.useRealTimers(); setAccountZone(undefined) })

describe('schedule a task from its row', () => {
  it('offers the next free times, books nothing until one is tapped, then books that time with Undo', async () => {
    const fetcher = stub()
    render(wrap(<TasksPage />))
    fireEvent.click(await screen.findByText('Pay the invoice'))
    const group = await screen.findByRole('group', { name: 'Schedule' })
    expect(calls(fetcher, 'POST')).toHaveLength(0)
    const chips = [...group.querySelectorAll('button')].map(b => b.textContent)
    expect(chips).toHaveLength(3)
    expect(chips[0]).toMatch(/^Today/); expect(chips[1]).toMatch(/^Tomorrow/)
    fireEvent.click(group.querySelectorAll('button')[0])
    await waitFor(() => expect(calls(fetcher, 'POST')).toHaveLength(1))
    // Booking goes through the task's schedule endpoint (not POST /api/events), with one idempotency key for this tap.
    expect(calls(fetcher, 'POST')[0][0]).toMatch(/\/api\/tasks\/7\/schedule$/)
    expect(JSON.parse(calls(fetcher, 'POST')[0][1]!.body as string)).toEqual({ starts_at: '2027-03-09T13:00:00.000Z', ends_at: '2027-03-09T13:45:00.000Z' })
    expect((calls(fetcher, 'POST')[0][1]!.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(calls(fetcher, 'DELETE').map(c => c[0])).toEqual([expect.stringMatching(/\/api\/events\/99$/)]))
  })

  it('asks the server only for slots as long as the task', async () => {
    const fetcher = stub()
    render(wrap(<TasksPage />))
    fireEvent.click(await screen.findByText('Pay the invoice'))
    await screen.findByRole('group', { name: 'Schedule' })
    const url = (fetcher.mock.calls as unknown as Call[]).map(c => String(c[0])).find(u => u.includes('/api/availability'))!
    expect(url).toContain('min_minutes=45'); expect(url).toContain('days=7')
  })
})
