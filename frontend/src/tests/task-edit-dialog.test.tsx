import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { RecordForm } from '../features/RecordForm'
import { setAccountZone } from '../lib/accountDay'
import { CALENDAR_CHANGED } from '../lib/taskSchedule'
import { TASKS_CHANGED } from '../lib/quickAdd'
import type { Availability } from '../lib/api'

// The browser zone (the date fields' zone) is Amsterdam, equal to the account's, the usual case.
const BROWSER_TZ = process.env.TZ
process.env.TZ = 'Europe/Amsterdam'
afterAll(() => { if (BROWSER_TZ === undefined) delete process.env.TZ; else process.env.TZ = BROWSER_TZ })
// "Now" is Wednesday 2026-11-11 11:00 in Amsterdam (10:00 UTC).
const NOW = '2026-11-11T10:00:00Z'
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider>{children}</ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
type Call = { method: string; url: string; body?: Record<string, unknown> }
const free: Availability = { work_start: '09:00', work_end: '17:00', days: [{ date: '2026-11-13', work_day: true, free_minutes: 480, slots: [{ starts_at: '2026-11-13T08:00:00Z', ends_at: '2026-11-13T16:00:00Z', minutes: 480 }] }] }
const session = (over: Record<string, unknown> = {}) => ({ session_id: 55, starts_at: '2026-11-12T08:00:00Z', ends_at: '2026-11-12T08:30:00Z', sessions: 1, split: false, ...over })
const task = (over: Record<string, unknown> = {}) => ({ id: 7, title: 'Pay the invoice', status: 'todo', priority: 'high', due_at: '2026-11-20T08:30:00Z', estimated_minutes: 30, schedule: null, ...over })

type Reply = { status: number; body: unknown }
function server(opts: { put?: () => Reply | Promise<Reply>; patch?: () => Reply | Promise<Reply> } = {}) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET'
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined })
    const reply = (r: Reply) => new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
    if (method === 'PUT' && /\/api\/tasks\/\d+\/schedule$/.test(String(url))) return reply(await (opts.put?.() ?? { status: 200, body: { data: { id: 55 }, schedule: session({ starts_at: '2026-11-13T08:00:00Z', ends_at: '2026-11-13T08:30:00Z' }) } }))
    if (method === 'PATCH') return reply(await (opts.patch?.() ?? { status: 200, body: { data: { id: 7 } } }))
    if (/\/api\/availability/.test(String(url))) return reply({ status: 200, body: free })
    return reply({ status: 200, body: { data: [], meta: { last_page: 1 } } })
  }))
  return calls
}
const open = (item: Record<string, unknown> = task(), onSave = vi.fn(), onClose = vi.fn()) => { render(wrap(<RecordForm resource="tasks" item={item} onSave={onSave} onClose={onClose} />)); return { onSave, onClose } }
const deadline = () => (document.querySelector('.rf-deadline .dtp-trigger') as HTMLElement).dataset.value
const tile = (name: string) => screen.getByRole('radio', { name })
const selected = () => screen.getAllByRole('radio').filter(r => r.closest('[aria-label="When"]') && r.getAttribute('aria-checked') === 'true').map(r => r.textContent)
const patchBody = (calls: Call[]) => calls.filter(c => c.method === 'PATCH').map(c => c.body)

beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals(); setAccountZone('Europe/Amsterdam'); vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) }) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); setAccountZone(undefined) })

