import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import AiControlCenter from '../features/settings/AiControlCenter'
import type { IntelligenceSettingsData } from '../lib/intelligence'

type Call = [string, RequestInit | undefined]
function stub(handler: (url: string, init?: RequestInit) => unknown) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => { const body = handler(url, init); return new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 404 : 200 }) })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
beforeEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

const data: IntelligenceSettingsData = {
  settings: { enabled: true, features: { briefing: true, recommendations: true, weekly: true, planner: true, ai_narrative: false, conversation_personalization: false, plan_learning: true }, sources: { calendar: true, connected: true, goals: true, habits: true, focus: true, checkins: true }, frequency: 'quiet', personalization: false, retention_days: 90, planning_strategy: null },
  options: { retention_days: [30, 90, 180], strategies: ['balanced', 'deep', 'light', 'deadlines'] },
  external_ai: { allowed: true, connected_data: false, provider: null, in_use: false }, counts: { recommendations: 0, feedback: 0, proposals: 0 },
  learning: { thresholds: { count: 3, share: 0.6, half_life_days: 30, max_age_days: 180 }, dimensions: [
    { dimension: 'day_strategy', counts: { deep: 3, light: 3 }, total: 6, shares: { deep: 50, light: 50 }, preferred: null, contexts: [{ scope: 'workday', preferred: 'deep' }, { scope: 'day_off', preferred: 'light' }] },
    { dimension: 'week_version', counts: { essentials: 3, balanced: 3 }, total: 6, shares: { essentials: 6, balanced: 94 }, preferred: 'balanced', contexts: [] },
  ] },
}

const render$ = (language: 'en' | 'ar') => {
  localStorage.setItem('lifeos-language', language)
  return stub((url, init) => {
    if (/\/api\/user$/.test(url)) return { id: 1, name: 'A', email: 'a@x.io' }
    if (/intelligence\/settings$/.test(url)) return init?.method === 'PUT' ? { settings: data.settings } : data
    if (/intelligence\/activity$/.test(url)) return { proposals: [], recommendations: [], events: [] }
    if (/intelligence\/learning/.test(url)) return { cleared: 6 }
    return undefined
  })
}
const page = () => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider><AuthProvider><AiControlCenter /></AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>

describe('situation-aware plan learning', () => {
  it('shows defaults per situation, recent shares, and forgets one choice', async () => {
    const fetcher = render$('en')
    render(page())
    expect(await screen.findByText('Workdays: Deep focus')).toBeInTheDocument()
    expect(screen.getByText('Days off: Light day')).toBeInTheDocument()
    expect(screen.getByText('Essentials 3 (6% recent) · Everything 3 (94% recent)')).toBeInTheDocument()
    expect(screen.getByText('Default: Everything')).toBeInTheDocument()
    // A choice with only situation defaults does not claim there is no preference.
    expect(screen.queryByText('No clear preference yet')).not.toBeInTheDocument()
    expect(screen.getByText(/a choice counts half after 30 days and is forgotten after 180/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Forget learned day strategy' }))
    await waitFor(() => expect((fetcher.mock.calls as unknown as Call[]).some(c => c[0].endsWith('/api/intelligence/learning?dimension=day_strategy') && c[1]?.method === 'DELETE')).toBe(true))
  })

  it('names situations in Arabic', async () => {
    render$('ar')
    render(page())
    expect(await screen.findByText('أيام العمل: تركيز عميق')).toBeInTheDocument()
    expect(screen.getByText('أيام العطلة: يوم خفيف')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'انسَ ما تعلّمته عن استراتيجية اليوم' })).toBeInTheDocument()
  })
})
