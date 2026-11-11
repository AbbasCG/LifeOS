import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { useState, type ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import QuickAdd from '../components/layout/QuickAdd'
import { ChoiceGroup, PickerField } from '../components/ui/Choice'
import { BottomSheet } from '../components/visual'
import { RecordForm } from '../features/RecordForm'
import IntegrationsSettings from '../features/settings/IntegrationsSettings'
import { dueFor, dueForDay, openQuickAdd } from '../lib/quickAdd'
import { accountDay } from '../lib/accountDay'
import mobile from '../styles/mobile.css?raw'

const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter><ToastProvider>{children}</ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>
type Call = { method: string; url: string; body?: Record<string, unknown> }
function server(routes: { match: RegExp; method?: string; body: unknown; status?: number }[]) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET'
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined })
    const route = routes.find(r => r.match.test(String(url)) && (!r.method || r.method === method))
    return new Response(JSON.stringify(route ? route.body : {}), { status: route ? route.status ?? 200 : 404, headers: { 'Content-Type': 'application/json' } })
  }))
  return calls
}
beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en') })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('a day picked on the calendar', () => {
  it('is 17:00 that day, tonight when it is today and 17:00 has passed, and nothing when empty or invalid', () => {
    const now = new Date('2027-03-22T10:00:00Z')
    expect(dueForDay('2027-04-02', now)).toBe(dueFor('tomorrow', now) && dueForDay('2027-04-02', now))
    expect(dueForDay('2027-04-02', now)).toMatch(/^2027-04-0[12]T/)
    expect(dueForDay(accountDay(now), now)).toBe(dueFor('today', now))
    expect(dueForDay('', now)).toBeNull()
    expect(dueForDay('soon', now)).toBeNull()
  })
})

