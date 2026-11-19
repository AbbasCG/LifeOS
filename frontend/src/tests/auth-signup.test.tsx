import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { AuthProvider } from '../contexts/AuthContext'
import AuthPage from '../features/AuthPage'

/** Signing up sends the browser's zone and the app's language, so a new account starts in them; the buttons say what they do. */
type Call = { url: string; method: string; body?: Record<string, unknown> }
let calls: Call[], register: (body: Record<string, unknown>) => { status: number; body: unknown }
const shell = (mode: 'login' | 'register') => render(<ThemeProvider><LanguageProvider><MemoryRouter><AuthProvider><AuthPage mode={mode} /></AuthProvider></MemoryRouter></LanguageProvider></ThemeProvider>)

beforeEach(() => {
  cleanup(); localStorage.clear(); calls = []
  register = () => ({ status: 201, body: { id: 1, name: 'Sara', email: 's@x.io' } })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url: String(url), method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined }
    calls.push(call)
    if (/\/api\/register$/.test(call.url)) { const r = register(call.body!); return new Response(JSON.stringify(r.body), { status: r.status }) }
    if (/\/api\/user$/.test(call.url)) return new Response(JSON.stringify({ message: 'Unauthenticated.' }), { status: 401 })
    return new Response('{}', { status: 200 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const registers = () => calls.filter(c => c.method === 'POST' && /\/api\/register$/.test(c.url))
function fill(labels: { name: string; email: string; password: string; confirm: string }) {
  fireEvent.change(screen.getByLabelText(labels.name), { target: { value: 'Sara' } })
  fireEvent.change(screen.getByLabelText(labels.email), { target: { value: 's@x.io' } })
  fireEvent.change(screen.getByLabelText(labels.password), { target: { value: 'very-strong-pass' } })
  fireEvent.change(screen.getByLabelText(labels.confirm), { target: { value: 'very-strong-pass' } })
}
const EN = { name: 'Name', email: 'Email', password: 'Password', confirm: 'Confirm password' }

describe('signing up sends the browser zone and the app language', () => {
  it('English: the zone the browser reports and "en", with nothing else changed in the form', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'Europe/Amsterdam' } as Intl.ResolvedDateTimeFormatOptions)
    localStorage.setItem('lifeos-language', 'en')
    shell('register'); fill(EN)
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(registers()).toHaveLength(1))
    expect(registers()[0].body).toEqual({ name: 'Sara', email: 's@x.io', password: 'very-strong-pass', password_confirmation: 'very-strong-pass', timezone: 'Europe/Amsterdam', language: 'en' })
  })

  it.each([['ar', 'Asia/Riyadh', { name: 'الاسم', email: 'البريد الإلكتروني', password: 'كلمة المرور', confirm: 'تأكيد كلمة المرور' }, 'إنشاء الحساب'], ['nl', 'Europe/Amsterdam', EN, 'Account aanmaken']] as const)('%s: sends the language the app is in', async (language, zone, labels, button) => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: zone } as Intl.ResolvedDateTimeFormatOptions)
    localStorage.setItem('lifeos-language', language)
    shell('register'); fill(labels)
    fireEvent.click(screen.getByRole('button', { name: button }))
    await waitFor(() => expect(registers()).toHaveLength(1))
    expect(registers()[0].body).toMatchObject({ timezone: zone, language })
  })

  it('leaves the zone out when the browser reports none or cannot say', async () => {
    localStorage.setItem('lifeos-language', 'en')
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: '' } as Intl.ResolvedDateTimeFormatOptions)
    shell('register'); fill(EN)
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(registers()).toHaveLength(1))
    expect(registers()[0].body).not.toHaveProperty('timezone'); expect(registers()[0].body).toMatchObject({ language: 'en' })
    cleanup(); calls = []
    spy.mockImplementation(() => { throw new RangeError('no zone') })
    shell('register'); fill(EN)
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(registers()).toHaveLength(1))
    expect(registers()[0].body).not.toHaveProperty('timezone')
  })

  it('a zone the server refuses never blocks signing up: it is sent once more without the zone', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'Asia/Calcutta' } as Intl.ResolvedDateTimeFormatOptions)
    localStorage.setItem('lifeos-language', 'en')
    register = body => body.timezone ? { status: 422, body: { message: 'The timezone field must be a valid timezone.', errors: { timezone: ['invalid'] } } } : { status: 201, body: {} }
    shell('register'); fill(EN)
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(registers()).toHaveLength(2))
    expect(registers()[1].body).not.toHaveProperty('timezone'); expect(registers()[1].body).toMatchObject({ language: 'en', email: 's@x.io' })
    expect(screen.queryByText(/valid timezone/)).toBeNull()
  })

  it('signing in sends no zone or language', async () => {
    localStorage.setItem('lifeos-language', 'en')
    shell('login')
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 's@x.io' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(calls.some(c => /\/api\/login$/.test(c.url))).toBe(true))
    expect(calls.find(c => /\/api\/login$/.test(c.url))!.body).toEqual({ email: 's@x.io', password: 'pw' })
  })
})

describe('the auth buttons say the action; the headings stay', () => {
  it.each([
    ['en', 'login', 'Welcome back', 'Sign in'], ['en', 'register', 'Create your workspace', 'Create account'],
    ['ar', 'login', 'مرحباً بعودتك', 'تسجيل الدخول'], ['ar', 'register', 'أنشئ مساحة عملك', 'إنشاء الحساب'],
    ['nl', 'login', 'Welcome back', 'Inloggen'], ['nl', 'register', 'Create your workspace', 'Account aanmaken'],
  ] as const)('%s %s: heading "%s", button "%s"', (language, mode, heading, button) => {
    localStorage.setItem('lifeos-language', language)
    shell(mode)
    expect(screen.getByRole('heading', { level: 2, name: heading })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: button })).toHaveClass('primary')
    expect(screen.queryByRole('button', { name: heading })).toBeNull()
  })
})
