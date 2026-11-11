import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { useToast } from '../lib/toast'

const shell = (ui: ReactNode) => { localStorage.setItem('lifeos-language', 'en'); return render(<MemoryRouter><ThemeProvider><LanguageProvider>{ui}</LanguageProvider></ThemeProvider></MemoryRouter>) }
function Fire({ type }: { type?: 'error' }) { const toast = useToast(); return <button onClick={() => toast('Saved it', type)}>fire</button> }
const realMatchMedia = window.matchMedia
const flush = () => act(async () => { await Promise.resolve(); await new Promise(r => setTimeout(r, 0)) })
const openDialog = (parent: Element) => { const d = document.createElement('dialog'); parent.appendChild(d); d.setAttribute('open', ''); return d }
const hostOf = () => document.querySelector('.toast-region')!.parentElement!.parentElement!

describe('toast region follows the most recently opened modal', () => {
  beforeEach(() => { cleanup(); localStorage.clear() })
  afterEach(() => { cleanup(); document.querySelectorAll('dialog').forEach(d => d.remove()) })

  it('goes into the inner dialog of two nested dialogs, back to the outer one, then to the page', async () => {
    shell(<ToastProvider><Fire /></ToastProvider>)
    await flush()
    expect(hostOf()).toBe(document.body)
    const outer = openDialog(document.body); await flush()
    expect(hostOf()).toBe(outer)
    const inner = openDialog(outer); await flush()
    expect(hostOf()).toBe(inner)
    fireEvent.click(screen.getByText('fire'))
    const toast = document.querySelector('.toast')!
    expect(inner.contains(toast)).toBe(true)
    inner.removeAttribute('open'); await flush()
    expect(hostOf()).toBe(outer)
    expect(document.querySelector('.toast')).toBe(toast)   // moved, never remounted
    outer.removeAttribute('open'); await flush()
    expect(hostOf()).toBe(document.body)
    expect(document.querySelector('.toast')).toBe(toast)
    expect(document.querySelectorAll('.toast-region')).toHaveLength(1)
  })

  it('uses the order the dialogs were opened in, not their order in the page', async () => {
    shell(<ToastProvider><Fire /></ToastProvider>)
    const first = document.createElement('dialog'), second = document.createElement('dialog')
    document.body.append(first, second)   // `first` comes earlier in the page
    second.setAttribute('open', ''); await flush()
    expect(hostOf()).toBe(second)
    first.setAttribute('open', ''); await flush()
    expect(hostOf()).toBe(first)           // opened last, although earlier in the DOM
    first.removeAttribute('open'); await flush()
    expect(hostOf()).toBe(second)
  })

  it('leaves a dialog that is on its way out', async () => {
    shell(<ToastProvider><Fire /></ToastProvider>)
    const outer = openDialog(document.body), inner = openDialog(outer); await flush()
    expect(hostOf()).toBe(inner)
    inner.setAttribute('data-closing', ''); await flush()
    expect(hostOf()).toBe(outer)
  })

  it('is found again when the host dialog is removed from the page while open', async () => {
    shell(<ToastProvider><Fire /></ToastProvider>)
    const outer = openDialog(document.body); await flush()
    expect(hostOf()).toBe(outer)
    outer.remove(); await flush()
    expect(hostOf()).toBe(document.body)
    expect(document.querySelector('.toast-region')!.isConnected).toBe(true)
  })
})

function WithAction({ onUndo }: { onUndo: () => void }) { const toast = useToast(); return <button onClick={() => toast('Deleted', 'info', { label: 'Undo', onClick: onUndo })}>act</button> }

