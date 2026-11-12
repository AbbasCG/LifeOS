import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import CalendarPage from '../features/CalendarPage'
import EventForm from '../features/EventForm'
import { setAccountZone } from '../lib/accountDay'
import { TASKS_CHANGED } from '../lib/quickAdd'
import { blockBox, blockHeight, HOUR_PX, minutesInto, movePreview, resizePreview } from '../lib/calendar'
import type { Availability, CalendarOccurrence } from '../lib/api'

/**
 * The calendar grid and what it does when the server refuses a move.
 * Grid rules relied on here: the grid is a wall-clock grid (10:00 is at 10 × 52px on every day, also the 23- and 25-hour ones); a block is
 * exactly as tall as it is long (minutes × 52/60 px) less a 2px gap; a block that crosses midnight is drawn in both day columns.
 */
const original = process.env.TZ
beforeAll(() => { process.env.TZ = 'Europe/Amsterdam' })
afterAll(() => { if (original === undefined) delete process.env.TZ; else process.env.TZ = original })

describe('grid math', () => {
  it('a block is as tall as it is long: 15, 30, 45 and 60 minutes, less the 2px gap', () => {
    expect([15, 30, 45, 60, 90].map(blockHeight)).toEqual([11, 24, 37, 50, 76])
    for (const minutes of [15, 30, 45, 60, 120]) expect((blockHeight(minutes) + 2) / minutes).toBeCloseTo(HOUR_PX / 60, 10)
  })
  it('back-to-back blocks touch the next one’s top, 2px apart, and a 15-minute block is not rounded up', () => {
    const day = new Date(2026, 10, 12)
    const a = blockBox(day, new Date(2026, 10, 12, 9, 0), new Date(2026, 10, 12, 9, 15)), b = blockBox(day, new Date(2026, 10, 12, 9, 15), new Date(2026, 10, 12, 9, 45))
    expect(a.height).toBe(11)
    expect(b.top).toBe(a.top + a.height + 2)
    expect(a.top).toBe(9 * HOUR_PX)
  })
  it('draws a block that crosses midnight in both columns, each part as long as its visible part', () => {
    const d1 = new Date(2026, 10, 12), d2 = new Date(2026, 10, 13)
    const start = new Date(2026, 10, 12, 22, 0), end = new Date(2026, 10, 13, 2, 0)
    const first = blockBox(d1, start, end), second = blockBox(d2, start, end)
    expect(first).toMatchObject({ top: 22 * HOUR_PX, height: blockHeight(120), runsOn: true, continues: false })
    expect(second).toMatchObject({ top: 0, height: blockHeight(120), runsOn: false, continues: true })
  })
  it('places a block by the wall clock on the day the clocks go forward (2026-03-29, 23 hours): 10:00 is at 600 minutes', () => {
    const day = new Date(2026, 2, 29), ten = new Date('2026-03-29T08:00:00Z')   // 10:00 CEST
    expect(ten.getHours()).toBe(10)
    expect(minutesInto(day, ten)).toBe(600)
    expect(blockBox(day, ten, new Date('2026-03-29T08:30:00Z')).top).toBe(10 * HOUR_PX)
    expect(minutesInto(day, new Date('2026-03-29T00:30:00Z'))).toBe(90)         // 01:30 CET, before the change
    expect(minutesInto(day, new Date('2026-03-29T01:30:00Z'))).toBe(210)        // 03:30 CEST, after it (02:xx does not exist)
  })
  it('places a block by the wall clock on the day the clocks go back (2026-10-25, 25 hours)', () => {
    const day = new Date(2026, 9, 25), ten = new Date('2026-10-25T09:00:00Z')   // 10:00 CET
    expect(ten.getHours()).toBe(10)
    expect(minutesInto(day, ten)).toBe(600)
    expect(minutesInto(day, new Date('2026-10-25T21:00:00Z'))).toBe(22 * 60)   // 22:00 CET
    expect(minutesInto(new Date(2026, 9, 26), new Date('2026-10-25T23:30:00Z'))).toBe(30)   // 00:30 on the 26th
  })
  it('moves a block on a clock-change day by wall-clock minutes and keeps its real length', () => {
    const day = new Date(2026, 2, 29), s = new Date('2026-03-29T08:00:00Z'), e = new Date('2026-03-29T09:00:00Z')
    const moved = movePreview(s, e, day, day, 60)
    expect(moved.start.getHours()).toBe(11); expect(moved.start.getMinutes()).toBe(0)
    expect(moved.end.getTime() - moved.start.getTime()).toBe(3_600_000)
  })
  it('does not move or shorten a block that crosses midnight when the pointer has not moved, from either day column', () => {
    const d1 = new Date(2026, 10, 12), d2 = new Date(2026, 10, 13)
    const s = new Date(2026, 10, 12, 22, 0), e = new Date(2026, 10, 13, 2, 0)
    for (const day of [d1, d2]) {
      const m = movePreview(s, e, day, day, 0)
      expect(m.start).toEqual(s); expect(m.end).toEqual(e)
      expect(resizePreview(s, e, day, 0).end).toEqual(e)
    }
    expect(movePreview(s, e, d1, d2, 30).start).toEqual(new Date(2026, 10, 13, 22, 30))   // one column to the right and 30 minutes down
    expect(resizePreview(s, e, d2, 30).end).toEqual(new Date(2026, 10, 13, 2, 30))
  })
})

