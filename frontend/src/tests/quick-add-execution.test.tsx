import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import QuickAdd from '../components/layout/QuickAdd'
import { setAccountZone } from '../lib/accountDay'
import { CALENDAR_CHANGED } from '../lib/taskSchedule'
import { openQuickAdd, TASKS_CHANGED } from '../lib/quickAdd'
import { pendingItems, sendPending, setOfflineOwner, createTaskOrQueue, openSync } from '../lib/offline'
import OfflineSync from '../components/layout/OfflineSync'

/**
 * Quick Add uses the dialog's model: the day tiles say WHEN TO DO IT (a calendar session), never a deadline, and nothing is scheduled by
 * default. The account is in Auckland (UTC+13 in November) while the browser is not, so every time here is the account's wall clock.
 */
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider>{children}</ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
// 23:00 on 11 Nov in Auckland (10:00Z): today's next half hour is 23:30, tomorrow is the 12th.
const NOW = new Date('2026-11-11T10:00:00Z')
type Call = { url: string; method: string; headers: Record<string, string>; body?: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any

const conflictBody = (over: Record<string, unknown> = {}) => ({
  message: 'This time is already booked.',
  conflict: { code: 'schedule_conflict', requested: { starts_at: '2026-11-11T20:00:00Z', ends_at: '2026-11-11T20:30:00Z' },
    conflicts: [{ id: 3, event_id: 3, task_id: 8, title: 'Write report', kind: 'task_session', source: 'lifeos', starts_at: '2026-11-11T19:45:00Z', ends_at: '2026-11-11T20:15:00Z', overlap_minutes: 15 }],
    suggestion: { starts_at: '2026-11-11T20:15:00Z', ends_at: '2026-11-11T20:45:00Z' }, ...over },
})
let calls: Call[], post: (call: Call) => { status: number; body: unknown; delay?: number }
function server() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET', call: Call = { url: String(url), method, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(init.body as string) : undefined }
    calls.push(call)
    if (/\/api\/assistant\/status/.test(call.url)) return new Response(JSON.stringify({ voice_allowed: false }), { status: 200 })
    if (/\/api\/tasks$/.test(call.url) && method === 'POST') {
      const r = post(call); if (r.delay) await new Promise(res => setTimeout(res, r.delay))
      return new Response(JSON.stringify(r.body), { status: r.status })
    }
    return new Response(JSON.stringify({ data: [], meta: { last_page: 1 } }), { status: 200 })
  }))
}
const posts = () => calls.filter(c => c.method === 'POST' && /\/api\/tasks$/.test(c.url))
const ok = () => ({ status: 201, body: { data: { id: 5 } } })

async function open(language = 'en') {
  localStorage.setItem('lifeos-language', language)
  render(wrap(<QuickAdd />)); act(() => openQuickAdd())
  return screen.findByRole('textbox', { name: language === 'ar' ? 'المهمة' : 'Task' })
}
const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } })
const add = () => fireEvent.click(screen.getByRole('button', { name: /^(Add task|إضافة المهمة)$/ }))
const tile = (name: string | RegExp) => screen.getByRole('radio', { name })

beforeEach(() => {
  cleanup(); localStorage.clear(); vi.useFakeTimers({ toFake: ['Date'], now: NOW }); setAccountZone('Pacific/Auckland'); post = ok; server()
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setAccountZone(undefined); setOfflineOwner(null) })