describe('the "When" tiles set the day and keep the time', () => {
  it('Today and Tomorrow keep the time already chosen (09:30 here), and the tile is selected', () => {
    server(); open()   // due 2026-11-20 09:30 Amsterdam
    expect(deadline()).toBe('2026-11-20T09:30'); expect(selected()).toEqual([])
    fireEvent.click(tile('Today')); expect(deadline()).toBe('2026-11-11T09:30'); expect(selected()).toEqual(['Today'])
    fireEvent.click(tile('Tomorrow')); expect(deadline()).toBe('2026-11-12T09:30'); expect(selected()).toEqual(['Tomorrow'])
    fireEvent.click(tile('This week')); expect(deadline()).toBe('2026-11-15T09:30'); expect(selected()).toEqual(['This week'])
  })
  it('with no deadline yet, a tile fills the visible default 17:00', () => {
    server(); open(task({ due_at: null }))
    expect(deadline()).toBe(''); expect(selected()).toEqual(['No date'])
    fireEvent.click(tile('Today')); expect(deadline()).toBe('2026-11-11T17:00')
    expect(document.querySelector('.rf-deadline .dtp-trigger')!.textContent).toMatch(/17:00|5:00\s?PM/)
  })
  it('after 17:00 the default for today is the next half hour, never 23:00', () => {
    server(); vi.setSystemTime(new Date('2026-11-11T17:10:00Z'))   // 18:10 in Amsterdam
    open(task({ due_at: null }))
    fireEvent.click(tile('Today')); expect(deadline()).toBe('2026-11-11T18:30')
    fireEvent.click(tile('Tomorrow')); expect(deadline()).toBe('2026-11-12T18:30')   // now it has a time: kept
  })
  it('"No date" clears the deadline and is selected; the save sends null', async () => {
    const calls = server(); open()
    fireEvent.click(tile('No date')); expect(deadline()).toBe(''); expect(selected()).toEqual(['No date'])
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patchBody(calls)).toHaveLength(1))
    expect(patchBody(calls)[0]).toMatchObject({ due_at: null })
  })
  it('another day (Wednesday the 18th) selects no tile and says it is a custom date', async () => {
    server(); open(task({ due_at: '2026-11-18T15:00:00Z' }))
    expect(selected()).toEqual([])
    expect(document.querySelector('.rf-custom')).toHaveTextContent('Custom due date: Wednesday, November 18')
    expect(document.querySelector('.rf-custom')).toHaveAttribute('aria-hidden', 'true')   // the visible copy; the status below speaks it
    fireEvent.click(tile('Tomorrow')); expect(screen.queryByText(/Custom due date/)).toBeNull()
  })
  it('near midnight the account day decides, not the UTC day', () => {
    server(); open(task({ due_at: '2026-11-11T23:30:00Z' }))   // 00:30 on the 12th in Amsterdam, still the 11th in UTC
    expect(deadline()).toBe('2026-11-12T00:30'); expect(selected()).toEqual(['Tomorrow'])
  })
  it('the deadline is saved as the typed wall time in the browser zone (09:30 Amsterdam), and the label says it is the deadline', async () => {
    const calls = server(); open()
    expect(screen.getByText('Deadline (due)')).toBeInTheDocument()
    fireEvent.click(tile('Today'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patchBody(calls)).toHaveLength(1))
    expect(patchBody(calls)[0]).toMatchObject({ due_at: '2026-11-11T08:30:00.000Z' })
  })
  it('reopening after a save shows the right tile', async () => {
    const calls = server(); const first = open()
    fireEvent.click(tile('Tomorrow')); fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(first.onClose).toHaveBeenCalled())
    cleanup()
    open(task({ due_at: patchBody(calls)[0]!.due_at as string }))
    expect(selected()).toEqual(['Tomorrow'])
  })
})

describe('accessibility and wording of the When tiles', () => {
  const statuses = () => [...document.querySelectorAll('[role="status"]')].map(n => n.textContent)
  it('the custom-date status node is always there, empty until the date settles, then speaks once; the year shows only when it differs', async () => {
    server(); open(task({ due_at: '2027-02-17T15:00:00Z' }))
    expect(document.querySelector('.rf-custom')).toHaveTextContent('Wednesday, February 17, 2027')
    expect(statuses().join('')).not.toContain('Custom due date')   // not yet: it waits for the date to stop changing
    await waitFor(() => expect(statuses().filter(x => x?.includes('Custom due date: Wednesday, February 17, 2027'))).toHaveLength(1))
    fireEvent.click(tile('Today'))
    await waitFor(() => expect(statuses().join('')).not.toContain('Custom due date'))
    expect(statuses().length).toBeGreaterThan(0)
  })
  it('Save keeps focus while saving: aria-disabled, not disabled, and a second press does nothing', async () => {
    let release: (r: Reply) => void = () => undefined
    const calls = server({ patch: () => new Promise<Reply>(r => { release = r }) })
    open()
    const save = screen.getByRole('button', { name: 'Save' }); save.focus()
    fireEvent.click(save)
    await waitFor(() => expect(save).toHaveAttribute('aria-disabled', 'true'))
    expect(save).not.toBeDisabled(); expect(save).toHaveFocus()
    fireEvent.click(save)
    release({ status: 200, body: { data: { id: 7 } } })
    await waitFor(() => expect(patchBody(calls)).toHaveLength(1))
  })
  it('the helper text describes the deadline field', () => {
    server(); open()
    const group = screen.getByRole('group', { name: 'Deadline (due)' })
    expect(document.getElementById(group.getAttribute('aria-describedby')!)).toHaveTextContent(/keeps the time/)
  })
  it('"This week" on a Saturday (resolves to tomorrow) and on a Sunday (resolves to today) stays the checked tile until something else changes the field', () => {
    server()
    vi.setSystemTime(new Date('2026-11-14T10:00:00Z'))   // Saturday
    open(task({ due_at: null }))
    fireEvent.click(tile('This week')); expect(deadline()).toBe('2026-11-15T17:00'); expect(selected()).toEqual(['This week'])
    fireEvent.click(tile('Tomorrow')); expect(selected()).toEqual(['Tomorrow'])
    cleanup(); vi.setSystemTime(new Date('2026-11-15T10:00:00Z'))   // Sunday
    open(task({ due_at: null }))
    fireEvent.click(tile('This week')); expect(deadline()).toBe('2026-11-15T17:00'); expect(selected()).toEqual(['This week'])
    fireEvent.click(tile('Today')); expect(selected()).toEqual(['Today'])
    fireEvent.click(tile('No date')); expect(selected()).toEqual(['No date'])
  })
  it('is Dutch where the dialog is: tiles, label, priority', () => {
    localStorage.setItem('lifeos-language', 'nl'); server(); open()
    for (const name of ['Vandaag', 'Morgen', 'Deze week', 'Geen datum']) expect(screen.getByRole('radio', { name })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Wanneer' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Prioriteit' })).toBeInTheDocument()
    expect(screen.getByText('Deadline (uiterste datum)')).toBeInTheDocument()
    expect(screen.getByText(/behoudt de tijd/)).toBeInTheDocument()
  })
})

