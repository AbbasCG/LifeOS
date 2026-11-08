import { describe, it, expect } from 'vitest'
import { nextWeekDay, dueFor, dueForDay } from '../lib/quickAdd'
import { setAccountZone } from '../lib/accountDay'
import premium from '../styles/premium.css?raw'
import theme from '../styles/theme.css?raw'
import mobile from '../styles/mobile.css?raw'
import workspace from '../styles/workspace.css?raw'
import picker from '../styles/picker.css?raw'
import experience from '../styles/experience.css?raw'
import visual from '../styles/visual.css?raw'
import settings from '../features/settings/IntegrationsSettings.tsx?raw'

// Mobile P1 batch: what the review found, pinned so it cannot quietly come back.

/** WCAG relative-luminance contrast ratio of two #rrggbb colours. */
function ratio(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}
const token = (css: string, scope: 'light' | 'dark', name: string): string => {
  const block = scope === 'light' ? css.match(/:root\s*{([^}]*)}/)![1]! : css.match(/:root\[data-theme="dark"\]\s*{([^}]*)}/)![1]!
  return block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))![1]!
}

describe('dictated "next week" is visible', () => {
  it('nextWeekDay is the coming Monday as a day, from any weekday', () => {
    setAccountZone('UTC')
    expect(nextWeekDay(new Date('2027-03-10T09:00:00Z'))).toBe('2027-03-15')   // Wednesday
    expect(nextWeekDay(new Date('2027-03-14T09:00:00Z'))).toBe('2027-03-15')   // Sunday
    expect(nextWeekDay(new Date('2027-03-15T09:00:00Z'))).toBe('2027-03-22')   // Monday itself asks for the next one
  })

  it('saves exactly the same due date as the old hidden "next week" choice', () => {
    setAccountZone('Europe/Amsterdam')
    for (const now of ['2027-03-10T09:00:00Z', '2027-03-14T23:30:00Z', '2027-03-15T09:00:00Z']) {
      expect(dueForDay(nextWeekDay(new Date(now)), new Date(now))).toBe(dueFor('nextweek', new Date(now)))
    }
  })
})

describe('selected priority tiles are readable in both themes', () => {
  const pairs: [string, 'light' | 'dark', string, string][] = [
    ['urgent', 'light', '--color-on-danger', '--color-danger'], ['urgent', 'dark', '--color-on-danger', '--color-danger'],
    ['high', 'light', '--color-on-warning', '--color-warning'], ['high', 'dark', '--color-on-warning', '--color-warning'],
  ]
  it.each(pairs)('%s tile, %s theme: text on fill is at least 4.5:1', (_tone, scope, on, fill) => {
    expect(ratio(token(premium, scope, on), token(premium, scope, fill))).toBeGreaterThanOrEqual(4.5)
  })

  it('the tiles use those tokens, not hard-coded colours, and show a check mark besides colour', () => {
    expect(mobile).toMatch(/\.choice\.tone-urgent\[aria-checked="true"\][^}]*color: var\(--color-on-danger\)/)
    expect(mobile).toMatch(/\.choice\.tone-high\[aria-checked="true"\][^}]*color: var\(--color-on-warning\)/)
    expect(mobile).toMatch(/\.choice-tiles \.choice\[aria-checked="true"\]::after[^}]*content: "✓" \/ ""/)
  })
})

describe('keyboard focus is visible', () => {
  it('the global and picker rings are the opaque primary colour (3:1 needed; 5.7:1 on white)', () => {
    expect(ratio(token(theme, 'light', '--color-primary'), token(theme, 'light', '--color-surface'))).toBeGreaterThanOrEqual(3)
    expect(ratio(token(theme, 'dark', '--color-primary'), token(theme, 'dark', '--color-surface'))).toBeGreaterThanOrEqual(3)
    expect(workspace).toMatch(/button:focus-visible[^}]*outline:3px solid var\(--color-primary\)/)
    expect(workspace).not.toMatch(/focus-visible[^}]*var\(--color-accent\)/)
    expect(picker).toMatch(/\.dtp-dialog \*:focus-visible \{ outline: 3px solid var\(--color-primary\)/)
    expect(experience).toMatch(/:where\(button, a, input, select, textarea, \[tabindex\]\):focus-visible \{ outline: 3px solid var\(--color-primary\)/)
  })
})

describe('small controls reach 44px on a phone', () => {
  it('icon buttons, the task play button, calendar arrows and the widget movers are raised under coarse pointers', () => {
    const block = visual.slice(visual.indexOf('@media (pointer: coarse), (max-width: 760px)'))
    expect(block).toMatch(/\.icon-button, \.icon-button\.play, \.cal-nav \.quiet, \.widget-move \.icon-button \{ min-height: 44px; \}/)
    expect(block).toMatch(/\.icon-button\.play, \.widget-move \.icon-button \{ min-width: 44px; \}/)
  })
})

describe('the external-AI switch is named by its visible text (WCAG 2.5.3)', () => {
  it('is labelled by the visible words, with the long wording only as a description', () => {
    expect(settings).toMatch(/<strong id="share-ai-label">\{t\('Share with external AI'/)
    expect(settings).toMatch(/role="switch"[^>]*aria-labelledby="share-ai-label" aria-describedby="share-ai-desc"/)
    expect(settings).not.toMatch(/role="switch"[^>]*aria-label=/)
  })
})
