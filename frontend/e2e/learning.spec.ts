import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/** Turn plan learning on or off through the settings API (the switch itself is covered by unit tests); turning it off cleans up. */
async function learning(page: Page, on: boolean) {
  await page.evaluate(async enabled => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }
    await fetch('/api/intelligence/settings', { method: 'PUT', credentials: 'include', headers, body: JSON.stringify({ features: { plan_learning: enabled } }) })
    if (enabled) return
    await fetch('/api/intelligence/learning', { method: 'DELETE', credentials: 'include', headers })
    // Remove the conversations this test made.
    const list = await (await fetch('/api/copilot/conversations?q=Plan%20my%20week', { credentials: 'include', headers })).json()
    for (const c of list.conversations ?? []) if (c.title === 'Plan my week') await fetch(`/api/copilot/conversations/${c.id}`, { method: 'DELETE', credentials: 'include', headers })
  }, on)
}

test('learned week versions show up per choice in the AI Control Center and can be forgotten one by one', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/assistant')
  await learning(page, true)
  try {
    const composer = page.getByRole('textbox', { name: 'Message' })
    for (let i = 0; i < 3; i++) {
      await page.goto('/assistant')
      await composer.fill('Plan my week')
      await composer.press('Enter')
      const first = page.locator('.chat-turn.assistant').nth(0).locator('.plan-card')
      await first.getByRole('button', { name: 'Essentials only' }).click()
      await expect(page.locator('.chat-turn.assistant').nth(1).locator('.plan-card').getByRole('button', { name: 'Essentials only' })).toHaveAttribute('aria-pressed', 'true')
    }

    // A fresh request now starts with essentials and says why.
    await page.goto('/assistant')
    await composer.fill('Plan my week')
    await composer.press('Enter')
    const plan = page.locator('.chat-turn.assistant').last().locator('.plan-card')
    await expect(plan.getByRole('button', { name: 'Essentials only' })).toHaveAttribute('aria-pressed', 'true')
    await expect(plan).toContainText('Used what you usually choose: essentials only')

    await page.goto('/settings/ai')
    const row = page.locator('.learned-list li', { hasText: 'Week plans' })
    await expect(row).toContainText('Essentials 3 (100% recent)')
    await expect(row.getByText('Default: Essentials')).toBeVisible()
    await row.getByRole('button', { name: 'Forget learned week plans' }).click()
    await expect(page.getByText('Forgotten.')).toBeVisible()
    await expect(page.locator('.learned-list li', { hasText: 'Week plans' })).toHaveCount(0)
  } finally {
    await learning(page, false)
  }
})
