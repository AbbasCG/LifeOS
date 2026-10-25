import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import AiControlCenter from '../features/settings/AiControlCenter'
import type { IntelligenceSettingsData } from '../lib/intelligence'

beforeEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

const data: IntelligenceSettingsData = {
  settings: { enabled: true, features: { briefing: true, recommendations: true, weekly: true, planner: true, ai_narrative: false, conversation_personalization: false, plan_learning: true, goal_reviews: false }, sources: { calendar: true, connected: true, goals: true, habits: true, focus: true, checkins: true }, frequency: 'quiet', personalization: false, retention_days: 90, planning_strategy: null },
  options: { retention_days: [30, 90, 180], strategies: ['balanced', 'deep', 'light', 'deadlines'] },
  external_ai: { allowed: true, connected_data: false, provider: null, in_use: false }, counts: { recommendations: 0, feedback: 0, proposals: 0 },
  learning: { thresholds: { count: 3, share: 0.6, half_life_days: 30, max_age_days: 180 }, dimensions: [
    { dimension: 'day_strategy', counts: { deep: 3, light: 3 }, total: 6, shares: { deep: 50, light: 50 }, preferred: null, contexts: [{ scope: 'low_energy', preferred: 'light' }, { scope: 'high_energy', preferred: 'deep' }] },
  ] },
}

const page = () => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider><AuthProvider><AiControlCenter /></AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
const stubAll = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  const body = /\/api\/user$/.test(url) ? { id: 1, name: 'A', email: 'a@x.io' } : /intelligence\/settings$/.test(url) ? data : /intelligence\/activity$/.test(url) ? { proposals: [], recommendations: [], events: [] } : undefined
  return new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 404 : 200 })
}))

describe('energy-aware plan learning', () => {
  it('names energy situations and explains where energy comes from', async () => {
    localStorage.setItem('lifeos-language', 'en')
    stubAll()
    render(page())
    expect(await screen.findByText('Low energy: Light day')).toBeInTheDocument()
    expect(screen.getByText('High energy: Deep focus')).toBeInTheDocument()
    expect(screen.getByText(/on low- or high-energy days \(from today’s check-in\)/)).toBeInTheDocument()
  })

  it('names them in Arabic', async () => {
    localStorage.setItem('lifeos-language', 'ar')
    stubAll()
    render(page())
    expect(await screen.findByText('طاقة منخفضة: يوم خفيف')).toBeInTheDocument()
    expect(screen.getByText('طاقة مرتفعة: تركيز عميق')).toBeInTheDocument()
  })
})
