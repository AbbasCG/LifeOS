import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { icosphere, perspective, rotation, normalMatrix, multiply, hexToRgb, ring } from '../lib/orb/geometry'
import { webglAvailable } from '../lib/orb/renderer'
import { LivingOrb } from '../components/orb/LivingOrb'
import { ThemeProvider } from '../contexts/ThemeContext'

beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals() })

describe('orb geometry', () => {
  it('builds a closed unit icosphere within the 16-bit index budget', () => {
    for (const [detail, vertices, triangles] of [[0, 12, 20], [3, 642, 1280], [4, 2562, 5120]]) {
      const mesh = icosphere(detail)
      expect(mesh.positions.length / 3).toBe(vertices)
      expect(mesh.indices.length / 3).toBe(triangles)
      expect(Math.max(...mesh.indices)).toBeLessThan(65536)
    }
    const { positions } = icosphere(2)
    for (let i = 0; i < positions.length; i += 3) expect(Math.hypot(positions[i], positions[i + 1], positions[i + 2])).toBeCloseTo(1, 5)
  })
  it('produces orthonormal rotations and a valid perspective projection', () => {
    const m = rotation(0.7, -1.2)
    const n = normalMatrix(m)
    const col = (i: number) => [n[i * 3], n[i * 3 + 1], n[i * 3 + 2]]
    for (let i = 0; i < 3; i++) expect(Math.hypot(...col(i))).toBeCloseTo(1, 6)
    expect(col(0)[0] * col(1)[0] + col(0)[1] * col(1)[1] + col(0)[2] * col(1)[2]).toBeCloseTo(0, 6)
    const identity = multiply(rotation(0, 0), rotation(0, 0))
    expect(Array.from(identity)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    const p = perspective(Math.PI / 2, 2, 0.1, 10)
    expect(p[0]).toBeCloseTo(0.5)
    expect(p[11]).toBe(-1)
  })
  it('parses colours and lays out the progress ring', () => {
    expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0])
    expect(hexToRgb('#fff')).toEqual([1, 1, 1])
    const points = ring(4, 2)
    expect(points.length).toBe(16)
    expect(points[3]).toBe(0)
    expect(points[7]).toBe(0.25)
  })
})

describe('living orb', () => {
  it('describes what it shows and keeps a same-size fallback when WebGL is unavailable', () => {
    expect(webglAvailable()).toBe(false) // jsdom has no WebGL
    const { container } = render(<ThemeProvider><LivingOrb progress={0.4} mode="focus" label="Focus session: 40% complete" size={180} /></ThemeProvider>)
    const orb = screen.getByRole('img', { name: 'Focus session: 40% complete' })
    expect(orb).toHaveStyle({ width: '180px', height: '180px' })
    expect(orb.className).toContain('mode-focus')
    expect(orb.className).not.toContain('is-live')
    expect(container.querySelector('.orb-fallback')).not.toBeNull()
    expect(orb.style.getPropertyValue('--orb-progress')).toBe('40%')
    // Not focusable until the interactive WebGL scene is running.
    expect(orb).not.toHaveAttribute('tabindex')
  })
})

import { fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import { todayGuidance } from '../lib/guidance'
import { arcPath, dayAngle } from '../lib/dial'
import { DayDial } from '../features/today/DayDial'
import { GoalJourney, HabitHeatmap } from '../features/progress/Journey'
import AssistantPage from '../features/AssistantPage'
import type { TodayData } from '../lib/api'

const shell = (children: ReactNode, path = '/') => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[path]}><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
function stubApi(routes: { match: RegExp; body: unknown; method?: string }[]) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes.find(r => r.match.test(url) && (!r.method || r.method === (init?.method || 'GET')))
    return new Response(JSON.stringify(route ? route.body : {}), { status: route ? 200 : 404 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const base: TodayData = {
  date: '2027-03-10', period: 'morning', briefing: [], reflection_prompt: null,
  energy: { checkin: null, enabled: true, energy: null, workload: null, load_percent: 40, level: 'moderate' },
  focus_time: { free_minutes: 150, slots: [{ area: 'work', starts_at: '2027-03-10T13:00:00', ends_at: '2027-03-10T15:30:00', minutes: 150 }], peak: null, next_task: { id: 3, title: 'Draft report' } },
  timeline: [{ id: 'e1', title: 'Client call', starts_at: '2027-03-10T10:00:00', ends_at: '2027-03-10T11:00:00', kind: 'fixed', source: 'lifeos', all_day: false }, { id: 'x2', title: 'Board sync', starts_at: '2027-03-10T16:00:00', ends_at: '2027-03-10T16:30:00', kind: 'fixed', source: 'outlook', all_day: false }],
  windows: { work: { start: '2027-03-10T09:00:00', end: '2027-03-10T17:00:00' } },
  deadlines: [], progress: { tasks: { done: 1, target: 4 }, focus: { done: 30, target: 240 }, habits: { done: 1, target: 2 }, overall: 30 },
}

describe('contextual guidance', () => {
  it('picks the most useful next move in priority order', () => {
    expect(todayGuidance({ ...base, deadlines: [{ id: 1, title: 'x', priority: null, due_at: '', type: 'task', bucket: 'overdue' }] })).toMatchObject({ tone: 'alert', to: '/assistant?ask=Reschedule%20my%20overdue%20tasks' })
    expect(todayGuidance(base)).toMatchObject({ tone: 'energy', to: '#checkin' })
    const checkedIn = { ...base, energy: { ...base.energy, checkin: { date: '2027-03-10', energy: 4 } as TodayData['energy']['checkin'] } }
    expect(todayGuidance(checkedIn)).toMatchObject({ tone: 'focus', to: '/focus?task=3' })
    expect(todayGuidance(checkedIn).en).toContain('2h 30m free')
    expect(todayGuidance({ ...checkedIn, energy: { ...checkedIn.energy, level: 'heavy', load_percent: 120 } })).toMatchObject({ to: '/today/plan' })
    expect(todayGuidance({ ...checkedIn, period: 'evening' }).to).toContain('/assistant?ask=')
  })
})

describe('day dial', () => {
  it('maps the day onto a 24-hour circle', () => {
    const start = new Date('2027-03-10T00:00:00').getTime()
    expect(dayAngle('2027-03-10T06:00:00', start)).toBeCloseTo(90)
    expect(dayAngle('2027-03-11T06:00:00', start)).toBe(360)
    expect(arcPath(86, 0, 90)).toMatch(/^M 110.00 24.00 A 86 86 0 0 1 196.00 110.00$/)
    expect(arcPath(86, 0, 270)).toContain(' 0 1 1 ')
  })
  it('links arcs and the list, and labels connected sources', () => {
    render(shell(<DayDial data={base} />))
    expect(screen.getByLabelText(/^Client call, /)).toBeInTheDocument()
    expect(screen.getByLabelText(/Board sync, .+ \(outlook\)/)).toHaveClass('source-external')
    expect(screen.getByText('Outlook')).toBeInTheDocument()
    fireEvent.mouseEnter(screen.getByRole('button', { name: /Client call/ }))
    expect(screen.getByLabelText(/^Client call, /)).toHaveClass('active')
  })
})

describe('goal journeys and habit heatmaps', () => {
  it('describes milestone progress and recent consistency', () => {
    render(shell(<><GoalJourney color="#16a34a" milestones={[{ title: 'Base', completed: true }, { title: '10 km', completed: true }, { title: 'Race', completed: false }]} /><HabitHeatmap today="2027-03-10" dates={['2027-03-10', '2027-03-09', '2026-01-01']} /></>))
    expect(screen.getByRole('list', { name: 'Milestones: 2 of 3 done' })).toBeInTheDocument()
    expect(screen.getByText('Race').closest('li')).toHaveClass('next')
    expect(screen.getByRole('img', { name: 'Done on 2 of the last 84 days' })).toBeInTheDocument()
  })
})

describe('copilot companion', () => {
  it('pre-fills a suggested question without sending it and offers context chips', async () => {
    const fetcher = stubApi([{ match: /\/api\/user$/, body: { id: 1, name: 'A', email: 'a@x.io' } }, { match: /\/api\/today$/, body: { ...base, deadlines: [{ id: 1, title: 'x', priority: null, due_at: '', type: 'task', bucket: 'today' }] } }, { match: /\/api\/assistant\/proposals$/, body: [] }])
    render(shell(<AssistantPage />, '/assistant?ask=Reschedule%20my%20overdue%20tasks'))
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Reschedule my overdue tasks')
    expect(await screen.findByRole('button', { name: /Show tasks due today/ })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /Copilot companion/ })).toBeInTheDocument()
    expect(fetcher.mock.calls.some(c => String(c[0]).endsWith('/api/assistant') && c[1]?.method === 'POST')).toBe(false)
  })
})
