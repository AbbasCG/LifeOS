import { describe, it, expect } from 'vitest'
import scrollbars from '../styles/scrollbars.css?raw'
import main from '../main.tsx?raw'

const styles = import.meta.glob('../styles/*.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const index = import.meta.glob('../index.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('the global scrollbar rule', () => {
  it('hides the visual bar everywhere (standard, legacy Edge and WebKit) outside forced-colors mode', () => {
    expect(scrollbars).toMatch(/@media not \(forced-colors: active\)/)
    expect(scrollbars).toMatch(/\*\s*\{[^}]*scrollbar-width:\s*none/)
    expect(scrollbars).toMatch(/\*\s*\{[^}]*-ms-overflow-style:\s*none/)
    expect(scrollbars).toMatch(/\*::-webkit-scrollbar\s*\{[^}]*display:\s*none[^}]*width:\s*0[^}]*height:\s*0/)
  })

  it('never stops scrolling: it sets no overflow value at all', () => {
    const code = scrollbars.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/overflow(-x|-y)?\s*:/)
    expect(code).not.toMatch(/pointer-events|touch-action|user-select/)
  })

  it('is imported by the app entry, after the theme', () => {
    expect(main).toMatch(/import '\.\/styles\/scrollbars\.css'/)
    expect(main.indexOf('styles/theme.css')).toBeLessThan(main.indexOf('styles/scrollbars.css'))
  })

  it('no other stylesheet reserves scrollbar space or forces a bar back', () => {
    for (const [file, css] of Object.entries({ ...styles, ...index })) {
      expect(css, file).not.toMatch(/scrollbar-gutter/)
      expect(css, file).not.toMatch(/scrollbar-width:\s*(auto|thin)/)
      expect(css, file).not.toMatch(/::-webkit-scrollbar\s*\{[^}]*display:\s*(block|initial)/)
    }
  })

  it('no stylesheet hides a scrollbar outside the forced-colors guard (so forced-colors keeps native bars)', () => {
    for (const [file, raw] of Object.entries({ ...styles, ...index })) {
      const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')
      const guarded = file.endsWith('/scrollbars.css') ? css.replace(/@media not \(forced-colors: active\)\s*\{[\s\S]*\}\s*$/, '') : css
      expect(guarded, file).not.toMatch(/scrollbar-width:\s*none|-ms-overflow-style:\s*none|::-webkit-scrollbar[^{]*\{[^}]*display:\s*none/)
    }
  })

  it('scrollers without focusable content get a tab stop, a region role and a name', async () => {
    const read = async (p: string) => (await import(`../features/${p}?raw`)).default as string
    expect(await read('AnalyticsPage.tsx')).toMatch(/className="table-scroll" role="region" tabIndex=\{0\} aria-label/)
    expect(await read('FocusPage.tsx')).toMatch(/className="session-history" role="region" tabIndex=\{0\} aria-label/)
    expect(await read('AssistantPage.tsx')).toMatch(/className="chat-log" role="region" tabIndex=\{0\} aria-label/)
  })
})
