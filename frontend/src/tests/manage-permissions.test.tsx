import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { ManagePermissions } from '../features/connected/ManagePermissions'
import type { PermissionState } from '../lib/connectionPermissions'

const calendar = (over: Partial<PermissionState> = {}): PermissionState => ({
  granted: ['read', 'sync'], effective: ['read', 'sync'], capabilities: ['read', 'sync', 'export', 'create', 'update', 'delete'], presets: ['read_only', 'read_create', 'read_create_update', 'full'],
  preset: 'read_only', legacy: false, blocked: {}, changed_at: null, ...over,
})
const tasks = (over: Partial<PermissionState> = {}): PermissionState => ({ granted: ['read', 'sync', 'import'], effective: ['read', 'sync', 'import'], capabilities: ['read', 'sync', 'import'], presets: ['read_only'], preset: 'read_only', legacy: false, blocked: {}, changed_at: null, ...over })

type Call = { method: string; url: string; body?: Record<string, unknown> }
let calls: Call[], answer: { status: number; body: unknown }
const changed = vi.fn()
function server() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (/\/write\/connect$/.test(url)) return new Response(JSON.stringify({ authorization_url: '/after-consent' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
  }))
}
const shell = (state: PermissionState) => render(<ThemeProvider><LanguageProvider><ToastProvider><MemoryRouter><ManagePermissions accountId={7} label="Google Calendar" state={state} onChanged={changed} /></MemoryRouter></ToastProvider></LanguageProvider></ThemeProvider>)
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Manage permissions' }))
const puts = () => calls.filter(c => c.method === 'PUT')

beforeEach(() => {
  cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en'); changed.mockClear()
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
  answer = { status: 200, body: { data: {} } }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('manage permissions', () => {
  it('shows what is allowed now and what is not, in words and for screen readers', () => {
    server()
    shell(calendar({ granted: ['read', 'sync', 'export', 'create'], effective: ['read', 'sync', 'export', 'create'], preset: 'read_create' }))
    const list = screen.getByRole('list', { name: 'Allowed now' })
    const item = (name: string) => within(list).getAllByRole('listitem').find(li => li.textContent?.endsWith(name)) as HTMLElement
    expect(item('Read')).toHaveTextContent('Allowed: Read')
    expect(item('Create')).toHaveTextContent('Allowed: Create')
    expect(item('Delete')).toHaveTextContent('Not allowed: Delete')
    expect(item('Delete')).toHaveClass('off')
  })

  it('says an earlier connection keeps what it could do and has no Delete', () => {
    server()
    shell(calendar({ legacy: true }))
    expect(screen.getByText(/made before these choices existed/)).toBeInTheDocument()
  })

  it('offers only what the service can do: a task service has no choice that sends changes', async () => {
    server()
    shell(tasks())
    open()
    const dialog = await screen.findByRole('dialog', { hidden: true })
    expect(within(dialog).getAllByRole('radio', { hidden: true })).toHaveLength(1)
    expect(within(dialog).getByRole('radio', { name: /Read only/, hidden: true })).toBeChecked()
    expect(within(dialog).queryByText(/Delete/)).toBeNull()
    expect(within(dialog).queryByText(/Custom/)).toBeNull()
  })

  it('saves a preset and does not send a delete confirmation it does not need', async () => {
    server()
    shell(calendar())
    open()
    const dialog = await screen.findByRole('dialog', { hidden: true })
    expect(within(dialog).getAllByRole('radio', { hidden: true })).toHaveLength(5)   // four presets and Custom
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Read \+ Create LifeOS can add/, hidden: true }))
    expect(within(dialog).queryByText('Delete cannot be undone')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0].url).toBe('/api/integrations/accounts/7/permissions')
    expect(puts()[0].body).toEqual({ preset: 'read_create' })
    await waitFor(() => expect(changed).toHaveBeenCalled())
  })

  it('turning Delete on needs its own words and tick before Save works, and sends the confirmation', async () => {
    server()
    shell(calendar())
    open()
    const dialog = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(within(dialog).getByRole('radio', { name: /Full access including Delete/, hidden: true }))
    expect(within(dialog).getByText('Delete cannot be undone')).toBeInTheDocument()
    const save = within(dialog).getByRole('button', { name: 'Save', hidden: true })
    expect(save).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I understand and want to turn Delete on/, hidden: true }))
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0].body).toEqual({ preset: 'full', confirm_delete: true })
  })

  it('keeping Delete on asks nothing more', async () => {
    server()
    shell(calendar({ granted: ['read', 'sync', 'export', 'create', 'update', 'delete'], effective: ['read', 'sync', 'export', 'create', 'update', 'delete'], preset: 'full' }))
    open()
    const dialog = await screen.findByRole('dialog', { hidden: true })
    expect(within(dialog).queryByText('Delete cannot be undone')).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Save', hidden: true })).toBeEnabled()
  })

  it('custom permissions: choosing a write switches "send changes" on with it, and reading stays on', async () => {
    server()
    shell(calendar())
    open()
    const dialog = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(within(dialog).getByRole('radio', { name: /Custom/, hidden: true }))
    expect(within(dialog).getByRole('checkbox', { name: /Read/, hidden: true })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Update', hidden: true }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0].body).toEqual({ permissions: ['read', 'sync', 'export', 'update'] })
  })

  it('shows the server’s message when saving is refused and keeps the dialog open', async () => {
    answer = { status: 422, body: { message: 'This service cannot do that through LifeOS.' } }
    server()
    shell(calendar())
    open()
    const dialog = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Read \+ Create LifeOS can add/, hidden: true }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }))
    expect(await within(dialog).findByText('This service cannot do that through LifeOS.')).toBeInTheDocument()
    expect(changed).not.toHaveBeenCalled()
  })

  it('when the service has not given the access a choice needs, it says so and asks once at the service', async () => {
    server()
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true })
    shell(calendar({ granted: ['read', 'sync', 'export', 'create'], effective: ['read', 'sync'], blocked: { export: 'reconsent_required', create: 'reconsent_required' } }))
    expect(screen.getByText(/has not given LifeOS the access needed to send changes/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Allow at the service' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/after-consent'))
    expect(calls.some(c => c.method === 'POST' && /accounts\/7\/write\/connect$/.test(c.url))).toBe(true)
  })

  it('speaks Arabic and Dutch', async () => {
    server()
    localStorage.setItem('lifeos-language', 'ar')
    shell(calendar())
    expect(screen.getByRole('heading', { name: 'ما يسمح به لـ LifeOS' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'إدارة الصلاحيات' }))
    expect(await screen.findByRole('radio', { name: /قراءة فقط/, hidden: true })).toBeInTheDocument()
    cleanup()
    localStorage.setItem('lifeos-language', 'nl')
    shell(calendar())
    expect(screen.getByRole('heading', { name: 'Wat LifeOS mag doen' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Rechten beheren' }))
    expect(await screen.findByRole('radio', { name: /Alleen lezen/, hidden: true })).toBeInTheDocument()
  })
})
