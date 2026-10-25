import { test as base, expect, type Page } from '@playwright/test'

/**
 * Every test: fails on any request that leaves 127.0.0.1 (no real accounts, ever), on uncaught page errors, and
 * on unexpected console errors. `setLanguage` sets the server-side preference, which wins over local storage.
 */
export const test = base.extend<{ guard: { allowConsole: (pattern: RegExp) => void }; setLanguage: (language: 'en' | 'ar') => Promise<void> }>({
  guard: [async ({ page }, use) => {
    const external: string[] = [], errors: string[] = [], allowed: RegExp[] = []
    await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol.startsWith('http'), route => { external.push(route.request().url()); return route.abort() })
    page.on('pageerror', e => errors.push(String(e)))
    page.on('console', m => { if (m.type() === 'error' && !allowed.some(r => r.test(m.text()))) errors.push(m.text()) })
    await use({ allowConsole: pattern => { allowed.push(pattern) } })
    expect(external, 'requests outside the test servers').toEqual([])
    expect(errors, 'console and page errors').toEqual([])
  }, { auto: true }],
  setLanguage: async ({ page }, use) => {
    await use(async language => {
      await page.goto('/')
      const status = await page.evaluate(async l => {
        const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
        return (await fetch('/api/settings', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: JSON.stringify({ language: l }) })).status
      }, language)
      expect(status).toBe(200)
    })
  },
})
export { expect }

export async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
}
