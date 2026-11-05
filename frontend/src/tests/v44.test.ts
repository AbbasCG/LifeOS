import { describe, it, expect } from 'vitest'
import fonts from '../styles/fonts.css?raw'
import indexCss from '../index.css?raw'
import theme from '../styles/theme.css?raw'
import workspace from '../styles/workspace.css?raw'
import { elapsedNow, parseStamp, stampSession, type FocusSessionRecord } from '../lib/focus'

const running = (over: Partial<FocusSessionRecord> = {}): FocusSessionRecord => ({
  id: 1, status: 'running', kind: 'focus', mode: 'custom', cycle: null, duration_seconds: 1500, elapsed_seconds: 0,
  resumed_at: '2027-03-09T10:00:00.000000Z', completed_at: null, started_at: '2027-03-09T10:00:00.000000Z', created_at: '2027-03-09T10:00:00.000000Z',
  notes: null, interruptions: null, task_id: null, project_id: null, ...over,
})
const T = new Date('2027-03-09T10:00:00Z').getTime()

describe('V44 the focus countdown', () => {
  it('counts the seconds since the session began', () => {
    expect(elapsedNow(running(), T + 90_000)).toBe(90)
  })
  it('does not end at once when the device clock is hours ahead of the server', () => {
    const device = T + 6 * 3600_000
    // The server said it was 10:00:02 when the device thought it was 16:00:00.
    const s = { ...running(), skew_ms: new Date('2027-03-09T10:00:02Z').getTime() - device }
    expect(elapsedNow(s, device)).toBe(2)
    expect(elapsedNow(s, device + 60_000)).toBe(62)
  })
  it('stamps the gap between the server and this device when a record arrives', () => {
    const stamped = stampSession(running({ server_time: new Date(Date.now() + 5 * 3600_000).toISOString() }))
    expect(stamped.skew_ms).toBeGreaterThan(5 * 3600_000 - 2000)
    expect(stampSession(running()).skew_ms).toBeUndefined()
  })
  it('never finishes by accident: a time that cannot be read counts as just started', () => {
    expect(elapsedNow(running({ resumed_at: 'not a date' }), T + 3_000_000)).toBe(0)
    expect(elapsedNow(running({ elapsed_seconds: Number.NaN }), T + 10_000)).toBe(10)
    expect(elapsedNow(running({ resumed_at: null }), T)).toBe(0)
  })
  it('reads times with microseconds, the way the server writes them', () => {
    expect(parseStamp('2027-03-09T10:00:00.123456Z')).toBe(T + 123)
    expect(parseStamp('')).toBeNull()
    expect(parseStamp('nope')).toBeNull()
  })
  it('never runs past the length of the session, and a paused session does not move', () => {
    expect(elapsedNow(running(), T + 99_999_000)).toBe(1500)
    expect(elapsedNow(running({ status: 'paused', elapsed_seconds: 300 }), T + 99_999_000)).toBe(300)
  })
})

describe('V44 the font stacks', () => {
  const css = fonts
  const stack = (name: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].replace(/\s+/g, ' ').trim() ?? ''

  it('puts Thmanyah first for Arabic and keeps Inter first for English', () => {
    expect(stack('font-latin')).toMatch(/^"Inter"/)
    expect(stack('font-arabic')).toMatch(/^"Thmanyah Sans"/)
  })
  it('keeps no other face ahead of it anywhere in the app styles', () => {
    for (const [file, text] of Object.entries({ 'index.css': indexCss, 'theme.css': theme, 'workspace.css': workspace })) {
      for (const m of text.matchAll(/font-family:\s*([^;}]+)/g)) expect(m[1].trim(), `${file}: ${m[1]}`).toMatch(/^var\(--font-(ui|latin|arabic)/)
    }
  })
})
