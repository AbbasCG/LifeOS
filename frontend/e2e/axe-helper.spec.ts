import { test, expect } from './fixtures'
import { a11yViolations, settle } from './axe'

/** The shared accessibility check (e2e/axe.ts) used by the What's New, hint and tour specs: it must report every element, and measure a settled page. */
const page = (body: string, css = '') => `<!doctype html><html lang="en"><head><title>t</title><style>body{background:#fff;color:#111;font:16px sans-serif}${css}</style></head><body><main>${body}</main></body></html>`

test('reports every failing element, not only the first', async ({ page: p }) => {
  await p.setContent(page('<h1>Title</h1><p id="low1" style="color:#bbb">first pale text</p><p id="low2" style="color:#bbb">second pale text</p><p id="fine">readable text</p>'))
  const found = await a11yViolations(p, 'main')
  expect(found.filter(line => line.startsWith('color-contrast')).map(line => line.match(/#low\d/)?.[0]).sort()).toEqual(['#low1', '#low2'])
  expect(found.join('\n')).toContain('insufficient color contrast')
  expect(found.join('\n')).not.toContain('#fine')
})

test('returns nothing for an accessible page', async ({ page: p }) => {
  await p.setContent(page('<h1>Title</h1><p>readable text</p>'))
  expect(await a11yViolations(p)).toEqual([])
})

test('waits for a fade-in to finish before measuring contrast', async ({ page: p }) => {
  // Fully readable text, but for the first 600 ms it is almost transparent: measured at once it would look pale.
  await p.setContent(page('<h1>Title</h1><p id="card" style="animation:fade 600ms linear both">readable text</p>', '@keyframes fade{from{opacity:.05}to{opacity:1}}'))
  const before = await p.evaluate(() => document.getElementById('card')!.getAnimations().filter(a => a.playState !== 'finished').length)
  expect(before).toBe(1)
  expect(await a11yViolations(p, '#card')).toEqual([])
  const after = await p.evaluate(() => document.getElementById('card')!.getAnimations().filter(a => a.playState !== 'finished').length)
  expect(after).toBe(0)
})

test('does not hang on animations that never end', async ({ page: p }) => {
  await p.setContent(page('<h1>Title</h1><p id="spin" style="animation:spin 1s linear infinite">readable text</p>', '@keyframes spin{from{opacity:1}to{opacity:.9}}'))
  const started = Date.now()
  await settle(p, '#spin')
  expect(Date.now() - started).toBeLessThan(2000)
  expect(await a11yViolations(p, '#spin')).toEqual([])
})
