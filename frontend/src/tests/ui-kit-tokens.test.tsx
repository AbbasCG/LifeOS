import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = join(__dirname, '..', 'styles')
const files = readdirSync(dir).filter(f => f.endsWith('.css'))
const css = (f: string) => readFileSync(join(dir, f), 'utf8')

/** Count definitions of a custom property per theme scope (light :root vs dark) across every style file. */
function definitions(token: string) {
  const out = { light: [] as string[], dark: [] as string[] }
  for (const f of files) {
    for (const m of css(f).matchAll(/(:root(?:\[data-theme="dark"\])?)\s*\{([^}]*)\}/g)) {
      const n = [...m[2].matchAll(new RegExp(`(?<![\\w-])${token}\\s*:`, 'g'))].length
      for (let i = 0; i < n; i++) out[m[1].includes('dark') ? 'dark' : 'light'].push(f)
    }
  }
  return out
}

describe('design tokens are defined once', () => {
  const shared = ['--space-1', '--space-6', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-pill', '--radius-panel', '--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--lh-tight', '--lh-body', '--focus-ring']
  const themed = ['--color-bg', '--color-surface', '--shadow-soft', '--shadow-lift', '--elev-1', '--elev-2', '--elev-3', '--surface-1', '--surface-2', '--surface-inset', '--st-ok', '--st-warn', '--st-bad', '--st-idle', '--st-ok-bg', '--st-warn-bg', '--st-bad-bg', '--st-ok-dot', '--st-warn-dot', '--st-bad-dot']
  it.each(shared)('%s has exactly one definition, in theme.css', token => {
    const d = definitions(token)
    expect(d.light).toEqual(['theme.css'])
    expect(d.dark).toEqual([])
  })
  it.each(themed)('%s has one light and one dark definition, both in theme.css', token => {
    const d = definitions(token)
    expect(d.light).toEqual(['theme.css'])
    expect(d.dark).toEqual(['theme.css'])
  })
})
