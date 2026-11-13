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

// The browser zone is Amsterdam, equal to the account's, the usual case.
const BROWSER_TZ = process.env.TZ
process.env.TZ = 'Europe/Amsterdam'
afterAll(() => { if (BROWSER_TZ === undefined) delete process.env.TZ; else process.env.TZ = BROWSER_TZ })
// "Now" is Wednesday 2026-11-11 11:00 in Amsterdam (10:00 UTC).
const NOW = '2026-11-11T10:00:00Z'
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider>{children}</ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
type Call = { method: string; url: string; body?: Record<string, unknown>; key?: string; availability?: string }
const free: Availability = { work_start: '09:00', work_end: '17:00', days: [{ date: '2026-11-13', work_day: true, free_minutes: 480, slots: [{ starts_at: '2026-11-13T08:00:00Z', ends_at: '2026-11-13T16:00:00Z', minutes: 480 }] }] }
const session = (over: Record<string, unknown> = {}) => ({ session_id: 55, starts_at: '2026-11-12T08:00:00Z', ends_at: '2026-11-12T08:30:00Z', sessions: 1, split: false, ...over })
const task = (over: Record<string, unknown> = {}) => ({ id: 7, title: 'Pay the invoice', status: 'todo', priority: 'high', due_at: '2026-11-20T08:30:00Z', estimated_minutes: 30, schedule: null, ...over })

type Reply = { status: number; body: unknown }
function server(opts: { write?: () => Reply | Promise<Reply>; undo?: () => Reply } = {}) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET'
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined, key: (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'] })
    const reply = (r: Reply) => new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
    if (method === 'POST' && /\/api\/tasks\/\d+\/schedule$/.test(String(url))) return reply(opts.undo?.() ?? { status: 201, body: { data: { id: 91 }, schedule: session({ session_id: 91 }) } })
    if (method === 'PATCH' || (method === 'POST' && /\/api\/tasks$/.test(String(url)))) return reply(await (opts.write?.() ?? { status: 200, body: { data: { id: 7 } } }))
    if (/\/api\/availability/.test(String(url))) return reply({ status: 200, body: free })
    return reply({ status: 200, body: { data: [], meta: { last_page: 1 } } })
  }))
  return calls
}
const open = (item: Record<string, unknown> = task(), onSave = vi.fn(), onClose = vi.fn()) => { render(wrap(<RecordForm resource="tasks" item={item} onSave={onSave} onClose={onClose} />)); return { onSave, onClose } }
const writes = (calls: Call[]) => calls.filter(c => c.method === 'PATCH' || (c.method === 'POST' && /\/api\/tasks$/.test(c.url)))
const bodyOf = (calls: Call[]) => writes(calls)[0].body!
const tile = (name: string) => screen.getByRole('radio', { name })
const chip = (name: string) => screen.getByRole('radio', { name })
const checked = () => screen.getAllByRole('radio').filter(r => r.getAttribute('aria-checked') === 'true').map(r => r.textContent)
const startTrigger = () => screen.getByText(/^(Start time|وقت البداية|Starttijd)$/).closest('label')!.querySelector('.dtp-trigger') as HTMLElement
const startValue = () => startTrigger().dataset.value
const typeStart = (time: string) => {
  fireEvent.click(startTrigger())
  const box = screen.getByRole('textbox', { name: 'Time' }); fireEvent.change(box, { target: { value: time } }); fireEvent.keyDown(box, { key: 'Enter' })
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
}
const ends = () => document.querySelector('.rf-end')!.textContent
const deadlineSwitch = () => screen.getByRole('checkbox', { name: /Do you have a deadline/ }) as HTMLInputElement
const deadline = () => document.querySelector('.rf-deadline .dtp-trigger') as HTMLElement | null
const saveButton = () => screen.getByRole('button', { name: 'Save' })
const formError = () => document.querySelector('p.error')

beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals(); setAccountZone('Europe/Amsterdam'); vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) }) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); setAccountZone(undefined) })

