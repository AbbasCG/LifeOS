import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within, renderHook, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import axe from 'axe-core'
import { useState, type ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import { ScheduleConflictDialog } from '../components/ui/ScheduleConflictDialog'
import TasksPage from '../features/TasksPage'
import { useSessionFields } from '../features/tasks/sessionFields'
import { ApiError, type Availability } from '../lib/api'
import { conflictSentence, conflictTitle, parseConflict, type ScheduleConflict } from '../lib/scheduleConflict'
import { setAccountZone } from '../lib/accountDay'
import { CALENDAR_CHANGED } from '../lib/taskSchedule'
import { TASKS_CHANGED } from '../lib/quickAdd'

const ZONE = 'Europe/Amsterdam'
const NOW = '2026-11-11T10:00:00Z'   // Wednesday 11:00 in Amsterdam
const en = (a: string) => a
const ar = (_a: string, b: string) => b
const nl = (a: string, _b: string, c?: string) => c ?? a
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>

// Asked 09:15 to 09:45 local; "Write report" is 09:00 to 09:30; the first free time is 09:30 to 10:00.
const body = (over: Partial<ScheduleConflict> & { kind?: string } = {}) => ({
  message: 'The given data was invalid.', errors: { starts_at: ['overlap'] },
  conflict: { code: 'schedule_conflict', requested: { starts_at: '2026-11-12T08:15:00Z', ends_at: '2026-11-12T08:45:00Z' },
    conflicts: [{ id: 3, event_id: 3, task_id: 8, title: 'Write report', kind: over.kind ?? 'task_session', source: 'lifeos', starts_at: '2026-11-12T08:00:00Z', ends_at: '2026-11-12T08:30:00Z', overlap_minutes: 15 }],
    suggestion: 'suggestion' in over ? over.suggestion : { starts_at: '2026-11-12T08:30:00Z', ends_at: '2026-11-12T09:00:00Z' } },
})
const make = (over: Partial<ScheduleConflict> & { kind?: string } = {}) => parseConflict(new ApiError(422, 'x', {}, body(over)))!

beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals(); setAccountZone(ZONE); vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) }) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); setAccountZone(undefined) })

describe('reading the server’s answer', () => {
  it('accepts only the 422 schedule_conflict shape', () => {
    expect(make().conflicts).toHaveLength(1); expect(make().suggestion).toEqual({ starts_at: '2026-11-12T08:30:00Z', ends_at: '2026-11-12T09:00:00Z' })
    expect(parseConflict(new ApiError(422, 'x', { starts_at: ['bad'] }, { errors: {} }))).toBeNull()
    expect(parseConflict(new ApiError(409, 'x', {}, body()))).toBeNull()
    expect(parseConflict(new ApiError(422, 'x', {}, { conflict: { code: 'other' } }))).toBeNull()
    expect(parseConflict(new Error('boom'))).toBeNull(); expect(parseConflict(null)).toBeNull()
    expect(parseConflict(new ApiError(422, 'x', {}, { conflict: { code: 'schedule_conflict', requested: {}, conflicts: [] } }))).toBeNull()
  })
  it('keeps at most 5 conflicts and a null suggestion', () => {
    const raw = body(); const one = raw.conflict.conflicts[0]
    const c = parseConflict(new ApiError(422, 'x', {}, { conflict: { ...raw.conflict, conflicts: Array.from({ length: 8 }, (_, i) => ({ ...one, id: i })), suggestion: null } }))!
    expect(c.conflicts).toHaveLength(5); expect(c.suggestion).toBeNull()
  })
  it('words the problem in plain language with 24-hour times, in en, ar and nl', () => {
    const c = make()
    expect(conflictSentence(c, en, 'en', ZONE)).toBe("You can't schedule this task from 09:15 to 09:45, because you already have another task from 09:00 to 09:30.")
    expect(conflictSentence(c, ar, 'ar', ZONE)).toBe('لا يمكن جدولة هذه المهمة من 09:15 إلى 09:45، لأن لديك مهمة أخرى من 09:00 إلى 09:30.')
    expect(conflictSentence(c, nl, 'nl', ZONE)).toBe('Je kunt deze taak niet inplannen van 09:15 tot 09:45, omdat je al een andere taak hebt van 09:00 tot 09:30.')
    expect(conflictTitle(c, ar)).toBe('هذا الوقت محجوز بالفعل لمهمة أخرى.')
  })
  it('uses neutral wording when the other item is an event or an external one', () => {
    expect(conflictTitle(make({ kind: 'event' }), ar)).toBe('هذا الوقت محجوز بالفعل لمهمة أو موعد آخر.')
    expect(conflictTitle(make({ kind: 'external' }), en)).toBe('This time is already booked for another task or event.')
    expect(conflictSentence(make({ kind: 'event' }), ar, 'ar', ZONE)).toContain('لأن لديك موعدًا آخر من 09:00 إلى 09:30')
  })
})

