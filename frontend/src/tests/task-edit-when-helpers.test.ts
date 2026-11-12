import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { setAccountZone } from '../lib/accountDay'
import { DEFAULT_DEADLINE_TIME, deadlineField, deadlineInstant, deriveWhen, dueFor, dueKeepingTime, nextHalfHour, weekEndDay, whenField } from '../lib/quickAdd'

// The browser's zone (what the date fields use) is Amsterdam here, the usual case where it equals the account's; differing zones are tested apart.
const BROWSER_TZ = process.env.TZ
process.env.TZ = 'Europe/Amsterdam'
afterAll(() => { if (BROWSER_TZ === undefined) delete process.env.TZ; else process.env.TZ = BROWSER_TZ })
afterEach(() => setAccountZone(undefined))
const AMS = 'Europe/Amsterdam'
// Wednesday 2026-11-11, 11:00 in Amsterdam (CET, UTC+1).
const NOON = new Date('2026-11-11T10:00:00Z')
const at = (local: string, zone = AMS) => { setAccountZone(zone); return new Date(deadlineInstant(local)!) }

describe('the deadline field is the browser wall clock, as the pickers always stored it', () => {
  it('round-trips an instant through the browser zone (Amsterdam here), whatever the account zone is', () => {
    expect(deadlineField('2026-11-11T16:00:00Z')).toBe('2026-11-11T17:00')
    expect(deadlineInstant('2026-11-11T17:00')).toBe('2026-11-11T16:00:00.000Z')
    expect(deadlineField('2026-11-11T23:30:00Z')).toBe('2026-11-12T00:30')   // the UTC day is the 11th, the browser day the 12th
    setAccountZone('America/New_York')
    expect(deadlineField('2026-11-11T22:00:00Z')).toBe('2026-11-11T23:00')   // unchanged by the account zone
    expect(deadlineInstant('2026-11-11T23:00')).toBe('2026-11-11T22:00:00.000Z')
  })
  it('knows nothing for empty or invalid values', () => {
    expect(deadlineField(null)).toBe(''); expect(deadlineField('nope')).toBe('')
    expect(deadlineInstant('')).toBeNull(); expect(deadlineInstant('soon')).toBeNull()
  })
  it('keeps the wall time on the spring and autumn clock-change days', () => {
    expect(deadlineField(deadlineInstant('2026-03-29T17:00'))).toBe('2026-03-29T17:00')   // CEST, UTC+2
    expect(deadlineInstant('2026-03-29T17:00')).toBe('2026-03-29T15:00:00.000Z')
    expect(deadlineInstant('2026-10-25T17:00')).toBe('2026-10-25T16:00:00.000Z')          // CET again
    expect(deadlineField('2026-10-25T00:30:00Z')).toBe('2026-10-25T02:30')                // the repeated hour
  })
})

describe('which "When" choice a deadline is (priority: none, today, tomorrow, week)', () => {
  // now = Wednesday 2026-11-11, Amsterdam. Sunday 2026-11-15 is the end of the week.
  const table: [string, string, string][] = [
    ['empty', '', 'none'],
    ['today morning', '2026-11-11T09:00', 'today'],
    ['today 00:00', '2026-11-11T00:00', 'today'],
    ['today 23:59', '2026-11-11T23:59', 'today'],
    ['tomorrow', '2026-11-12T17:00', 'tomorrow'],
    ['tomorrow 00:00', '2026-11-12T00:00', 'tomorrow'],
    ['Thursday 13th (not a tile)', '2026-11-13T17:00', 'custom'],
    ['Sunday the 15th', '2026-11-15T17:00', 'week'],
    ['the Wednesday after (custom)', '2026-11-18T17:00', 'custom'],
    ['yesterday (custom)', '2026-11-10T17:00', 'custom'],
  ]
  it.each(table)('%s', (_name, field, expected) => { setAccountZone(AMS); expect(deriveWhen(field, NOON)).toBe(expected) })

  it('uses the account day, not the UTC day, near midnight', () => {
    // 23:30 Amsterdam on the 11th is 22:30 UTC the 11th; 00:30 Amsterdam on the 12th is 23:30 UTC on the 11th.
    setAccountZone(AMS)
    const lateEvening = new Date('2026-11-11T22:30:00Z'), afterMidnight = new Date('2026-11-11T23:30:00Z')
    expect(deriveWhen(deadlineField('2026-11-11T23:30:00Z'), lateEvening)).toBe('tomorrow')   // 00:30 on the 12th
    expect(deriveWhen('2026-11-12T00:30', afterMidnight)).toBe('today')
    expect(deriveWhen('2026-11-11T23:59', afterMidnight)).toBe('custom')   // yesterday by then
  })
  it('on a Sunday "this week" is today, and on a Saturday it is tomorrow', () => {
    setAccountZone(AMS)
    expect(deriveWhen('2026-11-15T10:00', new Date('2026-11-15T08:00:00Z'))).toBe('today')
    expect(deriveWhen('2026-11-15T10:00', new Date('2026-11-14T08:00:00Z'))).toBe('tomorrow')
    expect(deriveWhen('2026-11-15T10:00', new Date('2026-11-13T08:00:00Z'))).toBe('week')
    expect(weekEndDay('2026-11-15')).toBe('2026-11-15'); expect(weekEndDay('2026-11-16')).toBe('2026-11-22')
  })
  it('is right across the clock changes and in other zones', () => {
    setAccountZone(AMS)
    expect(deriveWhen('2026-03-30T08:00', new Date('2026-03-28T23:30:00Z'))).toBe('tomorrow')   // 00:30 CET on the 29th, a 23-hour day
    expect(deriveWhen('2026-03-29T08:00', new Date('2026-03-28T23:30:00Z'))).toBe('today')
    expect(deriveWhen('2026-10-26T08:00', new Date('2026-10-24T22:30:00Z'))).toBe('tomorrow')   // 00:30 CEST on the 25th, a 25-hour day
    setAccountZone('Asia/Tokyo')
    expect(deriveWhen('2026-11-12T08:00', new Date('2026-11-11T16:00:00Z'))).toBe('today')       // already the 12th in Tokyo
    setAccountZone('America/Los_Angeles')
    expect(deriveWhen('2026-11-10T20:00', new Date('2026-11-11T05:00:00Z'))).toBe('today')       // the 10th in Los Angeles
  })
})

