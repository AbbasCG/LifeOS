import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import fonts from '../styles/fonts.css?raw'
import { FONT_FILES, fontFolder, findFont, fontReport, thmanyahFonts, FONT_URL_PREFIX } from '../../scripts/thmanyahFonts.mjs'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'lifeos-fonts-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const install = (folder: string, names: string[]) => { mkdirSync(join(root, 'fonts', folder), { recursive: true }); for (const n of names) writeFileSync(join(root, 'fonts', folder, n), 'x') }

describe('V45 the Thmanyah font files', () => {
  it('asks for exactly the files the stylesheet declares, under /fonts/thmanyah/', () => {
    const urls = [...fonts.matchAll(/url\("([^"]+)"\)/g)].map(m => m[1])
    expect(urls.length).toBeGreaterThan(5)
    for (const url of urls) { expect(url.startsWith(FONT_URL_PREFIX)).toBe(true); expect(FONT_FILES).toContain(url.slice(FONT_URL_PREFIX.length)) }
    for (const file of FONT_FILES) expect(fonts).toContain(file)
  })

  it('finds the folder and the files whatever their capitalisation (Thmanyah/, THMANYAH/, mixed-case names)', () => {
    install('Thmanyah', ['THMANYAHSANS-regular.woff2', 'ThmanyahSerifDisplay-Bold.woff2'])
    expect(fontFolder(join(root, 'fonts'))).toBe(join(root, 'fonts', 'Thmanyah'))
    expect(findFont(join(root, 'fonts'), 'thmanyahsans-Regular.woff2')).toBe(join(root, 'fonts', 'Thmanyah', 'THMANYAHSANS-regular.woff2'))
    expect(findFont(join(root, 'fonts'), 'thmanyahsans-Black.woff2')).toBeNull()
  })

  it('never serves a path outside the font folder', () => {
    install('thmanyah', ['thmanyahsans-Regular.woff2'])
    for (const name of ['../x.woff2', '..\\x.woff2', 'a/b.woff2', '']) expect(findFont(join(root, 'fonts'), name)).toBeNull()
  })

  it('reports which fonts are installed and which are missing, and copes with no folder at all', () => {
    expect(fontReport(join(root, 'fonts'), FONT_FILES)).toEqual({ folder: null, found: [], missing: FONT_FILES })
    install('Thmanyah', [FONT_FILES[1], FONT_FILES[0].toUpperCase().replace('.WOFF2', '.woff2')])
    const report = fontReport(join(root, 'fonts'), FONT_FILES)
    expect(report.found).toEqual([FONT_FILES[0], FONT_FILES[1]])
    expect(report.missing).toHaveLength(FONT_FILES.length - 2)
  })

  it('serves a font on the dev server from a differently capitalised folder, and lets other requests through', async () => {
    install('Thmanyah', ['ThmanyahSans-Regular.woff2'])
    const plugin = thmanyahFonts(root) as unknown as { configureServer: (s: unknown) => void }
    let handler!: (req: unknown, res: unknown, next: () => void) => void
    plugin.configureServer({ middlewares: { use: (fn: typeof handler) => { handler = fn } } })
    const headers: Record<string, string> = {}
    const res = Object.assign(new PassThrough(), { setHeader: (k: string, v: string) => { headers[k] = v } })
    handler({ url: '/fonts/thmanyah/thmanyahsans-Regular.woff2?v=1' }, res, () => { throw new Error('should have been served') })
    res.resume()
    await new Promise(done => res.on('end', done))
    expect(headers['Content-Type']).toBe('font/woff2')
    let passed = false
    handler({ url: '/assets/app.js' }, res, () => { passed = true })
    handler({ url: '/fonts/thmanyah/thmanyahsans-Black.woff2' }, res, () => { passed = true })
    expect(passed).toBe(true)
  })

  it('writes the built fonts to fonts/thmanyah/ with the exact names the stylesheet asks for', () => {
    const out = join(root, 'dist')
    mkdirSync(join(out, 'fonts', 'Thmanyah'), { recursive: true })
    writeFileSync(join(out, 'fonts', 'Thmanyah', 'ThmanyahSans-REGULAR.woff2'), 'x')
    const plugin = thmanyahFonts(root) as unknown as { configResolved: (c: unknown) => void; closeBundle: { handler: () => void } }
    plugin.configResolved({ build: { outDir: out } })
    plugin.closeBundle.handler()
    expect(readdirSync(join(out, 'fonts'))).toEqual(['thmanyah'])
    expect(readdirSync(join(out, 'fonts', 'thmanyah'))).toEqual(['thmanyahsans-Regular.woff2'])
    expect(existsSync(join(out, 'fonts', 'Thmanyah'))).toBe(readdirSync(join(out, 'fonts')).includes('Thmanyah'))
  })
})
