import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { setAccountZone } from '../lib/accountDay'
import { deadlineField, deadlineInstant, deriveWhen, nextHalfHour, whenField } from '../lib/quickAdd'
import { useSessionFields } from '../features/tasks/sessionFields'
import { typedTimesShifted } from '../lib/zoneShift'
import { LanguageProvider } from '../contexts/LanguageContext'
import type { ReactNode } from 'react'

/**
 * Typed times mean the ACCOUNT's timezone, not the browser's. Every case below runs with the browser in a zone that differs from
 * the account zone (Europe/Amsterdam), because on a laptop that happens to be in Amsterdam the old browser-local code gave the same answers.
 */
const BROWSER_TZ = process.env.TZ
afterAll(() => { if (BROWSER_TZ === undefined) delete process.env.TZ; else process.env.TZ = BROWSER_TZ })
afterEach(() => setAccountZone(undefined))
const AMS = 'Europe/Amsterdam'
const BROWSERS = ['UTC', 'America/New_York', 'Asia/Riyadh', 'Pacific/Auckland']
/** Run `fn` with the browser in `browser`, the account in `account`. */
const within = <T,>(browser: string, account: string, fn: () => T): T => { process.env.TZ = browser; setAccountZone(account); return fn() }

describe.each(BROWSERS)('browser in %s, account in Amsterdam', browser => {
  it('shows an instant on the account clock and reads a typed time as account time', () => within(browser, AMS, () => {
    expect(deadlineField('2026-11-11T16:00:00Z')).toBe('2026-11-11T17:00')       // CET, UTC+1
    expect(deadlineInstant('2026-11-11T17:00')).toBe('2026-11-11T16:00:00.000Z')
    expect(deadlineField('2026-07-01T07:30:00Z')).toBe('2026-07-01T09:30')       // CEST, UTC+2
    expect(deadlineInstant('2026-07-01T09:30')).toBe('2026-07-01T07:30:00.000Z')
    expect(deadlineField('2026-11-11T23:30:00Z')).toBe('2026-11-12T00:30')       // the account's day is the 12th
  }))
  it('a typed time always comes back unchanged (round trip), across a year of days', () => within(browser, AMS, () => {
    const days = [...Array.from({ length: 53 }, (_, week) => new Date(Date.UTC(2026, 0, 1 + week * 7)).toISOString().slice(0, 10)), '2026-03-29', '2026-10-25']
    for (const date of days) for (const time of ['00:00', '01:59', '03:00', '09:00', '12:34', '17:00', '23:59']) {
      const field = `${date}T${time}`
      expect(deadlineField(deadlineInstant(field)), field).toBe(field)
    }
  }))
  it('keeps the wall time on the spring change (2026-03-29) and the autumn change (2026-10-25)', () => within(browser, AMS, () => {
    expect(deadlineInstant('2026-03-29T01:59')).toBe('2026-03-29T00:59:00.000Z')   // CET
    expect(deadlineInstant('2026-03-29T03:00')).toBe('2026-03-29T01:00:00.000Z')   // CEST: 03:00 follows 01:59 by one minute (02:xx does not exist)
    expect(deadlineInstant('2026-03-29T17:00')).toBe('2026-03-29T15:00:00.000Z')
    expect(deadlineInstant('2026-03-28T17:00')).toBe('2026-03-28T16:00:00.000Z')   // the day before is still CET
    expect(deadlineInstant('2026-10-25T17:00')).toBe('2026-10-25T16:00:00.000Z')
    expect(deadlineInstant('2026-10-24T17:00')).toBe('2026-10-24T15:00:00.000Z')   // the day before is still CEST
    expect(deadlineInstant('2026-10-25T03:00')).toBe('2026-10-25T02:00:00.000Z')
  }))
  it('a time the clock skips moves forward; a time it repeats means the first one', () => within(browser, AMS, () => {
    expect(deadlineInstant('2026-03-29T02:30')).toBe('2026-03-29T01:30:00.000Z')   // 02:30 does not exist: it is 03:30 CEST
    expect(deadlineField('2026-03-29T01:30:00Z')).toBe('2026-03-29T03:30')
    expect(deadlineInstant('2026-10-25T02:30')).toBe('2026-10-25T00:30:00.000Z')   // 02:30 happens twice: the first (CEST)
    expect(deadlineField('2026-10-25T00:30:00Z')).toBe('2026-10-25T02:30')
    expect(deadlineField('2026-10-25T01:30:00Z')).toBe('2026-10-25T02:30')         // the second 02:30 (CET) reads the same
  }))
  it('rejects a day, hour or minute that does not exist', () => within(browser, AMS, () => {
    expect(deadlineInstant('2026-02-31T10:00')).toBeNull(); expect(deadlineInstant('2026-13-01T10:00')).toBeNull()
    expect(deadlineInstant('2026-11-11T24:00')).toBeNull(); expect(deadlineInstant('2026-11-11T10:60')).toBeNull()
    expect(deadlineInstant('2026-11-11')).toBe('2026-11-11T16:00:00.000Z')          // a date alone: the default 17:00 account time
  }))
  it('the tile and the "17:00 has passed" rule use the account clock', () => within(browser, AMS, () => {
    // 17:10 in Amsterdam is 16:10 UTC: the browser clock (UTC) would still say "before 17:00".
    expect(whenField('today', '', new Date('2026-11-11T16:10:00Z'))).toBe('2026-11-11T17:30')
    expect(nextHalfHour(new Date('2026-11-11T16:10:00Z'), AMS)).toBe('17:30')
    expect(whenField('today', '', new Date('2026-11-11T15:30:00Z'))).toBe('2026-11-11T17:00')   // 16:30 in Amsterdam
    // A deadline typed as 00:30 on the 12th (Amsterdam) is tomorrow there, whatever the browser's day.
    expect(deriveWhen('2026-11-12T00:30', new Date('2026-11-11T20:00:00Z'))).toBe('tomorrow')
    expect(deriveWhen('2026-11-11T23:30', new Date('2026-11-11T20:00:00Z'))).toBe('today')
  }))
})

