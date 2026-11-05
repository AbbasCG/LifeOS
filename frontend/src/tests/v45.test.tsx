import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import FocusPage from '../features/FocusPage'

const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
type Rec = Record<string, unknown>
const record = (over: Rec = {}): Rec => ({
  id: 7, status: 'running', kind: 'focus', mode: 'pomodoro', cycle: 1, duration_seconds: 1500, elapsed_seconds: 0, resumed_at: new Date().toISOString(),
  completed_at: null, started_at: new Date().toISOString(), created_at: new Date().toISOString(), notes: null, interruptions: null, task_id: null, project_id: null,
  ...over,
})

/** A small server: the list it returns is whatever `list()` says at that moment. */
function server(list: () => Rec[], onPatch: (body: Rec) => Rec | null = () => null) {
  const patches: Rec[] = []
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET'
    if (/\/api\/user$/.test(url)) return new Response(JSON.stringify({ id: 1 }))
    if (/insights/.test(url)) return new Response(JSON.stringify({ sessions: 0, by_day: [], distractions: [], tips: [] }))
    if (/\/api\/focus-sessions\/\d+$/.test(url) && method === 'PATCH') { const body = JSON.parse(init!.body as string); patches.push(body); const next = onPatch(body); return next ? new Response(JSON.stringify({ server_time: new Date().toISOString(), ...next })) : new Response('{}', { status: 500 }) }
    if (/\/api\/focus-sessions$/.test(url) && method === 'POST') return new Response(JSON.stringify({ server_time: new Date().toISOString(), ...list()[0] }), { status: 201 })
    if (/\/api\/focus-sessions$/.test(url)) return new Response(JSON.stringify({ data: list().map(r => ({ server_time: new Date().toISOString(), ...r })) }))
    return new Response(JSON.stringify({ data: [] }))
  })
  vi.stubGlobal('fetch', fetcher)
  return { patches, fetcher }
}
const finishes = (patches: Rec[]) => patches.filter(p => p.action === 'finish')

describe('V45 the Pomodoro timer', () => {
  beforeEach(() => { localStorage.clear(); localStorage.setItem('lifeos-language', 'en') })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('shows the full countdown after Start and never finishes by itself', async () => {
    let sessions: Rec[] = []
    const { patches, fetcher } = server(() => sessions)
    render(wrap(<FocusPage />))
    const start = await screen.findByRole('button', { name: /Start 25 min/ })
    sessions = [record()]
    fireEvent.click(start)
    await screen.findByRole('button', { name: /Pause/ })
    expect(document.querySelector('.dial-time')!.textContent).toMatch(/^2[45]:\d\d$/)
    await new Promise(r => setTimeout(r, 1300))
    expect(document.querySelector('.dial-time')!.textContent).toMatch(/^2[45]:\d\d$/)
    expect(finishes(patches)).toHaveLength(0)
    const post = JSON.parse(fetcher.mock.calls.find(c => c[1]?.method === 'POST')![1]!.body as string)
    expect(post).toMatchObject({ kind: 'focus', mode: 'pomodoro', duration_seconds: 1500 })
  })

  it('pauses, resumes and resets through the server', async () => {
    let state: Rec = record()
    const { patches } = server(() => [state], body => {
      state = body.action === 'pause' ? { ...state, status: 'paused', elapsed_seconds: 40, resumed_at: null }
        : body.action === 'resume' ? { ...state, status: 'running', resumed_at: new Date().toISOString(), server_time: new Date().toISOString() }
          : { ...state, status: 'cancelled' }
      return state
    })
    render(wrap(<FocusPage />))
    fireEvent.click(await screen.findByRole('button', { name: /Pause/ }))
    await screen.findByRole('button', { name: /Resume/ })
    expect(document.querySelector('.dial-time')!.textContent).toBe('24:20')
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }))
    await screen.findByRole('button', { name: /Pause/ })
    fireEvent.click(screen.getByRole('button', { name: 'Discard session' }))
    await screen.findByRole('button', { name: /Start 25 min/ })
    expect(patches.map(p => p.action)).toEqual(['pause', 'resume', 'cancel'])
    expect(document.querySelector('.dial-time')!.textContent).toBe('25:00')
  })

  it('finishes exactly once when the time really runs out, however many ticks pass', async () => {
    let state: Rec = record({ duration_seconds: 60, resumed_at: new Date(Date.now() - 59_300).toISOString() })
    const { patches } = server(() => [state], () => { state = { ...state, status: 'completed' }; return state })
    render(wrap(<FocusPage />))
    await waitFor(() => expect(finishes(patches)).toHaveLength(1), { timeout: 4000 })
    await new Promise(r => setTimeout(r, 1500))
    expect(finishes(patches)).toHaveLength(1)
    expect(await screen.findByText(/Session complete/)).toBeInTheDocument()
  })

  it('does not end a session the server says still has time, whatever this device thinks', async () => {
    // First answer looks expired; the server's fresh answer says it has just resumed.
    let calls = 0
    const { patches } = server(() => [++calls <= 1 ? record({ resumed_at: new Date(Date.now() - 3 * 3600_000).toISOString(), server_time: new Date(Date.now() - 3 * 3600_000 + 1500_000).toISOString(), skew_ms: undefined }) : record()])
    render(wrap(<FocusPage />))
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 4000 })
    await new Promise(r => setTimeout(r, 800))
    expect(finishes(patches)).toHaveLength(0)
    expect(screen.queryByText(/Session complete/)).toBeNull()
  })

  it('does not announce "Session complete" when saving the finish failed', async () => {
    const state = record({ duration_seconds: 60, resumed_at: new Date(Date.now() - 61_000).toISOString() })
    const { patches } = server(() => [state], () => null)
    render(wrap(<FocusPage />))
    await waitFor(() => expect(finishes(patches).length).toBeGreaterThanOrEqual(1), { timeout: 4000 })
    await new Promise(r => setTimeout(r, 600))
    expect(screen.queryByText(/Session complete — time saved/)).toBeNull()
    expect(finishes(patches)).toHaveLength(1)
  })
})
