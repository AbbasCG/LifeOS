import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import Dashboard from '../features/Dashboard'
import { TodayCustomizer } from '../features/today/TodayCustomizer'
import { normalizeToday, TODAY_SECTIONS, type TodayLayout } from '../lib/todayLayout'
import type { Briefing } from '../lib/api'

type Call = [string, RequestInit | undefined]
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals() })

const briefing: Briefing = {
  date: '2027-01-04', timezone: 'UTC', period: 'afternoon',
  stats: { completed_today: 2, focus_minutes_today: 50, open_tasks: 4, overdue_tasks: 1, available_minutes: 480, booked_minutes: 120, load_percent: 25 },
  focus: [{ id: 7, title: 'Ship the report', priority: 'urgent', status: 'todo', estimated_minutes: 45, due_at: null, score: 70, reasons: ['urgent'] }],
  agenda: [], next_event: null,
  habits: [{ id: 3, title: 'Read', color: '#6366f1', recurrence: 'daily', current_streak: 4, longest_streak: 9, done_today: false, done_this_period: false, at_risk: false }],
  goals: [], suggestions: [{ type: 'warning', en: 'You have 1 overdue task(s).', ar: '', action: '/tasks?due=overdue' }],
}
const stub = (layout?: TodayLayout) => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const body = /\/api\/user$/.test(url) ? { id: 1, name: 'Abbas Test', email: 'a@x.io' } : /\/api\/briefing$/.test(url) ? briefing : /\/api\/settings$/.test(url) ? { language: 'en', ...(layout ? { today_layout: layout } : {}) } : /\/api\/recommendations/.test(url) ? { enabled: false, data: [] } : {}
    return new Response(JSON.stringify(body), { status: init?.method && init.method !== 'GET' ? 200 : /\/api\/(user|briefing|settings|recommendations)/.test(url) ? 200 : 404 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('Today layout rules', () => {
  it('drops unknown sections, appends missing ones and never hides the Now card', () => {
    // V24: the focus section starts hidden for everyone until they choose to show it.
    expect(normalizeToday()).toEqual({ order: [...TODAY_SECTIONS], hidden: ['focus'] })
    const layout = normalizeToday({ order: ['habits', 'weather' as never, 'now', 'habits'], hidden: ['now', 'copilot', 'copilot'] })
    expect(layout.order).toEqual(['habits', 'now', 'strip', 'top3', 'progress', 'focus', 'copilot', 'suggestions'])
    expect(layout.hidden).toEqual(['copilot', 'focus'])
    // A layout saved before V24 that already lists focus keeps the user's choice.
    expect(normalizeToday({ order: [...TODAY_SECTIONS], hidden: [] }).hidden).toEqual([])
  })
})

describe('Today follows the saved layout for this device', () => {
  it('shows sections in the chosen order and moves hidden ones into "More for today"', async () => {
    stub({ desktop: { order: ['habits', 'now', 'strip', 'top3', 'progress', 'focus', 'copilot', 'suggestions'], hidden: ['suggestions', 'focus'] }, phone: { hidden: ['habits'] } })
    const { container } = render(wrap(<Dashboard />))
    await screen.findByText('Ship the report')
    await waitFor(() => expect(container.querySelector('.today-top:not(.in-more) .today-section')?.className).toContain('section-habits'))
    const shown = [...container.querySelectorAll('.today-top:not(.in-more) .today-section')].map(n => n.className.match(/section-(\w+)/)![1])
    expect(shown.slice(0, 2)).toEqual(['habits', 'now'])
    expect(shown).not.toContain('suggestions')
    // Hidden, not lost: inside "More for today".
    expect(screen.queryByText('You have 1 overdue task(s).')).toBeNull()
    fireEvent.click(screen.getByText('More for today'))
    expect(await screen.findByText('You have 1 overdue task(s).')).toBeInTheDocument()
  })
})

describe('Customize Today', () => {
  it('reorders and hides sections for one device and saves only what differs from the default', async () => {
    const fetcher = stub(), onSaved = vi.fn()
    render(wrap(<TodayCustomizer saved={{ phone: { hidden: ['copilot'] } }} device="desktop" onClose={() => {}} onSaved={onSaved} />))
    expect(screen.getByRole('radio', { name: /Computer/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('button', { name: 'Hide Now card' })).toBeNull()
    expect(screen.getByText('Always shown')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reset/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Move Habits up' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide Day strip' }))
    expect(screen.getByRole('button', { name: 'Show Day strip' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const put = (fetcher.mock.calls as unknown as Call[]).find(c => c[1]?.method === 'PUT')!
    expect(JSON.parse(put[1]!.body as string)).toEqual({ today_layout: {
      phone: { order: [...TODAY_SECTIONS], hidden: ['copilot', 'focus'] },
      desktop: { order: ['now', 'strip', 'top3', 'progress', 'habits', 'focus', 'copilot', 'suggestions'], hidden: ['focus', 'strip'] },
    } })
  })

  it('resets one device back to the default and keeps the other', async () => {
    const fetcher = stub()
    render(wrap(<TodayCustomizer saved={{ phone: { hidden: ['copilot'] }, desktop: { hidden: ['strip'] } }} device="phone" onClose={() => {}} onSaved={() => {}} />))
    fireEvent.click(screen.getByRole('button', { name: /Reset/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect((fetcher.mock.calls as unknown as Call[]).some(c => c[1]?.method === 'PUT')).toBe(true))
    const put = (fetcher.mock.calls as unknown as Call[]).find(c => c[1]?.method === 'PUT')!
    expect(JSON.parse(put[1]!.body as string)).toEqual({ today_layout: { desktop: { order: [...TODAY_SECTIONS], hidden: ['strip', 'focus'] } } })
  })
})
