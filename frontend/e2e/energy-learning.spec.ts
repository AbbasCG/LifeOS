import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

async function call(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ([m, p, b]) => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const r = await fetch(p as string, { method: m as string, credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: b ? JSON.stringify(b) : undefined })
    return r.status === 204 ? null : r.json().catch(() => null)
  }, [method, path, body] as const)
}

test('week versions are learned separately for low- and high-energy days', async ({ page, setLanguage }) => {
  test.setTimeout(120_000)
  await setLanguage('en')
  await page.goto('/assistant')
  // Today in the user's own time zone, and today's check-in (restored afterwards).
  const timezone: string = (await call(page, 'GET', '/api/settings')).timezone ?? 'UTC'
  const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone })
  const previous: number | null = (await call(page, 'GET', '/api/checkins')).today?.energy ?? null
  await call(page, 'PUT', '/api/intelligence/settings', { features: { plan_learning: true }, sources: { checkins: true } })
  const composer = page.getByRole('textbox', { name: 'Message' })
  const plan = async () => {
    await page.goto('/assistant')
    await composer.fill('Plan my week')
    await composer.press('Enter')
    return page.locator('.chat-turn.assistant').last().locator('.plan-card')
  }
  try {
    // Low energy: essentials, three times.
    await call(page, 'PUT', `/api/checkins/${today}`, { energy: 1 })
    for (let i = 0; i < 3; i++) {
      await (await plan()).getByRole('button', { name: 'Essentials only' }).click()
      await expect(page.locator('.chat-turn.assistant').nth(1).locator('.plan-card').getByRole('button', { name: 'Essentials only' })).toHaveAttribute('aria-pressed', 'true')
    }
    // High energy: everything, three times (said as a follow-up). Until then the overall habit (essentials) applies.
    await call(page, 'PUT', `/api/checkins/${today}`, { energy: 5 })
    for (let i = 0; i < 3; i++) {
      await expect((await plan()).getByRole('button', { name: 'Everything, by priority' })).toBeVisible()
      await composer.fill('plan everything')
      await composer.press('Enter')
      await expect(page.locator('.chat-turn.assistant')).toHaveCount(2)
    }

    // Back to low energy: the plan starts with essentials and says why.
    await call(page, 'PUT', `/api/checkins/${today}`, { energy: 2 })
    const lowPlan = await plan()
    await expect(lowPlan.getByRole('button', { name: 'Essentials only' })).toHaveAttribute('aria-pressed', 'true')
    await expect(lowPlan).toContainText('essentials only (when your energy is low)')

    await page.goto('/settings/ai')
    const row = page.locator('.learned-list li', { hasText: 'Week plans' })
    await expect(row.getByText('Low energy: Essentials')).toBeVisible()
    await expect(row.getByText('High energy: Everything')).toBeVisible()
  } finally {
    await call(page, 'DELETE', '/api/intelligence/learning')
    await call(page, 'PUT', '/api/intelligence/settings', { features: { plan_learning: false } })
    if (previous === null) await call(page, 'DELETE', `/api/checkins/${today}`)
    else await call(page, 'PUT', `/api/checkins/${today}`, { energy: previous })
    const list = await call(page, 'GET', '/api/copilot/conversations?q=Plan%20my%20week')
    for (const c of (list?.conversations ?? []) as { id: string; title: string }[]) if (c.title === 'Plan my week') await call(page, 'DELETE', `/api/copilot/conversations/${c.id}`)
  }
})
