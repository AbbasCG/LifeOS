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
type Call = { method: string; url: string; body?: Record<string, unknown>; key?: string }
const free: Availability = { work_start: '09:00', work_end: '17:00', days: [{ date: '2026-11-13', work_day: true, free_minutes: 480, slots: [{ starts_at: '2026-11-13T08:00:00Z', ends_at: '2026-11-13T16:00:00Z', minutes: 480 }] }] }
const session = (over: Record<string, unknown> = {}) => ({ session_id: 55, starts_at: '2026-11-12T08:00:00Z', ends_at: '2026-11-12T08:30:00Z', sessions: 1, split: false, ...over })
const task = (over: Record<string, unknown> = {}) => ({ id: 7, title: 'Pay the invoice', status: 'todo', priority: 'high', due_at: '2026-11-20T08:30:00Z', estimated_minutes: 30, schedule: null, ...over })

type Reply = { status: number; body: unknown }
function server(opts: { put?: () => Reply | Promise<Reply>; post?: () => Reply | Promise<Reply>; patch?: () => Reply | Promise<Reply> } = {}) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET'
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined, key: (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'] })
    const reply = (r: Reply) => new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
    if (method === 'PUT' && /\/api\/tasks\/\d+\/schedule$/.test(String(url))) return reply(await (opts.put?.() ?? { status: 200, body: { data: { id: 55 }, schedule: session({ starts_at: '2026-11-13T08:00:00Z', ends_at: '2026-11-13T08:30:00Z' }) } }))
    if (method === 'POST' && /\/api\/tasks\/\d+\/schedule$/.test(String(url))) return reply(await (opts.post?.() ?? { status: 201, body: { data: { id: 91, task_id: 7 }, schedule: session({ session_id: 91, starts_at: '2026-11-13T08:00:00Z', ends_at: '2026-11-13T08:30:00Z' }) } }))
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
  it('the field shows the account\'s clock (not the browser\'s), the tile follows it, and Today keeps the time', () => {
    server(); setAccountZone('Pacific/Auckland')   // 23:00 on the 11th there; the browser is in Amsterdam
    open(task({ due_at: '2026-11-11T12:00:00Z' }))   // 01:00 on the 12th in Auckland (13:00 in Amsterdam)
    expect(deadline()).toBe('2026-11-12T01:00'); expect(selected()).toEqual(['Tomorrow'])
    fireEvent.click(tile('Today')); expect(deadline()).toBe('2026-11-11T01:00')   // account today = the 11th, time kept
  })
})

describe.each(['UTC', 'America/New_York'])('browser in %s, account in Amsterdam: the dialog speaks the account clock', browser => {
  const sessionStart = () => (screen.getByText('Execution start').closest('label')!.querySelector('.dtp-trigger') as HTMLElement).dataset.value
  beforeEach(() => { process.env.TZ = browser })
  afterEach(() => { process.env.TZ = 'Europe/Amsterdam' })

  it('shows the deadline and the scheduled start/end as the calendar and the list badges show them (17:00, 09:00-09:30)', () => {
    server(); open(task({ due_at: '2026-11-20T16:00:00Z', schedule: session() }))
    expect(deadline()).toBe('2026-11-20T17:00')
    expect(sessionStart()).toBe('2026-11-12T09:00')
    expect(screen.getByText('Execution end').closest('label')!.querySelector<HTMLElement>('.dtp-trigger')!.dataset.value).toBe('2026-11-12T09:30')
  })
  it('saving without touching anything sends no deadline at all, and no session request', async () => {
    const calls = server(); open(task({ due_at: '2026-11-20T16:00:00Z', schedule: session() }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patchBody(calls)).toHaveLength(1))
    expect(patchBody(calls)[0]).not.toHaveProperty('due_at'); expect(patchBody(calls)[0]).not.toHaveProperty('due_date')
    expect(calls.filter(c => /schedule$/.test(c.url))).toHaveLength(0)
  })
  it('a tile keeps the typed time and posts it as account time (Today 17:00 is 16:00Z)', async () => {
    const calls = server(); open(task({ due_at: '2026-11-20T16:00:00Z' }))
    fireEvent.click(tile('Today')); expect(deadline()).toBe('2026-11-11T17:00')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patchBody(calls)).toHaveLength(1))
    expect(patchBody(calls)[0]).toMatchObject({ due_at: '2026-11-11T16:00:00.000Z' })
  })
  it('says which zone the times are in, and ties the note to the deadline for screen readers', () => {
    server(); open()
    const [note, ...others] = screen.getAllByText(/Times are in/)   // one under the deadline, one in the scheduled-time box
    expect(others).toHaveLength(1)
    expect(note).toHaveTextContent('Times are in Europe/Amsterdam')
    expect(screen.getByRole('group', { name: 'Deadline (due)' }).getAttribute('aria-describedby')).toContain(note.id)
  })
})

