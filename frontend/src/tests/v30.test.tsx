import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import TasksPage from '../features/TasksPage'
import { setAccountZone } from '../lib/accountDay'

type Call = [string, RequestInit | undefined]
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
const task = { id: 7, title: 'Pay the invoice', status: 'todo', priority: 'high', due_at: '2027-03-09T10:00:00Z', estimated_minutes: 30 }

function stub() {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return new Response(JSON.stringify({ data: task }), { status: 200 })
    const body = /\/api\/user$/.test(url) ? { id: 1, name: 'A', email: 'a@x.io', timezone: 'Europe/Amsterdam' }
      : /\/api\/connected\/tasks/.test(url) ? []
      : /\/api\/tasks/.test(url) ? { data: [task], meta: { last_page: 1 } } : { data: [] }
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const patches = (f: ReturnType<typeof stub>) => (f.mock.calls as unknown as Call[]).filter(c => c[1]?.method === 'PATCH').map(c => JSON.parse(c[1]!.body as string))

beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals(); setAccountZone('Europe/Amsterdam'); vi.useFakeTimers({ toFake: ['Date'], now: new Date('2027-03-09T08:00:00Z') }) })
afterEach(() => { vi.useRealTimers(); setAccountZone(undefined) })

async function openTask() {
  render(wrap(<TasksPage />))
  fireEvent.click(await screen.findByText('Pay the invoice'))
}

describe('moving and prioritising a task in two taps', () => {
  it('moves a task to tomorrow at 17:00 in the account’s zone, and Undo puts the old date back', async () => {
    const fetcher = stub()
    await openTask()
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    await waitFor(() => expect(patches(fetcher)).toEqual([{ due_at: '2027-03-10T16:00:00.000Z' }]))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(patches(fetcher)).toEqual([{ due_at: '2027-03-10T16:00:00.000Z' }, { due_at: '2027-03-09T10:00:00Z' }]))
  })

  it('moves to next week (the coming Monday) and clears the date', async () => {
    const fetcher = stub()
    await openTask()
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))
    await waitFor(() => expect(patches(fetcher)).toEqual([{ due_at: '2027-03-15T16:00:00.000Z' }]))
    fireEvent.click(screen.getByRole('button', { name: 'No date' }))
    await waitFor(() => expect(patches(fetcher).at(-1)).toEqual({ due_at: null }))
  })

  it('changes the priority in one tap and shows the current one as selected', async () => {
    const fetcher = stub()
    await openTask()
    const group = screen.getByRole('radiogroup', { name: 'Priority' })
    expect(group.querySelector('[aria-checked="true"]')?.textContent).toMatch(/High/)
    fireEvent.click(screen.getByRole('radio', { name: /Urgent/ }))
    await waitFor(() => expect(patches(fetcher)).toEqual([{ priority: 'urgent' }]))
    // Picking the one it already has changes nothing.
    fireEvent.click(screen.getByRole('radio', { name: /High/ }))
    expect(patches(fetcher)).toHaveLength(1)
  })
})