type Call = [string, RequestInit | undefined]
const wrap = (children: ReactNode, path = '/') => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[path]}><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
const ZONE = 'Europe/Amsterdam', NOW = '2026-11-11T10:00:00Z'
const occurrence = (over: Partial<CalendarOccurrence> = {}): CalendarOccurrence => ({ id: 'e55', event_id: 55, source: 'lifeos', title: 'Pay the invoice', kind: 'flexible', task_id: 7, starts_at: '2026-11-12T08:00:00Z', ends_at: '2026-11-12T08:30:00Z', recurring: false, occurrence_start: null, editable: true, ...over })
const other = occurrence({ id: 'e56', event_id: 56, title: 'Team stand-up', task_id: null, kind: 'fixed', starts_at: '2026-11-12T08:15:00Z', ends_at: '2026-11-12T08:45:00Z' })
const free: Availability = { work_start: '09:00', work_end: '17:00', days: [{ date: '2026-11-12', work_day: true, free_minutes: 480, slots: [{ starts_at: '2026-11-12T10:00:00Z', ends_at: '2026-11-12T16:00:00Z', minutes: 360 }] }] }
const refused = (suggestion: unknown = { starts_at: '2026-11-12T09:00:00Z', ends_at: '2026-11-12T09:30:00Z' }, withBody = true) => ({
  status: 422, body: { message: 'This time conflicts with “Team stand-up”.', errors: { starts_at: ['This time conflicts with “Team stand-up”.'] },
    ...(withBody ? { conflict: { code: 'schedule_conflict', requested: { starts_at: '2026-11-12T08:15:00Z', ends_at: '2026-11-12T08:45:00Z' },
      conflicts: [{ id: 56, event_id: 56, task_id: null, title: 'Team stand-up', kind: 'event', source: 'lifeos', starts_at: '2026-11-12T08:15:00Z', ends_at: '2026-11-12T08:45:00Z', overlap_minutes: 15 }], suggestion } } : {}) },
})

