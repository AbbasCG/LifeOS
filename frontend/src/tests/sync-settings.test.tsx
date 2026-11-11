import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { SyncSettings } from '../features/connected/SyncSettings'
import type { Conflict, PushResult, SyncState } from '../lib/syncSettings'

const state = (over: Partial<SyncState> = {}): SyncState => ({
  direction: 'inbound', effective_direction: 'inbound', effective_reason: null, available_directions: ['inbound', 'outbound', 'two_way', 'manual'], conflict_policy: 'ask', paused: false, paused_at: null,
  copies: 3, copies_pending: 1, open_conflicts: 0, last_outbound: null, ...over,
})
const conflict: Conflict = { id: 5, account_id: 7, status: 'open', resolution: null, title: 'Team lunch', starts_at: '2027-03-23T09:00:00Z', ends_at: '2027-03-23T10:00:00Z', detected_at: '2027-03-22T08:00:00Z' }
const plan: PushResult = { ran: false, reason: null, pushed: 0, conflicts: 0, awaiting: 0, gone: 0, failed: 0, pending: 2, planned: [{ link_id: 1, from: 'Old', to: 'New' }, { link_id: 2, from: 'A', to: 'B' }] }

type Call = { method: string; url: string; body?: Record<string, unknown> }
let calls: Call[], conflictsAnswer: Conflict[], pushAnswer: PushResult
const changed = vi.fn()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
function server() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (/sync-conflicts$/.test(url)) return json({ data: conflictsAnswer })
    if (/sync\/preview$/.test(url)) return json({ data: plan })
    if (/sync\/push$/.test(url)) return json({ data: pushAnswer })
    return json({ data: {} })
  }))
}
const shell = (s: SyncState) => render(<ThemeProvider><LanguageProvider><ToastProvider><MemoryRouter><SyncSettings accountId={7} label="Google Calendar" state={s} onChanged={changed} /></MemoryRouter></ToastProvider></LanguageProvider></ThemeProvider>)
/** Ends the exit animation of one conflict row, as the browser would. */
const exitOf = async (title: string) => {
  const row = screen.getByText(title).closest('li')!
  for (const type of ['animationend', 'webkitAnimationEnd']) { const end = new Event(type, { bubbles: true }); Object.assign(end, { animationName: 'conflict-out' }); fireEvent(row, end) }   // jsdom has no AnimationEvent: React listens under either name
}
const writes = () => calls.filter(c => c.method !== 'GET')

