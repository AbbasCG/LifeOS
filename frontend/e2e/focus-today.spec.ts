import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return r.status === 204 ? null : r.json().catch(() => null)
  }, [method, path, body] as const)
}

test('focus on Today: shown on request, with a daily goal set in one tap', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const before = await call(page, 'GET', '/api/settings')
  await call(page, 'PUT', '/api/settings', { today_layout: {}, daily_focus_goal: null })
  try {
    await page.goto('/')
    await expect(page.locator('.now-card')).toBeVisible()
    // Hidden by default: nobody's Today changes until they choose.
    await expect(page.locator('.today-top:not(.in-more) .section-focus')).toHaveCount(0)

    await page.getByRole('button', { name: 'Customize Today' }).click()
    const sheet = page.getByRole('dialog', { name: 'Customize Today' })
    await sheet.getByRole('button', { name: 'Show Focus' }).click()
    await sheet.getByRole('button', { name: 'Save' }).click()
    const focus = page.locator('.today-top:not(.in-more) .section-focus')
    await expect(focus.getByRole('heading', { name: 'Focus' })).toBeVisible()
    await expect(focus.getByText('Set a goal')).toBeVisible()

    await focus.getByRole('button', { name: /Set a daily goal/ }).click()
    await page.getByRole('dialog', { name: 'Daily focus goal' }).getByRole('radio', { name: '1h', exact: true }).click()
    await expect(page.getByText('Daily focus goal saved.')).toBeVisible()
    await expect(focus.getByRole('img', { name: /of 60 minutes/ })).toBeVisible()
    expect((await call(page, 'GET', '/api/settings')).daily_focus_goal).toBe(60)
    const stats = await call(page, 'GET', '/api/focus-sessions/today')
    expect(stats.goal_minutes).toBe(60)
    expect(typeof stats.today_minutes).toBe('number')
  } finally {
    await call(page, 'PUT', '/api/settings', { today_layout: before.today_layout ?? {}, daily_focus_goal: before.daily_focus_goal ?? null })
  }
})