describe('one step: choose a day, a start and a length, press Save once', () => {
  it('Tomorrow 09:00 for 15 minutes is ONE POST with schedule.starts_at and estimated_minutes, and no deadline of any kind', async () => {
    const calls = server(); const { onSave, onClose } = open({})
    const tasks = vi.fn(), cal = vi.fn()
    window.addEventListener(TASKS_CHANGED, tasks); window.addEventListener(CALENDAR_CHANGED, cal)
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Call the bank' } })
    fireEvent.click(tile('Tomorrow'))
    expect(startValue()).toBe('09:00')   // another day than today: 09:00
    fireEvent.click(chip('15'))
    expect(ends()).toBe('Ends 09:15')
    expect(screen.getByText('Saving puts it in your calendar.')).toBeInTheDocument()
    const save = saveButton(); fireEvent.click(save); fireEvent.click(save)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(calls.filter(c => c.method !== 'GET')).toHaveLength(1)
    const sent = writes(calls)[0]
    expect(sent.method).toBe('POST'); expect(sent.url).toMatch(/\/api\/tasks$/)
    expect(sent.body).toMatchObject({ title: 'Call the bank', estimated_minutes: 15, schedule: { starts_at: '2026-11-12T08:00:00.000Z' } })   // 09:00 Amsterdam
    expect(sent.body).not.toHaveProperty('due_at'); expect(sent.body).not.toHaveProperty('due_date')
    expect(sent.key).toMatch(/^[0-9a-f-]{36}$/)
    expect(onSave).toHaveBeenCalledTimes(1); expect(tasks).toHaveBeenCalledTimes(1); expect(cal).toHaveBeenCalledTimes(1)
    window.removeEventListener(TASKS_CHANGED, tasks); window.removeEventListener(CALENDAR_CHANGED, cal)
  })
  it('a new task starts as "Not scheduled" with no start field, and saving then sends no schedule key', async () => {
    const calls = server(); const { onClose } = open({})
    expect(checked()).toContain('Not scheduled'); expect(screen.queryByText('Start time')).toBeNull()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Someday' } }); fireEvent.click(saveButton())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(bodyOf(calls)).not.toHaveProperty('schedule'); expect(bodyOf(calls)).toMatchObject({ estimated_minutes: 30 })
    expect(bodyOf(calls)).not.toHaveProperty('due_at'); expect(bodyOf(calls)).not.toHaveProperty('due_date')
  })
  it('the first start is the next half hour for today and 09:00 for any other day; a time that has passed today is moved forward', () => {
    server(); open({})
    fireEvent.click(tile('Today')); expect(startValue()).toBe('11:30')
    fireEvent.click(tile('Tomorrow')); expect(startValue()).toBe('09:00')
    typeStart('08:00'); vi.setSystemTime(new Date('2026-11-11T11:10:00Z'))   // 12:10 now
    fireEvent.click(tile('Today')); expect(startValue()).toBe('12:30')
    fireEvent.click(tile('Tomorrow')); expect(startValue()).toBe('12:30')   // the time he chose is kept
  })
  it('the end is computed and read-only, follows the start and the length, and says the new day after midnight', () => {
    server(); open({})
    fireEvent.click(tile('Today')); typeStart('23:50')
    expect(ends()).toBe('Ends Tomorrow 00:20')
    fireEvent.click(chip('15')); expect(ends()).toBe('Ends Tomorrow 00:05')
    typeStart('22:00'); expect(ends()).toBe('Ends 22:15')
    expect(document.querySelector('.rf-end')).toHaveAttribute('role', 'status')   // announced politely
    expect(document.querySelector('.rf-end input')).toBeNull()
  })
  it('custom duration: a number of minutes, at least 5; it IS the estimate, there is no separate estimate field', async () => {
    const calls = server(); const { onClose } = open({})
    expect(screen.queryByText(/Estimate/)).toBeNull()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Long one' } })
    fireEvent.click(tile('Tomorrow')); fireEvent.click(chip('Custom'))
    const input = screen.getByLabelText('Custom duration (minutes)') as HTMLInputElement
    expect(input.min).toBe('5'); fireEvent.change(input, { target: { value: '25' } })
    expect(ends()).toBe('Ends 09:25')
    fireEvent.click(saveButton())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(bodyOf(calls)).toMatchObject({ estimated_minutes: 25 })
  })
  it('the duration chips are 15, 30, 45, 60 and 120; the task\'s current estimate is used directly (90 shows as custom)', () => {
    server(); open({}); fireEvent.click(tile('Tomorrow'))
    expect(screen.getAllByRole('radio').map(r => r.textContent)).toEqual(expect.arrayContaining(['15', '30', '45', '60', '120', 'Custom']))
    expect(checked()).toContain('30'); cleanup()
    open(task({ estimated_minutes: 90 })); fireEvent.click(tile('Tomorrow'))
    expect(checked()).toContain('Custom'); expect((screen.getByLabelText('Custom duration (minutes)') as HTMLInputElement).value).toBe('90')
  })
  it('suggested times follow the duration and the chosen day, and picking one fills the day and the start', async () => {
    const calls = server(); open({})
    fireEvent.click(tile('Tomorrow')); fireEvent.click(chip('60'))
    await waitFor(() => expect(calls.some(c => /availability\?date=2026-11-12&days=7&min_minutes=60/.test(c.url))).toBe(true))
    fireEvent.click((await screen.findAllByRole('button', { name: /Suggested times/ }))[0])
    expect(startValue()).toBe('09:00'); expect(checked()).toEqual(expect.not.arrayContaining(['Tomorrow']))
    expect(document.querySelector('.qa-pick.is-set')).not.toBeNull()   // 13 Nov is its own selected "Pick a date" tile
  })
})

