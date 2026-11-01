import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider, useAuth } from '../contexts/AuthContext'
import { hasVoiceConsent, setVoiceConsent } from '../lib/voice'
import { CSP } from '../../vite.config'

function SignOut() { const { user, logout } = useAuth(); return user ? <button onClick={() => void logout()}>sign out</button> : <p>signed out</p> }
const wrap = (children: ReactNode) => <ThemeProvider><LanguageProvider><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></LanguageProvider></ThemeProvider>

describe('V43 privacy on the device', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('forgets the voice consent when the person signs out', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(/\/api\/user$/.test(url) ? { id: 1, name: 'A', email: 'a@x.io' } : {}), { status: 200 })))
    setVoiceConsent(true)
    render(wrap(<SignOut />))
    fireEvent.click(await screen.findByText('sign out'))
    await screen.findByText('signed out')
    await waitFor(() => expect(hasVoiceConsent()).toBe(false))
  })
})

describe('V43 content security policy', () => {
  const directive = (name: string) => CSP.split(';').map(d => d.trim()).find(d => d.startsWith(`${name} `)) ?? ''

  it('allows scripts, connections and workers from this origin only', () => {
    for (const name of ['script-src', 'connect-src', 'worker-src', 'default-src']) expect(directive(name)).toBe(`${name} 'self'`)
  })
  it('allows no plugins and no foreign form targets', () => {
    expect(directive('object-src')).toBe("object-src 'none'")
    expect(directive('form-action')).toBe("form-action 'self'")
    expect(directive('base-uri')).toBe("base-uri 'self'")
  })
  it('never allows eval or inline scripts', () => {
    expect(directive('script-src')).not.toMatch(/unsafe/)
  })
})
