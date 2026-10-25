import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import { ProgressPanel } from '../features/progress/ProgressPanel'

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
beforeEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

const goal = { id: 4, title: 'Run a marathon', color: '#7c3aed', percent: 40, expected_percent: 30, days_left: 150, status: 'on_track', reasons: [{ en: '40% done with 30% of the time used.', ar: 'أُنجز ٤٠٪.' }],
  milestones: { done: 1, total: 2, next: 'Half marathon' }, tasks: { open: 1, done: 1, overdue: 0 }, trend: { recent: 1, previous: 0, direction: 'up' }, focus_minutes_30d: 45,
  next_actions: [], suggested_tasks: [], recommendations: [] }
const handler = (url: string) => {
  if (/\/api\/user$/.test(url)) return { id: 1, name: 'A', email: 'a@x.io' }
  if (/insights\/progress$/.test(url)) return { goals: [goal], projects: [], habits: [] }
  if (/goals\/4\/review$/.test(url)) return { conversation: { id: 'ab12ab12-0000-4000-8000-000000000018' } }
  return undefined
}

describe('goal reviews', () => {
  it('reviews a goal for this month in Copilot', async () => {
    localStorage.setItem('lifeos-language', 'en')
    const fetcher = stub(handler)
    render(wrap(<ProgressPanel resource="goals" />))
    fireEvent.click(await screen.findByRole('button', { name: 'Review “Run a marathon” this month' }))
    expect(await screen.findByTestId('where')).toHaveTextContent('/assistant?c=ab12ab12-0000-4000-8000-000000000018')
    const post = (fetcher.mock.calls as unknown as Call[]).find(c => c[0].endsWith('/api/goals/4/review'))!
    expect(post[1]?.method).toBe('POST')
    expect(JSON.parse(post[1]!.body as string)).toEqual({ language: 'en' })
  })

  it('offers the review in Arabic', async () => {
    localStorage.setItem('lifeos-language', 'ar')
    stub(handler)
    render(wrap(<ProgressPanel resource="goals" />))
    expect(await screen.findByRole('button', { name: 'راجع «Run a marathon» لهذا الشهر' })).toHaveTextContent('مراجعة هذا الشهر')
  })
})
