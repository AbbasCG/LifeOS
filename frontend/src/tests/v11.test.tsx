import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { PlanCard } from '../features/assistant/PlanCard'
import { ProposalCard } from '../features/assistant/ProposalCard'
import type { AssistantProposal } from '../lib/api'
import type { CopilotPlan } from '../lib/copilot'

const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider>{children}</ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
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
    await waitFor(() => expect(fetcher).toHaveBeenCalled())
    expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ action_ids: ['a1'] })
  })

  it('warns about overlaps found by the preview', () => {
    render(wrap(<ProposalCard proposal={{ ...proposal, actions: [{ ...proposal.actions[0], conflicts: [{ title: 'Team sync', source_label: 'Google', starts_at: '', ends_at: '', minutes: 30 }] }] }} />))
    expect(screen.getByText('Overlaps: Team sync (Google)')).toBeInTheDocument()
  })
})