describe('toast progress and exit', () => {
  beforeEach(() => { cleanup(); localStorage.clear(); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); window.matchMedia = realMatchMedia; cleanup() })

  it('shows the time it will stay (4.5 s, 7 s for errors) and pauses the bar with the timer on hover and focus', () => {
    shell(<ToastProvider><Fire /><Fire type="error" /></ToastProvider>)
    const [ok, bad] = screen.getAllByText('fire')
    fireEvent.click(ok); fireEvent.click(bad)
    const bars = Array.from(document.querySelectorAll<HTMLElement>('.toast-bar'))
    expect(bars.map(b => b.style.getPropertyValue('--ms'))).toEqual(['4500ms', '7000ms'])
    const region = document.querySelector('.toast-region')!
    expect(region.hasAttribute('data-paused')).toBe(false)
    fireEvent.mouseEnter(region); expect(region.hasAttribute('data-paused')).toBe(true)
    fireEvent.mouseLeave(region); expect(region.hasAttribute('data-paused')).toBe(false)
    const dismiss = screen.getAllByLabelText('Dismiss')[0]
    fireEvent.focus(dismiss); expect(region.hasAttribute('data-paused')).toBe(true)
    fireEvent.blur(dismiss); expect(region.hasAttribute('data-paused')).toBe(false)
  })

  it('the bar and the timer share one clock: a pause puts the bar where the remaining time says', () => {
    shell(<ToastProvider><Fire /></ToastProvider>)
    fireEvent.click(screen.getByText('fire'))
    const bar = document.querySelector<HTMLElement>('.toast-bar')!
    const animation = { currentTime: 0 as number | null }
    bar.getAnimations = (() => [animation]) as unknown as typeof bar.getAnimations
    act(() => { vi.advanceTimersByTime(1000) })
    fireEvent.mouseEnter(document.querySelector('.toast-region')!)
    expect(animation.currentTime).toBeGreaterThanOrEqual(1000); expect(animation.currentTime).toBeLessThan(1100)
  })

  it('a toast with an action waits until it is used or dismissed (no timer, no bar); others still time out', () => {
    const undo = vi.fn()
    shell(<ToastProvider><Fire /><WithAction onUndo={undo} /></ToastProvider>)
    fireEvent.click(screen.getByText('act')); fireEvent.click(screen.getByText('fire'))
    expect(document.querySelectorAll('.toast-bar')).toHaveLength(1)   // only the plain toast has one
    act(() => { vi.advanceTimersByTime(60000) })
    const left = document.querySelectorAll('.toast')
    expect(left).toHaveLength(1)
    expect(left[0].textContent).toContain('Deleted')
    fireEvent.click(screen.getByText('Undo'))
    expect(undo).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(200) })
    expect(document.querySelector('.toast')).toBeNull()
  })

  it('hover and focus on a toast with an action change nothing and it can still be dismissed', () => {
    shell(<ToastProvider><WithAction onUndo={() => {}} /></ToastProvider>)
    fireEvent.click(screen.getByText('act'))
    const region = document.querySelector('.toast-region')!
    fireEvent.mouseEnter(region); fireEvent.mouseLeave(region)
    act(() => { vi.advanceTimersByTime(30000) })
    expect(document.querySelector('.toast')).not.toBeNull()
    fireEvent.click(screen.getByLabelText('Dismiss'))
    act(() => { vi.advanceTimersByTime(200) })
    expect(document.querySelector('.toast')).toBeNull()
  })

  it('leaves with an exit first (data-leaving), then is removed after about 160 ms', () => {
    shell(<ToastProvider><Fire /></ToastProvider>)
    fireEvent.click(screen.getByText('fire'))
    fireEvent.click(screen.getByLabelText('Dismiss'))
    const toast = document.querySelector('.toast')!
    expect(toast.hasAttribute('data-leaving')).toBe(true)
    act(() => { vi.advanceTimersByTime(150) })
    expect(document.querySelector('.toast')).toBe(toast)
    act(() => { vi.advanceTimersByTime(20) })
    expect(document.querySelector('.toast')).toBeNull()
  })

  it('a toast that is leaving is not offered as the place to move focus to', () => {
    shell(<ToastProvider><Fire /></ToastProvider>)
    const fire = screen.getByText('fire'); fire.focus()
    fireEvent.click(fire); fireEvent.click(fire)
    const [first, second] = screen.getAllByLabelText('Dismiss')
    fireEvent.focus(first, { relatedTarget: fire }); first.focus()
    fireEvent.click(first)                      // the focused toast leaves: focus goes to the other toast
    expect(document.activeElement).toBe(second)
    fireEvent.click(second)                     // now the only other toast is already leaving: focus returns to the opener
    expect(document.activeElement).toBe(fire)
  })

  it('reduced motion: the toast is removed at once and there is no bar to watch', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: query.includes('reduce'), addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia
    shell(<ToastProvider><Fire /></ToastProvider>)
    fireEvent.click(screen.getByText('fire'))
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(document.querySelector('.toast')).toBeNull()
  })
})