beforeEach(() => {
  cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); changed.mockClear(); conflictsAnswer = []; pushAnswer = { ...plan, ran: true, pushed: 2, pending: 2 }
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('sync settings', () => {
  it('shows only what the server can prove, and no number it does not have', () => {
    server()
    shell(state({ last_outbound: { id: 1, status: 'success', started_at: '2027-03-22T08:00:00Z', upserted: 2, error: null, details: {} } }))
    expect(screen.getByText('From the service into LifeOS')).toBeInTheDocument()
    expect(screen.getByText(/3 · 1 waiting to be updated/)).toBeInTheDocument()
    expect(screen.getByText(/Sent · 2/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Preview what would be sent/ })).toBeNull()
  })

  it('says a direction that sends is not in effect while permissions do not allow it', () => {
    server()
    shell(state({ direction: 'two_way', effective_direction: 'inbound', effective_reason: 'permissions' }))
    expect(screen.getByText(/Sending is switched off in this connection’s permissions/)).toBeInTheDocument()
    expect(screen.getByText('From the service into LifeOS')).toBeInTheDocument()   // what is really in effect
  })

  it('offers only the directions the service can do', async () => {
    server()
    shell(state({ available_directions: ['inbound', 'manual'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Sync settings' }))
    const dialog = await screen.findByRole('dialog', { hidden: true })
    expect(within(dialog).getAllByRole('radio', { hidden: true })).toHaveLength(2)
    expect(within(dialog).queryByText('Both ways')).toBeNull()
  })

  it('saves a direction; the conflict choices appear only for directions that send', async () => {
    server()
    shell(state())
    fireEvent.click(screen.getByRole('button', { name: 'Sync settings' }))
    const dialog = await screen.findByRole('dialog', { hidden: true })
    expect(within(dialog).queryByText('If an event changed in both places')).toBeNull()
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Both ways/, hidden: true }))
    expect(within(dialog).getByText('If an event changed in both places')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Keep the LifeOS version/, hidden: true }))
    expect(within(dialog).getByText(/will overwrite changes you made at the service/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Ask me/, hidden: true }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].method).toBe('PUT')
    expect(writes()[0].url).toBe('/api/integrations/accounts/7/sync-settings')
    expect(writes()[0].body).toEqual({ direction: 'two_way', conflict_policy: 'ask' })
    await waitFor(() => expect(changed).toHaveBeenCalled())
  })

  it('pauses and resumes', async () => {
    server()
    shell(state())
    fireEvent.click(screen.getByRole('button', { name: 'Pause sync' }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].body).toEqual({ paused: true })
    cleanup()
    server()
    shell(state({ paused: true }))
    expect(screen.getByText(/paused/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Resume sync' }))
    await waitFor(() => expect(writes()[0].body).toEqual({ paused: false }))
  })

  it('previews what would be sent without sending, then sends only when asked', async () => {
    server()
    shell(state({ direction: 'outbound', effective_direction: 'outbound' }))
    fireEvent.click(screen.getByRole('button', { name: /Preview what would be sent/ }))
    expect(await screen.findByText(/2 update\(s\) would be sent\. Nothing has been sent yet\./)).toBeInTheDocument()
    expect(screen.getByText('Old → New')).toBeInTheDocument()
    expect(calls.some(c => /sync\/push$/.test(c.url))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Send these updates now' }))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && /sync\/push$/.test(c.url))).toBe(true))
    await waitFor(() => expect(changed).toHaveBeenCalled())
  })

  it('lists the conflicts waiting and resolves one without overwriting unless confirmed', async () => {
    conflictsAnswer = [conflict]
    server()
    shell(state({ direction: 'outbound', effective_direction: 'outbound', open_conflicts: 1 }))
    expect(await screen.findByText('Team lunch')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep the one at the service' }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].url).toBe('/api/integrations/sync-conflicts/5/resolve')
    expect(writes()[0].body).toEqual({ resolution: 'keep_external' })
  })

  it('overwriting the service’s version needs its own tick and says it cannot be undone', async () => {
    conflictsAnswer = [conflict]
    server()
    shell(state({ direction: 'outbound', effective_direction: 'outbound', open_conflicts: 1 }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use the LifeOS version…' }))
    expect(screen.getByText(/cannot be undone from LifeOS/)).toBeInTheDocument()
    const overwrite = screen.getByRole('button', { name: 'Overwrite' })
    expect(overwrite).toBeDisabled()
    expect(writes()).toHaveLength(0)
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand and want to overwrite it/ }))
    fireEvent.click(overwrite)
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].body).toEqual({ resolution: 'keep_lifeos', confirm_overwrite: true })
  })

  it('the overwrite confirmation is a named group and focus moves to its checkbox', async () => {
    conflictsAnswer = [conflict]
    server()
    shell(state({ direction: 'outbound', effective_direction: 'outbound', open_conflicts: 1 }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use the LifeOS version…' }))
    const group = screen.getByRole('group', { name: /This replaces what is at the service/ })
    expect(within(group).getByRole('checkbox')).toHaveFocus()
  })

  it('after resolving a conflict focus moves to the next one, or to the heading when none is left', async () => {
    const second: Conflict = { ...conflict, id: 6, title: 'Dentist' }
    conflictsAnswer = [conflict, second]
    server()
    shell(state({ direction: 'outbound', effective_direction: 'outbound', open_conflicts: 2 }))
    await screen.findByText('Dentist')
    conflictsAnswer = [second]
    fireEvent.click(screen.getAllByRole('button', { name: 'Keep the one at the service' })[0])
    await screen.findByText('Kept theirs')   // the row shows what was kept first, and leaves when its exit animation ends
    await exitOf('Team lunch')
    await waitFor(() => expect(screen.queryByText('Team lunch')).toBeNull())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep the one at the service' })).toHaveFocus())
    conflictsAnswer = []
    fireEvent.click(screen.getByRole('button', { name: 'Keep the one at the service' }))
    await screen.findByText('Kept theirs')
    await exitOf('Dentist')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'How it syncs' })).toHaveFocus())
  })

  it('a resolved conflict shows what was kept, then leaves on its own timer when no animation ends (focus moves after, not before)', async () => {
    const second: Conflict = { ...conflict, id: 6, title: 'Dentist' }
    conflictsAnswer = [conflict, second]
    server()
    shell(state({ direction: 'outbound', effective_direction: 'outbound', open_conflicts: 2 }))
    await screen.findByText('Dentist')
    conflictsAnswer = [second]
    fireEvent.click(screen.getAllByRole('button', { name: 'Keep both' })[0])
    await screen.findByText('Kept both')
    const row = screen.getByText('Team lunch').closest('li')!
    expect(row).toHaveClass('is-resolved')
    expect(row).toHaveFocus()                              // parked on the row, the next conflict is not focused yet
    expect(screen.getByRole('button', { name: 'Keep both' })).not.toHaveFocus()
    expect(changed).not.toHaveBeenCalled()                 // the list is only refreshed once the exit is over
    await waitFor(() => expect(screen.queryByText('Team lunch')).toBeNull(), { timeout: 2500 })   // safety timer: 1000 ms without animationend
    await waitFor(() => expect(document.activeElement?.closest('[data-conflict]')).toHaveAttribute('data-conflict', '6'))   // the next conflict
    expect(changed).toHaveBeenCalled()
  })

  it('focus is never left on the page body between the row leaving and the slow list reload', async () => {
    const second: Conflict = { ...conflict, id: 6, title: 'Dentist' }
    conflictsAnswer = [conflict, second]
    server()
    shell(state({ direction: 'outbound', effective_direction: 'outbound', open_conflicts: 2 }))
    await screen.findByText('Dentist')
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const inner = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', vi.fn(async (u: string, i?: RequestInit) => { if (/sync-conflicts$/.test(u)) await gate; return inner(u, i) }))   // the reload now takes as long as the test says
    conflictsAnswer = [second]
    fireEvent.click(screen.getAllByRole('button', { name: 'Keep both' })[0])
    await screen.findByText('Kept both')
    expect(document.activeElement).not.toBe(document.body)
    await exitOf('Team lunch')
    await waitFor(() => expect(screen.queryByText('Team lunch')).toBeNull())
    expect(document.activeElement).not.toBe(document.body)   // reload still pending
    expect(document.activeElement?.closest('[data-conflict]')).toHaveAttribute('data-conflict', '6')
    release()
    await waitFor(() => expect(changed).toHaveBeenCalled())
    expect(document.activeElement).not.toBe(document.body)
  })

  it('under reduced motion the chip stays about 600 ms and the row then goes without any animation', async () => {
    const reduce = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches: /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} })) as never
    try {
      conflictsAnswer = [conflict]
      server()
      shell(state({ direction: 'outbound', effective_direction: 'outbound', open_conflicts: 1 }))
      await screen.findByText('Team lunch')
      conflictsAnswer = []
      const t0 = Date.now()
      fireEvent.click(screen.getByRole('button', { name: 'Use the LifeOS version…' }))
      fireEvent.click(screen.getByRole('checkbox', { name: /I understand/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }))
      await screen.findByText('Kept yours')
      await waitFor(() => expect(screen.queryByText('Team lunch')).toBeNull(), { timeout: 2000 })
      expect(Date.now() - t0).toBeGreaterThanOrEqual(550)
      await waitFor(() => expect(screen.getByRole('heading', { name: 'How it syncs' })).toHaveFocus())
    } finally { window.matchMedia = reduce }
  })

  it('a failed run is announced as an alert', () => {
    server()
    shell(state({ last_outbound: { id: 1, status: 'failed', started_at: '2027-03-22T08:00:00Z', upserted: 0, error: 'The service said no.', details: {} } }))
    expect(screen.getByText('The service said no.')).toHaveAttribute('role', 'alert')   // the toaster has its own, empty alert region now
  })

  it('speaks Arabic and Dutch', () => {
    server()
    localStorage.setItem('lifeos-language', 'ar')
    shell(state())
    expect(screen.getByRole('heading', { name: 'كيف تتم المزامنة' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'إعدادات المزامنة' })).toBeInTheDocument()
    cleanup()
    localStorage.setItem('lifeos-language', 'nl')
    shell(state())
    expect(screen.getByRole('heading', { name: 'Hoe het synchroniseert' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Synchronisatie pauzeren' })).toBeInTheDocument()
  })
})
