import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { offsetMinutes, setAccountZone, wallClockToInstant } from '../lib/accountDay'
import { makeShift, zonesDiffer } from '../lib/zoneShift'
import { movePreview, minutesInto } from '../lib/calendar'

afterEach(() => setAccountZone(undefined))

describe('wall clock in another timezone', () => {
  it('finds the instant a wall clock reads in a zone, across daylight saving', () => {
    // Amsterdam is UTC+1 in winter, UTC+2 in summer.
    expect(wallClockToInstant(2027, 1, 6, 9, 30, 0, 'Europe/Amsterdam').toISOString()).toBe('2027-01-06T08:30:00.000Z')
    expect(wallClockToInstant(2027, 7, 6, 9, 30, 0, 'Europe/Amsterdam').toISOString()).toBe('2027-07-06T07:30:00.000Z')
    // Zones ahead of and behind UTC, and one with a half-hour offset.
    expect(wallClockToInstant(2027, 1, 6, 9, 0, 0, 'Pacific/Auckland').toISOString()).toBe('2027-01-05T20:00:00.000Z')
    expect(wallClockToInstant(2027, 1, 6, 9, 0, 0, 'America/Los_Angeles').toISOString()).toBe('2027-01-06T17:00:00.000Z')
    expect(wallClockToInstant(2027, 1, 6, 9, 0, 0, 'Asia/Kolkata').toISOString()).toBe('2027-01-06T03:30:00.000Z')
  })

  it('measures a zone’s offset at an instant', () => {
    expect(offsetMinutes(new Date('2027-01-06T12:00:00Z'), 'Europe/Amsterdam')).toBe(60)
    expect(offsetMinutes(new Date('2027-07-06T12:00:00Z'), 'Europe/Amsterdam')).toBe(120)
    expect(offsetMinutes(new Date('2027-01-06T12:00:00Z'), 'Asia/Kolkata')).toBe(330)
  })
})

describe('shifting the calendar into a zone', () => {
  it('does nothing without a zone', () => {
    const shift = makeShift(undefined)
    expect(shift.toView('2027-01-06T08:30:00.000Z')).toBe('2027-01-06T08:30:00.000Z')
    expect(shift.toReal('2027-01-06T08:30:00.000Z')).toBe('2027-01-06T08:30:00.000Z')
  })

  it('draws an instant with the wall clock of the chosen zone, whatever the browser’s zone is', () => {
    const shift = makeShift('Pacific/Auckland')   // UTC+13 in January
    const drawn = shift.viewDate(new Date('2027-01-06T20:00:00Z'))
    // 20:00 UTC is 09:00 on the 7th in Auckland: the drawn Date reads that in the browser's own wall clock.
    expect([drawn.getFullYear(), drawn.getMonth() + 1, drawn.getDate(), drawn.getHours(), drawn.getMinutes()]).toEqual([2027, 1, 7, 9, 0])
  })

  it('converts back exactly, for any hour of the day', () => {
    const shift = makeShift('America/Los_Angeles')
    for (const iso of ['2027-01-06T00:00:00.000Z', '2027-01-06T07:15:00.000Z', '2027-06-30T23:45:00.000Z', '2027-03-14T10:00:00.000Z']) {
      expect(shift.toReal(shift.toView(iso))).toBe(iso)
    }
  })

  it('keeps grid arithmetic right: a block dragged 30 minutes lands 30 minutes later in real time', () => {
    const shift = makeShift('Europe/Amsterdam')
    const start = shift.viewDate(new Date('2027-01-06T08:00:00Z')), end = shift.viewDate(new Date('2027-01-06T09:00:00Z'))
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate())
    expect(minutesInto(day, start)).toBe(9 * 60)                       // 09:00 in Amsterdam
    const moved = movePreview(start, end, day, day, 30)
    expect(shift.realDate(moved.start).toISOString()).toBe('2027-01-06T08:30:00.000Z')
    expect(shift.realDate(moved.end).toISOString()).toBe('2027-01-06T09:30:00.000Z')
  })

  it('stays right across the spring daylight-saving change', () => {
    const shift = makeShift('Europe/Amsterdam')
    // 2027-03-28 02:00 CET becomes 03:00 CEST: the 09:00 wall clock after it is one hour earlier in UTC than before.
    expect(shift.toReal(shift.toView('2027-03-27T08:00:00.000Z'))).toBe('2027-03-27T08:00:00.000Z')
    expect(shift.toReal(shift.toView('2027-03-29T07:00:00.000Z'))).toBe('2027-03-29T07:00:00.000Z')
    const drawn = shift.viewDate(new Date('2027-03-29T07:00:00Z'))
    expect(drawn.getHours()).toBe(9)
  })
})

describe('when the calendar offers a choice of zone', () => {
  beforeEach(() => setAccountZone(undefined))

  it('only when the account’s zone and the device’s really differ', () => {
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(zonesDiffer(undefined)).toBe(false)
    expect(zonesDiffer(browser)).toBe(false)
    // A zone a day ahead of anywhere always differs.
    expect(zonesDiffer(browser === 'Pacific/Kiritimati' ? 'Pacific/Pago_Pago' : 'Pacific/Kiritimati')).toBe(true)
  })
})
