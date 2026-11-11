import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import { ToastProvider } from '../components/ui/Toaster'
import IntegrationsSettings from '../features/settings/IntegrationsSettings'

const EMAIL = 'a.very.long.address.for.testing@example-company.test'
const account = (over: Record<string, unknown> = {}) => ({ id: 3, provider: 'google', email: EMAIL, display_name: null, status: 'active', last_synced_at: null, last_error: null, events_count: 2, connected_at: null, collections: [], collections_managed: true, recent_runs: [], ...over })
const provider = (id: string, label: string, accounts: unknown[] = []) => ({ provider: id, label, category: 'calendars', implemented: true, configured: true, status: 'available', scopes: 'x', env_keys: [], redirect_uri: '', accounts })
let providers: ReturnType<typeof provider>[]
function server() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (/\/api\/user$/.test(url)) return json({ id: 1, name: 'A', email: 'a@x.io' })
    if (/\/api\/integrations$/.test(url)) return json({ providers, ai_connected_data: false, categories: [{ key: 'calendars', providers }] })
    return json({})
  }))
}
const banners = (role: 'alert' | 'status') => screen.queryAllByRole(role).filter(e => e.classList.contains('hub-notice'))
const toasts = () => document.querySelectorAll('.toast').length
const shell = (path = '/') => render(<ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[path]}><ToastProvider><AuthProvider><IntegrationsSettings /></AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>)

beforeEach(() => {
  cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); providers = [provider('google', 'Google Calendar', [account()])]
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('connected accounts hub: wave A defects', () => {
  it('the details sheet is titled by the provider and shows the email once, isolated as LTR', async () => {
    server(); shell()
    fireEvent.click(await screen.findByRole('button', { name: `Details of ${EMAIL}` }))
    const sheet = await screen.findByRole('dialog', { hidden: true })
    expect(within(sheet).getByRole('heading', { name: 'Google Calendar', hidden: true })).toBeInTheDocument()
    const inSheet = within(sheet).getAllByText(EMAIL, { selector: 'bdi', ignore: 'button *' })
    expect(inSheet).toHaveLength(1)
    expect(inSheet[0]).toHaveAttribute('dir', 'ltr')
    expect(within(sheet).queryByRole('heading', { name: EMAIL, hidden: true })).toBeNull()
  })

  it('the hub row keeps the email on one line with a full-value title and a bdi', async () => {
    server(); shell()
    const mail = (await screen.findAllByText(EMAIL, { selector: 'bdi' }))[0]
    expect(mail).toHaveAttribute('dir', 'ltr')
    expect(mail.parentElement).toHaveAttribute('title', EMAIL)
  })

  it('a provider id without a brand style gets a neutral letter tile', async () => {
    providers = [provider('microsoft', 'Microsoft Outlook'), provider('google', 'Google Calendar')]
    server(); shell()
    const tile = (await screen.findByText('M', { selector: '.provider-mark' }))
    expect(tile).toHaveAttribute('aria-hidden', 'true')
    expect(tile).toHaveClass('mark-fallback')
    expect(document.querySelectorAll('.provider-mark.google svg').length).toBe(1)
  })

  it('an OAuth return error is one persistent role=alert banner, with no extra toast, and can be dismissed', async () => {
    server(); shell('/?error=denied')
    await screen.findByText('Access was not granted, so nothing was connected.')
    expect(banners('alert')).toHaveLength(1)
    expect(banners('status')).toHaveLength(0)
    expect(toasts()).toBe(0)
    const alert = banners('alert')[0]
    expect(screen.getAllByText('Access was not granted, so nothing was connected.')).toHaveLength(1)
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss message' }))
    expect(banners('alert')).toHaveLength(0)
  })

  it('a successful return is exactly one polite status (not an alert), announced once', async () => {
    server(); shell('/?connected=google')
    await screen.findByText(/google connected\./)
    expect(banners('status')).toHaveLength(1)
    expect(banners('alert')).toHaveLength(0)
    expect(toasts()).toBe(0)
    expect(screen.getAllByText(/google connected\./)).toHaveLength(1)
  })

  it('both a granted permission and a connection are shown', async () => {
    server(); shell('/?connected=google&write_granted=1')
    await screen.findByText(/google connected\./)
    expect(screen.getByText(/Permission granted\./)).toBeInTheDocument()
    expect(banners('status')).toHaveLength(2)
  })

  it('the banner and its dismiss button read in Arabic and Dutch', async () => {
    localStorage.setItem('lifeos-language', 'nl'); server(); shell('/?connected=Google')
    await screen.findByText(/Google verbonden/)
    const nl = banners('status')[0]
    expect(within(nl).getByRole('button', { name: 'Bericht sluiten' })).toBeInTheDocument()
    cleanup(); localStorage.setItem('lifeos-language', 'ar'); shell('/?error=denied')
    await screen.findByText('لم يُمنح الوصول، لذلك لم يتم الربط.')
    const ar = banners('alert')[0]
    expect(within(ar).getByRole('button', { name: 'إغلاق الرسالة' })).toBeInTheDocument()
  })

  it('the disconnect dialog names the account, so two accounts of one provider are distinguishable', async () => {
    server(); shell()
    fireEvent.click(await screen.findByRole('button', { name: `Details of ${EMAIL}` }))
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect', hidden: true }))
    const cancel = await screen.findByRole('button', { name: 'Cancel', hidden: true })
    const line = document.getElementById('disconnect-account') as HTMLElement
    expect(line).toHaveTextContent(EMAIL)
    expect(line.querySelector('bdi')).toHaveAttribute('dir', 'ltr')
    expect(cancel.getAttribute('aria-describedby')).toContain('disconnect-account')
    expect(cancel).toHaveFocus()
  })
})
