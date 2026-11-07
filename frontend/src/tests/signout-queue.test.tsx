import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import Sidebar from '../components/layout/Sidebar'
import Topbar from '../components/layout/Topbar'
import { enqueue, pendingItems, setOfflineOwner } from '../lib/offline'

const wrap = (children: ReactNode) => <MemoryRouter><ThemeProvider><LanguageProvider><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></LanguageProvider></ThemeProvider></MemoryRouter>
const user = { id: 1, name: 'A', email: 'a@x.io' }
type Mode = 'offline' | 'server-error' | 'ok'
function stubNetwork(mode: Mode) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (/\/api\/logout$/.test(url) || /csrf-cookie$/.test(url)) {
      if (mode === 'offline') throw new TypeError('Failed to fetch')
      if (mode === 'server-error') return new Response(JSON.stringify({ message: 'Server error' }), { status: 500 })
    }
    return new Response(JSON.stringify(/\/api\/user$/.test(url) ? user : {}), { status: 200 })
  }))
}
const queue = () => { setOfflineOwner(1); enqueue({ kind: 'habit.log', label: 'Read', payload: { habit_id: 3, date: '2027-01-04', completed: true } }) }

describe.each([
  ['Sidebar', () => <Sidebar open onClose={() => {}} />],
  ['Topbar', () => <Topbar onMenuClick={() => {}} />],
])('sign-out from %s keeps pending changes unless sign-out succeeds', (_name, view) => {
  beforeEach(() => { localStorage.clear(); vi.spyOn(window, 'confirm').mockReturnValue(true) })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setOfflineOwner(null) })
  const press = async () => { render(wrap(view())); await waitFor(() => expect(screen.getAllByRole('button', { name: /Sign out|تسجيل الخروج/ }).length).toBeGreaterThan(0)); await screen.findByRole('button', { name: /Sign out|تسجيل الخروج/ }); queue(); fireEvent.click(screen.getByRole('button', { name: /Sign out|تسجيل الخروج/ })) }

  it('keeps the queue when the network is down', async () => {
    stubNetwork('offline'); await press()
    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 50))
    expect(pendingItems()).toHaveLength(1)
  })
  it('keeps the queue when the server rejects the sign-out', async () => {
    stubNetwork('server-error'); await press()
    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 50))
    expect(pendingItems()).toHaveLength(1)
  })
  it('clears the queue after a successful sign-out', async () => {
    stubNetwork('ok'); await press()
    await waitFor(() => expect(pendingItems()).toHaveLength(0))
  })
  it('keeps the queue when the person declines', async () => {
    stubNetwork('ok'); (window.confirm as ReturnType<typeof vi.fn>).mockReturnValue(false); await press()
    await new Promise(r => setTimeout(r, 50))
    expect(pendingItems()).toHaveLength(1)
  })
})
