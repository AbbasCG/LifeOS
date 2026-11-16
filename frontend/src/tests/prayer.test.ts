import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextPrayer, overlapOf, untilWords, windowLabel, type PrayerDay } from '../lib/prayer'
import { setPrayerPrefs, prayerPrefs } from '../lib/prayerStore'
import { methodForCountry, parseCoord } from '../features/settings/prayerLogic'
import { CITIES } from '../features/settings/prayerCities'

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }) })
afterEach(() => { vi.useRealTimers(); setPrayerPrefs(null) })

const times = (d: string, tz = 0): PrayerDay['times'] => ({ fajr: `${d}T0${3 + tz}:00:00Z`, sunrise: `${d}T05:00:00Z`, dhuhr: `${d}T09:20:00Z`, asr: `${d}T12:42:00Z`, maghrib: `${d}T15:10:00Z`, isha: `${d}T16:40:00Z` })
const day = (date: string, windows: PrayerDay['windows'] = [], t = times(date)): PrayerDay => ({ date, ramadan: false, times: t, windows, iftar: null })
const win = (prayer: string, from: string, to: string, prayers?: string[]) => ({ prayer, prayers, starts_at: from, ends_at: to })
const at = (iso: string) => new Date(iso)
const t = (en: string) => en

describe('overlapOf', () => {
  const d = day('2027-02-03', [win('asr', '2027-02-03T12:32:00Z', '2027-02-03T13:02:00Z')])
  it('finds the prayer a booking sits on, with the prayer time', () => {
    const hit = overlapOf([d], at('2027-02-03T12:50:00Z'), at('2027-02-03T13:30:00Z'))
    expect(hit?.window.prayer).toBe('asr'); expect(hit?.time).toBe('2027-02-03T12:42:00Z')
  })
  it('does not count a booking that only touches the window as an overlap', () => {
    expect(overlapOf([d], at('2027-02-03T11:30:00Z'), at('2027-02-03T12:32:00Z'))).toBeNull()   // ends exactly when the window starts
    expect(overlapOf([d], at('2027-02-03T13:02:00Z'), at('2027-02-03T14:00:00Z'))).toBeNull()   // starts exactly when it ends
  })
  it('counts one minute inside as an overlap, and a booking that contains the whole window', () => {
    expect(overlapOf([d], at('2027-02-03T11:30:00Z'), at('2027-02-03T12:33:00Z'))).not.toBeNull()
    expect(overlapOf([d], at('2027-02-03T10:00:00Z'), at('2027-02-03T18:00:00Z'))).not.toBeNull()
  })
  it('names every prayer of a merged window and uses the first one for the time', () => {
    const merged = day('2027-02-03', [win('dhuhr', '2027-02-03T09:10:00Z', '2027-02-03T12:50:00Z', ['dhuhr', 'asr'])])
    const hit = overlapOf([merged], at('2027-02-03T12:40:00Z'), at('2027-02-03T13:10:00Z'))!
    expect(windowLabel(hit.window, t)).toBe('Dhuhr + Asr'); expect(hit.time).toBe('2027-02-03T09:20:00Z')
  })
  it('sees a window that crosses midnight from the day after, and from the day before', () => {
    const late = day('2027-06-20', [win('isha', '2027-06-20T23:40:00Z', '2027-06-21T00:20:00Z')])
    expect(overlapOf([late, day('2027-06-21')], at('2027-06-21T00:10:00Z'), at('2027-06-21T01:00:00Z'))).not.toBeNull()
    expect(overlapOf([late], at('2027-06-20T23:00:00Z'), at('2027-06-20T23:50:00Z'))).not.toBeNull()
    expect(overlapOf([late], at('2027-06-21T00:20:00Z'), at('2027-06-21T01:00:00Z'))).toBeNull()
  })
  it('finds nothing without windows (a polar day) or with an unreadable time', () => {
    expect(overlapOf([day('2027-06-21', [])], at('2027-06-21T10:00:00Z'), at('2027-06-21T11:00:00Z'))).toBeNull()
    expect(overlapOf([d], new Date('nope'), at('2027-02-03T12:50:00Z'))).toBeNull()
  })
})

