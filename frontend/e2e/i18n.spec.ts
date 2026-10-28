import { test, expect, noHorizontalOverflow } from './fixtures'

test('Arabic is right-to-left on the main screens and fits the viewport', async ({ page, setLanguage }) => {
  await setLanguage('ar')
  try {
    for (const [path, heading] of [['/', null], ['/timeline', 'يومك كله في مكان واحد'], ['/settings/integrations', 'الحسابات المرتبطة'], ['/assistant', null]] as const) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
      await expect(page.locator('html')).toHaveAttribute('lang', 'ar')
      if (heading) await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
      await noHorizontalOverflow(page)
    }
  } finally {
    await setLanguage('en')
  }
})
