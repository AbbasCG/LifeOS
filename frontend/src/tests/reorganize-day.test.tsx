import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { ReorganizeButton, ReorganizeCard, ReorganizeHost } from '../features/today/ReorganizeDay'
import { slippedText, hasSlipped } from '../lib/reorganize'
import { TASKS_CHANGED } from '../lib/quickAdd'
import { CALENDAR_CHANGED } from '../lib/taskSchedule'
import type { AssistantProposal, ReorganizeHint } from '../lib/api'

type Route = { match: RegExp; method?: string; body: unknown; status?: number }
function mockApi(routes: Route[]) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes.find(r => r.match.test(url) && (!r.method || r.method === (init?.method || 'GET')))
    return new Response(JSON.stringify(route ? route.body : {}), { status: route ? route.status ?? 200 : 404 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider>{children}</ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
const page = (hint?: ReorganizeHint) => wrap(<><ReorganizeButton /><ReorganizeCard hint={hint} /><ReorganizeHost /></>)
const calls = (fetcher: ReturnType<typeof mockApi>, suffix: string) => fetcher.mock.calls.filter(c => String(c[0]).endsWith(suffix))

const id = '0b0b0b0b-0000-4000-8000-0000000000aa'
const proposal: AssistantProposal = {
  id, kind: 'reorganize', provider: 'local', status: 'pending', summary: '2 sessions placed', explanation: ['Missed work comes first.'], expires_at: '2027-03-23T10:00:00Z', applied_at: null, undo_until: null, results: null,
  actions: [
    { id: 'a1', type: 'create_event', title: 'Write report', starts_at: '2027-03-22T14:00:00Z', ends_at: '2027-03-22T15:00:00Z', minutes: 60, task_id: 5, source: 'missed', reason: 'You missed this session this morning.' },
    { id: 'a2', type: 'create_event', title: 'Pay invoice', starts_at: '2027-03-22T15:00:00Z', ends_at: '2027-03-22T15:30:00Z', minutes: 30, task_id: 6, source: 'due', reason: 'Due today and not booked yet.' },
    { id: 'a3', type: 'move_event', title: 'Read papers', event_id: 9, from_starts_at: '2027-03-22T16:00:00Z', from_ends_at: '2027-03-22T17:00:00Z', starts_at: '2027-03-23T09:00:00Z', ends_at: '2027-03-23T10:00:00Z', minutes: 60, source: 'overflow', reason: 'Moved to bring today under 80%.', conflicts: [] },
  ] as AssistantProposal['actions'],
}
const preview = { proposal, summary: 'I can place 2 sessions and move 1.', explanation: ['Urgent work is placed first.', 'Fixed events never move.'] }
const route = (body: unknown, status = 200): Route => ({ match: /\/api\/today\/reorganize$/, method: 'POST', body, status })
const applied = { ...proposal, status: 'applied', undo_until: '2027-03-23T10:00:00Z', results: [{ action_id: 'a2', type: 'create_event', event_id: 77 }] }

beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-03-22T12:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

describe('Reorganize my day: entry points', () => {
  it('shows the card only when something slipped, with the counts', () => {
    const { rerender } = render(page({ missed: 0, due_unscheduled: 0, overloaded: false }))
    expect(screen.queryByText(/Your day slipped/)).toBeNull()
    rerender(page(undefined)); expect(screen.queryByText(/Your day slipped/)).toBeNull()
    rerender(page({ missed: 2, due_unscheduled: 1, overloaded: false }))
    expect(screen.getByText('Your day slipped: 2 sessions missed, 1 task due without time. Reorganize?')).toBeInTheDocument()
    rerender(page({ missed: 0, due_unscheduled: 0, overloaded: true }))
    expect(screen.getByText(/the rest of today is overbooked/)).toBeInTheDocument()
    expect(hasSlipped({ missed: 1, due_unscheduled: 0, overloaded: false })).toBe(true)
  })

  it('always offers the permanent action, and opening the preview changes nothing', async () => {
    const fetcher = mockApi([route({ proposal: null, summary: 'Nothing has slipped.', explanation: [] })])
    render(page({ missed: 0, due_unscheduled: 0, overloaded: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Reorganize my day' }))
    expect(await screen.findByRole('dialog', { name: 'Reorganize my day' })).toBeInTheDocument()
    expect(await screen.findByText('Nothing has slipped.')).toBeInTheDocument()
    expect(fetcher.mock.calls.every(c => c[1]?.method === 'POST' && String(c[0]).endsWith('/api/today/reorganize'))).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('the card button opens the preview', async () => {
    mockApi([route(preview)])
    render(page({ missed: 1, due_unscheduled: 0, overloaded: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Reorganize' }))
    expect(await screen.findByText('I can place 2 sessions and move 1.')).toBeInTheDocument()
  })
})

describe('Reorganize my day: the preview', () => {
  async function open() {
    render(page({ missed: 1, due_unscheduled: 1, overloaded: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Reorganize my day' }))
    return await screen.findByRole('dialog', { name: 'Reorganize my day' })
  }

  it('shows the summary, the explanation, each action with its source label and reason, in 24 hours', async () => {
    mockApi([route(preview)])
    const dialog = await open()
    expect(await within(dialog).findByText('I can place 2 sessions and move 1.')).toBeInTheDocument()
    expect(within(dialog).getByText('Urgent work is placed first.')).toBeInTheDocument()
    expect(within(dialog).getByText('Fixed events never move.')).toBeInTheDocument()
    expect(within(dialog).getByText('Missed session')).toBeInTheDocument()
    expect(within(dialog).getByText('Due or overdue')).toBeInTheDocument()
    expect(within(dialog).getByText('Moved to lighten the day')).toBeInTheDocument()
    expect(within(dialog).getByText('You missed this session this morning.')).toBeInTheDocument()
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(3)
    expect(dialog.textContent).not.toMatch(/\b(AM|PM)\b/i)
    expect(within(dialog).getByText('Reorganized day')).toBeInTheDocument()
  })

  it('with nothing to do it shows the summary and a Close button, and Close closes', async () => {
    mockApi([route({ proposal: null, summary: 'Nothing has slipped.', explanation: ['Every task has a session.'] })])
    const dialog = await open()
    expect(await within(dialog).findByText('Every task has a session.')).toBeInTheDocument()
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    const close = within(dialog).getAllByRole('button', { name: 'Close' })
    fireEvent.click(close[close.length - 1])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('applies only the chosen actions through the assistant apply call, then refreshes Today, calendar and tasks', async () => {
    const fetcher = mockApi([route(preview), { match: /\/apply$/, method: 'POST', body: applied }])
    const tasks = vi.fn(), calendar = vi.fn()
    window.addEventListener(TASKS_CHANGED, tasks); window.addEventListener(CALENDAR_CHANGED, calendar)
    const dialog = await open()
    await within(dialog).findByText('Write report')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Write report/ }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Read papers/ }))
    expect(calls(fetcher, '/apply')).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: /Add 1 to calendar/ }))
    await waitFor(() => expect(calls(fetcher, `/api/assistant/proposals/${id}/apply`)).toHaveLength(1))
    expect(JSON.parse(calls(fetcher, '/apply')[0][1]!.body as string)).toEqual({ action_ids: ['a2'] })
    expect(await screen.findByText('1 change(s) applied to your calendar.')).toBeInTheDocument()
    expect(tasks).toHaveBeenCalledTimes(1); expect(calendar).toHaveBeenCalledTimes(1)
    window.removeEventListener(TASKS_CHANGED, tasks); window.removeEventListener(CALENDAR_CHANGED, calendar)
  })

  it('shows a 422 conflict as an error and refreshes nothing', async () => {
    mockApi([route(preview), { match: /\/apply$/, method: 'POST', status: 422, body: { message: 'That time was taken meanwhile.', conflict: { code: 'schedule_conflict' }, errors: { actions: ['taken'] } } }])
    const tasks = vi.fn(); window.addEventListener(TASKS_CHANGED, tasks)
    const dialog = await open()
    await within(dialog).findByText('Write report')
    fireEvent.click(within(dialog).getByRole('button', { name: /Add 3 to calendar|Apply 3 change/ }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That time was taken meanwhile.')
    expect(tasks).not.toHaveBeenCalled()
    window.removeEventListener(TASKS_CHANGED, tasks)
  })

  it('undo goes through the assistant undo call and refreshes again', async () => {
    const undone = { ...applied, status: 'undone', undo_until: null, results: [{ action_id: 'a2', type: 'create_event', event_id: 77, undo: { done: true } }] }
    const fetcher = mockApi([route(preview), { match: /\/apply$/, method: 'POST', body: applied }, { match: /\/undo$/, method: 'POST', body: undone }])
    const calendar = vi.fn(); window.addEventListener(CALENDAR_CHANGED, calendar)
    const dialog = await open()
    await within(dialog).findByText('Write report')
    fireEvent.click(within(dialog).getByRole('button', { name: /Apply 3 change|Add 3 to calendar/ }))
    fireEvent.click(await within(dialog).findByRole('button', { name: /Undo these changes/ }))
    expect(await screen.findByText('All changes undone.')).toBeInTheDocument()
    expect(calls(fetcher, `/api/assistant/proposals/${id}/undo`)).toHaveLength(1)
    expect(calendar).toHaveBeenCalledTimes(2)
    window.removeEventListener(CALENDAR_CHANGED, calendar)
  })

  it('"Not now" dismisses through the assistant call, closes, and refreshes nothing', async () => {
    const fetcher = mockApi([route(preview), { match: /\/dismiss$/, method: 'POST', body: { ...proposal, status: 'dismissed' } }])
    const tasks = vi.fn(); window.addEventListener(TASKS_CHANGED, tasks)
    const dialog = await open()
    await within(dialog).findByText('Write report')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls(fetcher, '/dismiss')).toHaveLength(1)
    expect(tasks).not.toHaveBeenCalled()
    window.removeEventListener(TASKS_CHANGED, tasks)
  })

  it('shows a failed preview in the error style and can try again', async () => {
    const fetcher = mockApi([route({ message: 'Too Many Attempts.' }, 429)])
    const dialog = await open()
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Too Many Attempts.')
    mockApi([route(preview)])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }))
    expect(await within(dialog).findByText('I can place 2 sessions and move 1.')).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('gives focus back to the button that opened it', async () => {
    mockApi([route({ proposal: null, summary: 'Nothing has slipped.', explanation: [] })])
    render(page())
    const opener = screen.getByRole('button', { name: 'Reorganize my day' })
    opener.focus(); fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('Nothing has slipped.')
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(opener).toHaveFocus()
  })
})

describe('Reorganize my day: Arabic and Dutch', () => {
  it('words the card in all three languages', () => {
    const hint = { missed: 2, due_unscheduled: 1, overloaded: false }
    const en = (a: string) => a
    expect(slippedText(hint, en)).toBe('Your day slipped: 2 sessions missed, 1 task due without time. Reorganize?')
    expect(slippedText(hint, (_e, ar) => ar)).toBe('انزلق يومك: 2 جلسات فائتة، 1 مهمة مستحقة بلا وقت. أعد التنظيم؟')
    expect(slippedText(hint, (_e, _a, nl) => nl ?? '')).toBe('Je dag is uitgelopen: 2 sessies gemist, 1 taak met deadline zonder tijd. Herorganiseren?')
  })

  it('renders the entry and the preview in Arabic, right to left', async () => {
    localStorage.setItem('lifeos-language', 'ar')
    mockApi([route(preview)])
    render(page({ missed: 1, due_unscheduled: 0, overloaded: false }))
    expect(document.documentElement.dir).toBe('rtl')
    expect(screen.getByText('انزلق يومك: 1 جلسة فائتة. أعد التنظيم؟')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'أعد التنظيم' }))
    const dialog = await screen.findByRole('dialog', { name: 'أعد تنظيم يومي' })
    expect(await within(dialog).findByText('جلسة فائتة')).toBeInTheDocument()
    expect(within(dialog).getByText('مستحقة أو متأخرة')).toBeInTheDocument()
    expect(within(dialog).getByText('نُقلت لتخفيف اليوم')).toBeInTheDocument()
  })

  it('renders the entry and the preview in Dutch', async () => {
    localStorage.setItem('lifeos-language', 'nl')
    mockApi([route(preview)])
    render(page({ missed: 1, due_unscheduled: 0, overloaded: false }))
    expect(screen.getByText('Je dag is uitgelopen: 1 sessie gemist. Herorganiseren?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Herorganiseer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Herorganiseer mijn dag' })
    expect(await within(dialog).findByText('Gemiste sessie')).toBeInTheDocument()
    expect(within(dialog).getByText('Aan de beurt of te laat')).toBeInTheDocument()
    expect(within(dialog).getByText('Verplaatst om de dag lichter te maken')).toBeInTheDocument()
    expect(within(dialog).getByText('Heringerichte dag')).toBeInTheDocument()
  })
})
