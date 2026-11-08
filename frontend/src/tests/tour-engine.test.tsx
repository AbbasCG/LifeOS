import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import TourHost from '../features/discovery/TourHost'
import { startTour, type Tour, type TourStep } from '../lib/discovery'

const step = (over: Partial<TourStep> = {}): TourStep => ({ target: 'quick-add', route: null, reveal: null, placement: 'auto' as const, optional: false, title: 'Quick add', body: 'Start here.', ...over })
const tour = (over: Partial<Tour> = {}): Tour => ({ id: 'quick-tour', version: 1, title: 'Capture tour', steps: [step(), step({ target: 'nav-tasks', title: 'Tasks', body: 'Your list.' }), step({ target: 'nav-calendar', title: 'Calendar', body: 'Your week.' })], state: { step_index: 0, completed: false, skipped: false }, ...over })

type Call = { method: string; url: string; body: unknown }
let calls: Call[]
function server(answer: Tour | 404) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (/\/api\/discovery\/tours\//.test(url)) return answer === 404 ? new Response('{"message":"Not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } }) : new Response(JSON.stringify({ data: answer }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    return new Response('{"data":{}}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}
const puts = () => calls.filter(c => c.method === 'PUT').map(c => `${c.url.split('/states/')[1]} ${(c.body as { action: string; step_index?: number }).action}${(c.body as { step_index?: number }).step_index !== undefined ? ` ${(c.body as { step_index: number }).step_index}` : ''}`)

function Where() { return <p data-testid="where">{useLocation().pathname}</p> }
const openMenu = vi.fn(), closeMenu = vi.fn()
const shell = (ui: ReactNode = null) => render(<ThemeProvider><LanguageProvider><ToastProvider><MemoryRouter initialEntries={['/']}><Routes><Route path="*" element={<>
  <button data-tour="quick-add">Add</button><a data-tour="nav-tasks" href="/tasks">Tasks</a><a data-tour="nav-calendar" href="/calendar">Calendar</a>{ui}<TourHost openMenu={openMenu} closeMenu={closeMenu} /><Where /></>} /></Routes></MemoryRouter></ToastProvider></LanguageProvider></ThemeProvider>)

beforeEach(() => {
  cleanup(); localStorage.clear(); sessionStorage.clear(); openMenu.mockClear(); closeMenu.mockClear()
  localStorage.setItem('lifeos-language', 'en')
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 10, top: 10, left: 10, bottom: 40, right: 110, width: 100, height: 30, toJSON: () => ({}) })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const begin = async (id = 'quick-tour') => { act(() => startTour(id)); return screen.findByTestId('tour-card') }

describe('tour engine', () => {
  it('walks the steps, remembers each one and ends as completed', async () => {
    server(tour())
    shell()
    const card = await begin()
    expect(card).toHaveTextContent('Quick add'); expect(card).toHaveTextContent('Capture tour · 1 / 3')
    await waitFor(() => expect(puts()).toContain('tour/quick-tour started'))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('heading', { name: 'Tasks' })).toBeInTheDocument()
    await waitFor(() => expect(puts()).toContain('tour/quick-tour step 1'))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('heading', { name: 'Quick add' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next' })); fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('heading', { name: 'Calendar' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Skip tour' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByTestId('tour-card')).toBeNull()
    expect(puts()).toContain('tour/quick-tour completed')
  })

  it('never acts for the person: it only reads the tour and records progress', async () => {
    server(tour())
    shell()
    await begin()
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }))
    expect(calls.every(c => (c.method === 'GET' && /tours\//.test(c.url)) || (c.method === 'PUT' && /states\/tour\//.test(c.url)))).toBe(true)
  })

  it('Escape and "Skip tour" end it as skipped and give focus back to where the person was', async () => {
    server(tour())
    shell()
    const opener = screen.getByRole('button', { name: 'Add' }); opener.focus()
    await begin()
    expect(screen.getByTestId('tour-card')).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('tour-card')).toBeNull()
    expect(puts()).toContain('tour/quick-tour skipped')
    expect(opener).toHaveFocus()
  })

  it('resumes where the person stopped, but starts over once it was finished', async () => {
    server(tour({ state: { step_index: 1, completed: false, skipped: false } }))
    shell()
    expect(await begin()).toHaveTextContent('2 / 3')
    fireEvent.keyDown(document, { key: 'Escape' })
    server(tour({ state: { step_index: 1, completed: true, skipped: false } }))
    expect(await begin()).toHaveTextContent('1 / 3')
  })

  it('goes to the step’s screen and opens the menu only when the target is hidden', async () => {
    server(tour({ steps: [step({ target: 'missing-menu-item', reveal: 'sidebar', route: '/tasks' })] }))
    shell()
    await begin()
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/tasks'))
    await waitFor(() => expect(openMenu).toHaveBeenCalled())
    server(tour({ steps: [step({ target: 'nav-tasks', reveal: 'sidebar' })] }))
    openMenu.mockClear()
    fireEvent.keyDown(document, { key: 'Escape' })
    await begin()
    expect(openMenu).not.toHaveBeenCalled()
  })

  it('skips an optional step whose target does not exist, and shows a required one without a spotlight', async () => {
    server(tour({ steps: [step({ target: 'not-there-1', optional: true, title: 'Gone' }), step({ title: 'Here' })] }))
    shell()
    await begin()
    expect(await screen.findByRole('heading', { name: 'Here' }, { timeout: 9000 })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    server(tour({ steps: [step({ target: 'not-there-2', title: 'Needs it' })] }))
    await begin()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Needs it' })).toBeInTheDocument())
    await act(async () => { await new Promise(r => setTimeout(r, 3600)) })
    expect(screen.getByRole('heading', { name: 'Needs it' })).toBeInTheDocument()
    expect(document.querySelector('.tour-dim.has-target')).toBeNull()
  }, 30_000)

  it('says so, and shows nothing, when the tour is not available', async () => {
    server(404)
    shell()
    act(() => startTour('quick-tour'))
    expect(await screen.findByText('This tour is not available right now.')).toBeInTheDocument()
    expect(screen.queryByTestId('tour-card')).toBeNull()
  })

  it('has an accessible name and speaks Arabic', async () => {
    localStorage.setItem('lifeos-language', 'ar')
    server(tour({ title: 'جولة', steps: [step({ title: 'إضافة سريعة', body: 'ابدأ من هنا.' })] }))
    shell()
    const card = await begin()
    expect(card).toHaveAttribute('role', 'dialog'); expect(card).toHaveAccessibleName('إضافة سريعة')
    expect(screen.getByRole('button', { name: 'تم' })).toBeInTheDocument()
  })
})
