import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useState, type ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { Dialog } from '../components/ui/Shared'
import { ToastProvider } from '../components/ui/Toaster'
import { useToast } from '../lib/toast'
import { BottomSheet } from '../components/visual'
import SettingsLayout from '../features/settings/SettingsLayout'

const shell = (ui: ReactNode, lang?: string, path = '/') => {
  if (lang) localStorage.setItem('lifeos-language', lang)
  return render(<MemoryRouter initialEntries={[path]}><ThemeProvider><LanguageProvider>{ui}</LanguageProvider></ThemeProvider></MemoryRouter>)
}
const css = (name: string) => readFileSync(resolve(__dirname, '../styles', name), 'utf8')

describe('nested Dialog Escape', () => {
  beforeEach(() => { cleanup(); localStorage.clear() })
  afterEach(cleanup)
  it('closes only the inner Dialog, never the BottomSheet beneath it', () => {
    const outer = vi.fn(), inner = vi.fn()
    const { container } = shell(<BottomSheet title="Outer" onClose={outer}><Dialog title="Inner" onClose={inner}><span>x</span></Dialog></BottomSheet>)
    const dialogs = container.querySelectorAll('dialog')
    const innerDialog = dialogs[dialogs.length - 1]
    expect(innerDialog.className).toContain('os-dialog')
    const ev = new Event('cancel', { cancelable: true, bubbles: true })
    act(() => { innerDialog.dispatchEvent(ev) })
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
  })
})

describe('toast pause and resume', () => {
  beforeEach(() => { cleanup(); localStorage.clear(); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); cleanup() })
  function Fire({ type }: { type?: 'error' }) { const toast = useToast(); return <button onClick={() => toast('Saved', type)}>fire</button> }
  it('keeps the toast while hovered and dismisses after the remaining time', () => {
    shell(<ToastProvider><Fire /></ToastProvider>, 'en')
    fireEvent.click(screen.getByText('fire'))
    const region = document.querySelector('.toast-region')!
    act(() => { vi.advanceTimersByTime(3000) })
    fireEvent.mouseEnter(region)
    act(() => { vi.advanceTimersByTime(20000) })
    expect(document.querySelector('.toast')).not.toBeNull()
    fireEvent.mouseLeave(region)
    act(() => { vi.advanceTimersByTime(1400) })
    expect(document.querySelector('.toast')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(200) })
    expect(document.querySelector('.toast')).toBeNull()
  })
  it('pauses on focus-within and errors last 7000ms', () => {
    shell(<ToastProvider><Fire type="error" /></ToastProvider>)
    fireEvent.click(screen.getByText('fire'))
    const dismissBtn = screen.getAllByRole('button').find(b => b.classList.contains('icon-button'))!
    act(() => { vi.advanceTimersByTime(6000) })
    fireEvent.focus(dismissBtn)
    act(() => { vi.advanceTimersByTime(10000) })
    expect(document.querySelector('.toast')).not.toBeNull()
    fireEvent.blur(dismissBtn)
    act(() => { vi.advanceTimersByTime(1100) })
    expect(document.querySelector('.toast')).toBeNull()
  })
})

describe('toast live regions and modal hosting', () => {
  beforeEach(() => { cleanup(); localStorage.clear() })
  afterEach(cleanup)
  function Fire({ type }: { type?: 'error' }) { const toast = useToast(); return <button onClick={() => toast('Saved it', type)}>fire</button> }
  it('the region is a live region that exists empty before the first toast, and shows the text once', async () => {
    vi.useFakeTimers()
    try {
      shell(<ToastProvider><Fire /></ToastProvider>, 'en')
      const region = document.querySelector('.toast-region')!
      expect(region.getAttribute('role')).toBe('status'); expect(region.getAttribute('aria-live')).toBe('polite')
      expect(region.children.length).toBe(0)
      fireEvent.click(screen.getByText('fire'))
      expect(screen.getAllByText('Saved it')).toHaveLength(1)
      expect(document.querySelector('.toast')!.getAttribute('role')).toBeNull()
      act(() => { vi.advanceTimersByTime(5000) })
      expect(region.isConnected).toBe(true); expect(region.children.length).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('errors use role=alert', () => {
    shell(<ToastProvider><Fire type="error" /></ToastProvider>, 'en')
    fireEvent.click(screen.getByText('fire'))
    expect(screen.getByRole('alert').textContent).toContain('Saved it')
    expect(screen.getAllByText('Saved it')).toHaveLength(1)
  })
  it('renders inside the open modal dialog so it stays interactive', async () => {
    function Host() { const [open, setOpen] = useState(false); return <><button onClick={() => setOpen(true)}>opener</button>{open && <Dialog title="D" onClose={() => setOpen(false)}><span>body</span></Dialog>}</> }
    shell(<ToastProvider><Host /><Fire /></ToastProvider>, 'en')
    expect(document.querySelector('dialog')).toBeNull()
    fireEvent.click(screen.getByText('opener'))
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    // The live region is already inside the dialog before any toast arrives.
    expect(document.querySelector('dialog .toast-region[role=status]')).not.toBeNull()
    expect(document.querySelectorAll('.toast-region')).toHaveLength(1)
    fireEvent.click(screen.getByText('fire'))
    const dialog = document.querySelector('dialog')!
    expect(dialog.querySelector('.toast-region .toast')).not.toBeNull()
    // Closing the dialog hands the region back to the page.
    fireEvent.click(screen.getByLabelText('Close'))
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(document.querySelector('dialog')).toBeNull()
    expect(document.querySelector('.toast-region')).not.toBeNull()
  })
  it('moves focus to the previous element when the focused toast is dismissed', () => {
    shell(<ToastProvider><Fire /></ToastProvider>, 'en')
    const fire = screen.getByText('fire'); fire.focus(); fireEvent.click(fire)
    const dismiss = screen.getByLabelText('Dismiss')
    fireEvent.focus(dismiss, { relatedTarget: fire }); dismiss.focus()
    fireEvent.click(dismiss)
    expect(document.activeElement).toBe(fire)
  })
})

describe('settings tabs', () => {
  const original = Element.prototype.scrollIntoView
  beforeEach(() => { cleanup(); localStorage.clear() })
  afterEach(() => { Element.prototype.scrollIntoView = original; cleanup() })
  const tabs = <Routes><Route path="/settings" element={<SettingsLayout />}><Route index element={<p>g</p>} /><Route path="security" element={<p>s</p>} /></Route></Routes>
  it('has Dutch labels', () => {
    shell(tabs, 'nl', '/settings')
    for (const name of ['Algemeen', 'Beveiliging', 'Welzijn', 'Meldingen', 'Gekoppelde accounts', 'Assistent', 'Automatiseringen']) expect(screen.getByRole('link', { name })).toBeTruthy()
  })
  it('scrolls the active tab into view without moving focus', () => {
    const spy = vi.fn()
    Element.prototype.scrollIntoView = spy
    const before = document.activeElement
    shell(tabs, 'en', '/settings/security')
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ inline: 'center' }))
    expect(document.activeElement).toBe(before)
  })
})

describe('stylesheet contracts', () => {
  it('reduced-motion stops infinite loops (no behavioural alternative in jsdom)', () => {
    const theme = css('theme.css')
    const block = theme.slice(theme.indexOf('prefers-reduced-motion: reduce'))
    for (const rule of ['animation-iteration-count: 1 !important', 'animation-delay: 0s !important', 'transition-delay: 0s !important', 'scroll-behavior: auto !important']) expect(block).toContain(rule)
  })
})
