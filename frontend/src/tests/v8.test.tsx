import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import { WriteAccess } from '../features/connected/WriteAccess'
import { SendToCalendar } from '../features/connected/SendToCalendar'
import type { WriteData, WriteState } from '../lib/calendarWrite'

type Route = { match: RegExp; method?: string; body: unknown; status?: number }
function mockApi(routes: Route[]) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes.find(r => r.match.test(url) && (!r.method || r.method === (init?.method || 'GET')))
    return new Response(JSON.stringify(route ? route.body : {}), { status: route ? route.status ?? 200 : 404 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
const user = { match: /\/api\/user$/, body: { id: 1, name: 'A', email: 'a@x.io' } }
const sent = (fetcher: ReturnType<typeof mockApi>, method: string, path: RegExp) => fetcher.mock.calls.filter(c => (c[1]?.method ?? 'GET') === method && path.test(String(c[0]))).map(c => c[1]?.body ? JSON.parse(c[1].body as string) : null)
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); vi.unstubAllGlobals() })

const off: WriteState = { available: true, granted: false, enabled: false, calendar_id: null, calendar_name: null, copies: 0 }

describe('opt-in write access', () => {
  it('is hidden when the server does not offer it and asks for a separate permission when it does', () => {
    mockApi([user])
    const { container, unmount } = render(wrap(<WriteAccess accountId={4} label="Google Calendar" write={{ ...off, available: false }} orphans={[]} onChanged={vi.fn()} />))
    expect(container.querySelector('.write-access')).toBeNull()
    unmount()
    render(wrap(<WriteAccess accountId={4} label="Google Calendar" write={off} orphans={[]} onChanged={vi.fn()} />))
    expect(screen.getByText('Off')).toBeInTheDocument()
    expect(screen.getByText(/one at a time, after a preview, only when you confirm/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Allow adding events/ })).toBeInTheDocument()
  })
  it('requires an explicit calendar before anything can be written, and can be turned off', async () => {
    const fetcher = mockApi([user, { match: /\/write\/calendars$/, body: { data: [{ id: 'me', name: 'Me', primary: true }, { id: 'work@group', name: 'Work', primary: false }] } }, { match: /\/accounts\/4\/write$/, method: 'PUT', body: { write: {} } }])
    const onChanged = vi.fn()
    const { unmount } = render(wrap(<WriteAccess accountId={4} label="Google Calendar" write={{ ...off, granted: true }} orphans={[]} onChanged={onChanged} />))
    const select = await screen.findByLabelText('Calendar for new events')
    await waitFor(() => expect(select).toHaveValue('me'))
    fireEvent.change(select, { target: { value: 'work@group' } })
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(sent(fetcher, 'PUT', /\/accounts\/4\/write$/)).toEqual([{ calendar_id: 'work@group' }]))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    unmount()
    render(wrap(<WriteAccess accountId={4} label="Google Calendar" write={{ ...off, granted: true, enabled: true, calendar_id: 'work@group', calendar_name: 'Work', copies: 2 }} orphans={[{ id: 7, account_id: 4, event_id: null, title: 'Old block', starts_at: '2027-03-23T09:00:00Z', ends_at: '2027-03-23T10:00:00Z', orphan: true, in_sync: false }]} onChanged={onChanged} />))
    expect(screen.getByText('Adds to “Work”. 2 event(s) added so far.')).toBeInTheDocument()
    expect(screen.getByText(/1 copy\(ies\) whose LifeOS event was deleted/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Turn off/ }))
    await waitFor(() => expect(sent(fetcher, 'PUT', /\/accounts\/4\/write$/).at(-1)).toEqual({ calendar_id: null }))
  })
})

describe('send to a calendar', () => {
  const data: WriteData = { enabled: true, targets: [{ id: 4, provider: 'google', email: 'me@gmail.com', calendar_name: 'Work' }, { id: 5, provider: 'outlook', email: 'me@work.com', calendar_name: 'Calendar' }],
    links: [{ id: 9, account_id: 5, event_id: 12, title: 'Deep work', starts_at: '2027-03-23T09:00:00Z', ends_at: '2027-03-23T11:00:00Z', orphan: false, in_sync: false }] }
  const preview = { op: 'create', account: { id: 4, provider: 'google', label: 'Google Calendar', email: 'me@gmail.com' }, calendar: { id: 'work@group', name: 'Work' }, before: null, after: { title: 'Deep work', starts_at: '2027-03-23T13:00:00Z', ends_at: '2027-03-23T15:00:00Z' }, token: 'signed-token', expires_at: '2027-03-23T08:10:00Z' }
  it('previews exactly one change and only makes it on confirmation', async () => {
    const fetcher = mockApi([user, { match: /\/api\/calendar-write\/preview$/, method: 'POST', body: preview }, { match: /\/api\/calendar-write\/confirm$/, method: 'POST', body: { op: 'create', link: {} } }])
    const onChanged = vi.fn()
    render(wrap(<SendToCalendar eventId={12} title="Deep work" data={data} onClose={vi.fn()} onChanged={onChanged} />))
    expect(screen.getByText('Copy is out of date')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText(/This changes Google Calendar \(me@gmail.com\) — calendar “Work”/)).toBeInTheDocument()
    expect(screen.getByText('Will be added')).toBeInTheDocument()
    expect(sent(fetcher, 'POST', /confirm$/)).toEqual([])
    expect(sent(fetcher, 'POST', /preview$/)).toEqual([{ op: 'create', account_id: 4, event_id: 12, link_id: null }])
    fireEvent.click(screen.getByRole('button', { name: /Confirm: Add event/ }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(sent(fetcher, 'POST', /confirm$/)).toEqual([{ token: 'signed-token' }])
  })
  it('shows a refused confirmation and changes nothing locally', async () => {
    mockApi([user, { match: /\/preview$/, method: 'POST', body: { ...preview, op: 'update', account: { ...preview.account, id: 5, label: 'Outlook Calendar' }, before: { title: 'Deep work', starts_at: '2027-03-23T09:00:00Z', ends_at: '2027-03-23T11:00:00Z' } } },
      { match: /\/confirm$/, method: 'POST', status: 422, body: { message: 'This event was changed in Outlook Calendar after LifeOS added it, so LifeOS left it alone.', errors: { calendar: ['This event was changed in Outlook Calendar after LifeOS added it, so LifeOS left it alone.'] } } }])
    const onChanged = vi.fn()
    render(wrap(<SendToCalendar eventId={12} title="Deep work" data={data} onClose={vi.fn()} onChanged={onChanged} />))
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(await screen.findByText('Now there')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Confirm: Update copy/ }))
    expect(await screen.findByText(/changed in Outlook Calendar after LifeOS added it/)).toBeInTheDocument()
    expect(onChanged).not.toHaveBeenCalled()
  })
})