type Patch = (init: RequestInit) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>
function stub(patch: Patch, seed: CalendarOccurrence[] = [occurrence(), other]) {
  const calendar = seed.map(o => ({ ...o }))   // the "server": a saved move is what the next read returns
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const r = await patch(init)
      if (r.status === 200) { const sent = JSON.parse(String(init.body)); const hit = calendar.find(o => o.event_id === Number(url.split('/').pop())); if (hit) Object.assign(hit, { starts_at: sent.starts_at, ends_at: sent.ends_at }) }
      return new Response(JSON.stringify(r.body), { status: r.status })
    }
    const body = /\/api\/user$/.test(url) ? { id: 1, name: 'A', email: 'a@x.io', timezone: ZONE }
      : /\/api\/availability/.test(url) ? free : /\/api\/calendar/.test(url) ? { data: calendar } : /\/api\/tasks/.test(url) ? { data: [], meta: { last_page: 1 } } : { data: [] }
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const patches = (f: ReturnType<typeof stub>) => (f.mock.calls as unknown as Call[]).filter(c => c[1]?.method === 'PATCH')
const block = () => document.querySelector<HTMLElement>('[data-occurrence="e55"]')!
const shown = () => block().querySelector('small')!.textContent
// The block is drawn from the first answer; the account zone and the task list arrive a moment later. Wait for them, as a person does, before the first key.
const open = async () => { render(wrap(<CalendarPage />, '/calendar?date=2026-11-12')); await waitFor(() => expect(block()).toBeTruthy()); await new Promise(r => setTimeout(r, 80)) }
const nudge = (key = 'ArrowDown') => fireEvent.keyDown(block(), { key, altKey: true })

beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); localStorage.setItem('lifeos-calendar-view', 'day'); vi.unstubAllGlobals(); setAccountZone(ZONE); vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) }) })
afterEach(() => { vi.useRealTimers(); setAccountZone(undefined) })

