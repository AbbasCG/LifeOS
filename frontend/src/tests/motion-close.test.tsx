import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { useRef, type ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { Dialog, Drawer } from '../components/ui/Shared'
import { BottomSheet } from '../components/visual'
import { useAnimatedClose } from '../lib/useAnimatedClose'

const shell = (ui: ReactNode) => { localStorage.setItem('lifeos-language', 'en'); return render(<MemoryRouter><ThemeProvider><LanguageProvider>{ui}</LanguageProvider></ThemeProvider></MemoryRouter>) }
const realMatchMedia = window.matchMedia
// jsdom has no Web Animations API; with it missing the dialog (correctly) closes at once, so these tests add the method the way a browser has it.
const animatable = () => { Object.defineProperty(Element.prototype, 'getAnimations', { value: () => [], configurable: true, writable: true }) }
const notAnimatable = () => { delete (Element.prototype as unknown as Record<string, unknown>).getAnimations }
const reduceMotion = (on: boolean) => { window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: on && query.includes('reduce'), addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia }

function Probe({ onClose, open = true }: { onClose: () => void; open?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null), close = useAnimatedClose(ref, onClose)
  return <><dialog ref={ref} open={open} data-testid="d" /><button onClick={close}>close</button></>
}

describe('exit animation before a dialog closes', () => {
  beforeEach(() => { cleanup(); vi.useFakeTimers(); animatable() })
  afterEach(() => { vi.useRealTimers(); window.matchMedia = realMatchMedia; notAnimatable(); cleanup() })

  it('marks the dialog as closing and calls onClose when the exit animation ends', () => {
    const onClose = vi.fn()
    render(<Probe onClose={onClose} />)
    fireEvent.click(screen.getByText('close'))
    const d = screen.getByTestId('d')
    expect(d.hasAttribute('data-closing')).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(100) })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent(d, new Event('animationend', { bubbles: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('makes the dialog inert while it closes, so a second click cannot reach Save or Delete', () => {
    render(<Probe onClose={() => {}} />)
    const d = screen.getByTestId('d')
    expect(d.hasAttribute('inert')).toBe(false)
    fireEvent.click(screen.getByText('close'))
    expect(d.hasAttribute('inert')).toBe(true)
  })

  it('lifts inert again if the parent kept the dialog open', () => {
    render(<Probe onClose={() => {}} />)
    fireEvent.click(screen.getByText('close'))
    act(() => { vi.advanceTimersByTime(400) })
    const d = screen.getByTestId('d')
    expect(d.hasAttribute('inert')).toBe(false); expect(d.hasAttribute('data-closing')).toBe(false)
  })

  it('a dirty BottomSheet is not inert while it asks, only once the discard is confirmed', () => {
    const { container } = shell(<BottomSheet title="T" onClose={() => {}} dirty={() => true}>x</BottomSheet>)
    const d = container.querySelector('dialog')!
    act(() => { d.dispatchEvent(new Event('cancel', { cancelable: true })) })
    expect(d.hasAttribute('inert')).toBe(false)
    fireEvent.click(screen.getByText('Discard'))
    expect(d.hasAttribute('inert')).toBe(true)
  })

  it('ignores the end of an animation inside the dialog (a toast leaving, a spinner)', () => {
    const onClose = vi.fn()
    render(<Probe onClose={onClose} />)
    fireEvent.click(screen.getByText('close'))
    const inner = document.createElement('span'); const wrapper = document.createElement('div'); wrapper.appendChild(inner); screen.getByTestId('d').appendChild(wrapper)
    fireEvent(inner, new Event('animationend', { bubbles: true }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('falls back to a timer when no animation ever ends, and calls onClose once', () => {
    const onClose = vi.fn()
    render(<Probe onClose={onClose} />)
    fireEvent.click(screen.getByText('close')); fireEvent.click(screen.getByText('close'))
    act(() => { vi.advanceTimersByTime(199) })
    expect(onClose).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(2) })
    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('waits a little longer once the exit has really started (a slow frame)', () => {
    const onClose = vi.fn()
    render(<Probe onClose={onClose} />)
    fireEvent.click(screen.getByText('close'))
    act(() => { vi.advanceTimersByTime(150) })
    fireEvent(screen.getByTestId('d'), new Event('animationstart', { bubbles: true }))
    act(() => { vi.advanceTimersByTime(200) })
    expect(onClose).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(80) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes at once, with no closing state, when the person asked for reduced motion', () => {
    reduceMotion(true)
    const onClose = vi.fn()
    render(<Probe onClose={onClose} />)
    fireEvent.click(screen.getByText('close'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('d').hasAttribute('data-closing')).toBe(false)
  })

  it('shows a dialog again if the parent chose to keep it open', () => {
    const onClose = vi.fn()
    render(<Probe onClose={onClose} />)
    fireEvent.click(screen.getByText('close'))
    act(() => { vi.advanceTimersByTime(210) })
    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(130) })
    expect(screen.getByTestId('d').hasAttribute('data-closing')).toBe(false)
  })

  it('never fires onClose after the dialog unmounted first', () => {
    const onClose = vi.fn()
    const { unmount } = render(<Probe onClose={onClose} />)
    fireEvent.click(screen.getByText('close'))
    unmount()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('Dialog, Drawer and BottomSheet use the exit', () => {
  beforeEach(() => { cleanup(); vi.useFakeTimers(); animatable() })
  afterEach(() => { vi.useRealTimers(); window.matchMedia = realMatchMedia; notAnimatable(); cleanup() })

  it.each([['Dialog', (c: () => void) => <Dialog title="T" onClose={c}>x</Dialog>], ['Drawer', (c: () => void) => <Drawer title="T" onClose={c}>x</Drawer>], ['BottomSheet', (c: () => void) => <BottomSheet title="T" onClose={c}>x</BottomSheet>]] as const)(
    '%s: the close button and Escape play the exit first', (_name, make) => {
      const onClose = vi.fn()
      const { container } = shell(make(onClose))
      const d = container.querySelector('dialog')!
      fireEvent.click(screen.getByLabelText('Close'))
      expect(d.hasAttribute('data-closing')).toBe(true); expect(onClose).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(250) })
      expect(onClose).toHaveBeenCalledTimes(1)
      cleanup()
      const second = vi.fn(), again = shell(make(second)).container.querySelector('dialog')!
      act(() => { again.dispatchEvent(new Event('cancel', { cancelable: true })) })
      expect(again.hasAttribute('data-closing')).toBe(true)
      act(() => { vi.advanceTimersByTime(250) })
      expect(second).toHaveBeenCalledTimes(1)
    })

  it('BottomSheet asks before discarding, and only the confirmed discard plays the exit', () => {
    const onClose = vi.fn()
    const { container } = shell(<BottomSheet title="T" onClose={onClose} dirty={() => true}>x</BottomSheet>)
    const d = container.querySelector('dialog')!
    act(() => { d.dispatchEvent(new Event('cancel', { cancelable: true })) })
    expect(screen.getByText('Discard your changes?')).toBeTruthy()
    expect(d.hasAttribute('data-closing')).toBe(false)
    act(() => { vi.advanceTimersByTime(500) })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Discard'))
    expect(d.hasAttribute('data-closing')).toBe(true)
    act(() => { vi.advanceTimersByTime(250) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('an engine without the Web Animations API closes at once', () => {
    notAnimatable()
    const onClose = vi.fn()
    shell(<Dialog title="T" onClose={onClose}>x</Dialog>)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('reduced motion: Dialog closes immediately', () => {
    reduceMotion(true)
    const onClose = vi.fn()
    shell(<Dialog title="T" onClose={onClose}>x</Dialog>)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
