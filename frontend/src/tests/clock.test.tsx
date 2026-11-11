import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { useState, type ReactNode } from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { ToastProvider } from '../components/ui/Toaster'
import { AuthProvider } from '../contexts/AuthContext'
import CalendarPage from '../features/CalendarPage'
import { DateTimeField } from '../components/ui/DateTimePicker'
import { DueChip } from '../components/visual'
import { setAccountZone, wallClockToInstant } from '../lib/accountDay'
import { formatClock, formatClockRange, formatDayTime, formatFullDayTime, formatMediumDateTime, clockLocale } from '../lib/clock'
import { sessionFull, sessionRange, sessionWhen } from '../lib/taskSchedule'
import { formatTime, preferredHourCycle } from '../lib/dateTime'
import type { CalendarOccurrence } from '../lib/api'

const ZONE = 'Europe/Amsterdam'
const LANGS = ['en', 'ar', 'nl'] as const
const NO_MERIDIEM = /(^|[^A-Za-z])(AM|PM|am|pm)([^A-Za-z]|$)|(^|[\s\d])[صم]($|[\s\d])/
const wrap = (children: ReactNode, path = '/') => <ThemeProvider><LanguageProvider><MemoryRouter initialEntries={[path]}><ToastProvider><AuthProvider>{children}</AuthProvider></ToastProvider></MemoryRouter></LanguageProvider></ThemeProvider>