describe('tapping a "When" tile moves the day and keeps the time', () => {
  it('keeps the time already chosen for today, tomorrow and this week', () => {
    setAccountZone(AMS)
    expect(whenField('today', '2026-11-20T09:15', NOON)).toBe('2026-11-11T09:15')
    expect(whenField('tomorrow', '2026-11-11T08:00', NOON)).toBe('2026-11-12T08:00')
    expect(whenField('week', '2026-11-11T13:45', NOON)).toBe('2026-11-15T13:45')
    expect(whenField('nextweek', '2026-11-11T13:45', NOON)).toBe('2026-11-16T13:45')
    expect(whenField('today', '2026-11-20T23:00', NOON)).toBe('2026-11-11T23:00')   // a time the user chose is theirs, even 23:00
  })
  it('clears the date for "No date"', () => { expect(whenField('none', '2026-11-11T09:15', NOON)).toBe('') })
  it('with no time yet uses the visible default 17:00', () => {
    setAccountZone(AMS)
    expect(whenField('today', '', NOON)).toBe(`2026-11-11T${DEFAULT_DEADLINE_TIME}`)
    expect(whenField('tomorrow', '', NOON)).toBe('2026-11-12T17:00')
    expect(whenField('week', '', NOON)).toBe('2026-11-15T17:00')
  })
  it('uses the next half hour when 17:00 has already passed today (never a hidden 23:00)', () => {
    setAccountZone(AMS)
    expect(whenField('today', '', new Date('2026-11-11T16:10:00Z'))).toBe('2026-11-11T17:30')   // 17:10 local
    expect(whenField('today', '', new Date('2026-11-11T16:00:00Z'))).toBe('2026-11-11T17:30')   // exactly 17:00 has passed
    expect(whenField('today', '', new Date('2026-11-11T20:45:00Z'))).toBe('2026-11-11T22:00')   // 21:45 local
    expect(whenField('tomorrow', '', new Date('2026-11-11T20:45:00Z'))).toBe('2026-11-12T17:00')  // only today is bumped
  })
  it('near midnight: from 23:30 the next half hour would be tomorrow, so it is a visible 23:59 today', () => {
    setAccountZone(AMS)
    expect(nextHalfHour(new Date('2026-11-11T22:29:00Z'))).toBe('23:30')   // 23:29 local
    expect(nextHalfHour(new Date('2026-11-11T22:30:00Z'))).toBe('23:59')
    expect(whenField('today', '', new Date('2026-11-11T22:50:00Z'))).toBe('2026-11-11T23:59')
    // 00:10 on the 12th in Amsterdam is still the 11th in UTC: "today" is the account's 12th.
    expect(whenField('today', '', new Date('2026-11-11T23:10:00Z'))).toBe('2026-11-12T17:00')
  })
  it('a date picked by hand then a tile gives back the same wall time on the clock-change days', () => {
    setAccountZone(AMS)
    expect(whenField('today', '2026-11-01T02:30', new Date('2026-10-25T08:00:00Z'))).toBe('2026-10-25T02:30')   // field space: no instant maths
    expect(whenField('tomorrow', '2026-11-01T09:00', new Date('2026-03-28T10:00:00Z'))).toBe('2026-03-29T09:00')
  })
  it('dueKeepingTime moves a saved deadline to the chosen day at the same account time', () => {
    setAccountZone(AMS)
    expect(dueKeepingTime('tomorrow', '2026-11-20T08:30:00Z', NOON)).toBe('2026-11-12T08:30:00.000Z')   // 09:30 local stays 09:30
    expect(dueKeepingTime('none', '2026-11-20T08:30:00Z', NOON)).toBeNull()
    expect(dueKeepingTime('today', null, NOON)).toBe('2026-11-11T16:00:00.000Z')   // 17:00 local
  })
})