describe('browser zone differs from the account zone', () => {
  it('the day is the account\'s today, the time stays, and the tile follows the account day of that moment', () => {
    server(); setAccountZone('Pacific/Auckland')   // 23:00 on the 11th there; the field is Amsterdam time
    open(task({ due_at: '2026-11-11T12:00:00Z' }))   // field 13:00 on the 11th, but 01:00 on the 12th in Auckland
    expect(deadline()).toBe('2026-11-11T13:00'); expect(selected()).toEqual(['Tomorrow'])
    fireEvent.click(tile('Today')); expect(deadline()).toBe('2026-11-11T13:00')   // account today = the 11th, time kept
  })
})

describe('saving', () => {
  it('sends one request for a double click, then refreshes the task lists and the calendar once each', async () => {
    const calls = server(); let release: (r: Reply) => void = () => undefined
    const gate = new Promise<Reply>(r => { release = r })
    vi.unstubAllGlobals(); const inner = server({ patch: () => gate }); void calls
    const tasks = vi.fn(), cal = vi.fn()
    window.addEventListener(TASKS_CHANGED, tasks); window.addEventListener(CALENDAR_CHANGED, cal)
    const { onSave, onClose } = open()
    const save = screen.getByRole('button', { name: 'Save' })
    fireEvent.click(save); fireEvent.submit(document.getElementById('record-form-tasks')!)
    release({ status: 200, body: { data: { id: 7 } } })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(patchBody(inner)).toHaveLength(1); expect(onSave).toHaveBeenCalledTimes(1)
    expect(tasks).toHaveBeenCalledTimes(1); expect(cal).toHaveBeenCalledTimes(1)
    window.removeEventListener(TASKS_CHANGED, tasks); window.removeEventListener(CALENDAR_CHANGED, cal)
  })
})

