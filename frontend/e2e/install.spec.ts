import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

/**
 * Real installing needs a real browser on a real device, so the page is handed the event Chrome would send (and told to
 * count calls to prompt()). What is tested is LifeOS's part: where the install offer appears, that nothing installs until
 * a tap, that the browser's prompt is the thing that is called, and that it can be dismissed for good.
 */
async function offerInstall(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __prompted: number }
    w.__prompted = 0
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt: async () => { w.__prompted++ }, userChoice: Promise.resolve({ outcome: 'accepted' }) })
    window.dispatchEvent(event)
  })
}
const prompted = (page: Page) => page.evaluate(() => (window as unknown as { __prompted: number }).__prompted)

test('Settings offers the install, and a tap calls the browser’s own prompt', async ({ page, setLanguage }) => {
  await setLanguage('en')
  await page.goto('/settings')
  const card = page.getByRole('region', { name: 'Install the app' })
  await expect(card).toBeVisible()
  await offerInstall(page)
  await expect(card.getByRole('button', { name: 'Install app' })).toBeVisible()
  expect(await prompted(page)).toBe(0)
  await card.getByRole('button', { name: 'Install app' }).click()
  await expect.poll(() => prompted(page)).toBe(1)
  await expect(page.getByText('LifeOS was added to this device.')).toBeVisible()
})

test('on a phone Today offers it once, and "Not now" hides it for good', async ({ page, setLanguage, isMobile }) => {
  test.skip(!isMobile, 'the banner is for touch screens')
  await setLanguage('en')
  await page.goto('/')
  await page.evaluate(() => localStorage.removeItem('lifeos-install-banner'))
  await page.reload()
  const banner = page.getByRole('region', { name: 'Install the app' })
  await expect(banner).toHaveCount(0)               // nothing to offer until the browser offers it
  await offerInstall(page)
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'Install' }).click()
  await expect.poll(() => prompted(page)).toBe(1)

  await page.reload()
  await offerInstall(page)
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'Not now' }).click()
  await expect(banner).toHaveCount(0)
  await page.reload()
  await offerInstall(page)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(banner).toHaveCount(0)
  await page.evaluate(() => localStorage.removeItem('lifeos-install-banner'))
})

test.describe('iPhone', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' })
  test('Settings shows the Share-sheet steps, in Arabic too', async ({ page, setLanguage }) => {
    await setLanguage('en')
    await page.goto('/settings')
    await page.getByRole('button', { name: 'How to install' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add LifeOS to your Home Screen' })
    await expect(dialog).toContainText('Add to Home Screen')
    await dialog.getByRole('button', { name: 'Got it' }).click()
    await expect(dialog).toBeHidden()
    await setLanguage('ar')
    await page.goto('/settings')
    await page.getByRole('button', { name: 'كيف أثبّته' }).click()
    await expect(page.getByRole('dialog', { name: 'أضف LifeOS إلى الشاشة الرئيسية' })).toContainText('إضافة إلى الشاشة الرئيسية')
    await setLanguage('en')
  })
})
