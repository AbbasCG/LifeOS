import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import { RecommendationCard } from '../features/intelligence/RecommendationCard'
import AiControlCenter from '../features/settings/AiControlCenter'
import type { IntelligenceSettingsData, Recommendation } from '../lib/intelligence'

type Call = [string, RequestInit | undefined]
function stub(handler: (url: string, init?: RequestInit) => unknown) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => { const body = handler(url, init); return new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 404 : 200 }) })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname + l.search}</p> }
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={['/']}><ToastProvider><AuthProvider>
  <Routes><Route path="/" element={children} /><Route path="/assistant" element={<Where />} /></Routes>
</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals() })

const rec: Recommendation = { id: 7, type: 'deadline', severity: 'high', status: 'active', feedback: null, title: { en: '“Board deck” is due Tue 18:00', ar: '' }, detail: { en: 'No time is set aside for it yet.', ar: '' },
  confidence: 'high', sources: ['tasks'], evidence: {}, action: { kind: 'proposal', proposal: 'find_time', task_ids: [3], label: { en: 'Find time', ar: '' } }, proposal_id: null, first_seen_at: '2027-03-23T07:00:00Z' }

describe('suggestions in Copilot', () => {
  it('opens a suggestion as a Copilot conversation in the current language', async () => {
    const fetcher = stub(url => /\/api\/user$/.test(url) ? { id: 1, name: 'A', email: 'a@x.io' } : /discuss$/.test(url) ? { conversation: { id: 'c0ffee00-0000-4000-8000-000000000014' } } : undefined)
    render(wrap(<ul><RecommendationCard rec={rec} onChange={vi.fn()} /></ul>))
    fireEvent.click(screen.getByRole('button', { name: 'Ask Copilot' }))
    expect(await screen.findByTestId('where')).toHaveTextContent('/assistant?c=c0ffee00-0000-4000-8000-000000000014')
    const post = (fetcher.mock.calls as unknown as Call[]).find(c => c[0].endsWith('/api/recommendations/7/discuss'))!
    expect(JSON.parse(post[1]!.body as string)).toEqual({ language: 'en' })
  })
})

describe('plan learning controls', () => {
  const data: IntelligenceSettingsData = {
    settings: { enabled: true, features: { briefing: true, recommendations: true, weekly: true, planner: true, ai_narrative: false, conversation_personalization: false, plan_learning: true, goal_reviews: false }, sources: { calendar: true, connected: true, goals: true, habits: true, focus: true, checkins: true }, frequency: 'quiet', personalization: false, retention_days: 90, planning_strategy: null },
    options: { retention_days: [30, 90, 180], strategies: ['balanced', 'deep', 'light', 'deadlines'] },
    external_ai: { allowed: true, connected_data: false, provider: null, in_use: false }, counts: { recommendations: 0, feedback: 0, proposals: 0 },
    learning: { thresholds: { count: 3, share: 0.6 }, dimensions: [{ dimension: 'week_version', counts: { essentials: 3, balanced: 1 }, total: 4, preferred: 'essentials' }, { dimension: 'focus_length', counts: { long: 1 }, total: 1, preferred: null }] },
  }

  it('shows what was learned, toggles learning and forgets it', async () => {
    const fetcher = stub((url, init) => {
      if (/\/api\/user$/.test(url)) return { id: 1, name: 'A', email: 'a@x.io' }
      if (/intelligence\/settings$/.test(url)) return init?.method === 'PUT' ? { settings: data.settings } : data
      if (/intelligence\/activity$/.test(url)) return { proposals: [], recommendations: [], events: [] }
      if (/intelligence\/learning$/.test(url)) return { cleared: 5 }
      return undefined
    })
    render(wrap(<AiControlCenter />))
    expect(await screen.findByText('Week plans')).toBeInTheDocument()
    expect(screen.getByText('Essentials 3 · Everything 1')).toBeInTheDocument()
    expect(screen.getByText('Default: Essentials')).toBeInTheDocument()
    expect(screen.getByText('No clear preference yet')).toBeInTheDocument()
    expect(screen.getByLabelText('Learn my preferred plan versions')).toBeChecked()

    fireEvent.click(screen.getByLabelText('Learn my preferred plan versions'))
    await waitFor(() => expect((fetcher.mock.calls as unknown as Call[]).some(c => c[1]?.method === 'PUT' && JSON.parse(c[1].body as string).features?.plan_learning === false)).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Forget learned preferences' }))
    await waitFor(() => expect((fetcher.mock.calls as unknown as Call[]).some(c => c[0].endsWith('/api/intelligence/learning') && c[1]?.method === 'DELETE')).toBe(true))
  })
})
