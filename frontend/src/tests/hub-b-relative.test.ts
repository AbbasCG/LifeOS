import { describe, expect, it } from 'vitest'
import { relativeTime } from '../lib/relativeTime'

const NOW = Date.parse('2027-03-22T12:00:00Z')
const at = (ms: number) => new Date(NOW + ms).toISOString()
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR

describe('relativeTime', () => {
  it('never invents a time: no date or an unreadable one gives nothing', () => {
    expect(relativeTime(null, 'en', NOW)).toBeNull()
    expect(relativeTime(undefined, 'en', NOW)).toBeNull()
    expect(relativeTime('', 'en', NOW)).toBeNull()
    expect(relativeTime('not a date', 'en', NOW)).toBeNull()
  })
  it('says "just now" under a minute, in each language, whichever side of now', () => {
    expect(relativeTime(at(-20_000), 'en', NOW)).toMatchObject({ kind: 'now', text: 'just now', future: false })
    expect(relativeTime(at(-20_000), 'nl', NOW)?.text).toBe('zojuist')
    expect(relativeTime(at(-20_000), 'ar', NOW)?.text).toBe('قبل لحظات')
    expect(relativeTime(at(20_000), 'en', NOW)).toMatchObject({ kind: 'now', future: true })
  })
  it('counts minutes, hours and days with the language’s own words', () => {
    expect(relativeTime(at(-3 * MIN - 5000), 'en', NOW)).toMatchObject({ kind: 'relative', text: '3 minutes ago' })
    expect(relativeTime(at(-2 * HOUR - MIN), 'en', NOW)?.text).toBe('2 hours ago')
    expect(relativeTime(at(-DAY - HOUR), 'en', NOW)?.text).toBe('yesterday')
    expect(relativeTime(at(-3 * DAY), 'en', NOW)?.text).toBe('3 days ago')
    expect(relativeTime(at(-3 * MIN - 5000), 'nl', NOW)?.text).toBe('3 minuten geleden')
    expect(relativeTime(at(-3 * MIN - 5000), 'ar', NOW)?.text).toBe(new Intl.RelativeTimeFormat('ar', { numeric: 'auto' }).format(-3, 'minute'))
  })
  it('reads a future retry time as "in N minutes"', () => {
    expect(relativeTime(at(7 * MIN - 1000), 'en', NOW)).toMatchObject({ kind: 'relative', future: true, text: 'in 7 minutes' })
    expect(relativeTime(at(7 * MIN - 1000), 'nl', NOW)?.text).toBe('over 7 minuten')
  })
  it('falls back to a localized date after a week', () => {
    const r = relativeTime(at(-10 * DAY), 'en', NOW)
    expect(r).toMatchObject({ kind: 'date' })
    expect(r?.text).toBe(new Date(NOW - 10 * DAY).toLocaleDateString('en', { dateStyle: 'medium' }))
    expect(relativeTime(at(-7 * DAY), 'en', NOW)?.kind).toBe('relative')
  })
})
