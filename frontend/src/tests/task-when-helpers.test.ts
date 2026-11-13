import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { setAccountZone } from '../lib/accountDay'
import { bookingOf, choiceOf, defaultWhen, dayLabel, lengthOf, sessionDraft, settledStart, validMinutes, whenFor } from '../lib/taskWhen'

const AMS = 'Europe/Amsterdam'
afterEach(() => setAccountZone(undefined))

describe('the day choice', () => {
  it('maps a day to today, tomorrow, a picked date or none on the ACCOUNT calendar', () => {
    setAccountZone(AMS)
    const now = new Date('2026-11-11T23:30:00Z')   // already the 12th in Amsterdam
    expect(choiceOf('2026-11-12', now)).toBe('today'); expect(choiceOf('2026-11-13', now)).toBe('tomorrow')
    expect(choiceOf('2026-11-19', now)).toBe('custom'); expect(choiceOf('', now)).toBe('none')
  })
  it('the first start is the next half hour today and 09:00 on any other day; a chosen time that has passed today moves forward', () => {
    setAccountZone(AMS)
    const now = new Date('2026-11-11T10:10:00Z')   // 11:10
    expect(defaultWhen('2026-11-11', now)).toEqual({ day: '2026-11-11', start: '11:30' }); expect(defaultWhen('2026-11-12', now)).toEqual({ day: '2026-11-12', start: '09:00' })
    expect(whenFor('2026-11-11', '09:00', now)).toEqual({ day: '2026-11-11', start: '11:30' }); expect(whenFor('2026-11-11', '15:00', now).start).toBe('15:00'); expect(whenFor('2026-11-12', '07:15', now).start).toBe('07:15')
  })
  it('with no half hour left today, "today" rolls to tomorrow 09:00 instead of 23:59', () => {
    setAccountZone(AMS)
    const late = new Date('2026-11-11T22:40:00Z')   // 23:40
    expect(defaultWhen('2026-11-11', late)).toEqual({ day: '2026-11-12', start: '09:00' })
    expect(whenFor('2026-11-11', '23:00', late)).toEqual({ day: '2026-11-12', start: '09:00' })
  })
})

describe.each(['UTC', 'America/New_York', 'Pacific/Auckland'])('browser in %s, account in Amsterdam', browser => {
  const BROWSER = process.env.TZ
  beforeEach(() => { process.env.TZ = browser; setAccountZone(AMS) })
  afterEach(() => { if (BROWSER === undefined) delete process.env.TZ; else process.env.TZ = BROWSER })
  it('"today" and the next half hour are the ACCOUNT\'s, whatever the device clock says', () => {
    const now = new Date('2026-11-11T23:10:00Z')   // 00:10 on the 12th in Amsterdam
    expect(choiceOf('2026-11-12', now)).toBe('today'); expect(defaultWhen('2026-11-12', now)).toEqual({ day: '2026-11-12', start: '00:30' })
    expect(whenFor('2026-11-12', '00:00', now).start).toBe('00:30')
  })
  it('a start is the account\'s wall time: 09:00 is 08:00Z, its end follows, and the clock-skipped 02:30 is settled to 03:30', () => {
    expect(bookingOf('2026-11-12', '09:00', 30)).toMatchObject({ starts_at: '2026-11-12T08:00:00.000Z', endTime: '09:30' })
    expect(settledStart('2026-03-29', '02:30')).toBe('03:30'); expect(settledStart('2026-03-29', '01:30')).toBe('01:30')
  })
  it('the saved instant of an unmoved start wins (the second 02:30 of the autumn day): the end is not an hour off', () => {
    expect(bookingOf('2026-10-25', '02:30', 60)).toMatchObject({ endTime: '02:30' })                                  // first 02:30 + 60 min
    expect(bookingOf('2026-10-25', '02:30', 60, '2026-10-25T01:30:00.000Z')).toMatchObject({ starts_at: '2026-10-25T01:30:00.000Z', endTime: '03:30' })   // second 02:30 + 60 min
  })
})

describe('the booking: start, length, computed end', () => {
  it('turns a day and a start into the account-zone instant, and the end is start + length', () => {
    setAccountZone(AMS)
    expect(bookingOf('2026-11-12', '09:00', 15)).toEqual({ starts_at: '2026-11-12T08:00:00.000Z', ends_at: '2026-11-12T08:15:00.000Z', endDay: '2026-11-12', endTime: '09:15' })
  })
  it('passing midnight gives the next day as the end day', () => {
    setAccountZone(AMS)
    expect(bookingOf('2026-11-12', '23:50', 30)).toMatchObject({ endDay: '2026-11-13', endTime: '00:20' })
  })
  it('on the spring day (2026-03-29) the end is real elapsed time: 01:45 + 30 min is 03:15', () => {
    setAccountZone(AMS)
    expect(bookingOf('2026-03-29', '01:45', 30)).toMatchObject({ starts_at: '2026-03-29T00:45:00.000Z', endTime: '03:15' })
  })
  it('on the autumn day (2026-10-25) 02:30 is the first one and the hour repeats', () => {
    setAccountZone(AMS)
    const b = bookingOf('2026-10-25', '02:30', 60)!
    expect(b.starts_at).toBe('2026-10-25T00:30:00.000Z'); expect(b.endTime).toBe('02:30')   // 01:30Z is the second 02:30
  })
  it('is null for anything that is not a valid time or length (the minimum is 5 minutes)', () => {
    expect(bookingOf('', '09:00', 15)).toBeNull(); expect(bookingOf('2026-11-12', '', 15)).toBeNull(); expect(bookingOf('2026-11-12', '09:00', 4)).toBeNull(); expect(bookingOf('2026-11-12', '09:00', NaN)).toBeNull()
    expect(validMinutes(5)).toBe(true); expect(validMinutes(4)).toBe(false); expect(validMinutes(10081)).toBe(false)
  })
})

describe('a saved session as the fields show it', () => {
  it('has its day, start and length (duration comes from the session, not the estimate)', () => {
    setAccountZone(AMS)
    const s = { session_id: 1, starts_at: '2026-11-12T08:00:00Z', ends_at: '2026-11-12T09:30:00Z', sessions: 1, split: false }
    expect(sessionDraft(s)).toEqual({ day: '2026-11-12', start: '09:00', minutes: 90 }); expect(lengthOf(s.starts_at, s.ends_at)).toBe(90)
  })
  it('names a day in words, with the year only when it is not this year', () => {
    expect(dayLabel('2026-11-19', 'en', '2026')).toBe('Thursday, November 19'); expect(dayLabel('2027-01-02', 'en', '2026')).toContain('2027')
    expect(dayLabel('2026-11-19', 'ar', '2026')).toContain('19')
  })
})