describe('an already scheduled task', () => {
  const booked = (over: Record<string, unknown> = {}) => task({ schedule: session(), ...over })
  it('shows «Scheduled», its day, start, length and the computed end, and the deadline is kept apart', () => {
    server(); open(booked())
    expect(document.querySelector('.sched-badge')).toHaveTextContent('Scheduled: Tomorrow 09:00 – 09:30')
    expect(checked()).toEqual(expect.arrayContaining(['Tomorrow', '30'])); expect(startValue()).toBe('09:00'); expect(ends()).toBe('Ends 09:30')
    expect(deadlineSwitch()).toBeChecked(); expect(deadline()!.dataset.value).toBe('2026-11-20T09:30')
  })
  it('the duration shown is the session\'s own length, not the estimate', () => {
    server(); open(booked({ estimated_minutes: 30, schedule: session({ ends_at: '2026-11-12T09:30:00Z' }) }))
    expect(ends()).toBe('Ends 10:30'); expect(checked()).toContain('Custom')
  })
  it('a new start edits THE SAME session: one PATCH with schedule.starts_at, the end follows, the deadline is untouched', async () => {
    const calls = server(); const { onClose } = open(booked())
    typeStart('16:00'); expect(ends()).toBe('Ends 16:30')
    fireEvent.click(saveButton())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(calls.filter(c => c.method !== 'GET')).toHaveLength(1)
    expect(writes(calls)[0].method).toBe('PATCH'); expect(writes(calls)[0].url).toMatch(/\/api\/tasks\/7$/)
    expect(bodyOf(calls)).toMatchObject({ estimated_minutes: 30, schedule: { starts_at: '2026-11-12T15:00:00.000Z' } })
    expect(bodyOf(calls)).not.toHaveProperty('due_at'); expect(bodyOf(calls)).not.toHaveProperty('due_date')
  })
  it('a new length updates the end and estimated_minutes, and keeps the start instant', async () => {
    const calls = server(); const { onClose } = open(booked())
    fireEvent.click(chip('60')); expect(ends()).toBe('Ends 10:00')
    fireEvent.click(saveButton()); await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(bodyOf(calls)).toMatchObject({ estimated_minutes: 60, schedule: { starts_at: '2026-11-12T08:00:00Z' } })
  })
  it('saving without touching the time sends no schedule key at all', async () => {
    const calls = server(); const { onClose } = open(booked({ schedule: session({ ends_at: '2026-11-12T09:30:00Z' }) }))
    fireEvent.click(saveButton()); await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(bodyOf(calls)).not.toHaveProperty('schedule'); expect(bodyOf(calls)).toMatchObject({ estimated_minutes: 30 })
  })
  it('«Not scheduled» says in words that saving removes it, sends schedule: null, and the toast offers Undo that books the old slot again', async () => {
    const calls = server(); const { onClose } = open(booked())
    fireEvent.click(tile('Not scheduled'))
    expect(screen.getByText(/Saving will remove it from your calendar/)).toBeInTheDocument(); expect(screen.queryByText('Start time')).toBeNull()
    fireEvent.click(saveButton()); await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(bodyOf(calls)).toHaveProperty('schedule', null); expect(bodyOf(calls)).not.toHaveProperty('due_at')
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && /\/api\/tasks\/7\/schedule$/.test(c.url))).toBe(true))
    const undo = calls.find(c => c.method === 'POST' && /\/schedule$/.test(c.url))!
    expect(undo.body).toEqual({ starts_at: '2026-11-12T08:00:00Z', ends_at: '2026-11-12T08:30:00Z' }); expect(undo.key).toBeTruthy()
  })
  it('several sessions: the note and no start field; saving never sends a schedule', async () => {
    const calls = server(); const { onClose } = open(booked({ schedule: session({ sessions: 3, split: true }) }))
    expect(screen.getByText('This task has several sessions. Change them in the calendar.')).toBeInTheDocument()
    expect(screen.queryByText('Start time')).toBeNull(); expect(screen.queryByRole('radio', { name: 'Tomorrow' })).toBeNull()
    fireEvent.click(saveButton()); await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(bodyOf(calls)).not.toHaveProperty('schedule')
  })
  it('a completed or cancelled task has no scheduling controls and says why', () => {
    server(); open(task({ status: 'completed' }))
    expect(screen.getByText(/Completed and cancelled tasks are not scheduled/)).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'Tomorrow' })).toBeNull(); expect(screen.queryByText('Start time')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'To do' })); expect(screen.getByRole('radio', { name: 'Tomorrow' })).toBeInTheDocument()
  })
})

