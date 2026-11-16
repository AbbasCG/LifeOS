import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import { ConfirmPasswordProvider } from '../components/ui/ConfirmPasswordProvider'
import SettingsPage from '../features/SettingsPage'
import PrayerOverlapNote from '../components/PrayerOverlapNote'
import PrayerToday from '../features/today/PrayerToday'
import { setPrayerPrefs } from '../lib/prayerStore'

const SETTINGS = { language: 'en', theme: 'light', timezone: 'UTC', work_start: '09:00', work_end: '17:00', break_minutes: 10, work_days: [1, 2, 3, 4, 5], week_start: 1, calendar_system: 'gregorian', hijri_offset: 0,
  prayer_enabled: false, prayer_lat: null, prayer_lng: null, prayer_method: 'umm_al_qura', prayer_asr: 'standard', prayer_before: 10, prayer_after: 20, jumuah_after: 75, ramadan_mode: 'off', ramadan_work_start: '10:00', ramadan_work_end: '15:00', iftar_minutes: 45 }
type Call = { url: string; method: string; body: unknown }
let calls: Call[], reject: Record<string, string[]> | null

function stubApi(extra: (url: string) => unknown = () => undefined) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
    if (/\/api\/settings$/.test(url) && method === 'PUT') return reject ? json({ message: 'The given data was invalid.', errors: reject }, 422) : json(body)
    if (/\/api\/settings$/.test(url)) return json(SETTINGS)
    if (/\/api\/user$/.test(url)) return json({ id: 1, name: 'A', email: 'a@x.io' })
    return json(extra(url) ?? {})
  }))
}
const shell = (ui: React.ReactNode) => render(<ThemeProvider><LanguageProvider><ToastProvider><MemoryRouter><AuthProvider><ConfirmPasswordProvider>{ui}</ConfirmPasswordProvider></AuthProvider></MemoryRouter></ToastProvider></LanguageProvider></ThemeProvider>)
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }))
const saved = () => calls.filter(c => c.method === 'PUT' && /\/api\/settings$/.test(c.url)).map(c => c.body as Record<string, unknown>)

beforeEach(() => { calls = []; reject = null; localStorage.setItem('lifeos-language', 'en'); vi.useFakeTimers({ toFake: ['Date'] }) })
afterEach(() => { cleanup(); delete (navigator as { geolocation?: unknown }).geolocation; vi.unstubAllGlobals(); vi.useRealTimers(); setPrayerPrefs(null); localStorage.clear() })

