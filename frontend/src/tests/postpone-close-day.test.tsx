import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import TasksPageLazy from '../features/TasksPage'
import { PostponeButton } from '../features/tasks/Postpone'
import { CloseDayButton, CloseDayCard, CloseDayHost } from '../features/today/CloseDay'
import { closeDayText } from '../lib/closeDay'
import { canPostpone, movedText, postponeBody } from '../lib/postpone'
import { setAccountZone } from '../lib/accountDay'
import { TASKS_CHANGED } from '../lib/quickAdd'
import { CALENDAR_CHANGED } from '../lib/taskSchedule'
import type { AssistantProposal, CloseDayHint } from '../lib/api'

type Route = { match: RegExp; method?: string; body: unknown; status?: number; fail?: boolean }
function mockApi(routes: Route[]) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes.find(r => r.match.test(url) && (!r.method || r.method === (init?.method || 'GET')))
    if (route?.fail) throw new TypeError('network down')
    return new Response(JSON.stringify(route ? route.body : {}), { status: route ? route.status ?? 200 : 404 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const wrap = (children: ReactNode, path = '/') => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[path]}><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
const sent = (fetcher: ReturnType<typeof mockApi>, suffix: string) => fetcher.mock.calls.filter(c => String(c[0]).endsWith(suffix))
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body))
const keyOf = (call: unknown[]) => ((call[1] as RequestInit).headers as Record<string, string>)['Idempotency-Key']
function language(l: 'en' | 'ar' | 'nl') { localStorage.setItem('lifeos-language', l) }

const UPDATED = '2027-03-22T08:00:00Z'
const task = { id: 5, status: 'todo', updated_at: UPDATED }
const POSTPONE = /\/api\/tasks\/5\/postpone$/, UNDO = /\/api\/tasks\/5\/postpone\/undo$/
const sessionMoved = { data: { id: 5, title: 'Write report' }, undo: { token: 't'.repeat(40), expires_at: '2027-03-22T12:10:00Z' }, moved: { session: { session_id: 9, from_starts_at: '2027-03-22T14:00:00Z', from_ends_at: '2027-03-22T15:00:00Z', starts_at: '2027-03-23T09:00:00Z', ends_at: '2027-03-23T10:00:00Z' } } }
const dueMoved = { ...sessionMoved, moved: { due: { from: '2027-03-22T23:59:00Z', to: '2027-03-25T23:59:00Z', due_all_day: true } } }
function counter() {
  const seen = { tasks: 0, calendar: 0 }
  const a = () => { seen.tasks++ }, b = () => { seen.calendar++ }
  window.addEventListener(TASKS_CHANGED, a); window.addEventListener(CALENDAR_CHANGED, b)
  return { seen, stop: () => { window.removeEventListener(TASKS_CHANGED, a); window.removeEventListener(CALENDAR_CHANGED, b) } }
}
async function openMenu(name = 'Postpone “Write report”') {
  fireEvent.click(screen.getByRole('button', { name }))
  return await screen.findByRole('menu')
}

beforeEach(() => {
  cleanup(); localStorage.clear(); language('en'); vi.unstubAllGlobals(); setAccountZone('UTC')
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-03-22T12:00:00Z'))   // a Monday
})
afterEach(() => { vi.useRealTimers(); setAccountZone(undefined) })

