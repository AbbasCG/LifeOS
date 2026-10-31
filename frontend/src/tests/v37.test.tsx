import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { InstallBanner, InstallCard } from '../components/InstallApp'
import { resetInstallState } from '../lib/pwa'

/** The browser's install prompt, made by hand: the real one needs a real browser on a real device. */
function offerInstall(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const prompt = vi.fn(async () => {})
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt, userChoice: Promise.resolve({ outcome }) })
  act(() => { window.dispatchEvent(event) })
  return { prompt, event }
}
const wrap = (ui: React.ReactNode) => <ThemeProvider><LanguageProvider><ToastProvider>{ui}</ToastProvider></LanguageProvider></ThemeProvider>
const coarse = (on: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('pointer: coarse'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }))

beforeEach(() => {
  cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en')
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false }
  coarse(false)
})
afterEach(() => { act(() => resetInstallState()); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('install from the browser prompt', () => {
  it('shows an install button only once the browser offers one, and installs with one tap', async () => {
    render(wrap(<InstallCard />))
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull()
    expect(screen.getByText(/did not offer an install button/)).toBeInTheDocument()
    const { prompt, event } = offerInstall()
    expect(event.defaultPrevented).toBe(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Install app' }))
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('LifeOS was added to this device.')).toBeInTheDocument()
  })

  it('a screen that opens after the prompt was offered still gets it', () => {
    offerInstall()
    render(wrap(<InstallCard />))
    expect(screen.getByRole('button', { name: 'Install app' })).toBeInTheDocument()
  })

  it('says so when the app is already installed', () => {
    offerInstall()
    render(wrap(<InstallCard />))
    act(() => { window.dispatchEvent(new Event('appinstalled')) })
    expect(screen.getByText('LifeOS is installed on this device.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull()
  })
})

describe('iPhone and iPad', () => {
  it('shows the Share-sheet steps, because Safari has no install prompt', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')
    render(wrap(<InstallCard />))
    fireEvent.click(screen.getByRole('button', { name: 'How to install' }))
    expect(await screen.findByText(/Add to Home Screen/)).toBeInTheDocument()
    expect(screen.getByText(/Tap the Share button/)).toBeInTheDocument()
  })
})

describe('the banner on Today', () => {
  it('is for touch screens, only where install can work, and "Not now" hides it for good', () => {
    offerInstall()
    const { unmount } = render(wrap(<InstallBanner />))
    expect(screen.queryByText('Add LifeOS to your home screen')).toBeNull()   // a computer: Settings and the menu offer it
    unmount()

    coarse(true)
    const second = render(wrap(<InstallBanner />))
    expect(screen.getByText('Add LifeOS to your home screen')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByText('Add LifeOS to your home screen')).toBeNull()
    second.unmount()
    render(wrap(<InstallBanner />))
    expect(screen.queryByText('Add LifeOS to your home screen')).toBeNull()
  })

  it('stays away when the browser has nothing to offer', () => {
    coarse(true)
    render(wrap(<InstallBanner />))
    expect(screen.queryByText('Add LifeOS to your home screen')).toBeNull()
  })
})