describe('Settings: Prayer times & Ramadan', () => {
  it('picking a city fills the place and suggests its method, which can still be changed, and saves the right payload', async () => {
    stubApi(); shell(<SettingsPage />)
    const city = await screen.findByLabelText('City')
    await waitFor(() => expect(within(city).getAllByRole('option').length).toBeGreaterThan(40))
    fireEvent.change(city, { target: { value: 'cairo' } })
    expect(screen.getByLabelText('Calculation method')).toHaveValue('egyptian')
    expect(screen.getByLabelText(/^Latitude/)).toHaveValue('30.0444')
    fireEvent.change(screen.getByLabelText('Calculation method'), { target: { value: 'turkey' } })
    fireEvent.click(screen.getByLabelText(/Show prayer times/))
    fireEvent.change(screen.getByLabelText('Asr calculation'), { target: { value: 'hanafi' } })
    fireEvent.change(screen.getByLabelText(/before each prayer/), { target: { value: '15' } })
    fireEvent.change(screen.getByLabelText(/after each prayer/), { target: { value: '25' } })
    fireEvent.change(screen.getByLabelText(/Jumu/), { target: { value: '90' } })
    expect(screen.queryByLabelText(/for iftar/)).toBeNull()   // the Ramadan hours only appear once Ramadan mode is not off
    fireEvent.change(screen.getByLabelText('Ramadan mode'), { target: { value: 'auto' } })
    fireEvent.change(screen.getByLabelText(/for iftar/), { target: { value: '30' } })
    save()
    await waitFor(() => expect(saved()).toHaveLength(1))
    expect(saved()[0]).toMatchObject({ prayer_enabled: true, prayer_lat: 30.0444, prayer_lng: 31.2357, prayer_method: 'turkey', prayer_asr: 'hanafi', prayer_before: 15, prayer_after: 25, jumuah_after: 90, ramadan_mode: 'auto', ramadan_work_start: '10:00', ramadan_work_end: '15:00', iftar_minutes: 30 })
  })

  it('typed coordinates are validated on the field and nothing out of range is sent', async () => {
    stubApi(); shell(<SettingsPage />)
    const lat = await screen.findByLabelText(/^Latitude/), lng = screen.getByLabelText(/^Longitude/)
    fireEvent.change(lat, { target: { value: '95' } })
    expect(lat).toHaveAttribute('aria-invalid', 'true'); expect(screen.getByText('Enter a number between −90 and 90.')).toBeInTheDocument()
    fireEvent.change(lng, { target: { value: '39,8262' } })
    fireEvent.change(lat, { target: { value: '21.4225' } })
    expect(lat).not.toHaveAttribute('aria-invalid')
    save()
    await waitFor(() => expect(saved()).toHaveLength(1))
    expect(saved()[0]).toMatchObject({ prayer_lat: 21.4225, prayer_lng: 39.8262 })
    fireEvent.change(lng, { target: { value: '500' } })
    expect(screen.getByText('Enter a number between −180 and 180.')).toBeInTheDocument()
    save()
    await waitFor(() => expect(saved()).toHaveLength(2))
    expect(saved()[1].prayer_lng).toBeNull()
  })

  it('shows the server’s 422 on prayer_enabled next to the checkbox', async () => {
    reject = { prayer_enabled: ['Set your coordinates before turning prayer times on.'] }
    stubApi(); shell(<SettingsPage />)
    const box = await screen.findByLabelText(/Show prayer times/)
    fireEvent.click(box); save()
    const alert = await screen.findByText('Set your coordinates before turning prayer times on.')
    expect(alert).toHaveAttribute('role', 'alert'); expect(box).toHaveAttribute('aria-invalid', 'true'); expect(box).toHaveAttribute('aria-describedby', alert.id)
  })

  it('uses the device location only after a click, and says plainly when it is denied or missing', async () => {
    const getCurrentPosition = vi.fn((_ok: PositionCallback, fail: PositionErrorCallback) => fail({ code: 1 } as GeolocationPositionError))
    Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition }, configurable: true })
    stubApi(); shell(<SettingsPage />)
    const button = await screen.findByRole('button', { name: 'Use my current location' })
    expect(getCurrentPosition).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(await screen.findByText(/Location access was denied/)).toBeInTheDocument()
    getCurrentPosition.mockImplementation(ok => ok({ coords: { latitude: 21.42251, longitude: 39.82619 } } as GeolocationPosition))
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByLabelText(/^Latitude/)).toHaveValue('21.4225'))
    expect(screen.getByLabelText(/^Longitude/)).toHaveValue('39.8262')
  })

  it('says so when the device has no geolocation', async () => {
    expect('geolocation' in navigator).toBe(false)
    stubApi(); shell(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Use my current location' }))
    expect(await screen.findByText(/cannot share its location/)).toBeInTheDocument()
  })

  it('sends the coordinates to /api/settings and to no other URL, even when prayer times are read', async () => {
    stubApi(url => /prayer-times/.test(url) ? { enabled: true, timezone: 'UTC', days: [] } : undefined)
    const { unmount } = shell(<SettingsPage />)
    const city = await screen.findByLabelText('City')
    await waitFor(() => expect(within(city).getAllByRole('option').length).toBeGreaterThan(40))
    fireEvent.change(city, { target: { value: 'makkah' } })
    fireEvent.click(screen.getByLabelText(/Show prayer times/)); save()
    await waitFor(() => expect(saved()).toHaveLength(1))
    unmount()
    setPrayerPrefs({ prayer_enabled: true }); shell(<PrayerOverlapNote start="2027-02-03T12:50:00Z" end="2027-02-03T13:30:00Z" />)
    await waitFor(() => expect(calls.some(c => /prayer-times/.test(c.url))).toBe(true))
    const leaks = calls.filter(c => (/21\.42|39\.82/.test(c.url) || /21\.42|39\.82/.test(JSON.stringify(c.body ?? ''))) && !(c.method === 'PUT' && /\/api\/settings$/.test(c.url)))
    expect(leaks).toEqual([])
    expect(calls.filter(c => /21\.4225/.test(JSON.stringify(c.body ?? ''))).map(c => c.url)).toEqual([expect.stringMatching(/\/api\/settings$/)])
  })
})

