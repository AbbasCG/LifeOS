import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every text of the Connected Accounts screens must exist in Dutch. `t(en, ar)` without a third text shows the English one to a Dutch reader, so a new two-language
 * text in these files fails here instead of reaching people unnoticed.
 */
const root = join(__dirname, '..')
const files = [
  'features/settings/IntegrationsSettings.tsx', 'features/settings/ProviderConfiguration.tsx', 'lib/accountState.ts',
  ...readdirSync(join(root, 'features/connected')).filter(f => f.endsWith('.tsx')).map(f => `features/connected/${f}`),
]
const lit = String.raw`(?:\x60(?:[^\x60\\]|\\.)*\x60|'(?:[^'\\]|\\.)*')`
const twoLanguages = new RegExp(String.raw`\bt\(\s*${lit}\s*,\s*${lit}\s*\)`, 'g')

describe('Connected Accounts screens in Dutch', () => {
  it.each(files)('%s has a Dutch text for every text', file => {
    const source = readFileSync(join(root, file), 'utf8')
    const missing = [...source.matchAll(twoLanguages)].map(m => m[0].slice(0, 90))
    expect(missing).toEqual([])
  })

  it('the files being checked exist and are not empty', () => {
    expect(files.length).toBeGreaterThan(8)
    for (const f of files) expect(readFileSync(join(root, f), 'utf8').length).toBeGreaterThan(200)
  })
})
