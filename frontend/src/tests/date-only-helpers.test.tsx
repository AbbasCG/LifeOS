import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ThemeProvider } from '../contexts/ThemeContext'
import { DueLine } from '../features/tasks/ScheduleParts'
import { DueChip } from '../components/visual'
import { setAccountZone } from '../lib/accountDay'
import { DeadlinesWidget } from '../features/today/TodayWidgets'
import { draftOf, groupOf, dueDay, duePayload, formatDue, isAllDay, moveDue, restoreDue } from '../lib/dueDate'

// The browser is in Auckland; the account is in Amsterdam.
const BROWSER_TZ = process.env.TZ
process.env.TZ = 'Pacific/Auckland'
afterAll(() => { if (BROWSER_TZ === undefined) delete process.env.TZ; else process.env.TZ = BROWSER_TZ })
const wrap = (ui: React.ReactNode) => <ThemeProvider><LanguageProvider><MemoryRouter>{ui}</MemoryRouter></LanguageProvider></ThemeProvider>
// Sat 14 Nov 2026 is a date-only deadline: the server stores 23:59 Amsterdam = 22:59Z.
const ALL_DAY = { due_at: '2026-11-14T22:59:00Z', due_all_day: true, due_date: '2026-11-14' }
const NOW = new Date('2026-11-12T10:00:00Z')   // Thu 12 Nov 11:00 Amsterdam, 23:00 Auckland

beforeEach(() => { cleanup(); localStorage.clear(); setAccountZone('Europe/Amsterdam') })
afterEach(() => { vi.useRealTimers(); cleanup(); setAccountZone(undefined) })

