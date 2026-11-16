import { describe, expect, it, vi } from 'vitest'
import { hijriDate } from '../lib/hijri'
import { islamicDayLabel, islamicDayOf } from '../lib/islamicDays'

// Anchors: the dates the Umm al-Qura calendar is expected to give for Eid al-Fitr, Eid al-Adha and the Islamic new year agree with the
// browser's Intl data. For 1 Ramadan 1447 the Intl data answers 2026-02-18; countries that announced the 19th are what the one-day
// adjustment setting is for, so both are tested. The Hijri date shown in the app always says it may differ by a day from local sighting.
const ymd = (h: ReturnType<typeof hijriDate>) => h && [h.year, h.month, h.day]

describe('Hijri date (Umm al-Qura)', () => {
  it('1 Shawwal 1447 (Eid al-Fitr) is 2026-03-20', () => {
    expect(ymd(hijriDate('2026-03-20', 'en'))).toEqual([1447, 10, 1])
    expect(ymd(hijriDate('2026-03-19', 'en'))).toEqual([1447, 9, 30])
  })
  it('10 Dhu al-Hijjah 1447 (Eid al-Adha) is 2026-05-27', () => {
    expect(ymd(hijriDate('2026-05-27', 'en'))).toEqual([1447, 12, 10])
  })
  it('1 Muharram 1448 is 2026-06-16', () => {
    expect(ymd(hijriDate('2026-06-16', 'en'))).toEqual([1448, 1, 1])
  })
  it('1 Ramadan 1447: the calendar data says 2026-02-18; the one-day adjustment reaches the 19th for anyone whose country started a day later', () => {
    expect(ymd(hijriDate('2026-02-18', 'en'))).toEqual([1447, 9, 1])
    expect(ymd(hijriDate('2026-02-19', 'en', -1))).toEqual([1447, 9, 1])
  })
  it('shifts the Gregorian day by the offset before converting, in both directions', () => {
    expect(ymd(hijriDate('2026-03-19', 'en', 1))).toEqual([1447, 10, 1])
    expect(ymd(hijriDate('2026-03-21', 'en', -1))).toEqual([1447, 10, 1])
    expect(ymd(hijriDate('2026-03-21', 'en', -2))).toEqual([1447, 9, 30])
  })
  it('does not depend on the time of day or the machine zone', () => {
    expect(ymd(hijriDate('2026-05-27', 'en'))).toEqual([1447, 12, 10])
    expect(ymd(hijriDate('2026-12-31', 'en'))).toEqual(ymd(hijriDate('2026-12-31', 'nl')))
  })
  it('labels the date in each language', () => {
    expect(hijriDate('2026-05-27', 'en')?.label).toMatch(/^Dhu.*Hijjah 10, 1447$/)
    expect(hijriDate('2026-03-20', 'nl')?.label).toBe('1 Sjawal 1447')
    expect(hijriDate('2026-03-20', 'ar')?.label).toContain('شوال')
    expect(hijriDate('2026-03-20', 'ar')?.label).toContain('1447')
  })
  it('returns null for text that is not a day', () => {
    expect(hijriDate('not-a-day', 'en')).toBeNull()
  })
  it('never throws when Intl lacks the calendar: no Hijri date', async () => {
    vi.resetModules()
    const real = Intl.DateTimeFormat
    vi.stubGlobal('Intl', { ...Intl, DateTimeFormat: function () { throw new RangeError('no calendar') } })
    try { const fresh = await import('../lib/hijri'); expect(fresh.hijriDate('2031-01-01', 'en')).toBeNull() } finally { vi.unstubAllGlobals(); expect(Intl.DateTimeFormat).toBe(real) }
  })
  it('returns no Hijri date when the browser quietly falls back to another calendar', async () => {
    vi.resetModules()
    const real = Intl.DateTimeFormat
    vi.stubGlobal('Intl', { ...Intl, DateTimeFormat: function (_: string, o: object) { const f = new real('en', o); return { resolvedOptions: () => ({ calendar: 'gregory' }), formatToParts: f.formatToParts.bind(f), format: f.format.bind(f) } } })
    try { const fresh = await import('../lib/hijri'); expect(fresh.hijriDate('2032-01-01', 'en')).toBeNull() } finally { vi.unstubAllGlobals() }
  })
})

describe('Islamic days', () => {
  it('marks the six days and nothing else', () => {
    expect(islamicDayOf({ month: 1, day: 1 })).toBe('new_year')
    expect(islamicDayOf({ month: 1, day: 10 })).toBe('ashura')
    expect(islamicDayOf({ month: 9, day: 1 })).toBe('ramadan')
    expect(islamicDayOf({ month: 10, day: 1 })).toBe('eid_fitr')
    expect(islamicDayOf({ month: 12, day: 9 })).toBe('arafah')
    expect(islamicDayOf({ month: 12, day: 10 })).toBe('eid_adha')
    expect(islamicDayOf({ month: 9, day: 27 })).toBeNull()   // Laylat al-Qadr is disputed, so it is not marked
    expect(islamicDayOf({ month: 9, day: 21 })).toBeNull()
    expect(islamicDayOf(null)).toBeNull()
  })
  it('finds them on the real dates', () => {
    expect(islamicDayOf(hijriDate('2026-03-20', 'en'))).toBe('eid_fitr')
    expect(islamicDayOf(hijriDate('2026-05-26', 'en'))).toBe('arafah')
    expect(islamicDayOf(hijriDate('2026-05-27', 'en'))).toBe('eid_adha')
    expect(islamicDayOf(hijriDate('2026-06-16', 'en'))).toBe('new_year')
    expect(islamicDayOf(hijriDate('2026-06-25', 'en'))).toBe('ashura')
    expect(islamicDayOf(hijriDate('2026-02-19', 'en', -1))).toBe('ramadan')
  })
  it('has a label in every language for every day', () => {
    for (const key of ['new_year', 'ashura', 'ramadan', 'eid_fitr', 'arafah', 'eid_adha'] as const)
      for (const lang of ['en', 'ar', 'nl']) expect(islamicDayLabel(key, lang).length).toBeGreaterThan(2)
    expect(islamicDayLabel('eid_adha', 'ar')).toBe('عيد الأضحى')
  })
})