describe('Postpone: the menu', () => {
  it('"Tomorrow" sends to: tomorrow with the version seen and an Idempotency-Key, says where the session went, and refreshes', async () => {
    const fetcher = mockApi([{ match: POSTPONE, method: 'POST', body: sessionMoved }]), events = counter()
    render(wrap(<PostponeButton task={task} title="Write report" />))
    const menu = await openMenu()
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Tomorrow', 'Next week', 'Suggest a time…', 'Pick a date…'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Tomorrow' }))
    expect(await screen.findByText('Moved to Tue 09:00–10:00')).toBeInTheDocument()
    const [call] = sent(fetcher, '/api/tasks/5/postpone')
    expect(bodyOf(call)).toEqual({ to: 'tomorrow', expected_updated_at: UPDATED })
    expect(keyOf(call)).toMatch(/^[0-9a-f-]{36}$/)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(events.seen).toEqual({ tasks: 1, calendar: 1 })
    events.stop()
  })

  it('"Next week" of a deadline-only task says the deadline moved, with the date when it is a week or more away', async () => {
    const fetcher = mockApi([{ match: POSTPONE, method: 'POST', body: { ...dueMoved, moved: { due: { from: '2027-03-22T23:59:00Z', to: '2027-03-29T23:59:00Z', due_all_day: true } } } }])
    render(wrap(<PostponeButton task={{ id: 5, status: 'todo' }} title="Write report" />))
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Next week' }))
    expect(await screen.findByText('Deadline moved to Mon, Mar 29')).toBeInTheDocument()
    expect(bodyOf(sent(fetcher, '/api/tasks/5/postpone')[0])).toEqual({ to: 'next_week' })
  })

  it('Undo in the toast calls the undo endpoint with the token, says so and refreshes again', async () => {
    const fetcher = mockApi([{ match: UNDO, method: 'POST', body: { data: { id: 5 } } }, { match: POSTPONE, method: 'POST', body: dueMoved }]), events = counter()
    render(wrap(<PostponeButton task={task} title="Write report" />))
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Tomorrow' }))
    expect(await screen.findByText('Deadline moved to Thu')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Put back where it was.')).toBeInTheDocument()
    expect(bodyOf(sent(fetcher, '/api/tasks/5/postpone/undo')[0])).toEqual({ token: 't'.repeat(40) })
    expect(events.seen).toEqual({ tasks: 2, calendar: 2 })
    events.stop()
  })

  it.each([
    ['changed_since', 409, 'This task was changed after it was postponed, so it is not put back.'],
    ['undo_unavailable', 422, 'This postponement can no longer be undone.'],
  ])('a refused undo (%s) is said, never silent', async (code, status, message) => {
    mockApi([{ match: UNDO, method: 'POST', status, body: { message: 'server words', code } }, { match: POSTPONE, method: 'POST', body: sessionMoved }])
    render(wrap(<PostponeButton task={task} title="Write report" />))
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Tomorrow' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('a refused undo because the old time is taken shows the server’s message', async () => {
    const conflict = { message: 'The original time now overlaps “Dentist”, so the session is not put back.', errors: { token: ['x'] }, conflict: { code: 'schedule_conflict' } }
    mockApi([{ match: UNDO, method: 'POST', status: 422, body: conflict }, { match: POSTPONE, method: 'POST', body: sessionMoved }])
    render(wrap(<PostponeButton task={task} title="Write report" />))
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Tomorrow' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(await screen.findByText(conflict.message)).toBeInTheDocument()
  })

  it.each([
    ['session_fixed', 422, 'This is a fixed appointment; move it in the calendar.'],
    ['session_linked', 422, 'This session is also in a connected calendar; move it there.'],
    ['nothing_to_postpone', 422, 'This task has no session and no deadline, so there is nothing to postpone.'],
    ['already_later', 422, 'The deadline is already on or after that day.'],
    ['task_closed', 422, 'A completed or cancelled task cannot be postponed.'],
    ['task_changed', 409, 'This task was changed in the meantime. Reload and try again.'],
  ])('%s is shown in place, and the menu stays open', async (code, status, message) => {
    mockApi([{ match: POSTPONE, method: 'POST', status, body: { message: 'server words', code } }])
    render(wrap(<PostponeButton task={task} title="Write report" />))
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Tomorrow' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('no room at all (the structured conflict) shows the server’s message in place', async () => {
    const message = 'There is no free time for this session on 2027-03-23 or the next 5 work days.'
    mockApi([{ match: POSTPONE, method: 'POST', status: 422, body: { message, errors: { to: [message] }, conflict: { code: 'schedule_conflict', requested: {}, conflicts: [] } } }])
    render(wrap(<PostponeButton task={task} title="Write report" />))
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Tomorrow' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })

  it('a retry after a dropped connection carries the same Idempotency-Key; a new tap after success gets a new one', async () => {
    const routes: Route[] = [{ match: POSTPONE, method: 'POST', body: sessionMoved, fail: true }]
    const fetcher = mockApi(routes)
    render(wrap(<PostponeButton task={task} title="Write report" />))
    const menu = await openMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Tomorrow' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    routes[0].fail = false
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Tomorrow' }))
    expect(await screen.findByText('Moved to Tue 09:00–10:00')).toBeInTheDocument()
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Tomorrow' }))
    await waitFor(() => expect(sent(fetcher, '/api/tasks/5/postpone')).toHaveLength(3))
    const keys = sent(fetcher, '/api/tasks/5/postpone').map(keyOf)
    expect(keys[0]).toBe(keys[1]); expect(keys[2]).not.toBe(keys[1])
  })

  it('"Suggest a time…" asks without writing, shows the day and time, and Confirm sends to: date with that day', async () => {
    const suggestion = { to: 'date', date: '2027-03-24', starts_at: '2027-03-24T09:00:00Z', ends_at: '2027-03-24T10:00:00Z', due_at: null, due_all_day: false, has_room: true }
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (!POSTPONE.test(url)) return new Response('{}', { status: 401 })
      const body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify(body.to === 'suggest' ? { data: { id: 5 }, suggestion } : { ...sessionMoved, moved: { session: { ...sessionMoved.moved.session, starts_at: suggestion.starts_at, ends_at: suggestion.ends_at } } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetcher)
    render(wrap(<PostponeButton task={task} title="Write report" />))
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Suggest a time…' }))
    const panel = await screen.findByRole('group', { name: 'Suggest a time' })
    expect(await within(panel).findByText('Suggested: Wed, Mar 24 · 09:00–10:00')).toBeInTheDocument()
    expect(within(panel).queryByText(/no free time/)).toBeNull()
    const posts = () => fetcher.mock.calls.filter(c => POSTPONE.test(String(c[0])))
    expect(JSON.parse(String(posts()[0][1]?.body))).toEqual({ to: 'suggest' })
    expect(posts()).toHaveLength(1)
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Confirm' })).toHaveFocus())
    fireEvent.click(within(panel).getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('Moved to Wed 09:00–10:00')).toBeInTheDocument()
    const confirm = posts()[1]
    expect(JSON.parse(String(confirm[1]?.body))).toEqual({ to: 'date', date: '2027-03-24', expected_updated_at: UPDATED })
    expect(keyOf(confirm)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('a suggestion without room says so honestly and can still be confirmed', async () => {
    const suggestion = { to: 'date', date: '2027-03-23', starts_at: null, ends_at: null, due_at: '2027-03-23T23:59:00Z', due_all_day: true, has_room: false }
    const fetcher = mockApi([{ match: POSTPONE, method: 'POST', body: { data: { id: 5 }, suggestion } }])
    render(wrap(<PostponeButton task={task} title="Write report" />))
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Suggest a time…' }))
    const panel = await screen.findByRole('group', { name: 'Suggest a time' })
    expect(await within(panel).findByText('Suggested: deadline on Tue, Mar 23')).toBeInTheDocument()
    expect(within(panel).getByText('There is no free time for it in the next work days, so this is simply the next work day.')).toBeInTheDocument()
    fireEvent.click(within(panel).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(sent(fetcher, '/api/tasks/5/postpone')).toHaveLength(2))
    expect(bodyOf(sent(fetcher, '/api/tasks/5/postpone')[1])).toMatchObject({ to: 'date', date: '2027-03-23' })
  })

  it('a suggestion that cannot be made (nothing to postpone) is said in place, and Back returns to the menu', async () => {
    mockApi([{ match: POSTPONE, method: 'POST', status: 422, body: { message: 'x', code: 'nothing_to_postpone' } }])
    render(wrap(<PostponeButton task={task} title="Write report" />))
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Suggest a time…' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('nothing to postpone')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('"Pick a date…" offers tomorrow by default and Confirm sends that day', async () => {
    const fetcher = mockApi([{ match: POSTPONE, method: 'POST', body: dueMoved }])
    render(wrap(<PostponeButton task={{ id: 5, status: 'in_progress' }} title="Write report" />))
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Pick a date…' }))
    const panel = await screen.findByRole('group', { name: 'Pick a date' })
    expect(within(panel).getByRole('button', { name: /^Day: / })).toHaveAttribute('data-value', '2027-03-23')
    fireEvent.click(within(panel).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(sent(fetcher, '/api/tasks/5/postpone')).toHaveLength(1))
    expect(bodyOf(sent(fetcher, '/api/tasks/5/postpone')[0])).toEqual({ to: 'date', date: '2027-03-23' })
  })

  it('is a keyboard menu button: ArrowDown opens on the first item, arrows move, Escape closes and gives focus back', async () => {
    mockApi([])
    render(wrap(<PostponeButton task={task} title="Write report" />))
    const trigger = screen.getByRole('button', { name: 'Postpone “Write report”' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu'); expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const menu = await screen.findByRole('menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'true'); expect(trigger).toHaveAttribute('aria-controls', menu.id)
    const items = within(menu).getAllByRole('menuitem')
    await waitFor(() => expect(items[0]).toHaveFocus())
    fireEvent.keyDown(items[0], { key: 'ArrowDown' }); expect(items[1]).toHaveFocus()
    fireEvent.keyDown(items[1], { key: 'End' }); expect(items[3]).toHaveFocus()
    fireEvent.keyDown(items[3], { key: 'ArrowDown' }); expect(items[0]).toHaveFocus()
    fireEvent.keyDown(items[0], { key: 'ArrowUp' }); expect(items[3]).toHaveFocus()
    fireEvent.keyDown(items[3], { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(trigger).toHaveFocus()
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    await waitFor(() => expect(within(screen.getByRole('menu')).getAllByRole('menuitem')[3]).toHaveFocus())
  })

  it('a reason not to postpone (unsaved edits) is said in place and nothing is sent', async () => {
    const fetcher = mockApi([])
    render(wrap(<PostponeButton task={task} title="Write report" blocked={() => 'Save or discard your changes first.'} />))
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Tomorrow' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Save or discard your changes first.')
    expect(sent(fetcher, '/postpone')).toHaveLength(0)
  })

  it('is not offered for a completed or cancelled task', () => {
    render(wrap(<><PostponeButton task={{ id: 1, status: 'completed' }} title="A" /><PostponeButton task={{ id: 2, status: 'cancelled' }} title="B" /><PostponeButton task={{ id: 3, status: 'inbox' }} title="C" /></>))
    expect(screen.queryByRole('button', { name: /A”$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /B”$/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Postpone “C”' })).toBeInTheDocument()
    expect([canPostpone({ status: 'completed' }), canPostpone({ status: 'cancelled' }), canPostpone({ status: 'todo' }), canPostpone({})]).toEqual([false, false, true, true])
    expect(postponeBody({ id: 1, updated_at: 7 }, 'date', '2027-04-01')).toEqual({ to: 'date', date: '2027-04-01' })
  })

  it('words the menu and the toast in Arabic', async () => {
    language('ar')
    mockApi([{ match: POSTPONE, method: 'POST', body: dueMoved }])
    render(wrap(<PostponeButton task={task} title="تقرير" />))
    const menu = await openMenu('تأجيل «تقرير»')
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['غدًا', 'الأسبوع القادم', 'اقترح وقتًا…', 'اختر تاريخًا…'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'غدًا' }))
    expect(await screen.findByText(/^نُقل الموعد النهائي إلى /)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'تراجع' })).toBeInTheDocument()
  })

  it('words the menu, the toast and a refusal in Dutch', async () => {
    language('nl')
    mockApi([{ match: POSTPONE, method: 'POST', status: 422, body: { message: 'x', code: 'session_fixed' } }])
    render(wrap(<PostponeButton task={task} title="Rapport" />))
    const menu = await openMenu('Uitstellen: “Rapport”')
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Morgen', 'Volgende week', 'Stel een tijd voor…', 'Kies een datum…'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Morgen' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Dit is een vaste afspraak; verplaats hem in de agenda.')
    const t = (en: string, _ar: string, nl?: string) => nl ?? en
    expect(movedText(sessionMoved.moved, t, 'nl')).toMatch(/^Verplaatst naar .+ 09:00–10:00$/)
    expect(movedText({}, t, 'nl')).toBe('Uitgesteld.')
  })
})

const id = '0b0b0b0b-0000-4000-8000-0000000000cc'
const proposal: AssistantProposal = {
  id, kind: 'close_day', provider: 'local', status: 'pending', summary: 'Close the day: 2 change(s)', explanation: ['x'], expires_at: '2027-03-23T10:00:00Z', applied_at: null, undo_until: null, results: null,
  actions: [
    { id: 'a1', type: 'move_event', title: 'Write report', event_id: 9, task_id: 5, from_starts_at: '2027-03-22T18:30:00Z', from_ends_at: '2027-03-22T19:30:00Z', starts_at: '2027-03-23T09:00:00Z', ends_at: '2027-03-23T10:00:00Z', minutes: 60, source: 'session', reason: 'Today’s session (18:30–19:30) is still open, so it moves to tomorrow at 09:00 with the same length.' },
    { id: 'a2', type: 'reschedule_task', title: 'Pay invoice', task_id: 6, from_due_at: '2027-03-22T23:59:00Z', from_due_all_day: true, due_at: '2027-03-23T23:59:00Z', due_all_day: true, minutes: 0, source: 'deadline', reason: 'Due today and still open, so the deadline moves to tomorrow.' },
  ] as AssistantProposal['actions'],
}
const recap = { completed: 4, focus_minutes: 80, planned_minutes: 180, done_titles: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'] }
const result = { proposal, summary: 'Close the day: 2 change(s) roll what is still open to your next work day.', explanation: ['Still open today: 2 task(s).'], recap }
const CLOSE = { match: /\/api\/today\/close$/, method: 'POST' }
const page = (hint?: CloseDayHint) => wrap(<><CloseDayButton /><CloseDayCard hint={hint} /><CloseDayHost /></>)

describe('Close the day', () => {
  it('shows the card only when the server suggests it, with the open count', () => {
    const { rerender } = render(page({ open_today: 3, suggested: false }))
    expect(screen.queryByText(/Your work day is over/)).toBeNull()
    rerender(page(undefined)); expect(screen.queryByText(/Your work day is over/)).toBeNull()
    rerender(page({ open_today: 3, suggested: true }))
    expect(screen.getByRole('region', { name: 'Close the day' })).toHaveTextContent('Your work day is over: 3 things are still open. Close the day?')
    expect(screen.getAllByRole('button', { name: 'Close the day' })).toHaveLength(2)
  })

  it('words the card in all three languages', () => {
    const pick = (l: 'en' | 'ar' | 'nl') => (en: string, ar: string, nl?: string) => l === 'ar' ? ar : l === 'nl' ? nl ?? en : en
    expect(closeDayText(1, pick('en'))).toBe('Your work day is over: 1 thing is still open. Close the day?')
    expect(closeDayText(3, pick('ar'))).toBe('انتهى يوم عملك: بقيت 3 أشياء مفتوحة. أتغلق اليوم؟')
    expect(closeDayText(2, pick('ar'))).toBe('انتهى يوم عملك: بقي شيئان مفتوحين. أتغلق اليوم؟')
    expect(closeDayText(3, pick('nl'))).toBe('Je werkdag is voorbij: nog 3 dingen open. Dag afsluiten?')
  })

  it('the card opens the sheet: the recap first (at most five titles), then the summary and the roll-over with its sources and reasons', async () => {
    const fetcher = mockApi([{ ...CLOSE, body: result }])
    render(page({ open_today: 2, suggested: true }))
    fireEvent.click(within(screen.getByRole('region', { name: 'Close the day' })).getByRole('button', { name: 'Close the day' }))
    const dialog = await screen.findByRole('dialog', { name: 'Close the day' })
    const recapBox = await within(dialog).findByRole('region', { name: 'Today so far' })
    expect(recapBox).toHaveTextContent('Done today: 4 tasks · 1 h 20 min focus · planned 3 h')
    expect(within(recapBox).getAllByRole('listitem').map(li => li.textContent)).toEqual(['One', 'Two', 'Three', 'Four', 'Five'])
    expect(dialog.textContent!.indexOf('Done today')).toBeLessThan(dialog.textContent!.indexOf(result.summary))
    expect(within(dialog).getByText('Still open today: 2 task(s).')).toBeInTheDocument()
    expect(within(dialog).getByText('Roll over to your next work day')).toBeInTheDocument()
    expect(within(dialog).getByText('Today’s session')).toBeInTheDocument()
    expect(within(dialog).getByText('Deadline today')).toBeInTheDocument()
    expect(within(dialog).getByText(proposal.actions[1].reason!)).toBeInTheDocument()
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2)
    expect(fetcher.mock.calls.filter(c => c[1]?.method === 'POST').map(c => String(c[0]))).toEqual(['/api/today/close'])
  })

  it('with nothing open it shows only the recap and the summary, and a Close button', async () => {
    mockApi([{ ...CLOSE, body: { proposal: null, summary: 'Nothing is left open today. Enjoy your evening.', explanation: [], recap: { completed: 1, focus_minutes: 0, planned_minutes: 0, done_titles: ['Only one'] } } }])
    render(page())
    fireEvent.click(screen.getByRole('button', { name: 'Close the day' }))
    const dialog = await screen.findByRole('dialog', { name: 'Close the day' })
    expect(await within(dialog).findByText('Done today: 1 task · 0 min focus · planned 0 min')).toBeInTheDocument()
    expect(within(dialog).getByText('Nothing is left open today. Enjoy your evening.')).toBeInTheDocument()
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('applies the chosen actions through the assistant apply call, then undo through the undo call, refreshing each time', async () => {
    const applied = { ...proposal, status: 'applied', undo_until: '2027-03-22T12:30:00Z', results: [{ action_id: 'a2', type: 'reschedule_task', task_id: 6 }] }
    const fetcher = mockApi([{ ...CLOSE, body: result }, { match: /\/apply$/, method: 'POST', body: applied }, { match: /\/undo$/, method: 'POST', body: { ...applied, status: 'undone', undo_until: null, results: [{ action_id: 'a2', type: 'reschedule_task', undo: { done: true } }] } }])
    const events = counter()
    render(page())
    fireEvent.click(screen.getByRole('button', { name: 'Close the day' }))
    const dialog = await screen.findByRole('dialog', { name: 'Close the day' })
    const boxes = await within(dialog).findAllByRole('checkbox')
    fireEvent.click(boxes[0])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply 1 change(s)' }))
    expect(await screen.findByText('1 change(s) applied.')).toBeInTheDocument()
    expect(bodyOf(sent(fetcher, `/api/assistant/proposals/${id}/apply`)[0])).toEqual({ action_ids: ['a2'] })
    expect(events.seen).toEqual({ tasks: 1, calendar: 1 })
    fireEvent.click(within(dialog).getByRole('button', { name: /Undo these changes/ }))
    expect(await screen.findByText('All changes undone.')).toBeInTheDocument()
    expect(sent(fetcher, `/api/assistant/proposals/${id}/undo`)).toHaveLength(1)
    expect(events.seen).toEqual({ tasks: 2, calendar: 2 })
    events.stop()
  })

  it('"Not now" dismisses through the assistant call and closes', async () => {
    const fetcher = mockApi([{ ...CLOSE, body: result }, { match: /\/dismiss$/, method: 'POST', body: { ...proposal, status: 'dismissed' } }])
    render(page())
    fireEvent.click(screen.getByRole('button', { name: 'Close the day' }))
    const dialog = await screen.findByRole('dialog', { name: 'Close the day' })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(sent(fetcher, `/api/assistant/proposals/${id}/dismiss`)).toHaveLength(1)
  })

  it('renders the entry, the recap and the sources in Arabic', async () => {
    language('ar')
    mockApi([{ ...CLOSE, body: result }])
    render(page({ open_today: 3, suggested: true }))
    expect(screen.getByRole('region', { name: 'أغلق اليوم' })).toHaveTextContent('انتهى يوم عملك')
    fireEvent.click(screen.getAllByRole('button', { name: 'أغلق اليوم' })[0])
    const dialog = await screen.findByRole('dialog', { name: 'أغلق اليوم' })
    expect(await within(dialog).findByText(/^أُنجز اليوم: 4 مهام · ساعة و20 دقيقة تركيز · 3 ساعات مخطط$/)).toBeInTheDocument()
    expect(within(dialog).getByText('جلسة اليوم')).toBeInTheDocument()
    expect(within(dialog).getByText('موعدها النهائي اليوم')).toBeInTheDocument()
  })

  it('renders the entry, the recap and the sources in Dutch', async () => {
    language('nl')
    mockApi([{ ...CLOSE, body: result }])
    render(page({ open_today: 1, suggested: true }))
    expect(screen.getByRole('region', { name: 'Dag afsluiten' })).toHaveTextContent('Je werkdag is voorbij: nog 1 ding open. Dag afsluiten?')
    fireEvent.click(screen.getAllByRole('button', { name: 'Dag afsluiten' })[0])
    const dialog = await screen.findByRole('dialog', { name: 'Dag afsluiten' })
    expect(await within(dialog).findByText('Vandaag gedaan: 4 taken · 1 u 20 min focus · 3 u gepland')).toBeInTheDocument()
    expect(within(dialog).getByText('Sessie van vandaag')).toBeInTheDocument()
    expect(within(dialog).getByText('Deadline vandaag')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '2 wijziging(en) toepassen' })).toBeInTheDocument()
  })
})

describe('Postpone on the Tasks page, its dialog and its swipe', () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: 5, title: 'Write report', status: 'todo', priority: 'high', due_at: null, estimated_minutes: 60, updated_at: UPDATED, schedule: { session_id: 9, starts_at: '2027-03-22T14:00:00Z', ends_at: '2027-03-22T15:00:00Z', sessions: 1, split: false }, ...over })
  function stubPage(tasks: Record<string, unknown>[]) {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = method === 'POST' && POSTPONE.test(url) ? sessionMoved
        : method === 'PATCH' ? { data: tasks[0] }
          : /\/api\/user$/.test(url) ? { id: 1, name: 'A', email: 'a@x.io', timezone: 'UTC' }
            : /\/api\/connected\/tasks/.test(url) ? [] : /\/api\/tasks/.test(url) ? { data: tasks, meta: { last_page: 1 } } : { data: [] }
      return new Response(JSON.stringify(body), { status: 200 })
    })
    vi.stubGlobal('fetch', fetcher)
    return fetcher
  }
  const reads = (f: ReturnType<typeof stubPage>) => f.mock.calls.filter(c => (c[1]?.method ?? 'GET') === 'GET' && /\/api\/tasks\?/.test(String(c[0]))).length
  const swipeLeft = (container: HTMLElement) => {
    const line = container.querySelector('.task-line')!
    fireEvent.pointerDown(line, { pointerType: 'touch', pointerId: 1, clientX: 300, clientY: 10 }); fireEvent.pointerMove(line, { pointerType: 'touch', pointerId: 1, clientX: 150, clientY: 10 }); fireEvent.pointerUp(line, { pointerType: 'touch', pointerId: 1 })
  }

  it('an open row offers Postpone next to Edit; "Next week" moves it, says so and the list reads the server again', async () => {
    const fetcher = stubPage([row()])
    render(wrap(<TasksPageLazy />))
    fireEvent.click(await screen.findByText('Write report'))
    fireEvent.click(await screen.findByRole('button', { name: 'Postpone “Write report”' }))
    const before = reads(fetcher)
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Next week' }))
    expect(await screen.findByText('Moved to Tue 09:00–10:00')).toBeInTheDocument()
    expect(bodyOf(sent(fetcher, '/api/tasks/5/postpone')[0])).toEqual({ to: 'next_week', expected_updated_at: UPDATED })
    await waitFor(() => expect(reads(fetcher)).toBeGreaterThan(before))
  }, 15_000)

  it('the task dialog offers Postpone in its action area; a postponement closes it', async () => {
    const fetcher = stubPage([row()])
    render(wrap(<TasksPageLazy />))
    fireEvent.click(await screen.findByText('Write report'))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit item' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Postpone “Write report”' }))
    fireEvent.click(within(await within(dialog).findByRole('menu')).getByRole('menuitem', { name: 'Tomorrow' }))
    expect(await screen.findByText('Moved to Tue 09:00–10:00')).toBeInTheDocument()
    expect(bodyOf(sent(fetcher, '/api/tasks/5/postpone')[0])).toEqual({ to: 'tomorrow', expected_updated_at: UPDATED })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit item' })).toBeNull())
  }, 15_000)

  it('a completed row offers no Postpone', async () => {
    stubPage([row({ status: 'completed', completed_at: '2027-03-22T09:00:00Z' })])
    render(wrap(<TasksPageLazy />, '/tasks'))
    fireEvent.click(screen.getByRole('radio', { name: 'Done' }))
    fireEvent.click(await screen.findByText('Write report'))
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Postpone/ })).toBeNull()
  })

  it('the default left swipe (Tomorrow) postpones a booked task through the postpone call', async () => {
    const fetcher = stubPage([row()])
    const { container } = render(wrap(<TasksPageLazy />))
    await screen.findByText('Write report')
    swipeLeft(container)
    expect(await screen.findByText('Moved to Tue 09:00–10:00')).toBeInTheDocument()
    expect(bodyOf(sent(fetcher, '/api/tasks/5/postpone')[0])).toMatchObject({ to: 'tomorrow' })
    expect(fetcher.mock.calls.filter(c => c[1]?.method === 'PATCH')).toHaveLength(0)
  })

  it('the swipe still gives a task with no session and no deadline a deadline tomorrow (nothing to postpone otherwise)', async () => {
    const fetcher = stubPage([row({ schedule: null, due_at: null })])
    const { container } = render(wrap(<TasksPageLazy />))
    await screen.findByText('Write report')
    swipeLeft(container)
    await waitFor(() => expect(fetcher.mock.calls.filter(c => c[1]?.method === 'PATCH')).toHaveLength(1))
    expect(sent(fetcher, '/api/tasks/5/postpone')).toHaveLength(0)
  })
})