describe('date-only deadline helpers (browser zone differs from the account zone)', () => {
  it('reads only the flag: a timed deadline at 23:59 account time stays timed', () => {
    expect(isAllDay(ALL_DAY)).toBe(true)
    expect(isAllDay({ due_at: '2026-11-14T16:00:00Z', due_all_day: false })).toBe(false)
    expect(isAllDay({ due_at: '2026-11-14T22:59:00Z', due_all_day: false })).toBe(false)   // timed 23:59
    expect(isAllDay({ due_at: '2026-11-14T22:59:00Z' })).toBe(false)                         // no flag: not date-only
    expect(isAllDay({ due_at: null })).toBe(false)
    expect(dueDay(ALL_DAY)).toBe('2026-11-14')
  })
  it('a timed 23:59 deadline shows its time, a date-only one does not (Today, Review, Dashboard and Briefing all use formatDue)', () => {
    const o = { language: 'en', timeZone: 'Europe/Amsterdam' }
    expect(formatDue({ due_at: '2026-11-14T22:59:00Z', due_all_day: false }, o)).toBe('Sat, Nov 14 23:59')
    expect(formatDue({ due_at: '2026-11-14T22:59:00Z', due_all_day: true }, o)).toBe('Sat, Nov 14')
  })
  it('the Today deadlines widget: the row\'s own flag decides, project rows without one stay timed', () => {
    localStorage.setItem('lifeos-language', 'en')
    const row = (id: number, type: string, due_all_day?: boolean) => ({ id, title: `R${id}`, priority: null, due_at: '2026-11-14T22:59:00Z', type, bucket: 'week', ...(due_all_day === undefined ? {} : { due_all_day }) })
    render(wrap(<DeadlinesWidget data={{ deadlines: [row(1, 'task', false), row(2, 'task', true), row(3, 'external', true), row(4, 'project')] } as never} />))
    const lines = [...document.querySelectorAll('.deadline-list li small')].map(e => e.textContent)
    expect(lines[0]).toContain('23:59'); expect(lines[1]).not.toContain(':'); expect(lines[2]).not.toContain(':'); expect(lines[3]).toContain('23:59')
  })
  it('groupOf: a date-only deadline is "next" through the same day next week, a timed one by 7x24 hours', () => {
    const now = Date.parse('2026-11-12T10:00:00Z')   // Thu 12 Nov 11:00 Amsterdam
    const t = (over: Record<string, unknown>) => ({ id: 1, title: 'x', status: 'todo', ...over }) as never
    expect(groupOf(t({ due_at: '2026-11-19T22:59:00Z', due_all_day: true, due_date: '2026-11-19' }), now)).toBe('next')    // Thu 19 Nov, date-only
    expect(groupOf(t({ due_at: '2026-11-20T22:59:00Z', due_all_day: true, due_date: '2026-11-20' }), now)).toBe('later')
    expect(groupOf(t({ due_at: '2026-11-19T22:59:00Z', due_all_day: false }), now)).toBe('later')                          // timed 23:59 is past 7x24 h
    expect(groupOf(t({ due_at: '2026-11-19T09:00:00Z', due_all_day: false }), now)).toBe('next')
    expect(groupOf(t({ due_at: '2026-11-12T22:59:00Z', due_all_day: true, due_date: '2026-11-12' }), now)).toBe('now')
  })
  it('the dialog opens an all-day task with the toggle on, the date and 17:00 behind it', () => {
    expect(draftOf(ALL_DAY)).toEqual({ field: '2026-11-14T17:00', noTime: true })
    expect(draftOf({ due_at: '2026-11-14T16:00:00Z', due_all_day: false })).toEqual({ field: '2026-11-14T17:00', noTime: false })
    expect(draftOf({ due_at: null })).toEqual({ field: '', noTime: false })
  })
  it('payload: nothing when untouched, due_date for a day, due_at for a time, null to clear', () => {
    const opened = draftOf(ALL_DAY)
    expect(duePayload(opened, opened)).toEqual({})
    expect(duePayload({ field: '2026-11-14T09:00', noTime: true }, opened)).toEqual({})           // the hidden time does not matter
    expect(duePayload({ field: '2026-11-15T17:00', noTime: true }, opened)).toEqual({ due_date: '2026-11-15' })
    expect(duePayload({ field: '2026-11-14T17:00', noTime: false }, opened)).toEqual({ due_at: '2026-11-14T16:00:00.000Z' })
    expect(duePayload({ field: '', noTime: true }, opened)).toEqual({ due_at: null })
    expect(duePayload({ field: '2026-11-14T10:00', noTime: true }, draftOf({ due_at: '2026-11-14T16:00:00Z', due_all_day: false }))).toEqual({ due_date: '2026-11-14' })
    expect(duePayload({ field: '', noTime: false }, null)).toEqual({ due_at: null })               // a new task says so
    expect(duePayload({ field: '', noTime: true }, draftOf({ due_at: null }))).toEqual({})
  })
  it('DST days: a date-only deadline is the day, a timed one the account wall clock', () => {
    // 2026-03-29 has 23 hours in Amsterdam, 2026-10-25 has 25.
    expect(duePayload({ field: '2026-03-29T00:00', noTime: true }, null)).toEqual({ due_date: '2026-03-29' })
    expect(duePayload({ field: '2026-10-25T23:00', noTime: true }, null)).toEqual({ due_date: '2026-10-25' })
    expect(duePayload({ field: '2026-03-29T03:30', noTime: false }, null)).toEqual({ due_at: '2026-03-29T01:30:00.000Z' })
    expect(duePayload({ field: '2026-10-25T02:30', noTime: false }, null)).toEqual({ due_at: '2026-10-25T00:30:00.000Z' })   // the first 02:30
    const repeated = '2026-10-25T01:30:00Z'                                                                                   // the second 02:30
    expect(duePayload(draftOf({ due_at: repeated }), draftOf({ due_at: repeated }))).toEqual({})
    expect(restoreDue({ due_at: '2026-10-25T22:59:59Z', due_all_day: true, due_date: '2026-10-25' })).toEqual({ due_date: '2026-10-25' })
  })
  it('quick moves keep a date-only deadline date-only (and a timed one timed)', () => {
    expect(moveDue('tomorrow', ALL_DAY, NOW)).toEqual({ due_date: '2026-11-13' })
    expect(moveDue('today', ALL_DAY, NOW)).toEqual({ due_date: '2026-11-12' })
    expect(moveDue('nextweek', ALL_DAY, NOW)).toEqual({ due_date: '2026-11-16' })
    expect(moveDue('none', ALL_DAY, NOW)).toEqual({ due_at: null })
    expect(moveDue('tomorrow', { due_at: '2026-11-14T08:30:00Z', due_all_day: false }, NOW)).toEqual({ due_at: '2026-11-13T08:30:00.000Z' })
    expect(restoreDue(ALL_DAY)).toEqual({ due_date: '2026-11-14' })
    expect(restoreDue({ due_at: '2026-11-14T08:30:00Z', due_all_day: false })).toEqual({ due_at: '2026-11-14T08:30:00Z' })
    expect(restoreDue({ due_at: null })).toEqual({ due_at: null })
  })
  it('formatDue shows the day alone for a date-only deadline, in the account zone', () => {
    expect(formatDue(ALL_DAY, { language: 'en', timeZone: 'Europe/Amsterdam' })).toBe('Sat, Nov 14')
    expect(formatDue({ due_at: '2026-11-14T16:00:00Z', due_all_day: false }, { language: 'en', timeZone: 'Europe/Amsterdam' })).toBe('Sat, Nov 14 17:00')
  })
})