describe('the conflict dialog', () => {
  function Harness({ conflict = make(), onChoose = vi.fn(), onUse, onClose }: { conflict?: ScheduleConflict; onChoose?: () => void; onUse?: (s: unknown) => void; onClose?: () => void }) {
    const [open, setOpen] = useState(false)
    return <><button onClick={() => setOpen(true)}>opener</button><button>other control</button>
      {open && <ScheduleConflictDialog conflict={conflict} onChoose={onChoose} onUseSuggestion={onUse} onClose={() => { onClose?.(); setOpen(false) }} />}</>
  }
  const show = async (props: Parameters<typeof Harness>[0] = {}) => { render(wrap(<Harness {...props} />)); const opener = screen.getByText('opener'); opener.focus(); fireEvent.click(opener); return { opener, dialog: await screen.findByRole('alertdialog') } }

  it('is a modal alertdialog with the title, the sentence, the conflict (title, day, 24h range, overlap) and the actions', async () => {
    const { dialog } = await show({ onUse: vi.fn() })
    expect(within(dialog).getByRole('heading')).toHaveTextContent('This time is already booked for another task.')
    expect(dialog).toHaveTextContent("You can't schedule this task from 09:15 to 09:45, because you already have another task from 09:00 to 09:30.")
    const item = within(dialog).getByRole('listitem')
    expect(item).toHaveTextContent('Write report'); expect(item).toHaveTextContent('Tomorrow'); expect(item).toHaveTextContent('09:00–09:30'); expect(item).toHaveTextContent('15 min overlap')
    expect(within(dialog).getByRole('button', { name: 'Choose another time' })).toHaveFocus()
    expect(within(dialog).getByRole('link', { name: 'View the conflicting item' })).toHaveAttribute('href', '/calendar?date=2026-11-12&session=3')
    expect(within(dialog).getByRole('button', { name: 'Suggest the first free time: 09:30–10:00' })).toBeInTheDocument()
    expect(dialog.querySelector('bdi')).not.toBeNull()   // times keep their own direction
  })
  it('lists up to five conflicts compactly and hides “View” for an external item', async () => {
    const raw = body({ kind: 'external' }), one = raw.conflict.conflicts[0]
    const c = parseConflict(new ApiError(422, 'x', {}, { conflict: { ...raw.conflict, conflicts: Array.from({ length: 6 }, (_, i) => ({ ...one, id: i, event_id: null, title: `Item ${i}` })) } }))!
    const { dialog } = await show({ conflict: c })
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(5)
    expect(within(dialog).queryByRole('link')).toBeNull()
  })
  it('offers the suggestion only when the server has one, and applies it once even on a double press', async () => {
    const use = vi.fn()
    const { dialog } = await show({ conflict: make({ suggestion: null }), onUse: use })
    expect(within(dialog).queryByRole('button', { name: /Suggest/ })).toBeNull()
    cleanup()
    const second = await show({ onUse: use })
    const button = within(second.dialog).getByRole('button', { name: /Suggest the first free time/ })
    fireEvent.click(button); fireEvent.click(button)
    expect(use).toHaveBeenCalledTimes(1); expect(use).toHaveBeenCalledWith({ starts_at: '2026-11-12T08:30:00Z', ends_at: '2026-11-12T09:00:00Z' })
  })
  it('Escape closes only this dialog and focus returns to the control that opened the flow', async () => {
    const onClose = vi.fn(), onChoose = vi.fn()
    const { opener, dialog } = await show({ onClose, onChoose })
    const cancel = new Event('cancel', { cancelable: true, bubbles: true }); fireEvent(dialog, cancel)
    expect(cancel.defaultPrevented).toBe(true)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(onClose).toHaveBeenCalledTimes(1); expect(onChoose).not.toHaveBeenCalled(); expect(opener).toHaveFocus()
  })
  it('“Choose another time” closes it, then hands focus to the caller', async () => {
    const onChoose = vi.fn()
    const { dialog } = await show({ onChoose })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose another time' }))
    await waitFor(() => expect(onChoose).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
  it('announces the problem once, politely, and does not describe itself a second time', async () => {
    const { dialog } = await show()
    expect(dialog).not.toHaveAttribute('aria-describedby')
    await waitFor(() => expect(document.querySelector('[data-announcer]')).toHaveTextContent("This time is already booked for another task. You can't schedule this task from 09:15 to 09:45"))
    expect(document.querySelectorAll('[data-announcer]')).toHaveLength(1)
  })
  it.each([['ar', 'rtl', 'هذا الوقت محجوز بالفعل لمهمة أخرى.', 'اختيار وقت آخر', 'اقتراح أول وقت متاح: 09:30–10:00', 'تداخل 15 دقيقة'],
    ['nl', 'ltr', 'Deze tijd is al gereserveerd voor een andere taak.', 'Kies een andere tijd', 'Eerste vrije tijd voorstellen: 09:30–10:00', '15 min overlap']])(
    'is complete in %s and has no accessibility violations', async (lang, dir, title, choose, suggest, overlap) => {
      localStorage.setItem('lifeos-language', lang)
      const { dialog } = await show({ onUse: vi.fn() })
      expect(document.documentElement.dir).toBe(dir)
      expect(within(dialog).getByRole('heading')).toHaveTextContent(title)
      expect(within(dialog).getByRole('button', { name: choose })).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: suggest })).toBeInTheDocument()
      expect(dialog).toHaveTextContent(overlap)
      const result = await axe.run(dialog, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
      expect(result.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)).toEqual([])
    })
})

