import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import type { ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import SetupHost from '../components/layout/SetupHost'
import Sidebar from '../components/layout/Sidebar'
import SettingsPage from '../features/SettingsPage'
import { setMoreOpen, setUiPrefs, uiPrefs } from '../lib/uiPrefs'
import { calendarPrefs, setCalendarPrefs } from '../lib/weekStart'
import { defaultWorkDays, setupDraft } from '../features/onboarding/setupDraft'

/** First-run setup (new accounts, onboarding 'pending') and the simple navigation (ui_mode 'simple'); older accounts see neither. */
type Call = { method: string; url: string; body: Record<string, unknown> | null }
let calls: Call[] = [], settings: Record<string, unknown> = {}, putReply: (body: Record<string, unknown>) => Response
const fresh = () => ({ onboarding: 'pending', ui_mode: 'simple', timezone: 'Asia/Tokyo', language: 'en', week_start: 1, calendar_system: 'gregorian', hijri_offset: 0, prayer_enabled: false, prayer_lat: null, prayer_lng: null, prayer_method: 'umm_al_qura', prayer_asr: 'standard', prayer_before: 10, prayer_after: 20, jumuah_after: 75, ramadan_mode: 'off', ramadan_work_start: '10:00', ramadan_work_end: '15:00', iftar_minutes: 45 })
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const puts = () => calls.filter(c => c.method === 'PUT' && c.url.endsWith('/api/settings'))

function Where() { return <output data-testid="where">{useLocation().pathname}</output> }
const wrap = (children: ReactNode, at = '/tasks') => <MemoryRouter initialEntries={[at]}><ThemeProvider><LanguageProvider><ToastProvider><AuthProvider><Routes><Route path="*" element={<>{children}<Where /></>} /></Routes></AuthProvider></ToastProvider></LanguageProvider></ThemeProvider></MemoryRouter>

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('lifeos-language', 'en')
  calls = []; settings = fresh()
  putReply = body => { settings = { ...settings, ...body }; return json(settings) }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET', body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ method, url, body })
    if (url.endsWith('/api/user')) return json({ id: 1, name: 'New', email: 'n@x.io' })
    if (url.endsWith('/api/settings')) return method === 'PUT' ? putReply(body) : json(settings)
    return json({})
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setUiPrefs(null); setMoreOpen(false); setCalendarPrefs(null); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

async function openSetup() {
  setUiPrefs(settings)
  render(wrap(<SetupHost />))
  return screen.findByRole('dialog', { name: 'Your basics' })
}

describe('first-run setup', () => {
  it('shows only for an account whose setup is pending', async () => {
    for (const p of [{ onboarding: 'done' }, {}, null]) {
      setUiPrefs(p)
      const { unmount } = render(wrap(<SetupHost />))
      await act(async () => { await new Promise(r => setTimeout(r, 20)) })
      expect(screen.queryByRole('dialog')).toBeNull()
      unmount()
    }
    expect(calls.filter(c => c.url.endsWith('/api/settings'))).toHaveLength(0)
    expect(await openSetup()).toBeVisible()
  })

  it('step 1 shows the saved language, the zone from signup and the local time there', async () => {
    const dialog = await openSetup()
    expect(within(dialog).getByText('Step 1 of 3')).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'Language' })).toHaveValue('en')
    expect(within(dialog).getByRole('combobox', { name: 'Time zone' })).toHaveValue('Asia/Tokyo')
    const expected = new Date().toLocaleString('en', { timeZone: 'Asia/Tokyo', weekday: 'long', hour: '2-digit', minute: '2-digit' })
    expect(within(dialog).getByRole('combobox', { name: 'Time zone' })).toHaveAccessibleDescription(`Your local time there: ${expected}. If this is not right, choose another time zone.`)
    expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: 'Your basics' }))
  })

  it('switches the language of the whole screen at once (Arabic right to left, Dutch)', async () => {
    const dialog = await openSetup()
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Language' }), { target: { value: 'ar' } })
    expect(await screen.findByRole('heading', { name: 'الأساسيات' })).toBeInTheDocument()
    expect(document.documentElement.dir).toBe('rtl')
    expect(screen.getByText('الخطوة 1 من 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'التالي' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'اللغة' }), { target: { value: 'nl' } })
    expect(await screen.findByRole('heading', { name: 'De basis' })).toBeInTheDocument()
    expect(document.documentElement.dir).toBe('ltr')
    expect(screen.getByText('Stap 1 van 3')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Volgende' }))
    expect(await screen.findByRole('heading', { name: 'Je werkweek' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Werkdagen' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Volgende' }))
    expect(await screen.findByRole('heading', { name: 'Optionele extra’s' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Afronden' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Instelling overslaan' })).toBeInTheDocument()
  })

  it('Next and Back move between the steps and focus each heading; step 2 shows the defaults, ordered by the week start', async () => {
    const dialog = await openSetup()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))
    const week = await within(dialog).findByRole('heading', { name: 'Your work week' })
    expect(document.activeElement).toBe(week)
    expect(within(dialog).getByText('Step 2 of 3')).toBeInTheDocument()
    const days = () => within(within(dialog).getByRole('group', { name: 'Working days' })).getAllByRole('checkbox')
    expect(days().map(d => d.parentElement!.textContent)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    expect(days().map(d => (d as HTMLInputElement).checked)).toEqual([true, true, true, true, true, false, false])
    expect(within(dialog).getByText('09:00')).toBeInTheDocument()
    expect(within(dialog).getByText('17:00')).toBeInTheDocument()
    // A Saturday week (and work days the person never touched) follows the usual Sunday-to-Thursday week.
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Week starts on' }), { target: { value: '6' } })
    expect(days().map(d => d.parentElement!.textContent)).toEqual(['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'])
    expect(days().map(d => (d as HTMLInputElement).checked)).toEqual([false, true, true, true, true, true, false])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }))
    expect(document.activeElement).toBe(await within(dialog).findByRole('heading', { name: 'Your basics' }))
    expect(within(dialog).queryByRole('button', { name: 'Back' })).toBeNull()
  })

  it('a working week needs a day, and work must end after it starts', async () => {
    const dialog = await openSetup()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))
    await within(dialog).findByRole('heading', { name: 'Your work week' })
    for (const box of within(dialog).getAllByRole('checkbox')) if ((box as HTMLInputElement).checked) fireEvent.click(box)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Choose at least one working day.')
    expect(within(dialog).getByRole('heading', { name: 'Your work week' })).toBeInTheDocument()
  })

  it('Skip setup marks it done with one small request and closes', async () => {
    const dialog = await openSetup()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Skip setup' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(puts()).toHaveLength(1)
    expect(puts()[0].body).toEqual({ onboarding: 'done' })
    expect(uiPrefs().onboarding).toBe('done')
  })

  it('Finish saves every answer in ONE request with onboarding done, lands on Today and welcomes', async () => {
    const dialog = await openSetup()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))
    await within(dialog).findByRole('heading', { name: 'Your work week' })
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Week starts on' }), { target: { value: '6' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Thu' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))
    await within(dialog).findByRole('heading', { name: 'Optional extras' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Show Hijri dates beside the Gregorian ones' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Show prayer times and keep planned work clear of them' }))
    const city = within(dialog).getByRole('combobox', { name: 'City' })
    await waitFor(() => expect(within(city).getByRole('option', { name: 'Cairo' })).toBeInTheDocument())
    fireEvent.change(city, { target: { value: 'cairo' } })
    expect(within(dialog).getByRole('link', { name: 'Finish and connect a calendar in Settings' })).toHaveAttribute('href', '/settings/integrations')
    expect(puts()).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish' }))
    expect(await screen.findByText('Welcome to LifeOS. You are all set.')).toBeInTheDocument()
    expect(puts()).toHaveLength(1)
    expect(puts()[0].body).toEqual({ language: 'en', timezone: 'Asia/Tokyo', week_start: 6, work_days: [0, 1, 2, 3], work_start: '09:00', work_end: '17:00', calendar_system: 'hijri', prayer_enabled: true, prayer_lat: 30.0444, prayer_lng: 31.2357, prayer_method: 'egyptian', onboarding: 'done' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/)
    expect(uiPrefs().onboarding).toBe('done')
    expect(calendarPrefs()).toMatchObject({ weekStart: 6, system: 'hijri' })
  })

  it('prayer times need a city before Finish', async () => {
    const dialog = await openSetup()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' })); await within(dialog).findByRole('heading', { name: 'Your work week' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' })); await within(dialog).findByRole('heading', { name: 'Optional extras' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Show prayer times and keep planned work clear of them' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Choose a city for the prayer times.')
    expect(within(dialog).getByRole('combobox', { name: /City/ })).toHaveAttribute('aria-invalid', 'true')
    expect(puts()).toHaveLength(0)
  })

  it('shows the server’s refusal on its field, on the step that has it', async () => {
    putReply = () => json({ message: 'The timezone field must be a valid timezone.', errors: { timezone: ['The timezone field must be a valid timezone.'] } }, 422)
    const dialog = await openSetup()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' })); await within(dialog).findByRole('heading', { name: 'Your work week' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' })); await within(dialog).findByRole('heading', { name: 'Optional extras' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish' }))
    expect(await within(dialog).findByRole('heading', { name: 'Your basics' })).toBeInTheDocument()
    const zone = within(dialog).getByRole('combobox', { name: /Time zone/ })
    expect(zone).toHaveAttribute('aria-invalid', 'true')
    expect(zone).toHaveAccessibleDescription(/^The timezone field must be a valid timezone\. Your local time there:/)
    expect(within(dialog).getByRole('alert')).toHaveTextContent('The timezone field must be a valid timezone.')
    expect(uiPrefs().onboarding).toBe('pending')
  })

  it('Escape asks in the dialog before skipping (no browser confirm)', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    const dialog = await openSetup()
    const escape = () => fireEvent(dialog.closest('dialog') ?? dialog, new Event('cancel', { cancelable: true }))
    escape()
    expect(within(dialog).getByText('Skip the setup?')).toBeInTheDocument()
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep setting up' }))
    expect(puts()).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep setting up' }))
    expect(within(dialog).queryByText('Skip the setup?')).toBeNull()
    expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: 'Your basics' }))
    // A second Escape while asking means "no": back to the step.
    escape(); escape()
    expect(within(dialog).queryByText('Skip the setup?')).toBeNull()
    escape()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Skip setup' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(puts().map(c => c.body)).toEqual([{ onboarding: 'done' }])
    expect(confirm).not.toHaveBeenCalled()
  })

  it('fills sensible defaults for what a new account never saved', () => {
    expect(setupDraft({ timezone: 'Asia/Riyadh', week_start: 6 }, 'ar')).toMatchObject({ language: 'ar', timezone: 'Asia/Riyadh', work_days: [0, 1, 2, 3, 4], work_start: '09:00', work_end: '17:00', calendar_system: 'gregorian', prayer_enabled: false })
    expect(setupDraft({ work_days: [1, 3] }, 'en')).toMatchObject({ week_start: 1, work_days: [1, 3] })
    // A new account in a Sunday-to-Thursday country is offered its local week; the UAE and Europe keep Monday to Friday.
    expect(setupDraft({ timezone: 'Asia/Riyadh', week_start: 1, work_days: [1, 2, 3, 4, 5] }, 'ar')).toMatchObject({ week_start: 0, work_days: [0, 1, 2, 3, 4] })
    expect(setupDraft({ timezone: 'Africa/Cairo' }, 'ar')).toMatchObject({ week_start: 0, work_days: [0, 1, 2, 3, 4] })
    expect(setupDraft({ timezone: 'Asia/Dubai', week_start: 1, work_days: [1, 2, 3, 4, 5] }, 'ar')).toMatchObject({ week_start: 1, work_days: [1, 2, 3, 4, 5] })
    expect(setupDraft({ timezone: 'Europe/Amsterdam', week_start: 1, work_days: [1, 2, 3, 4, 5] }, 'nl')).toMatchObject({ week_start: 1, work_days: [1, 2, 3, 4, 5] })
    // A week someone already chose is never replaced.
    expect(setupDraft({ timezone: 'Asia/Riyadh', week_start: 1, work_days: [1, 2, 3] }, 'ar')).toMatchObject({ week_start: 1, work_days: [1, 2, 3] })
    expect(defaultWorkDays(1)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('simple navigation', () => {
  const links = () => screen.getAllByRole('navigation').flatMap(n => within(n).queryAllByRole('link')).map(l => l.textContent)
  it('shows Today, Tasks, Calendar and Focus plus «More», which reveals the rest in place and is remembered', async () => {
    setUiPrefs({ ui_mode: 'simple' })
    render(wrap(<Sidebar open={false} onClose={() => {}} />))
    expect(links()).toEqual(['Today', 'Tasks', 'Calendar', 'Focus'])
    const more = screen.getByRole('button', { name: 'More' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    const region = document.getElementById(more.getAttribute('aria-controls')!)!
    expect(region).not.toBeVisible()
    fireEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(region).toBeVisible()
    expect(links()).toEqual(['Today', 'Tasks', 'Calendar', 'Focus', 'Copilot', 'Timeline', 'Smart planning', 'Weekly review', 'Goals', 'Habits & routines', 'Projects', 'Insights', 'Categories', 'Discover', 'What’s new', 'Settings'])
    expect(localStorage.getItem('lifeos-nav-more')).toBe('open')
    fireEvent.click(more)
    expect(localStorage.getItem('lifeos-nav-more')).toBe('closed')
    expect(links()).toHaveLength(4)
  })

  it('«Show all sections» switches to the full navigation and saves ui_mode full', async () => {
    setUiPrefs({ ui_mode: 'simple' })
    render(wrap(<Sidebar open={false} onClose={() => {}} />))
    fireEvent.click(screen.getByRole('button', { name: 'Show all sections' }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0].body).toEqual({ ui_mode: 'full' })
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show all sections' })).toBeNull()
    expect(links()).toHaveLength(16)
    expect(uiPrefs().uiMode).toBe('full')
  })

  it('a refused «Show all sections» goes back to the simple list and says why', async () => {
    putReply = () => json({ message: 'Could not save.' }, 500)
    setUiPrefs({ ui_mode: 'simple' })
    render(wrap(<Sidebar open={false} onClose={() => {}} />))
    fireEvent.click(screen.getByRole('button', { name: 'Show all sections' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save.')
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument()
    expect(uiPrefs()).toMatchObject({ uiMode: 'simple', onboarding: 'done' })
  })

  it('the full navigation (every existing account) is unchanged', () => {
    setUiPrefs({ ui_mode: 'full' })
    render(wrap(<Sidebar open={false} onClose={() => {}} />))
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show all sections' })).toBeNull()
    expect(screen.getAllByRole('navigation').map(n => n.getAttribute('aria-label'))).toEqual(['Main', 'Plan', 'Progress', 'More'])
    expect(links()).toHaveLength(16)
    cleanup(); setUiPrefs(null)
    render(wrap(<Sidebar open={false} onClose={() => {}} />))
    expect(links()).toHaveLength(16)
  })

  it('speaks Arabic and Dutch', () => {
    setUiPrefs({ ui_mode: 'simple' })
    localStorage.setItem('lifeos-language', 'ar')
    const { unmount } = render(wrap(<Sidebar open={false} onClose={() => {}} />))
    expect(screen.getByRole('button', { name: 'المزيد' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'إظهار كل الأقسام' })).toBeInTheDocument()
    unmount()
    localStorage.setItem('lifeos-language', 'nl')
    render(wrap(<Sidebar open={false} onClose={() => {}} />))
    expect(screen.getByRole('button', { name: 'Meer' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Alle onderdelen tonen' })).toBeInTheDocument()
  })
})

describe('Settings: Navigation', () => {
  it('shows the saved navigation size and saves a change with the other preferences', async () => {
    settings = { ...fresh(), onboarding: 'done', ui_mode: 'full', theme: 'system', work_start: '09:00', work_end: '17:00', break_minutes: 10, work_days: [1, 2, 3, 4, 5] }
    render(wrap(<SettingsPage />, '/settings'))
    const select = await screen.findByRole('combobox', { name: 'Navigation' })
    expect(select).toHaveValue('full')
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Simple (the essentials first)', 'Full (every section)'])
    fireEvent.change(select, { target: { value: 'simple' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0].body).toMatchObject({ ui_mode: 'simple', onboarding: 'done' })
    await waitFor(() => expect(uiPrefs().uiMode).toBe('simple'))
  })

  it('opens for a new account whose settings hold only its zone and language', async () => {
    settings = { onboarding: 'done', ui_mode: 'simple', timezone: 'Asia/Tokyo', language: 'en', week_start: 1, calendar_system: 'gregorian', hijri_offset: 0, prayer_enabled: false, prayer_lat: null, prayer_lng: null, prayer_method: 'umm_al_qura' }
    render(wrap(<SettingsPage />, '/settings'))
    expect(await screen.findByRole('combobox', { name: 'Navigation' })).toHaveValue('simple')
    expect(screen.getByRole('group', { name: 'Working days' })).toBeInTheDocument()
  })
})
