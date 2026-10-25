import { test, expect } from './fixtures'

test.use({ storageState: { cookies: [], origins: [] } })

test('signs in with the demo account and refuses a wrong password', async ({ page, guard }) => {
  // The app asks who is signed in before login, and the wrong password is answered with 422.
  guard.allowConsole(/status of 40[13]|status of 422/)
  await page.goto('/login')
  await page.fill('input[name=email]', 'demo@lifeos.local')
  await page.fill('input[name=password]', 'not-the-password')
  await page.click('form button.primary')
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)

  await page.fill('input[name=password]', process.env.E2E_PASSWORD!)
  await page.click('form button.primary')
  await page.waitForURL('**/')
  await expect(page.locator('h1').first()).toBeVisible()
})
