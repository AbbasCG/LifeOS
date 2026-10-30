import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { QuickCheckin } from '../features/today/QuickCheckin'
import type { TodayData } from '../lib/api'

const today = { date: '2027-03-09', energy: { enabled: true, checkin: null, energy: null, workload: null, load_percent: 0, level: 'light' } } as unknown as TodayData
const wrap = (ui: React.ReactNode) => <ThemeProvider><LanguageProvider><ToastProvider>{ui}</ToastProvider></LanguageProvider></ThemeProvider>

describe('one-tap check-in on Today', () => {
  beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en')
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false } })
  afterEach(() => vi.unstubAllGlobals())

  it('saves only the energy, for the account’s day, with one tap', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ date: '2027-03-09', energy: 4 }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    const onSaved = vi.fn()
    render(wrap(<QuickCheckin today={today} onSaved={onSaved} />))
    fireEvent.click(screen.getByRole('button', { name: '4 Good' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const call = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]
    expect(call[0]).toContain('/api/checkins/2027-03-09')
    expect(call[1].method).toBe('PUT')
    // Nothing else is sent, so a mood, sleep or reflection saved earlier today is left as it is.
    expect(JSON.parse(call[1].body as string)).toEqual({ energy: 4 })
  })

  it('offers five levels and opens the full check-in from "More"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })))
    render(wrap(<QuickCheckin today={today} onSaved={() => {}} />))
    expect(screen.getAllByRole('button', { name: /^\d \w+/ })).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(await screen.findByRole('form', { name: 'Daily check-in' })).toBeInTheDocument()
  })
})
