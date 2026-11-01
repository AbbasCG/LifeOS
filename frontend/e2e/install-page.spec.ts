import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/** Where a phone user can find the install: a link on the sign-in page, a link in the menu, and a public page. */
async function offerInstall(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __prompted: number }
    w.__prompted = 0
    window.dispatchEvent(Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt: async () => { w.__prompted++ }, userChoice: Promise.resolve({ outcome: 'accepted' }) }))
  })
}

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('the sign-in page links to the install page, which works without signing in', async ({ page, guard }) => {
    guard.allowConsole(/401/)   // signed out: the session check is refused, as it should be
    await page.addInitScript(() => localStorage.setItem('lifeos-language', 'en'))
    await page.goto('/login')
    await page.getByRole('link', { name: 'Get the phone app' }).click()
    await expect(page).toHaveURL(/\/install$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Get LifeOS on your phone' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Android (Chrome or Edge)' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'iPhone and iPad (Safari)' })).toBeVisible()
    await expect(page).not.toHaveURL(/login/)

    // When the browser offers its install prompt, one tap calls it.
    await offerInstall(page)
    await page.getByRole('button', { name: 'Install app' }).click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __prompted: number }).__prompted)).toBe(1)
  })

  test('the install page is available in Arabic too', async ({ page, guard }) => {
    guard.allowConsole(/401/)
    await page.addInitScript(() => localStorage.setItem('lifeos-language', 'ar'))
    await page.goto('/install')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
    await expect(page.getByRole('heading', { level: 1, name: 'حمّل LifeOS على جوالك' })).toBeVisible()
    await expect(page.getByRole('heading', { name: /iPhone/ })).toBeVisible()
  })
})

test('the menu always has a way in: a link to the install page when the browser has no install button', async ({ page, setLanguage, isMobile }) => {
  await setLanguage('en')
  await page.goto('/')
  if (isMobile) await page.getByRole('button', { name: 'Toggle menu' }).click()
  const link = page.getByRole('complementary').getByRole('link', { name: 'Get the phone app' })
  await expect(link).toBeVisible()
  await link.click()
  await expect(page).toHaveURL(/\/install$/)
})