describe('Quick add: «when do you want to do it?»', () => {
  it('offers Today, Tomorrow, a date and Not scheduled, and nothing is scheduled by default', async () => {
    await open()
    const group = screen.getByRole('radiogroup', { name: 'When do you want to do it?' })
    expect(within(group).getAllByRole('radio').map(r => r.textContent?.trim().replace(/✓/, ''))).toEqual(['Today', 'Tomorrow', 'Pick a date', 'Not scheduled'])
    expect(within(group).queryByRole('radio', { name: /This week|No date/ })).toBeNull()
    expect(tile('Not scheduled')).toHaveAttribute('aria-checked', 'true')
    expect(tile('Today')).toHaveAttribute('aria-checked', 'false')
  })

  it('the default saves ONE request with no schedule and no deadline of any kind', async () => {
    const input = await open()
    type(input, 'Pay rent'); expect(screen.queryByText(/Understood:/)).toBeNull(); add()
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0].body).toMatchObject({ title: 'Pay rent', status: 'todo', priority: 'medium', estimated_minutes: 30, client_id: expect.any(String) })
    for (const key of ['schedule', 'due_at', 'due_date', 'due_all_day']) expect(posts()[0].body).not.toHaveProperty(key)
  })

  it('Tomorrow books 09:00 account time for 30 minutes in exactly one request, says so, and refreshes lists and the calendar', async () => {
    const tasks = vi.fn(), calendar = vi.fn()
    window.addEventListener(TASKS_CHANGED, tasks); window.addEventListener(CALENDAR_CHANGED, calendar)
    const input = await open()
    type(input, 'Call the bank'); fireEvent.click(tile('Tomorrow'))
    expect(screen.getByText(/Understood:/)).toHaveTextContent('Understood: Tomorrow 09:00–09:30')
    add()
    await waitFor(() => expect(posts()).toHaveLength(1))
    // 09:00 on the 12th in Auckland (UTC+13) is 20:00Z on the 11th, whatever the browser's zone is.
    expect(posts()[0].body).toMatchObject({ title: 'Call the bank', estimated_minutes: 30, schedule: { starts_at: '2026-11-11T20:00:00.000Z' } })
    expect(posts()[0].body).not.toHaveProperty('due_at')
    expect(posts()[0].headers['Idempotency-Key']).toBe(posts()[0].body!.client_id)
    expect(await screen.findByText('Added and scheduled: Tomorrow 09:00–09:30')).toBeInTheDocument()
    expect(tasks).toHaveBeenCalled(); expect(calendar).toHaveBeenCalled()
    window.removeEventListener(TASKS_CHANGED, tasks); window.removeEventListener(CALENDAR_CHANGED, calendar)
  })

  it('Today starts at the next half hour and shows the end date when it passes midnight', async () => {
    const input = await open()
    type(input, 'Late call'); fireEvent.click(tile('Today'))
    expect(screen.getByText(/Understood:/)).toHaveTextContent('Understood: Today 23:30–Tomorrow 00:00')
    add()
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0].body!.schedule.starts_at).toBe('2026-11-11T10:30:00.000Z')
  })

  it('"tomorrow at 7pm for one hour" books 19:00 for 60 minutes and wins over the chosen day', async () => {
    const input = await open()
    fireEvent.click(tile('Today'))
    type(input, 'Study Laravel tomorrow at 7pm for one hour')
    expect(screen.getByText(/Understood:/)).toHaveTextContent('Understood: Tomorrow 19:00–20:00')
    add()
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0].body).toMatchObject({ title: 'Study Laravel tomorrow at 7pm for one hour', estimated_minutes: 60, schedule: { starts_at: '2026-11-12T06:00:00.000Z' } })
    expect(posts()[0].body).not.toHaveProperty('due_at')
  })

  it('a phrase with only a length sets the estimate (and the chosen day uses it); with Not scheduled nothing is booked', async () => {
    const input = await open()
    type(input, 'Write report for 2 hours')
    expect(screen.getByText(/Understood:/)).toHaveTextContent('Understood: 120 min')
    fireEvent.click(tile('Tomorrow'))
    expect(screen.getByText(/Understood:/)).toHaveTextContent('Understood: Tomorrow 09:00–11:00')
    fireEvent.click(tile('Not scheduled')); add()
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0].body).toMatchObject({ estimated_minutes: 120 })
    expect(posts()[0].body).not.toHaveProperty('schedule'); expect(posts()[0].body).not.toHaveProperty('due_at')
  })

  it('does not announce each keystroke: the line is plain text tied to the field, not a live region', async () => {
    const input = await open()
    type(input, 'Call mum tomorrow at 7pm')
    const line = screen.getByText(/Understood:/)
    expect(line).not.toHaveAttribute('role'); expect(line).not.toHaveAttribute('aria-live')
    expect(input.getAttribute('aria-describedby')).toBe(line.id)
  })

  it('says the booking in Arabic with the times in their own direction', async () => {
    const input = await open('ar')
    type(input, 'اتصل بأحمد بكرة الساعة 5 مساءً لمدة ساعتين')
    const line = screen.getByText(/فُهم:/)
    expect(line).toHaveTextContent('فُهم: غدًا 17:00–19:00')
    expect(line.querySelector('bdi[dir="ltr"]')).toHaveTextContent('17:00–19:00')
  })

  it('a time that has already passed saves the task WITHOUT a time (never blocked), and says so before and after', async () => {
    const input = await open()
    type(input, 'Too late today at 8am for 45 minutes')
    expect(screen.getByText(/Understood:/)).toHaveTextContent('Understood: 08:00 has passed: it will be added without a time')
    add()
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0].body).toMatchObject({ title: 'Too late today at 8am for 45 minutes', estimated_minutes: 45 })
    for (const key of ['schedule', 'due_at', 'due_date']) expect(posts()[0].body).not.toHaveProperty(key)
    expect(await screen.findByText('Added. 08:00 has passed, so it was not scheduled.')).toBeInTheDocument()
  })

  it('a start in the past with an end in the future ("at 10:30pm for 2 hours" at 23:00) is treated the same', async () => {
    const input = await open()
    type(input, 'Late job at 10:30pm for 2 hours')
    expect(screen.getByText(/Understood:/)).toHaveTextContent('22:30 has passed')
    add()
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0].body).not.toHaveProperty('schedule'); expect(posts()[0].body!.estimated_minutes).toBe(120)
  })

  it('says it in Arabic: the line and the toast, with the time isolated', async () => {
    const input = await open('ar')
    type(input, 'مهمة اليوم الساعة 8 صباحا')
    expect(screen.getByText(/فُهم:/)).toHaveTextContent('فُهم: مضى 08:00: ستُضاف دون وقت')
    add()
    expect(await screen.findByText(/أُضيفت\. الساعة .*08:00.* مضت، لذا لم تُجدول\./)).toBeInTheDocument()
  })

  it('a time with no day word follows the tile: Tomorrow + "at 3pm" is tomorrow 15:00; Not scheduled + "at 11:45pm" is today', async () => {
    const input = await open()
    fireEvent.click(tile('Tomorrow')); type(input, 'Call the dentist at 3pm')
    expect(screen.getByText(/Understood:/)).toHaveTextContent('Understood: Tomorrow 15:00–15:30')
    add()
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0].body!.schedule.starts_at).toBe('2026-11-12T02:00:00.000Z')   // 15:00 on the 12th in Auckland
    cleanup(); post = ok
    const again = await open()
    type(again, 'Call the vet at 11:45pm')
    expect(screen.getByText(/Understood:/)).toHaveTextContent('Understood: Today 23:45–Tomorrow 00:15')
  })

  it('a day word in the phrase still wins over the tile', async () => {
    const input = await open()
    fireEvent.click(tile('Today')); type(input, 'Plan tomorrow at 3pm')
    expect(screen.getByText(/Understood:/)).toHaveTextContent('Understood: Tomorrow 15:00–15:30')
  })

  it('with no half hour left today, Today becomes Tomorrow 09:00 and the tile and the line say so', async () => {
    vi.setSystemTime(new Date('2026-11-11T10:40:00Z'))   // 23:40 in Auckland
    const input = await open()
    type(input, 'Last call'); fireEvent.click(tile('Today'))
    expect(tile('Tomorrow')).toHaveAttribute('aria-checked', 'true'); expect(tile('Today')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/Understood:/)).toHaveTextContent('Understood: Tomorrow 09:00–09:30 (today is almost over)')
  })

  it('always shows 24-hour times in the line, the toast and the conflict dialog, even when the 12-hour clock is chosen', async () => {
    localStorage.setItem('lifeos-hour-cycle', '12'); localStorage.setItem('lifeos-clock', '12')
    let n = 0
    post = () => ++n === 1 ? { status: 422, body: conflictBody() } : ok()
    const input = await open()
    type(input, 'Clock check'); fireEvent.click(tile('Tomorrow'))
    expect(screen.getByText(/Understood:/).textContent).not.toMatch(/AM|PM/i)
    expect(screen.getByText(/Understood:/)).toHaveTextContent('Tomorrow 09:00–09:30')
    add()
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).not.toMatch(/AM|PM/i)
    fireEvent.click(within(dialog).getByRole('button', { name: /Suggest the first free time/ }))
    const toast = await screen.findByText(/Added and scheduled/)
    expect(toast.textContent).toBe('Added and scheduled: Tomorrow 09:15–09:45')
  })

  it('an error is tied to the field and goes away when the text or the tile changes', async () => {
    post = () => ({ status: 500, body: { message: 'Server error' } })
    const input = await open()
    type(input, 'Needs fixing'); add()
    const message = await screen.findByText('Server error')
    expect(input).toHaveAttribute('aria-invalid', 'true'); expect(input.getAttribute('aria-describedby')).toContain(message.id)
    fireEvent.click(tile('Tomorrow'))
    expect(screen.queryByText('Server error')).toBeNull(); expect(input).not.toHaveAttribute('aria-invalid')
    add(); await screen.findByText('Server error')
    type(input, 'Needs fixing now')
    expect(screen.queryByText('Server error')).toBeNull()
  })

  it('a server "time not in the future" answer is said in plain words, not as the raw message', async () => {
    post = () => ({ status: 422, body: { message: 'The schedule.ends_at field must be a date after now.', errors: { 'schedule.ends_at': ['raw'] } } })
    const input = await open('ar')
    type(input, 'مهمة'); fireEvent.click(tile('غدًا')); add()
    expect(await screen.findByText('اختر وقتًا لم يمضِ.')).toBeInTheDocument()
  })

  it('a retry after a dropped answer (502) reuses the client_id and the Idempotency-Key, in a scheduled and a not-scheduled body; a final refusal (422) starts a new one', async () => {
    let n = 0
    post = () => ++n === 1 ? { status: 502, body: { message: 'Bad gateway' } } : ok()
    const input = await open()
    type(input, 'Retry me'); add()
    await screen.findByText('Bad gateway'); add()
    await waitFor(() => expect(posts()).toHaveLength(2))
    expect(posts()[1].body!.client_id).toBe(posts()[0].body!.client_id)
    cleanup(); calls.length = 0; n = 0
    post = () => ++n === 1 ? { status: 502, body: { message: 'Bad gateway' } } : ok()
    const second = await open()
    type(second, 'Retry booked'); fireEvent.click(tile('Tomorrow')); add()
    await screen.findByText('Bad gateway'); add()
    await waitFor(() => expect(posts()).toHaveLength(2))
    expect(posts()[1].body!.client_id).toBe(posts()[0].body!.client_id)
    expect(posts()[0].headers['Idempotency-Key']).toBe(posts()[0].body!.client_id)
    expect(posts()[1].headers['Idempotency-Key']).toBe(posts()[0].headers['Idempotency-Key'])
    // A final refusal (422) means nothing was saved: the next try is a new action with a new id.
    cleanup(); calls.length = 0; n = 0
    post = () => ++n === 1 ? { status: 422, body: { message: 'Nope', errors: { title: ['x'] } } } : ok()
    const third = await open()
    type(third, 'Refused once'); add()
    await screen.findByText('Nope'); add()
    await waitFor(() => expect(posts()).toHaveLength(2))
    expect(posts()[1].body!.client_id).not.toBe(posts()[0].body!.client_id)
  })

  it('"Choose another time" puts the cursor on the start time, not the title', async () => {
    post = () => ({ status: 422, body: conflictBody() })
    const input = await open()
    type(input, 'Focus check'); fireEvent.click(tile('Tomorrow')); add()
    fireEvent.click(await within(await screen.findByRole('alertdialog')).findByRole('button', { name: 'Choose another time' }))
    await screen.findByLabelText('Title')
    await waitFor(() => expect(screen.getByLabelText('Start time')).toHaveFocus())
  })

  it('a double click on Add creates one task', async () => {
    post = () => ({ ...ok(), delay: 30 })
    const input = await open()
    type(input, 'Once'); fireEvent.click(tile('Tomorrow'))
    const button = screen.getByRole('button', { name: 'Add task' })
    fireEvent.click(button); fireEvent.click(button)
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Task' })).toBeNull())
    expect(posts()).toHaveLength(1)
  })
})