describe('a move the server refuses', () => {
  it('puts the block back exactly where it was, opens the conflict dialog and leaves nothing "moved" behind', async () => {
    let answer: (r: { status: number; body: unknown }) => void = () => {}
    const f = stub(() => new Promise(resolve => { answer = resolve }))
    await open()
    expect(shown()).toBe('09:00 – 09:30')
    nudge()                                                              // 15 minutes down, onto the stand-up
    await waitFor(() => expect(shown()).toBe('09:15 – 09:45'))          // drawn at once (optimistic)
    await act(async () => { answer(refused()) })
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Team stand-up')
    expect(shown()).toBe('09:00 – 09:30')                               // rolled back, not waiting for a reload
    expect(patches(f)).toHaveLength(1)
    expect(screen.queryByText(/now 09:15/)).toBeNull()                  // no success message
    expect(document.querySelectorAll('[data-occurrence="e55"]')).toHaveLength(1)
  })

  it('explains a plain 422 (a server without the structured answer) from the calendar it already has', async () => {
    stub(() => refused(null, false))
    await open()
    nudge()
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Team stand-up')
    expect(shown()).toBe('09:00 – 09:30')
  })

  it('“Choose another time” returns focus to the block that was not moved', async () => {
    stub(() => refused())
    await open()
    nudge()
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose another time' }))
    await waitFor(() => expect(block()).toHaveFocus())
  })

  it('the suggested time goes through the same request, for the same event', async () => {
    const f = stub(init => (patches(f).length === 1 ? refused() : { status: 200, body: { data: JSON.parse(String(init.body)) } }))
    await open()
    nudge()
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Suggest the first free time/ }))
    await waitFor(() => expect(patches(f)).toHaveLength(2))
    expect(patches(f)[1][0]).toMatch(/\/api\/events\/55$/)
    expect(JSON.parse(String(patches(f)[1][1]!.body))).toMatchObject({ starts_at: '2026-11-12T09:00:00Z', ends_at: '2026-11-12T09:30:00Z' })
    await waitFor(() => expect(shown()).toBe('10:00 – 10:30'))
  })

  it('a dropped connection rolls the block back with a message, and “Try again” sends the same absolute times', async () => {
    let calls = 0
    const f = stub(() => { calls++; if (calls === 1) throw new TypeError('network'); return { status: 200, body: { data: {} } } })
    await open()
    nudge()
    expect(await screen.findByText(/Could not reach LifeOS/)).toBeInTheDocument()
    expect(shown()).toBe('09:00 – 09:30')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(patches(f)).toHaveLength(2))
    expect(patches(f)[1][1]!.body).toBe(patches(f)[0][1]!.body)
    await waitFor(() => expect(shown()).toBe('09:15 – 09:45'))
  })

  it('a successful move refreshes the tasks as well as the calendar, and Undo moves the same event back', async () => {
    const f = stub(() => ({ status: 200, body: { data: {} } }), [occurrence()])
    let tasksChanged = 0
    const count = () => { tasksChanged++ }
    window.addEventListener(TASKS_CHANGED, count)
    await open()
    nudge()
    await waitFor(() => expect(tasksChanged).toBe(1))
    window.removeEventListener(TASKS_CHANGED, count)
    expect(await screen.findByText(/now 09:15 – 09:45/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(patches(f)).toHaveLength(2))
    expect(patches(f)[1][0]).toMatch(/\/api\/events\/55$/)
    expect(JSON.parse(String(patches(f)[1][1]!.body))).toMatchObject({ starts_at: '2026-11-12T08:00:00Z', ends_at: '2026-11-12T08:30:00Z' })
    expect(await screen.findByText('Change undone.')).toBeInTheDocument()
  })

  it('nudges made while one is being saved are drawn at once and sent as one request with the latest time; a refusal returns to the last saved time', async () => {
    const answers: ((r: { status: number; body: unknown }) => void)[] = []
    const f = stub(() => new Promise(resolve => { answers.push(resolve) }), [occurrence()])
    await open()
    for (const step of ['09:15 – 09:45', '09:30 – 10:00', '09:45 – 10:15']) { await act(async () => { nudge() });  expect(shown()).toBe(step) }   // each drawn at once
    expect(patches(f)).toHaveLength(1)
    await act(async () => { answers[0]({ status: 200, body: { data: {} } }) })
    await waitFor(() => expect(patches(f)).toHaveLength(2))
    expect(JSON.parse(String(patches(f)[1][1]!.body))).toMatchObject({ starts_at: '2026-11-12T08:45:00.000Z', ends_at: '2026-11-12T09:15:00.000Z' })
    await act(async () => { answers[1]({ status: 422, body: { message: 'x', errors: { other: ['x'] } } }) })
    await waitFor(() => expect(shown()).toBe('09:15 – 09:45'))          // back to the saved first step, not to the start
  })

  it('a 15-minute block is drawn 11px tall, not rounded up over the block below it', async () => {
    stub(() => ({ status: 200, body: {} }), [occurrence({ ends_at: '2026-11-12T08:15:00Z' })])
    await open()
    expect(block().style.height).toBe('11px')
    expect(block().className).toContain('tiny')
  })
})

describe('the event form', () => {
  it('a refused save opens the same conflict dialog, keeps the form as it was, and the suggestion is saved through the same request', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { bodies.push(JSON.parse(String(init.body))); const r = bodies.length === 1 ? refused() : { status: 201, body: { data: { id: 90 } } }; return new Response(JSON.stringify(r.body), { status: r.status }) }
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetcher)
    const onSaved = vi.fn(), onClose = vi.fn()
    render(wrap(<EventForm item={{ starts_at: '2026-11-12T08:15:00Z', ends_at: '2026-11-12T08:45:00Z', kind: 'flexible' }} tasks={[]} known={[other]} onSaved={onSaved} onClose={onClose} />))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Dentist' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Team stand-up')
    expect(onSaved).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled()      // nothing was created, the form is still open
    expect(screen.getByLabelText('Title')).toHaveValue('Dentist')
    fireEvent.click(within(dialog).getByRole('button', { name: /Suggest the first free time/ }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toMatchObject({ title: 'Dentist', starts_at: '2026-11-12T09:00:00.000Z', ends_at: '2026-11-12T09:30:00.000Z' })
  })
})