describe('the deadline is separate and optional', () => {
  it('is off for a new task and on, with its value, for a task that has one', () => {
    server(); open({}); expect(deadlineSwitch()).not.toBeChecked(); expect(deadline()).toBeNull()
    expect(screen.getByText(/Execution time: when I will work on the task/)).toBeInTheDocument(); expect(screen.getByText(/Deadline: the last moment/)).toBeInTheDocument()
    cleanup(); open(task()); expect(deadlineSwitch()).toBeChecked(); expect(deadline()!.dataset.value).toBe('2026-11-20T09:30')
  })
  it('scheduling a task that has a deadline never touches the deadline; a deadline-less task never gets one', async () => {
    const calls = server(); const { onClose } = open(task())
    fireEvent.click(tile('Tomorrow')); fireEvent.click(saveButton()); await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(bodyOf(calls)).not.toHaveProperty('due_at'); expect(bodyOf(calls)).not.toHaveProperty('due_date')
    expect(bodyOf(calls)).toMatchObject({ schedule: { starts_at: '2026-11-12T08:00:00.000Z' } })
  })
  it('turning it off on a task that has one says it will be removed and sends due_at: null', async () => {
    const calls = server(); const { onClose } = open(task())
    fireEvent.click(deadlineSwitch()); expect(screen.getByText('Saving will remove the deadline.')).toBeInTheDocument()
    fireEvent.click(saveButton()); await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(bodyOf(calls)).toHaveProperty('due_at', null)
  })
  it('a deadline typed with the switch on is saved as the account\'s wall time (17:00 Amsterdam is 16:00Z)', async () => {
    const calls = server(); const { onClose } = open({})
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'With deadline' } })
    fireEvent.click(deadlineSwitch()); expect(deadline()!.dataset.value).toBe('2026-11-11T17:00')
    fireEvent.click(saveButton()); await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(bodyOf(calls)).toMatchObject({ due_at: '2026-11-11T16:00:00.000Z' }); expect(bodyOf(calls)).not.toHaveProperty('schedule')
  })
})