describe('nextPrayer', () => {
  const days = [day('2027-02-03'), day('2027-02-04')]
  it('is the first prayer still to come, with the minutes left', () => {
    vi.setSystemTime(at('2027-02-03T11:30:00Z'))
    const next = nextPrayer(days, new Date())!
    expect(next.key).toBe('asr'); expect(next.minutes).toBe(72); expect(untilWords(next.minutes, t)).toBe('1 h 12 min')
  })
  it('skips sunrise, which is not a prayer', () => {
    vi.setSystemTime(at('2027-02-03T04:00:00Z'))
    expect(nextPrayer(days, new Date())!.key).toBe('dhuhr')
  })
  it('after Isha it is tomorrow’s Fajr', () => {
    vi.setSystemTime(at('2027-02-03T20:00:00Z'))
    const next = nextPrayer(days, new Date())!
    expect(next.key).toBe('fajr'); expect(next.at.toISOString()).toBe('2027-02-04T03:00:00.000Z')
  })
  it('is nothing on a polar day (all times null) and when no day is known', () => {
    const polar: PrayerDay['times'] = { fajr: null, sunrise: null, dhuhr: null, asr: null, maghrib: null, isha: null }
    vi.setSystemTime(at('2027-06-21T10:00:00Z'))
    expect(nextPrayer([day('2027-06-21', [], polar), day('2027-06-22', [], polar)], new Date())).toBeNull()
    expect(nextPrayer([], new Date())).toBeNull()
  })
  it('says a short wait in minutes only', () => { expect(untilWords(12, t)).toBe('12 min'); expect(untilWords(60, t)).toBe('1 h') })
})

describe('the city list and the method it suggests', () => {
  it('has about forty cities with real coordinates, each named in three languages', () => {
    expect(CITIES.length).toBeGreaterThanOrEqual(40)
    for (const c of CITIES) { expect(Math.abs(c.lat)).toBeLessThanOrEqual(90); expect(Math.abs(c.lng)).toBeLessThanOrEqual(180); expect(c.names.every(Boolean)).toBe(true) }
    expect(new Set(CITIES.map(c => c.id)).size).toBe(CITIES.length)
    const makkah = CITIES.find(c => c.id === 'makkah')!
    expect([makkah.lat, makkah.lng]).toEqual([21.4225, 39.8262])
  })
  it('suggests the usual method per country, the Muslim World League otherwise', () => {
    const method = (id: string) => methodForCountry(CITIES.find(c => c.id === id)!.country)
    expect(method('riyadh')).toBe('umm_al_qura'); expect(method('cairo')).toBe('egyptian'); expect(method('kuwait')).toBe('kuwait'); expect(method('doha')).toBe('qatar')
    expect(method('istanbul')).toBe('turkey'); expect(method('karachi')).toBe('karachi'); expect(method('dhaka')).toBe('karachi')
    expect(method('newyork')).toBe('north_america'); expect(method('toronto')).toBe('north_america')
    expect(method('amsterdam')).toBe('muslim_world_league'); expect(method('dubai')).toBe('muslim_world_league'); expect(method('sydney')).toBe('muslim_world_league')
  })
})

describe('coordinate validation', () => {
  it('accepts numbers in range, a comma and Arabic digits', () => {
    expect(parseCoord('21.4225', 90)).toEqual({ value: 21.4225, error: false }); expect(parseCoord('-33,8688', 90)).toEqual({ value: -33.8688, error: false })
    expect(parseCoord('٢١٫٤', 90)).toEqual({ value: 21.4, error: false }); expect(parseCoord('180', 180).value).toBe(180)
  })
  it('treats empty as "not yet" and everything else outside the range or not a number as an error', () => {
    expect(parseCoord('  ', 90)).toEqual({ value: null, error: false })
    for (const bad of ['91', '-90.5', 'abc', '12.', '1e3', '1.2.3', '--4']) expect(parseCoord(bad, 90), bad).toEqual({ value: null, error: true })
    expect(parseCoord('181', 180).error).toBe(true)
  })
})

describe('the prayer preferences the app keeps', () => {
  it('knows whether prayer times are on and the Ramadan work hours, and bumps rev only when something changes', () => {
    setPrayerPrefs({ prayer_enabled: true, ramadan_work_start: '09:00', ramadan_work_end: '14:00' })
    const first = prayerPrefs(); expect(first).toMatchObject({ enabled: true, workStart: '09:00', workEnd: '14:00' })
    setPrayerPrefs({ prayer_enabled: true, ramadan_work_start: '09:00', ramadan_work_end: '14:00' }); expect(prayerPrefs()).toBe(first)
    setPrayerPrefs({ prayer_enabled: true, ramadan_work_start: '09:00', ramadan_work_end: '14:00', prayer_method: 'egyptian' }); expect(prayerPrefs().rev).toBe(first.rev + 1)
    setPrayerPrefs(null); expect(prayerPrefs()).toMatchObject({ enabled: false, workStart: '10:00', workEnd: '15:00' })
  })
})
