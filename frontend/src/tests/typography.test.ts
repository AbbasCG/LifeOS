import { describe, it, expect } from 'vitest'
import css from '../styles/fonts.css?raw'
import theme from '../styles/theme.css?raw'
import workspace from '../styles/workspace.css?raw'
import premium from '../styles/premium.css?raw'
import experience from '../styles/experience.css?raw'

const FILES = ['thmanyahsans-Light', 'thmanyahsans-Regular', 'thmanyahsans-Medium', 'thmanyahsans-Bold', 'thmanyahsans-Black', 'thmanyahserifdisplay-Bold', 'thmanyahserifdisplay-Black'].map(name => `${name}.woff2`)
// The licensed font files are installed locally (git-ignored); when present they must be exactly the referenced ones.
const installed = Object.keys(import.meta.glob('../../public/fonts/thmanyah/*.woff2', { query: '?url', eager: true })).map(path => path.split('/').pop())
const faces = css.match(/@font-face\s*{[^}]*}/g) ?? []

describe('Thmanyah typography', () => {
  it('declares every supplied weight with font-display: swap and local files only', () => {
    expect(faces.length).toBe(12)
    for (const face of faces) {
      expect(face).toContain('font-display: swap')
      const url = face.match(/url\("([^"]+)"\)/)![1]
      expect(url).toMatch(/^\/fonts\/thmanyah\//)
      expect(FILES).toContain(url.split('/').pop())
    }
    for (const file of FILES) expect(css).toContain(file)
  })

  it('uses Thmanyah first in RTL and keeps Inter for Latin in LTR', () => {
    expect(css).toMatch(/--font-arabic:\s*"Thmanyah Sans"/)
    expect(css).toMatch(/--font-latin:\s*"Inter",\s*"Thmanyah Sans Arabic"/)
    expect(css).toMatch(/\[dir="rtl"\]\s*{\s*--font-ui:\s*var\(--font-arabic\)/)
    expect(css).toMatch(/\[dir="rtl"\] h1,[\s\S]*font-family: var\(--font-display-arabic\)/)
  })

  it('scopes the LTR fallback to Arabic code points and never letter-spaces Arabic', () => {
    for (const face of faces.filter((f: string) => f.includes('"Thmanyah Sans Arabic"'))) expect(face).toMatch(/unicode-range:\s*U\+0600-06FF/)
    expect(css).toMatch(/\[dir="rtl"\] \*[^{]*{\s*letter-spacing: normal !important/)
  })

  it('does not load any font from a CDN anywhere in the styles', () => {
    for (const sheet of [css, theme, workspace, premium, experience]) {
      expect(sheet).not.toMatch(/fonts\.googleapis|fonts\.gstatic|@import url\(/)
    }
    if (installed.length > 0) expect([...installed].sort()).toEqual([...FILES].sort())
  })
})