describe('the fields of the scheduled time', () => {
  const schedule = { session_id: 55, starts_at: '2026-11-12T08:00:00Z', ends_at: '2026-11-12T08:30:00Z', sessions: 1, split: false }
  const hook = (task: Record<string, unknown>, estimate = 45) => renderHook(() => useSessionFields({ id: 7, ...task }, estimate), { wrapper: ({ children }) => wrap(children) })
  it('does nothing when untouched, for a scheduled and an unscheduled task', () => {
    expect(hook({ schedule }).result.current.plan()).toBeNull(); expect(hook({ schedule: null }).result.current.plan()).toBeNull()
  })
  it('the end defaults from the estimate when only a start is given, and follows the start by the same length', () => {
    const { result } = hook({ schedule: null })
    act(() => result.current.changeStart('2026-11-13T10:00'))
    expect(result.current.end).toBe('2026-11-13T10:45')
    expect(result.current.plan()).toEqual({ slot: { starts_at: '2026-11-13T09:00:00.000Z', ends_at: '2026-11-13T09:45:00.000Z' } })   // 10:00 to 10:45 on the account's (Amsterdam) clock, whatever the browser zone is
    const moved = hook({ schedule })
    act(() => moved.result.current.changeStart('2026-11-12T10:00'))
    expect(moved.result.current.end).toBe('2026-11-12T10:30')   // the session was 30 minutes long: it stays 30
  })
  it('clearing is not supported and says so; an end before the start is refused', () => {
    const { result } = hook({ schedule })
    act(() => { result.current.changeStart(''); result.current.changeEnd('') })
    expect(result.current.plan()).toMatchObject({ error: expect.stringContaining('cannot be cleared') })
    act(() => { result.current.changeStart('2026-11-12T10:00'); result.current.changeEnd('2026-11-12T09:00') })
    expect(result.current.plan()).toMatchObject({ error: expect.stringContaining('after the start') })
  })
})