describe('the scheduled session, apart from the deadline', () => {
  const booked = (over: Record<string, unknown> = {}) => task({ schedule: session(), due_at: '2026-11-20T15:00:00Z', ...over })
  it('is not shown for a task without a session', () => {
    server(); open(task()); expect(screen.queryByText('Scheduled session time')).toBeNull()
  })
  it('shows the session time in the account zone, a calendar link, and says that the deadline alone does not move it', () => {
    server(); open(booked())
    const block = screen.getByRole('region', { name: 'Scheduled session time' })
    expect(block.textContent).toMatch(/09:00|9:00/)   // 08:00Z is 09:00 in Amsterdam
    expect(within(block).getByRole('link', { name: 'View in calendar' })).toHaveAttribute('href', '/calendar?date=2026-11-12&session=55')
    expect(within(block).getByText(/does not move the session/)).toBeInTheDocument()
  })
  it('warns calmly when the deadline is before the session ends, and stops when it is later', () => {
    server(); open(booked({ due_at: '2026-11-12T08:00:00Z' }))
    expect(screen.getByText('The scheduled session is after the deadline.')).toBeInTheDocument()
    fireEvent.click(tile('Tomorrow'))   // keeps 09:00; the session ends 09:30
    expect(screen.getByText('The scheduled session is after the deadline.')).toBeInTheDocument()
    fireEvent.click(tile('This week'))
    expect(screen.queryByText('The scheduled session is after the deadline.')).toBeNull()
  })
  it('Reschedule moves the existing session with PUT (never a POST), once, then refreshes tasks and calendar and says so politely', async () => {
    const calls = server(); open(booked())
    const tasks = vi.fn(), cal = vi.fn()
    window.addEventListener(TASKS_CHANGED, tasks); window.addEventListener(CALENDAR_CHANGED, cal)
    const trigger = screen.getByRole('button', { name: 'Reschedule' })
    fireEvent.click(trigger); expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const slot = await screen.findAllByRole('button', { name: /Suggested times/ })
    fireEvent.click(slot[0]); fireEvent.click(slot[0])
    await waitFor(() => expect(calls.filter(c => c.method === 'PUT')).toHaveLength(1))
    const put = calls.find(c => c.method === 'PUT')!
    expect(put.url).toMatch(/\/api\/tasks\/7\/schedule$/); expect(put.body).toMatchObject({ session_id: 55 })
    expect(calls.some(c => c.method === 'POST')).toBe(false)
    await waitFor(() => expect(cal).toHaveBeenCalledTimes(1)); expect(tasks).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('group', { name: 'Reschedule the session' })).toBeNull()
    await waitFor(() => expect(trigger).toHaveFocus())   // focus returns to the button that opened the editor
    expect(document.body.textContent).toContain('Session moved.')
    expect(screen.getByRole('region', { name: 'Scheduled session time' }).textContent).toMatch(/13/)   // now on the 13th
    window.removeEventListener(TASKS_CHANGED, tasks); window.removeEventListener(CALENDAR_CHANGED, cal)
  })
  it('an overlap (422 on starts_at) is shown in the dialog, no success is announced and the session time is unchanged', async () => {
    const calls = server({ put: () => ({ status: 422, body: { message: 'The given data was invalid.', errors: { starts_at: ['That time overlaps “Standup”.'] } } }) })
    open(booked())
    const cal = vi.fn(); window.addEventListener(CALENDAR_CHANGED, cal)
    fireEvent.click(screen.getByRole('button', { name: 'Reschedule' }))
    fireEvent.click((await screen.findAllByRole('button', { name: /Suggested times/ }))[0])
    expect(await screen.findByRole('alert')).toHaveTextContent('That time overlaps “Standup”.')
    expect(document.body.textContent).not.toContain('Session moved.')
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(1); expect(cal).not.toHaveBeenCalled()
    window.removeEventListener(CALENDAR_CHANGED, cal)
  })
  it('a permission error shows the server’s own message', async () => {
    server({ put: () => ({ status: 403, body: { message: 'You may not change this calendar.' } }) })
    open(booked())
    fireEvent.click(screen.getByRole('button', { name: 'Reschedule' }))
    fireEvent.click((await screen.findAllByRole('button', { name: /Suggested times/ }))[0])
    expect(await screen.findByRole('alert')).toHaveTextContent('You may not change this calendar.')
  })
  it('closing the editor clears an earlier error, but a failed move keeps it open with the error', async () => {
    server({ put: () => ({ status: 422, body: { message: 'x', errors: { starts_at: ['Overlap.'] } } }) })
    open(booked())
    const trigger = screen.getByRole('button', { name: 'Reschedule' })
    fireEvent.click(trigger)
    fireEvent.click((await screen.findAllByRole('button', { name: /Suggested times/ }))[0])
    expect(await screen.findByRole('alert')).toHaveTextContent('Overlap.')
    fireEvent.click(within(screen.getByRole('group', { name: 'Reschedule the session' })).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() => expect(trigger).toHaveFocus())
  })
  it('speaks Arabic and Dutch', () => {
    localStorage.setItem('lifeos-language', 'ar'); server(); open(booked({ due_at: '2026-11-12T08:00:00Z' }))
    expect(screen.getByText('موعد الجلسة المجدولة')).toBeInTheDocument()
    expect(screen.getByText('الجلسة المجدولة بعد الموعد النهائي.')).toBeInTheDocument()
    expect(screen.getByText('الموعد النهائي (الاستحقاق)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'إعادة الجدولة' })).toBeInTheDocument()
    cleanup(); localStorage.setItem('lifeos-language', 'nl'); server(); open(booked())
    expect(screen.getByText('Tijd van de ingeplande sessie')).toBeInTheDocument()
  })
})