describe('formatClock: one 24-hour format for every language', () => {
  // [instant, Amsterdam wall clock]
  const table: [string, string][] = [
    ['2026-11-11T07:00:00Z', '08:00'], ['2026-11-11T08:30:00Z', '09:30'], ['2026-11-11T12:00:00Z', '13:00'],
    ['2026-11-11T16:45:00Z', '17:45'], ['2026-11-11T19:00:00Z', '20:00'], ['2026-11-11T22:00:00Z', '23:00'],
    ['2026-11-11T22:59:00Z', '23:59'], ['2026-11-11T23:00:00Z', '00:00'], ['2026-11-11T11:00:00Z', '12:00'], ['2026-11-11T23:05:00Z', '00:05'],
    // spring change 2026-03-29: 02:00 CET -> 03:00 CEST, there is no 02:xx
    ['2026-03-29T00:59:00Z', '01:59'], ['2026-03-29T01:00:00Z', '03:00'], ['2026-03-28T23:00:00Z', '00:00'],
    // autumn change 2026-10-25: 03:00 CEST -> 02:00 CET, 02:xx happens twice
    ['2026-10-25T00:30:00Z', '02:30'], ['2026-10-25T01:30:00Z', '02:30'], ['2026-10-25T02:00:00Z', '03:00'], ['2026-10-24T22:00:00Z', '00:00'],
  ]
  for (const language of LANGS) {
    it(`reads ${language} as two digits, a colon and two digits, never AM/PM`, () => {
      for (const [iso, wanted] of table) {
        expect(formatClock(iso, { language, timeZone: ZONE }), iso).toBe(wanted)
        expect(formatClock(new Date(iso), { language, timeZone: ZONE })).toBe(wanted)
      }
    })
  }
  it('prints midnight as 00:00 (hour12:false would give 24:00 in en-US) and noon as 12:00, also in UTC and without a zone', () => {
    expect(formatClock('2026-06-01T00:00:00Z', { language: 'en', timeZone: 'UTC' })).toBe('00:00')
    expect(formatClock('2026-06-01T12:00:00Z', { language: 'en', timeZone: 'UTC' })).toBe('12:00')
    expect(formatClock(new Date(2026, 5, 1, 0, 0))).toBe('00:00')
    expect(formatClock(new Date(2026, 5, 1, 23, 59))).toBe('23:59')
  })
  it('uses Latin digits and the same time text in ar, nl and en; ranges and day texts too', () => {
    for (const language of LANGS) {
      expect(clockLocale(language)).toMatch(/-u-nu-latn$/)
      expect(formatClockRange('2026-11-11T16:45:00Z', '2026-11-11T17:30:00Z', { language, timeZone: ZONE })).toBe('17:45 – 18:30')
      const day = formatDayTime('2026-11-11T12:00:00Z', { language, timeZone: ZONE })
      expect(day).toMatch(/13:00$/); expect(day).not.toMatch(/[٠-٩]/); expect(day).not.toMatch(NO_MERIDIEM)
      const full = formatFullDayTime('2026-11-12T23:00:00Z', { language, timeZone: ZONE })
      expect(full).toMatch(/2026/); expect(full).toMatch(/00:00$/); expect(full).not.toMatch(/[٠-٩]/)
      expect(formatMediumDateTime('2026-11-12T12:00:00Z', { language, timeZone: ZONE })).toMatch(/13:00$/)
    }
    expect(formatFullDayTime('2026-11-12T23:00:00Z', { language: 'nl', timeZone: ZONE })).toBe('vrijdag 13 november 2026, 00:00')
    expect(formatFullDayTime('2026-11-12T12:00:00Z', { language: 'en', timeZone: ZONE })).toBe('Thursday, November 12, 2026, 13:00')
  })
  it('gives an empty text for an invalid date and ignores an unknown zone', () => {
    expect(formatClock('nope', { language: 'en' })).toBe('')
    expect(formatClock('2026-11-11T07:00:00Z', { language: 'en', timeZone: 'Not/AZone' })).toMatch(/^\d{2}:\d{2}$/)
  })
  it('is what the Tasks session texts use', () => {
    for (const language of LANGS) {
      expect(sessionRange('2026-11-12T12:00:00Z', '2026-11-12T12:30:00Z', language, ZONE)).toBe('13:00 – 13:30')
      expect(sessionFull('2026-11-12T12:00:00Z', '2026-11-12T12:30:00Z', language, ZONE)).toMatch(/13:00 – 13:30$/)
      expect(sessionWhen('2026-11-12T16:45:00Z', language, (e: string) => e, new Date('2026-11-11T10:00:00Z'), ZONE).timeText).toBe('17:45')
    }
  })
  it('wall clock to instant to clock round-trips on the change days', () => {
    for (const [d, h, m] of [[29, 3, 0], [29, 1, 59], [29, 0, 0], [29, 23, 59]] as const) {
      const at = wallClockToInstant(2026, 3, d, h, m, 0, ZONE)
      expect(formatClock(at, { timeZone: ZONE })).toBe(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
    }
  })
})

describe('the picker defaults to the 24-hour clock', () => {
  beforeEach(() => { cleanup(); localStorage.clear() })
  it('does not follow the language: English no longer defaults to 12 hours, and only an explicit choice does', () => {
    expect(preferredHourCycle()).toBe(24)
    expect(formatTime('13:00', 24, 'en')).toBe('13:00'); expect(formatTime('00:00', 24, 'ar')).toBe('00:00')
    expect(formatTime('13:00', 12, 'ar')).not.toMatch(/[٠-٩]/)
    localStorage.setItem('lifeos-hour-cycle', '12'); expect(preferredHourCycle()).toBe(12)
  })
  for (const language of LANGS) {
    it(`shows 13:00 and 00:00 in ${language} and round-trips typed and chosen times`, () => {
      localStorage.setItem('lifeos-language', language)
      let last = ''
      function Harness() { const [v, setV] = useState('2026-11-12T09:00'); last = v; return <DateTimeField kind="datetime" label="When" value={v} onChange={setV} /> }
      render(wrap(<Harness />))
      const trigger = screen.getByRole('button', { name: /When/ })
      expect(trigger.textContent).toMatch(/09:00/); expect(trigger.textContent).not.toMatch(NO_MERIDIEM)
      fireEvent.click(trigger)
      const time = document.querySelector<HTMLInputElement>('.dtp-time input[type="text"]')!
      fireEvent.change(time, { target: { value: '13:00' } }); fireEvent.blur(time)
      expect(last).toBe('2026-11-12T13:00')
      fireEvent.change(time, { target: { value: '00:00' } }); fireEvent.blur(time)
      expect(last).toBe('2026-11-12T00:00')
      expect(document.querySelector('.dtp-dialog')!.textContent).not.toMatch(NO_MERIDIEM)
      fireEvent.click(within(screen.getByRole('group', { name: /^(Hour|الساعة)/ })).getByRole('button', { name: '23' }))
      expect(last).toBe('2026-11-12T23:00')
      expect(document.querySelector('.dtp-dialog [role="group"][aria-label*="AM"]')).toBeNull()
    })
  }
  it('DueChip shows a deadline on the 24-hour clock', () => {
    localStorage.setItem('lifeos-language', 'en')
    const due = new Date(); due.setHours(15, 5, 0, 0)
    render(wrap(<DueChip due={due.toISOString()} />))
    expect(document.body.textContent).toMatch(/15:05/); expect(document.body.textContent).not.toMatch(NO_MERIDIEM)
  })
})

// "Now" is Wednesday 2026-11-11 11:00 in Amsterdam.
const NOW = '2026-11-11T10:00:00Z'
const occ = (id: number, title: string, starts_at: string, ends_at: string): CalendarOccurrence => ({ id: `e${id}`, event_id: id, source: 'lifeos', title, kind: 'flexible', task_id: null, starts_at, ends_at, recurring: false, occurrence_start: null, editable: true })
const events = [
  occ(1, 'Evening class', '2026-11-12T16:45:00Z', '2026-11-12T17:30:00Z'),   // 17:45 - 18:30
  occ(2, 'Midnight call', '2026-11-11T23:00:00Z', '2026-11-11T23:30:00Z'),   // 00:00 - 00:30 on the 12th
  occ(3, 'Lunch', '2026-11-12T12:00:00Z', '2026-11-12T13:00:00Z'),           // 13:00 - 14:00
]
function stub() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = /\/api\/user$/.test(url) ? { id: 1, name: 'A', email: 'a@x.io', timezone: ZONE }
      : /\/api\/calendar/.test(url) ? { data: events }
      : /\/api\/availability/.test(url) ? { work_start: '09:00', work_end: '17:00', days: [] }
      : /\/api\/tasks/.test(url) ? { data: [], meta: { last_page: 1 } } : /\/api\/connected\/tasks/.test(url) ? [] : { data: [] }
    return new Response(JSON.stringify(body), { status: 200 })
  }))
}

