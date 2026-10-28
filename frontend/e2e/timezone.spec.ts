import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * "Today" follows the account's timezone, not the browser's. The browser here is in UTC; the account is put in a zone
 * whose calendar day is different right now (UTC+14 in the second half of the UTC day, UTC-11 in the first), which is
 * exactly the window in which the browser's own "today" used to be refused by the server (422) or filed under the
 * wrong day.
 */
test.use({ timezoneId: 'UTC' })

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, path, body] as const)
}

const dayIn = (zone: string) => new Date().toLocaleDateString('en-CA', { timeZone: zone })

test('plan my day and habit logging follow the account’s day when it differs from the browser’s', async ({ page, setLanguage, guard }) => {
  // The 422 for the account's tomorrow below is the point of the test, not a defect.
  guard.allowConsole(/422/)
  await setLanguage('en')
  await page.goto('/')
  const original = (await call(page, 'GET', '/api/settings')).body.timezone as string
  const zone = new Date().getUTCHours() >= 10 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago'
  const accountToday = dayIn(zone), browserToday = dayIn('UTC')
  expect(accountToday).not.toBe(browserToday)
  try {
    expect((await call(page, 'PUT', '/api/settings', { timezone: zone })).status).toBe(200)

    // Plan my day: the date is the account's today, and the server accepts it (no 422 reaches the console).
    const plan = page.waitForResponse(r => r.url().includes('/api/day-plan') && r.request().method() === 'GET')
    await page.goto('/today/plan')
    expect((await plan).status()).toBe(200)
    await expect(page.locator('#plan-date')).toHaveValue(accountToday)
    await expect(page.locator('#plan-date')).toHaveAttribute('min', accountToday)

    // A habit logged from Today is filed under the account's day, and the server takes it.
    const habit = (await call(page, 'POST', '/api/habits', { title: `E2E zone ${Date.now()}` })).body.data
    try {
      // The server takes the account's today and refuses the account's tomorrow (the browser's own day would have
      // been refused, or accepted, by the wrong clock).
      expect((await call(page, 'PUT', `/api/habits/${habit.id}/entry`, { date: accountToday, completed: true })).status).toBe(200)
      const accountTomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: zone })
      expect((await call(page, 'PUT', `/api/habits/${habit.id}/entry`, { date: accountTomorrow, completed: true })).status).toBe(422)
    } finally {
      await call(page, 'DELETE', `/api/habits/${habit.id}`)
    }
  } finally {
    await call(page, 'PUT', '/api/settings', { timezone: original })
  }
})
