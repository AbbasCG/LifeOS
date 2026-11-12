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
      const settled = watchScripts(page)
      // The app asks the server about announcements once it is idle. If that call were still pending when a test installs its own stub and
      // navigates, the OLD page would receive the stubbed announcement, mark it shown for this browser session, and the new page would show nothing.
      const discovery = page.waitForResponse(r => r.url().includes('/api/discovery/bootstrap'), { timeout: 15_000 }).catch(() => null)
      await page.goto('/')
      const status = await page.evaluate(async l => {
        const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
        return (await fetch('/api/settings', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: JSON.stringify({ language: l }) })).status
      }, language)
      expect(status).toBe(200)
      // The page is still fetching its lazy chunks; navigating away now cancels them and Chromium logs each as a failed load. Let them finish.
      await discovery
      await settled()
    })
  },
})
export { expect }

/**
 * Counts the page's script downloads. The app fetches lazy chunks after load; leaving the page while one is in flight makes Chromium log
 * "Failed to load resource: net::ERR_FAILED", which the guard (rightly) treats as an error. `networkidle` cannot be used: the app keeps requests open.
 * `settled()` resolves once no script has been in flight for a few consecutive checks.
 */
function watchScripts(page: Page) {
  let inflight = 0
  const isScript = (r: import('@playwright/test').Request) => r.resourceType() === 'script'
  const start = (r: import('@playwright/test').Request) => { if (isScript(r)) inflight++ }
  const end = (r: import('@playwright/test').Request) => { if (isScript(r)) inflight-- }
  page.on('request', start); page.on('requestfinished', end); page.on('requestfailed', end)
  return async () => {
    let quiet = 0
    await expect.poll(() => { quiet = inflight === 0 ? quiet + 1 : 0; return quiet }, { intervals: [150], timeout: 15_000 }).toBeGreaterThanOrEqual(4)
    page.off('request', start); page.off('requestfinished', end); page.off('requestfailed', end)
  }
}

export async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
}

/**
 * Set a value through the app's own date/time picker (never the browser's): open the field, type the date and/or time into the
 * picker's boxes, and close it. `value` is 'YYYY-MM-DD', 'HH:mm' or 'YYYY-MM-DDTHH:mm'.
 */
export async function pick(page: Page, trigger: import('@playwright/test').Locator, value: string) {
  await trigger.click()
  const sheet = page.locator('.dtp-dialog[open]')
  await expect(sheet).toBeVisible()
  const [date, time] = value.includes('T') ? value.split('T') : /^\d{4}-/.test(value) ? [value, ''] : ['', value]
  if (date) { const box = sheet.getByRole('textbox', { name: 'Date' }); await box.fill(date); await box.press('Enter') }
  if (time) { const box = sheet.getByRole('textbox', { name: 'Time' }); await box.fill(time); await box.press('Enter') }
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toBeHidden()
}
/** The picker button inside a `<label>` whose text starts with `label`. */
export const field = (scope: Page | import('@playwright/test').Locator, label: string) => scope.locator('label', { hasText: new RegExp(`^${label}`) }).locator('.dtp-trigger').first()

/**
 * Really use a date/time picker the way a person does: open it (by the field or by its calendar icon), page to the right month,
 * tap the day, tap the hour and the minute, press Done. Returns nothing; the caller checks what was saved.
 * `time` is 24-hour 'HH:mm' (minutes in steps of 5); the clock is switched to 24 h first so the buttons are the same everywhere.
 */
export async function chooseByTapping(page: Page, trigger: import('@playwright/test').Locator, date: string, time?: string, via: 'field' | 'icon' = 'field') {
  await trigger.scrollIntoViewIfNeeded()
  if (via === 'icon') await trigger.locator('svg').first().click(); else await trigger.click()
  const sheet = page.locator('.dtp-dialog[open]')
  await expect(sheet).toBeVisible()
  await sheet.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)))
  const view = page.viewportSize()!, box = (await sheet.boundingBox())!
  expect(box.x, 'picker inside the screen (left)').toBeGreaterThanOrEqual(-1)
  expect(box.y, 'picker inside the screen (top)').toBeGreaterThanOrEqual(-1)
  expect(box.x + box.width, 'picker inside the screen (right)').toBeLessThanOrEqual(view.width + 1)
  expect(box.y + box.height, 'picker inside the screen (bottom)').toBeLessThanOrEqual(view.height + 1)
  if (date) {
    const dayButton = sheet.locator(`[data-day="${date}"]`)
    for (let guard = 0; guard < 36 && !(await dayButton.count()); guard++) {
      const shown = (await sheet.locator('.dtp-day:not(.outside)').first().getAttribute('data-day'))!
      await sheet.locator('.dtp-month > .icon-button').nth(date.slice(0, 7) > shown.slice(0, 7) ? 1 : 0).click()
    }
    await dayButton.click()
  }
  if (time) {
    const [h, m] = time.split(':')
    if (await sheet.getByRole('button', { name: /^12 h|^١٢ س/ }).getAttribute('aria-pressed') === 'true') await sheet.getByRole('button', { name: /^24 h|^٢٤ س/ }).click()
    await sheet.locator('.dtp-hours button', { hasText: new RegExp(`^${h}$`) }).click()
    await sheet.locator('.dtp-minutes button', { hasText: new RegExp(`^${m}$`) }).click()
  }
  if (await sheet.isVisible()) await sheet.getByRole('button', { name: /^Done$|^تم$/ }).click()
  await expect(sheet).toBeHidden()
}
