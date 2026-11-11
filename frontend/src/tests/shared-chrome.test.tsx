import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { useState, type ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { Dialog, Drawer } from '../components/ui/Shared'
import { ToastProvider } from '../components/ui/Toaster'
import { ConfirmPasswordProvider } from '../components/ui/ConfirmPasswordProvider'
import { SensitiveContext } from '../lib/sensitive'
import { ApiError } from '../lib/api'
import { useToast } from '../lib/toast'
import { useContext } from 'react'
import { BottomSheet, PriorityMark } from '../components/visual'

// A browser can play the exit animation; jsdom cannot, so give it the method that says so.
beforeEach(() => { Object.defineProperty(Element.prototype, 'getAnimations', { value: () => [], configurable: true, writable: true }) })
afterEach(() => { delete (Element.prototype as unknown as Record<string, unknown>).getAnimations })
const shell = (ui: ReactNode, lang?: string) => {
  if (lang) localStorage.setItem('lifeos-language', lang)
  return render(<MemoryRouter><ThemeProvider><LanguageProvider>{ui}</LanguageProvider></ThemeProvider></MemoryRouter>)
}
const escape = (el: HTMLElement) => {
  // Real browsers fire a cancelable `cancel` event on Escape and close the dialog unless it is prevented.
  const ev = new Event('cancel', { cancelable: true })
  act(() => { el.dispatchEvent(ev) })
  if (!ev.defaultPrevented) (el as HTMLDialogElement).close()
}

function Host({ kind, busy }: { kind: 'dialog' | 'drawer'; busy?: boolean }) {
  const [open, setOpen] = useState(false)
  const Comp = kind === 'dialog' ? Dialog : Drawer
  return <><button onClick={() => setOpen(true)}>opener</button>{open && <Comp title="T" onClose={() => { if (!busy) setOpen(false) }}><input data-autofocus aria-label="field" /></Comp>}</>
}

describe('Dialog and Drawer Escape handling', () => {
  beforeEach(() => { cleanup(); localStorage.clear() })
  afterEach(cleanup)
  it.each(['dialog', 'drawer'] as const)('%s stays open when Escape is pressed while onClose does nothing', kind => {
    const { container } = shell(<Host kind={kind} busy />)
    fireEvent.click(screen.getByText('opener'))
    const d = container.querySelector('dialog')!
    expect(d.open).toBe(true)
    escape(d)
    expect(d.open).toBe(true)
  })
  it.each(['dialog', 'drawer'] as const)('%s closes on Escape when onClose closes it, and focus returns to the opener', async kind => {
    const { container } = shell(<Host kind={kind} />)
    const opener = screen.getByText('opener')
    opener.focus(); fireEvent.click(opener)
    const d = container.querySelector('dialog')!
    expect(document.activeElement).toBe(screen.getByLabelText('field'))
    escape(d)
    // The exit animation runs first (jsdom plays none, so the 200ms fallback ends it); then onClose unmounts the dialog.
    expect(d.hasAttribute('data-closing')).toBe(true)
    await waitFor(() => expect(container.querySelector('dialog')).toBeNull())
    // Focus goes back in the unmount cleanup (a passive effect), which React may run just after the dialog node is gone: wait for it, still require it.
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })
})

describe('shared chrome in Dutch', () => {
  beforeEach(() => { cleanup(); localStorage.clear() })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })
  it('Dialog and Drawer close buttons are Dutch', () => {
    shell(<><Dialog title="A" onClose={() => {}}>x</Dialog><Drawer title="B" onClose={() => {}}>y</Drawer></>, 'nl')
    expect(screen.getAllByLabelText('Sluiten')).toHaveLength(2)
    expect(screen.queryByLabelText('Close')).toBeNull()
  })
  it('Dialog close button stays English in English', () => {
    shell(<Dialog title="A" onClose={() => {}}>x</Dialog>, 'en')
    expect(screen.getByLabelText('Close')).toBeTruthy()
  })
  it('toast dismiss button is Dutch', () => {
    function Fire() { const toast = useToast(); return <button onClick={() => toast('Hoi')}>fire</button> }
    shell(<ToastProvider><Fire /></ToastProvider>, 'nl')
    fireEvent.click(screen.getByText('fire'))
    expect(screen.getByLabelText('Sluiten')).toBeTruthy()
  })
  it('password confirmation prompt is Dutch', async () => {
    function Trigger() {
      const run = useContext(SensitiveContext)
      return <button onClick={() => { void run(async () => { throw new ApiError(423, 'locked') }).catch(() => {}) }}>go</button>
    }
    shell(<ConfirmPasswordProvider><Trigger /></ConfirmPasswordProvider>, 'nl')
    fireEvent.click(screen.getByText('go'))
    expect(await screen.findByText('Bevestig dat jij het bent')).toBeTruthy()
    expect(screen.getByText('Wachtwoord')).toBeTruthy()
    expect(screen.getByText('Annuleren')).toBeTruthy()
    expect(screen.getByText('Bevestigen')).toBeTruthy()
    expect(screen.getByText(/Voer voor jouw veiligheid/)).toBeTruthy()
  })
  it('BottomSheet discard confirmation and PriorityMark are Dutch', () => {
    shell(<><BottomSheet title="S" onClose={() => {}} dirty={() => true}>body</BottomSheet><PriorityMark priority="urgent" labelled /></>, 'nl')
    expect(screen.getByText('Dringend')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Sluiten'))
    expect(screen.getByText('Wijzigingen negeren?')).toBeTruthy()
    expect(screen.getByText('Wat je hier hebt ingevoerd is niet opgeslagen.')).toBeTruthy()
    expect(screen.getByText('Blijven bewerken')).toBeTruthy()
    expect(screen.getByText('Negeren')).toBeTruthy()
  })
})

describe('Drawer Escape isolation', () => {
  afterEach(cleanup)
  it('does not let the cancel event bubble to ancestors', () => {
    const parent = vi.fn()
    document.body.addEventListener('cancel', parent)
    const { container } = shell(<div><Drawer title="T" onClose={() => {}}><span>x</span></Drawer></div>)
    act(() => { container.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true, bubbles: true })) })
    document.body.removeEventListener('cancel', parent)
    expect(parent).not.toHaveBeenCalled()
  })
})
