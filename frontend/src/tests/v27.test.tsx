import { describe, it, expect, afterEach } from 'vitest'
import { accountDay, accountInstant, setAccountZone, shiftDay, weekdayOf } from '../lib/accountDay'
import { localDate } from '../lib/hooks'
import { mondayOf } from '../lib/dates'
import { dueFor } from '../lib/quickAdd'

afterEach(() => setAccountZone(undefined))

describe('today in the account timezone', () => {
  it('differs from the browser day near midnight, in both directions', () => {
    const instant = new Date('2027-01-06T23:30:00Z')
    setAccountZone('Pacific/Auckland')       // UTC+13: already the 7th
    expect(accountDay(instant)).toBe('2027-01-07')
    setAccountZone('America/Los_Angeles')    // UTC-8: still the evening of the 6th
    expect(accountDay(new Date('2027-01-06T03:00:00Z'))).toBe('2027-01-05')
    setAccountZone('UTC')
    expect(accountDay(instant)).toBe('2027-01-06')
  })

  it('falls back to the browser day when the zone is unknown or invalid', () => {
    const instant = new Date(2027, 0, 6, 12, 0)
    setAccountZone(undefined)
    expect(accountDay(instant)).toBe('2027-01-06')
    setAccountZone('Not/AZone')
    expect(accountDay(instant)).toBe('2027-01-06')
  })

  it('is what localDate() returns with no argument, while a given date keeps the browser day', () => {
    setAccountZone('Pacific/Kiritimati')     // UTC+14, the furthest ahead
    const now = new Date()
    expect(localDate()).toBe(accountDay(now))
    const given = new Date(2027, 5, 15, 12, 0)
    expect(localDate(given)).toBe('2027-06-15')
  })

  it('does calendar arithmetic on a day without any timezone', () => {
    expect(shiftDay('2027-03-28', 1)).toBe('2027-03-29')   // across a DST change in Europe
    expect(shiftDay('2027-01-01', -1)).toBe('2026-12-31')
    expect(weekdayOf('2027-03-10')).toBe(3)                 // Wednesday
  })

  it('finds the Monday of the account’s week', () => {
    expect(mondayOf(new Date(2027, 2, 10, 12))).toBe('2027-03-08')
    expect(mondayOf(new Date(2027, 2, 14, 12))).toBe('2027-03-08')
    expect(mondayOf(new Date(2027, 2, 15, 12))).toBe('2027-03-15')
  })
})

describe('quick add due dates in the account timezone', () => {
  it('puts 17:00 on the account’s wall clock, not the browser’s', () => {
    setAccountZone('Europe/Amsterdam')
    // 22:30 UTC on 9 March 2027 is 23:30 in Amsterdam: still the 9th there (UTC+1 in March, before DST).
    const now = new Date('2027-03-09T22:30:00Z')
    expect(dueFor('today', now)).toBe('2027-03-09T16:00:00.000Z')
    expect(dueFor('tomorrow', now)).toBe('2027-03-10T16:00:00.000Z')
  })

  it('uses the account’s day when it is already tomorrow there', () => {
    setAccountZone('Pacific/Auckland')
    // 23:30 UTC on 6 January is 12:30 on the 7th in Auckland (UTC+13 in summer).
    const now = new Date('2027-01-06T23:30:00Z')
    expect(dueFor('today', now)).toBe('2027-01-07T04:00:00.000Z')
    expect(dueFor('week', now)).toBe('2027-01-10T04:00:00.000Z')   // the 7th is a Thursday there, so this week ends on Sunday the 10th
  })

  it('ends “this week” on Sunday and stays on Sunday when it already is', () => {
    setAccountZone('UTC')
    expect(dueFor('week', new Date('2027-03-10T09:30:00Z'))).toBe('2027-03-14T17:00:00.000Z')
    expect(dueFor('week', new Date('2027-03-14T09:30:00Z'))).toBe('2027-03-14T17:00:00.000Z')
  })

  it('handles the daylight-saving change itself', () => {
    setAccountZone('Europe/Amsterdam')
    expect(accountInstant('2027-03-27', 17)).toBe('2027-03-27T16:00:00.000Z')   // CET, UTC+1
    expect(accountInstant('2027-03-29', 17)).toBe('2027-03-29T15:00:00.000Z')   // CEST, UTC+2
  })
})
