import { test, expect, noHorizontalOverflow } from './fixtures'

const pages = ['/', '/tasks', '/calendar', '/timeline', '/planning', '/review', '/focus', '/projects', '/goals', '/habits', '/categories', '/analytics', '/assistant', '/settings', '/settings/integrations']

test('every main screen renders with demo data and fits the viewport', async ({ page, setLanguage }) => {
  await setLanguage('en')
  for (const path of pages) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('main h1, main h2').first(), path).toBeVisible()
    await noHorizontalOverflow(page)
  }
})