describe('Quick add: a taken time saves nothing', () => {
  it('keeps the sheet and the text, shows the dialog, and the suggested time is sent once', async () => {
    let n = 0
    post = () => ++n === 1 ? { status: 422, body: conflictBody() } : ok()
    const input = await open()
    type(input, 'Plan the week'); fireEvent.click(tile('Tomorrow')); add()
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent("You can't schedule this task from 09:00 to 09:30")
    expect(screen.getByRole('textbox', { name: 'Task' })).toHaveValue('Plan the week')
    expect(screen.queryByText(/Added and scheduled/)).toBeNull()
    expect(posts()).toHaveLength(1)
    const suggest = within(dialog).getByRole('button', { name: /Suggest the first free time/ })
    fireEvent.click(suggest); fireEvent.click(suggest)
    await waitFor(() => expect(posts()).toHaveLength(2))
    expect(posts()[1].body).toMatchObject({ title: 'Plan the week', estimated_minutes: 30, schedule: { starts_at: '2026-11-11T20:15:00Z' } })
    expect(posts()[1].body).not.toHaveProperty('due_at')
    expect(posts()[1].body!.client_id).not.toBe(posts()[0].body!.client_id)
    expect(await screen.findByText('Added and scheduled: Tomorrow 09:15–09:45')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Task' })).toBeNull())
    expect(posts()).toHaveLength(2)
  })

  it('"Choose another time" opens the full dialog with the same draft and the day, start and length filled in', async () => {
    post = () => ({ status: 422, body: conflictBody() })
    const input = await open()
    type(input, 'Plan the week for 45 minutes'); fireEvent.click(tile('Tomorrow')); fireEvent.click(screen.getByRole('radio', { name: 'Urgent' })); add()
    fireEvent.click(await within(await screen.findByRole('alertdialog')).findByRole('button', { name: 'Choose another time' }))
    expect(await screen.findByLabelText('Title')).toHaveValue('Plan the week for 45 minutes')
    const group = screen.getByRole('radiogroup', { name: 'When do you want to do it?' })
    expect(within(group).getByRole('radio', { name: 'Tomorrow' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('Start time')).toHaveTextContent('09:00')
    expect(screen.getByRole('radio', { name: '45' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Urgent' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('checkbox', { name: /deadline for finishing it/ })).not.toBeChecked()
    expect(posts()).toHaveLength(1)   // nothing more was sent: the user picks another time first
  })

  it('a closed or other error keeps the sheet with the message', async () => {
    post = () => ({ status: 500, body: { message: 'Server error' } })
    const input = await open()
    type(input, 'x task'); add()
    expect(await screen.findByText('Server error')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Task' })).toHaveValue('x task')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('Quick add: More details', () => {
  it('opens the dialog with the planned day, start and length, and the deadline switch off', async () => {
    const input = await open()
    type(input, 'Prepare slides'); fireEvent.click(tile('Tomorrow'))
    fireEvent.click(screen.getByRole('button', { name: /More details/ }))
    expect(await screen.findByLabelText('Title')).toHaveValue('Prepare slides')
    expect(posts()).toHaveLength(0)
    const group = screen.getByRole('radiogroup', { name: 'When do you want to do it?' })
    expect(within(group).getByRole('radio', { name: 'Tomorrow' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('Start time')).toHaveTextContent('09:00')
    expect(screen.getByRole('checkbox', { name: /deadline for finishing it/ })).not.toBeChecked()
    expect(screen.getByText(/^Ends/)).toHaveTextContent('09:30')
    // Saving from there is still one request with the same plan and no deadline.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0].body).toMatchObject({ title: 'Prepare slides', estimated_minutes: 30, schedule: { starts_at: '2026-11-11T20:00:00.000Z' } })
    expect(posts()[0].body).not.toHaveProperty('due_at'); expect(posts()[0].body).not.toHaveProperty('due_date')
  })

  it('without a chosen day the dialog opens with "Not scheduled" and no deadline', async () => {
    const input = await open()
    type(input, 'Someday'); fireEvent.click(screen.getByRole('button', { name: /More details/ }))
    await screen.findByLabelText('Title')
    const group = screen.getByRole('radiogroup', { name: 'When do you want to do it?' })
    expect(within(group).getByRole('radio', { name: 'Not scheduled' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('checkbox', { name: /deadline for finishing it/ })).not.toBeChecked()
  })
})

describe('offline: the queue keeps the time', () => {
  const item = async () => { setOfflineOwner(1); vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false); await createTaskOrQueue({ title: 'Pay rent', estimated_minutes: 45, schedule: { starts_at: '2026-11-11T20:00:00.000Z' } }); vi.restoreAllMocks(); return pendingItems()[0] }

  it('queues the payload WITH its schedule and no due_at, and nothing is sent', async () => {
    const queued = await item()
    expect(queued.payload).toMatchObject({ title: 'Pay rent', estimated_minutes: 45, schedule: { starts_at: '2026-11-11T20:00:00.000Z' }, client_id: expect.any(String) })
    expect(queued.payload).not.toHaveProperty('due_at')
    expect(posts()).toHaveLength(0)
  })

  it('sends it later with the schedule, the client id and an Idempotency-Key', async () => {
    const queued = await item()
    expect(await sendPending(queued)).toBe('sent')
    expect(posts()[0].body).toEqual(queued.payload)
    expect(posts()[0].headers['Idempotency-Key']).toBe(queued.payload.client_id)
    expect(pendingItems()).toHaveLength(0)
  })

  it('a time taken by then keeps the TASK: it is re-sent without the schedule and without the Idempotency-Key, same client_id', async () => {
    const queued = await item()
    post = c => c.body?.schedule ? { status: 422, body: conflictBody() } : ok()
    expect(await sendPending(queued)).toBe('unscheduled_taken')
    expect(pendingItems()).toHaveLength(0)
    expect(posts()).toHaveLength(2)
    expect(posts()[1].body).toEqual({ title: 'Pay rent', estimated_minutes: 45, client_id: queued.payload.client_id })
    expect(posts()[1].headers['Idempotency-Key']).toBeUndefined()
  })

  it('a time that has passed by then is kept the same way', async () => {
    const queued = await item()
    post = c => c.body?.schedule ? { status: 422, body: { message: 'x', errors: { 'schedule.ends_at': ['past'] } } } : ok()
    expect(await sendPending(queued)).toBe('unscheduled_passed')
    expect(pendingItems()).toHaveLength(0); expect(posts()[1].body).not.toHaveProperty('schedule')
  })

  it('any other refusal keeps the item as a conflict row (not dropped), and so does a failing plain resend', async () => {
    const queued = await item()
    post = () => ({ status: 422, body: { message: 'The title field is required.', errors: { title: ['required'] } } })
    expect(await sendPending(queued)).toBe('conflict')
    expect(pendingItems()[0]).toMatchObject({ id: queued.id, state: 'conflict', reason: 'rejected' })
    expect(pendingItems()[0].payload).toEqual(queued.payload); expect(posts()).toHaveLength(1)
    post = c => c.body?.schedule ? { status: 422, body: conflictBody() } : { status: 500, body: { message: 'boom' } }
    expect(await sendPending(pendingItems()[0])).toBe('conflict')
    expect(pendingItems()).toHaveLength(1)
  })

  it('the queued toast says the time is checked again on send', async () => {
    setOfflineOwner(1); vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const input = await open()
    type(input, 'Offline plan'); fireEvent.click(tile('Tomorrow')); add()
    expect(await screen.findByText(/The time is checked again when you send it/)).toBeInTheDocument()
    expect(pendingItems()[0].payload).toMatchObject({ schedule: { starts_at: '2026-11-11T20:00:00.000Z' } })
  })

  it('Waiting to sync words a conflict row in the app language, never the raw server message', async () => {
    const queued = await item()
    post = () => ({ status: 422, body: { message: 'The title field is required.', errors: { title: ['required'] } } })
    await sendPending(queued)
    localStorage.setItem('lifeos-language', 'ar')
    render(wrap(<OfflineSync />)); act(() => openSync())
    expect(await screen.findByText('لم يقبلها الخادم.')).toBeInTheDocument()
    expect(screen.queryByText(/title field is required/)).toBeNull()
  })
})

describe('clock changes and an account zone that is not the browser\'s', () => {
  // The browser here is whatever the test machine is; the account is elsewhere, so every instant is the account's wall clock.
  const cases: [string, string, string, string, string][] = [
    ['Europe/Amsterdam', 'spring change 2026-03-29', '2026-03-28T20:00:00Z', 'Tomorrow 09:00–09:30', '2026-03-29T07:00:00.000Z'],
    ['Europe/Amsterdam', 'autumn change 2026-10-25', '2026-10-24T20:00:00Z', 'Tomorrow 09:00–09:30', '2026-10-25T08:00:00.000Z'],
    ['America/Los_Angeles', 'US spring change 2026-03-08', '2026-03-07T22:00:00Z', 'Tomorrow 09:00–09:30', '2026-03-08T16:00:00.000Z'],
    ['America/Los_Angeles', 'US autumn change 2026-11-01', '2026-10-31T20:00:00Z', 'Tomorrow 09:00–09:30', '2026-11-01T17:00:00.000Z'],
    ['Pacific/Auckland', 'NZ spring change 2026-09-27', '2026-09-26T05:00:00Z', 'Tomorrow 09:00–09:30', '2026-09-26T20:00:00.000Z'],
  ]
  it.each(cases)('%s, %s: the Tomorrow tile is 09:00 on the account\'s clock', async (zone, _label, now, line, starts) => {
    setAccountZone(zone); vi.setSystemTime(new Date(now))
    const input = await open()
    type(input, 'Zone check'); fireEvent.click(tile('Tomorrow'))
    expect(screen.getByText(/Understood:/)).toHaveTextContent(`Understood: ${line}`)
    add()
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0].body!.schedule.starts_at).toBe(starts)
  })

  it('a session across the spring gap is 2 real hours: 01:30 + 2 h ends at 04:30 on the wall clock', async () => {
    setAccountZone('Europe/Amsterdam'); vi.setSystemTime(new Date('2026-03-28T20:00:00Z'))
    const input = await open()
    type(input, 'Night shift tomorrow at 1:30am for 2 hours')
    expect(screen.getByText(/Understood:/)).toHaveTextContent('Understood: Tomorrow 01:30–04:30')
    add()
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0].body).toMatchObject({ estimated_minutes: 120, schedule: { starts_at: '2026-03-29T00:30:00.000Z' } })
  })

  it('a session across the autumn repeat is 2 real hours: 01:30 + 2 h ends at 02:30 on the wall clock', async () => {
    setAccountZone('Europe/Amsterdam'); vi.setSystemTime(new Date('2026-10-24T20:00:00Z'))
    const input = await open()
    type(input, 'Night shift tomorrow at 1:30am for 2 hours')
    expect(screen.getByText(/Understood:/)).toHaveTextContent('Understood: Tomorrow 01:30–02:30')
    add()
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0].body!.schedule.starts_at).toBe('2026-10-24T23:30:00.000Z')
  })
})
