import { test, expect } from './fixtures'

test('connected accounts never pretend to be connected and feed links cannot reach the server network', async ({ page, setLanguage, guard }) => {
  guard.allowConsole(/status of 422/)
  await setLanguage('en')
  await page.goto('/settings/integrations')
  const google = page.locator('.integration-card', { hasText: 'Google Calendar' })
  await expect(google.getByText('Needs server setup')).toBeVisible()
  await expect(google.getByRole('button', { name: /Connect/ })).toHaveCount(0)

  await page.getByLabel('Calendar address (.ics or webcal)').fill('https://127.0.0.1/feed.ics')
  await page.getByRole('button', { name: /Subscribe/ }).click()
  await expect(page.locator('.feed-subscribe').getByRole('alert')).toContainText('private network')
})
