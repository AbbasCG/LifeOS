import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Every text of the Connected Accounts screens must exist in Dutch. `t(en, ar)` without a third text shows the English one to a Dutch reader, so a new two-language
 * text in these files fails here instead of reaching people unnoticed. The source is parsed with the TypeScript compiler, so texts built from nested template literals
 * (`${a ? `x ${b}` : ''}`) are counted correctly, which a regular expression cannot do.
 */
const root = join(__dirname, '..')
const candidates = [
  'features/settings/IntegrationsSettings.tsx', 'features/settings/ProviderConfiguration.tsx',
  'lib/accountState.ts', 'lib/calendarWrite.ts', 'lib/connectionPermissions.ts', 'lib/syncSettings.ts', 'lib/integrationsAdmin.ts',
  ...readdirSync(join(root, 'features/connected')).filter(f => /\.tsx?$/.test(f)).map(f => `features/connected/${f}`),
]
const files = candidates.filter(f => existsSync(join(root, f)))

/** The calls `t(a, b)` with exactly two arguments, as short source excerpts. */
export function twoLanguageCalls(source: string, name = 'source.tsx'): string[] {
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, name.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't' && node.arguments.length === 2) found.push(node.getText(sf).slice(0, 90))
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

describe('Connected Accounts screens in Dutch', () => {
  it.each(files)('%s has a Dutch text for every text', file => {
    expect(twoLanguageCalls(readFileSync(join(root, file), 'utf8'), file)).toEqual([])
  })

  it('the files being checked exist and are not empty', () => {
    expect(files.length).toBeGreaterThan(8)
    expect(files).toContain('lib/calendarWrite.ts')
    for (const f of files) expect(readFileSync(join(root, f), 'utf8').length).toBeGreaterThan(200)
  })

  it('detects a missing Dutch text even when the text contains nested template literals', () => {
    const nested = 'const x = t(`Synced: ${r.up} updated${r.moved ? `, ${r.moved} moved` : ""}.`, `تمت ${r.up}${r.moved ? `، ${r.moved}` : ""}.`)'
    expect(twoLanguageCalls(nested)).toHaveLength(1)
    expect(twoLanguageCalls(nested.replace(/\)$/, ', `Klaar ${r.up}`)'))).toEqual([])
    expect(twoLanguageCalls("const y = t('a, b', 'c, d')")).toHaveLength(1)
    expect(twoLanguageCalls("const y = t('a', 'b', 'c')")).toEqual([])
  })
})
