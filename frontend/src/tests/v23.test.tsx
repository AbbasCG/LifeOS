import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import OfflineSync from '../components/layout/OfflineSync'
import { completeTaskOrQueue, confirmSignOut, createTaskOrQueue, enqueue, logHabitOrQueue, openSync, pendingItems, sendAllPending, sendPending, setOfflineOwner } from '../lib/offline'

type Call = [string, RequestInit | undefined]
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider>{children}</ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
let online = true
beforeEach(() => {
  cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals()
  online = true
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
  setOfflineOwner(1)
})
afterEach(() => { vi.restoreAllMocks(); setOfflineOwner(null) })

/** A server with one task (id 5) and one habit (id 3); everything else is 404. */
function server(task: { status: string; updated_at: string } | null = { status: 'todo', updated_at: '2027-01-04T10:00:00Z' }) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (/\/api\/tasks\/5$/.test(url)) return task ? new Response(JSON.stringify({ data: { id: 5, title: 'Pay rent', ...task } }), { status: 200 }) : new Response('{"message":"Not found."}', { status: 404 })
    if (/\/api\/tasks$/.test(url) && method === 'POST') return new Response(JSON.stringify({ data: { id: 9 } }), { status: 201 })
    if (/\/api\/habits\/3\/entry$/.test(url)) return new Response('{"message":"Saved."}', { status: 200 })
    return new Response('{"message":"Not found."}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const calls = (f: ReturnType<typeof server>, method: string) => (f.mock.calls as unknown as Call[]).filter(c => (c[1]?.method ?? 'GET') === method)

describe('keeping changes on this device', () => {
  it('queues instead of failing when offline or when the server cannot be reached', async () => {
    online = false
    const fetcher = server()
    expect(await createTaskOrQueue({ title: 'Buy milk', priority: 'high' })).toBe('queued')
    expect(await completeTaskOrQueue({ id: 5, title: 'Pay rent', updated_at: '2027-01-04T10:00:00Z' })).toBe('queued')
    expect(await logHabitOrQueue({ id: 3, title: 'Read' }, '2027-01-04', true)).toBe('queued')
    expect(fetcher).not.toHaveBeenCalled()
    online = true
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await completeTaskOrQueue({ id: 6, title: 'Water plants' })).toBe('queued')
    const items = pendingItems()
    expect(items.map(i => i.kind)).toEqual(['task.create', 'task.complete', 'habit.log', 'task.complete'])
    expect(items[0].payload).toMatchObject({ title: 'Buy milk', priority: 'high', client_id: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    expect(items[1].base).toBe('2027-01-04T10:00:00Z')
  })

  it('belongs to one account and is cleared on sign-out after asking', () => {
    enqueue({ kind: 'habit.log', label: 'Read', payload: { habit_id: 3, date: '2027-01-04', completed: true } })
    setOfflineOwner(2)
    expect(pendingItems()).toEqual([])
    setOfflineOwner(1)
    expect(pendingItems()).toHaveLength(1)
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    expect(confirmSignOut(n => `${n} will be deleted`)).toBe(false)
    expect(pendingItems()).toHaveLength(1)
    expect(confirmSignOut(n => `${n} will be deleted`)).toBe(true)
    expect(pendingItems()).toEqual([])
    setOfflineOwner(null)
    expect(() => enqueue({ kind: 'habit.log', label: 'Read', payload: {} })).toThrow(/Sign in again/)
  })
})

describe('sending, only when asked, without silent overwrites', () => {
  const queueCompletion = () => enqueue({ kind: 'task.complete', label: 'Pay rent', payload: { task_id: 5 }, base: '2027-01-04T10:00:00Z' })

  it('sends an unchanged completion, a new task (with its device id) and a habit', async () => {
    const fetcher = server()
    queueCompletion()
    enqueue({ kind: 'task.create', label: 'Buy milk', payload: { title: 'Buy milk', client_id: '11111111-2222-4333-8444-555555555555' } })
    enqueue({ kind: 'habit.log', label: 'Read', payload: { habit_id: 3, date: '2027-01-04', completed: true } })
    expect(await sendAllPending()).toEqual({ sent: 3, already: 0, conflict: 0, offline: false })
    expect(pendingItems()).toEqual([])
    expect(JSON.parse(calls(fetcher, 'PATCH')[0][1]!.body as string)).toEqual({ status: 'completed' })
    expect(JSON.parse(calls(fetcher, 'POST')[0][1]!.body as string).client_id).toBe('11111111-2222-4333-8444-555555555555')
  })

  it('turns a task changed or deleted elsewhere into a conflict, and sends only on the user’s decision', async () => {
    let fetcher = server({ status: 'in_progress', updated_at: '2027-01-04T12:00:00Z' })
    queueCompletion()
    expect(await sendAllPending()).toMatchObject({ conflict: 1 })
    expect(calls(fetcher, 'PATCH')).toHaveLength(0)
    expect(pendingItems()[0]).toMatchObject({ state: 'conflict', reason: 'changed' })
    expect(await sendPending(pendingItems()[0], true)).toBe('sent')
    expect(calls(fetcher, 'PATCH')).toHaveLength(1)

    fetcher = server(null)
    queueCompletion()
    expect(await sendPending(pendingItems()[0])).toBe('conflict')
    expect(pendingItems()[0]).toMatchObject({ reason: 'deleted' })
    expect(calls(fetcher, 'PATCH')).toHaveLength(0)
  })

  it('drops a completion already done elsewhere, and keeps everything when the connection drops', async () => {
    server({ status: 'completed', updated_at: '2027-01-04T12:00:00Z' })
    queueCompletion()
    expect(await sendAllPending()).toMatchObject({ already: 1 })
    expect(pendingItems()).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    queueCompletion()
    expect(await sendAllPending()).toMatchObject({ offline: true, sent: 0 })
    expect(pendingItems()).toHaveLength(1)
  })
})

describe('Waiting to sync', () => {
  it('shows the count, never sends by itself, and sends on Send all', async () => {
    const fetcher = server()
    enqueue({ kind: 'habit.log', label: 'Read', payload: { habit_id: 3, date: '2027-01-04', completed: true } })
    online = false
    render(wrap(<OfflineSync />))
    expect(screen.getByRole('button', { name: /1 waiting to sync/ })).toBeInTheDocument()
    act(() => openSync())
    const sheet = await screen.findByRole('dialog', { name: 'Waiting to sync' })
    expect(sheet).toHaveTextContent('Read')
    expect(screen.getByRole('button', { name: /Send all/ })).toBeDisabled()
    // Back online: a suggestion to review, nothing sent.
    online = true
    act(() => { window.dispatchEvent(new Event('online')) })
    expect(await screen.findByText(/Back online\. 1 change\(s\) waiting to sync\./)).toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Send all/ }))
    expect(await screen.findByText('1 change(s) sent.')).toBeInTheDocument()
    expect(pendingItems()).toEqual([])
    expect(calls(fetcher, 'PUT')).toHaveLength(1)
  })

  it('offers “Complete anyway” for a changed task and lets any item be discarded', async () => {
    server({ status: 'in_progress', updated_at: '2027-01-04T12:00:00Z' })
    enqueue({ kind: 'task.complete', label: 'Pay rent', payload: { task_id: 5 }, base: '2027-01-04T10:00:00Z' })
    await sendAllPending()
    render(wrap(<OfflineSync />))
    act(() => openSync())
    expect(await screen.findByText('Changed on another device since then.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Complete anyway' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Discard “Pay rent”' }))
    await waitFor(() => expect(pendingItems()).toEqual([]))
    expect(await screen.findByText('Everything is in sync.')).toBeInTheDocument()
  })
})