describe('when the browser zone and the account zone differ', () => {
  it('the day comes from the account calendar, the time from the field, and the tile follows the account day of the typed moment', () => {
    setAccountZone('Pacific/Auckland')   // browser: Amsterdam. NOW is 23:00 on the 11th in Auckland.
    expect(whenField('today', '2026-11-20T09:30', NOON)).toBe('2026-11-11T09:30')
    // 13:00 Amsterdam on the 11th is 01:00 on the 12th in Auckland: the account's tomorrow, although the field shows the 11th.
    expect(deriveWhen('2026-11-11T13:00', NOON)).toBe('tomorrow')
    expect(deriveWhen('2026-11-11T10:00', NOON)).toBe('today')   // 22:00 on the 11th in Auckland
  })
})

describe('dueKeepingTime (the list chips and the swipe snooze) uses the ACCOUNT zone for both the day and the time of day', () => {
  // Cases where the browser zone differs from the account zone. The old code read the time on the browser clock and the day on the account calendar.
  const run = (browser: string, account: string, when: Parameters<typeof dueKeepingTime>[0], due: string | null, now: string) => {
    process.env.TZ = browser; setAccountZone(account)
    try { return dueKeepingTime(when, due, new Date(now)) } finally { process.env.TZ = 'Europe/Amsterdam' }
  }
  const table: [string, string, string, Parameters<typeof dueKeepingTime>[0], string | null, string, string | null][] = [
    ['CI case: browser UTC, account Amsterdam, due in one hour across the account midnight', 'UTC', AMS, 'tomorrow', '2026-11-11T23:09:00Z', '2026-11-11T22:09:00Z', '2026-11-11T23:09:00.000Z'],
    ['browser Amsterdam, account UTC, 00:30 local is 23:30 UTC', AMS, 'UTC', 'tomorrow', '2026-11-11T23:30:00Z', '2026-11-11T10:00:00Z', '2026-11-12T23:30:00.000Z'],
    ['browser Auckland, account New York (the browser day is ahead)', 'Pacific/Auckland', 'America/New_York', 'tomorrow', '2026-11-11T20:00:00Z', '2026-11-11T15:00:00Z', '2026-11-12T20:00:00.000Z'],
    ['browser New York, account Auckland (the browser day is behind)', 'America/New_York', 'Pacific/Auckland', 'tomorrow', '2026-11-11T20:00:00Z', '2026-11-11T15:00:00Z', '2026-11-12T20:00:00.000Z'],
    ['spring change 2026-03-29, browser UTC', 'UTC', AMS, 'tomorrow', '2026-03-20T09:30:00Z', '2026-03-28T10:00:00Z', '2026-03-29T08:30:00.000Z'],
    ['autumn change 2026-10-25, browser UTC', 'UTC', AMS, 'tomorrow', '2026-10-20T08:30:00Z', '2026-10-24T10:00:00Z', '2026-10-25T09:30:00.000Z'],
    ['this week keeps the account clock time', 'UTC', AMS, 'week', '2026-11-11T23:30:00Z', '2026-11-11T10:00:00Z', '2026-11-14T23:30:00.000Z'],
    ['no deadline yet: 17:00 account time', 'UTC', AMS, 'tomorrow', null, '2026-11-11T10:00:00Z', '2026-11-12T16:00:00.000Z'],
    ['no deadline, today, 17:00 passed in the account zone: next half hour there (17:10 -> 17:30)', 'UTC', AMS, 'today', null, '2026-11-11T16:10:00Z', '2026-11-11T16:30:00.000Z'],
    ['no deadline, today, still before 17:00 there', 'UTC', AMS, 'today', null, '2026-11-11T14:00:00Z', '2026-11-11T16:00:00.000Z'],
    ['no date clears', 'UTC', AMS, 'none', '2026-11-11T14:00:00Z', '2026-11-11T14:00:00Z', null],
  ]
  it.each(table)('%s', (_n, browser, account, when, due, now, expected) => { expect(run(browser, account, when, due, now)).toBe(expected) })
})

describe('dueFor (quick add, dictation) is unchanged', () => {
  it('still answers 17:00, 23:00 once 17:00 has passed, Sunday for the week', () => {
    setAccountZone(AMS)
    expect(dueFor('today', NOON)).toBe('2026-11-11T16:00:00.000Z')
    expect(dueFor('today', new Date('2026-11-11T18:00:00Z'))).toBe('2026-11-11T22:00:00.000Z')
    expect(dueFor('week', NOON)).toBe('2026-11-15T16:00:00.000Z')
    expect(dueFor('none', NOON)).toBeNull()
    expect(at('2026-11-11T17:00').toISOString()).toBe(dueFor('today', NOON))
  })
})
