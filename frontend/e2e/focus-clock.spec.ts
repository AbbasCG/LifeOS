import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return r.status === 204 ? null : r.json().catch(() => null)
  }, [method, path, body] as const)
}

/** A device whose clock is hours ahead of the server's. */
async function aheadBy(page: Page, hours: number) {
  await page.addInitScript(offset => {
    const Real = Date
    class Shifted extends Real {
      constructor(...args: unknown[]) { if (args.length === 0) super(Real.now() + offset); else super(...(args as [number])) }
      static now() { return Real.now() + offset }
    }
    window.Date = Shifted as unknown as DateConstructor
  }, hours * 3600_000)
}

test('a started focus session counts down even when the device clock is hours ahead of the server', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/focus')
  const sessions = await call(page, 'GET', '/api/focus-sessions') as { data: { id: number; status: string }[] }
  for (const s of sessions.data.filter(s => s.status === 'running' || s.status === 'paused')) await call(page, 'PATCH', `/api/focus-sessions/${s.id}`, { action: 'cancel' })

  await aheadBy(page, 6)
  await page.goto('/focus')
  await page.locator('.focus-start').click()
  const dial = page.locator('.dial-time')
  await expect(dial).toHaveText(/^2[45]:\d\d$/)
  await page.waitForTimeout(2500)
  await expect(dial).toHaveText(/^2[45]:\d\d$/)
  await expect(page.getByText('Session complete')).toHaveCount(0)
  const now = await call(page, 'GET', '/api/focus-sessions') as { data: { status: string }[] }
  expect(now.data[0].status).toBe('running')

  await call(page, 'PATCH', `/api/focus-sessions/${(await call(page, 'GET', '/api/focus-sessions') as { data: { id: number }[] }).data[0].id}`, { action: 'cancel' })
})

for (const language of ['en', 'ar'] as const) {
  test(`the interface text uses a Thmanyah face first (${language})`, async ({ page, setLanguage }) => {
    await setLanguage(language)
    await page.goto('/')
    await expect(page.locator('.now-card')).toBeVisible()
    const families = await page.evaluate(() => [document.body, document.querySelector('button'), document.querySelector('h1,h2'), document.querySelector('.sidebar a, nav a')].filter(Boolean).map(el => getComputedStyle(el as Element).fontFamily))
    expect(families.length).toBeGreaterThan(2)
    for (const f of families) expect(f.startsWith('"Thmanyah '), f).toBe(true)
  })
}
