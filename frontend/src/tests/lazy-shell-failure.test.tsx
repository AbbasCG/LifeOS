import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import QuickAdd from '../components/layout/QuickAdd'
import TourHost from '../features/discovery/TourHost'
import { openQuickAdd } from '../lib/quickAdd'
import { START_TOUR } from '../lib/discovery'

// The Quick Add sheet and the tour engine are separate files fetched on demand. When a file cannot be fetched (offline before it was ever
// cached) the tap must say so and must not leave a dead, empty shell; the next tap tries again.
const files = vi.hoisted(() => ({ sheetUp: false, tourUp: false }))
vi.mock('../components/layout/QuickAddSheet', () => {
  if (!files.sheetUp) throw new Error('Failed to fetch dynamically imported module')
  return { default: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="Quick add sheet" /> : null) }
})
vi.mock('../features/discovery/TourSheet', () => {
  if (!files.tourUp) throw new Error('Failed to fetch dynamically imported module')
  return { default: ({ first }: { first: string }) => <div data-testid="tour" data-first={first} /> }
})

const wrap = (children: ReactNode, path = '/') => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[path]}><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
beforeEach(() => {
  cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals(); vi.resetModules()
  files.sheetUp = false; files.tourUp = false
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })))
})

describe('a part that cannot be fetched', () => {
  it('Quick Add: tells the user, opens nothing, and the shortcut path stays empty', async () => {
    render(wrap(<QuickAdd />))
    act(() => openQuickAdd())
    expect(await screen.findByText(/Quick add is not available yet/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Quick Add: the next tap tries the file again and opens once it is there', async () => {
    render(wrap(<QuickAdd />))
    act(() => openQuickAdd())
    expect(await screen.findByText(/Quick add is not available yet/)).toBeInTheDocument()
    files.sheetUp = true
    act(() => openQuickAdd())
    expect(await screen.findByRole('dialog', { name: 'Quick add sheet' })).toBeInTheDocument()
  })

  it('the tour: tells the user and starts nothing', async () => {
    render(wrap(<TourHost openMenu={() => {}} closeMenu={() => {}} />))
    act(() => { window.dispatchEvent(new CustomEvent(START_TOUR, { detail: { id: 'calendar' } })) })
    expect(await screen.findByText(/The tour is not available yet/)).toBeInTheDocument()
    expect(screen.queryByTestId('tour')).not.toBeInTheDocument()
  })
})

describe('a part that is fetched', () => {
  it('Quick Add opens the sheet on the first tap, with the open state it was given', async () => {
    files.sheetUp = true
    render(wrap(<QuickAdd />))
    act(() => openQuickAdd())
    expect(await screen.findByRole('dialog', { name: 'Quick add sheet' })).toBeInTheDocument()
  })

  it('the tour hands the first request to the engine once it is there', async () => {
    files.tourUp = true
    render(wrap(<TourHost openMenu={() => {}} closeMenu={() => {}} />))
    act(() => { window.dispatchEvent(new CustomEvent(START_TOUR, { detail: { id: 'calendar' } })) })
    await waitFor(() => expect(screen.getByTestId('tour')).toHaveAttribute('data-first', 'calendar'))
  })
})