describe('choice groups replace drop-downs', () => {
  function Demo() {
    const [v, setV] = useState('medium')
    return <form data-testid="f"><ChoiceGroup label="Priority" name="priority" value={v} onChange={setV} options={[{ value: 'high', label: 'High' }, { value: 'medium', label: 'Normal' }, { value: 'low', label: 'Low' }]} /></form>
  }
  it('is a radio group: one tap changes the value, and a plain form post sees it', () => {
    render(<Demo />)
    expect(screen.getByRole('radiogroup', { name: 'Priority' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Normal' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'High' }))
    expect(screen.getByRole('radio', { name: 'High' })).toHaveAttribute('aria-checked', 'true')
    expect(Object.fromEntries(new FormData(screen.getByTestId('f') as HTMLFormElement))).toEqual({ priority: 'high' })
  })
})

describe('searchable pick-one field', () => {
  const options = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, title: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India'][i] }))
  function Demo() {
    const [v, setV] = useState('')
    return <form data-testid="f"><PickerField label="Project" name="project_id" value={v} onChange={setV} options={options} /></form>
  }
  it('shows the current choice on one line, searches a long list, picks and clears', () => {
    render(wrap(<Demo />))
    const trigger = screen.getByRole('button', { name: 'Project: None' })
    fireEvent.click(trigger)
    const search = screen.getByRole('searchbox', { name: 'Search' })
    fireEvent.change(search, { target: { value: 'ech' } })
    expect(screen.queryByRole('radio', { name: 'Alpha' })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Echo' }))
    expect(screen.getByRole('button', { name: 'Project: Echo' })).toBeInTheDocument()
    expect(Object.fromEntries(new FormData(screen.getByTestId('f') as HTMLFormElement))).toEqual({ project_id: '5' })
    fireEvent.click(screen.getByRole('button', { name: 'Project: Echo' }))
    fireEvent.click(screen.getByRole('radio', { name: 'None' }))
    expect(Object.fromEntries(new FormData(screen.getByTestId('f') as HTMLFormElement))).toEqual({ project_id: '' })
  })
  it('pressing Enter in the search box does not submit the form the field lives in', () => {
    const submit = vi.fn(e => e.preventDefault())
    render(wrap(<form onSubmit={submit}><PickerField label="Project" name="project_id" value="" onChange={() => {}} options={options} /></form>))
    fireEvent.click(screen.getByRole('button', { name: 'Project: None' }))
    const search = screen.getByRole('searchbox', { name: 'Search' })
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    search.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
    expect(submit).not.toHaveBeenCalled()
  })
  it('has no search box for a short list', () => {
    render(wrap(<PickerField label="Goal" value="" onChange={() => {}} options={options.slice(0, 3)} />))
    fireEvent.click(screen.getByRole('button', { name: 'Goal: None' }))
    expect(screen.queryByRole('searchbox')).toBeNull()
  })
})

describe('bottom sheet on a phone', () => {
  it('follows the visual viewport so the footer stays above the on-screen keyboard', () => {
    const listeners: Record<string, () => void> = {}
    const vv = { height: 844, offsetTop: 0, addEventListener: (n: string, f: () => void) => { listeners[n] = f }, removeEventListener: vi.fn() }
    vi.stubGlobal('visualViewport', vv)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 })
    render(wrap(<BottomSheet title="Sheet" onClose={() => {}} footer={<button>Save</button>}><input aria-label="x" /></BottomSheet>))
    const dialog = document.querySelector('dialog') as HTMLElement
    expect(dialog.style.getPropertyValue('--kb')).toBe('0px')
    vv.height = 500; act(() => listeners.resize?.())
    expect(dialog.style.getPropertyValue('--kb')).toBe('344px')
    expect(dialog.style.getPropertyValue('--vvh')).toBe('500px')
  })
  it('Escape on a sheet inside a sheet closes only the top one', () => {
    const outer = vi.fn(), inner = vi.fn()
    render(wrap(<BottomSheet title="Outer" onClose={outer}><BottomSheet title="Inner" onClose={inner}><p>hi</p></BottomSheet></BottomSheet>))
    fireEvent(screen.getByRole('dialog', { name: 'Inner', hidden: true }), new Event('cancel', { bubbles: true, cancelable: true }))
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
  })
})

describe('mobile stylesheet guarantees', () => {
  it('keeps inputs at 16px on touch screens (no iOS zoom) without blocking pinch-zoom', () => {
    expect(mobile).toMatch(/@media \(pointer: coarse\), \(max-width: 760px\)[\s\S]*?font-size: 16px/)
    expect(mobile.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/maximum-scale|user-scalable/)
  })
  it('sizes sheets with dvh, safe areas and the keyboard inset', () => {
    expect(mobile).toMatch(/92dvh/)
    expect(mobile).toMatch(/env\(safe-area-inset-bottom/)
    expect(mobile).toMatch(/var\(--kb, 0px\)/)
  })
  it('gives every choice at least a 44px target', () => {
    expect(mobile).toMatch(/\.choice \{[^}]*min-height: 44px; min-width: 44px/)
    expect(mobile).toMatch(/\.picker-trigger \{[^}]*min-height: 56px/)
    expect(mobile).toMatch(/\.qa-add \{[^}]*min-height: 56px/)
  })
})

describe('Quick add', () => {
  const open = async () => {
    server([{ match: /\/api\/assistant\/status/, body: { voice_allowed: false } }, { match: /\/api\/tasks$/, method: 'POST', body: { data: { id: 5 } }, status: 201 }])
    render(wrap(<QuickAdd />))
    act(() => openQuickAdd())
    return screen.findByLabelText('Task')
  }
  const post = () => vi.mocked(fetch).mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'POST' && String(c[0]).endsWith('/api/tasks')).map(c => JSON.parse((c[1] as RequestInit).body as string) as Record<string, unknown>)

  it('adds a task in two moves from the defaults: type, then the big Add button (today, normal)', async () => {
    const input = await open()
    expect(screen.getByRole('button', { name: 'Add task' })).toBeDisabled()
    fireEvent.change(input, { target: { value: 'Pay rent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    await waitFor(() => expect(post()).toHaveLength(1))
    expect(post()[0]).toMatchObject({ title: 'Pay rent', priority: 'medium', status: 'todo' })
    expect(typeof post()[0].due_at).toBe('string')
  })
  it('shows date and priority as direct one-tap choices with icons, and sends them', async () => {
    const input = await open()
    const when = screen.getByRole('radiogroup', { name: 'When' }), prio = screen.getByRole('radiogroup', { name: 'Priority' })
    for (const name of ['Today', 'Tomorrow', 'This week', 'No date']) expect(within(when).getByRole('radio', { name })).toBeInTheDocument()
    for (const name of ['Urgent', 'High', 'Normal', 'Low']) expect(within(prio).getByRole('radio', { name })).toBeInTheDocument()
    expect(when.querySelectorAll('svg').length).toBeGreaterThanOrEqual(4)
    expect(screen.getByRole('radio', { name: /Pick a date/ })).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'Call the bank' } })
    fireEvent.click(within(when).getByRole('radio', { name: 'Tomorrow' }))
    fireEvent.click(within(prio).getByRole('radio', { name: 'Urgent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    await waitFor(() => expect(post()).toHaveLength(1))
    expect(post()[0]).toMatchObject({ title: 'Call the bank', priority: 'urgent', due_at: dueFor('tomorrow') })
  })
  it('"No date" sends no due date; Log a habit and More details stay available', async () => {
    const input = await open()
    fireEvent.change(input, { target: { value: 'Someday' } })
    fireEvent.click(screen.getByRole('radio', { name: 'No date' }))
    expect(screen.getByRole('button', { name: /Log a habit/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /More details/ })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    await waitFor(() => expect(post()).toHaveLength(1))
    expect(post()[0].due_at).toBeNull()
  })
})

describe('Task details form', () => {
  const lists = [
    { match: /\/api\/projects/, body: { data: [{ id: 1, title: 'Website', color: '#336699' }, { id: 2, title: 'Home' }], meta: { last_page: 1 } } },
    { match: /\/api\/goals/, body: { data: [{ id: 4, title: 'Learn Spanish' }], meta: { last_page: 1 } } },
    { match: /\/api\/categories/, body: { data: [{ id: 7, title: 'Admin' }], meta: { last_page: 1 } } },
    { match: /\/api\/tasks\?/, body: { data: [], meta: { last_page: 1 } } },
    { match: /\/api\/tasks$/, method: 'POST', body: { data: { id: 9 } }, status: 201 },
  ]
  it('uses choices instead of drop-downs, keeps every field, and posts the same data as before', async () => {
    const calls = server(lists)
    const onSave = vi.fn(), onClose = vi.fn()
    render(wrap(<RecordForm resource="tasks" item={{}} onSave={onSave} onClose={onClose} />))
    const dialog = screen.getByRole('dialog')
    // No <select> anywhere: status, priority, duration, repeat are buttons.
    expect(dialog.querySelectorAll('select')).toHaveLength(0)
    for (const group of ['When', 'Priority', 'Status', 'Duration', 'Repeat']) expect(screen.getByRole('radiogroup', { name: group })).toBeInTheDocument()
    // Nothing was removed: the less common fields are under "More options".
    const more = dialog.querySelector('details.rf-more') as HTMLDetailsElement
    for (const name of [/Description/, /Remind me/, /Tags/, /Notes/, /Subtasks/]) expect(within(more).getAllByText(name).length).toBeGreaterThan(0)
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Draft the proposal' } })
    fireEvent.click(screen.getByRole('radio', { name: 'High' }))
    fireEvent.click(screen.getByRole('radio', { name: 'In progress' }))
    fireEvent.click(screen.getByRole('radio', { name: '1h' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Daily' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Project: None' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Website' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const body = calls.find(c => c.method === 'POST' && c.url.endsWith('/api/tasks'))!.body!
    expect(body).toMatchObject({ title: 'Draft the proposal', priority: 'high', status: 'in_progress', estimated_minutes: '60', recurrence: 'daily', project_id: 1, goal_id: null, category_id: null, tags: [], subtasks: [] })
    expect(Object.keys(body).sort()).toEqual(['category_id', 'description', 'due_at', 'estimated_minutes', 'goal_id', 'notes', 'priority', 'project_id', 'recurrence', 'remind_at', 'status', 'subtasks', 'tags', 'title'])
    expect(onSave).toHaveBeenCalled()
  })
  it('a deadline chip fills the deadline and "No date" clears it', async () => {
    server(lists)
    render(wrap(<RecordForm resource="tasks" item={{}} onSave={() => {}} onClose={() => {}} />))
    const trigger = () => document.querySelector('.rf-deadline .dtp-trigger') as HTMLElement
    expect(trigger().dataset.value).toBe('')
    fireEvent.click(screen.getByRole('radio', { name: 'Tomorrow' }))
    expect(trigger().dataset.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(screen.getByRole('radio', { name: 'Tomorrow' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'No date' }))
    expect(trigger().dataset.value).toBe('')
  })
  it('the Save button is in the sheet footer, outside the scrolling body', () => {
    server(lists)
    render(wrap(<RecordForm resource="tasks" item={{}} onSave={() => {}} onClose={() => {}} />))
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save.closest('.sheet-foot')).not.toBeNull()
    expect(save.closest('.sheet-body')).toBeNull()
  })
  it('other items keep their fields: an event still asks for start, end, type and task', () => {
    server(lists)
    render(wrap(<RecordForm resource="events" item={{}} onSave={() => {}} onClose={() => {}} />))
    expect(screen.getByText('Start')).toBeInTheDocument(); expect(screen.getByText('End')).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Type' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Task: / })).toBeInTheDocument()
  })
})

describe('Connected accounts, compact', () => {
  const account = { id: 3, provider: 'outlook', email: 'me@outlook.com', display_name: null, status: 'active', last_synced_at: null, last_error: null, events_count: 2, connected_at: null, collections: [], collections_managed: false }
  const outlook = { provider: 'outlook', label: 'Outlook Calendar', category: 'calendars', implemented: true, configured: true, status: 'available', scopes: 'Calendars.Read', env_keys: [], redirect_uri: '', required_scopes: [], accounts: [account] }
  const hub = (accounts = [account]) => ({ providers: [{ ...outlook, accounts }], ai_connected_data: false, categories: [{ key: 'calendars', providers: [{ ...outlook, accounts }] }] })
  it('keeps explanations out of the page: icons, short labels, and the long text behind (i)', async () => {
    server([{ match: /\/api\/integrations$/, body: hub() }, { match: /\/api\/user$/, body: { id: 1 } }])
    render(wrap(<IntegrationsSettings />))
    expect(await screen.findByText('Outlook Calendar')).toBeInTheDocument()
    expect(screen.queryByText(/never creates, edits or deletes|LifeOS never creates/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'About connections' }))
    expect(await screen.findByText(/creates, changes or deletes nothing there unless you allow it/)).toBeInTheDocument()
  })
  it('puts the status and the action on the row: sync is one icon button, details open on request', async () => {
    const calls = server([{ match: /\/api\/integrations$/, body: hub() }, { match: /\/api\/integrations\/accounts\/3\/sync$/, method: 'POST', body: { imported: 1, run: null } }, { match: /\/api\/user$/, body: { id: 1 } }])
    render(wrap(<IntegrationsSettings />))
    expect(await screen.findByText('Not synced yet')).toBeInTheDocument()
    const sync = screen.getByRole('button', { name: /^Sync now/ })
    expect(sync.textContent).toBe('')   // an icon, named for assistive technology
    fireEvent.click(sync)
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && /accounts\/3\/sync$/.test(c.url))).toBe(true))
    expect(screen.queryByText('Last successful sync')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Details of me@outlook.com' }))
    expect(await screen.findByText('Last successful sync')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Disconnect/ })).toBeInTheDocument()
  })
  it('a revoked account offers Reconnect right on the row', async () => {
    server([{ match: /\/api\/integrations$/, body: hub([{ ...account, status: 'revoked' }]) }, { match: /\/api\/user$/, body: { id: 1 } }])
    render(wrap(<IntegrationsSettings />))
    expect(await screen.findByText('Access revoked')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Reconnect/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Sync now/ })).toBeNull()
  })
  it('shows a loading skeleton and an error message instead of a blank page', async () => {
    server([{ match: /\/api\/integrations$/, body: { message: 'Server error' }, status: 500 }, { match: /\/api\/user$/, body: { id: 1 } }])
    const { container } = render(wrap(<IntegrationsSettings />))
    expect(container.querySelector('.skeleton')).not.toBeNull()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})
