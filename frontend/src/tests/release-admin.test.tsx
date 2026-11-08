import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { AuthProvider } from '../contexts/AuthContext'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { ConfirmPasswordProvider } from '../components/ui/ConfirmPasswordProvider'
import ReleaseAdminPage from '../features/discovery/ReleaseAdminPage'
import type { AdminRelease } from '../lib/discovery'

const HASH = 'c851cb5cbd8ad46c17daa3b8aa05faa93f5df9098d66ad1087a0428e15f2671b'
const t3 = (x: string) => ({ ar: `ar ${x}`, nl: `nl ${x}`, en: `en ${x}` })
const release = (over: Partial<AdminRelease> = {}): AdminRelease => ({
  key: 'r-one', date: '2026-11-08', revision: 1, importance: 'normal', title: t3('Title'), items: 2, registered: true, review_status: 'draft', deploy_status: 'live', deployed_sha: 'a'.repeat(40),
  content_hash: HASH, approved_hash: null, live_since: '2026-11-08T10:00:00+00:00', reviewed_at: null, visible: false,
  preview: { title: t3('Title'), summary: t3('Summary'), audiences: ['web', 'mobile'], items: [{ type: 'new', feature: 'quick-capture' }, { type: 'fixed', title: t3('Sign-out fix'), body: t3('Waiting changes are kept'), link: '/updates' }],
    features: [{ id: 'quick-capture', category: 'tasks', name: t3('Quick capture'), description: t3('Type a phrase'), route: '/tasks', requires: [], tour: 'quick-tour' }],
    tours: [{ id: 'quick-tour', title: t3('Tour'), steps: [{ target: 'quick-add', title: t3('Step one'), body: t3('Tour body') }] }] }, ...over,
})

type Call = { method: string; url: string; body?: unknown }
let calls: Call[], user: Record<string, unknown>, list: { data: AdminRelease[]; activation: { enabled: boolean; status: string; detail: string } }, approveAnswers: Response[]
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
function server() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === '/api/user') return json(user)
    if (/\/api\/admin\/discovery\/releases$/.test(url)) return list === null as never ? json({ message: 'The announcement files in the running code are invalid: x', code: 'content_invalid' }, 503) : json(list)
    if (/\/approve$/.test(url)) return approveAnswers.shift() ?? json({ data: {} })
    if (/\/withdraw$/.test(url)) return json({ data: {} })
    if (url === '/api/security/confirm-password') return json({})
    return json({})
  }))
}
const shell = () => render(<ThemeProvider><LanguageProvider><ToastProvider><AuthProvider><ConfirmPasswordProvider><MemoryRouter initialEntries={['/admin/releases']}><Routes><Route path="*" element={<ReleaseAdminPage />} /></Routes></MemoryRouter></ConfirmPasswordProvider></AuthProvider></ToastProvider></LanguageProvider></ThemeProvider>)
const listCalls = () => calls.filter(c => c.method === 'GET' && /admin\/discovery\/releases$/.test(c.url)).length