const TIMES = { fajr: '2027-02-03T03:00:00Z', sunrise: '2027-02-03T04:10:00Z', dhuhr: '2027-02-03T09:20:00Z', asr: '2027-02-03T12:42:00Z', maghrib: '2027-02-03T15:10:00Z', isha: '2027-02-03T16:40:00Z' }
const DAY = { date: '2027-02-03', ramadan: false, times: TIMES, windows: [{ prayer: 'asr', prayers: ['asr'], starts_at: '2027-02-03T12:32:00Z', ends_at: '2027-02-03T13:02:00Z' }], iftar: null }

describe('the overlap note', () => {
  it('names the prayer and its time, and is nothing when prayer times are off', async () => {
    stubApi(url => /prayer-times/.test(url) ? { enabled: true, timezone: 'UTC', days: [DAY] } : undefined)
    const { container, rerender } = shell(<PrayerOverlapNote start="2027-02-03T12:50:00Z" end="2027-02-03T13:30:00Z" />)
    expect(container).toBeEmptyDOMElement(); expect(calls.filter(c => /prayer-times/.test(c.url))).toEqual([])   // off: nothing drawn, nothing fetched
    setPrayerPrefs({ prayer_enabled: true })
    await waitFor(() => expect(container).toHaveTextContent('This overlaps Asr (12:42). You can still save.'))
    expect(calls.filter(c => /prayer-times/.test(c.url))).toHaveLength(1)
    rerender(<ThemeProvider><LanguageProvider><ToastProvider><MemoryRouter><AuthProvider><ConfirmPasswordProvider><PrayerOverlapNote start="2027-02-03T13:02:00Z" end="2027-02-03T14:00:00Z" /></ConfirmPasswordProvider></AuthProvider></MemoryRouter></ToastProvider></LanguageProvider></ThemeProvider>)
    await waitFor(() => expect(container).not.toHaveTextContent('This overlaps'))   // touching the window's end is not an overlap
    expect(calls.filter(c => /prayer-times/.test(c.url))).toHaveLength(1)           // the same read served both
  })
})

describe('Today', () => {
  it('shows the next prayer and, on a Ramadan day, the work hours and iftar', async () => {
    vi.setSystemTime(new Date('2027-02-03T11:30:00Z'))
    const tomorrow = { ...DAY, date: '2027-02-04', ramadan: false, windows: [], times: Object.fromEntries(Object.entries(TIMES).map(([k, v]) => [k, v.replace('02-03', '02-04')])) }
    stubApi(url => /prayer-times/.test(url) ? { enabled: true, timezone: 'UTC', days: [{ ...DAY, ramadan: true, iftar: { starts_at: '2027-02-03T15:10:00Z', ends_at: '2027-02-03T15:55:00Z' } }, tomorrow] } : undefined)
    setPrayerPrefs({ prayer_enabled: true, ramadan_work_start: '10:00', ramadan_work_end: '15:00' })
    shell(<PrayerToday />)
    expect(await screen.findByTestId('next-prayer')).toHaveTextContent('Next prayer: Asr 12:42 (in 1 h 12 min)')
    expect(screen.getByTestId('ramadan-note')).toHaveTextContent('Ramadan mode: work hours 10:00–15:00, iftar 15:10')
  })
})
