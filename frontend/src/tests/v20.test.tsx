import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import QuickAdd from '../components/layout/QuickAdd'
import { dueFor, openQuickAdd, TASKS_CHANGED } from '../lib/quickAdd'
import { DueChip, Expandable, PriorityMark, ProgressRing } from '../components/visual'
import { ProposalCard } from '../features/assistant/ProposalCard'
import type { AssistantProposal } from '../lib/api'

const wrap = (children: ReactNode, path = '/') => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[path]}><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals() })

type Call = [string, RequestInit | undefined]
const stub = () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const body = /\/api\/user$/.test(url) ? { id: 1, name: 'A', email: 'a@x.io' } : init?.method === 'POST' ? { data: { id: 5 } } : {}
    return new Response(JSON.stringify(body), { status: init?.method === 'POST' ? 201 : 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const posted = (fetcher: ReturnType<typeof stub>) => (fetcher.mock.calls as unknown as Call[]).filter(c => c[1]?.method === 'POST' && String(c[0]).endsWith('/api/tasks'))

describe('quick add', () => {
  it('turns the quick choices into a due date', () => {
    const now = new Date(2027, 2, 10, 9, 30) // a Wednesday
    expect(dueFor('none', now)).toBeNull()
    expect(new Date(dueFor('today', now)!)).toEqual(new Date(2027, 2, 10, 17, 0))
    expect(new Date(dueFor('tomorrow', now)!)).toEqual(new Date(2027, 2, 11, 17, 0))
    expect(new Date(dueFor('week', now)!)).toEqual(new Date(2027, 2, 14, 17, 0))
  })

  it('adds a task with one line and two taps, and tells lists to refresh', async () => {
    const fetcher = stub(), changed = vi.fn()
    window.addEventListener(TASKS_CHANGED, changed)
    render(wrap(<QuickAdd />))
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => openQuickAdd())
    fireEvent.change(await screen.findByRole('textbox', { name: 'Task' }), { target: { value: 'Call the bank' } })
    fireEvent.click(screen.getByRole('radio', { name: /Tomorrow/ }))
    fireEvent.click(screen.getByRole('radio', { name: /High/ }))
    fireEvent.click(screen.getByRole('button', { name: /Add task/ }))
    await waitFor(() => expect(posted(fetcher)).toHaveLength(1))
    const body = JSON.parse(posted(fetcher)[0][1]!.body as string)
    expect(body).toMatchObject({ title: 'Call the bank', priority: 'high', status: 'todo' })
    expect(new Date(body.due_at).getHours()).toBe(17)
    await waitFor(() => expect(changed).toHaveBeenCalled())
    window.removeEventListener(TASKS_CHANGED, changed)
  })

  it('opens from the installed app shortcut', async () => {
    stub()
    render(wrap(<QuickAdd />, '/?add=task'))
    expect(await screen.findByRole('textbox', { name: 'Task' })).toBeInTheDocument()
  })

  it('says so when offline and does not try to save', async () => {
    const fetcher = stub()
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(wrap(<QuickAdd />))
    act(() => openQuickAdd())
    fireEvent.change(await screen.findByRole('textbox', { name: 'Task' }), { target: { value: 'Pay rent' } })
    expect(screen.getByText(/You’re offline\. Nothing is saved until you reconnect\./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add task/ })).toBeDisabled()
    expect(posted(fetcher)).toHaveLength(0)
    vi.restoreAllMocks()
  })
})

describe('visual building blocks', () => {
  it('speaks rings, priorities and deadlines instead of relying on color', () => {
    const late = new Date(Date.now() - 3 * 86400000).toISOString()
    render(wrap(<><ProgressRing value={3} max={4} label="Tasks: 3 of 4" /><PriorityMark priority="urgent" /><DueChip due={late} /></>))
    expect(screen.getByRole('img', { name: 'Tasks: 3 of 4' })).toBeInTheDocument()
    expect(screen.getByText('Urgent')).toHaveClass('sr-only')
    expect(screen.getByText('3d late')).toBeInTheDocument()
  })

  it('renders details only when opened', async () => {
    render(wrap(<Expandable summary="More for today"><p>Hidden detail</p></Expandable>))
    expect(screen.queryByText('Hidden detail')).toBeNull()
    fireEvent.click(screen.getByText('More for today'))
    expect(await screen.findByText('Hidden detail')).toBeInTheDocument()
  })
})

describe('AI proposals at a glance', () => {
  const event = (id: string, day: number, hour: number) => ({ id, type: 'create_event' as const, title: `Block ${id}`, task_id: 1, starts_at: new Date(2027, 2, day, hour).toISOString(), ends_at: new Date(2027, 2, day, hour + 1).toISOString(), minutes: 60 })
  const proposal: AssistantProposal = {
    id: '11111111-2222-4333-8444-555555555555', kind: 'plan_week', provider: 'local', status: 'pending', summary: 'Suggested 4 new block(s) and 1 move(s).', explanation: ['Deadlines first.'], results: null, expires_at: '2027-03-20T10:00:00Z', applied_at: null,
    actions: [
      event('b', 9, 14), event('a', 8, 9), event('c', 9, 9), event('d', 10, 9),
      { id: 'm', type: 'move_event', event_id: 4, title: 'Write report', from_starts_at: new Date(2027, 2, 8, 12).toISOString(), from_ends_at: new Date(2027, 2, 8, 13).toISOString(), starts_at: new Date(2027, 2, 11, 8).toISOString(), ends_at: new Date(2027, 2, 11, 9).toISOString(), minutes: 60, reason: 'Thursday is lighter.', conflicts: [{ title: 'Gym', source_label: 'Google', starts_at: new Date(2027, 2, 11, 8).toISOString(), ends_at: new Date(2027, 2, 11, 9).toISOString(), minutes: 60 }] },
    ],
  }

  it('leads with counts, lists moves first and groups new blocks by day', () => {
    stub()
    const { container } = render(wrap(<ProposalCard proposal={proposal} />))
    expect(screen.getByText('4 new')).toBeInTheDocument()
    expect(screen.getByText('1 move(s)')).toBeInTheDocument()
    expect(screen.getByText('4h')).toBeInTheDocument()
    expect(screen.getByText('1 overlap(s)')).toBeInTheDocument()
    const groups = [...container.querySelectorAll('.proposal-day')].map(h => h.firstChild?.textContent)
    expect(groups).toHaveLength(4)
    expect(groups[0]).toBe('Moves')
    // The first row is the move, then new blocks in time order.
    const titles = [...container.querySelectorAll('.proposal-title')].map(n => n.textContent)
    expect(titles).toEqual(['Write report', 'Block a', 'Block c', 'Block b', 'Block d'])
    // Every item is still selected by default; why a block moves is one tap away; the overlap stays visible.
    expect(screen.getAllByRole('checkbox').every(b => (b as HTMLInputElement).checked)).toBe(true)
    expect(screen.getByText('Why').closest('details')).not.toHaveAttribute('open')
    expect(screen.getByText(/Overlaps/)).toBeInTheDocument()
    expect(screen.getByText('Why this plan').closest('details')).not.toHaveAttribute('open')
    expect(screen.getByText('Nothing changes until you approve. Times are re-checked when you apply.')).toBeInTheDocument()
  })
})