describe('what a date-only deadline reads as', () => {
  // "Tomorrow"/"Today" wording depends on the clock: pin it so the test does not depend on the day it runs.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: NOW }) })
  const dueText = () => document.querySelector('.due')!.textContent!
  it.each([['en', 'Due:', 'Sat, Nov 14'], ['nl', 'Deadline:', 'za 14 nov'], ['ar', 'الاستحقاق:', '14']])('DueLine in %s has no time', (lang, label, day) => {
    localStorage.setItem('lifeos-language', lang)
    render(wrap(<DueLine due={ALL_DAY.due_at} allDay />))
    const text = dueText()
    expect(text).toContain(label); expect(text).toContain(day)
    expect(text).not.toMatch(/\d{1,2}:\d{2}/)
    expect(text).not.toContain('23:59')
  })
  it('a timed deadline keeps its 24-hour time', () => {
    localStorage.setItem('lifeos-language', 'en')
    render(wrap(<DueLine due="2026-11-14T16:00:00Z" allDay={false} />))
    expect(dueText()).toMatch(/Sat, Nov 14 17:00/)
  })
  it('is not late during its day, and late once the day has ended', () => {
    localStorage.setItem('lifeos-language', 'en')
    const { rerender } = render(wrap(<DueLine due="2099-11-14T22:59:00Z" allDay />))
    expect(document.querySelector('.due.late')).toBeNull()
    rerender(wrap(<DueLine due="2020-11-14T22:59:00Z" allDay />))
    expect(document.querySelector('.due.late')).not.toBeNull()
  })
  it('DueChip reads the account zone, not the Auckland browser: 17:00 in Amsterdam is 05:00 next day in Auckland', () => {
    localStorage.setItem('lifeos-language', 'en')
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })   // Thu 12 Nov 11:00 Amsterdam, already Fri 13 Nov in Auckland
    render(wrap(<DueChip due="2026-11-12T15:00:00Z" />))
    expect(document.querySelector('.due time')!.textContent).toBe('Today 16:00')
    cleanup()
    render(wrap(<DueChip due="2099-11-14T22:59:00Z" allDay />))
    expect(document.querySelector('.due time')!.getAttribute('datetime')).toBe('2099-11-14')
    expect(document.querySelector('.due time')!.textContent).toBe('Nov 14')   // the day Amsterdam reads (the 14th; Auckland would say the 15th), never 23:59
  })
})
