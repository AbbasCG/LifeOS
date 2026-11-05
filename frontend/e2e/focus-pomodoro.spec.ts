import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return r.status === 204 ? null : r.json().catch(() => null)
  }, [method, path, body] as const)
}
const seconds = async (page: Page) => { const [m, s] = (await page.locator('.dial-time').innerText()).split(':').map(Number); return m * 60 + s }

async function clean(page: Page) {
  const list = await call(page, 'GET', '/api/focus-sessions') as { data: { id: number; status: string }[] }
  for (const s of list.data.filter(s => s.status === 'running' || s.status === 'paused')) await call(page, 'PATCH', `/api/focus-sessions/${s.id}`, { action: 'cancel' })
}

for (const language of ['en', 'ar'] as const) {
  test(`Pomodoro: start counts down, pause holds, resume continues, reset discards, and nothing finishes by itself (${language})`, async ({ page, setLanguage }) => {
    await setLanguage(language)
    await page.goto('/focus')
    await clean(page)
    await page.reload()
    const patches: string[] = []
    page.on('request', r => { if (r.method() === 'PATCH' && /focus-sessions/.test(r.url())) patches.push(r.postData() ?? '') })

    await page.locator('.focus-start').click()
    const first = await seconds(page)
    expect(first).toBeGreaterThan(24 * 60 + 50)
    await expect.poll(() => seconds(page), { timeout: 8000 }).toBeLessThan(first)
    await page.waitForTimeout(1500)
    expect(await seconds(page)).toBeGreaterThan(24 * 60)

    await page.locator('.focus-controls .primary.big').click()
    await expect(page.locator('.dial-status')).toHaveText(/Paused|متوقف/)
    const held = await seconds(page)
    await page.waitForTimeout(2500)
    expect(await seconds(page)).toBe(held)

    await page.locator('.focus-controls .primary.big').click()
    await expect(page.locator('.dial-status')).not.toHaveText(/Paused|متوقف/)
    await expect.poll(() => seconds(page), { timeout: 8000 }).toBeLessThan(held)

    await page.locator('.focus-controls button[aria-label]').click()
    await expect(page.locator('.focus-start')).toBeVisible()
    expect(await seconds(page)).toBe(25 * 60)
    const state = await call(page, 'GET', '/api/focus-sessions') as { data: { status: string }[] }
    expect(state.data[0].status).toBe('cancelled')
    expect(patches.filter(p => p.includes('finish'))).toHaveLength(0)
  })
}
