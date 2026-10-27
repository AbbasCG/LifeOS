import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { FocusToday } from '../features/today/FocusToday'
import { TodayCustomizer } from '../features/today/TodayCustomizer'

type Call = [string, RequestInit | undefined]
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider>{children}</ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals() })

function stub(stats: Record<string, unknown>) {
  let current = stats
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') { current = { ...current, goal_minutes: JSON.parse(init.body as string).daily_focus_goal }; return new Response('{}', { status: 200 }) }
    if (/focus-sessions\/today$/.test(url)) return new Response(JSON.stringify(current), { status: 200 })
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('focus on Today', () => {
  it('shows minutes against the goal, both streaks and the best hour', async () => {
    stub({ today_minutes: 45, goal_minutes: 90, goal_streak_days: 3, streak_days: 5, best_hour: 9, best_hour_minutes: 300 })
    render(wrap(<FocusToday />))
    expect(await screen.findByRole('img', { name: '45 of 90 minutes' })).toBeInTheDocument()
    expect(screen.getByText('5-day focus streak')).toBeInTheDocument()
    expect(screen.getByText('Goal met 3 day(s) in a row')).toBeInTheDocument()
    expect(screen.getByText(/Best hour: 09:00/)).toBeInTheDocument()
  })

  it('invites a goal when there is none, and saves one in a tap', async () => {
    const fetcher = stub({ today_minutes: 0, goal_minutes: null, goal_streak_days: 0, streak_days: 0, best_hour: null, best_hour_minutes: 0 })
    render(wrap(<FocusToday />))
    expect(await screen.findByText('Set a goal')).toBeInTheDocument()
    expect(screen.getByText('No streak yet')).toBeInTheDocument()
    expect(screen.queryByText(/Best hour/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Set a daily goal/ }))
    fireEvent.click(await screen.findByRole('radio', { name: '1h' }))
    await waitFor(() => expect((fetcher.mock.calls as unknown as Call[]).some(c => c[1]?.method === 'PUT')).toBe(true))
    const put = (fetcher.mock.calls as unknown as Call[]).find(c => c[1]?.method === 'PUT')!
    expect(JSON.parse(put[1]!.body as string)).toEqual({ daily_focus_goal: 60 })
    expect(await screen.findByText('60 min to go')).toBeInTheDocument()
  })

  it('says when today’s goal is met', async () => {
    stub({ today_minutes: 95, goal_minutes: 90, goal_streak_days: 0, streak_days: 1, best_hour: 14, best_hour_minutes: 95 })
    render(wrap(<FocusToday />))
    expect(await screen.findByText('Goal met today')).toBeInTheDocument()
  })
})

describe('the focus section in Customize Today', () => {
  it('is listed but hidden until the user shows it', () => {
    render(wrap(<TodayCustomizer saved={{}} device="phone" onClose={() => {}} onSaved={() => {}} />))
    expect(screen.getByRole('button', { name: 'Show Focus' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /Reset/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Show Focus' }))
    expect(screen.getByRole('button', { name: 'Hide Focus' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Reset/ })).toBeEnabled()
  })
})