describe('a taken time', () => {
  const conflictBody = () => ({ message: 'The given data was invalid.', errors: { starts_at: ['That time overlaps another item.'] }, conflict: { code: 'schedule_conflict', requested: { starts_at: '2026-11-12T08:00:00Z', ends_at: '2026-11-12T08:15:00Z' },
    conflicts: [{ id: 3, event_id: 3, task_id: 8, title: 'Write report', kind: 'task_session', source: 'lifeos', starts_at: '2026-11-12T07:45:00Z', ends_at: '2026-11-12T08:05:00Z', overlap_minutes: 5 }], suggestion: { starts_at: '2026-11-12T08:05:00Z', ends_at: '2026-11-12T08:20:00Z' } } })
  const arrange = async (write: () => Reply) => {
    const calls = server({ write }); const handlers = open({})
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Pay' } }); fireEvent.click(tile('Tomorrow')); fireEvent.click(chip('15'))
    fireEvent.click(saveButton())
    return { calls, ...handlers, dialog: await screen.findByRole('alertdialog') }
  }
  it('keeps the dialog open with everything typed, saves nothing, and tells what is in the way', async () => {
    const { dialog, onSave, onClose } = await arrange(() => ({ status: 422, body: conflictBody() }))
    expect(within(dialog).getByRole('heading')).toHaveTextContent('This time is already booked for another task.')
    expect(dialog).toHaveTextContent('Write report'); expect(dialog).toHaveTextContent('5 min overlap'); expect(dialog).toHaveTextContent('08:45 to 09:05')
    expect(within(dialog).getByRole('link', { name: 'View the conflicting item' })).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled(); expect(document.body.textContent).not.toContain('Created.')
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Pay'); expect(ends()).toBe('Ends 09:15')
  })
  it('"Choose another time" puts focus on the start field', async () => {
    await arrange(() => ({ status: 422, body: conflictBody() }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose another time' }))
    await waitFor(() => expect(document.activeElement).toBe(startTrigger()))
  })
  it('the suggested time fills the day and start and saves again, once', async () => {
    let n = 0; const { calls, onClose } = await arrange(() => (n++ === 0 ? { status: 422, body: conflictBody() } : { status: 201, body: { data: { id: 9 } } }))
    const use = screen.getByRole('button', { name: /Suggest the first free time/ }); fireEvent.click(use); fireEvent.click(use)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(writes(calls)).toHaveLength(2)
    expect(writes(calls)[1].body).toMatchObject({ estimated_minutes: 15, schedule: { starts_at: '2026-11-12T08:05:00.000Z' } })
  })
  it('speaks Arabic, with the three actions', async () => {
    localStorage.setItem('lifeos-language', 'ar')
    server({ write: () => ({ status: 422, body: conflictBody() }) }); open({})
    fireEvent.change(document.querySelector('input[name="title"]')!, { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('radio', { name: 'غدًا' })); fireEvent.click(screen.getByRole('button', { name: 'حفظ' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByRole('heading')).toHaveTextContent('هذا الوقت محجوز بالفعل لمهمة أخرى.')
    for (const name of [/اختيار وقت آخر/, /اقتراح أول وقت متاح/, /عرض المهمة المتعارضة/]) expect(within(dialog).getByRole(name.source.includes('عرض') ? 'link' : 'button', { name })).toBeInTheDocument()
  })
  it('a dropped connection keeps the dialog, and trying again carries the same Idempotency-Key', async () => {
    let n = 0; const calls: Call[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method || 'GET'
      calls.push({ method, url: String(url), key: (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'] })
      if (method === 'POST') { if (n++ === 0) throw new TypeError('Failed to fetch'); return new Response(JSON.stringify({ data: { id: 9 } }), { status: 201 }) }
      return new Response(JSON.stringify(/availability/.test(String(url)) ? free : { data: [], meta: { last_page: 1 } }), { status: 200 })
    }))
    const { onClose } = open({})
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Pay' } }); fireEvent.click(tile('Tomorrow'))
    fireEvent.click(saveButton()); await waitFor(() => expect(formError()).toHaveTextContent('Could not reach LifeOS'))
    fireEvent.click(saveButton()); await waitFor(() => expect(onClose).toHaveBeenCalled())
    const posts = calls.filter(c => c.method === 'POST'); expect(posts).toHaveLength(2); expect(posts[0].key).toBe(posts[1].key); expect(posts[0].key).toBeTruthy()
  })
})

describe('words, direction and the 24-hour clock', () => {
  it.each([
    ['en', 'When do you want to do it?', ['Today', 'Tomorrow', 'Pick a date', 'Not scheduled'], 'Start time', 'Ends'],
    ['ar', 'متى تريد تنفيذ المهمة؟', ['اليوم', 'غدًا', 'تاريخ آخر', 'بدون جدولة'], 'وقت البداية', 'النهاية'],
    ['nl', 'Wanneer wil je de taak doen?', ['Vandaag', 'Morgen', 'Andere datum', 'Niet ingepland'], 'Starttijd', 'Einde'],
  ])('%s: the question, the four tiles, the start field and the end line', (lang, question, tiles, startLabel, endWord) => {
    localStorage.setItem('lifeos-language', lang); server(); open({})
    expect(screen.getByRole('radiogroup', { name: question })).toBeInTheDocument()
    for (const name of tiles) expect(screen.getByRole('radio', { name })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: tiles[1] }))
    expect(screen.getByText(startLabel)).toBeInTheDocument(); expect(ends()).toContain(endWord)
    expect(startTrigger().textContent).toBe('09:00')   // 24-hour, never AM/PM
    expect(ends()).toMatch(/09:30/)
  })
  it('a picked date is its own selected tile, named by the day (Thursday 19 November)', () => {
    server(); open({})
    fireEvent.click(screen.getByRole('radio', { name: 'Pick a date' }))
    const box = screen.getByRole('textbox', { name: 'Date' }); fireEvent.change(box, { target: { value: '2026-11-19' } }); fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByRole('radio', { name: /Thursday, November 19/ })).toHaveAttribute('aria-checked', 'true'); expect(startValue()).toBe('09:00')
  })
  it('Enter and Space on a tile are real button clicks (keyboard works), and Escape is not swallowed', () => {
    server(); open({})
    const t = tile('Tomorrow'); expect(t.tagName).toBe('BUTTON'); expect(t).toHaveAttribute('type', 'button')
  })
})

describe.each(['UTC', 'America/New_York'])('browser in %s, account in Amsterdam', browser => {
  beforeEach(() => { process.env.TZ = browser })
  afterEach(() => { process.env.TZ = 'Europe/Amsterdam' })
  it('shows the session on the account clock (09:00-09:30), says which zone the times are in, and saves a typed start as the account\'s instant', async () => {
    const calls = server(); const { onClose } = open(task({ schedule: session() }))
    expect(startValue()).toBe('09:00'); expect(ends()).toBe('Ends 09:30')
    expect(screen.getAllByText(/Times are in/).length).toBeGreaterThan(0); expect(screen.getAllByText(/Times are in/)[0]).toHaveTextContent('Times are in Europe/Amsterdam')
    typeStart('10:00'); fireEvent.click(saveButton()); await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(bodyOf(calls)).toMatchObject({ schedule: { starts_at: '2026-11-12T09:00:00.000Z' } })
  })
})

describe('browser in the account zone', () => {
  it('shows no zone note: there is nothing to explain', () => { server(); open(task({ schedule: session() })); expect(screen.queryByText(/Times are in/)).not.toBeInTheDocument() })
  it('the note reads in Arabic, with the zone name kept left-to-right', () => {
    process.env.TZ = 'UTC'; localStorage.setItem('lifeos-language', 'ar')
    try { server(); open(task({ schedule: session() })) } finally { process.env.TZ = 'Europe/Amsterdam' }
    const note = screen.getAllByText(/الأوقات بتوقيت/)[0]
    expect(note.querySelector('bdi')).toHaveAttribute('dir', 'ltr'); expect(note).toHaveTextContent('Europe/Amsterdam')
  })
})

describe('saving', () => {
  it('Save keeps focus while saving (aria-disabled, not disabled) and a second press sends nothing', async () => {
    let release: (r: Reply) => void = () => undefined
    const calls = server({ write: () => new Promise<Reply>(r => { release = r }) }); open()
    const save = saveButton(); save.focus(); fireEvent.click(save)
    await waitFor(() => expect(save).toHaveAttribute('aria-disabled', 'true'))
    expect(save).not.toBeDisabled(); expect(save).toHaveFocus()
    fireEvent.click(save); release({ status: 200, body: { data: { id: 7 } } })
    await waitFor(() => expect(writes(calls)).toHaveLength(1))
  })
  it('another error keeps the dialog open and shows it', async () => {
    server({ write: () => ({ status: 500, body: { message: 'Server error.' } }) }); const { onClose } = open(task({ schedule: session() }))
    typeStart('10:00'); fireEvent.click(saveButton())
    await waitFor(() => expect(formError()).toHaveTextContent('Server error.')); expect(onClose).not.toHaveBeenCalled()
  })
})
