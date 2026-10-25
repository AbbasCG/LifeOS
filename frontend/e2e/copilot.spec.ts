import { test, expect } from './fixtures'

test('Copilot proposes, applies only after approval, and undoes', async ({ page, setLanguage }) => {
  await setLanguage('en')
  const events = () => page.evaluate(async () => {
    const from = new Date().toISOString(), to = new Date(Date.now() + 3 * 86400000).toISOString()
    return (await (await fetch(`/api/calendar?from=${from}&to=${to}`, { credentials: 'include', headers: { Accept: 'application/json' } })).json()).data?.length ?? -1
  })
  await page.goto('/assistant')
  const start = await events()

  await page.locator('textarea').first().fill('I have two hours available tomorrow. Schedule studying and exercise.')
  await page.locator('textarea').first().press('Enter')
  const card = page.locator('.proposal-card').last()
  await expect(card.getByText('Needs your approval')).toBeVisible()
  expect(await events(), 'nothing changes before approval').toBe(start)

  await card.locator('.toolbar button.primary').click()
  await expect(card.getByText('Applied')).toBeVisible()
  expect(await events()).toBeGreaterThan(start)

  await card.getByRole('button', { name: /Undo these changes/ }).click()
  await expect(card.getByText('Undone')).toBeVisible()
  expect(await events()).toBe(start)
})