describe('browser in the account zone', () => {
  it('shows no zone note: there is nothing to explain', () => {
    server(); open()
    expect(screen.queryByText(/Times are in/)).not.toBeInTheDocument()
  })
  it('the note reads in Arabic, with the zone name kept left-to-right', () => {
    process.env.TZ = 'UTC'; localStorage.setItem('lifeos-language', 'ar')
    try { server(); open() } finally { process.env.TZ = 'Europe/Amsterdam' }
    const note = screen.getAllByText(/الأوقات بتوقيت/)[0]
    expect(note.querySelector('bdi')).toHaveAttribute('dir', 'ltr'); expect(note).toHaveTextContent('Europe/Amsterdam')
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

const conflictBody = (over: Record<string, unknown> = {}) => ({ message: 'The given data was invalid.', errors: { starts_at: ['That time overlaps another item.'] }, conflict: { code: 'schedule_conflict', requested: { starts_at: '2026-11-13T08:00:00Z', ends_at: '2026-11-13T08:30:00Z' },
  conflicts: [{ id: 3, event_id: 3, task_id: 8, title: 'Write report', kind: 'task_session', source: 'lifeos', starts_at: '2026-11-13T07:45:00Z', ends_at: '2026-11-13T08:15:00Z', overlap_minutes: 15 }], suggestion: { starts_at: '2026-11-13T08:15:00Z', ends_at: '2026-11-13T08:45:00Z' }, ...over } })
const suggestedTime = async () => fireEvent.click((await screen.findAllByRole('button', { name: /Suggested times/ }))[0])   // fills start and end: 13 Nov 09:00 to 09:30
const putCalls = (calls: Call[]) => calls.filter(c => c.method === 'PUT')
const postCalls = (calls: Call[]) => calls.filter(c => c.method === 'POST')
const formError = () => document.querySelector('p.error')
const saveButton = () => screen.getByRole('button', { name: 'Save' })

describe('the scheduled execution time, apart from the deadline and the estimate', () => {
  const booked = (over: Record<string, unknown> = {}) => task({ schedule: session(), due_at: '2026-11-20T15:00:00Z', ...over })
  it('is shown for an unscheduled task too, saying it is not scheduled yet', () => {
    server(); open(task())
    const block = screen.getByRole('region', { name: 'Scheduled execution time' })
    expect(block).toHaveTextContent('Not scheduled yet'); expect(within(block).queryByRole('link')).toBeNull()
  })
  it('shows the session time in the account zone, a calendar link, and says that the deadline alone does not move it', () => {
    server(); open(booked())
    const block = screen.getByRole('region', { name: 'Scheduled execution time' })
    expect(block.textContent).toMatch(/09:00/)   // 08:00Z is 09:00 in Amsterdam
    expect(within(block).getByRole('link', { name: 'View in calendar' })).toHaveAttribute('href', '/calendar?date=2026-11-12&session=55')
    expect(within(block).getByText(/does not move the session/)).toBeInTheDocument()
    expect(block).toHaveTextContent(/remove the session, use the calendar or Undo/)
  })
  it('warns calmly when the deadline is before the session ends, and stops when it is later', () => {
    server(); open(booked({ due_at: '2026-11-12T08:00:00Z' }))
    expect(screen.getByText('The scheduled session is after the deadline.')).toBeInTheDocument()
    fireEvent.click(tile('Tomorrow'))   // keeps 09:00; the session ends 09:30
    expect(screen.getByText('The scheduled session is after the deadline.')).toBeInTheDocument()
    fireEvent.click(tile('This week'))
    expect(screen.queryByText('The scheduled session is after the deadline.')).toBeNull()
  })
  it('changing only the deadline never touches the session: one PATCH, no PUT, no POST', async () => {
    const calls = server(); const { onClose } = open(booked())
    fireEvent.click(tile('Tomorrow')); fireEvent.click(saveButton())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(patchBody(calls)).toHaveLength(1); expect(putCalls(calls)).toHaveLength(0); expect(postCalls(calls)).toHaveLength(0)
  })
  it('a scheduled task: the new start and end are saved with Save as ONE PUT on the same session (then the task fields), refreshes once, success only after both', async () => {
    const calls = server(); const { onSave, onClose } = open(booked())
    const tasks = vi.fn(), cal = vi.fn()
    window.addEventListener(TASKS_CHANGED, tasks); window.addEventListener(CALENDAR_CHANGED, cal)
    await suggestedTime()
    const save = saveButton(); fireEvent.click(save); fireEvent.click(save)   // a double click
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(putCalls(calls)).toHaveLength(1); expect(postCalls(calls)).toHaveLength(0); expect(patchBody(calls)).toHaveLength(1)
    expect(putCalls(calls)[0].body).toEqual({ session_id: 55, starts_at: '2026-11-13T08:00:00.000Z', ends_at: '2026-11-13T08:30:00.000Z' })
    expect(patchBody(calls)[0]).not.toHaveProperty('due_at')   // the deadline is unchanged by moving the session
    expect(onSave).toHaveBeenCalledTimes(1); expect(tasks).toHaveBeenCalledTimes(1); expect(cal).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Changes saved.')
    window.removeEventListener(TASKS_CHANGED, tasks); window.removeEventListener(CALENDAR_CHANGED, cal)
  })
  it('an unscheduled task: filling the time books ONE new session with POST and an Idempotency-Key (never PUT)', async () => {
    const calls = server(); const { onClose } = open(task())
    await suggestedTime(); fireEvent.click(saveButton())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(postCalls(calls)).toHaveLength(1); expect(putCalls(calls)).toHaveLength(0)
    expect(postCalls(calls)[0].key).toMatch(/^[0-9a-f-]{36}$/)
    expect(postCalls(calls)[0].body).toEqual({ starts_at: '2026-11-13T08:00:00.000Z', ends_at: '2026-11-13T08:30:00.000Z' })
  })
  it('a retry after a dropped connection reuses the Idempotency-Key (so it cannot book twice)', async () => {
    let n = 0; const calls: Call[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method || 'GET'
      calls.push({ method, url: String(url), key: (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'] })
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
      if (method === 'POST' && /schedule$/.test(String(url))) { if (n++ === 0) throw new TypeError('Failed to fetch'); return json(201, { data: { id: 91 }, schedule: session({ session_id: 91 }) }) }
      if (/availability/.test(String(url))) return json(200, free)
      if (method === 'PATCH') return json(200, { data: { id: 7 } })
      return json(200, { data: [], meta: { last_page: 1 } })
    }))
    const { onClose } = open(task())
    await suggestedTime(); fireEvent.click(saveButton())
    await waitFor(() => expect(formError()).toHaveTextContent('Could not reach LifeOS'))
    fireEvent.click(saveButton())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const posts = postCalls(calls); expect(posts).toHaveLength(2); expect(posts[0].key).toBe(posts[1].key); expect(posts[0].key).toBeTruthy()
  })
  it('a failed session save is not a success: no task save, no message, the dialog stays open with the error', async () => {
    const calls = server({ put: () => ({ status: 500, body: { message: 'Server error.' } }) }); const { onSave, onClose } = open(booked())
    await suggestedTime(); fireEvent.click(saveButton())
    await waitFor(() => expect(formError()).toHaveTextContent('Server error.'))
    expect(patchBody(calls)).toHaveLength(0); expect(onSave).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Changes saved.'); expect(document.body.textContent).not.toContain('moved to')
  })
  it('the session saved but the task fields failed: it says exactly that, nothing is marked saved, and a retry does not move the session again', async () => {
    const calls = server({ patch: () => ({ status: 500, body: { message: 'Could not save.' } }) }); const { onSave, onClose } = open(booked())
    await suggestedTime(); fireEvent.click(saveButton())
    await waitFor(() => expect(formError()).toHaveTextContent(/The scheduled time was saved, but the other changes were not: Could not save\./))
    expect(onSave).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain('Changes saved.')
    fireEvent.click(saveButton())
    await waitFor(() => expect(patchBody(calls)).toHaveLength(2))
    expect(putCalls(calls)).toHaveLength(1)   // the fields already show the saved time: untouched, so nothing is sent for it
  })
  describe('a taken time', () => {
    it('keeps the dialog open, saves nothing, and opens the conflict dialog with the sentence, the 24-hour times and the overlap', async () => {
      const calls = server({ put: () => ({ status: 422, body: conflictBody() }) }); const { onSave, onClose } = open(booked())
      const cal = vi.fn(); window.addEventListener(CALENDAR_CHANGED, cal)
      await suggestedTime(); fireEvent.click(saveButton())
      const dialog = await screen.findByRole('alertdialog')
      expect(within(dialog).getByRole('heading')).toHaveTextContent('This time is already booked for another task.')
      expect(dialog).toHaveTextContent("You can't schedule this task from 09:00 to 09:30, because you already have another task from 08:45 to 09:15.")
      expect(dialog).toHaveTextContent('Write report'); expect(dialog).toHaveTextContent('15 min overlap')
      expect(within(dialog).getByRole('link', { name: 'View the conflicting item' })).toHaveAttribute('href', '/calendar?date=2026-11-13&session=3')
      expect(patchBody(calls)).toHaveLength(0); expect(onSave).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled()
      expect(document.body.textContent).not.toContain('Changes saved.')
      expect(cal).toHaveBeenCalled()   // the task is read again, so the row shows the real state
      window.removeEventListener(CALENDAR_CHANGED, cal)
    })
    it('"Choose another time" closes it and puts focus on the start field', async () => {
      server({ put: () => ({ status: 422, body: conflictBody() }) }); open(booked())
      await suggestedTime(); fireEvent.click(saveButton())
      fireEvent.click(await screen.findByRole('button', { name: 'Choose another time' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(document.querySelector('.rf-session-edit .dtp-trigger')))
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    })
    it('Escape closes only the conflict dialog; focus goes back to Save; the edit dialog stays', async () => {
      server({ put: () => ({ status: 422, body: conflictBody() }) }); const { onClose } = open(booked())
      await suggestedTime(); saveButton().focus(); fireEvent.click(saveButton())
      const dialog = await screen.findByRole('alertdialog')
      fireEvent(dialog, new Event('cancel', { cancelable: true }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      expect(onClose).not.toHaveBeenCalled(); await waitFor(() => expect(saveButton()).toHaveFocus())
    })
    it('the first free time is applied once through the same path: one more PUT with the suggested slot, then the task fields, then closed', async () => {
      let n = 0
      const calls = server({ put: () => (n++ === 0 ? { status: 422, body: conflictBody() } : { status: 200, body: { data: { id: 55 }, schedule: session({ starts_at: '2026-11-13T08:15:00Z', ends_at: '2026-11-13T08:45:00Z' }) } }) })
      const { onClose } = open(booked())
      await suggestedTime(); fireEvent.click(saveButton())
      const button = await screen.findByRole('button', { name: /Suggest the first free time: 09:15–09:45/ })
      fireEvent.click(button); fireEvent.click(button)
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
      expect(putCalls(calls)).toHaveLength(2)
      expect(putCalls(calls)[1].body).toEqual({ session_id: 55, starts_at: '2026-11-13T08:15:00Z', ends_at: '2026-11-13T08:45:00Z' })
      expect(patchBody(calls)).toHaveLength(1)
    })
    it('hides the suggestion button when the server has none', async () => {
      server({ put: () => ({ status: 422, body: conflictBody({ suggestion: null }) }) }); open(booked())
      await suggestedTime(); fireEvent.click(saveButton())
      await screen.findByRole('alertdialog'); expect(screen.queryByRole('button', { name: /Suggest the first free time/ })).toBeNull()
    })
  })
  it('speaks Arabic and Dutch, and keeps the deadline, the scheduled time and the estimate apart', () => {
    localStorage.setItem('lifeos-language', 'ar'); server(); open(booked({ due_at: '2026-11-12T08:00:00Z' }))
    expect(screen.getByText('موعد التنفيذ المجدول')).toBeInTheDocument()
    expect(screen.getByText('الجلسة المجدولة بعد الموعد النهائي.')).toBeInTheDocument()
    expect(screen.getByText('الموعد النهائي (الاستحقاق)')).toBeInTheDocument()
    expect(screen.getAllByText('المدة المتوقعة (دقائق)').length).toBeGreaterThan(0)
    cleanup(); localStorage.setItem('lifeos-language', 'nl'); server(); open(booked())
    expect(screen.getByText('Geplande uitvoeringstijd')).toBeInTheDocument()
    expect(screen.getByText('Deadline (uiterste datum)')).toBeInTheDocument()
    expect(screen.getAllByText('Geschatte duur (minuten)').length).toBeGreaterThan(0)
    cleanup(); localStorage.setItem('lifeos-language', 'en'); server(); open(booked())
    expect(screen.getByText('Scheduled execution time')).toBeInTheDocument(); expect(screen.getByText('Deadline (due)')).toBeInTheDocument(); expect(screen.getAllByText('Estimate (minutes)').length).toBeGreaterThan(0)
  })
})
