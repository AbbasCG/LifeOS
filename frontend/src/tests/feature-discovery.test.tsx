import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import HintHost from '../features/discovery/HintHost'
import { NewBadge } from '../features/discovery/NewBadge'
import { HintsSetting } from '../features/discovery/HintsSetting'
import { setNewFeatures, type Guide } from '../lib/discovery'

type Call = { method: string; url: string; body: unknown }
let calls: Call[]
const hint = { id: 'capture-hint', feature: 'quick-capture', target: 'quick-add', route: '/tasks', text: 'Type a phrase like “tomorrow 5pm”.' }
const guide = (over: Partial<Guide> = {}): Guide => ({ new: [{ id: 'quick-capture', route: '/tasks', name: 'Quick capture' }], hints: [hint], ...over })

function server(g: Guide, settings: unknown = {}) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    let body: unknown = {}
    if (/\/api\/discovery\/guide/.test(url)) body = { data: g }
    else if (/\/api\/settings/.test(url) && method === 'GET') body = settings
    else if (/\/api\/discovery\/features\/.+\/try/.test(url)) body = { data: { available: true, reason: null, route: '/tasks', tour: null } }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}
const puts = () => calls.filter(c => c.method === 'PUT').map(c => `${c.url.replace(/\?.*/, '')} ${JSON.stringify(c.body)}`)

function Screen({ withTarget = true }: { withTarget?: boolean }) {
  const go = useNavigate()
  return <><button onClick={() => go('/tasks')}>to-tasks</button>{withTarget && <button data-hint="quick-add">Add</button>}<NewBadge to="/tasks" /><HintHost /></>
}
const shell = (ui: ReactNode, path = '/tasks') => render(<ThemeProvider><LanguageProvider><ToastProvider><MemoryRouter initialEntries={[path]}><Routes><Route path="*" element={ui} /></Routes></MemoryRouter></ToastProvider></LanguageProvider></ThemeProvider>)

beforeEach(() => {
  cleanup(); localStorage.clear(); sessionStorage.clear(); setNewFeatures([])
  localStorage.setItem('lifeos-language', 'en')
  // jsdom has no layout: give every element a size so "visible" holds.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 10, top: 10, left: 10, bottom: 40, right: 110, width: 100, height: 30, toJSON: () => ({}) })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 280 })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 1500)) })

describe('feature discovery', () => {
  it('shows the hint once at the right screen, records it, and does not repeat it', async () => {
    server(guide())
    shell(<Screen />)
    expect(await screen.findByTestId('hint-bubble', {}, { timeout: 4000 })).toHaveTextContent('tomorrow 5pm')
    await waitFor(() => expect(puts()).toContain('/api/discovery/states/hint/capture-hint {"action":"seen","surface":"web"}'))
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
    expect(screen.queryByTestId('hint-bubble')).toBeNull()
    expect(puts().some(p => p.includes('hint/capture-hint') && p.includes('dismissed'))).toBe(true)
    cleanup()
    // A second page load in the same browser session shows nothing more.
    server(guide())
    shell(<Screen />)
    await settle()
    expect(screen.queryByTestId('hint-bubble')).toBeNull()
  })

  it('shows no hint on another screen, without its target, or when the person is typing', async () => {
    server(guide())
    shell(<Screen />, '/calendar')
    await settle()
    expect(screen.queryByTestId('hint-bubble')).toBeNull()
    cleanup(); sessionStorage.clear()
    server(guide())
    shell(<Screen withTarget={false} />)
    await settle()
    expect(screen.queryByTestId('hint-bubble')).toBeNull()
    cleanup(); sessionStorage.clear()
    server(guide())
    shell(<><input aria-label="Note" /><Screen /></>)
    screen.getByLabelText('Note').focus()
    await settle()
    expect(screen.queryByTestId('hint-bubble')).toBeNull()
  })

  it('Escape closes the hint for good, and "Turn off tips" saves the preference', async () => {
    server(guide())
    shell(<Screen />)
    await screen.findByTestId('hint-bubble', {}, { timeout: 4000 })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('hint-bubble')).toBeNull()
    cleanup(); sessionStorage.clear()
    server(guide())
    shell(<Screen />)
    await screen.findByTestId('hint-bubble', {}, { timeout: 4000 })
    fireEvent.click(screen.getByRole('button', { name: 'Turn off tips' }))
    expect(puts()).toContain('/api/settings {"discovery":{"hints_enabled":false}}')
    expect(screen.queryByTestId('hint-bubble')).toBeNull()
  })

  it('marks the menu item as new, and opening that screen clears the mark and records the try', async () => {
    server(guide({ hints: [] }))
    shell(<Screen />, '/')
    expect(await screen.findByTestId('new-badge', {}, { timeout: 4000 })).toHaveTextContent('New')
    fireEvent.click(screen.getByText('to-tasks'))
    await waitFor(() => expect(screen.queryByTestId('new-badge')).toBeNull())
    expect(calls.some(c => c.method === 'POST' && c.url.includes('/features/quick-capture/try'))).toBe(true)
  })

  it('shows no badge and no hint when the server has none, or fails', async () => {
    server({ new: [], hints: [] })
    shell(<Screen />)
    await settle()
    expect(screen.queryByTestId('new-badge')).toBeNull()
    cleanup()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    shell(<Screen />)
    await settle()
    expect(screen.queryByTestId('hint-bubble')).toBeNull()
  })

  it('the settings switch reads and writes the hints preference', async () => {
    server(guide(), { discovery: { hints_enabled: false } })
    shell(<HintsSetting />)
    const box = await screen.findByRole('checkbox', { name: /Show tips/ })
    expect(box).not.toBeChecked()
    fireEvent.click(box)
    await waitFor(() => expect(puts()).toContain('/api/settings {"discovery":{"hints_enabled":true}}'))
  })

  it('speaks Arabic in the bubble', async () => {
    localStorage.setItem('lifeos-language', 'ar')
    server(guide())
    shell(<Screen />)
    expect(await screen.findByRole('button', { name: 'فهمت' }, { timeout: 4000 })).toBeInTheDocument()
  })
})
