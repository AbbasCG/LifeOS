import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import InstallPage from '../features/InstallPage'
import { InstallLink } from '../components/InstallApp'
import { resetInstallState } from '../lib/pwa'

const wrap = (ui: React.ReactNode) => <ThemeProvider><LanguageProvider><ToastProvider><MemoryRouter>{ui}</MemoryRouter></ToastProvider></LanguageProvider></ThemeProvider>
function offerInstall() {
  const prompt = vi.fn(async () => {})
  act(() => { window.dispatchEvent(Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt, userChoice: Promise.resolve({ outcome: 'accepted' }) })) })
  return prompt
}
const phoneUserAgent = (ua: string) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)

beforeEach(() => { cleanup(); localStorage.clear(); localStorage.setItem('lifeos-language', 'en') })
afterEach(() => { act(() => resetInstallState()); vi.restoreAllMocks() })

describe('the public install page', () => {
  it('shows the steps for Android and for iPhone when the browser offers no install button', () => {
    render(wrap(<InstallPage />))
    expect(screen.getByRole('heading', { level: 1, name: 'Get LifeOS on your phone' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Android (Chrome or Edge)' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'iPhone and iPad (Safari)' })).toBeInTheDocument()
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument()
  })

  it('installs through the browser’s own prompt with one tap, and only then', async () => {
    render(wrap(<InstallPage />))
    const prompt = offerInstall()
    expect(prompt).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Install app' }))
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
  })

  it('puts the steps for this device first: iPhone before Android on an iPhone', () => {
    phoneUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')
    render(wrap(<InstallPage />))
    const headings = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)
    expect(headings).toEqual(['iPhone and iPad (Safari)', 'Android (Chrome or Edge)'])
  })

  it('copies its own address to send to a phone', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(wrap(<InstallPage />))
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${location.origin}/install`))
  })
})

describe('the link to it', () => {
  it('is a plain link to /install that anyone can see, and is gone once the app is installed', () => {
    render(wrap(<InstallLink />))
    expect(screen.getByRole('link', { name: 'Get the phone app' })).toHaveAttribute('href', '/install')
    act(() => { window.dispatchEvent(new Event('appinstalled')) })
    expect(screen.queryByRole('link', { name: 'Get the phone app' })).toBeNull()
  })
})
