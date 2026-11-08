import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import DiscoveryHost from '../features/discovery/DiscoveryHost'
import UpdatesPage from '../features/discovery/UpdatesPage'
import { NewBadge } from '../features/discovery/NewBadge'
import { setUnseenUpdates } from '../lib/discovery'

const release = (key: string, seen = false) => ({ key, date: '2026-11-08', revision: 1, importance: 'normal', title: `Title ${key}`, summary: 'S', items: [{ type: 'new', title: 'Item', body: 'Body', feature: null, can_try: false, unavailable_reason: null, tour: null, tried: false, is_new: false, link: null }], seen, helpful: null })
let calls: { method: string; url: string }[]
function server(unseen: number, announcement: unknown = null, history: unknown[] = []) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(url) })
    const body = /discovery\/bootstrap/.test(url) ? { data: { announcement, update_required: false, counts: { unseen_updates: unseen }, preferences: { hints_enabled: true } } } : /discovery\/releases/.test(url) ? { data: history } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}
const shell = (ui: React.ReactNode) => render(<ThemeProvider><LanguageProvider><ToastProvider><MemoryRouter initialEntries={['/']}><Routes><Route path="*" element={ui} /></Routes></MemoryRouter></ToastProvider></LanguageProvider></ThemeProvider>)

beforeEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); localStorage.setItem('lifeos-language', 'en'); setUnseenUpdates(0); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the count of updates not seen yet', () => {
  it('shows on the menu item from the server’s count even when no sheet may open, and nothing when there are none', async () => {
    server(2)
    shell(<><NewBadge to="/updates" /><DiscoveryHost /></>)
    expect(await screen.findByTestId('unseen-badge', {}, { timeout: 5000 })).toHaveTextContent('2')
    expect(screen.getByLabelText('2 updates you have not seen')).toBeInTheDocument()
    cleanup()
    setUnseenUpdates(0)
    server(0)
    shell(<><NewBadge to="/updates" /><DiscoveryHost /></>)
    await waitFor(() => expect(calls.some(c => /bootstrap/.test(c.url))).toBe(true), { timeout: 5000 })
    expect(screen.queryByTestId('unseen-badge')).toBeNull()
  })

  it('opening the update history marks what it lists as seen and clears the count', async () => {
    server(1, null, [release('r-one')])
    shell(<><NewBadge to="/updates" /><UpdatesPage /></>)
    act(() => setUnseenUpdates(1))
    expect(screen.getByTestId('unseen-badge')).toHaveTextContent('1')
    await waitFor(() => expect(calls.some(c => c.method === 'PUT' && /states\/release\/r-one/.test(c.url))).toBe(true))
    await waitFor(() => expect(screen.queryByTestId('unseen-badge')).toBeNull())
  })

  it('dismissing the announcement leaves one update fewer waiting', async () => {
    const announcement = { ...release('r-one'), seen: undefined, helpful: undefined }
    server(1, announcement)
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
    shell(<><NewBadge to="/updates" /><DiscoveryHost /></>)
    expect(await screen.findByTestId('unseen-badge', {}, { timeout: 5000 })).toHaveTextContent('1')
    fireEvent.click(await screen.findByRole('button', { name: 'Got it' }, { timeout: 5000 }))
    await waitFor(() => expect(screen.queryByTestId('unseen-badge')).toBeNull())
  })
})
