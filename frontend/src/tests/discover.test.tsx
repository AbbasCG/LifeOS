import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import DiscoverPage from '../features/discovery/DiscoverPage'
import type { CatalogueFeature } from '../lib/discovery'

const feature = (over: Partial<CatalogueFeature> = {}): CatalogueFeature => ({
  id: 'quick-capture', category: 'tasks', name: 'Quick Capture in three languages', description: 'Write a task the way you speak.', route: '/tasks', release: 'r-one', date: '2026-11-08',
  can_try: true, unavailable_reason: null, tour: 'quick-capture-tour', tour_done: false, tried: false, is_new: true, ...over,
})
const list = [
  feature(),
  feature({ id: 'dutch-language', category: 'settings', name: 'Nederlands is available', description: 'Choose Nederlands in Settings.', route: '/settings', tour: null, is_new: false, tried: true }),
  feature({ id: 'night-owl', category: 'focus', name: 'Night owl mode', description: 'Dim the focus screen.', route: '/focus', can_try: false, unavailable_reason: 'setup_needed', tour: null, is_new: false }),
]

type Call = { method: string; url: string }
let calls: Call[]
function server(features: CatalogueFeature[] | 500, tryAnswer: unknown = { data: { available: true, reason: null, route: '/tasks', tour: 'quick-capture-tour' } }) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(url) })
    if (/\/api\/discovery\/features\?/.test(url)) return features === 500 ? new Response('{"message":"boom"}', { status: 500, headers: { 'Content-Type': 'application/json' } }) : new Response(JSON.stringify({ data: features }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (/\/try/.test(url)) return new Response(JSON.stringify(tryAnswer), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (/\/api\/settings/.test(url)) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}
function Where() { return <p data-testid="where">{useLocation().pathname}</p> }
const shell = () => render(<ThemeProvider><LanguageProvider><ToastProvider><MemoryRouter initialEntries={['/discover']}><Routes><Route path="*" element={<><DiscoverPage /><Where /></>} /></Routes></MemoryRouter></ToastProvider></LanguageProvider></ThemeProvider>)

beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en') })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Discovery Center', () => {
  it('lists the features by category, with New marks and what can be done with each', async () => {
    server(list)
    shell()
    expect(await screen.findByRole('heading', { name: 'Discover', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Tasks', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Settings', level: 2 })).toBeInTheDocument()
    const card = screen.getByRole('heading', { name: /Quick Capture in three languages/ }).closest('li') as HTMLElement
    expect(within(card).getByText('New')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Try now' })).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Take the tour' })).toBeInTheDocument()
    const dutch = screen.getByRole('heading', { name: /Nederlands is available/ }).closest('li') as HTMLElement
    expect(within(dutch).queryByText('New')).toBeNull()
    expect(within(dutch).queryByRole('button', { name: /tour/i })).toBeNull()
  })

  it('says why a feature cannot be used now instead of hiding it', async () => {
    server(list)
    shell()
    const card = (await screen.findByRole('heading', { name: /Night owl mode/ })).closest('li') as HTMLElement
    expect(within(card).getByText('Needs setup first.')).toBeInTheDocument()
    expect(within(card).queryByRole('button')).toBeNull()
    cleanup()
    server([feature({ can_try: false, unavailable_reason: 'platform', tour: null })])
    shell()
    expect(await screen.findByText('Not available on this device.')).toBeInTheDocument()
    cleanup()
    server([feature({ can_try: false, unavailable_reason: 'update_required', tour: null })])
    shell()
    expect(await screen.findByText('Reload LifeOS to use this.')).toBeInTheDocument()
  })

  it('searches names and descriptions and says when nothing matches', async () => {
    server(list)
    shell()
    await screen.findByRole('heading', { name: /Quick Capture/ })
    const box = screen.getByRole('searchbox', { name: 'Search features' })
    fireEvent.change(box, { target: { value: 'dim the focus' } })
    expect(screen.getByRole('heading', { name: /Night owl mode/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Quick Capture/ })).toBeNull()
    fireEvent.change(box, { target: { value: 'zzz' } })
    expect(screen.getByText('No feature matches your search.')).toBeInTheDocument()
    fireEvent.change(box, { target: { value: '' } })
    expect(screen.getByRole('heading', { name: /Quick Capture/ })).toBeInTheDocument()
  })

  it('"Try now" asks the server, opens the screen and starts the tour the server names', async () => {
    const started = vi.fn()
    window.addEventListener('lifeos:start-tour', started)
    server(list)
    shell()
    const card = (await screen.findByRole('heading', { name: /Quick Capture/ })).closest('li') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'Try now' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/tasks'))
    expect(calls.some(c => c.method === 'POST' && /features\/quick-capture\/try/.test(c.url))).toBe(true)
    await waitFor(() => expect(started).toHaveBeenCalledTimes(1))
    expect((started.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: 'quick-capture-tour' })
    window.removeEventListener('lifeos:start-tour', started)
  })

  it('a finished tour can be watched again, without counting as a new try', async () => {
    const started = vi.fn()
    window.addEventListener('lifeos:start-tour', started)
    server([feature({ tour_done: true, tried: true, is_new: false })])
    shell()
    fireEvent.click(await screen.findByRole('button', { name: 'Watch the tour again' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/tasks'))
    expect(started).toHaveBeenCalledTimes(1)
    expect(calls.some(c => c.method === 'POST')).toBe(false)
    window.removeEventListener('lifeos:start-tour', started)
  })

  it('shows a message and stays put when the server says it is not available', async () => {
    server(list, { data: { available: false, reason: 'setup_needed', route: null, tour: null } })
    shell()
    const card = (await screen.findByRole('heading', { name: /Quick Capture/ })).closest('li') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'Try now' }))
    expect(await screen.findByText('This is not available for your account right now.')).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/discover')
  })

  it('has an empty state, shows an error, and speaks Arabic', async () => {
    server([])
    shell()
    expect(await screen.findByText('Nothing to discover yet')).toBeInTheDocument()
    cleanup()
    server(500)
    shell()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    cleanup()
    localStorage.setItem('lifeos-language', 'ar')
    server(list)
    shell()
    expect(await screen.findByRole('heading', { name: 'اكتشف', level: 1 })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'جرّبها الآن' }).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'ابدأ الجولة' })).toBeInTheDocument()
  })
})
