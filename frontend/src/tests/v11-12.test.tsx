import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { PlanCard } from '../features/assistant/PlanCard'
import DayPlanPage from '../features/today/DayPlanPage'
import { AuthProvider } from '../contexts/AuthContext'
import { ProposalCard } from '../features/assistant/ProposalCard'
import type { AssistantProposal } from '../lib/api'
import type { CopilotPlan } from '../lib/copilot'

const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals() })

const plan = (moves: CopilotPlan['moves']): CopilotPlan => ({ kind: 'plan_week', title: 'Plan for 26 Oct – 1 Nov', explanation: [], conflicts: [], alternatives: [{ key: 'balanced', label: 'Everything, by priority', current: true }], impact: { blocks: 2, planned_minutes: 120, moved_events: moves?.count ?? 0 }, moves })
const proposal: AssistantProposal = {
  id: '11111111-2222-4333-8444-555555555555', kind: 'plan_week', provider: 'local', status: 'pending', summary: 'Suggested 1 new block(s) and 1 move(s).', explanation: [], results: null, expires_at: '2027-01-05T10:00:00Z', applied_at: null,
  actions: [
    { id: 'a1', type: 'move_event', event_id: 4, title: 'Write report', from_starts_at: '2026-10-27T12:00:00Z', from_ends_at: '2026-10-27T14:00:00Z', starts_at: '2026-10-28T08:00:00Z', ends_at: '2026-10-28T10:00:00Z', minutes: 120, reason: '“Write report” is flexible, and 2026-10-28 is lighter (10%).', conflicts: [] },
    { id: 'a2', type: 'create_event', title: 'Budget', task_id: 3, starts_at: '2026-10-29T08:00:00Z', ends_at: '2026-10-29T09:00:00Z', minutes: 60 },
  ],
}

describe('plans that move flexible blocks', () => {
  it('says what moves and lets the user keep everything in place', () => {
    const choose = vi.fn()
    render(wrap(<PlanCard plan={plan({ allowed: true, count: 1, available: 1 })} onAlternative={choose} />))
    expect(screen.getByText(/1 flexible block\(s\) move\. Fixed, recurring and connected events never move/)).toBeInTheDocument()
    expect(screen.getByText('Events moved').nextSibling?.textContent).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: 'Keep everything in place' }))
    expect(choose).toHaveBeenCalledWith('moves:off')
  })

  it('offers to allow moves again, and stays quiet when nothing would move', () => {
    const choose = vi.fn()
    const { rerender } = render(wrap(<PlanCard plan={plan({ allowed: false, count: 0, available: 2 })} onAlternative={choose} />))
    expect(screen.getByText('Nothing moves: every existing event stays where it is.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Move flexible blocks if needed' }))
    expect(choose).toHaveBeenCalledWith('moves:on')
    rerender(wrap(<PlanCard plan={plan({ allowed: true, count: 0, available: 0 })} onAlternative={choose} />))
    expect(screen.queryByRole('button', { name: 'Keep everything in place' })).not.toBeInTheDocument()
  })

  it('previews each move with its reason and conflict check, and applies only the chosen changes', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...proposal, status: 'applied', results: [{ action_id: 'a1', type: 'move_event', event_id: 4 }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    render(wrap(<ProposalCard proposal={proposal} />))
    expect(screen.getByText('Proposed week plan')).toBeInTheDocument()
    expect(screen.getByText('Moves an existing block')).toBeInTheDocument()
    expect(screen.getByText(/is flexible, and 2026-10-28 is lighter/)).toBeInTheDocument()
    expect(screen.getByText('No conflicts at the new time')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Apply 2 change\(s\)/ })).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    fireEvent.click(screen.getByRole('button', { name: /Move 1 to calendar/ }))
    const apply = () => (fetcher.mock.calls as unknown as [string, RequestInit | undefined][]).find(c => String(c[0]).endsWith('/apply'))
    await waitFor(() => expect(apply()).toBeDefined())
    expect(JSON.parse(apply()![1]!.body as string)).toEqual({ action_ids: ['a1'] })
  })

  it('warns about overlaps found by the preview', () => {
    render(wrap(<ProposalCard proposal={{ ...proposal, actions: [{ ...proposal.actions[0], conflicts: [{ title: 'Team sync', source_label: 'Google', starts_at: '', ends_at: '', minutes: 30 }] }] }} />))
    expect(screen.getByText('Overlaps: Team sync (Google)')).toBeInTheDocument()
  })
})

describe('study and personal focus (V12)', () => {
  const dayPlan = { date: '2027-03-23', timezone: 'UTC', replan: false, energy: null, estimate_ratio: 1, recommended: 'balanced', budget: { window_minutes: 480, committed_minutes: 0, free_minutes: 480, capacity_minutes: 480, must_do_minutes: 0, buffer_minutes: 10 }, boundaries: {}, peak: null, commitments: [], overload: null, recovery: [], explanation: [], alternatives: [{ key: 'balanced', title: { en: 'Balanced', ar: '' }, description: { en: 'Mixed.', ar: '' }, items: [], warnings: [], breaks: [], metrics: { planned_minutes: 0, tasks: 0, switches: 0, load_percent: 0, unscheduled_must_do: 0 }, explanation: [] }] }

  it('saves daily limits for study and personal windows, empty meaning no limit', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const body = /\/api\/user$/.test(url) ? { id: 1, name: 'A', email: 'a@x.io' } : /\/api\/day-plan\?/.test(url) ? dayPlan : /\/api\/settings$/.test(url) ? (init?.method === 'PUT' ? {} : { study_start: '19:00', study_end: '21:00', study_daily_limit: 60, buffer_minutes: 10 }) : {}
      return new Response(JSON.stringify(body), { status: 200 })
    })
    vi.stubGlobal('fetch', fetcher)
    render(wrap(<DayPlanPage />))
    fireEvent.click(await screen.findByRole('button', { name: 'Boundaries and buffers' }))
    expect(await screen.findByLabelText('Study limit per day (min)')).toHaveValue(60)
    expect(screen.getByLabelText('Personal limit per day (min)')).toHaveValue(null)
    fireEvent.change(screen.getByLabelText('Study limit per day (min)'), { target: { value: '90' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save boundaries' }))
    await waitFor(() => expect(fetcher.mock.calls.some(c => (c[1] as RequestInit | undefined)?.method === 'PUT')).toBe(true))
    const put = fetcher.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'PUT')!
    expect(JSON.parse((put[1] as RequestInit).body as string)).toMatchObject({ study_start: '19:00', study_daily_limit: 90, personal_daily_limit: null })
  })

  it('offers switching a focus plan between working, study and personal time', () => {
    const choose = vi.fn()
    const focus: CopilotPlan = { kind: 'focus_blocks', title: 'Focus blocks', explanation: ['Blocks are spread across different days first, inside your study hours.'], conflicts: [], impact: { blocks: 2, planned_minutes: 120, days: 2, moved_events: 0 },
      alternatives: [{ key: 'default', label: 'Usual length', current: true }, { key: 'area:work', label: 'In working hours', current: false }, { key: 'area:study', label: 'In study hours', current: true }] }
    render(wrap(<PlanCard plan={focus} onAlternative={choose} />))
    expect(screen.getByRole('button', { name: 'In study hours' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'In working hours' }))
    expect(choose).toHaveBeenCalledWith('area:work')
  })
})