describe('the calendar views show a 24-hour clock', () => {
  beforeEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); setAccountZone(ZONE); vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) }); stub() })
  afterEach(() => { vi.useRealTimers(); setAccountZone(undefined) })

  for (const language of LANGS) for (const view of ['day', 'week', 'month', 'agenda']) {
    it(`${view} view in ${language}: 17:45, 00:00 and 13:00, no AM/PM`, async () => {
      localStorage.setItem('lifeos-language', language); localStorage.setItem('lifeos-calendar-view', view)
      render(wrap(<CalendarPage />, '/calendar?date=2026-11-12'))
      await screen.findByText('Evening class')
      const text = document.body.textContent ?? ''
      expect(text).toContain('17:45'); expect(text).toContain('13:00'); expect(text).toContain('00:00')
      expect(text).not.toMatch(NO_MERIDIEM)
      // The hour gutter of the day and week views counts 01:00 ... 23:00.
      if (view === 'day' || view === 'week') { expect(text).toContain('09:00'); expect(text).toContain('23:00'); expect(text).not.toMatch(/\b\d:00\b/) }
      // Every slot label is a two-digit hour.
      if (view === 'day' || view === 'week') for (const slot of document.querySelectorAll('button.slot')) expect(slot.getAttribute('aria-label')).toMatch(/\d{2}:00/)
    })
  }

  it('the event details show the 24-hour time of a read-only event and of the form', async () => {
    localStorage.setItem('lifeos-language', 'en'); localStorage.setItem('lifeos-calendar-view', 'agenda')
    render(wrap(<CalendarPage />, '/calendar?date=2026-11-12'))
    fireEvent.click(await screen.findByText('Evening class'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/17:45/); expect(dialog.textContent).not.toMatch(NO_MERIDIEM)
  })
})

describe('the agenda row reads as a range', () => {
  beforeEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); setAccountZone(ZONE); vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) }); stub() })
  afterEach(() => { vi.useRealTimers(); setAccountZone(undefined) })
  for (const [language, word] of [['en', 'to'], ['ar', 'إلى'], ['nl', 'tot']] as const) {
    it(`has a machine-readable start and a spoken "${word}" in ${language}`, async () => {
      localStorage.setItem('lifeos-language', language); localStorage.setItem('lifeos-calendar-view', 'agenda')
      render(wrap(<CalendarPage />, '/calendar?date=2026-11-12'))
      const row = (await screen.findByText('Evening class')).closest('.agenda-item')!
      const el = row.querySelector('time')!
      expect(el.getAttribute('datetime')).toBe('2026-11-12T16:45:00Z')
      expect(el.textContent?.replace(/\s+/g, ' ').trim()).toBe(`17:45 ${word} 18:30`)
      expect(screen.queryAllByText('غداً')).toHaveLength(0)
    })
  }
})