type Reply = { status: number; body: unknown }
const task = (over: Record<string, unknown> = {}) => ({ id: 7, title: 'Pay the invoice', status: 'todo', priority: 'high', due_at: '2026-11-20T15:00:00Z', estimated_minutes: 30, schedule: null, ...over })
const free: Availability = { work_start: '09:00', work_end: '17:00', days: [{ date: '2026-11-11', work_day: true, free_minutes: 120, slots: [{ starts_at: '2026-11-11T13:00:00Z', ends_at: '2026-11-11T15:00:00Z', minutes: 120 }] }] }
type Call = [string, RequestInit | undefined]
function stub(tasks: unknown[], post: (n: number) => Reply = () => ({ status: 201, body: { data: { id: 99 }, schedule: { session_id: 99, starts_at: '2026-11-11T13:00:00Z', ends_at: '2026-11-11T13:30:00Z', sessions: 1, split: false } } })) {
  let n = 0
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const reply = (r: Reply) => new Response(JSON.stringify(r.body), { status: r.status })
    if (init?.method === 'POST' && /\/api\/tasks\/\d+\/schedule$/.test(url)) return reply(post(n++))
    const out = /\/api\/user$/.test(url) ? { id: 1, name: 'A', email: 'a@x.io', timezone: ZONE } : /\/api\/availability/.test(url) ? free : /\/api\/calendar/.test(url) ? { data: [] } : /\/api\/connected\/tasks/.test(url) ? [] : /\/api\/tasks/.test(url) ? { data: tasks, meta: { last_page: 1 } } : { data: [] }
    return new Response(JSON.stringify(out), { status: 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const calls = (f: ReturnType<typeof stub>, method: string, match?: RegExp) => (f.mock.calls as unknown as Call[]).filter(c => (c[1]?.method ?? 'GET') === method && (!match || match.test(String(c[0]))))

describe('the task row chips go through the same path', () => {
  const conflictReply = (): Reply => ({ status: 422, body: { ...body(), conflict: { ...body().conflict, requested: { starts_at: '2026-11-11T13:00:00Z', ends_at: '2026-11-11T13:30:00Z' }, suggestion: { starts_at: '2026-11-11T13:30:00Z', ends_at: '2026-11-11T14:00:00Z' } } } })
  it('a taken time opens the conflict dialog, creates nothing, refreshes the row, and the suggestion books once', async () => {
    const f = stub([task()], n => (n === 0 ? conflictReply() : { status: 201, body: { data: { id: 99 }, schedule: { session_id: 99, starts_at: '2026-11-11T13:30:00Z', ends_at: '2026-11-11T14:00:00Z', sessions: 1, split: false } } }))
    const tasks = vi.fn(), cal = vi.fn()
    window.addEventListener(TASKS_CHANGED, tasks); window.addEventListener(CALENDAR_CHANGED, cal)
    render(wrap(<TasksPage />))
    fireEvent.click(await screen.findByText('Pay the invoice'))
    const chips = await screen.findByRole('group', { name: 'Schedule' })
    fireEvent.click(within(chips).getAllByRole('button')[0])
    const dialog = await screen.findByRole('alertdialog')
    expect(calls(f, 'POST')).toHaveLength(1)
    expect(document.body.textContent).not.toMatch(/scheduled Today/)
    expect(tasks).toHaveBeenCalled(); expect(cal).toHaveBeenCalled()   // the task is read again after a refusal
    const use = within(dialog).getByRole('button', { name: /Suggest the first free time/ })
    fireEvent.click(use); fireEvent.click(use)
    await waitFor(() => expect(calls(f, 'POST')).toHaveLength(2))
    expect(JSON.parse(calls(f, 'POST')[1][1]!.body as string)).toEqual({ starts_at: '2026-11-11T13:30:00Z', ends_at: '2026-11-11T14:00:00Z' })
    expect((calls(f, 'POST')[1][1]!.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    await screen.findByText(/scheduled Today 14:30/)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(calls(f, 'POST')).toHaveLength(2)
    window.removeEventListener(TASKS_CHANGED, tasks); window.removeEventListener(CALENDAR_CHANGED, cal)
  })
  it('“Choose another time” returns focus to the time choices of that row', async () => {
    stub([task()], () => conflictReply())
    render(wrap(<TasksPage />))
    fireEvent.click(await screen.findByText('Pay the invoice'))
    fireEvent.click(within(await screen.findByRole('group', { name: 'Schedule' })).getAllByRole('button')[0])
    fireEvent.click(await screen.findByRole('button', { name: 'Choose another time' }))
    await waitFor(() => expect(document.activeElement?.closest('[data-sched-chips]')).not.toBeNull())
  })
})

describe('the task row says deadline and scheduled time apart', () => {
  const lines = (container: HTMLElement) => ({ due: container.querySelector('.meta-row .due')?.textContent ?? null, sched: container.querySelector('.sched-badge')?.textContent ?? null, minutes: container.querySelector('.sched-duration')?.textContent ?? null })
  it('shows «الاستحقاق: …» and «مجدولة: اليوم 14:00 – 14:30» as two lines, with the estimate separate', async () => {
    localStorage.setItem('lifeos-language', 'ar')
    stub([task({ due_at: '2026-11-11T16:00:00Z', schedule: { session_id: 5, starts_at: '2026-11-11T13:00:00Z', ends_at: '2026-11-11T13:30:00Z', sessions: 1, split: false } })])
    const { container } = render(wrap(<TasksPage />))
    await screen.findByText('Pay the invoice')
    const l = lines(container)
    expect(l.due).toContain('الاستحقاق:'); expect(l.due).toContain('اليوم 17:00')
    expect(l.sched).toContain('مجدولة:'); expect(l.sched).toContain('اليوم 14:00 – 14:30')
    expect(l.minutes).toContain('30 دقيقة')
  })
  it('shows the due line only when there is a deadline, and “tomorrow” only for the account’s real tomorrow', async () => {
    stub([task({ due_at: null, schedule: { session_id: 5, starts_at: '2026-11-11T23:30:00Z', ends_at: '2026-11-12T00:00:00Z', sessions: 1, split: false } })])
    const { container } = render(wrap(<TasksPage />))
    await screen.findByText('Pay the invoice')
    const l = lines(container)
    expect(l.due).toBeNull()
    expect(l.sched).toContain('Tomorrow 00:30 – 01:00')   // 00:30 on the 12th in Amsterdam is tomorrow, though it is 23:30 UTC today
  })
})