describe('the scheduled start and end fields (browser in New York, account in Amsterdam)', () => {
  const schedule = { session_id: 55, starts_at: '2026-11-12T08:00:00Z', ends_at: '2026-11-12T08:30:00Z', sessions: 1, split: false }
  const hook = (task: Record<string, unknown>, estimate = 45) => renderHook(() => useSessionFields({ id: 7, ...task }, estimate), { wrapper: ({ children }: { children: ReactNode }) => <LanguageProvider>{children}</LanguageProvider> })
  it('shows a saved session as the 09:00 to 09:30 the list badge and the calendar show', () => within('America/New_York', AMS, () => {
    const { result } = hook({ schedule })
    expect(result.current.start).toBe('2026-11-12T09:00'); expect(result.current.end).toBe('2026-11-12T09:30')
    expect(result.current.plan()).toBeNull()   // untouched: nothing to save
  }))
  it('typing a start books it on the account clock, the end follows by the estimate, and moving never invents a deadline', () => within('America/New_York', AMS, () => {
    const { result } = hook({ schedule: null })
    act(() => result.current.changeStart('2026-11-13T09:00'))
    expect(result.current.end).toBe('2026-11-13T09:45')
    expect(result.current.plan()).toEqual({ slot: { starts_at: '2026-11-13T08:00:00.000Z', ends_at: '2026-11-13T08:45:00.000Z' } })
    const moved = hook({ schedule })
    act(() => moved.result.current.changeStart('2026-11-12T10:00'))
    expect(moved.result.current.end).toBe('2026-11-12T10:30')
    expect(moved.result.current.plan()).toEqual({ slot: { starts_at: '2026-11-12T09:00:00.000Z', ends_at: '2026-11-12T09:30:00.000Z' } })
  }))
  it('keeps the length across the spring change when the start moves over it', () => within('Asia/Riyadh', AMS, () => {
    const { result } = hook({ schedule: null }, 60)
    act(() => result.current.changeStart('2026-03-29T01:30'))   // 00:30Z
    expect(result.current.plan()).toEqual({ slot: { starts_at: '2026-03-29T00:30:00.000Z', ends_at: '2026-03-29T01:30:00.000Z' } })
    expect(result.current.end).toBe('2026-03-29T03:30')         // one hour later is 03:30 on the wall clock: 02:xx does not exist
  }))
})

describe('the zone note', () => {
  it('is wanted only when the browser clock reads differently from the account clock', () => {
    process.env.TZ = 'UTC'; setAccountZone(AMS); expect(typedTimesShifted()).toBe(true)
    process.env.TZ = AMS; expect(typedTimesShifted()).toBe(false)
    process.env.TZ = 'Europe/Berlin'; expect(typedTimesShifted()).toBe(false)   // same offsets all year: nothing to say
    setAccountZone(undefined); process.env.TZ = 'UTC'; expect(typedTimesShifted()).toBe(false)
  })
})