beforeEach(() => {
  cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en')
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
  user = { id: 1, name: 'Admin', email: 'a@example.test', is_admin: true, two_factor_enabled: true }
  list = { data: [release()], activation: { enabled: true, status: 'confirmed', detail: 'ok' } }
  approveAnswers = []
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('approving updates', () => {
  it('is for administrators only and asks the server for nothing else', async () => {
    user = { ...user, is_admin: false }
    server()
    shell()
    expect(await screen.findByText('Administrators only')).toBeInTheDocument()
    expect(calls.some(c => /admin\/discovery/.test(c.url))).toBe(false)
  })

  it('shows status, the activation state, the fingerprint and the exact text in each language', async () => {
    list.activation = { enabled: false, status: 'disabled', detail: 'off' }
    server()
    shell()
    expect(await screen.findByRole('heading', { name: /en Title/, level: 2 })).toBeInTheDocument()
    expect(screen.getByText('Draft')).toBeInTheDocument()
    expect(screen.getByText('In the running code')).toBeInTheDocument()
    expect(screen.getByText('Not visible')).toBeInTheDocument()
    expect(screen.getByText(/switched off on the server/)).toBeInTheDocument()
    expect(screen.getByText(`${HASH.slice(0, 16)}…`)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Read the exact text'))
    expect(screen.getByText(/en Sign-out fix: en Waiting changes are kept/)).toBeInTheDocument()
    expect(screen.getByText(/en Step one/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'العربية' }))
    expect(screen.getByText(/ar Sign-out fix: ar Waiting changes are kept/)).toBeInTheDocument()
    expect(screen.getByText(/ar Step one/).closest('[lang="ar"]')).toHaveAttribute('dir', 'rtl')
    fireEvent.click(screen.getByRole('button', { name: 'Nederlands' }))
    expect(screen.getByText(/nl Quick capture: nl Type a phrase/)).toBeInTheDocument()
  })

  it('approves only after the reviewer says they read it, naming the fingerprint, and asks for the password when the server wants it', async () => {
    approveAnswers = [json({ message: 'Password confirmation required.' }, 423)]
    server()
    shell()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    const dialog = await screen.findByRole('dialog', { name: 'Approve this update?' })
    expect(within(dialog).getByText(HASH)).toBeInTheDocument()
    const go = within(dialog).getByRole('button', { name: 'Approve' })
    expect(go).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I read the text/ }))
    expect(go).toBeEnabled()
    fireEvent.click(go)
    const confirm = await screen.findByRole('dialog', { name: 'Confirm it’s you' })
    fireEvent.change(within(confirm).getByLabelText(/password/i), { target: { value: 'secret-password' } })
    fireEvent.submit(confirm.querySelector('form') as HTMLFormElement)
    await waitFor(() => expect(calls.filter(c => /\/approve$/.test(c.url))).toHaveLength(2))
    expect(calls.filter(c => /\/approve$/.test(c.url)).every(c => (c.body as { content_hash: string }).content_hash === HASH)).toBe(true)
    await waitFor(() => expect(listCalls()).toBeGreaterThanOrEqual(2))
  })

  it('when the text changed meanwhile (409) it shows the current text instead of approving', async () => {
    approveAnswers = [json({ message: 'The announcement changed after you opened it. Review the current text and approve again.', code: 'content_changed' }, 409)]
    server()
    shell()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    const dialog = await screen.findByRole('dialog', { name: 'Approve this update?' })
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Approve this update?' })).toBeNull())
    await waitFor(() => expect(listCalls()).toBeGreaterThanOrEqual(2))
    expect(await screen.findByText(/changed after you opened it/)).toBeInTheDocument()
  })

  it('says why approving is not possible instead of offering a button that cannot work', async () => {
    list.data = [release({ registered: false, review_status: null, deploy_status: null })]
    server()
    shell()
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByText('It must first be registered by a healthy deploy.')).toBeInTheDocument()
    expect(screen.getByText('Not registered yet')).toBeInTheDocument()
    cleanup()
    user = { ...user, two_factor_enabled: false }
    list.data = [release()]
    server()
    shell()
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByText(/Turn on two-factor authentication first/)).toBeInTheDocument()
  })

  it('an approved release can be withdrawn at once, and an approval that no longer matches the text is flagged', async () => {
    list.data = [release({ review_status: 'approved', approved_hash: HASH, visible: true })]
    server()
    shell()
    expect(await screen.findByText('Already approved.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }))
    const dialog = await screen.findByRole('dialog', { name: 'Withdraw this update?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && /r-one\/withdraw$/.test(c.url))).toBe(true))
    cleanup()
    list.data = [release({ review_status: 'approved', approved_hash: 'b'.repeat(64), visible: false })]
    server()
    shell()
    expect(await screen.findByRole('alert')).toHaveTextContent('The text changed after it was approved')
    expect(screen.getByRole('button', { name: 'Approve the new text' })).toBeEnabled()
  })

  it('shows the server’s message when the files in the code are invalid', async () => {
    list = null as never
    server()
    shell()
    expect(await screen.findByRole('alert')).toHaveTextContent('announcement files in the running code are invalid')
  })
})
