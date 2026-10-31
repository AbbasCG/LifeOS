import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

async function resetLayout(page: Page) {
  await page.evaluate(async () => {
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '')
    await fetch('/api/settings', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-XSRF-TOKEN': token }, body: JSON.stringify({ today_layout: {} }) })
  })
}
const shown = (page: Page) => page.locator('.today-top:not(.in-more) > .today-section').evaluateAll(nodes => nodes.map(n => n.className.match(/section-(\w+)/)?.[1]))

test('Today is customized for this device: reorder, hide into "More", and reset', async ({ page, setLanguage }, info) => {
  await setLanguage('en')
  await resetLayout(page)
  try {
    await page.goto('/')
    await expect(page.locator('.now-card')).toBeVisible()
    expect((await shown(page))[0]).toBe('now')

    await page.getByRole('button', { name: 'Customize Today' }).click()
    const sheet = page.getByRole('dialog', { name: 'Customize Today' })
    // Opens on the device in use.
    await expect(sheet.getByRole('radio', { name: info.project.name === 'mobile' ? /Phone/ : /Computer/ })).toHaveAttribute('aria-checked', 'true')
    await expect(sheet.getByRole('button', { name: 'Hide Now card' })).toHaveCount(0)
    // Now card, quick check-in and day strip come before Top 3 by default.
    for (let i = 0; i < 3; i++) await sheet.getByRole('button', { name: 'Move Top 3 up' }).click()
    await sheet.getByRole('button', { name: 'Hide Day strip' }).click()
    await sheet.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Today updated.')).toBeVisible()

    await expect.poll(async () => (await shown(page)).slice(0, 2)).toEqual(['top3', 'now'])
    expect(await shown(page)).not.toContain('strip')
    // Hidden, not lost.
    await page.reload()
    await expect.poll(async () => (await shown(page)).slice(0, 2)).toEqual(['top3', 'now'])
    await page.getByText('More for today').click()
    await expect(page.locator('.today-top.in-more .section-strip')).toBeVisible()

    await page.getByRole('button', { name: 'Customize Today' }).click()
    await sheet.getByRole('button', { name: /Reset/ }).click()
    await sheet.getByRole('button', { name: 'Save' }).click()
    await expect.poll(async () => (await shown(page))[0]).toBe('now')
    expect(await shown(page)).toContain('strip')
  } finally {
    await resetLayout(page)
  }
})
