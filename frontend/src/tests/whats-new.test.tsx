import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import DiscoveryHost from '../features/discovery/DiscoveryHost'
import UpdatesPage from '../features/discovery/UpdatesPage'
import { ReleaseBody } from '../features/discovery/ReleaseBody'
import { calmMoment, type DiscoveryItem, type HistoryRelease, type Release } from '../lib/discovery'

const item = (over: Partial<DiscoveryItem> = {}): DiscoveryItem => ({ type: 'new', title: 'Quick capture', body: 'Type a phrase and LifeOS reads the time.', feature: 'quick-capture', can_try: true, unavailable_reason: null, tour: null, tried: false, is_new: true, link: null, ...over })
const release = (over: Partial<Release> = {}): Release => ({ key: 'r-one', date: '2026-11-08', revision: 1, importance: 'important', title: 'Smarter capture', summary: 'Write tasks the way you speak.', items: [item()], ...over })

type Call = { method: string; url: string; body: unknown }
let calls: Call[]
function server(routes: { bootstrap?: unknown; releases?: HistoryRelease[]; tryAnswer?: unknown }) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    let body: unknown = {}
    if (/\/api\/discovery\/bootstrap/.test(url)) body = { data: routes.bootstrap ?? { announcement: null, update_required: false, counts: { unseen_updates: 0 }, preferences: { hints_enabled: true } } }
    else if (/\/api\/discovery\/releases/.test(url)) body = { data: routes.releases ?? [] }
    else if (/\/api\/discovery\/features\/.+\/try/.test(url)) body = routes.tryAnswer ?? { data: { available: true, reason: null, route: '/tasks', tour: null } }
    else if (/\/api\/discovery\/states\//.test(url)) body = { data: {} }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}
const states = () => calls.filter(c => c.method === 'PUT').map(c => `${c.url.split('/states/')[1]} ${(c.body as { action: string }).action}`)

function Where() { return <p data-testid="where">{useLocation().pathname}</p> }
const shell = (ui: ReactNode, path = '/') => render(<ThemeProvider><LanguageProvider><ToastProvider><MemoryRouter initialEntries={[path]}><Routes><Route path="*" element={<>{ui}<Where /></>} /></Routes></MemoryRouter></ToastProvider></LanguageProvider></ThemeProvider>)

beforeEach(() => {
  cleanup(); localStorage.clear(); sessionStorage.clear()
  localStorage.setItem('lifeos-language', 'en')
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => { vi.useRealTimers(); cleanup(); vi.unstubAllGlobals() })

const idle = () => act(async () => { await vi.advanceTimersByTimeAsync(2500) })

describe('the What’s New announcement', () => {
  it('shows nothing when the server has no announcement', async () => {
    server({})
    shell(<DiscoveryHost />)
    await idle()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(0)
  })

  it('shows the announcement once the app is idle, records that it was seen, and "Got it" ends it', async () => {
    server({ bootstrap: { announcement: release(), update_required: false, counts: { unseen_updates: 1 }, preferences: { hints_enabled: true } } })
    shell(<DiscoveryHost />)
    expect(screen.queryByText('Smarter capture')).not.toBeInTheDocument()   // not before the app is idle
    await idle()
    const dialog = await screen.findByRole('dialog', { name: 'Smarter capture' })
    expect(within(dialog).getByText('Write tasks the way you speak.')).toBeInTheDocument()
    expect(within(dialog).getByRole('heading', { name: /^New$/ })).toBeInTheDocument()
    await waitFor(() => expect(states()).toContain('release/r-one seen'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Got it' }))
    await waitFor(() => expect(states()).toContain('release/r-one dismissed'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('"Later" asks the server to postpone it', async () => {
    server({ bootstrap: { announcement: release(), update_required: false, counts: { unseen_updates: 1 }, preferences: { hints_enabled: true } } })
    shell(<DiscoveryHost />)
    await idle()
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }))
    await waitFor(() => expect(states()).toContain('release/r-one snoozed'))
    expect(states()).not.toContain('release/r-one dismissed')
  })

  it('is shown at most once per browser session', async () => {
    server({ bootstrap: { announcement: release(), update_required: false, counts: { unseen_updates: 1 }, preferences: { hints_enabled: true } } })
    const first = shell(<DiscoveryHost />)
    await idle()
    await screen.findByRole('dialog')
    first.unmount()
    cleanup()
    calls.length = 0
    shell(<DiscoveryHost />)
    await idle()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(calls).toHaveLength(0)   // it does not even ask again
  })

  it('does not interrupt typing, and shows up once the person stops', async () => {
    server({ bootstrap: { announcement: release(), update_required: false, counts: { unseen_updates: 1 }, preferences: { hints_enabled: true } } })
    shell(<><input aria-label="Task" /><DiscoveryHost /></>)
    screen.getByLabelText('Task').focus()
    expect(calmMoment()).toBe(false)
    await idle()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    ;(document.activeElement as HTMLElement).blur()
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000) })
    expect(await screen.findByRole('dialog', { name: 'Smarter capture' })).toBeInTheDocument()
  })

  it('"Try now" starts the feature’s tour when the server names one', async () => {
    const started = vi.fn()
    window.addEventListener('lifeos:start-tour', started)
    server({ bootstrap: { announcement: release(), update_required: false, counts: { unseen_updates: 1 }, preferences: { hints_enabled: true } }, tryAnswer: { data: { available: true, reason: null, route: '/tasks', tour: 'quick-tour' } } })
    shell(<DiscoveryHost />)
    await idle()
    fireEvent.click(await screen.findByRole('button', { name: 'Try now' }))
    await waitFor(() => expect(started).toHaveBeenCalledTimes(1))
    expect((started.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: 'quick-tour' })
    window.removeEventListener('lifeos:start-tour', started)
  })

  it('"Try now" asks the server and goes to the page it names; an unavailable feature stays put', async () => {
    server({ bootstrap: { announcement: release(), update_required: false, counts: { unseen_updates: 1 }, preferences: { hints_enabled: true } } })
    shell(<DiscoveryHost />)
    await idle()
    fireEvent.click(await screen.findByRole('button', { name: 'Try now' }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/tasks'))
    expect(calls.some(c => c.method === 'POST' && /features\/quick-capture\/try/.test(c.url))).toBe(true)
    await waitFor(() => expect(states()).toContain('release/r-one dismissed'))
  })

  it('stays where it is and says so when the server refuses the feature', async () => {
    server({ bootstrap: { announcement: release(), update_required: false, counts: { unseen_updates: 1 }, preferences: { hints_enabled: true } }, tryAnswer: { data: { available: false, reason: 'setup_needed', route: null, tour: null } } })
    shell(<DiscoveryHost />)
    await idle()
    fireEvent.click(await screen.findByRole('button', { name: 'Try now' }))
    expect(await screen.findByText(/not available for your account/i)).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('asks for a reload when this tab is older than the update, and never reloads by itself', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    server({ bootstrap: { announcement: null, update_required: true, counts: { unseen_updates: 0 }, preferences: { hints_enabled: true } } })
    shell(<DiscoveryHost />)
    await idle()
    expect(await screen.findByText(/new version of LifeOS is ready/i)).toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
  })

  it('reads in Arabic with the right direction and in Dutch with Dutch labels', async () => {
    server({ bootstrap: { announcement: release({ title: 'عنوان' }), update_required: false, counts: { unseen_updates: 1 }, preferences: { hints_enabled: true } } })
    localStorage.setItem('lifeos-language', 'ar')
    shell(<DiscoveryHost />)
    await idle()
    expect(await screen.findByRole('dialog', { name: 'عنوان' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'حسنًا' })).toBeInTheDocument()
    expect(document.documentElement.dir).toBe('rtl')
    cleanup(); sessionStorage.clear()
    localStorage.setItem('lifeos-language', 'nl')
    shell(<DiscoveryHost />)
    await idle()
    expect(await screen.findByRole('button', { name: 'Begrepen' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Probeer nu' })).toBeInTheDocument()
  })
})

describe('release items', () => {
  it('groups by kind, has no Try button for something that cannot be tried, and media is never autoplayed', () => {
    const items = [
      item({ type: 'important', title: 'Read this', body: 'b', can_try: false, feature: null, is_new: false }),
      item({ type: 'fixed', title: 'A fix', body: 'b', can_try: false, feature: null, is_new: false, image: { src: '/discovery/r/a.png', alt: 'A screenshot' } }),
      item({ type: 'improved', title: 'Faster', body: 'b', can_try: true, video: { src: '/discovery/r/v.mp4', poster: '/discovery/r/p.png', captions: '/discovery/r/c.vtt', label: 'How it works' } }),
    ]
    const { container } = shell(<ReleaseBody items={items} onTry={() => {}} />)
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['Important', 'Improved', 'Fixed'])
    expect(screen.getAllByRole('button', { name: 'Try now' })).toHaveLength(1)
    expect(screen.getByAltText('A screenshot')).toHaveAttribute('src', '/discovery/r/a.png')
    const video = container.querySelector('video')!
    expect(video).toHaveAttribute('controls')
    expect(video).not.toHaveAttribute('autoplay')
    expect(video.getAttribute('preload')).toBe('none')
    expect(video).toHaveAttribute('poster', '/discovery/r/p.png')
    expect(video.querySelector('track')).toHaveAttribute('kind', 'captions')
  })
})

describe('the update history', () => {
  const history = (over: Partial<HistoryRelease> = {}): HistoryRelease => ({ ...release(), seen: false, helpful: null, ...over })

  it('lists the releases newest first, marks the unseen ones as seen, and has an empty state', async () => {
    server({ releases: [history({ key: 'r-two', title: 'Second', date: '2026-11-09' }), history({ key: 'r-one', title: 'First', seen: true })] })
    shell(<UpdatesPage />, '/updates')
    expect(await screen.findByRole('heading', { name: 'Second' })).toBeInTheDocument()
    expect(screen.getAllByRole('article')).toHaveLength(2)
    await waitFor(() => expect(states()).toEqual(['release/r-two seen']))   // r-one was already seen
    cleanup()
    server({ releases: [] })
    shell(<UpdatesPage />, '/updates')
    expect(await screen.findByText('No updates yet')).toBeInTheDocument()
  })

  it('records a yes or no on whether it was useful, nothing else', async () => {
    server({ releases: [history({ seen: true })] })
    shell(<UpdatesPage />, '/updates')
    const yes = await screen.findByRole('button', { name: 'Useful' })
    fireEvent.click(yes)
    await waitFor(() => expect(states()).toEqual(['release/r-one helpful']))
    expect(yes).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Not useful' }))
    await waitFor(() => expect(states()).toContain('release/r-one unhelpful'))
    expect(screen.getByRole('button', { name: 'Not useful' })).toHaveAttribute('aria-pressed', 'true')
    for (const c of calls.filter(c => c.method === 'PUT')) expect(Object.keys(c.body as object).sort()).toEqual(['action', 'surface'])
  })
})
