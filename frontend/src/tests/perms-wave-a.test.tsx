import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { ManagePermissions } from '../features/connected/ManagePermissions'
import { SyncSettings } from '../features/connected/SyncSettings'
import type { PermissionState } from '../lib/connectionPermissions'
import type { SyncState } from '../lib/syncSettings'

const perms = (over: Partial<PermissionState> = {}): PermissionState => ({
  granted: ['read', 'sync'], effective: ['read', 'sync'], capabilities: ['read', 'sync', 'export', 'create', 'update', 'delete'], presets: ['read_only', 'read_create', 'read_create_update', 'full'],
  preset: 'read_only', legacy: false, blocked: {}, changed_at: null, ...over,
})
const tasks = perms({ granted: ['read', 'sync', 'import'], effective: ['read', 'sync', 'import'], capabilities: ['read', 'sync', 'import'], presets: ['read_only'] })
const syncState = { direction: 'inbound', conflict_policy: 'ask', paused: false, available_directions: ['inbound', 'two_way'], effective_direction: 'inbound' } as unknown as SyncState

const wrap = (ui: React.ReactNode, lang = 'en') => {
  localStorage.setItem('lifeos-language', lang)
  return render(<ThemeProvider><LanguageProvider><ToastProvider><MemoryRouter>{ui}</MemoryRouter></ToastProvider></LanguageProvider></ThemeProvider>)
}

beforeEach(() => {
  cleanup(); localStorage.clear()
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { conflicts: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('permissions wave A', () => {
  it('states the always-on operations once, in three languages, without chips for them', () => {
    const texts: Record<string, string> = { en: 'Reading, syncing and importing are always on.', ar: 'القراءة والمزامنة والاستيراد مفعّلة دائمًا.', nl: 'Lezen, synchroniseren en importeren staan altijd aan.' }
    for (const lang of ['en', 'ar', 'nl']) {
      cleanup()
      const { container } = wrap(<ManagePermissions accountId={7} label="X" state={tasks} onChanged={() => {}} />, lang)
      expect(screen.getByText(texts[lang])).toBeInTheDocument()
      expect(container.querySelector('.perms-list')).toBeNull()
    }
  })

  it('keeps the other operations as chips', () => {
    wrap(<ManagePermissions accountId={7} label="X" state={perms()} onChanged={() => {}} />)
    const items = within(screen.getByRole('list', { name: 'Allowed now' })).getAllByRole('listitem').map(li => li.textContent)
    expect(items).toHaveLength(4)
    expect(items.join('|')).not.toMatch(/Read|Sync in the background/)
  })

  it('gives choices a grid layout with the radio as a direct child and a sticky footer holding Save', () => {
    wrap(<ManagePermissions accountId={7} label="X" state={perms()} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage permissions' }))
    const dialog = screen.getByRole('dialog', { hidden: true })
    const choices = dialog.querySelectorAll('label.perms-choice')
    expect(choices).toHaveLength(5)
    choices.forEach(c => { expect(c.firstElementChild?.tagName).toBe('INPUT'); expect(c.querySelector(':scope > strong')).not.toBeNull() })
    const footer = dialog.querySelector('.perms-footer') as HTMLElement
    expect(footer).not.toBeNull()
    expect(within(footer).getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(within(footer).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(dialog.querySelector('.perms-custom')).toBeNull()   // Custom list only when Custom is chosen
  })

  it('keeps the Delete hint in the footer, wired to Save, and moves focus to the confirm box', () => {
    wrap(<ManagePermissions accountId={7} label="X" state={perms()} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage permissions' }))
    const dialog = screen.getByRole('dialog', { hidden: true })
    fireEvent.click(within(dialog).getByRole('radio', { name: /Full access/, hidden: true }))
    const save = within(dialog).getByRole('button', { name: 'Save', hidden: true })
    const hint = dialog.querySelector(`#${save.getAttribute('aria-describedby')}`)
    expect(hint).toHaveTextContent('Save is off until you tick the box above.')
    expect(dialog.querySelector('.perms-footer')).toContainElement(hint as HTMLElement)
    expect(document.activeElement).toBe(within(dialog).getByRole('checkbox', { hidden: true }))
    fireEvent.click(within(dialog).getByRole('checkbox', { hidden: true }))
    expect(save).not.toHaveAttribute('aria-describedby')
  })

  it('shows the password note above the sticky footer, not below Save', () => {
    wrap(<ManagePermissions accountId={7} label="X" state={perms()} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage permissions' }))
    const dialog = screen.getByRole('dialog', { hidden: true })
    const note = within(dialog).getByText('You may be asked for your password.')
    expect(dialog.querySelector('.perms-footer')).not.toContainElement(note)
    expect(note.compareDocumentPosition(dialog.querySelector('.perms-footer') as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('uses the same grid choices and sticky footer in sync settings', () => {
    wrap(<SyncSettings accountId={7} label="X" state={{ ...syncState, direction: 'two_way' } as SyncState} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sync settings' }))
    const dialog = screen.getByRole('dialog', { hidden: true })
    const choices = dialog.querySelectorAll('label.perms-choice')
    expect(choices.length).toBeGreaterThan(2)
    choices.forEach(c => expect(c.firstElementChild?.tagName).toBe('INPUT'))
    expect(within(dialog.querySelector('.perms-footer') as HTMLElement).getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('keeps every control reachable in order: the cards, then Close-free path to Save and Cancel', () => {
    wrap(<ManagePermissions accountId={7} label="X" state={perms()} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage permissions' }))
    const dialog = screen.getByRole('dialog', { hidden: true })
    const order = Array.from(dialog.querySelectorAll<HTMLElement>('button, input, a[href], [tabindex]')).filter(e => !(e as HTMLInputElement).disabled && e.getAttribute('tabindex') !== '-1')
    const names = order.map(e => e.tagName === 'INPUT' ? (e as HTMLInputElement).type : e.textContent)
    expect(names.slice(-3)).toEqual(['radio', 'Save', 'Cancel'])   // the last card comes right before the footer buttons
    const footer = dialog.querySelector('.perms-footer') as HTMLElement
    expect(order.filter(e => footer.contains(e))).toHaveLength(2)
  })
})
